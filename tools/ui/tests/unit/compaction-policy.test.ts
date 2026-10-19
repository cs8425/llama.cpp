// v4 size accounting (context-enhance/02 §3.4): per-message sizes are REAL
// token counts derived from the server's per-turn timings
// (`deriveRealMessageTokens`: assistant = predicted_n, each segment's real
// total attributed to its last non-assistant; the system head counts 0 —
// folded into the first segment total — and the not-yet-sent tail falls back
// to a bytes/4 estimate). Byte counts (`messageBytes` / `apiMessageBytes`)
// are display material only (inspector sub-column, the tail estimate).
//
// Cut-point selection:
// - `planCompaction` = mode B (threshold-target, upper bound): two-stage,
//   boundary-first, split user-message span as fallback, empty kept allowed;
// - `planCompactionRecentWindow` = mode A (recent-window, default): the pi
//   walk from the last message to ≥ keepRecentTokens, cut at the nearest
//   legal point at/right of the crossing — never an empty kept.
// The cut must never land on a tool result (I4) and the kept region must
// respect I5. Trigger / success checks are mode-specific and shared by both
// modes' stores; the trigger input is the real context usage (the gauge).

import { AttachmentType, ContentPartType, FileTypeAudio, MessageRole, MessageType } from '$lib/enums';
import {
	apiMessageBytes,
	byteLength,
	computeCompactionBudget,
	computeEffectiveWindow,
	computeSummaryMaxTokens,
	deriveRealMessageTokens,
	evaluateCompactionResult,
	estimateCompactionSavings,
	messageBytes,
	messageSize,
	MIN_SUMMARIZE_TOKENS,
	nextCompactionStep,
	planCompaction,
	planCompactionRecentWindow,
	resolveSummarySize,
	shouldTriggerCompaction,
	tailStartOf,
	toCompactionMode
} from '$lib/services/context/compaction-policy';
import { effectiveCompactionPath } from '$lib/services/context/context-builder';
import type { CompactionSettings, RecentWindowOptions } from '$lib/services/context/compaction-policy';
import type { CompactionBudget, CompactionPlan } from '$lib/services/context/types';
import type { ApiChatMessageData } from '$lib/types/api';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import { describe, expect, it, vi } from 'vitest';

// context-builder (effectiveCompactionPath) imports ChatService only at call
// time; mock the module so the unit project does not pull the Svelte stores.
vi.mock('$lib/services/chat.service', () => ({
	ChatService: {
		convertDbMessageToApiChatMessageData: vi.fn(async (m: DatabaseMessage) => ({
			content: m.content,
			role: m.role
		}))
	}
}));

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

/**
 * An assistant message with the per-turn timings the real-token derivation
 * reads: `prompt_n` / `cache_n` / `predicted_n`.
 */
function assistantTimed(
	id: string,
	content: string,
	prompt: number,
	predicted: number,
	cache = 0
): DatabaseMessage {
	return message(id, MessageRole.ASSISTANT, content, {
		timings: { cache_n: cache, predicted_n: predicted, prompt_n: prompt }
	});
}

function budget(keepBudgetTokens: number, overrides: Partial<CompactionBudget> = {}): CompactionBudget {
	return {
		keepBudgetTokens,
		minKeptMessages: 0,
		minKeptUserTurns: 4,
		minSummarizeTokens: 10,
		...overrides
	};
}

// Mode A options: loose I5 floors by default so individual cases can raise
// one floor at a time.
function rw(keepRecentTokens: number, overrides: Partial<RecentWindowOptions> = {}): RecentWindowOptions {
	return {
		keepRecentTokens,
		minKeptMessages: 1,
		minKeptUserTurns: 1,
		minSummarizeTokens: 10,
		...overrides
	};
}

// Byte constants for the display-only byte suites and the tail's bytes/4
// estimate (400-char ASCII content = 400 bytes = 100 tail tokens).
const T100 = 'x'.repeat(400);
const TOOL_CALLS = JSON.stringify([{ function: { name: 'read_file' }, id: 'c1' }]); // 45 bytes

describe('byteLength', () => {
	it('counts ASCII one byte per character', () => {
		expect(byteLength('hello')).toBe(5);
	});

	it('counts CJK three bytes per character', () => {
		expect(byteLength('你好')).toBe(6);
	});

	it('mixes ASCII and CJK', () => {
		expect(byteLength('a你b')).toBe(5);
	});

	it('returns 0 for empty, undefined and null', () => {
		expect(byteLength('')).toBe(0);
		expect(byteLength(undefined)).toBe(0);
		expect(byteLength(null)).toBe(0);
	});
});

describe('messageBytes (display-only byte count)', () => {
	it('counts plain content at UTF-8 byte count', () => {
		expect(messageBytes(message('m', MessageRole.USER, T100))).toBe(400);
		expect(messageBytes(message('m', MessageRole.USER, ''))).toBe(0);
	});

	it('adds toolCalls and reasoning content at byte count', () => {
		const withCalls = message('m', MessageRole.ASSISTANT, T100, {
			reasoningContent: T100,
			toolCalls: TOOL_CALLS
		});

		// 400 + 400 + 45
		expect(messageBytes(withCalls)).toBe(845);
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

		expect(messageBytes(message('m', MessageRole.USER, '', { extra: [image] }))).toBe(1000);
		expect(messageBytes(message('m', MessageRole.USER, '', { extra: [audio] }))).toBe(3000);
		expect(messageBytes(message('m', MessageRole.USER, '', { extra: [video] }))).toBe(3000);
	});

	it('prices text attachments by byte count and PDFs by pages or text', () => {
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

		expect(messageBytes(message('m', MessageRole.USER, '', { extra: [text] }))).toBe(400);
		expect(messageBytes(message('m', MessageRole.USER, '', { extra: [pdfImages] }))).toBe(3000);
		expect(messageBytes(message('m', MessageRole.USER, '', { extra: [pdfText] }))).toBe(400);
	});
});

describe('apiMessageBytes (display-only byte count)', () => {
	it('counts string content at byte count and adds reasoning and tool calls', () => {
		const base: ApiChatMessageData = { content: T100, role: MessageRole.USER };

		expect(apiMessageBytes(base)).toBe(400);

		const withExtras: ApiChatMessageData = {
			content: '',
			reasoning_content: T100,
			role: MessageRole.ASSISTANT,
			tool_calls: [{ function: { arguments: '{}', name: 'read_file' }, id: 'c1', type: 'function' }]
		};

		// 400 (reasoning) + 80 (tool_calls JSON)
		expect(apiMessageBytes(withExtras)).toBe(480);
	});

	it('prices a tool-call-only assistant (content omitted at runtime) as tool_calls bytes only', () => {
		// The converter omits the empty content field for a tool-call-only
		// assistant turn (byte-identical wire shape, N11); the declared type
		// has no undefined, so the cast documents the type/runtime gap.
		const toolCallOnly = {
			role: MessageRole.ASSISTANT,
			tool_calls: [{ function: { arguments: '{}', name: 'read_file' }, id: 'c1', type: 'function' }]
		} as ApiChatMessageData;

		// 80 (tool_calls JSON) — the withExtras vector minus content and reasoning
		expect(apiMessageBytes(toolCallOnly)).toBe(80);
	});

	it('prices content parts: text by bytes, image flat 1000, audio/video flat 3000', () => {
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

		expect(apiMessageBytes(text)).toBe(400);
		expect(apiMessageBytes(image)).toBe(1000);
		expect(apiMessageBytes(audio)).toBe(3000);
		expect(apiMessageBytes(video)).toBe(3000);
	});

	it('combines parts with the same heuristics as the DB-form byte counter', () => {
		const mixed: ApiChatMessageData = {
			content: [
				{ image_url: { url: 'data:image/png;base64,xx' }, type: ContentPartType.IMAGE_URL },
				{ text: T100, type: ContentPartType.TEXT }
			],
			role: MessageRole.USER
		};

		expect(apiMessageBytes(mixed)).toBe(1400);
	});
});

describe('deriveRealMessageTokens', () => {
	it('attributes the first segment (prompt_n + cache_n) to the last non-assistant before the first assistant', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1000, 200, 50)
		];

		const real = deriveRealMessageTokens(path);

		expect(real.get('u1')).toBe(1050);
		expect(real.get('a1')).toBe(200);
		expect(real.has('sys')).toBe(false);
	});

	it('attributes each inter-assistant segment to that segment\'s last non-assistant', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1000, 200),
			message('t1', MessageRole.TOOL, 'tool result'),
			message('u2', MessageRole.USER, 'q2'),
			assistantTimed('a2', 'a2', 2000, 300)
		];

		const real = deriveRealMessageTokens(path);

		// segment 1 = prompt_n[a1]; segment 2 = (2000 − 1000) − 200 = 800,
		// owned by u2 (the segment's last non-assistant — t1 precedes it)
		expect(real.get('u1')).toBe(1000);
		expect(real.get('a1')).toBe(200);
		expect(real.get('u2')).toBe(800);
		expect(real.get('a2')).toBe(300);
		expect(real.has('t1')).toBe(false);
		expect(real.has('sys')).toBe(false);
	});

	it('leaves the system head and the not-yet-sent tail out of the map', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1000, 100),
			message('u2', MessageRole.USER, 'new question (not sent yet)')
		];

		const real = deriveRealMessageTokens(path);

		expect(real.get('u1')).toBe(1000);
		expect(real.get('a1')).toBe(100);
		expect(real.has('u2')).toBe(false); // tail — never tokenized
		expect(real.has('sys')).toBe(false);
	});

	it('returns an empty map when no assistant reports usable timings', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			message('a1', MessageRole.ASSISTANT, 'a1'),
			assistantTimed('a2', 'a2', 1000, 100)
		];

		// a1 lacks timings; a2's first segment still derives (u1 + a1 folded in)
		expect(deriveRealMessageTokens(path).get('u1')).toBe(1000);
		expect(deriveRealMessageTokens(path).get('a2')).toBe(100);
		expect(deriveRealMessageTokens(path).has('a1')).toBe(false);

		expect(
			deriveRealMessageTokens([
				message('u1', MessageRole.USER, 'q1'),
				message('a1', MessageRole.ASSISTANT, 'a1')
			]).size
		).toBe(0);
	});

	it('clamps a negative segment total to 0 (the prompt shrank after an in-loop compaction)', () => {
		const path = [
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 5000, 100),
			message('u2', MessageRole.USER, 'q2'),
			assistantTimed('a2', 'a2', 1000, 50)
		];

		const real = deriveRealMessageTokens(path);

		expect(real.get('u1')).toBe(5000);
		expect(real.get('a1')).toBe(100);
		// (1000 − 5000) − 100 < 0 → 0
		expect(real.get('u2')).toBe(0);
		expect(real.get('a2')).toBe(50);
	});
});

describe('tailStartOf', () => {
	it('returns path.length when the path ends on an assistant (no tail)', () => {
		const path = [
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 100, 10)
		];

		expect(tailStartOf(path)).toBe(2);
	});

	it('returns the index right after the last assistant when a tail follows', () => {
		const path = [
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 100, 10),
			message('u2', MessageRole.USER, 'q2')
		];

		expect(tailStartOf(path)).toBe(2);
	});

	it('returns 0 when the path has no assistant (nothing was ever tokenized)', () => {
		const path = [message('sys', MessageRole.SYSTEM, 'system'), message('u1', MessageRole.USER, 'q1')];

		expect(tailStartOf(path)).toBe(0);
	});
});

describe('messageSize', () => {
	it('prefers the real token count when the map has one', () => {
		const m = message('m', MessageRole.USER, T100);

		expect(messageSize(m, new Map([['m', 123]]), false)).toBe(123);
		// a real value wins over the tail estimate too
		expect(messageSize(m, new Map([['m', 123]]), true)).toBe(123);
	});

	it('falls back to bytes/4 for the not-yet-sent tail', () => {
		const m = message('m', MessageRole.USER, T100); // 400 bytes

		expect(messageSize(m, new Map(), true)).toBe(100);
	});

	it('counts 0 for a message with no real value that is not the tail (system head / folded segment)', () => {
		const sys = message('sys', MessageRole.SYSTEM, T100);
		const mid = message('m', MessageRole.USER, T100);

		expect(messageSize(sys, new Map(), false)).toBe(0);
		expect(messageSize(mid, new Map(), false)).toBe(0);
	});

	it('prices attachments into the tail estimate (image = 1000 → 250)', () => {
		const image: DatabaseMessageExtra = {
			base64Url: 'data:image/jpeg;base64,xx',
			name: 'a.jpg',
			type: AttachmentType.IMAGE
		};
		const m = message('m', MessageRole.USER, '', { extra: [image] });

		expect(messageSize(m, new Map(), true)).toBe(250);
	});
});

describe('computeSummaryMaxTokens', () => {
	it('derives the cap as a percentage of n_ctx (70% of 128k ≈ 91750, of 256k ≈ 183500)', () => {
		expect(computeSummaryMaxTokens(131072, 70)).toBe(91750);
		expect(computeSummaryMaxTokens(262144, 70)).toBe(183500);
	});

	it('floors the product and never returns 0', () => {
		expect(computeSummaryMaxTokens(1000, 33)).toBe(330);
		expect(computeSummaryMaxTokens(5, 10)).toBe(1);
	});
});

describe('computeCompactionBudget', () => {
	const settings: CompactionSettings = {
		contextCompactionThreshold: 80,
		contextKeepMinMessages: 0,
		contextKeepMinUserTurns: 4,
		contextKeepTargetPercent: 50
	};

	it('derives the keep budget from the threshold − keepTarget difference (v3)', () => {
		// floor(20000 × (80 − 50)%) = 6000
		const budget = computeCompactionBudget(20000, settings);

		expect(budget.keepBudgetTokens).toBe(6000);
	});

	it('uses the configured keep target percent', () => {
		// floor(20000 × (80 − 30)%) = 10000
		const budget = computeCompactionBudget(20000, { ...settings, contextKeepTargetPercent: 30 });

		expect(budget.keepBudgetTokens).toBe(10000);
	});

	it('collapses to 0 when threshold ≤ keepTarget (misconfiguration, never compacts)', () => {
		expect(computeCompactionBudget(20000, { ...settings, contextCompactionThreshold: 40 }).keepBudgetTokens).toBe(0);
		expect(computeCompactionBudget(20000, { ...settings, contextCompactionThreshold: 50 }).keepBudgetTokens).toBe(
			0
		);
	});

	it('floors the product', () => {
		// floor(8193 × 30%) = 2457.9 → 2457
		expect(computeCompactionBudget(8193, settings).keepBudgetTokens).toBe(2457);
	});

	it('passes the min limits through and pins minSummarizeTokens', () => {
		const budget = computeCompactionBudget(8192, {
			...settings,
			contextKeepMinMessages: 3,
			contextKeepMinUserTurns: 5
		});

		expect(budget.minKeptMessages).toBe(3);
		expect(budget.minKeptUserTurns).toBe(5);
		expect(budget.minSummarizeTokens).toBe(MIN_SUMMARIZE_TOKENS);
	});
});

describe('planCompaction (mode B, real tokens)', () => {
	it('returns null when the whole path fits the keep budget (nothing to summarize)', () => {
		// the earliest legal cut (u1) leaves an empty summarize region,
		// which is below minSummarizeTokens
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'hi'),
			assistantTimed('a1', 'hello', 100, 10)
		];

		expect(planCompaction(path, budget(1000, { minSummarizeTokens: 10 }))).toBeNull();
	});

	it('cuts at a user-message boundary, keeps within budget, and honors minKeptUserTurns', () => {
		// sizes: u1 1600, a1 1600, u2..a5 400 each → suffix(u2) = 3200 =
		// budget (exact fit), 4 user messages in the kept region
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1600, 1600),
			message('u2', MessageRole.USER, 'q2'),
			assistantTimed('a2', 'a2', 3600, 400),
			message('u3', MessageRole.USER, 'q3'),
			assistantTimed('a3', 'a3', 4400, 400),
			message('u4', MessageRole.USER, 'q4'),
			assistantTimed('a4', 'a4', 5200, 400),
			message('u5', MessageRole.USER, 'q5'),
			assistantTimed('a5', 'a5', 6000, 400)
		];

		const plan = planCompaction(path, budget(3200));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(false);
		expect(plan?.firstKeptMessageId).toBe('u2');
		// kept = u2..a5 → 3200 tokens ≤ budget (exact fit), 4 user messages
		expect(plan?.kept.map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
		expect(plan?.keptTokens).toBe(3200);
		// summarize = u1..a1, system prompt excluded (I1); the head rides along
		// separately for the prefix-stable summary payload (N4)
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1']);
		expect(plan?.systemHead?.id).toBe('sys');
		// the system head counts 0 (folded into the first segment)
		expect(plan?.estimatedTokensBefore).toBe(6400);
		expect(plan?.estimatedTokensAfter).toBe(3200);
	});

	it('refuses a boundary cut that would leave fewer than minKeptUserTurns user messages', () => {
		// sizes: u1 1000, a1 1000, u2 400, a2 400 → suffix(u2) = 800 ≤ 1000
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1000, 1000),
			message('u2', MessageRole.USER, 'q2'),
			assistantTimed('a2', 'a2', 2400, 400)
		];

		// only u2 can satisfy the budget (800 ≤ 1000) → 1 user message < 4
		expect(planCompaction(path, budget(1000, { minKeptUserTurns: 4 }))).toBeNull();
	});

	it('splits a single oversized span at an assistant message, keeping the recent tool exchange', () => {
		// sizes: u1 2000, a1 500, a2 1200, a3 100 (tool results 0) →
		// suffix(a2) = 1300 > 1000, suffix(a3) = 100 ≤ 1000
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 2000, 500),
			message('t1', MessageRole.TOOL, 'tool result 1', { toolCallId: 'c1' }),
			assistantTimed('a2', 'a2', 3700, 1200),
			message('t2', MessageRole.TOOL, 'tool result 2', { toolCallId: 'c2' }),
			assistantTimed('a3', 'a3', 5000, 100),
			message('t3', MessageRole.TOOL, 'tool result 3', { toolCallId: 'c3' })
		];

		const plan = planCompaction(path, budget(1000, { minKeptMessages: 2 }));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(true);
		// cut at a3: kept starts with assistant (tool_calls) + its tool result
		expect(plan?.firstKeptMessageId).toBe('a3');
		expect(plan?.kept.map((m) => m.id)).toEqual(['a3', 't3']);
		expect(plan?.kept[0].role).toBe(MessageRole.ASSISTANT);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1', 't1', 'a2', 't2']);
	});

	it('never cuts on a tool result, even in a pure assistant/tool alternation', () => {
		// sizes: a1 400, a2 400, a3 400 (tool results 0) → suffix(a1) = 1200
		// > 1000, suffix(a2) = 800 ≤ 1000
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			assistantTimed('a1', 'a1', 400, 400),
			message('t1', MessageRole.TOOL, 'tool result 1', { toolCallId: 'c1' }),
			assistantTimed('a2', 'a2', 1200, 400),
			message('t2', MessageRole.TOOL, 'tool result 2', { toolCallId: 'c2' }),
			assistantTimed('a3', 'a3', 2000, 400),
			message('t3', MessageRole.TOOL, 'tool result 3', { toolCallId: 'c3' })
		];

		const plan = planCompaction(path, budget(1000));

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
		// sizes: u1 1600 (the first segment), a1 100 → suffix(u1) = 1700 >
		// 1000, suffix(a1) = 100 ≤ 1000
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'x'.repeat(4000)),
			assistantTimed('a1', 'a1', 1600, 100),
			message('t1', MessageRole.TOOL, 'tool result', { toolCallId: 'c1' })
		];

		const plan = planCompaction(path, budget(1000));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(true);
		expect(plan?.firstKeptMessageId).toBe('a1');
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1']);
	});

	it('falls back to an empty kept region (all messages summarized) when nothing fits the budget', () => {
		// sizes: u1 1600, a1 100 → suffix(a1) = 100 > 50, only the cut after
		// the last message (0) fits
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'x'.repeat(4000)),
			assistantTimed('a1', 'a1', 1600, 100)
		];

		const plan = planCompaction(path, budget(50));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(true);
		// cut after the last message: kept is empty, the boundary id is absent
		expect(plan?.cutIndex).toBe(3);
		expect(plan?.firstKeptMessageId).toBeUndefined();
		expect(plan?.kept).toEqual([]);
		expect(plan?.keptTokens).toBe(0);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1']);
	});

	it('cuts after the last message (empty kept) when only the tail is oversized', () => {
		// sizes: u1 100, a1 100, a2 4000 (t1/t2 0) → suffix(a1) = 4100,
		// suffix(a2) = 4000 — both > 1000; only the cut after t2 fits
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 100, 100),
			message('t1', MessageRole.TOOL, 'tool result 1', { toolCallId: 'c1' }),
			assistantTimed('a2', 'a2', 4200, 4000),
			message('t2', MessageRole.TOOL, 'x'.repeat(4000), { toolCallId: 'c2' })
		];

		const plan = planCompaction(path, budget(1000));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(true);
		// the last ass+tool alone exceeds the budget → the cut lands after it
		expect(plan?.cutIndex).toBe(path.length);
		expect(plan?.firstKeptMessageId).toBeUndefined();
		expect(plan?.kept).toEqual([]);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1', 't1', 'a2', 't2']);
	});

	it('still honors a raised minKeptMessages floor (the old behavior, opt-in)', () => {
		// sizes: u1 1000, a1 100 → suffix(a1) = 100 ≤ 1000
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1000, 100),
			message('t1', MessageRole.TOOL, 'tool result', { toolCallId: 'c1' })
		];

		// the budget fits the last ass+tool (100 ≤ 1000) → split at a1
		const plan = planCompaction(path, budget(1000, { minKeptMessages: 2 }));

		expect(plan?.isSplitTurn).toBe(true);
		expect(plan?.firstKeptMessageId).toBe('a1');
		expect(plan?.kept.map((m) => m.id)).toEqual(['a1', 't1']);

		// a floor of 3 leaves no legal split cut → null
		expect(planCompaction(path, budget(1000, { minKeptMessages: 3 }))).toBeNull();
	});

	it('returns null when the summarize region is below minSummarizeTokens', () => {
		// no assistant reports timings → every size is 0 (nothing tokenized);
		// the cut lands at u1, whose summarize region is empty (0 < 500)
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'hi'),
			message('a1', MessageRole.ASSISTANT, 'a1'),
			message('u2', MessageRole.USER, 'q2'),
			message('a2', MessageRole.ASSISTANT, 'a2'),
			message('u3', MessageRole.USER, 'q3'),
			message('a3', MessageRole.ASSISTANT, 'a3'),
			message('u4', MessageRole.USER, 'q4'),
			message('a4', MessageRole.ASSISTANT, 'a4')
		];

		expect(planCompaction(path, budget(3000, { minSummarizeTokens: 500 }))).toBeNull();
	});

	it('handles a path without a system prompt', () => {
		// sizes: u1 1000, a1 1000, u2 1000, a2 1000, u3 100, a3 100, u4 100,
		// a4 100 → suffix(u3) = 300 ≤ 1600, suffix(u2) = 2300 > 1600
		const path = [
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1000, 1000),
			message('u2', MessageRole.USER, 'q2'),
			assistantTimed('a2', 'a2', 3000, 1000),
			message('u3', MessageRole.USER, 'q3'),
			assistantTimed('a3', 'a3', 5000, 100),
			message('u4', MessageRole.USER, 'q4'),
			assistantTimed('a4', 'a4', 5200, 100)
		];

		const plan = planCompaction(path, budget(1600, { minKeptUserTurns: 2 }));

		expect(plan).not.toBeNull();
		expect(plan?.firstKeptMessageId).toBe('u3');
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
		expect(plan?.systemHead).toBeNull();
	});
});

describe('toCompactionMode', () => {
	it('accepts the two known modes verbatim', () => {
		expect(toCompactionMode('recent-window')).toBe('recent-window');
		expect(toCompactionMode('threshold-target')).toBe('threshold-target');
	});

	it('falls back to recent-window (A) for unknown / corrupted values', () => {
		expect(toCompactionMode(undefined)).toBe('recent-window');
		expect(toCompactionMode('')).toBe('recent-window');
		expect(toCompactionMode('bogus')).toBe('recent-window');
	});
});

describe('computeEffectiveWindow', () => {
	it('returns n_ctx when the override is off (0)', () => {
		expect(computeEffectiveWindow(131072, 0)).toBe(131072);
	});

	it('caps at n_ctx when the override is larger', () => {
		expect(computeEffectiveWindow(131072, 200000)).toBe(131072);
	});

	it('uses the override when it is smaller', () => {
		expect(computeEffectiveWindow(131072, 32768)).toBe(32768);
	});

	it('returns n_ctx when the override equals it', () => {
		expect(computeEffectiveWindow(131072, 131072)).toBe(131072);
	});
});

describe('shouldTriggerCompaction (trigger = real context usage, v4)', () => {
	const base = {
		contextCompactionThreshold: 80,
		contextMaxContextOverride: 0,
		contextKeepRecentTokens: 2000,
		nCtx: 10000
	};

	it('A: triggers strictly above window − keep', () => {
		// window 10000 − keep 2000 = 8000
		expect(shouldTriggerCompaction('recent-window', { ...base, lastPrompt: 8000 })).toBe(false);
		expect(shouldTriggerCompaction('recent-window', { ...base, lastPrompt: 8001 })).toBe(true);
	});

	it('A: never triggers when window − keep ≤ 0 (misconfiguration)', () => {
		expect(
			shouldTriggerCompaction('recent-window', {
				...base,
				contextKeepRecentTokens: 10000,
				lastPrompt: 99999,
				nCtx: 10000
			})
		).toBe(false);
		expect(
			shouldTriggerCompaction('recent-window', {
				...base,
				contextKeepRecentTokens: 20000,
				lastPrompt: 99999,
				nCtx: 10000
			})
		).toBe(false);
	});

	it('A: the override shrinks the window and moves the trigger point', () => {
		// window = min(100000, 5000) = 5000 − keep 2000 = 3000
		const override = { ...base, contextMaxContextOverride: 5000, nCtx: 100000 };

		expect(shouldTriggerCompaction('recent-window', { ...override, lastPrompt: 3000 })).toBe(false);
		expect(shouldTriggerCompaction('recent-window', { ...override, lastPrompt: 3001 })).toBe(true);
		// without the override the headroom would be 98000 → no trigger
		expect(
			shouldTriggerCompaction('recent-window', {
				...base,
				contextMaxContextOverride: 0,
				lastPrompt: 3001,
				nCtx: 100000
			})
		).toBe(false);
	});

	it('A: a zero reading (no real data) never triggers', () => {
		expect(shouldTriggerCompaction('recent-window', { ...base, lastPrompt: 0 })).toBe(false);
	});

	it('B: triggers strictly above n_ctx × threshold%', () => {
		// 10000 × 80% = 8000
		expect(shouldTriggerCompaction('threshold-target', { ...base, lastPrompt: 8000 })).toBe(false);
		expect(shouldTriggerCompaction('threshold-target', { ...base, lastPrompt: 8001 })).toBe(true);
	});

	it('B: ignores the window parameters (mode-specific formula)', () => {
		// A would trigger at 5000 > min(100000, 100) − 5 = 95, B does not
		expect(
			shouldTriggerCompaction('threshold-target', {
				...base,
				contextMaxContextOverride: 100,
				contextKeepRecentTokens: 5,
				lastPrompt: 5000,
				nCtx: 10000
			})
		).toBe(false);
	});
});

describe('planCompactionRecentWindow (mode A, real tokens)', () => {
	it('stops the walk at the keep lower bound and cuts at a user crossing', () => {
		// sizes: u1 1600, a1 400, u2 400, a2 400, u3 600, a3 400 → walk:
		// a3 400 < 1000, u3 1000 ≥ 1000 → crossing on u3
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1600, 400),
			message('u2', MessageRole.USER, 'q2'),
			assistantTimed('a2', 'a2', 2400, 400),
			message('u3', MessageRole.USER, 'q3'),
			assistantTimed('a3', 'a3', 3400, 400)
		];

		const plan = planCompactionRecentWindow(path, rw(1000));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(false);
		expect(plan?.cutIndex).toBe(5);
		expect(plan?.firstKeptMessageId).toBe('u3');
		// kept is exactly the keep lower bound (600 + 400 = 1000 tokens)
		expect(plan?.kept.map((m) => m.id)).toEqual(['u3', 'a3']);
		expect(plan?.keptTokens).toBe(1000);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
		expect(plan?.systemHead?.id).toBe('sys');
		// the system head counts 0 (folded into the first segment)
		expect(plan?.estimatedTokensAfter).toBe(1000);
		expect(plan?.estimatedTokensBefore).toBe(3800);
	});

	it('cuts at the rightmost legal cut when the crossing lands on the trailing tool', () => {
		// sizes: u1 1000, a1 100, a2 100, t2 = tail estimate (16000 bytes →
		// 4000) → walk: t2 4000 ≥ 1000 → crossing on the trailing tool
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1000, 100),
			message('t1', MessageRole.TOOL, 'tool result 1', { toolCallId: 'c1' }),
			assistantTimed('a2', 'a2', 1200, 100),
			message('t2', MessageRole.TOOL, 'x'.repeat(16000), { toolCallId: 'c2' })
		];

		const plan = planCompactionRecentWindow(path, rw(1000));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(true);
		// the giant tool result keeps its whole preceding exchange (a2 + t2)
		expect(plan?.firstKeptMessageId).toBe('a2');
		expect(plan?.cutIndex).toBe(4);
		expect(plan?.kept.map((m) => m.id)).toEqual(['a2', 't2']);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1', 't1']);
	});

	it('moves the cut right to the next legal point when the crossing lands on a mid-path tool', () => {
		// sizes: u1 1000, a1 100, t1 1200 (the segment's real total), a2 100,
		// t2 = tail (small) → walk: t2 ~0, a2 100, t1 1300 ≥ 1000 → crossing
		// on the mid-path tool
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1000, 100),
			message('t1', MessageRole.TOOL, 'x'.repeat(4000), { toolCallId: 'c1' }),
			assistantTimed('a2', 'a2', 2300, 100),
			message('t2', MessageRole.TOOL, 'ok', { toolCallId: 'c2' })
		];

		const plan = planCompactionRecentWindow(path, rw(1000));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(true);
		// the tool result the walk crossed is summarized; the following
		// exchange (a2 + t2) stays verbatim
		expect(plan?.firstKeptMessageId).toBe('a2');
		expect(plan?.kept.map((m) => m.id)).toEqual(['a2', 't2']);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1', 't1']);
	});

	it('returns null when the walk never reaches keep (whole path < keep)', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 100, 100)
		];

		expect(planCompactionRecentWindow(path, rw(2000))).toBeNull();
	});

	it('returns null for an empty path', () => {
		expect(planCompactionRecentWindow([], rw(1000))).toBeNull();
	});

	it('never produces an empty kept (the cut always lands on a kept message)', () => {
		// sizes: u0 1000, a0 100, u1 2000, a1 100, t1 = tail (0) → walk:
		// t1 0, a1 100, u1 2100 ≥ 1000 → crossing on u1 (user)
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u0', MessageRole.USER, 'q0'),
			assistantTimed('a0', 'a0', 1000, 100),
			message('u1', MessageRole.USER, 'x'.repeat(4000)),
			assistantTimed('a1', 'a1', 3100, 100),
			message('t1', MessageRole.TOOL, 'tool result', { toolCallId: 'c1' })
		];

		const plan = planCompactionRecentWindow(path, rw(1000));

		expect(plan).not.toBeNull();
		expect(plan?.kept.length).toBeGreaterThanOrEqual(1);
		expect(plan?.firstKeptMessageId).toBe('u1');
		expect(plan?.isSplitTurn).toBe(false);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u0', 'a0']);
	});

	it('honors the minKeptMessages floor', () => {
		// sizes: u0 1000, a0 100, u1 100, a1 100 → walk (keep 250): a1 100,
		// u1 200, a0 300 ≥ 250 → crossing on a0 → kept = [a0, u1, a1]
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u0', MessageRole.USER, 'q0'),
			assistantTimed('a0', 'a0', 1000, 100),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1200, 100)
		];

		expect(planCompactionRecentWindow(path, rw(250, { minKeptMessages: 4 }))).toBeNull();

		const plan = planCompactionRecentWindow(path, rw(250, { minKeptMessages: 3 }));

		expect(plan).not.toBeNull();
		expect(plan?.cutIndex).toBe(2);
		expect(plan?.firstKeptMessageId).toBe('a0');
	});

	it('honors minKeptUserTurns for a user cut', () => {
		// sizes: u0 1600, a0 100, u1 800, a1 400 → walk: a1 400, u1 1200 ≥
		// 1000 → crossing on u1 (user) → kept = [u1, a1]
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u0', MessageRole.USER, 'q0'),
			assistantTimed('a0', 'a0', 1600, 100),
			message('u1', MessageRole.USER, 'x'.repeat(2000)),
			assistantTimed('a1', 'a1', 2500, 400)
		];

		// kept = [u1, a1] → 1 user message
		expect(planCompactionRecentWindow(path, rw(1000, { minKeptUserTurns: 2 }))).toBeNull();

		const plan = planCompactionRecentWindow(path, rw(1000, { minKeptUserTurns: 1 }));

		expect(plan).not.toBeNull();
		expect(plan?.firstKeptMessageId).toBe('u1');
	});

	it('returns null when the summarize region is below minSummarizeTokens', () => {
		// sizes: u0 200, a0 200, u1 800, a1 100 → walk: a1 100, u1 900,
		// a0 1100 ≥ 1000 → crossing on a0 → summarize region = [u0] = 200
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u0', MessageRole.USER, 'x'.repeat(200)),
			assistantTimed('a0', 'a0', 200, 200),
			message('u1', MessageRole.USER, 'x'.repeat(800)),
			assistantTimed('a1', 'a1', 1200, 100)
		];

		expect(planCompactionRecentWindow(path, rw(1000, { minSummarizeTokens: 201 }))).toBeNull();
		expect(planCompactionRecentWindow(path, rw(1000, { minSummarizeTokens: 200 }))).not.toBeNull();
	});

	it('handles a path without a system prompt', () => {
		// sizes: u0 1000, a0 100, u1 800, a1 100 → walk: a1 100, u1 900,
		// a0 1000 ≥ 1000 → crossing on a0 → kept = [a0, u1, a1]
		const path = [
			message('u0', MessageRole.USER, 'q0'),
			assistantTimed('a0', 'a0', 1000, 100),
			message('u1', MessageRole.USER, 'x'.repeat(2000)),
			assistantTimed('a1', 'a1', 1900, 100)
		];

		const plan = planCompactionRecentWindow(path, rw(1000));

		expect(plan).not.toBeNull();
		expect(plan?.firstKeptMessageId).toBe('a0');
		expect(plan?.systemHead).toBeNull();
		expect(plan?.estimatedTokensAfter).toBe(1000); // no head
		expect(plan?.estimatedTokensBefore).toBe(2000);
	});
});

describe('evaluateCompactionResult (real tokens, v4)', () => {
	function makePlan(keptTokens: number, head: string | null): CompactionPlan {
		const kept = message('k', MessageRole.USER, 'recent question');

		return {
			cutIndex: 1,
			estimatedTokensAfter: keptTokens,
			estimatedTokensBefore: 0,
			firstKeptMessageId: kept.id,
			isSplitTurn: false,
			kept: [kept],
			keptTokens,
			realMessageTokens: new Map<string, number>(),
			systemHead: head === null ? null : message('sys', MessageRole.SYSTEM, head),
			toSummarize: [message('u', MessageRole.USER, 'old')]
		};
	}

	const aParams = {
		contextKeepRecentTokens: 2000,
		contextKeepTargetPercent: 50,
		contextMaxContextOverride: 0,
		nCtx: 10000
	};

	it('A: summary + kept ≤ window − keep (kept enters the check; the head is folded in)', () => {
		const plan = makePlan(1000, 'h'.repeat(400));

		// target = 10000 − 2000 = 8000; 7000 + 1000 = 8000 → ok (≤)
		expect(evaluateCompactionResult(plan, 7000, 'recent-window', aParams)).toEqual({
			ok: true,
			postSize: 8000,
			target: 8000
		});
		expect(evaluateCompactionResult(plan, 7001, 'recent-window', aParams)).toEqual({
			ok: false,
			postSize: 8001,
			target: 8000
		});
	});

	it('A: the system head is NOT counted on top (no independent real value)', () => {
		// with and without a system head the check is identical
		const withHead = makePlan(1000, 'h'.repeat(400));
		const withoutHead = makePlan(1000, null);

		expect(evaluateCompactionResult(withHead, 7000, 'recent-window', aParams)).toEqual(
			evaluateCompactionResult(withoutHead, 7000, 'recent-window', aParams)
		);
	});

	it('A: the override shrinks the window and the target', () => {
		const plan = makePlan(1000, 'h'.repeat(400));

		// window = min(10000, 5000) = 5000 − 2000 = 3000
		const params = { ...aParams, contextMaxContextOverride: 5000 };

		expect(evaluateCompactionResult(plan, 2000, 'recent-window', params)).toEqual({
			ok: true,
			postSize: 3000,
			target: 3000
		});
		expect(evaluateCompactionResult(plan, 2001, 'recent-window', params)).toEqual({
			ok: false,
			postSize: 3001,
			target: 3000
		});
	});

	it('B: summary ≤ keepTarget% × n_ctx (kept does NOT enter the check)', () => {
		const plan = makePlan(1000, 'h'.repeat(400));
		const bParams = { ...aParams };

		// target = floor(10000 × 50%) = 5000
		expect(evaluateCompactionResult(plan, 5000, 'threshold-target', bParams)).toEqual({
			ok: true,
			postSize: 5000,
			target: 5000
		});
		expect(evaluateCompactionResult(plan, 5001, 'threshold-target', bParams)).toEqual({
			ok: false,
			postSize: 5001,
			target: 5000
		});
	});

	it('B: a large kept region does not affect the result', () => {
		const plan = makePlan(9000, 'h'.repeat(400));

		expect(evaluateCompactionResult(plan, 5000, 'threshold-target', aParams)).toEqual({
			ok: true,
			postSize: 5000,
			target: 5000
		});
	});

	it('B: ignores the window parameters (mode-specific formula)', () => {
		const plan = makePlan(1000, 'h'.repeat(400));

		expect(
			evaluateCompactionResult(plan, 5000, 'threshold-target', { ...aParams, contextMaxContextOverride: 100 })
		).toEqual({
			ok: true,
			postSize: 5000,
			target: 5000
		});
	});
});

describe('resolveSummarySize', () => {
	it('prefers the API completion tokens when reported', () => {
		expect(resolveSummarySize(123, 'x'.repeat(999))).toBe(123);
	});

	it('falls back to the UTF-8 byte length when the server did not report', () => {
		expect(resolveSummarySize(null, '你好')).toBe(6);
	});

	it('treats a reported 0 as a real value', () => {
		expect(resolveSummarySize(0, 'x')).toBe(0);
	});
});

describe('nextCompactionStep', () => {
	it('gates immediately after a single attempt (maxAttempts = 1)', () => {
		expect(nextCompactionStep(1, 1)).toBe('gate');
	});

	it('retries while attempts remain (maxAttempts = 3)', () => {
		expect(nextCompactionStep(1, 3)).toBe('retry');
		expect(nextCompactionStep(2, 3)).toBe('retry');
		expect(nextCompactionStep(3, 3)).toBe('gate');
	});

	it('retries forever when maxAttempts ≤ 0 (the gate is the only stop)', () => {
		expect(nextCompactionStep(1, 0)).toBe('retry');
		expect(nextCompactionStep(99, 0)).toBe('retry');
		expect(nextCompactionStep(1, -3)).toBe('retry');
	});
});

describe('estimateCompactionSavings (real tokens, v4)', () => {
	function compaction(
		id: string,
		firstKeptMessageId: string,
		estimatedTokensBefore: number,
		extra?: Partial<DatabaseMessage>
	): DatabaseMessage {
		return message(id, MessageRole.USER, 'y'.repeat(800), {
			compactionMeta: { estimatedTokensBefore, firstKeptMessageId, summarizedCount: 2 },
			type: MessageType.COMPACTION,
			...extra
		});
	}

	it('subtracts the current payload (path minus dropped region) from the pre-compaction total', () => {
		// real: u1 1500, a1 300; the entry (tail, no real value) = 800 bytes /
		// 4 = 200, tail u2 = 400 bytes / 4 = 100; the system head counts 0
		// → total 2100, dropped 1800, payload 300 → 2000 − 300 = 1700
		const cmp = compaction('cmp', 'u2', 2000);
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1500, 300),
			cmp,
			message('u2', MessageRole.USER, T100)
		];

		expect(estimateCompactionSavings(path, cmp)).toBe(1700);
	});

	it('keeps an older compaction entry inside the dropped region out of the payload', () => {
		// real: the first segment (1500) is owned by oldCmp (the last
		// non-assistant before a1); a1 300; the entry (tail, no real value) =
		// 800 bytes / 4 = 200, tail u2 100 → total 2100, dropped = oldCmp + a1
		// = 1800 (newCmp excluded from dropped — it is sent), payload 300
		// → 2000 − 300 = 1700
		const oldCmp = message('oldCmp', MessageRole.USER, 'z'.repeat(400), {
			compactionMeta: { estimatedTokensBefore: 300, firstKeptMessageId: 'a1', summarizedCount: 1 },
			type: MessageType.COMPACTION
		});
		const newCmp = compaction('newCmp', 'u2', 2000);
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			oldCmp,
			assistantTimed('a1', 'a1', 1500, 300),
			newCmp,
			message('u2', MessageRole.USER, T100)
		];

		expect(estimateCompactionSavings(path, newCmp)).toBe(1700);
	});

	it('returns 0 when the boundary no longer exists on the path (fail-open full send)', () => {
		const cmp = compaction('cmp', 'missing-id', 450);
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			cmp
		];

		expect(estimateCompactionSavings(path, cmp)).toBe(0);
	});

	it('returns 0 when the boundary points at the system prompt (corrupt data)', () => {
		const cmp = compaction('cmp', 'sys', 450);
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			cmp
		];

		expect(estimateCompactionSavings(path, cmp)).toBe(0);
	});

	it('returns 0 when the entry has no compactionMeta', () => {
		const broken = message('cmp', MessageRole.USER, 'y'.repeat(800), { type: MessageType.COMPACTION });
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			broken
		];

		expect(estimateCompactionSavings(path, broken)).toBe(0);
	});

	it('counts the whole post-head path as dropped for an empty-kept entry (absent boundary id)', () => {
		// real: u1 1500, a1 300; the entry is the tail → 800 bytes / 4 = 200
		// → dropped 1800, payload 200 → 2200 − 200 = 2000
		const cmp = message('cmp', MessageRole.USER, 'y'.repeat(800), {
			compactionMeta: { estimatedTokensBefore: 2200, summarizedCount: 2 },
			type: MessageType.COMPACTION
		});
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1500, 300),
			cmp
		];

		expect(estimateCompactionSavings(path, cmp)).toBe(2000);
	});

	it('clamps to 0 when the pre-compaction total is below the current payload', () => {
		const cmp = compaction('cmp', 'u2', 100);
		const path = [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u1', MessageRole.USER, 'q1'),
			assistantTimed('a1', 'a1', 1500, 300),
			cmp,
			message('u2', MessageRole.USER, T100)
		];

		expect(estimateCompactionSavings(path, cmp)).toBe(0);
	});
});

// Second compaction (N8, 06-status §3.27): the plan must run on the
// EFFECTIVE path (effectiveCompactionPath → planner) so the summarize region
// never re-includes the messages an older entry already dropped.
describe('second compaction (plan on the effective path, N8)', () => {
	function compactionEntry(
		id: string,
		content: string,
		firstKeptMessageId: string | undefined
	): DatabaseMessage {
		return message(id, MessageRole.USER, content, {
			compactionMeta: { firstKeptMessageId, summarizedCount: 2 },
			type: MessageType.COMPACTION
		});
	}

	// Raw path: the first compaction (cmp1) already summarized u0/a0 — the
	// effective path is [sys, cmp1, u1..a2]. Real tokens on the effective
	// path: u1 = first segment (a1.prompt 5000; cmp1 counts 0), a1 1000,
	// u2 = 6200 − 5000 − 1000 = 200, a2 400 → total 6600 (the raw path would
	// total 13200).
	function rawPath(): DatabaseMessage[] {
		return [
			message('sys', MessageRole.SYSTEM, 'system'),
			message('u0', MessageRole.USER, 'x'.repeat(40000)),
			assistantTimed('a0', 'a0', 10000, 1600),
			compactionEntry('cmp1', 'OLD SUMMARY', 'u1'),
			message('u1', MessageRole.USER, 'x'.repeat(4000)),
			assistantTimed('a1', 'a1', 5000, 1000),
			message('u2', MessageRole.USER, 'q2'),
			assistantTimed('a2', 'a2', 6200, 400)
		];
	}

	it('mode B: the summarize region is the effective prefix (old summary + new messages, no dropped raw history)', () => {
		const plan = planCompaction(effectiveCompactionPath(rawPath()), budget(600, { minKeptUserTurns: 1 }));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(false);
		// toSummarize = [cmp1, u1, a1] on the effective path — u0/a0 (already
		// covered by the old summary) are NOT re-summarized; u1 IS (it is in
		// the kept region of cmp1, so it is in the effective path)
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['cmp1', 'u1', 'a1']);
		// the boundary comes from the post-cmp region
		expect(plan?.firstKeptMessageId).toBe('u2');
		expect(plan?.kept.map((m) => m.id)).toEqual(['u2', 'a2']);
		// token accounting prices the effective scale (6600), not the raw one
		expect(plan?.keptTokens).toBe(600);
		expect(plan?.estimatedTokensBefore).toBe(6600);
		expect(plan?.estimatedTokensAfter).toBe(600);
		expect(plan?.systemHead?.id).toBe('sys');
	});

	it('mode A: the walk runs on the effective path (same region, effective scale)', () => {
		const plan = planCompactionRecentWindow(effectiveCompactionPath(rawPath()), rw(600));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(false);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['cmp1', 'u1', 'a1']);
		expect(plan?.firstKeptMessageId).toBe('u2');
		expect(plan?.kept.map((m) => m.id)).toEqual(['u2', 'a2']);
		expect(plan?.keptTokens).toBe(600);
		expect(plan?.estimatedTokensBefore).toBe(6600);
		expect(plan?.estimatedTokensAfter).toBe(600);
	});
});
