// buildSummaryTranscript: the plain-text transcript fed to the summary call.
// Attachments must become placeholders (never base64), tool calls reduce to
// their names, and empty messages drop out entirely.

import { AttachmentType, MessageRole, MessageType } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import {
	buildSummaryTranscript,
	DEFAULT_SUMMARY_PROMPT,
	SPLIT_TURN_SUMMARY_PROMPT,
	summarizeMessages
} from '$lib/services/context/summarize';
import type { CompactionPlan } from '$lib/services/context/types';
import type { DatabaseMessage } from '$lib/types/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/services/chat.service', () => ({
	ChatService: {
		// Pass-through conversion: the payload-structure tests assert on order,
		// roles and the trailing instruction — not on the DB→API mapping itself.
		normalizeMessagesForApi: vi.fn(async (messages: unknown[]) => messages),
		sendMessage: vi.fn()
	}
}));

function message(role: MessageRole, content: string, extra?: Partial<DatabaseMessage>): DatabaseMessage {
	return {
		children: [],
		content,
		convId: 'c1',
		id: `m${Math.random()}`,
		parent: null,
		role,
		timestamp: 0,
		type: MessageType.TEXT,
		...extra
	} as DatabaseMessage;
}

describe('buildSummaryTranscript', () => {
	it('renders each message as [role] content', () => {
		const transcript = buildSummaryTranscript([
			message(MessageRole.USER, 'fix the login bug'),
			message(MessageRole.ASSISTANT, 'on it — checking auth.ts')
		]);

		expect(transcript).toBe('[user] fix the login bug\n\n[assistant] on it — checking auth.ts');
	});

	it('reduces tool calls to their names', () => {
		const transcript = buildSummaryTranscript([
			message(MessageRole.ASSISTANT, '', {
				toolCalls: JSON.stringify([
					{ function: { name: 'read_file' }, id: 'c1' },
					{ function: { name: 'write_file' }, id: 'c2' }
				])
			}),
			message(MessageRole.TOOL, 'file content here', { toolCallId: 'c1' })
		]);

		expect(transcript).toContain('[tool_calls: read_file, write_file]');
		expect(transcript).toContain('[tool] file content here');
	});

	it('uses a generic placeholder for malformed toolCalls JSON', () => {
		const transcript = buildSummaryTranscript([
			message(MessageRole.ASSISTANT, 'doing things', { toolCalls: '{not-json' })
		]);

		expect(transcript).toContain('[tool_calls: unparsed]');
	});

	it('turns attachments into placeholders without base64', () => {
		const transcript = buildSummaryTranscript([
			message(MessageRole.USER, 'see the screenshot', {
				extra: [
					{ base64Url: 'data:image/jpeg;base64,SECRET', name: 'shot.jpg', type: AttachmentType.IMAGE },
					{ content: 'const a = 1;', name: 'x.ts', size: 1234, type: AttachmentType.TEXT },
					{
						base64Data: 'data:application/pdf;base64,xx',
						content: 'pdf text',
						images: ['data:image/png;base64,a', 'data:image/png;base64,b'],
						name: 'doc.pdf',
						processedAsImages: true,
						type: AttachmentType.PDF
					},
					{ base64Data: 'SECRET', mimeType: 'audio/mpeg', name: 'note.mp3', type: AttachmentType.AUDIO }
				]
			})
		]);

		expect(transcript).toContain('[image: shot.jpg]');
		expect(transcript).toContain('[file: x.ts, 1.21 KB]');
		expect(transcript).toContain('[pdf: doc.pdf, 2 pages as images]');
		expect(transcript).toContain('[audio: note.mp3]');
		expect(transcript).not.toContain('SECRET');
	});

	it('drops empty messages and joins the rest with blank lines', () => {
		const transcript = buildSummaryTranscript([
			message(MessageRole.ASSISTANT, ''),
			message(MessageRole.USER, 'hello'),
			message(MessageRole.ASSISTANT, 'world')
		]);

		expect(transcript).toBe('[user] hello\n\n[assistant] world');
	});

	it('returns an empty string for an empty region', () => {
		expect(buildSummaryTranscript([])).toBe('');
	});
});

// --- summarizeMessages abort (N3 stop button) --------------------------------

function makePlan(): CompactionPlan {
	const summarized = message(MessageRole.USER, 'old question');
	const kept = message(MessageRole.USER, 'recent question');

	return {
		cutIndex: 1,
		estimatedTokensAfter: 10,
		estimatedTokensBefore: 20,
		firstKeptMessageId: kept.id,
		isSplitTurn: false,
		kept: [kept],
		systemHead: null,
		toSummarize: [summarized]
	};
}

/** Plan with a system head and a multi-role region (user / assistant+tool_calls / tool). */
function makePlanWithHead(): CompactionPlan {
	const head = message(MessageRole.SYSTEM, 'be terse');
	const toSummarize = [
		message(MessageRole.USER, 'old question'),
		message(MessageRole.ASSISTANT, '', {
			toolCalls: JSON.stringify([{ function: { name: 'read_file' }, id: 'c1' }])
		}),
		message(MessageRole.TOOL, 'file content here', { toolCallId: 'c1' })
	];
	const kept = message(MessageRole.USER, 'recent question');

	return {
		cutIndex: 4,
		estimatedTokensAfter: 10,
		estimatedTokensBefore: 20,
		firstKeptMessageId: kept.id,
		isSplitTurn: false,
		kept: [kept],
		systemHead: head,
		toSummarize
	};
}

function lastSentMessages(): { content: string; role: string }[] {
	return (vi.mocked(ChatService.sendMessage).mock.calls.at(-1)?.[0] ?? []) as unknown as {
		content: string;
		role: string;
	}[];
}

describe('summarizeMessages (abort, N3)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	it('throws an AbortError when the signal is aborted', async () => {
		// The real ChatService swallows a fetch AbortError and returns undefined;
		// summarizeMessages must re-surface it as a real abort so the store can
		// distinguish "stopped" from "failed" (fail-open, no cmp node).
		const controller = new AbortController();

		controller.abort();
		vi.mocked(ChatService.sendMessage).mockResolvedValue(undefined);

		await expect(summarizeMessages(makePlan(), null, controller.signal)).rejects.toMatchObject({
			name: 'AbortError'
		});
	});

	it('still throws for an empty response without a signal', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue(undefined);

		await expect(summarizeMessages(makePlan(), null)).rejects.toThrow('empty response');
	});
});

// --- summarizeMessages payload (N4 prefix-stable mode) ------------------------

describe('summarizeMessages (prefix-stable payload, N4)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('defaults to prefix-stable: [system head, region (order/roles kept), instruction (user)]', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');
		const plan = makePlanWithHead();

		await summarizeMessages(plan, null);

		// Head and region go through the same conversion as the main send path,
		// so the prefix is identical to the conversation payload's prefix.
		expect(ChatService.normalizeMessagesForApi).toHaveBeenCalledWith([plan.systemHead]);
		expect(ChatService.normalizeMessagesForApi).toHaveBeenCalledWith(plan.toSummarize);

		const sent = lastSentMessages();

		expect(sent.map(({ content, role }) => ({ content, role }))).toEqual([
			{ content: 'be terse', role: MessageRole.SYSTEM },
			{ content: 'old question', role: MessageRole.USER },
			{ content: '', role: MessageRole.ASSISTANT },
			{ content: 'file content here', role: MessageRole.TOOL },
			{ content: DEFAULT_SUMMARY_PROMPT, role: MessageRole.USER }
		]);
		expect(vi.mocked(ChatService.sendMessage).mock.calls.at(-1)?.[1]).toMatchObject({
			excludeReasoningFromContext: false,
			stream: false
		});
	});

	it('split-turn variant only swaps the trailing instruction (prefix identical)', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');
		// One shared plan for both calls: the point of the test is that only the
		// trailing instruction differs, so the prefix must come from the same
		// message objects (fresh plans would carry fresh random ids).
		const plan = makePlanWithHead();

		await summarizeMessages(plan, null);
		const normal = lastSentMessages();

		await summarizeMessages({ ...plan, isSplitTurn: true }, null);
		const split = lastSentMessages();

		expect(split.slice(0, -1)).toEqual(normal.slice(0, -1));
		expect(split[split.length - 1]).toEqual({ content: SPLIT_TURN_SUMMARY_PROMPT, role: MessageRole.USER });
	});

	it('a custom prompt replaces the trailing instruction (trimmed)', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');

		await summarizeMessages(makePlanWithHead(), null, undefined, { prompt: '  my custom prompt  ' });

		const sent = lastSentMessages();

		expect(sent[sent.length - 1]).toEqual({ content: 'my custom prompt', role: MessageRole.USER });
	});

	it('omits the head when the path has no system prompt', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');
		const plan = { ...makePlanWithHead(), systemHead: null };

		await summarizeMessages(plan, null);

		const sent = lastSentMessages();

		expect(sent).toHaveLength(plan.toSummarize.length + 1);
		expect(sent[0].role).toBe(MessageRole.USER);
	});

	it('passes excludeReasoning through to the send options (D2)', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');

		await summarizeMessages(makePlanWithHead(), null, undefined, { excludeReasoning: true });

		expect(vi.mocked(ChatService.sendMessage).mock.calls.at(-1)?.[1]).toMatchObject({
			excludeReasoningFromContext: true
		});
	});
});

// --- summarizeMessages payload (transcript fallback) --------------------------

describe('summarizeMessages (transcript fallback, v1)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('keeps the v1 shape [system (instruction), user (flat transcript)]', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');
		const plan = makePlanWithHead();

		await summarizeMessages(plan, null, undefined, { mode: 'transcript' });

		expect(ChatService.normalizeMessagesForApi).not.toHaveBeenCalled();
		expect(lastSentMessages()).toEqual([
			{ content: DEFAULT_SUMMARY_PROMPT, role: MessageRole.SYSTEM },
			{ content: buildSummaryTranscript(plan.toSummarize), role: MessageRole.USER }
		]);
	});
});
