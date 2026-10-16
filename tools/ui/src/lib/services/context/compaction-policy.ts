/**
 * Compaction policy: size accounting and cut-point selection.
 *
 * Pure functions, no store imports. The policy decides "where to cut, and
 * whether to cut at all" ({@link planCompaction} = mode B / upper bound,
 * {@link planCompactionRecentWindow} = mode A / lower bound); applying an
 * existing compaction entry to a payload is the builder's job
 * (context-builder.ts).
 *
 * Size accounting (v3 / dual-mode, context-enhance/02 §3.4): when the API has
 * an actual token count it is used at the precise decision points (trigger =
 * `timings.prompt_n`, success check = the summary response's completion
 * tokens); per-message there is no API value, so message costs are **UTF-8
 * byte counts** (image = 1000, audio/video = 3000 flat). No derived
 * proportions.
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
 * Minimum byte count in the summarize region for a compaction to be worth the
 * summary round-trip (02-data-model §3.3; byte count since v3).
 */
export const MIN_SUMMARIZE_TOKENS = 2000;

const textEncoder = new TextEncoder();

/** UTF-8 byte length of a string (0 for null/empty). */
export function byteLength(text: string | undefined | null): number {
	if (!text) return 0;

	return textEncoder.encode(text).length;
}

/**
 * Byte cost of one database message (v3): content + toolCalls JSON +
 * reasoning, each as UTF-8 bytes, plus per-attachment flat/text costs. The
 * value only decides "where to cut"; it never decides "does it fit" (the
 * server is the source of truth for that).
 */
export function estimateTokens(message: DatabaseMessage): number {
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
 * Byte cost of one converted API message. The inspector's payload rows are in
 * API form (the builder's output), not DB form, so they price the content
 * parts directly: text as UTF-8 bytes, one image part = 1000, audio/video
 * parts = 3000, tool calls by serialized bytes — the same heuristics as
 * {@link estimateTokens}.
 */
export function estimateApiMessageTokens(message: ApiChatMessageData): number {
	let bytes = 0;

	if (typeof message.content === 'string') {
		bytes += byteLength(message.content);
	} else {
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
 * Synchronous "tokens saved" figure for the gauge row (04-ui §3): the
 * pre-compaction estimate minus what the compacted path currently sends.
 * The current payload is priced with the same heuristic the builder uses —
 * the whole path minus the dropped region `path[head..boundary)`, the
 * in-effect entry excluded from that region because it IS sent (as the
 * summary). With an absent boundary id (deliberate empty kept, 02-§2) the
 * dropped region is everything after the head. Returns 0 when the entry has
 * no meta, its boundary id is lost (the builder fail-opens to the full path,
 * so nothing is saved) or nothing is net saved.
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

	const droppedEnd = hasBoundary ? boundaryIndex : path.length;

	let dropped = 0;

	for (let i = headLength; i < droppedEnd; i++) {
		if (path[i].id === entry.id) continue;

		dropped += estimateTokens(path[i]);
	}

	const payload = path.reduce((sum, message) => sum + estimateTokens(message), 0) - dropped;

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
 * @param path - The full root→leaf path (system prompt at index 0 when present).
 * @param budget - Keep budget and safety limits.
 * @returns The plan, or null when no compaction should happen.
 */
export function planCompaction(path: DatabaseMessage[], budget: CompactionBudget): CompactionPlan | null {
	if (path.length === 0) return null;

	const systemStart = path[0]?.role === MessageRole.SYSTEM ? 1 : 0;
	const length = path.length;

	// suffixBytes[i] = byte count of path[i..end]; the suffix shrinks
	// as i grows, so the first i whose suffix fits the budget keeps the most.
	const suffixBytes: number[] = new Array<number>(length + 1).fill(0);

	for (let i = length - 1; i >= 0; i--) {
		suffixBytes[i] = suffixBytes[i + 1] + estimateTokens(path[i]);
	}

	let cutIndex = -1;
	let isSplitTurn = false;

	// Stage 1: turn boundary (user message).
	for (let j = systemStart; j < length; j++) {
		if (path[j].role !== MessageRole.USER) continue;

		if (suffixBytes[j] > budget.keepBudgetTokens) continue;

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

			if (suffixBytes[j] > budget.keepBudgetTokens) continue;

			cutIndex = j;
			isSplitTurn = true;

			break;
		}
	}

	if (cutIndex === -1) return null;

	const toSummarize = path.slice(systemStart, cutIndex);
	const summarizeBytes = toSummarize.reduce((sum, m) => sum + estimateTokens(m), 0);

	if (summarizeBytes < budget.minSummarizeTokens) return null;

	const kept = path.slice(cutIndex);

	if (isSplitTurn) {
		if (kept.length < budget.minKeptMessages) return null;
	} else {
		const keptUserMessages = kept.reduce((count, m) => count + (m.role === MessageRole.USER ? 1 : 0), 0);

		if (keptUserMessages < budget.minKeptUserTurns) return null;
	}

	const headBytes = systemStart === 1 ? estimateTokens(path[0]) : 0;

	return {
		cutIndex,
		estimatedTokensAfter: headBytes + suffixBytes[cutIndex],
		estimatedTokensBefore: suffixBytes[0],
		firstKeptMessageId: cutIndex < length ? path[cutIndex].id : undefined,
		isSplitTurn,
		kept,
		systemHead: systemStart === 1 ? path[0] : null,
		toSummarize
	};
}

/**
 * Coerces a raw settings value (the `contextCompactionMode` config) into a
 * valid {@link CompactionMode}; unknown or corrupted values fall back to the
 * default `recent-window` (A).
 */
export function toCompactionMode(value: unknown): CompactionMode {
	return value === 'threshold-target' ? 'threshold-target' : 'recent-window';
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
	/** The last full prompt size: `timings.prompt_n` when the server reported it, else the path's byte count. */
	lastPrompt: number;
	/** The model context size (n_ctx). */
	nCtx: number;
	/** `contextCompactionThreshold` (mode B, % of n_ctx). */
	contextCompactionThreshold: number;
	/** `contextMaxContextOverride` (mode A, 0 = off). */
	contextMaxContextOverride: number;
	/** `contextKeepRecentTokens` (mode A, byte count). */
	contextKeepRecentTokens: number;
}

/**
 * Whether the auto compaction check should run (mode-specific, 02-data-model
 * §6). `lastPrompt` is the API's actual `prompt_n` when available, otherwise
 * the byte count of the path.
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
	/** Minimum recent context to keep verbatim, in byte count (the walk's stop point). */
	keepRecentTokens: number;
	/** Cut on a user message: minimum user messages that must stay in the kept region (I5). */
	minKeptUserTurns: number;
	/** Minimum total messages that must stay in the kept region (I5). */
	minKeptMessages: number;
	/** Minimum byte count in the summarize region; smaller regions are not worth a summary. */
	minSummarizeTokens: number;
}

/**
 * Mode A cut-point selection: the recent-window walk (pi reference,
 * 02-data-model §3.3.1). Walks back from the last message accumulating
 * per-message byte counts until ≥ `keepRecentTokens` (the crossing point),
 * then cuts at the nearest legal cut point at/right of it.
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
 * Then the safety checks: summarize region ≥ `minSummarizeTokens` (bytes),
 * kept ≥ `minKeptMessages`, and — when the cut lands on a user message —
 * kept user messages ≥ `minKeptUserTurns`.
 *
 * @param path - The full root→leaf path (system prompt at index 0 when present).
 * @param opts - Keep lower bound and safety limits.
 * @returns The plan, or null when no compaction should happen.
 */
export function planCompactionRecentWindow(
	path: DatabaseMessage[],
	opts: RecentWindowOptions
): CompactionPlan | null {
	if (path.length === 0) return null;

	const systemStart = path[0]?.role === MessageRole.SYSTEM ? 1 : 0;
	const length = path.length;

	// Walk back from the last message; the system head is never part of the
	// walk (it is always kept and priced separately in the success check).
	let cumulative = 0;
	let crossing = -1;

	for (let i = length - 1; i >= systemStart; i--) {
		cumulative += estimateTokens(path[i]);

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
	const summarizeBytes = toSummarize.reduce((sum, m) => sum + estimateTokens(m), 0);

	if (summarizeBytes < opts.minSummarizeTokens) return null;

	const kept = path.slice(cutIndex);

	if (kept.length < opts.minKeptMessages) return null;

	if (!isSplitTurn) {
		const keptUserMessages = kept.reduce((count, m) => count + (m.role === MessageRole.USER ? 1 : 0), 0);

		if (keptUserMessages < opts.minKeptUserTurns) return null;
	}

	const headBytes = systemStart === 1 ? estimateTokens(path[0]) : 0;
	const keptBytes = kept.reduce((sum, m) => sum + estimateTokens(m), 0);

	return {
		cutIndex,
		estimatedTokensAfter: headBytes + keptBytes,
		estimatedTokensBefore: headBytes + keptBytes + summarizeBytes,
		firstKeptMessageId: path[cutIndex].id,
		isSplitTurn,
		kept,
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
	/** `contextKeepRecentTokens` (mode A, byte count). */
	contextKeepRecentTokens: number;
	/** `contextKeepTargetPercent` (mode B, % of n_ctx). */
	contextKeepTargetPercent: number;
}

/** Result of the mode-specific success check. */
export interface CompactionCheckResult {
	/** true = the compaction result is within the mode target. */
	ok: boolean;
	/** The post-compaction size the mode checks (A: head + summary + kept; B: head + summary). */
	postSize: number;
	/** The mode target (A: window − keep; B: keepTarget% × n_ctx). */
	target: number;
}

/**
 * The mode-specific "did the compaction succeed" check, evaluated once the
 * summary exists (02-data-model §6). `summarySize` is the summary's size in
 * the mode's units: the API's actual completion tokens when the server
 * reported them, else the UTF-8 byte length of the content
 * ({@link resolveSummarySize}).
 * - A: `head + summary + kept ≤ window − keep` (below the trigger point →
 *   no immediate re-trigger);
 * - B: `head + summary ≤ keepTarget% × n_ctx` (kept is already constrained
 *   to the budget by the cut point).
 */
export function evaluateCompactionResult(
	plan: CompactionPlan,
	summarySize: number,
	mode: CompactionMode,
	params: CompactionCheckParams
): CompactionCheckResult {
	const headBytes = plan.systemHead ? estimateTokens(plan.systemHead) : 0;

	if (mode === 'recent-window') {
		const window = computeEffectiveWindow(params.nCtx, params.contextMaxContextOverride);
		const target = window - params.contextKeepRecentTokens;
		const keptBytes = plan.kept.reduce((sum, m) => sum + estimateTokens(m), 0);
		const postSize = headBytes + summarySize + keptBytes;

		return { ok: postSize <= target, postSize, target };
	}

	const target = Math.floor((params.nCtx * params.contextKeepTargetPercent) / 100);
	const postSize = headBytes + summarySize;

	return { ok: postSize <= target, postSize, target };
}

/**
 * Resolves the summary's size for the success check: the API's actual
 * completion tokens when reported, else the UTF-8 byte length of the
 * content (02-data-model §3.4: no API value → byte count).
 */
export function resolveSummarySize(tokens: number | null, content: string): number {
	return tokens ?? byteLength(content);
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
