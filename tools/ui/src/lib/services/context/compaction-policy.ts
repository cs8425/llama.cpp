/**
 * Compaction policy: size accounting and cut-point selection.
 *
 * Pure functions, no store imports. The policy decides "where to cut, and
 * whether to cut at all" ({@link planCompaction} = mode B / upper bound,
 * {@link planCompactionRecentWindow} = mode A / lower bound); applying an
 * existing compaction entry to a payload is the builder's job
 * (context-builder.ts).
 *
 * Size accounting (v4, context-enhance/02 §3.4): per-message sizes are
 * **real token counts** derived from the server's per-turn timings
 * ({@link deriveRealMessageTokens}: assistant = predicted_n, each segment's
 * real total attributed to its last non-assistant). The only no-data
 * exceptions are the not-yet-sent tail (bytes/4 estimate, {@link messageSize})
 * and the system head (0 — folded into the first segment total). Byte counts
 * ({@link messageBytes} / {@link apiMessageBytes}) are display material only
 * (inspector sub-column, the bytes/4 estimate) — never the primary size.
 * The auto trigger is the real `contextStatsStore.contextUsed` (the gauge's
 * source), never a byte sum.
 */

import { AttachmentType, ContentPartType, MessageRole } from '$lib/enums';
import type { ApiChatMessageContentPart, ApiChatMessageData } from '$lib/types/api';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import type { CompactionBudget, CompactionMode, CompactionPlan } from './types';

/** Rough cost of one image attachment (vision models encode ~1k tokens/image). */
const TOKENS_PER_IMAGE = 1000;
/** Rough flat cost of one audio or video attachment. */
const TOKENS_PER_AUDIO_VIDEO = 3000;
/**
 * Minimum token count in the summarize region for a compaction to be worth the
 * summary round-trip (02-data-model §3.3; real tokens since v4).
 */
export const MIN_SUMMARIZE_TOKENS = 2000;

const textEncoder = new TextEncoder();

/** UTF-8 byte length of a string (0 for null/empty). */
export function byteLength(text: string | undefined | null): number {
	if (!text) return 0;

	return textEncoder.encode(text).length;
}

/**
 * Byte count of one database message: content + toolCalls JSON + reasoning,
 * each as UTF-8 bytes, plus per-attachment flat/text costs. Display material
 * only (v4): the inspector's sub-column and the not-yet-sent tail's bytes/4
 * estimate. Never a primary size — per-message sizes are real tokens
 * ({@link messageSize}).
 */
export function messageBytes(message: DatabaseMessage): number {
	let bytes = byteLength(message.content);

	bytes += byteLength(message.toolCalls);
	bytes += byteLength(message.reasoningContent);

	for (const extra of message.extra ?? []) {
		bytes += estimateAttachmentBytes(extra);
	}

	return bytes;
}

function estimateAttachmentBytes(extra: DatabaseMessageExtra): number {
	switch (extra.type) {
		case AttachmentType.IMAGE:
			return TOKENS_PER_IMAGE;
		case AttachmentType.AUDIO:
		case AttachmentType.VIDEO:
			return TOKENS_PER_AUDIO_VIDEO;
		case AttachmentType.PDF:
			// Image-processed PDFs cost per page; text-extracted ones cost by text length.
			return extra.processedAsImages && extra.images
				? extra.images.length * TOKENS_PER_IMAGE
				: byteLength(extra.content);
		default:
			// TEXT / LEGACY_CONTEXT / MCP_PROMPT / MCP_RESOURCE
			return byteLength(extra.content);
	}
}

/**
 * Byte count of one converted API message. The inspector's payload rows are
 * in API form (the builder's output), not DB form, so they price the content
 * parts directly: text as UTF-8 bytes, one image part = 1000, audio/video
 * parts = 3000, tool calls by serialized bytes — the same heuristics as
 * {@link messageBytes}. Display material only (v4).
 *
 * A tool-call-only assistant turn legitimately carries no content at all:
 * the converter omits the empty field to stay byte-identical with the
 * in-flow push (the wire JSON has no content key), so
 * `content === undefined` is a total case here — it prices as 0 and the
 * row's bytes are the tool_calls JSON (+ reasoning) only. Display only; the
 * wire shape is never altered by this.
 */
export function apiMessageBytes(message: ApiChatMessageData): number {
	let bytes = 0;

	if (typeof message.content === 'string') {
		bytes += byteLength(message.content);
	} else if (Array.isArray(message.content)) {
		for (const part of message.content) {
			bytes += estimateContentPartBytes(part);
		}
	}

	if (message.tool_calls) {
		bytes += byteLength(JSON.stringify(message.tool_calls));
	}

	bytes += byteLength(message.reasoning_content);

	return bytes;
}

function estimateContentPartBytes(part: ApiChatMessageContentPart): number {
	switch (part.type) {
		case ContentPartType.TEXT:
			return byteLength(part.text);
		case ContentPartType.IMAGE_URL:
			return TOKENS_PER_IMAGE;
		default:
			// INPUT_AUDIO / INPUT_VIDEO
			return TOKENS_PER_AUDIO_VIDEO;
	}
}

/**
 * Real per-message token counts for a root→leaf path (v4, 02-data-model
 * §3.4). The server reports per-request / per-assistant-turn counts only
 * (assistant `timings`: `prompt_n` / `cache_n` / `predicted_n`), so the
 * per-message values are derived from adjacent turns — pure real data, not
 * estimates:
 * - assistant `i` → `predicted_n[i]` (its turn's output);
 * - each segment of non-assistant messages (between two measured assistants,
 *   or before the first) → the segment's real total
 *   `(prompt_n[i+1] + cache_n[i+1]) − (prompt_n[i] + cache_n[i]) −
 *   predicted_n[i]` (first segment = `prompt_n[0] + cache_n[0]`), attributed
 *   to the segment's LAST non-assistant message (the one that triggered the
 *   next turn);
 * - the system head → not in the map (no independent value — folded into the
 *   first segment total);
 * - the not-yet-sent tail (after the last assistant) → not in the map.
 *
 * An assistant without usable timings is skipped (its own value and the
 * segments around it are simply absent). A negative segment total — e.g. the
 * prompt shrank after an in-loop compaction — is NO data (N13 D5): the
 * segment's owner stays absent from the map, so consumers fall back to the
 * bytes/4 estimate instead of a fake 0.
 */
export function deriveRealMessageTokens(path: DatabaseMessage[]): Map<string, number> {
	const real = new Map<string, number>();

	interface Measured {
		cache: number;
		index: number;
		predicted: number;
		prompt: number;
	}

	const measured: Measured[] = [];

	path.forEach((message, index) => {
		if (message.role !== MessageRole.ASSISTANT) return;

		const timings = message.timings;

		if (timings?.prompt_n == null || timings?.predicted_n == null) return;

		measured.push({
			cache: timings.cache_n ?? 0,
			index,
			predicted: timings.predicted_n,
			prompt: timings.prompt_n
		});
	});

	if (measured.length === 0) return real;

	// First segment: everything before the first measured assistant. The
	// system head never owns a segment (it has no independent real value —
	// 02-§3.4); when the segment holds nothing else (a degenerate
	// [system, assistant] path) its total is simply dropped.
	const first = measured[0];
	const firstOwner = lastNonAssistantId(path, 0, first.index, true);

	if (firstOwner !== undefined) real.set(firstOwner, first.prompt + first.cache);

	for (let k = 0; k < measured.length; k++) {
		const a = measured[k];

		real.set(path[a.index].id, a.predicted);

		if (k + 1 >= measured.length) continue;

		const b = measured[k + 1];
		const segmentTotal = b.prompt + b.cache - (a.prompt + a.cache) - a.predicted;
		const owner = lastNonAssistantId(path, a.index, b.index, false);

		// N13 D5: a negative segment total is NO data — the owner stays absent
		// from the map so consumers fall back to the bytes/4 estimate (a
		// clamped 0 would masquerade as a real value).
		if (owner !== undefined && segmentTotal > 0) real.set(owner, segmentTotal);
	}

	return real;
}

/**
 * The id of the last non-assistant, non-system message in `path[start..to)`
 * (`start` = `from` when `includeFrom`, else `from + 1`; exclusive `to`) —
 * the owner of a segment's real total. The system head is skipped: it has no
 * independent real value (02-§3.4). undefined when the segment holds none.
 */
function lastNonAssistantId(
	path: DatabaseMessage[],
	from: number,
	to: number,
	includeFrom: boolean
): string | undefined {
	const start = includeFrom ? from : from + 1;

	for (let i = to - 1; i >= start; i--) {
		if (path[i].role === MessageRole.ASSISTANT || path[i].role === MessageRole.SYSTEM) continue;

		return path[i].id;
	}

	return undefined;
}

/**
 * The first index of the not-yet-sent tail: right after the path's last
 * assistant. A path with NO assistant has never been tokenized — the whole
 * path is tail. A path ending on an assistant has no tail.
 */
export function tailStartOf(path: DatabaseMessage[]): number {
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i].role === MessageRole.ASSISTANT) return i + 1;
	}

	return 0;
}

/**
 * The unified per-message size (v4): the real token count when the server
 * data covers it, the bytes/4 estimate for the not-yet-sent tail, and 0
 * otherwise — the system head has no independent value (it is folded into
 * the first segment total), and a non-assistant whose segment total was
 * attributed elsewhere carries none of its own.
 */
export function messageSize(
	message: DatabaseMessage,
	realTokens: Map<string, number>,
	isTail: boolean
): number {
	const real = realTokens.get(message.id);

	if (real !== undefined) return real;

	return isTail ? Math.round(messageBytes(message) / 4) : 0;
}

/**
 * Synchronous "tokens saved" figure for the gauge row (04-ui §3): the
 * pre-compaction real-token total (stored in the entry's meta at summary
 * time) minus what the compacted path currently sends. The current payload
 * is priced with the same v4 sizes — the whole path minus the dropped region
 * `path[head..boundary)`, the in-effect entry excluded from that region
 * because it IS sent (as the summary). With an absent boundary id
 * (deliberate empty kept, 02-§2) the dropped region is everything after the
 * head. Returns 0 when the entry has no meta, its boundary id is lost (the
 * builder fail-opens to the full path, so nothing is saved) or nothing is
 * net saved.
 */
export function estimateCompactionSavings(path: DatabaseMessage[], entry: DatabaseMessage): number {
	const meta = entry.compactionMeta;

	// `estimatedTokensBefore` is optional (older imported entries may lack it):
	// without it the savings figure is undefined, not NaN
	if (!meta || !meta.estimatedTokensBefore) return 0;

	const headLength = path[0]?.role === MessageRole.SYSTEM ? 1 : 0;

	// Absent boundary id = deliberate empty kept: the dropped region runs to
	// the end of the path. A *present* id that no longer exists (or points at
	// the system head) mirrors the builder's I3 fail-open exactly — the full
	// path is sent, so nothing is saved.
	const hasBoundary = meta.firstKeptMessageId !== undefined;
	const boundaryIndex = hasBoundary ? path.findIndex((message) => message.id === meta.firstKeptMessageId) : -1;

	if (hasBoundary && (boundaryIndex === -1 || (headLength > 0 && boundaryIndex === 0))) return 0;

	const real = deriveRealMessageTokens(path);
	const tailStart = tailStartOf(path);
	const size = (index: number) => messageSize(path[index], real, index >= tailStart);

	const droppedEnd = hasBoundary ? boundaryIndex : path.length;

	let dropped = 0;

	for (let i = headLength; i < droppedEnd; i++) {
		if (path[i].id === entry.id) continue;

		dropped += size(i);
	}

	const payload = path.reduce((sum, _, i) => sum + size(i), 0) - dropped;

	return Math.max(0, meta.estimatedTokensBefore - payload);
}

/** A message is a legal cut point when the kept region can start on it (I4):
 * user or assistant — never a tool result (orphan tool results are rejected by the API). */
function isCuttable(message: DatabaseMessage): boolean {
	return message.role === MessageRole.USER || message.role === MessageRole.ASSISTANT;
}

/**
 * The context settings that shape the compaction budget (mode B). A
 * structural pick (no settings import) so the policy stays store-free and
 * unit-testable. `contextCompactionThreshold` enters the budget as the
 * post-compaction total cap (budget = threshold − keepTarget, §02-3.3.2)
 * *and* gates when the auto check runs (the stores' trigger check).
 */
export interface CompactionSettings {
	contextCompactionThreshold: number;
	contextKeepMinMessages: number;
	contextKeepMinUserTurns: number;
	contextKeepTargetPercent: number;
}

/**
 * Max tokens for the summary LLM call: a percentage of the model context
 * (n_ctx) so the cap scales with the model — 70% of 128k ≈ 91750, of 256k ≈
 * 183500 — instead of a fixed number (06-status §3.13). Only used for the
 * summary call's `max_tokens`, never for the budget (v3).
 */
export function computeSummaryMaxTokens(nCtx: number, percent: number): number {
	return Math.max(1, Math.floor((nCtx * percent) / 100));
}

/**
 * Compaction budget for a known n_ctx (mode B, v3 final, 02-data-model
 * §3.3.2): the kept suffix must fit under the *difference* between the
 * trigger threshold and the keep target — after compaction the total =
 * (head + summary ≤ keepTarget%) + (kept ≤ threshold − keepTarget%) stays
 * under the trigger point, so the check does not fire again immediately.
 * `threshold ≤ keepTarget` (misconfiguration) → budget 0 → never compacts.
 * The old summary reserve (× 1.5) and 10% floor are gone (06-status §3.20).
 * The budget is a real-token count (v4).
 */
export function computeCompactionBudget(nCtx: number, settings: CompactionSettings): CompactionBudget {
	const diff = settings.contextCompactionThreshold - settings.contextKeepTargetPercent;

	return {
		keepBudgetTokens: diff > 0 ? Math.floor((nCtx * diff) / 100) : 0,
		minKeptMessages: settings.contextKeepMinMessages,
		minKeptUserTurns: settings.contextKeepMinUserTurns,
		minSummarizeTokens: MIN_SUMMARIZE_TOKENS
	};
}

/**
 * Selects the compaction cut point for a root→leaf path (system prompt first,
 * root excluded — the shape produced by `filterByLeafNodeId`).
 *
 * Two stages, boundary-first (02-data-model §3.3):
 * 1. earliest **user** message whose suffix fits the keep budget
 *    → normal compaction (the summary covers whole turns);
 * 2. otherwise earliest **user-or-assistant** cut whose suffix fits —
 *    including `j = path.length`, the cut after the last message (empty kept
 *    region, everything compacted; allowed since I5's split floor is 0)
 *    → split user-message span (`isSplitTurn = true`, `firstKeptMessageId`
 *    absent in the empty-kept case);
 * 3. otherwise null (nothing to do / no legal cut — with the empty-kept
 *    option stage 2 always has a solution, so this is left for degenerate
 *    inputs).
 *
 * Then the safety checks: the summarize region must reach `minSummarizeTokens`,
 * and the kept region must respect I5 (≥ N user messages for a boundary cut,
 * ≥ M messages for a split cut, M = 0 by default).
 *
 * All sizes are real tokens (v4, 02-§3.4): {@link messageSize} over the
 * {@link deriveRealMessageTokens} map (the `realTokens` parameter, derived
 * from `path` when omitted) — the tail at bytes/4, the system head 0.
 *
 * @param path - The full root→leaf path (system prompt at index 0 when present).
 * @param budget - Keep budget and safety limits (token scale).
 * @param realTokens - Per-message real token map (derived from `path` when omitted).
 * @returns The plan, or null when no compaction should happen.
 */
export function planCompaction(
	path: DatabaseMessage[],
	budget: CompactionBudget,
	realTokens?: Map<string, number>
): CompactionPlan | null {
	if (path.length === 0) return null;

	const systemStart = path[0]?.role === MessageRole.SYSTEM ? 1 : 0;
	const length = path.length;
	const real = realTokens ?? deriveRealMessageTokens(path);
	const tailStart = tailStartOf(path);
	const size = (index: number) => messageSize(path[index], real, index >= tailStart);

	// suffixTokens[i] = real tokens of path[i..end]; the suffix shrinks
	// as i grows, so the first i whose suffix fits the budget keeps the most.
	const suffixTokens: number[] = new Array<number>(length + 1).fill(0);

	for (let i = length - 1; i >= 0; i--) {
		suffixTokens[i] = suffixTokens[i + 1] + size(i);
	}

	let cutIndex = -1;
	let isSplitTurn = false;

	// Stage 1: turn boundary (user message).
	for (let j = systemStart; j < length; j++) {
		if (path[j].role !== MessageRole.USER) continue;

		if (suffixTokens[j] > budget.keepBudgetTokens) continue;

		cutIndex = j;

		break;
	}

	// Stage 2: split the span (earliest legal cut — necessarily an assistant
	// message here, since stage 1 already covered all user positions).
	// j == length is legal too: the cut after the last message leaves an empty
	// kept region (I5: the split floor minKeptMessages is 0 by default).
	if (cutIndex === -1) {
		for (let j = systemStart; j <= length; j++) {
			if (j < length && !isCuttable(path[j])) continue;

			if (suffixTokens[j] > budget.keepBudgetTokens) continue;

			cutIndex = j;
			isSplitTurn = true;

			break;
		}
	}

	if (cutIndex === -1) return null;

	const toSummarize = path.slice(systemStart, cutIndex);
	const summarizeTokens = toSummarize.reduce((sum, _, i) => sum + size(systemStart + i), 0);

	if (summarizeTokens < budget.minSummarizeTokens) return null;

	const kept = path.slice(cutIndex);

	if (isSplitTurn) {
		if (kept.length < budget.minKeptMessages) return null;
	} else {
		const keptUserMessages = kept.reduce((count, m) => count + (m.role === MessageRole.USER ? 1 : 0), 0);

		if (keptUserMessages < budget.minKeptUserTurns) return null;
	}

	const headTokens = systemStart === 1 ? size(0) : 0; // 0: the system head is folded into the first segment

	return {
		cutIndex,
		estimatedTokensAfter: headTokens + suffixTokens[cutIndex],
		estimatedTokensBefore: suffixTokens[0],
		firstKeptMessageId: cutIndex < length ? path[cutIndex].id : undefined,
		isSplitTurn,
		kept,
		keptTokens: suffixTokens[cutIndex],
		realMessageTokens: real,
		systemHead: systemStart === 1 ? path[0] : null,
		toSummarize
	};
}

/**
 * Coerces a raw settings value (the `contextCompactionMode` config) into a
 * valid {@link CompactionMode}; unknown or corrupted values fall back to the
 * default `threshold-target` (B).
 */
export function toCompactionMode(value: unknown): CompactionMode {
	return value === 'recent-window' ? 'recent-window' : 'threshold-target';
}

/**
 * The effective context window for compaction decisions (mode A): the model
 * n_ctx capped by the user override (`contextMaxContextOverride`, 0 = off).
 * Only shapes trimming decisions — the outgoing payload is never
 * hard-limited by it (02-data-model §3.3.1).
 */
export function computeEffectiveWindow(nCtx: number, maxContextOverride: number): number {
	return maxContextOverride > 0 ? Math.min(nCtx, maxContextOverride) : nCtx;
}

/** Parameters for the mode-specific trigger check (02-data-model §6). */
export interface CompactionTriggerParams {
	/**
	 * The real context usage: `contextStatsStore.contextUsed`
	 * (= prompt_n + cache_n + predicted_n of the last turn — the gauge's own
	 * number). Never a byte estimate (v4).
	 */
	lastPrompt: number;
	/** The model context size (n_ctx). */
	nCtx: number;
	/** `contextCompactionThreshold` (mode B, % of n_ctx). */
	contextCompactionThreshold: number;
	/** `contextMaxContextOverride` (mode A, 0 = off). */
	contextMaxContextOverride: number;
	/** `contextKeepRecentTokens` (mode A, token count). */
	contextKeepRecentTokens: number;
}

/**
 * Whether the auto compaction check should run (mode-specific, 02-data-model
 * §6). `lastPrompt` is the real context usage (the gauge's `contextUsed`;
 * v4).
 * - A: `lastPrompt > window − keep`; `window − keep ≤ 0` → never triggers
 *   (manual compaction is unaffected);
 * - B: `lastPrompt > n_ctx × threshold%`.
 */
export function shouldTriggerCompaction(mode: CompactionMode, params: CompactionTriggerParams): boolean {
	if (mode === 'recent-window') {
		const window = computeEffectiveWindow(params.nCtx, params.contextMaxContextOverride);
		const headroom = window - params.contextKeepRecentTokens;

		return headroom > 0 && params.lastPrompt > headroom;
	}

	return params.lastPrompt > (params.nCtx * params.contextCompactionThreshold) / 100;
}

/** Options for {@link planCompactionRecentWindow} (mode A, 02-data-model §3.3.1). */
export interface RecentWindowOptions {
	/** Minimum recent context to keep verbatim, in real tokens (the walk's stop point). */
	keepRecentTokens: number;
	/** Cut on a user message: minimum user messages that must stay in the kept region (I5). */
	minKeptUserTurns: number;
	/** Minimum total messages that must stay in the kept region (I5). */
	minKeptMessages: number;
	/** Minimum token count in the summarize region; smaller regions are not worth a summary. */
	minSummarizeTokens: number;
}

/**
 * Mode A cut-point selection: the recent-window walk (pi reference,
 * 02-data-model §3.3.1). Walks back from the last message accumulating
 * per-message REAL token counts ({@link messageSize} over the
 * {@link deriveRealMessageTokens} map) until ≥ `keepRecentTokens` (the
 * crossing point), then cuts at the nearest legal cut point at/right of it.
 *
 * - crossing on a tool result → the cut moves right to the next user/
 *   assistant message (a giant tool result therefore keeps the whole turn
 *   that follows it);
 * - no legal cut to the right (the tail is all tool results) → the
 *   rightmost legal cut (keeps that assistant (tool_calls) + its tool
 *   results — the most recent exchange);
 * - the walk never reaches keep (whole path < keep) → null (nothing to do);
 * - **never produces an empty kept**: the cut always lands on a user or
 *   assistant message (kept ≥ 1).
 *
 * Then the safety checks: summarize region ≥ `minSummarizeTokens` (tokens),
 * kept ≥ `minKeptMessages`, and — when the cut lands on a user message —
 * kept user messages ≥ `minKeptUserTurns`.
 *
 * @param path - The full root→leaf path (system prompt at index 0 when present).
 * @param opts - Keep lower bound and safety limits (token scale).
 * @param realTokens - Per-message real token map (derived from `path` when omitted).
 * @returns The plan, or null when no compaction should happen.
 */
export function planCompactionRecentWindow(
	path: DatabaseMessage[],
	opts: RecentWindowOptions,
	realTokens?: Map<string, number>
): CompactionPlan | null {
	if (path.length === 0) return null;

	const systemStart = path[0]?.role === MessageRole.SYSTEM ? 1 : 0;
	const length = path.length;
	const real = realTokens ?? deriveRealMessageTokens(path);
	const tailStart = tailStartOf(path);
	const size = (index: number) => messageSize(path[index], real, index >= tailStart);

	// Walk back from the last message; the system head is never part of the
	// walk (it is always kept and counts 0 — folded into the first segment).
	let cumulative = 0;
	let crossing = -1;

	for (let i = length - 1; i >= systemStart; i--) {
		cumulative += size(i);

		if (cumulative >= opts.keepRecentTokens) {
			crossing = i;

			break;
		}
	}

	if (crossing === -1) return null; // whole path < keep → not worth compacting

	// Nearest legal cut at/right of the crossing point.
	let cutIndex = -1;

	for (let j = crossing; j < length; j++) {
		if (isCuttable(path[j])) {
			cutIndex = j;

			break;
		}
	}

	// The tail is all tool results: fall back to the rightmost legal cut,
	// keeping that assistant (tool_calls) + its trailing tool results.
	if (cutIndex === -1) {
		for (let j = length - 1; j >= systemStart; j--) {
			if (isCuttable(path[j])) {
				cutIndex = j;

				break;
			}
		}
	}

	if (cutIndex === -1) return null; // no legal cut at all (degenerate path)

	const isSplitTurn = path[cutIndex].role === MessageRole.ASSISTANT;
	const toSummarize = path.slice(systemStart, cutIndex);
	const summarizeTokens = toSummarize.reduce((sum, _, i) => sum + size(systemStart + i), 0);

	if (summarizeTokens < opts.minSummarizeTokens) return null;

	const kept = path.slice(cutIndex);

	if (kept.length < opts.minKeptMessages) return null;

	if (!isSplitTurn) {
		const keptUserMessages = kept.reduce((count, m) => count + (m.role === MessageRole.USER ? 1 : 0), 0);

		if (keptUserMessages < opts.minKeptUserTurns) return null;
	}

	const headTokens = systemStart === 1 ? size(0) : 0;
	const keptTokens = kept.reduce((sum, _, i) => sum + size(cutIndex + i), 0);

	return {
		cutIndex,
		estimatedTokensAfter: headTokens + keptTokens,
		estimatedTokensBefore: headTokens + keptTokens + summarizeTokens,
		firstKeptMessageId: path[cutIndex].id,
		isSplitTurn,
		kept,
		keptTokens,
		realMessageTokens: real,
		systemHead: systemStart === 1 ? path[0] : null,
		toSummarize
	};
}

/** Parameters for the mode-specific success check (02-data-model §6). */
export interface CompactionCheckParams {
	/** The model context size (n_ctx). */
	nCtx: number;
	/** `contextMaxContextOverride` (mode A, 0 = off). */
	contextMaxContextOverride: number;
	/** `contextKeepRecentTokens` (mode A, token count). */
	contextKeepRecentTokens: number;
	/** `contextKeepTargetPercent` (mode B, % of n_ctx). */
	contextKeepTargetPercent: number;
}

/** Result of the mode-specific success check. */
export interface CompactionCheckResult {
	/** true = the compaction result is within the mode target. */
	ok: boolean;
	/** The post-compaction size the mode checks (A: summary + kept; B: summary) — real tokens. */
	postSize: number;
	/** The mode target (A: window − keep; B: keepTarget% × n_ctx). */
	target: number;
}

/**
 * The mode-specific "did the compaction succeed" check, evaluated once the
 * summary exists (02-data-model §6). `summarySize` is the summary's size in
 * tokens: the API's actual completion tokens when the server reported them,
 * else the UTF-8 byte length of the content ({@link resolveSummarySize}).
 * The kept region is priced at the plan's real tokens
 * (`plan.keptTokens`, v4); the system head counts 0 (no independent value —
 * folded into the first segment total).
 * - A: `summary + kept ≤ window − keep` (below the trigger point → no
 *   immediate re-trigger);
 * - B: `summary ≤ keepTarget% × n_ctx` (kept is already constrained to the
 *   budget by the cut point).
 */
export function evaluateCompactionResult(
	plan: CompactionPlan,
	summarySize: number,
	mode: CompactionMode,
	params: CompactionCheckParams
): CompactionCheckResult {
	if (mode === 'recent-window') {
		const window = computeEffectiveWindow(params.nCtx, params.contextMaxContextOverride);
		const target = window - params.contextKeepRecentTokens;
		const postSize = summarySize + plan.keptTokens;

		return { ok: postSize <= target, postSize, target };
	}

	const target = Math.floor((params.nCtx * params.contextKeepTargetPercent) / 100);
	const postSize = summarySize;

	return { ok: postSize <= target, postSize, target };
}

/**
 * Resolves the summary's size for the success check and `summaryTokens`
 * (02-data-model §4): the API's actual completion tokens when reported, else
 * the bytes/4 estimate of the content (N13 D4: v4 units — the raw byte length
 * would be ~4× off). The summary's own size, distinct from per-message
 * accounting.
 */
export function resolveSummarySize(tokens: number | null, content: string): number {
	return tokens ?? Math.round(byteLength(content) / 4);
}

/**
 * The shared over-target mechanism's loop step (02-data-model §6): after an
 * over-target summary, retry while attempts remain, otherwise hand over to
 * the user gate. `maxAttempts` = total attempts (1 = once; ≤ 0 = unlimited,
 * the gate is the only stop).
 */
export function nextCompactionStep(attempts: number, maxAttempts: number): 'retry' | 'gate' {
	return maxAttempts <= 0 || attempts < maxAttempts ? 'retry' : 'gate';
}
