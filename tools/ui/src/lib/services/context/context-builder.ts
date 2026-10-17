/**
 * Context builder — the single choke point from "database path" to
 * "exact API payload".
 *
 * `sendMessage`, `preEncode`, the agentic flow and the inspector all go
 * through {@link buildLlmContext}, which guarantees WYSIWYG: what the
 * inspector shows is what goes over the wire (context-enhance/03 §2).
 * Compaction planning (second and later compactions) runs on
 * {@link effectiveCompactionPath} — the same builder view — so the summarize
 * region never re-includes messages an older entry already dropped (N8,
 * 06-status §3.27).
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
 * The resolved compaction window of a path — the shared core of
 * {@link buildLlmContext} and {@link effectiveCompactionPath} (N8,
 * 06-status §3.27): I1 system head, I2 last entry in effect, I3 fail-open on
 * an invalid boundary. Null when the path has no compaction entry.
 */
interface CompactionWindow {
	/** The boundary id the entry claims (absent = deliberate empty kept). */
	boundaryId?: string;
	/** false = I3 fail-open (the builder sends the full path). */
	boundaryValid: boolean;
	/** The in-effect (last) compaction entry (I2). */
	entry: DatabaseMessage;
	/** The system prompt head (I1) — empty when the path has no system prompt. */
	head: DatabaseMessage[];
	/** The kept window (the entry excluded) — empty when the boundary is invalid. */
	kept: DatabaseMessage[];
	/** Index of the kept window's start in the path (-1 when the boundary is invalid). */
	keptIndex: number;
}

/** Resolves the compaction window of a path (see {@link CompactionWindow}). */
function resolveCompactionWindow(path: DatabaseMessage[]): CompactionWindow | null {
	const entry = findLastCompactionEntry(path);

	if (!entry) return null;

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
		return { boundaryId, boundaryValid: false, entry, head, kept: [], keptIndex: -1 };
	}

	// The kept window runs from the window start to the end of the path. The
	// entry node itself sits inside that window (it is a path node — usually
	// the last one) and is excluded here: its content is the summary, which
	// the callers insert separately. Messages appended after the entry stay kept.
	const kept = path.slice(keptIndex).filter((message) => message.id !== entry.id);

	return { boundaryId, boundaryValid: true, entry, head, kept, keptIndex };
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

	const window = resolveCompactionWindow(path);

	if (!window) {
		return {
			compaction: null,
			messages: await convertWithSourceIds(path, excludeReasoning)
		};
	}

	const { entry, head, kept, keptIndex } = window;

	if (!window.boundaryValid) {
		return {
			compaction: {
				boundaryValid: false,
				droppedCount: 0,
				entryId: entry.id,
				firstKeptMessageId: window.boundaryId
			},
			messages: await convertWithSourceIds(path, excludeReasoning)
		};
	}

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
			firstKeptMessageId: window.boundaryId
		},
		messages
	};
}

/**
 * The path as the LLM sees it after the builder applies the in-effect
 * compaction entry (N8, 06-status §3.27):
 * [system head?, old summary (plain node), kept…].
 *
 * Compaction PLANNING must run on this effective path, not the raw DB path:
 * on the raw path the summarize region re-includes the messages the old entry
 * already dropped, and a prefix-stable summary call would resend the whole
 * original history (context overflow — the second compaction can never
 * produce a summary, 06-status §3.27).
 *
 * Mirrors {@link buildLlmContext} exactly (the same window resolution,
 * I1/I2/I3):
 * - no compaction entry → the path as-is;
 * - invalid boundary (I3 fail-open) → the path as-is (the builder sends the
 *   full path);
 * - otherwise → [head…, entry, kept…]: the entry stays in the array as a
 *   plain node (role=user is a legal cut point; its content is the old
 *   summary, so the new summary rolls it forward — 02-§4 "second compaction").
 */
export function effectiveCompactionPath(path: DatabaseMessage[]): DatabaseMessage[] {
	const window = resolveCompactionWindow(path);

	if (!window || !window.boundaryValid) return path;

	return [...window.head, window.entry, ...window.kept];
}
