// buildLlmContext: the single choke point from database path to exact API
// payload. ChatService is mocked with a faithful stand-in for
// convertDbMessageToApiChatMessageData (per-message {content, role,
// reasoning_content}) so the tests pin the windowing/insertion semantics;
// the empty-system filter is applied by the builder itself (it mirrors
// normalizeMessagesForApi, v4).

import { MessageRole, MessageType } from '$lib/enums';
import {
	buildLlmContext,
	effectiveCompactionPath,
	findLastCompactionEntry
} from '$lib/services/context/context-builder';
import type { CompactionMeta, DatabaseMessage } from '$lib/types/database';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/services/chat.service', () => ({
	ChatService: {
		// Faithful stand-in for the DB→API conversion. The empty-system filter
		// lives in the builder (it mirrors normalizeMessagesForApi), not here.
		convertDbMessageToApiChatMessageData: vi.fn(async (m: DatabaseMessage) => ({
			content: m.content,
			role: m.role,
			...(m.reasoningContent ? { reasoning_content: m.reasoningContent } : {})
		}))
	}
}));

let seq = 0;

function message(
	role: MessageRole,
	content: string,
	extra?: Partial<DatabaseMessage>
): DatabaseMessage {
	seq += 1;

	return {
		children: [],
		content,
		convId: 'c1',
		id: `m${seq}`,
		parent: null,
		role,
		timestamp: seq,
		type: MessageType.TEXT,
		...extra
	} as DatabaseMessage;
}

function compaction(
	content: string,
	firstKeptMessageId: string | undefined,
	extra?: Partial<CompactionMeta>
): DatabaseMessage {
	return message(MessageRole.USER, content, {
		compactionMeta: {
			firstKeptMessageId,
			summarizedCount: 1,
			...extra
		},
		type: MessageType.COMPACTION
	});
}

describe('findLastCompactionEntry', () => {
	it('returns the last compaction entry on the path (I2)', () => {
		const a = compaction('old', 'x');
		const b = message(MessageRole.USER, 'u');
		const c = compaction('new', 'y');

		expect(findLastCompactionEntry([a, b, c])).toBe(c);
		expect(findLastCompactionEntry([a, b])).toBe(a);
		expect(findLastCompactionEntry([b])).toBeNull();
	});
});

describe('buildLlmContext', () => {
	it('sends the full converted path when no compaction entry exists (regression guard)', async () => {
		const sys = message(MessageRole.SYSTEM, 'you are helpful');
		const u1 = message(MessageRole.USER, 'hello');
		const a1 = message(MessageRole.ASSISTANT, 'hi there');
		const u2 = message(MessageRole.USER, 'again');

		const result = await buildLlmContext([sys, u1, a1, u2]);

		expect(result.compaction).toBeNull();
		expect(result.messages).toEqual([
			{ content: 'you are helpful', role: MessageRole.SYSTEM, sourceId: sys.id },
			{ content: 'hello', role: MessageRole.USER, sourceId: u1.id },
			{ content: 'hi there', role: MessageRole.ASSISTANT, sourceId: a1.id },
			{ content: 'again', role: MessageRole.USER, sourceId: u2.id }
		]);
	});

	it('builds [system, summary, kept…] for a single compaction entry', async () => {
		const sys = message(MessageRole.SYSTEM, 'you are helpful');
		const u1 = message(MessageRole.USER, 'first question');
		const a1 = message(MessageRole.ASSISTANT, 'first answer');
		const u2 = message(MessageRole.USER, 'second question');
		const a2 = message(MessageRole.ASSISTANT, 'second answer');
		const cmp = compaction('SUMMARY OF EARLIER', u2.id);

		const result = await buildLlmContext([sys, u1, a1, u2, a2, cmp]);

		expect(result.messages).toEqual([
			{ content: 'you are helpful', role: MessageRole.SYSTEM, sourceId: sys.id },
			{ content: 'SUMMARY OF EARLIER', role: MessageRole.USER, sourceId: cmp.id },
			{ content: 'second question', role: MessageRole.USER, sourceId: u2.id },
			{ content: 'second answer', role: MessageRole.ASSISTANT, sourceId: a2.id }
		]);
		expect(result.compaction).toEqual({
			boundaryValid: true,
			droppedCount: 2,
			entryId: cmp.id,
			firstKeptMessageId: u2.id
		});
	});

	it('keeps the system prompt first and never summarizes it (I1)', async () => {
		const sys = message(MessageRole.SYSTEM, 'system prompt');
		const u1 = message(MessageRole.USER, 'q1');
		const cmp = compaction('SUMMARY', u1.id);

		const result = await buildLlmContext([sys, u1, cmp]);

		expect(result.messages[0]).toEqual({
			content: 'system prompt',
			role: MessageRole.SYSTEM,
			sourceId: sys.id
		});
		// u1 is the boundary: nothing was dropped
		expect(result.compaction?.droppedCount).toBe(0);
	});

	it('drops the earlier compaction entry when a newer one is in effect (I2)', async () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const cmp1 = compaction('OLD SUMMARY', u1.id);
		const u2 = message(MessageRole.USER, 'q2');
		const a2 = message(MessageRole.ASSISTANT, 'a2');
		const cmp2 = compaction('NEW SUMMARY', u2.id);

		const result = await buildLlmContext([sys, u1, a1, cmp1, u2, a2, cmp2]);

		// only the last entry is in effect; cmp1 sat in the summarize region
		expect(result.messages).toEqual([
			{ content: 'sys', role: MessageRole.SYSTEM, sourceId: sys.id },
			{ content: 'NEW SUMMARY', role: MessageRole.USER, sourceId: cmp2.id },
			{ content: 'q2', role: MessageRole.USER, sourceId: u2.id },
			{ content: 'a2', role: MessageRole.ASSISTANT, sourceId: a2.id }
		]);
		expect(result.compaction?.entryId).toBe(cmp2.id);
	});

	it('sends an older compaction entry inside the kept region as a plain user message (I2)', async () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const cmp1 = compaction('OLD SUMMARY', u1.id);
		const u2 = message(MessageRole.USER, 'q2');
		const a2 = message(MessageRole.ASSISTANT, 'a2');
		// the newer entry's boundary points before cmp1, so cmp1 is kept
		const cmp2 = compaction('NEW SUMMARY', a1.id);

		const result = await buildLlmContext([sys, u1, a1, cmp1, u2, a2, cmp2]);

		// the in-effect entry (cmp2) is not sent twice; cmp1 rides along as user
		expect(result.messages).toEqual([
			{ content: 'sys', role: MessageRole.SYSTEM, sourceId: sys.id },
			{ content: 'NEW SUMMARY', role: MessageRole.USER, sourceId: cmp2.id },
			{ content: 'a1', role: MessageRole.ASSISTANT, sourceId: a1.id },
			{ content: 'OLD SUMMARY', role: MessageRole.USER, sourceId: cmp1.id },
			{ content: 'q2', role: MessageRole.USER, sourceId: u2.id },
			{ content: 'a2', role: MessageRole.ASSISTANT, sourceId: a2.id }
		]);
	});

	it('keeps messages appended after the entry (the post-compaction flow)', async () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const u2 = message(MessageRole.USER, 'q2');
		const a2 = message(MessageRole.ASSISTANT, 'a2');
		const cmp = compaction('SUMMARY', u2.id);
		// the user keeps chatting after the compaction: new turns hang off cmp
		const u3 = message(MessageRole.USER, 'q3');
		const a3 = message(MessageRole.ASSISTANT, 'a3');

		const result = await buildLlmContext([sys, u1, a1, u2, a2, cmp, u3, a3]);

		expect(result.messages).toEqual([
			{ content: 'sys', role: MessageRole.SYSTEM, sourceId: sys.id },
			{ content: 'SUMMARY', role: MessageRole.USER, sourceId: cmp.id },
			{ content: 'q2', role: MessageRole.USER, sourceId: u2.id },
			{ content: 'a2', role: MessageRole.ASSISTANT, sourceId: a2.id },
			{ content: 'q3', role: MessageRole.USER, sourceId: u3.id },
			{ content: 'a3', role: MessageRole.ASSISTANT, sourceId: a3.id }
		]);
		expect(result.compaction?.droppedCount).toBe(2);
	});

	it('fails open (full path) when the boundary id no longer exists (I3)', async () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const cmp = compaction('SUMMARY', 'deleted-message-id');

		const result = await buildLlmContext([sys, u1, a1, cmp]);

		expect(result.compaction).toEqual({
			boundaryValid: false,
			droppedCount: 0,
			entryId: cmp.id,
			firstKeptMessageId: 'deleted-message-id'
		});
		expect(result.messages).toHaveLength(4);
		expect(result.messages[0]).toEqual({ content: 'sys', role: MessageRole.SYSTEM, sourceId: sys.id });
	});

	it('fails open when the boundary points at the system prompt (corrupt data)', async () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const cmp = compaction('SUMMARY', sys.id);

		const result = await buildLlmContext([sys, u1, cmp]);

		expect(result.compaction?.boundaryValid).toBe(false);
		// the system prompt appears exactly once
		expect(result.messages.filter((m) => m.role === MessageRole.SYSTEM)).toHaveLength(1);
		expect(result.messages).toHaveLength(3);
	});

	it('treats an absent firstKeptMessageId as a deliberate empty kept region (all compacted)', async () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const cmp = compaction('SUMMARY', undefined);

		const result = await buildLlmContext([sys, u1, a1, cmp]);

		// payload = [system, summary]; this is NOT the I3 fail-open
		expect(result.messages).toEqual([
			{ content: 'sys', role: MessageRole.SYSTEM, sourceId: sys.id },
			{ content: 'SUMMARY', role: MessageRole.USER, sourceId: cmp.id }
		]);
		expect(result.compaction).toEqual({
			boundaryValid: true,
			droppedCount: 2,
			entryId: cmp.id,
			firstKeptMessageId: undefined
		});
	});

	it('keeps only the messages appended after an empty-kept entry', async () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const cmp = compaction('SUMMARY', undefined);
		// the user keeps chatting after the compaction: new turns hang off cmp
		const u2 = message(MessageRole.USER, 'q2');

		const result = await buildLlmContext([sys, u1, a1, cmp, u2]);

		expect(result.messages).toEqual([
			{ content: 'sys', role: MessageRole.SYSTEM, sourceId: sys.id },
			{ content: 'SUMMARY', role: MessageRole.USER, sourceId: cmp.id },
			{ content: 'q2', role: MessageRole.USER, sourceId: u2.id }
		]);
		expect(result.compaction?.droppedCount).toBe(2);
		expect(result.compaction?.boundaryValid).toBe(true);
	});

	it('treats a missing compactionMeta the same as an absent boundary (empty kept)', async () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const cmp = message(MessageRole.USER, 'SUMMARY', { type: MessageType.COMPACTION });

		const result = await buildLlmContext([sys, u1, cmp]);

		expect(result.compaction?.boundaryValid).toBe(true);
		expect(result.compaction?.firstKeptMessageId).toBeUndefined();
		expect(result.messages).toEqual([
			{ content: 'sys', role: MessageRole.SYSTEM, sourceId: sys.id },
			{ content: 'SUMMARY', role: MessageRole.USER, sourceId: cmp.id }
		]);
	});

	it('filters an empty system head like the current pipeline', async () => {
		const sys = message(MessageRole.SYSTEM, '   ');
		const u1 = message(MessageRole.USER, 'q1');
		const cmp = compaction('SUMMARY', u1.id);

		const result = await buildLlmContext([sys, u1, cmp]);

		expect(result.messages).toEqual([
			{ content: 'SUMMARY', role: MessageRole.USER, sourceId: cmp.id },
			{ content: 'q1', role: MessageRole.USER, sourceId: u1.id }
		]);
	});

	it('strips reasoning_content only when excludeReasoning is set', async () => {
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1', { reasoningContent: 'thinking…' });
		const cmp = compaction('SUMMARY', u1.id);

		const withReasoning = await buildLlmContext([u1, a1, cmp]);
		const withoutReasoning = await buildLlmContext([u1, a1, cmp], { excludeReasoning: true });

		// payload = [summary, u1, a1]
		expect(withReasoning.messages[2]).toEqual({
			content: 'a1',
			reasoning_content: 'thinking…',
			role: MessageRole.ASSISTANT,
			sourceId: a1.id
		});
		expect(withoutReasoning.messages[2]).toEqual({
			content: 'a1',
			role: MessageRole.ASSISTANT,
			sourceId: a1.id
		});
	});
});

// effectiveCompactionPath (N8, 06-status §3.27): the planning input — the
// path as the LLM sees it after the builder applies the in-effect entry. It
// must mirror buildLlmContext's window resolution exactly (I1/I2/I3).
describe('effectiveCompactionPath (N8: the planning input)', () => {
	it('returns the path as-is when no compaction entry exists', () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const path = [sys, u1, a1];

		expect(effectiveCompactionPath(path)).toBe(path);
	});

	it('collapses to [system, entry, kept…] for a single compaction entry', () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const u2 = message(MessageRole.USER, 'q2');
		const a2 = message(MessageRole.ASSISTANT, 'a2');
		const cmp = compaction('SUMMARY', u2.id);

		const effective = effectiveCompactionPath([sys, u1, a1, u2, a2, cmp]);

		// the dropped raw history (u1, a1) is gone; the entry rides as a node
		expect(effective.map((m) => m.id)).toEqual([sys.id, cmp.id, u2.id, a2.id]);
	});

	it('collapses to [system, entry] for an empty-kept entry (all compacted)', () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const cmp = compaction('SUMMARY', undefined);

		const effective = effectiveCompactionPath([sys, u1, a1, cmp]);

		expect(effective.map((m) => m.id)).toEqual([sys.id, cmp.id]);
	});

	it('keeps messages appended after the entry', () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const cmp = compaction('SUMMARY', undefined);
		const u2 = message(MessageRole.USER, 'q2');
		const a2 = message(MessageRole.ASSISTANT, 'a2');

		const effective = effectiveCompactionPath([sys, u1, a1, cmp, u2, a2]);

		expect(effective.map((m) => m.id)).toEqual([sys.id, cmp.id, u2.id, a2.id]);
	});

	it('fails open (the raw path) when the boundary id no longer exists (I3)', () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const cmp = compaction('SUMMARY', 'deleted-message-id');
		const path = [sys, u1, a1, cmp];

		expect(effectiveCompactionPath(path)).toBe(path);
	});

	it('fails open (the raw path) when the boundary points at the system prompt (I3)', () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const cmp = compaction('SUMMARY', sys.id);
		const path = [sys, u1, cmp];

		expect(effectiveCompactionPath(path)).toBe(path);
	});

	it('keeps an older compaction entry in the kept region as a plain node (I2)', () => {
		const sys = message(MessageRole.SYSTEM, 'sys');
		const u1 = message(MessageRole.USER, 'q1');
		const a1 = message(MessageRole.ASSISTANT, 'a1');
		const cmp1 = compaction('OLD SUMMARY', u1.id);
		const u2 = message(MessageRole.USER, 'q2');
		const a2 = message(MessageRole.ASSISTANT, 'a2');
		// the newer entry's boundary points before cmp1, so cmp1 is kept
		const cmp2 = compaction('NEW SUMMARY', a1.id);

		const effective = effectiveCompactionPath([sys, u1, a1, cmp1, u2, a2, cmp2]);

		// only the last entry is in effect; cmp1 stays as a plain user node
		expect(effective.map((m) => m.id)).toEqual([sys.id, cmp2.id, a1.id, cmp1.id, u2.id, a2.id]);
	});
});
