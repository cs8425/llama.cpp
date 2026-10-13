// Compaction policy: token estimation and two-stage cut-point selection
// (boundary-first, split user-message span as fallback). The cut must never
// land on a tool result (I4) and the kept region must respect I5.

import { AttachmentType, ContentPartType, FileTypeAudio, MessageRole, MessageType } from '$lib/enums';
import { estimateApiMessageTokens, estimateTokens, planCompaction } from '$lib/services/context/compaction-policy';
import type { CompactionBudget } from '$lib/services/context/types';
import type { ApiChatMessageData } from '$lib/types/api';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import { describe, expect, it } from 'vitest';

function message(
	id: string,
	role: MessageRole,
	content: string,
	extra?: Partial<DatabaseMessage>
): DatabaseMessage {
	return {
		children: [],
		content,
		convId: 'c1',
		id,
		parent: null,
		role,
		timestamp: 0,
		type: MessageType.TEXT,
		...extra
	} as DatabaseMessage;
}

function budget(keepBudgetTokens: number, overrides: Partial<CompactionBudget> = {}): CompactionBudget {
	return {
		keepBudgetTokens,
		minKeptMessages: 2,
		minKeptUserTurns: 4,
		minSummarizeTokens: 10,
		...overrides
	};
}

// 4 chars = 1 token, so 400-char content = 100 tokens.
const T100 = 'x'.repeat(400);
const T400 = 'x'.repeat(1600);

describe('estimateTokens', () => {
	it('estimates plain content at chars/4', () => {
		expect(estimateTokens(message('m', MessageRole.USER, T100))).toBe(100);
		expect(estimateTokens(message('m', MessageRole.USER, ''))).toBe(0);
	});

	it('adds toolCalls and reasoning content at chars/4', () => {
		const withCalls = message('m', MessageRole.ASSISTANT, T100, {
			reasoningContent: T100,
			toolCalls: JSON.stringify([{ function: { name: 'read_file' }, id: 'c1' }])
		});

		expect(estimateTokens(withCalls)).toBeGreaterThan(200);
	});

	it('prices image, audio and video attachments flat', () => {
		const image: DatabaseMessageExtra = {
			base64Url: 'data:image/jpeg;base64,xx',
			name: 'a.jpg',
			type: AttachmentType.IMAGE
		};
		const audio: DatabaseMessageExtra = {
			base64Data: 'xx',
			mimeType: 'audio/mpeg',
			name: 'a.mp3',
			type: AttachmentType.AUDIO
		};
		const video: DatabaseMessageExtra = {
			base64Data: 'xx',
			mimeType: 'video/mp4',
			name: 'a.mp4',
			type: AttachmentType.VIDEO
		};

		expect(estimateTokens(message('m', MessageRole.USER, '', { extra: [image] }))).toBe(1000);
		expect(estimateTokens(message('m', MessageRole.USER, '', { extra: [audio] }))).toBe(3000);
		expect(estimateTokens(message('m', MessageRole.USER, '', { extra: [video] }))).toBe(3000);
	});

	it('prices text attachments by content length and PDFs by pages or text', () => {
		const text: DatabaseMessageExtra = {
			content: T100,
			name: 'x.ts',
			size: 400,
			type: AttachmentType.TEXT
		};
		const pdfImages: DatabaseMessageExtra = {
			base64Data: 'data:application/pdf;base64,xx',
			content: '',
			images: ['data:image/png;base64,a', 'data:image/png;base64,b', 'data:image/png;base64,c'],
			name: 'd.pdf',
			processedAsImages: true,
			type: AttachmentType.PDF
		};
		const pdfText: DatabaseMessageExtra = {
			base64Data: 'data:application/pdf;base64,xx',
			content: T100,
			name: 'd.pdf',
			processedAsImages: false,
			type: AttachmentType.PDF
		};

		expect(estimateTokens(message('m', MessageRole.USER, '', { extra: [text] }))).toBe(100);
		expect(estimateTokens(message('m', MessageRole.USER, '', { extra: [pdfImages] }))).toBe(3000);
		expect(estimateTokens(message('m', MessageRole.USER, '', { extra: [pdfText] }))).toBe(100);
	});
});

describe('estimateApiMessageTokens', () => {
	it('estimates string content at chars/4 and adds reasoning and tool calls', () => {
		const base: ApiChatMessageData = { content: T100, role: MessageRole.USER };

		expect(estimateApiMessageTokens(base)).toBe(100);

		const withExtras: ApiChatMessageData = {
			content: '',
			reasoning_content: T100,
			role: MessageRole.ASSISTANT,
			tool_calls: [{ function: { arguments: '{}', name: 'read_file' }, id: 'c1', type: 'function' }]
		};

		expect(estimateApiMessageTokens(withExtras)).toBeGreaterThan(100);
	});

	it('prices content parts: text/4, image flat 1000, audio/video flat 3000', () => {
		const text: ApiChatMessageData = {
			content: [{ text: T100, type: ContentPartType.TEXT }],
			role: MessageRole.USER
		};
		const image: ApiChatMessageData = {
			content: [{ image_url: { url: 'data:image/png;base64,xx' }, type: ContentPartType.IMAGE_URL }],
			role: MessageRole.USER
		};
		const audio: ApiChatMessageData = {
			content: [{ input_audio: { data: 'xx', format: FileTypeAudio.WAV }, type: ContentPartType.INPUT_AUDIO }],
			role: MessageRole.USER
		};
		const video: ApiChatMessageData = {
			content: [{ input_video: { data: 'xx', format: 'mp4' }, type: ContentPartType.INPUT_VIDEO }],
			role: MessageRole.USER
		};

		expect(estimateApiMessageTokens(text)).toBe(100);
		expect(estimateApiMessageTokens(image)).toBe(1000);
		expect(estimateApiMessageTokens(audio)).toBe(3000);
		expect(estimateApiMessageTokens(video)).toBe(3000);
	});

	it('combines parts with the same heuristics as the DB-form estimator', () => {
		const mixed: ApiChatMessageData = {
			content: [
				{ image_url: { url: 'data:image/png;base64,xx' }, type: ContentPartType.IMAGE_URL },
				{ text: T100, type: ContentPartType.TEXT }
			],
			role: MessageRole.USER
		};

		expect(estimateApiMessageTokens(mixed)).toBe(1100);
	});
});

describe('planCompaction', () => {
	it('returns null when the whole path fits the keep budget (nothing to summarize)', () => {
		// system + 2 short turns: the earliest legal cut leaves an empty
		// summarize region, which is below minSummarizeTokens.
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, 'hi'),
			message('a1', MessageRole.ASSISTANT, 'hello')
		];

		expect(planCompaction(path, budget(1000, { minSummarizeTokens: 10 }))).toBeNull();
	});

	it('cuts at a user-message boundary, keeps within budget, and honors minKeptUserTurns', () => {
		// the first two turns are oversized so the earliest user boundary that
		// fits the budget is u2, leaving exactly 4 user messages in the kept region
		const path = [
			message('sys', MessageRole.SYSTEM, T100), // 100
			message('u1', MessageRole.USER, T400), // 400
			message('a1', MessageRole.ASSISTANT, T400),
			message('u2', MessageRole.USER, T400),
			message('a2', MessageRole.ASSISTANT, T400),
			message('u3', MessageRole.USER, T100),
			message('a3', MessageRole.ASSISTANT, T100),
			message('u4', MessageRole.USER, T100),
			message('a4', MessageRole.ASSISTANT, T100),
			message('u5', MessageRole.USER, T100),
			message('a5', MessageRole.ASSISTANT, T100)
		];

		const plan = planCompaction(path, budget(1400));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(false);
		expect(plan?.firstKeptMessageId).toBe('u2');
		// kept = u2..a5 → 800 tokens ≤ budget, 4 user messages
		expect(plan?.kept.map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
		expect(plan?.kept.reduce((s, m) => s + estimateTokens(m), 0)).toBeLessThanOrEqual(1400);
		// summarize = u1..a1, system prompt excluded (I1)
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1']);
		expect(plan?.estimatedTokensBefore).toBe(2300);
	});

	it('refuses a boundary cut that would leave fewer than minKeptUserTurns user messages', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100),
			message('u2', MessageRole.USER, T100),
			message('a2', MessageRole.ASSISTANT, T100)
		];

		// only u2 can satisfy the budget → 1 user message < 4
		expect(planCompaction(path, budget(200, { minKeptUserTurns: 4 }))).toBeNull();
	});

	it('splits a single oversized span at an assistant message, keeping the recent tool exchange', () => {
		const toolCalls = JSON.stringify([{ function: { name: 'read_file' }, id: 'c1' }]);
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100, { toolCalls }),
			message('t1', MessageRole.TOOL, T100, { toolCallId: 'c1' }),
			message('a2', MessageRole.ASSISTANT, T100, { toolCalls }),
			message('t2', MessageRole.TOOL, T100, { toolCallId: 'c2' }),
			message('a3', MessageRole.ASSISTANT, T100, { toolCalls }),
			message('t3', MessageRole.TOOL, T100, { toolCallId: 'c3' })
		];

		const plan = planCompaction(path, budget(300, { minKeptMessages: 2 }));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(true);
		// cut at a3: kept starts with assistant (tool_calls) + its tool result
		expect(plan?.firstKeptMessageId).toBe('a3');
		expect(plan?.kept.map((m) => m.id)).toEqual(['a3', 't3']);
		expect(plan?.kept[0].role).toBe(MessageRole.ASSISTANT);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1', 't1', 'a2', 't2']);
	});

	it('never cuts on a tool result, even in a pure assistant/tool alternation', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('a1', MessageRole.ASSISTANT, T100),
			message('t1', MessageRole.TOOL, T100, { toolCallId: 'c1' }),
			message('a2', MessageRole.ASSISTANT, T100),
			message('t2', MessageRole.TOOL, T100, { toolCallId: 'c2' }),
			message('a3', MessageRole.ASSISTANT, T100),
			message('t3', MessageRole.TOOL, T100, { toolCallId: 'c3' })
		];

		const plan = planCompaction(path, budget(200));

		expect(plan).not.toBeNull();
		expect(path[plan!.cutIndex].role).toBe(MessageRole.ASSISTANT);
		expect(plan?.kept[0].role).toBe(MessageRole.ASSISTANT);
		// every kept tool result still follows its assistant tool_call message
		for (let i = 1; i < plan!.kept.length; i++) {
			if (plan!.kept[i].role === MessageRole.TOOL) {
				expect(plan!.kept[i - 1].role).toBe(MessageRole.ASSISTANT);
			}
		}
	});

	it('summarizes a huge single user message (split cut) when it alone exceeds the budget', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, 'x'.repeat(1600)), // 400 tokens
			message('a1', MessageRole.ASSISTANT, T100),
			message('t1', MessageRole.TOOL, T100, { toolCallId: 'c1' })
		];

		const plan = planCompaction(path, budget(300));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(true);
		expect(plan?.firstKeptMessageId).toBe('a1');
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1']);
	});

	it('returns null when even a split cut cannot fit the budget', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, 'x'.repeat(1600)), // 400 tokens
			message('a1', MessageRole.ASSISTANT, T100)
		];

		expect(planCompaction(path, budget(50))).toBeNull();
	});

	it('returns null when the summarize region is below minSummarizeTokens', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, 'hi'), // 2 tokens
			message('a1', MessageRole.ASSISTANT, T100),
			message('u2', MessageRole.USER, T100),
			message('a2', MessageRole.ASSISTANT, T100),
			message('u3', MessageRole.USER, T100),
			message('a3', MessageRole.ASSISTANT, T100),
			message('u4', MessageRole.USER, T100),
			message('a4', MessageRole.ASSISTANT, T100)
		];

		// cut at u2 → summarize region is u1+a1 = 102 tokens < 200
		expect(planCompaction(path, budget(500, { minSummarizeTokens: 200 }))).toBeNull();
	});

	it('handles a path without a system prompt', () => {
		const path = [
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100),
			message('u2', MessageRole.USER, T100),
			message('a2', MessageRole.ASSISTANT, T100),
			message('u3', MessageRole.USER, T100),
			message('a3', MessageRole.ASSISTANT, T100),
			message('u4', MessageRole.USER, T100),
			message('a4', MessageRole.ASSISTANT, T100)
		];

		const plan = planCompaction(path, budget(400, { minKeptUserTurns: 2 }));

		expect(plan).not.toBeNull();
		expect(plan?.firstKeptMessageId).toBe('u3');
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
	});
});
