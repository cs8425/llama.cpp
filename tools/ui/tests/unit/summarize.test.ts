// buildSummaryTranscript: the plain-text transcript fed to the summary call.
// Attachments must become placeholders (never base64), tool calls reduce to
// their names, and empty messages drop out entirely.
//
// summarizeMessages returns a SummaryResult { content, tokens }: the trimmed
// text plus the server's actual completion tokens (timings.predicted_n) when
// reported, null otherwise. summarizeWithRetry is the shared over-target
// mechanism for both compaction modes: summarize → mode-specific success
// check → retry × maxAttempts → user gate (use / retry / skip).

import { AttachmentType, MessageRole, MessageType } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import {
	buildSummaryTranscript,
	DEFAULT_SUMMARY_PROMPT,
	SPLIT_TURN_SUMMARY_PROMPT,
	summarizeMessages,
	summarizeWithRetry,
	toSummaryMode
} from '$lib/services/context/summarize';
import type { CompactionSummaryGate, SummarizeWithRetryOptions } from '$lib/services/context/summarize';
import type { CompactionPlan } from '$lib/services/context/types';
import type { ChatMessageTimings, SettingsChatServiceOptions } from '$lib/types';
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

// --- toSummaryMode (contextSummaryMode setting) -------------------------------

describe('toSummaryMode', () => {
	it('accepts the two known modes verbatim', () => {
		expect(toSummaryMode('prefix-stable')).toBe('prefix-stable');
		expect(toSummaryMode('transcript')).toBe('transcript');
	});

	it('falls back to prefix-stable for unknown / corrupted values', () => {
		expect(toSummaryMode(undefined)).toBe('prefix-stable');
		expect(toSummaryMode('')).toBe('prefix-stable');
		expect(toSummaryMode('bogus')).toBe('prefix-stable');
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
		keptTokens: 10,
		realMessageTokens: new Map(),
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
		keptTokens: 10,
		realMessageTokens: new Map(),
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

		const result = await summarizeMessages(plan, null);

		// the return value is the SummaryResult: trimmed content, no timings
		// reported by this mock → null tokens
		expect(result).toEqual({ content: 'the summary', tokens: null });

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

	it('sends the old summary as a plain user turn when the region contains an old compaction entry (N8)', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the rolled summary');
		// The second compaction's plan runs on the effective path: the
		// summarize region is [old summary (user role), new messages…] —
		// never the raw history the old entry dropped.
		const oldSummary = message(MessageRole.USER, 'OLD SUMMARY', { type: MessageType.COMPACTION });
		const fresh = message(MessageRole.USER, 'new question');
		const plan = { ...makePlanWithHead(), toSummarize: [oldSummary, fresh] };

		await summarizeMessages(plan, null);

		const sent = lastSentMessages();

		expect(sent.map(({ content, role }) => ({ content, role }))).toEqual([
			{ content: 'be terse', role: MessageRole.SYSTEM },
			{ content: 'OLD SUMMARY', role: MessageRole.USER },
			{ content: 'new question', role: MessageRole.USER },
			{ content: DEFAULT_SUMMARY_PROMPT, role: MessageRole.USER }
		]);
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

// --- summarizeMessages return value (dual-mode SummaryResult) ---------------

describe('summarizeMessages (SummaryResult)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('trims the content and reports null tokens when the server sent no timings', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('  padded summary  ');

		const result = await summarizeMessages(makePlan(), null);

		expect(result).toEqual({ content: 'padded summary', tokens: null });
	});

	it('captures the actual completion tokens from the response timings', async () => {
		vi.mocked(ChatService.sendMessage).mockImplementation(
			async (_messages: unknown, options?: SettingsChatServiceOptions) => {
				options?.onComplete?.('the summary', undefined, { predicted_n: 123 });
				return 'the summary';
			}
		);

		const result = await summarizeMessages(makePlan(), null);

		expect(result).toEqual({ content: 'the summary', tokens: 123 });
	});

	it('reports null tokens when the timings lack predicted_n', async () => {
		vi.mocked(ChatService.sendMessage).mockImplementation(
			async (_messages: unknown, options?: SettingsChatServiceOptions) => {
				options?.onComplete?.('the summary', undefined, { prompt_n: 42 });
				return 'the summary';
			}
		);

		const result = await summarizeMessages(makePlan(), null);

		expect(result).toEqual({ content: 'the summary', tokens: null });
	});
});

// --- summarizeWithRetry (shared over-target mechanism, both modes) ----------

function baseRetryOptions(overrides: Partial<SummarizeWithRetryOptions> = {}): SummarizeWithRetryOptions {
	return {
		checkParams: {
			contextKeepRecentTokens: 2000,
			contextKeepTargetPercent: 50,
			contextMaxContextOverride: 0,
			nCtx: 10000
		},
		compactionMode: 'threshold-target',
		maxAttempts: 3,
		nCtx: 10000,
		...overrides
	};
}

/** Mock the summary call with a fixed content (optionally reporting timings). */
function mockSummary(content: string, timings?: ChatMessageTimings) {
	vi.mocked(ChatService.sendMessage).mockImplementation(
		async (_messages: unknown, options?: SettingsChatServiceOptions) => {
			options?.onComplete?.(content, undefined, timings);
			return content;
		}
	);
}

/**
 * Plan with a 400-byte head and a 10 000-token kept region (mode A pricing,
 * v4: the success check reads the plan's real kept tokens — the system head
 * counts 0, folded into the first segment total, not byte sizes).
 */
function makeBigKeptPlan(): CompactionPlan {
	const head = message(MessageRole.SYSTEM, 'h'.repeat(400));
	const kept = message(MessageRole.USER, 'x'.repeat(10000));

	return {
		cutIndex: 1,
		estimatedTokensAfter: 0,
		estimatedTokensBefore: 0,
		firstKeptMessageId: kept.id,
		isSplitTurn: false,
		kept: [kept],
		keptTokens: 10000,
		realMessageTokens: new Map(),
		systemHead: head,
		toSummarize: [message(MessageRole.USER, 'old')]
	};
}

describe('summarizeWithRetry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('passes a within-target summary on the first attempt', async () => {
		mockSummary('short summary');

		const result = await summarizeWithRetry(makePlan(), null, undefined, baseRetryOptions());

		expect(result).toEqual({ content: 'short summary', tokens: null });
		expect(vi.mocked(ChatService.sendMessage)).toHaveBeenCalledTimes(1);
	});

	it('retries up to maxAttempts and accepts the result when there is no gate (fail-open)', async () => {
		mockSummary('x'.repeat(6000)); // 6000 > 5000 (B: keepTarget 50% of 10000)

		const result = await summarizeWithRetry(makePlan(), null, undefined, baseRetryOptions({ maxAttempts: 3 }));

		expect(result?.content).toBe('x'.repeat(6000));
		expect(vi.mocked(ChatService.sendMessage)).toHaveBeenCalledTimes(3);
	});

	it('accepts the over-target summary when the gate says use', async () => {
		mockSummary('x'.repeat(6000));
		const gate: CompactionSummaryGate = { requestDecision: vi.fn().mockResolvedValue('use') };

		const result = await summarizeWithRetry(makePlan(), null, undefined, baseRetryOptions({ gate, maxAttempts: 1 }));

		expect(result?.content).toBe('x'.repeat(6000));
		expect(gate.requestDecision).toHaveBeenCalledWith({
			attempts: 1,
			mode: 'threshold-target',
			postSize: 6000,
			target: 5000
		});
		expect(vi.mocked(ChatService.sendMessage)).toHaveBeenCalledTimes(1);
	});

	it('returns null (no entry) when the gate says skip', async () => {
		mockSummary('x'.repeat(6000));
		const gate: CompactionSummaryGate = { requestDecision: vi.fn().mockResolvedValue('skip') };

		const result = await summarizeWithRetry(makePlan(), null, undefined, baseRetryOptions({ gate, maxAttempts: 1 }));

		expect(result).toBeNull();
	});

	it('recomputes the attempt counter after a gate retry and succeeds on the next pass', async () => {
		let calls = 0;

		vi.mocked(ChatService.sendMessage).mockImplementation(
			async (_messages: unknown, options?: SettingsChatServiceOptions) => {
				calls++;
				const content = calls === 1 ? 'x'.repeat(6000) : 'short now';

				options?.onComplete?.(content, undefined, undefined);
				return content;
			}
		);
		const gate: CompactionSummaryGate = { requestDecision: vi.fn().mockResolvedValue('retry') };

		const result = await summarizeWithRetry(makePlan(), null, undefined, baseRetryOptions({ gate, maxAttempts: 1 }));

		expect(result).toEqual({ content: 'short now', tokens: null });
		expect(gate.requestDecision).toHaveBeenCalledTimes(1);
		expect(vi.mocked(ChatService.sendMessage)).toHaveBeenCalledTimes(2);
	});

	it('retries without limit when maxAttempts ≤ 0, until within target (no gate)', async () => {
		let calls = 0;

		vi.mocked(ChatService.sendMessage).mockImplementation(
			async (_messages: unknown, options?: SettingsChatServiceOptions) => {
				calls++;
				const content = calls < 3 ? 'x'.repeat(6000) : 'fits';

				options?.onComplete?.(content, undefined, undefined);
				return content;
			}
		);
		const gate: CompactionSummaryGate = { requestDecision: vi.fn().mockResolvedValue('use') };

		const result = await summarizeWithRetry(makePlan(), null, undefined, baseRetryOptions({ gate, maxAttempts: 0 }));

		expect(result?.content).toBe('fits');
		expect(vi.mocked(ChatService.sendMessage)).toHaveBeenCalledTimes(3);
		expect(gate.requestDecision).not.toHaveBeenCalled();
	});

	it('prices the kept region into the check in mode A (summary + kept ≤ window − keep)', async () => {
		mockSummary('s'); // 1 byte
		const gate: CompactionSummaryGate = { requestDecision: vi.fn().mockResolvedValue('use') };

		// A: 1 (summary) + 10000 (plan.keptTokens) = 10001 > 10000 − 2000 =
		// 8000 → over target. The system head counts 0 (v4). The same plan
		// would be within target in mode B (1 ≤ 5000) — this pins the
		// mode-A formula.
		const result = await summarizeWithRetry(makeBigKeptPlan(), null, undefined, baseRetryOptions({
			compactionMode: 'recent-window',
			gate,
			maxAttempts: 1
		}));

		expect(result?.content).toBe('s');
		expect(gate.requestDecision).toHaveBeenCalledWith({
			attempts: 1,
			mode: 'recent-window',
			postSize: 10001,
			target: 8000
		});
	});

	it('skips the check entirely when nCtx is unknown (≤ 0)', async () => {
		mockSummary('x'.repeat(6000));
		const gate: CompactionSummaryGate = { requestDecision: vi.fn().mockResolvedValue('use') };

		const result = await summarizeWithRetry(makePlan(), null, undefined, baseRetryOptions({
			checkParams: {
				contextKeepRecentTokens: 2000,
				contextKeepTargetPercent: 50,
				contextMaxContextOverride: 0,
				nCtx: 0
			},
			gate,
			nCtx: 0
		}));

		expect(result?.content).toBe('x'.repeat(6000));
		expect(gate.requestDecision).not.toHaveBeenCalled();
		expect(vi.mocked(ChatService.sendMessage)).toHaveBeenCalledTimes(1);
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
