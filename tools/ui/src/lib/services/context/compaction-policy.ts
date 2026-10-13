/**
 * Compaction policy: token estimation and cut-point selection.
 *
 * Pure functions, no store imports. The policy decides "where to cut, and
 * whether to cut at all" ({@link planCompaction}); applying an existing
 * compaction entry to a payload is the builder's job (context-builder.ts).
 */

import { AttachmentType, ContentPartType, MessageRole } from '$lib/enums';
import type { ApiChatMessageContentPart, ApiChatMessageData } from '$lib/types/api';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import type { CompactionBudget, CompactionPlan } from './types';

/** Rough cost of one image attachment (vision models encode ~1k tokens/image). */
const TOKENS_PER_IMAGE = 1000;
/** Rough flat cost of one audio or video attachment. */
const TOKENS_PER_AUDIO_VIDEO = 3000;
/** Characters per token for text. Deliberately simple (v1); see context-enhance/02 §3.4. */
const CHARS_PER_TOKEN = 4;

function textTokens(text: string | undefined | null): number {
	if (!text) return 0;

	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimated token cost of a single database message (v1 heuristic):
 * content/4 + toolCalls JSON/4 + reasoning/4 + per-attachment flat/text costs.
 * The estimate only decides "where to cut"; it never decides "does it fit"
 * (the server is the source of truth for that).
 */
export function estimateTokens(message: DatabaseMessage): number {
	let tokens = textTokens(message.content);

	tokens += textTokens(message.toolCalls);
	tokens += textTokens(message.reasoningContent);

	for (const extra of message.extra ?? []) {
		tokens += estimateAttachmentTokens(extra);
	}

	return tokens;
}

function estimateAttachmentTokens(extra: DatabaseMessageExtra): number {
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
				: textTokens(extra.content);
		default:
			// TEXT / LEGACY_CONTEXT / MCP_PROMPT / MCP_RESOURCE
			return textTokens(extra.content);
	}
}

/**
 * Estimated token cost of one converted API message. The inspector's payload
 * rows are in API form (the builder's output), not DB form, so they price the
 * content parts directly: text/4, one image part = 1000, audio/video parts =
 * 3000, tool calls by serialized length — the same heuristics as
 * {@link estimateTokens}.
 */
export function estimateApiMessageTokens(message: ApiChatMessageData): number {
	let tokens = 0;

	if (typeof message.content === 'string') {
		tokens += textTokens(message.content);
	} else {
		for (const part of message.content) {
			tokens += estimateContentPartTokens(part);
		}
	}

	if (message.tool_calls) {
		tokens += textTokens(JSON.stringify(message.tool_calls));
	}

	tokens += textTokens(message.reasoning_content);

	return tokens;
}

function estimateContentPartTokens(part: ApiChatMessageContentPart): number {
	switch (part.type) {
		case ContentPartType.TEXT:
			return textTokens(part.text);
		case ContentPartType.IMAGE_URL:
			return TOKENS_PER_IMAGE;
		default:
			// INPUT_AUDIO / INPUT_VIDEO
			return TOKENS_PER_AUDIO_VIDEO;
	}
}

/** A message is a legal cut point when the kept region can start on it (I4):
 * user or assistant — never a tool result (orphan tool results are rejected by the API). */
function isCuttable(message: DatabaseMessage): boolean {
	return message.role === MessageRole.USER || message.role === MessageRole.ASSISTANT;
}

/**
 * Selects the compaction cut point for a root→leaf path (system prompt first,
 * root excluded — the shape produced by `filterByLeafNodeId`).
 *
 * Two stages, boundary-first (02-data-model §3.3):
 * 1. earliest **user** message whose suffix fits the keep budget
 *    → normal compaction (the summary covers whole turns);
 * 2. otherwise earliest **user-or-assistant** cut whose suffix fits
 *    → split user-message span (`isSplitTurn = true`);
 * 3. otherwise null (nothing to do / no legal cut).
 *
 * Then the safety checks: the summarize region must reach `minSummarizeTokens`,
 * and the kept region must respect I5 (≥ N user messages for a boundary cut,
 * ≥ M messages for a split cut).
 *
 * @param path - The full root→leaf path (system prompt at index 0 when present).
 * @param budget - Keep budget and safety limits.
 * @returns The plan, or null when no compaction should happen.
 */
export function planCompaction(path: DatabaseMessage[], budget: CompactionBudget): CompactionPlan | null {
	if (path.length === 0) return null;

	const systemStart = path[0]?.role === MessageRole.SYSTEM ? 1 : 0;
	const length = path.length;

	// suffixEstimate[i] = estimated tokens of path[i..end]; the suffix shrinks
	// as i grows, so the first i whose suffix fits the budget keeps the most.
	const suffixEstimate: number[] = new Array<number>(length + 1).fill(0);

	for (let i = length - 1; i >= 0; i--) {
		suffixEstimate[i] = suffixEstimate[i + 1] + estimateTokens(path[i]);
	}

	let cutIndex = -1;
	let isSplitTurn = false;

	// Stage 1: turn boundary (user message).
	for (let j = systemStart; j < length; j++) {
		if (path[j].role !== MessageRole.USER) continue;

		if (suffixEstimate[j] > budget.keepBudgetTokens) continue;

		cutIndex = j;

		break;
	}

	// Stage 2: split the span (earliest legal cut — necessarily an assistant
	// message here, since stage 1 already covered all user positions).
	if (cutIndex === -1) {
		for (let j = systemStart; j < length; j++) {
			if (!isCuttable(path[j])) continue;

			if (suffixEstimate[j] > budget.keepBudgetTokens) continue;

			cutIndex = j;
			isSplitTurn = true;

			break;
		}
	}

	if (cutIndex === -1) return null;

	const toSummarize = path.slice(systemStart, cutIndex);
	const summarizeTokens = toSummarize.reduce((sum, m) => sum + estimateTokens(m), 0);

	if (summarizeTokens < budget.minSummarizeTokens) return null;

	const kept = path.slice(cutIndex);

	if (isSplitTurn) {
		if (kept.length < budget.minKeptMessages) return null;
	} else {
		const keptUserMessages = kept.reduce((count, m) => count + (m.role === MessageRole.USER ? 1 : 0), 0);

		if (keptUserMessages < budget.minKeptUserTurns) return null;
	}

	const systemTokens = systemStart === 1 ? estimateTokens(path[0]) : 0;

	return {
		cutIndex,
		estimatedTokensAfter: systemTokens + suffixEstimate[cutIndex],
		estimatedTokensBefore: suffixEstimate[0],
		firstKeptMessageId: path[cutIndex].id,
		isSplitTurn,
		kept,
		toSummarize
	};
}
