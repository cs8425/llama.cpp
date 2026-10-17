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
 * - an ABSENT `firstKeptMessageId` → deliberate empty kept: kept = the
 *   messages after the entry node (usually none) — the full pre-entry history
 *   is covered by the summary;
 * - a PRESENT `firstKeptMessageId` that no longer exists → fail-open, send
 *   the full path (I3).
 *
 * Conversion reuses `ChatService.convertDbMessageToApiChatMessageData`
 * per message (the same conversion `normalizeMessagesForApi` applies) plus
 * its empty-system filter — no fork. The 1:1 DB→API mapping is kept (each
 * row carries `sourceId`) so the inspector can map rows back to the
 * per-message real tokens (v4, 02-§3.4).
 * Note: `chat.service.ts` will import this module in Phase 1; the resulting
 * cycle is safe because `ChatService` is only referenced at call time.
 */

import { MessageRole, MessageType } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import type { DatabaseMessage } from '$lib/types/database';
import type { ContextBuildOptions, ContextBuildResult, ContextPayloadMessage } from './types';

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

/**
 * Converts DB messages to the API form, keeping the 1:1 mapping to the DB
 * ids (`sourceId`). Mirrors `normalizeMessagesForApi` exactly — per-message
 * `convertDbMessageToApiChatMessageData` + the empty-system filter — so the
 * payload is bit-identical to the current send path.
 */
async function convertWithSourceIds(
	messages: DatabaseMessage[],
	excludeReasoning: boolean
): Promise<ContextPayloadMessage[]> {
	const converted = await Promise.all(
		messages.map((message) => ChatService.convertDbMessageToApiChatMessageData(message))
	);

	const out: ContextPayloadMessage[] = [];

	messages.forEach((message, i) => {
		const api = converted[i];
		const stripped =
			excludeReasoning && api.reasoning_content ? { ...api, reasoning_content: undefined } : api;

		// Mirror normalizeMessagesForApi: empty system messages are dropped.
		if (
			message.role === MessageRole.SYSTEM &&
			typeof stripped.content === 'string' &&
			stripped.content.trim() === ''
		) {
			return;
		}

		out.push({ ...stripped, sourceId: message.id });
	});

	return out;
}

/**
 * Builds the exact payload sent to the LLM for a root→leaf database path
 * (root excluded, system prompt first — the shape of `activeMessages`).
 *
 * @param path - The root→leaf message path in DB form.
 * @param options - `excludeReasoning` mirrors the existing context switch.
 * @returns The converted payload (each row tagged with its source id) and
 *   the compaction state.
 */
export async function buildLlmContext(
	path: DatabaseMessage[],
	options: ContextBuildOptions = {}
): Promise<ContextBuildResult> {
	const excludeReasoning = options.excludeReasoning === true;

	const entry = findLastCompactionEntry(path);

	if (!entry) {
		return {
			compaction: null,
			messages: await convertWithSourceIds(path, excludeReasoning)
		};
	}

	const boundaryId = entry.compactionMeta?.firstKeptMessageId;

	// I1: the system prompt head is never part of the summarize region.
	const head = path[0] && path[0].role === MessageRole.SYSTEM ? [path[0]] : [];

	// Resolve the kept window (02-data-model §2):
	// - absent boundary id → deliberate empty kept: the window starts right
	//   after the entry node (messages appended after a compaction stay kept);
	// - present boundary id → the window starts at that message; an id that no
	//   longer exists on this path (branching, deletion) — or one pointing at
	//   the system prompt itself (corrupt data; the policy and the inspector
	//   never produce it) — is the I3 fail-open: send everything rather than
	//   silently dropping "current" messages or duplicating the system prompt.
	const keptIndex =
		boundaryId === undefined
			? path.findIndex((message) => message.id === entry.id) + 1
			: path.findIndex((message) => message.id === boundaryId);

	const boundaryValid =
		boundaryId === undefined || (keptIndex !== -1 && !(head.length > 0 && keptIndex === 0));

	if (!boundaryValid) {
		return {
			compaction: {
				boundaryValid: false,
				droppedCount: 0,
				entryId: entry.id,
				firstKeptMessageId: boundaryId
			},
			messages: await convertWithSourceIds(path, excludeReasoning)
		};
	}

	// The kept window runs from the window start to the end of the path. The
	// entry node itself sits inside that window (it is a path node — usually
	// the last one) and must NOT be sent again: its content is the summary
	// that is inserted separately. Messages appended after the entry stay kept.
	const kept = path.slice(keptIndex).filter((message) => message.id !== entry.id);

	// The summary travels as a plain user turn so every chat template accepts it
	// (same pattern as the isSynthetic cwd messages); `type: compaction` is only
	// read by the renderer. Its sourceId is the entry's id (the inspector maps
	// it to the entry's real token count).
	const summary: ContextPayloadMessage = {
		content: entry.content,
		role: MessageRole.USER,
		sourceId: entry.id
	};

	const messages = [
		...(await convertWithSourceIds(head, excludeReasoning)),
		summary,
		...(await convertWithSourceIds(kept, excludeReasoning))
	];

	return {
		compaction: {
			boundaryValid: true,
			droppedCount: path
				.slice(head.length, keptIndex)
				.filter((message) => message.id !== entry.id).length,
			entryId: entry.id,
			firstKeptMessageId: boundaryId
		},
		messages
	};
}
