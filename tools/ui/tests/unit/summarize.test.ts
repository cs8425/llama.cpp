// buildSummaryTranscript: the plain-text transcript fed to the summary call.
// Attachments must become placeholders (never base64), tool calls reduce to
// their names, and empty messages drop out entirely.
//
// summarizeMessages returns a SummaryResult { content, tokens }: the trimmed
// text plus the server's actual completion tokens (timings.predicted_n) when
// reported, null otherwise. The prefix-stable payload is
// `buildLlmContext(planPath).messages` + the instruction (N11.2 / A4): the
// builder's output IS the last live payload, so the compact request's prefix
// is byte-identical to it (maximum KV-cache affinity). summarizeWithRetry is
// the shared over-target mechanism for both compaction modes: summarize →
// mode-specific success check → retry × maxAttempts → user gate
// (use / retry / skip).

import { AttachmentType, MessageRole, MessageType } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import { buildLlmContext } from '$lib/services/context/context-builder';
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
import type { ApiChatMessageData } from '$lib/types/api';
import type { DatabaseMessage } from '$lib/types/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/services/chat.service', () => ({
	ChatService: {
		// Faithful stand-in for the DB→API conversion (the builder reuses it
		// per message, context-builder.test.ts pattern). The payload tests
		// assert against buildLlmContext's output, not this mapping.
		convertDbMessageToApiChatMessageData: vi.fn(async (m: DatabaseMessage) => ({
			content: m.content,
			role: m.role,
			...(m.reasoningContent ? { reasoning_content: m.reasoningContent } : {})
		})),
		sendMessage: vi.fn()
	}
}));

let seq = 0;

function message(role: MessageRole, content: string, extra?: Partial<DatabaseMessage>): DatabaseMessage {
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

/**
 * A plan plus the effective path it was planned on (N11.2 / A4: the summary
 * payload is built from the path, not from plan.toSummarize alone).
 */
function makePlan(): { plan: CompactionPlan; planPath: DatabaseMessage[] } {
	const summarized = message(MessageRole.USER, 'old question');
	const kept = message(MessageRole.USER, 'recent question');
	const plan: CompactionPlan = {
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

	return { plan, planPath: [...plan.toSummarize, ...plan.kept] };
}

/** Plan with a system head and a multi-role region (user / assistant+tool_calls / tool). */
function makePlanWithHead(): { plan: CompactionPlan; planPath: DatabaseMessage[] } {
	const head = message(MessageRole.SYSTEM, 'be terse');
	const toSummarize = [
		message(MessageRole.USER, 'old question'),
		message(MessageRole.ASSISTANT, '', {
			toolCalls: JSON.stringify([{ function: { name: 'read_file' }, id: 'c1' }])
		}),
		message(MessageRole.TOOL, 'file content here', { toolCallId: 'c1' })
	];
	const kept = message(MessageRole.USER, 'recent question');
	const plan: CompactionPlan = {
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

	return { plan, planPath: [head, ...toSummarize, ...plan.kept] };
}

function lastSentMessages(): ApiChatMessageData[] {
	return (vi.mocked(ChatService.sendMessage).mock.calls.at(-1)?.[0] ?? []) as ApiChatMessageData[];
}

/** The prefix-stable payload: the builder's output for planPath + the instruction. */
async function expectedPayload(
	planPath: DatabaseMessage[],
	instruction: string,
	excludeReasoning = false
): Promise<ApiChatMessageData[]> {
	return [
		...(await buildLlmContext(planPath, { excludeReasoning })).messages,
		{ content: instruction, role: MessageRole.USER }
	];
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
		const { plan, planPath } = makePlan();

		controller.abort();
		vi.mocked(ChatService.sendMessage).mockResolvedValue(undefined);

		await expect(summarizeMessages(planPath, plan, null, controller.signal)).rejects.toMatchObject({
			name: 'AbortError'
		});
	});

	it('still throws for an empty response without a signal', async () => {
		const { plan, planPath } = makePlan();

		vi.mocked(ChatService.sendMessage).mockResolvedValue(undefined);

		await expect(summarizeMessages(planPath, plan, null)).rejects.toThrow('empty response');
	});
});

// --- summarizeMessages payload (N11.2 / A4: builder output + instruction) -----

describe('summarizeMessages (prefix-stable payload, N11.2 / A4)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('no compaction entry: payload = buildLlmContext(planPath).messages + instruction', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');
		const { plan, planPath } = makePlanWithHead();

		const result = await summarizeMessages(planPath, plan, null);

		// the return value is the SummaryResult: trimmed content, no timings
		// reported by this mock → null tokens
		expect(result).toEqual({ content: 'the summary', tokens: null });

		// The payload goes through the same choke point as the main send path —
		// the prefix is byte-identical to the conversation payload's prefix.
		expect(lastSentMessages()).toEqual(await expectedPayload(planPath, DEFAULT_SUMMARY_PROMPT));
		expect(vi.mocked(ChatService.sendMessage).mock.calls.at(-1)?.[1]).toMatchObject({
			excludeReasoningFromContext: false,
			stream: false
		});
	});

	it('an in-effect entry: the old summary rides as a plain user turn on the effective path (N8 / A4)', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the rolled summary');
		// The second compaction's plan runs on the effective path: the payload
		// is [system, old summary (plain user turn), kept…] — the exact last
		// live payload — never the raw history the old entry dropped.
		const head = message(MessageRole.SYSTEM, 'be terse');
		const oldSummary = message(MessageRole.USER, 'OLD SUMMARY', { type: MessageType.COMPACTION });
		const fresh = message(MessageRole.USER, 'new question');
		const kept = message(MessageRole.USER, 'recent question');
		const plan = { ...makePlanWithHead().plan, toSummarize: [oldSummary, fresh] };
		const planPath = [head, oldSummary, fresh, kept];

		await summarizeMessages(planPath, plan, null);

		const sent = lastSentMessages();

		expect(sent).toEqual(await expectedPayload(planPath, DEFAULT_SUMMARY_PROMPT));
		expect(sent.map(({ content, role }) => ({ content, role }))).toEqual([
			{ content: 'be terse', role: MessageRole.SYSTEM },
			{ content: 'OLD SUMMARY', role: MessageRole.USER },
			{ content: 'new question', role: MessageRole.USER },
			{ content: 'recent question', role: MessageRole.USER },
			{ content: DEFAULT_SUMMARY_PROMPT, role: MessageRole.USER }
		]);
	});

	it('split-turn variant only swaps the trailing instruction (prefix identical)', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');
		// One shared plan (and path) for both calls: the point of the test is
		// that only the trailing instruction differs, so the prefix must come
		// from the same message objects.
		const { plan, planPath } = makePlanWithHead();

		await summarizeMessages(planPath, plan, null);
		const normal = lastSentMessages();

		await summarizeMessages(planPath, { ...plan, isSplitTurn: true }, null);
		const split = lastSentMessages();

		expect(split.slice(0, -1)).toEqual(normal.slice(0, -1));
		expect(split[split.length - 1]).toEqual({ content: SPLIT_TURN_SUMMARY_PROMPT, role: MessageRole.USER });
	});

	it('a custom prompt replaces the trailing instruction (trimmed)', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');
		const { plan, planPath } = makePlanWithHead();

		await summarizeMessages(planPath, plan, null, undefined, { prompt: '  my custom prompt  ' });

		expect(lastSentMessages()).toEqual(await expectedPayload(planPath, 'my custom prompt'));
	});

	it('omits the head when the path has no system prompt', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');
		// no system message in the path at all (plan.systemHead is null)
		const { plan, planPath } = makePlan();

		await summarizeMessages(planPath, plan, null);

		const sent = lastSentMessages();

		expect(sent).toHaveLength(planPath.length + 1);
		expect(sent[0].role).toBe(MessageRole.USER);
	});

	it('strips reasoning_content from the prefix when excludeReasoning is set (D2)', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');
		const head = message(MessageRole.SYSTEM, 'be terse');
		const withReasoning = message(MessageRole.ASSISTANT, 'answer', { reasoningContent: 'thinking…' });
		const kept = message(MessageRole.USER, 'recent question');
		const plan = { ...makePlanWithHead().plan, toSummarize: [withReasoning] };
		const planPath = [head, withReasoning, kept];

		await summarizeMessages(planPath, plan, null, undefined, { excludeReasoning: true });

		const sent = lastSentMessages();

		expect(sent).toEqual(await expectedPayload(planPath, DEFAULT_SUMMARY_PROMPT, true));
		expect(sent[1]).toEqual({ content: 'answer', role: MessageRole.ASSISTANT, sourceId: withReasoning.id });
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
		const { plan, planPath } = makePlan();

		const result = await summarizeMessages(planPath, plan, null);

		expect(result).toEqual({ content: 'padded summary', tokens: null });
	});

	it('captures the actual completion tokens from the response timings', async () => {
		vi.mocked(ChatService.sendMessage).mockImplementation(
			async (_messages: unknown, options?: SettingsChatServiceOptions) => {
				options?.onComplete?.('the summary', undefined, { predicted_n: 123 });
				return 'the summary';
			}
		);
		const { plan, planPath } = makePlan();

		const result = await summarizeMessages(planPath, plan, null);

		expect(result).toEqual({ content: 'the summary', tokens: 123 });
	});

	it('reports null tokens when the timings lack predicted_n', async () => {
		vi.mocked(ChatService.sendMessage).mockImplementation(
			async (_messages: unknown, options?: SettingsChatServiceOptions) => {
				options?.onComplete?.('the summary', undefined, { prompt_n: 42 });
				return 'the summary';
			}
		);
		const { plan, planPath } = makePlan();

		const result = await summarizeMessages(planPath, plan, null);

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
function makeBigKeptPlan(): { plan: CompactionPlan; planPath: DatabaseMessage[] } {
	const head = message(MessageRole.SYSTEM, 'h'.repeat(400));
	const kept = message(MessageRole.USER, 'x'.repeat(10000));
	const plan: CompactionPlan = {
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

	return { plan, planPath: [head, ...plan.toSummarize, ...plan.kept] };
}

describe('summarizeWithRetry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('passes a within-target summary on the first attempt', async () => {
		mockSummary('short summary');
		const { plan, planPath } = makePlan();

		const result = await summarizeWithRetry(planPath, plan, null, undefined, baseRetryOptions());

		expect(result).toEqual({ content: 'short summary', tokens: null });
		expect(vi.mocked(ChatService.sendMessage)).toHaveBeenCalledTimes(1);
	});

	it('retries up to maxAttempts and accepts the result when there is no gate (fail-open)', async () => {
		mockSummary('x'.repeat(6000)); // 6000 > 5000 (B: keepTarget 50% of 10000)
		const { plan, planPath } = makePlan();

		const result = await summarizeWithRetry(planPath, plan, null, undefined, baseRetryOptions({ maxAttempts: 3 }));

		expect(result?.content).toBe('x'.repeat(6000));
		expect(vi.mocked(ChatService.sendMessage)).toHaveBeenCalledTimes(3);
	});

	it('accepts the over-target summary when the gate says use', async () => {
		mockSummary('x'.repeat(6000));
		const gate: CompactionSummaryGate = { requestDecision: vi.fn().mockResolvedValue('use') };
		const { plan, planPath } = makePlan();

		const result = await summarizeWithRetry(
			planPath,
			plan,
			null,
			undefined,
			baseRetryOptions({ gate, maxAttempts: 1 })
		);

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
		const { plan, planPath } = makePlan();

		const result = await summarizeWithRetry(
			planPath,
			plan,
			null,
			undefined,
			baseRetryOptions({ gate, maxAttempts: 1 })
		);

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
		const { plan, planPath } = makePlan();

		const result = await summarizeWithRetry(
			planPath,
			plan,
			null,
			undefined,
			baseRetryOptions({ gate, maxAttempts: 1 })
		);

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
		const { plan, planPath } = makePlan();

		const result = await summarizeWithRetry(
			planPath,
			plan,
			null,
			undefined,
			baseRetryOptions({ gate, maxAttempts: 0 })
		);

		expect(result?.content).toBe('fits');
		expect(vi.mocked(ChatService.sendMessage)).toHaveBeenCalledTimes(3);
		expect(gate.requestDecision).not.toHaveBeenCalled();
	});

	it('prices the kept region into the check in mode A (summary + kept ≤ window − keep)', async () => {
		mockSummary('s'); // 1 byte
		const gate: CompactionSummaryGate = { requestDecision: vi.fn().mockResolvedValue('use') };
		const { plan, planPath } = makeBigKeptPlan();

		// A: 1 (summary) + 10000 (plan.keptTokens) = 10001 > 10000 − 2000 =
		// 8000 → over target. The system head counts 0 (v4). The same plan
		// would be within target in mode B (1 ≤ 5000) — this pins the
		// mode-A formula.
		const result = await summarizeWithRetry(
			planPath,
			plan,
			null,
			undefined,
			baseRetryOptions({ compactionMode: 'recent-window', gate, maxAttempts: 1 })
		);

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
		const { plan, planPath } = makePlan();

		const result = await summarizeWithRetry(
			planPath,
			plan,
			null,
			undefined,
			baseRetryOptions({
				checkParams: {
					contextKeepRecentTokens: 2000,
					contextKeepTargetPercent: 50,
					contextMaxContextOverride: 0,
					nCtx: 0
				},
				gate,
				nCtx: 0
			})
		);

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

	it('keeps the v1 shape [system (instruction), user (flat transcript)] — transcript covers toSummarize + kept (A4)', async () => {
		vi.mocked(ChatService.sendMessage).mockResolvedValue('the summary');
		const { plan, planPath } = makePlanWithHead();

		await summarizeMessages(planPath, plan, null, undefined, { mode: 'transcript' });

		expect(ChatService.convertDbMessageToApiChatMessageData).not.toHaveBeenCalled();
		expect(lastSentMessages()).toEqual([
			{ content: DEFAULT_SUMMARY_PROMPT, role: MessageRole.SYSTEM },
			{ content: buildSummaryTranscript([...plan.toSummarize, ...plan.kept]), role: MessageRole.USER }
		]);
	});
});
