/**
 * Context builder — the single choke point from "database path" to
 * "exact API payload".
 *
 * `sendMessage`, `preEncode`, the agentic flow and the inspector all go
 * through {@link buildLlmContext}, which guarantees WYSIWYG: what the
 * inspector shows is what goes over the wire (context-enhance/03 §2).
 *
 * Semantics (02-data-model §2):
 * - no compaction entry on the path → convert the whole path (current behavior);
 * - a compaction entry in effect → [system prompt?, summary (role: user), kept…];
 * - only the LAST entry is in effect (I2); older entries inside the kept
 *   region are sent as plain user messages (their content is the old summary);
 * - a missing `firstKeptMessageId` → fail-open, send the full path (I3).
 *
 * Conversion reuses `ChatService.normalizeMessagesForApi` (per-message
 * `convertDbMessageToApiChatMessageData` + empty-system filter) — no fork.
 * Note: `chat.service.ts` will import this module in Phase 1; the resulting
 * cycle is safe because `ChatService` is only referenced at call time.
 */

import { MessageRole, MessageType } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import type { ApiChatMessageData } from '$lib/types/api';
import type { DatabaseMessage } from '$lib/types/database';
import { estimateTokens } from './compaction-policy';
import type { ContextBuildOptions, ContextBuildResult } from './types';

function isCompactionEntry(message: DatabaseMessage): boolean {
	return message.type === MessageType.COMPACTION;
}

/** Last compaction entry on the path (I2), or null. */
export function findLastCompactionEntry(path: DatabaseMessage[]): DatabaseMessage | null {
	for (let i = path.length - 1; i >= 0; i--) {
		if (isCompactionEntry(path[i])) return path[i];
	}

	return null;
}

function stripReasoning(
	messages: ApiChatMessageData[],
	strip: boolean
): ApiChatMessageData[] {
	if (!strip) return messages;

	return messages.map((msg) =>
		msg.reasoning_content ? { ...msg, reasoning_content: undefined } : msg
	);
}

/**
 * Builds the exact payload sent to the LLM for a root→leaf database path
 * (root excluded, system prompt first — the shape of `activeMessages`).
 *
 * @param path - The root→leaf message path in DB form.
 * @param options - `excludeReasoning` mirrors the existing context switch.
 * @returns The converted payload, the compaction state and the token estimate.
 */
export async function buildLlmContext(
	path: DatabaseMessage[],
	options: ContextBuildOptions = {}
): Promise<ContextBuildResult> {
	const excludeReasoning = options.excludeReasoning === true;

	const convert = async (messages: DatabaseMessage[]): Promise<ApiChatMessageData[]> =>
		stripReasoning(await ChatService.normalizeMessagesForApi(messages), excludeReasoning);

	const pathTokens = path.reduce((sum, message) => sum + estimateTokens(message), 0);

	const entry = findLastCompactionEntry(path);

	if (!entry) {
		return {
			compaction: null,
			estimatedTokens: pathTokens,
			messages: await convert(path)
		};
	}

	const boundaryId = entry.compactionMeta?.firstKeptMessageId ?? '';
	const keptIndex = boundaryId ? path.findIndex((message) => message.id === boundaryId) : -1;

	// I1: the system prompt head is never part of the summarize region.
	const head = path[0] && path[0].role === MessageRole.SYSTEM ? [path[0]] : [];

	// Fail-open (I3): the boundary no longer exists on this path (branching,
	// deletion) — or points at the system prompt itself (corrupt data; the
	// policy and the inspector never produce it). Send everything rather than
	// silently dropping "current" messages or duplicating the system prompt.
	if (keptIndex === -1 || (head.length > 0 && keptIndex === 0)) {
		return {
			compaction: {
				boundaryValid: false,
				droppedCount: 0,
				entryId: entry.id,
				firstKeptMessageId: boundaryId
			},
			estimatedTokens: pathTokens,
			messages: await convert(path)
		};
	}

	// The kept window runs from the boundary to the end of the path. The entry
	// node itself sits inside that window (it is a path node — usually the
	// last one) and must NOT be sent again: its content is the summary that
	// is inserted separately. Messages appended after the entry stay kept.
	const kept = path.slice(keptIndex).filter((message) => message.id !== entry.id);

	// The summary travels as a plain user turn so every chat template accepts it
	// (same pattern as the isSynthetic cwd messages); `type: compaction` is only
	// read by the renderer.
	const summary: ApiChatMessageData = {
		content: entry.content,
		role: MessageRole.USER
	};

	const messages = [
		...(await convert(head)),
		summary,
		...(await convert(kept))
	];

	const estimatedTokens =
		head.reduce((sum, message) => sum + estimateTokens(message), 0) +
		Math.ceil(entry.content.length / 4) +
		kept.reduce((sum, message) => sum + estimateTokens(message), 0);

	return {
		compaction: {
			boundaryValid: true,
			droppedCount: path
				.slice(head.length, keptIndex)
				.filter((message) => message.id !== entry.id).length,
			entryId: entry.id,
			firstKeptMessageId: boundaryId
		},
		estimatedTokens,
		messages
	};
}
