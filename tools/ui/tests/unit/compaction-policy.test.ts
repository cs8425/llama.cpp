// Compaction policy: size accounting and cut-point selection.
//
// Size accounting is v3 / dual-mode (context-enhance/02 §3.4): per-message
// costs are UTF-8 **byte counts** (image = 1000, audio/video = 3000 flat) —
// there is no per-message API token value, and no derived proportions.
//
// Cut-point selection:
// - `planCompaction` = mode B (threshold-target, upper bound): two-stage,
//   boundary-first, split user-message span as fallback, empty kept allowed;
// - `planCompactionRecentWindow` = mode A (recent-window, default): the pi
//   walk from the last message to ≥ keepRecentTokens, cut at the nearest
//   legal point at/right of the crossing — never an empty kept.
// The cut must never land on a tool result (I4) and the kept region must
// respect I5. Trigger / success checks are mode-specific and shared by both
// modes' stores.

import { AttachmentType, ContentPartType, FileTypeAudio, MessageRole, MessageType } from '$lib/enums';
import {
	byteLength,
	computeCompactionBudget,
	computeEffectiveWindow,
	computeSummaryMaxTokens,
	evaluateCompactionResult,
	estimateApiMessageTokens,
	estimateCompactionSavings,
	estimateTokens,
	MIN_SUMMARIZE_TOKENS,
	nextCompactionStep,
	planCompaction,
	planCompactionRecentWindow,
	resolveSummarySize,
	shouldTriggerCompaction,
	toCompactionMode
} from '$lib/services/context/compaction-policy';
import type { CompactionSettings, RecentWindowOptions } from '$lib/services/context/compaction-policy';
import type { CompactionBudget, CompactionPlan } from '$lib/services/context/types';
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

// Byte semantics: 400-char ASCII content = 400 bytes (was "100 tokens" at
// chars/4), 1600 chars = 1600 bytes.
const T100 = 'x'.repeat(400);
const T400 = 'x'.repeat(1600);
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

describe('estimateTokens', () => {
	it('estimates plain content at UTF-8 byte count', () => {
		expect(estimateTokens(message('m', MessageRole.USER, T100))).toBe(400);
		expect(estimateTokens(message('m', MessageRole.USER, ''))).toBe(0);
	});

	it('adds toolCalls and reasoning content at byte count', () => {
		const withCalls = message('m', MessageRole.ASSISTANT, T100, {
			reasoningContent: T100,
			toolCalls: TOOL_CALLS
		});

		// 400 + 400 + 45
		expect(estimateTokens(withCalls)).toBe(845);
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

		expect(estimateTokens(message('m', MessageRole.USER, '', { extra: [text] }))).toBe(400);
		expect(estimateTokens(message('m', MessageRole.USER, '', { extra: [pdfImages] }))).toBe(3000);
		expect(estimateTokens(message('m', MessageRole.USER, '', { extra: [pdfText] }))).toBe(400);
	});
});

describe('estimateApiMessageTokens', () => {
	it('estimates string content at byte count and adds reasoning and tool calls', () => {
		const base: ApiChatMessageData = { content: T100, role: MessageRole.USER };

		expect(estimateApiMessageTokens(base)).toBe(400);

		const withExtras: ApiChatMessageData = {
			content: '',
			reasoning_content: T100,
			role: MessageRole.ASSISTANT,
			tool_calls: [{ function: { arguments: '{}', name: 'read_file' }, id: 'c1', type: 'function' }]
		};

		// 400 (reasoning) + 80 (tool_calls JSON)
		expect(estimateApiMessageTokens(withExtras)).toBe(480);
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

		expect(estimateApiMessageTokens(text)).toBe(400);
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

		expect(estimateApiMessageTokens(mixed)).toBe(1400);
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
			message('sys', MessageRole.SYSTEM, T100), // 400
			message('u1', MessageRole.USER, T400), // 1600
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

		const plan = planCompaction(path, budget(5600));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(false);
		expect(plan?.firstKeptMessageId).toBe('u2');
		// kept = u2..a5 → 5600 bytes ≤ budget (exact fit), 4 user messages
		expect(plan?.kept.map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
		expect(plan?.kept.reduce((s, m) => s + estimateTokens(m), 0)).toBeLessThanOrEqual(5600);
		// summarize = u1..a1, system prompt excluded (I1); the head rides along
		// separately for the prefix-stable summary payload (N4)
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1']);
		expect(plan?.systemHead?.id).toBe('sys');
		expect(plan?.estimatedTokensBefore).toBe(9200);
	});

	it('refuses a boundary cut that would leave fewer than minKeptUserTurns user messages', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100),
			message('u2', MessageRole.USER, T100),
			message('a2', MessageRole.ASSISTANT, T100)
		];

		// only u2 can satisfy the budget (800 ≤ 1000) → 1 user message < 4
		expect(planCompaction(path, budget(1000, { minKeptUserTurns: 4 }))).toBeNull();
	});

	it('splits a single oversized span at an assistant message, keeping the recent tool exchange', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100, { toolCalls: TOOL_CALLS }),
			message('t1', MessageRole.TOOL, T100, { toolCallId: 'c1' }),
			message('a2', MessageRole.ASSISTANT, T100, { toolCalls: TOOL_CALLS }),
			message('t2', MessageRole.TOOL, T100, { toolCallId: 'c2' }),
			message('a3', MessageRole.ASSISTANT, T100, { toolCalls: TOOL_CALLS }),
			message('t3', MessageRole.TOOL, T100, { toolCallId: 'c3' })
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
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('a1', MessageRole.ASSISTANT, T100),
			message('t1', MessageRole.TOOL, T100, { toolCallId: 'c1' }),
			message('a2', MessageRole.ASSISTANT, T100),
			message('t2', MessageRole.TOOL, T100, { toolCallId: 'c2' }),
			message('a3', MessageRole.ASSISTANT, T100),
			message('t3', MessageRole.TOOL, T100, { toolCallId: 'c3' })
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
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T400), // 1600 bytes
			message('a1', MessageRole.ASSISTANT, T100),
			message('t1', MessageRole.TOOL, T100, { toolCallId: 'c1' })
		];

		const plan = planCompaction(path, budget(1000));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(true);
		expect(plan?.firstKeptMessageId).toBe('a1');
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1']);
	});

	it('falls back to an empty kept region (all messages summarized) when nothing fits the budget', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T400), // 1600 bytes
			message('a1', MessageRole.ASSISTANT, T100)
		];

		const plan = planCompaction(path, budget(50));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(true);
		// cut after the last message: kept is empty, the boundary id is absent
		expect(plan?.cutIndex).toBe(3);
		expect(plan?.firstKeptMessageId).toBeUndefined();
		expect(plan?.kept).toEqual([]);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1']);
	});

	it('cuts after the last message (empty kept) when only the tail is oversized', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100, { toolCalls: TOOL_CALLS }),
			message('t1', MessageRole.TOOL, T100, { toolCallId: 'c1' }),
			message('a2', MessageRole.ASSISTANT, 'x'.repeat(4000)), // 4000 bytes
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
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100, { toolCalls: TOOL_CALLS }),
			message('t1', MessageRole.TOOL, T100, { toolCallId: 'c1' })
		];

		// the budget fits the last ass+tool (846 ≤ 1000) → split at a1
		const plan = planCompaction(path, budget(1000, { minKeptMessages: 2 }));

		expect(plan?.isSplitTurn).toBe(true);
		expect(plan?.firstKeptMessageId).toBe('a1');
		expect(plan?.kept.map((m) => m.id)).toEqual(['a1', 't1']);

		// a floor of 3 leaves no legal split cut → null
		expect(planCompaction(path, budget(1000, { minKeptMessages: 3 }))).toBeNull();
	});

	it('returns null when the summarize region is below minSummarizeTokens', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, 'hi'), // 2 bytes
			message('a1', MessageRole.ASSISTANT, T100),
			message('u2', MessageRole.USER, T100),
			message('a2', MessageRole.ASSISTANT, T100),
			message('u3', MessageRole.USER, T100),
			message('a3', MessageRole.ASSISTANT, T100),
			message('u4', MessageRole.USER, T100),
			message('a4', MessageRole.ASSISTANT, T100)
		];

		// cut at u1 → summarize region is empty (0 < 500)
		expect(planCompaction(path, budget(3000, { minSummarizeTokens: 500 }))).toBeNull();
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

describe('shouldTriggerCompaction', () => {
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

describe('planCompactionRecentWindow', () => {
	it('stops the walk at the keep lower bound and cuts at a user crossing', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100), // 400
			message('u1', MessageRole.USER, T400), // 1600
			message('a1', MessageRole.ASSISTANT, T100),
			message('u2', MessageRole.USER, T100),
			message('a2', MessageRole.ASSISTANT, T100),
			message('u3', MessageRole.USER, 'x'.repeat(600)), // walk: 400 + 600 = 1000 ≥ keep
			message('a3', MessageRole.ASSISTANT, T100)
		];

		const plan = planCompactionRecentWindow(path, rw(1000));

		expect(plan).not.toBeNull();
		expect(plan?.isSplitTurn).toBe(false);
		expect(plan?.cutIndex).toBe(5);
		expect(plan?.firstKeptMessageId).toBe('u3');
		// kept is exactly the keep lower bound (600 + 400 = 1000 bytes)
		expect(plan?.kept.map((m) => m.id)).toEqual(['u3', 'a3']);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
		expect(plan?.systemHead?.id).toBe('sys');
		expect(plan?.estimatedTokensAfter).toBe(1400); // head 400 + kept 1000
		expect(plan?.estimatedTokensBefore).toBe(4200);
	});

	it('cuts at the rightmost legal cut when the crossing lands on the trailing tool', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100, { toolCalls: TOOL_CALLS }),
			message('t1', MessageRole.TOOL, T100, { toolCallId: 'c1' }),
			message('a2', MessageRole.ASSISTANT, T100, { toolCalls: TOOL_CALLS }),
			message('t2', MessageRole.TOOL, 'x'.repeat(16000)) // walk stops inside this tool
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
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100, { toolCalls: TOOL_CALLS }),
			message('t1', MessageRole.TOOL, 'x'.repeat(1200)), // walk: 400 + 484 + 1200 ≥ keep
			message('a2', MessageRole.ASSISTANT, T100, { toolCalls: TOOL_CALLS }),
			message('t2', MessageRole.TOOL, T100, { toolCallId: 'c2' })
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
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100)
		];

		expect(planCompactionRecentWindow(path, rw(2000))).toBeNull();
	});

	it('returns null for an empty path', () => {
		expect(planCompactionRecentWindow([], rw(1000))).toBeNull();
	});

	it('never produces an empty kept (the cut always lands on a kept message)', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u0', MessageRole.USER, T100),
			message('a0', MessageRole.ASSISTANT, T100),
			message('u1', MessageRole.USER, 'x'.repeat(4000)), // walk stops here (user)
			message('a1', MessageRole.ASSISTANT, T100),
			message('t1', MessageRole.TOOL, T100, { toolCallId: 'c1' })
		];

		const plan = planCompactionRecentWindow(path, rw(1000));

		expect(plan).not.toBeNull();
		expect(plan?.kept.length).toBeGreaterThanOrEqual(1);
		expect(plan?.firstKeptMessageId).toBe('u1');
		expect(plan?.isSplitTurn).toBe(false);
		expect(plan?.toSummarize.map((m) => m.id)).toEqual(['u0', 'a0']);
	});

	it('honors the minKeptMessages floor', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u0', MessageRole.USER, T100),
			message('a0', MessageRole.ASSISTANT, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100)
		];

		// walk: 400 + 400 + 1200 ≥ 1000 → crossing on a0 → kept = [a0, u1, a1]
		expect(planCompactionRecentWindow(path, rw(1000, { minKeptMessages: 4 }))).toBeNull();

		const plan = planCompactionRecentWindow(path, rw(1000, { minKeptMessages: 3 }));

		expect(plan).not.toBeNull();
		expect(plan?.cutIndex).toBe(2);
		expect(plan?.firstKeptMessageId).toBe('a0');
	});

	it('honors minKeptUserTurns for a user cut', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u0', MessageRole.USER, T400),
			message('a0', MessageRole.ASSISTANT, T100),
			message('u1', MessageRole.USER, 'x'.repeat(800)), // walk: 400 + 800 ≥ 1000
			message('a1', MessageRole.ASSISTANT, T100)
		];

		// kept = [u1, a1] → 1 user message
		expect(planCompactionRecentWindow(path, rw(1000, { minKeptUserTurns: 2 }))).toBeNull();

		const plan = planCompactionRecentWindow(path, rw(1000, { minKeptUserTurns: 1 }));

		expect(plan).not.toBeNull();
		expect(plan?.firstKeptMessageId).toBe('u1');
	});

	it('returns null when the summarize region is below minSummarizeTokens', () => {
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u0', MessageRole.USER, 'x'.repeat(200)),
			message('a0', MessageRole.ASSISTANT, 'x'.repeat(200)),
			message('u1', MessageRole.USER, 'x'.repeat(800)), // walk: 400 + 800 ≥ 1000
			message('a1', MessageRole.ASSISTANT, T100)
		];

		// summarize region = u0 + a0 = 400 bytes
		expect(planCompactionRecentWindow(path, rw(1000, { minSummarizeTokens: 401 }))).toBeNull();
		expect(planCompactionRecentWindow(path, rw(1000, { minSummarizeTokens: 400 }))).not.toBeNull();
	});

	it('handles a path without a system prompt', () => {
		const path = [
			message('u0', MessageRole.USER, T100),
			message('a0', MessageRole.ASSISTANT, T100),
			message('u1', MessageRole.USER, 'x'.repeat(800)), // walk: 400 + 800 ≥ 1000
			message('a1', MessageRole.ASSISTANT, T100)
		];

		const plan = planCompactionRecentWindow(path, rw(1000));

		expect(plan).not.toBeNull();
		expect(plan?.firstKeptMessageId).toBe('u1');
		expect(plan?.systemHead).toBeNull();
		expect(plan?.estimatedTokensAfter).toBe(1200); // no head
		expect(plan?.estimatedTokensBefore).toBe(2000);
	});
});

describe('evaluateCompactionResult', () => {
	function makePlan(keptContent: string, head: string | null): CompactionPlan {
		const kept = message('k', MessageRole.USER, keptContent);

		return {
			cutIndex: 1,
			estimatedTokensAfter: 0,
			estimatedTokensBefore: 0,
			firstKeptMessageId: kept.id,
			isSplitTurn: false,
			kept: [kept],
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

	it('A: head + summary + kept ≤ window − keep (kept enters the check)', () => {
		const plan = makePlan('x'.repeat(1000), 'h'.repeat(400));

		// target = 10000 − 2000 = 8000; 400 + 6600 + 1000 = 8000 → ok (≤)
		expect(evaluateCompactionResult(plan, 6600, 'recent-window', aParams)).toEqual({
			ok: true,
			postSize: 8000,
			target: 8000
		});
		expect(evaluateCompactionResult(plan, 6601, 'recent-window', aParams)).toEqual({
			ok: false,
			postSize: 8001,
			target: 8000
		});
	});

	it('A: the override shrinks the window and the target', () => {
		const plan = makePlan('x'.repeat(1000), 'h'.repeat(400));

		// window = min(10000, 5000) = 5000 − 2000 = 3000
		const params = { ...aParams, contextMaxContextOverride: 5000 };

		expect(evaluateCompactionResult(plan, 1600, 'recent-window', params)).toEqual({
			ok: true,
			postSize: 3000,
			target: 3000
		});
		expect(evaluateCompactionResult(plan, 1601, 'recent-window', params)).toEqual({
			ok: false,
			postSize: 3001,
			target: 3000
		});
	});

	it('A: without a system head the head bytes are 0', () => {
		const plan = makePlan('x'.repeat(1000), null);

		expect(evaluateCompactionResult(plan, 7000, 'recent-window', aParams)).toEqual({
			ok: true,
			postSize: 8000,
			target: 8000
		});
	});

	it('B: head + summary ≤ keepTarget% × n_ctx (kept does NOT enter the check)', () => {
		const plan = makePlan('x'.repeat(1000), 'h'.repeat(400));
		const bParams = { ...aParams };

		// target = floor(10000 × 50%) = 5000; 400 + 4600 = 5000 → ok (≤)
		expect(evaluateCompactionResult(plan, 4600, 'threshold-target', bParams)).toEqual({
			ok: true,
			postSize: 5000,
			target: 5000
		});
		expect(evaluateCompactionResult(plan, 4601, 'threshold-target', bParams)).toEqual({
			ok: false,
			postSize: 5001,
			target: 5000
		});
	});

	it('B: a large kept region does not affect the result', () => {
		const plan = makePlan('x'.repeat(9000), 'h'.repeat(400));

		expect(evaluateCompactionResult(plan, 4600, 'threshold-target', aParams)).toEqual({
			ok: true,
			postSize: 5000,
			target: 5000
		});
	});

	it('B: ignores the window parameters (mode-specific formula)', () => {
		const plan = makePlan('x'.repeat(1000), 'h'.repeat(400));

		expect(evaluateCompactionResult(plan, 4600, 'threshold-target', { ...aParams, contextMaxContextOverride: 100 })).toEqual({
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

describe('estimateCompactionSavings', () => {
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

	it('subtracts the current payload (path minus dropped region) from the pre-compaction estimate', () => {
		// sys 400, u1 400, a1 400, cmp 800, u2 400 → total 2400, dropped 800,
		// payload 1600 → 2000 − 1600 = 400
		const cmp = compaction('cmp', 'u2', 2000);
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100),
			cmp,
			message('u2', MessageRole.USER, T100)
		];

		expect(estimateCompactionSavings(path, cmp)).toBe(400);
	});

	it('keeps an older compaction entry inside the dropped region out of the payload', () => {
		// sys 400, u1 400, oldCmp 400, a1 400, newCmp 800, u2 400 → total 2800,
		// dropped = u1 + oldCmp + a1 = 1200, payload = sys + newCmp + u2 = 1600
		// → 1700 − 1600 = 100
		const oldCmp = message('oldCmp', MessageRole.USER, 'z'.repeat(400), {
			compactionMeta: { estimatedTokensBefore: 300, firstKeptMessageId: 'a1', summarizedCount: 1 },
			type: MessageType.COMPACTION
		});
		const newCmp = compaction('newCmp', 'u2', 1700);
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			oldCmp,
			message('a1', MessageRole.ASSISTANT, T100),
			newCmp,
			message('u2', MessageRole.USER, T100)
		];

		expect(estimateCompactionSavings(path, newCmp)).toBe(100);
	});

	it('returns 0 when the boundary no longer exists on the path (fail-open full send)', () => {
		const cmp = compaction('cmp', 'missing-id', 450);
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			cmp
		];

		expect(estimateCompactionSavings(path, cmp)).toBe(0);
	});

	it('returns 0 when the boundary points at the system prompt (corrupt data)', () => {
		const cmp = compaction('cmp', 'sys', 450);
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			cmp
		];

		expect(estimateCompactionSavings(path, cmp)).toBe(0);
	});

	it('returns 0 when the entry has no compactionMeta', () => {
		const broken = message('cmp', MessageRole.USER, 'y'.repeat(800), { type: MessageType.COMPACTION });
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			broken
		];

		expect(estimateCompactionSavings(path, broken)).toBe(0);
	});

	it('counts the whole post-head path as dropped for an empty-kept entry (absent boundary id)', () => {
		const cmp = message('cmp', MessageRole.USER, 'y'.repeat(800), {
			compactionMeta: { estimatedTokensBefore: 2000, summarizedCount: 2 },
			type: MessageType.COMPACTION
		});
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100),
			cmp
		];

		// dropped = u1 + a1 = 800 (the entry is the summary, not dropped);
		// payload = sys + cmp = 1200 → 2000 − 1200 = 800
		expect(estimateCompactionSavings(path, cmp)).toBe(800);
	});

	it('clamps to 0 when the pre-compaction estimate is below the current payload', () => {
		const cmp = compaction('cmp', 'u2', 100);
		const path = [
			message('sys', MessageRole.SYSTEM, T100),
			message('u1', MessageRole.USER, T100),
			message('a1', MessageRole.ASSISTANT, T100),
			cmp,
			message('u2', MessageRole.USER, T100)
		];

		expect(estimateCompactionSavings(path, cmp)).toBe(0);
	});
});
