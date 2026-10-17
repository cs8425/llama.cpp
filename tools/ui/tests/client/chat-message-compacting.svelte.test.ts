// Pins N7 (compaction in progress: input queue + in-chat indicator row, 04-ui §4.2 /
// 06-status §3.26): the indicator row (spinner + "Compacting context…" + Stop) shows at
// the end of the message list only for the conversation that owns the in-flight summary,
// and yields to the new cmp row and to the over-target decision card. Stop dispatches to
// stopGeneration while an agentic flow runs, otherwise to stopCompaction. While the
// active conversation compacts, sendMessage queues input as pending (no API call); other
// conversations send normally. The compaction finalizer auto-sends the queued message on
// every exit path (settled / aborted), and the indicator row renders above the pending row.
//
// Run: npx vitest --project=client --run tests/client/chat-message-compacting.svelte.test.ts

import ChatMessagesPerfWrapper from './components/ChatMessagesPerfWrapper.svelte';
import { MessageRole, MessageType } from '$lib/enums';
import { SUMMARY_CONTENT_PREFIX } from '$lib/services/context';
import { agenticStore } from '$lib/stores/agentic/index.svelte';
import type { CompactionDecisionRequest } from '$lib/stores/agentic/gates.svelte';
import { contextStatsStore } from '$lib/stores/chat/context-stats.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { modelsStore } from '$lib/stores/models/index.svelte';
import type { DatabaseConversation, DatabaseMessage } from '$lib/types';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

// --- fixture ------------------------------------------------------------------

const CONV_ID = 'n7-conv';

let seq = 0;

function makeMessage(overrides: Partial<DatabaseMessage>): DatabaseMessage {
	return {
		children: [],
		content: '',
		convId: CONV_ID,
		id: `m${seq++}`,
		parent: null,
		role: MessageRole.USER,
		timestamp: 1760314440000,
		type: MessageType.TEXT,
		...overrides
	} as DatabaseMessage;
}

function buildFixture(): void {
	const system = makeMessage({ content: 'You are helpful.', role: MessageRole.SYSTEM, type: MessageType.SYSTEM });
	const user = makeMessage({ content: 'help me fix the bug' });
	const assistant = makeMessage({ content: 'on it', role: MessageRole.ASSISTANT });

	conversationsStore.activeMessages = [system, user, assistant];
}

function setActiveConversation(id: string): void {
	conversationsStore.activeConversation = {
		currNode: '',
		id,
		lastModified: 0,
		name: 'N7 conversation'
	} as unknown as DatabaseConversation;
}

// --- helpers ------------------------------------------------------------------

async function waitFor<T extends Node>(find: () => T | null, timeoutMs = 5000): Promise<T> {
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const el = find();

		if (el) return el;

		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	throw new Error('Timed out waiting for element');
}

function indicatorRow(): HTMLElement | null {
	return [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((row) =>
		row.textContent?.includes('Compacting context…')
	) ?? null;
}

function pendingRow(): HTMLElement | null {
	return document.querySelector<HTMLElement>('[aria-label="Pending user message"]');
}

afterEach(() => {
	vi.restoreAllMocks();
	conversationsStore.activeMessages = [];
	conversationsStore.activeConversation = null;
	contextStatsStore.setCompacting(null);
	chatStore.clearPendingMessage(CONV_ID);
	chatStore.cleanupStreaming(CONV_ID);
	agenticStore.resolveCompactionDecision(CONV_ID, 'skip');
});

// --- indicator row display conditions (04-ui §4.2) -----------------------------

describe('ChatMessageCompacting indicator row', () => {
	it('shows while the active conversation compacts (spinner + Stop)', async () => {
		buildFixture();
		setActiveConversation(CONV_ID);
		contextStatsStore.setCompacting(CONV_ID);

		const { unmount } = render(ChatMessagesPerfWrapper);
		await tick();

		const row = await waitFor(indicatorRow);
		expect(row.querySelector('.animate-spin')).not.toBeNull();
		expect(row.textContent).toContain('Compacting context…');
		const stopButton = [...row.querySelectorAll<HTMLButtonElement>('button')].find(
			(b) => b.textContent?.trim() === 'Stop'
		);

		expect(stopButton).not.toBeNull();

		unmount();
	});

	it('hides while a DIFFERENT conversation compacts', async () => {
		buildFixture();
		setActiveConversation(CONV_ID);
		contextStatsStore.setCompacting('other-conv');

		const { unmount } = render(ChatMessagesPerfWrapper);
		await tick();

		expect(indicatorRow()).toBeNull();

		unmount();
	});

	it('hides when no compaction is in flight', async () => {
		buildFixture();
		setActiveConversation(CONV_ID);

		const { unmount } = render(ChatMessagesPerfWrapper);
		await tick();

		expect(indicatorRow()).toBeNull();

		unmount();
	});

	it('yields to the cmp row when the tail is a compaction entry', async () => {
		buildFixture();
		const cmp = makeMessage({
			compactionMeta: { estimatedTokensBefore: 1840, firstKeptMessageId: '', summarizedCount: 2 },
			content: `${SUMMARY_CONTENT_PREFIX} The user asked to fix a bug.`,
			role: MessageRole.USER,
			type: MessageType.COMPACTION
		});
		conversationsStore.activeMessages.push(cmp);
		setActiveConversation(CONV_ID);
		contextStatsStore.setCompacting(CONV_ID);

		const { unmount } = render(ChatMessagesPerfWrapper);
		await tick();

		// the real cmp row took over the tail — the indicator row must not double-render
		expect(indicatorRow()).toBeNull();
		expect(document.body.textContent?.includes('Context compacted')).toBe(true);

		unmount();
	});

	it('yields to the over-target card while it is shown', async () => {
		buildFixture();
		setActiveConversation(CONV_ID);
		contextStatsStore.setCompacting(CONV_ID);
		const request: CompactionDecisionRequest = {
			attempts: 3,
			convId: CONV_ID,
			mode: 'recent-window',
			postSize: 12345,
			target: 8000
		};
		agenticStore.requestCompactionDecision(request);

		const { unmount } = render(ChatMessagesPerfWrapper);
		await tick();

		expect(document.body.textContent).toContain('Context compaction exceeded the window target');
		expect(indicatorRow()).toBeNull();

		unmount();
	});

	it('renders above the pending row', async () => {
		buildFixture();
		setActiveConversation(CONV_ID);
		contextStatsStore.setCompacting(CONV_ID);
		chatStore.injectPendingMessage(CONV_ID, 'queued while compacting');

		const { unmount } = render(ChatMessagesPerfWrapper);
		await tick();

		const indicator = await waitFor(indicatorRow);
		const pending = await waitFor(pendingRow);

		// DOM order: message list → indicator row → (card) → pending row
		expect(indicator.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(pending.textContent).toContain('queued while compacting');

		unmount();
	});
});

// --- Stop dispatch (04-ui §4.2) -------------------------------------------------

describe('indicator row Stop dispatch', () => {
	async function renderRow() {
		buildFixture();
		setActiveConversation(CONV_ID);
		contextStatsStore.setCompacting(CONV_ID);

		const screen = render(ChatMessagesPerfWrapper);
		await tick();
		const row = await waitFor(indicatorRow);

		return { row, unmount: screen.unmount };
	}

	it('calls stopCompaction when no flow is running (post-flow / manual)', async () => {
		const stopGeneration = vi.spyOn(chatStore, 'stopGeneration').mockResolvedValue(undefined);
		const stopCompaction = vi.spyOn(chatStore, 'stopCompaction').mockImplementation(() => {});

		const { row, unmount } = await renderRow();

		await userEvent.click(
			[...row.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Stop')!
		);

		expect(stopCompaction).toHaveBeenCalledTimes(1);
		expect(stopGeneration).not.toHaveBeenCalled();

		unmount();
	});

	it('calls stopGeneration while the agentic flow is running (in-loop)', async () => {
		vi.spyOn(agenticStore, 'isRunning').mockReturnValue(true);
		const stopGeneration = vi.spyOn(chatStore, 'stopGeneration').mockResolvedValue(undefined);
		const stopCompaction = vi.spyOn(chatStore, 'stopCompaction').mockImplementation(() => {});

		const { row, unmount } = await renderRow();

		await userEvent.click(
			[...row.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Stop')!
		);

		expect(stopGeneration).toHaveBeenCalledTimes(1);
		expect(stopCompaction).not.toHaveBeenCalled();

		unmount();
	});
});

// --- sendMessage guard (queue, per-conv) ----------------------------------------

describe('sendMessage while compacting', () => {
	it('queues the message as pending for the compacting conversation (no API call)', async () => {
		buildFixture();
		setActiveConversation(CONV_ID);
		contextStatsStore.setCompacting(CONV_ID);

		const streamSpy = vi.spyOn(chatStore, 'streamChatCompletion').mockResolvedValue(undefined);

		await chatStore.sendMessage('queued while compacting');

		expect(chatStore.getPendingMessageContent(CONV_ID)).toBe('queued while compacting');
		expect(streamSpy).not.toHaveBeenCalled();
	});

	it('sends normally while a DIFFERENT conversation compacts', async () => {
		buildFixture();
		setActiveConversation(CONV_ID);
		contextStatsStore.setCompacting('other-conv');

		const streamSpy = vi.spyOn(chatStore, 'streamChatCompletion').mockResolvedValue(undefined);
		vi.spyOn(chatStore, 'addMessage').mockResolvedValue(makeMessage({ content: 'hello' }));
		vi.spyOn(chatStore, 'createAssistantMessage').mockResolvedValue(
			makeMessage({ role: MessageRole.ASSISTANT })
		);

		await chatStore.sendMessage('hello');

		expect(streamSpy).toHaveBeenCalledTimes(1);
		expect(chatStore.getPendingMessageContent(CONV_ID)).toBeNull();
	});
});

// --- finalizer auto-send ---------------------------------------------------------

describe('endCompactionState finalizer', () => {
	function mockSendPath() {
		const streamSpy = vi.spyOn(chatStore, 'streamChatCompletion').mockResolvedValue(undefined);
		vi.spyOn(chatStore, 'addMessage').mockResolvedValue(makeMessage({ content: 'queued' }));
		vi.spyOn(chatStore, 'createAssistantMessage').mockResolvedValue(
			makeMessage({ role: MessageRole.ASSISTANT })
		);

		return streamSpy;
	}

	it('auto-sends the queued message when the compaction settles without a plan', async () => {
		buildFixture();
		setActiveConversation(CONV_ID);
		chatStore.injectPendingMessage(CONV_ID, 'queued');

		// The test env has no model props → contextTotal is null →
		// compactConversation exits early (after claiming the state); the
		// finalizer must still run and send the queued message.
		const streamSpy = mockSendPath();

		await chatStore.compactConversation(CONV_ID);

		expect(contextStatsStore.compacting).toBe(false);
		expect(contextStatsStore.compactingConvId).toBeNull();
		expect(chatStore.getPendingMessageContent(CONV_ID)).toBeNull();
		expect(streamSpy).toHaveBeenCalledTimes(1);
	});

	it('auto-sends the queued message when the summary call is aborted', async () => {
		// Real-token fixture (5 user/assistant pairs × 5000) so the recent-window
		// plan (default keep 20000) finds a cut and the summary call is reached.
		const messages: DatabaseMessage[] = [
			makeMessage({ content: 'system', role: MessageRole.SYSTEM, type: MessageType.SYSTEM })
		];

		for (let i = 1; i <= 5; i++) {
			messages.push(
				makeMessage({
					content: `user ${i}`,
					timings: { cache_n: 0, predicted_ms: 1, predicted_n: 5000, prompt_ms: 1, prompt_n: 5000 }
				}),
				makeMessage({
					content: `assistant ${i}`,
					role: MessageRole.ASSISTANT,
					timings: { cache_n: 0, predicted_ms: 1, predicted_n: 5000, prompt_ms: 1, prompt_n: 5000 }
				})
			);
		}

		conversationsStore.activeMessages = messages;
		setActiveConversation(CONV_ID);
		vi.spyOn(modelsStore.props, 'getModelContextSize').mockReturnValue(256000);

		// Crossing lands on a2 (assistant) → split-turn cut → the minKeptUserTurns
		// check is skipped; defaults are fine for this fixture.
		const summarizeSpy = vi.spyOn(
			chatStore as unknown as { runCompactionSummary: (...args: unknown[]) => Promise<unknown> },
			'runCompactionSummary'
		).mockRejectedValue(new DOMException('Aborted', 'AbortError'));

		chatStore.injectPendingMessage(CONV_ID, 'queued-abort');
		const streamSpy = mockSendPath();

		await chatStore.compactConversation(CONV_ID);

		expect(summarizeSpy).toHaveBeenCalledTimes(1);
		expect(contextStatsStore.compacting).toBe(false);
		expect(contextStatsStore.compactingConvId).toBeNull();
		expect(chatStore.getPendingMessageContent(CONV_ID)).toBeNull();
		expect(streamSpy).toHaveBeenCalledTimes(1);
	});
});
