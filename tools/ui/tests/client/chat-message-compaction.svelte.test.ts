// Pins the chat-list rendering of compaction entries (context-enhance Phase 1, 5.6):
// a `type: 'compaction'` node is a user-role tree node, so the list must give it
// its OWN row (never merged into the preceding assistant's agentic group),
// render it through ChatMessageCompaction (not a user bubble), and hide it
// entirely when `contextShowCompactionEntries` is off. P2.5 adds the
// manual-intervention actions in the expanded region, all spied on the
// chatStore: edit the summary in place (prefix stripped), re-summarize and
// restore the full context (with a confirmation dialog). N3: while the
// entry's conversation is compacting (N7 per-conv `setCompacting(convId)`) the
// action row is replaced by a Stop button calling `stopCompaction`.
//
// Run: npx vitest --project=client --run tests/client/chat-message-compaction.svelte.test.ts

import ChatMessagesPerfWrapper from './components/ChatMessagesPerfWrapper.svelte';
import { MessageRole, MessageType } from '$lib/enums';
import { SUMMARY_CONTENT_PREFIX } from '$lib/services/context';
import { contextStatsStore } from '$lib/stores/chat/context-stats.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import type { DatabaseMessage } from '$lib/types';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userEvent } from 'vitest/browser';

// --- fixture ---------------------------------------------------------------

let seq = 0;

function makeMessage(overrides: Partial<DatabaseMessage>): DatabaseMessage {
	return {
		children: [],
		content: '',
		convId: 'cmp-conv',
		id: `m${seq++}`,
		parent: null,
		role: MessageRole.USER,
		timestamp: 1760314440000, // 2025-10-13 02:14
		type: MessageType.TEXT,
		...overrides
	} as DatabaseMessage;
}

function makeCompaction(overrides: Partial<DatabaseMessage> = {}): DatabaseMessage {
	return makeMessage({
		content: `${SUMMARY_CONTENT_PREFIX} The user asked to fix a bug; the agent read the file and applied a patch.`,
		compactionMeta: {
			estimatedTokensBefore: 1840,
			firstKeptMessageId: '',
			summarizedCount: 3
		},
		role: MessageRole.USER,
		type: MessageType.COMPACTION,
		...overrides
	});
}

/**
 * Path: system, user, assistant(tool_calls) → tool, cmp, user, assistant.
 * Returns the messages the tests address (cmp for the P2.5 action tests,
 * kept for the boundary preview).
 */
function buildFixture(): { cmp: DatabaseMessage; kept: DatabaseMessage } {
	const system = makeMessage({ content: 'You are helpful.', role: MessageRole.SYSTEM, type: MessageType.SYSTEM });
	const user = makeMessage({ content: 'help me fix the bug' });
	const assistant = makeMessage({
		role: MessageRole.ASSISTANT,
		toolCalls: JSON.stringify([
			{
				function: { arguments: '{}', name: 'read_file' },
				id: 'call_1',
				type: 'function'
			}
		])
	});
	const tool = makeMessage({ content: 'file contents', role: MessageRole.TOOL, toolCallId: 'call_1' });
	const kept = makeMessage({ content: 'thanks, that worked' });
	const cmp = makeCompaction({
		compactionMeta: {
			estimatedTokensBefore: 1840,
			firstKeptMessageId: kept.id,
			summarizedCount: 3
		}
	});
	const finalAssistant = makeMessage({ content: 'you are welcome', role: MessageRole.ASSISTANT });

	conversationsStore.activeMessages = [system, user, assistant, tool, cmp, kept, finalAssistant];

	return { cmp, kept };
}

// --- helpers ---------------------------------------------------------------

async function waitFor<T extends Node>(find: () => T | null, timeoutMs = 5000): Promise<T> {
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const el = find();

		if (el) return el;

		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	throw new Error('Timed out waiting for element');
}

function cmpRow(): HTMLElement | null {
	return [...document.querySelectorAll<HTMLElement>('.chat-message')].find((row) =>
		row.textContent?.includes('Context compacted')
	) ?? null;
}

function rowCount(): number {
	return document.querySelectorAll('.chat-message').length;
}

// The P2.5 actions live in the expanded summary region; expand it and hand
// back the row (the store actions are spied, so the row never unmounts).
async function openExpandedEntry() {
	const { unmount } = render(ChatMessagesPerfWrapper);

	await tick();
	const row = await waitFor(cmpRow);

	await userEvent.click(row.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
	await tick();
	await waitFor(() => row.querySelector('pre'));

	return { row, unmount };
}

function findRowButton(row: HTMLElement, label: string): HTMLButtonElement | null {
	return [...row.querySelectorAll<HTMLButtonElement>('button')].find(
		(button) => button.textContent?.trim() === label
	) ?? null;
}

afterEach(() => {
	vi.restoreAllMocks();
	conversationsStore.activeMessages = [];
	contextStatsStore.setCompacting(null);
});

// --- tests -----------------------------------------------------------------

describe('ChatMessages compaction entry rendering', () => {
	it('renders the entry as its own row with summary stats', async () => {
		buildFixture();
		const { unmount } = render(ChatMessagesPerfWrapper);

		await tick();
		const row = await waitFor(cmpRow);

		// 6 display rows: system, user, assistant(+tool group), cmp, user, assistant
		expect(rowCount()).toBe(6);
		expect(row.textContent).toContain('Summarized 3 messages');
		expect(row.textContent).toContain('~1,840');

		// The entry row is a separate row, not absorbed into the assistant's
		// agentic group (the tool result text must not leak into it)
		const agenticRow = [...document.querySelectorAll<HTMLElement>('.chat-message')].find((r) =>
			r.textContent?.includes('file contents')
		);

		expect(agenticRow).not.toBe(row);
		expect(row.textContent).not.toContain('file contents');

		unmount();
		conversationsStore.activeMessages = [];
	});

	it('expands to the summary text and the kept-region boundary preview', async () => {
		buildFixture();
		const { unmount } = render(ChatMessagesPerfWrapper);

		await tick();
		const row = await waitFor(cmpRow);
		const button = row.querySelector<HTMLButtonElement>('button[aria-expanded]');

		expect(button).not.toBeNull();
		expect(button?.getAttribute('aria-expanded')).toBe('false');
		expect(row.querySelector('pre')).toBeNull();

		await userEvent.click(button!);
		await tick();

		const pre = await waitFor(() => row.querySelector('pre'));
		expect(pre.textContent).toContain('The user asked to fix a bug');
		// the fixed summary prefix is stripped from the displayed body
		expect(pre.textContent).not.toContain('Conversation summary');

		// kept boundary: message index 5 (0-based) in the active path -> "#6"
		expect(row.textContent).toContain('Kept from: #6');
		expect(row.textContent).toContain('user: “thanks, that worked”');

		// collapse again
		const hideButton = row.querySelector<HTMLButtonElement>('button[aria-expanded]');

		expect(hideButton?.textContent).toContain('Hide summary');

		await userEvent.click(hideButton!);
		await tick();

		expect(row.querySelector('pre')).toBeNull();

		unmount();
		conversationsStore.activeMessages = [];
	});

	it('hides the entry entirely when contextShowCompactionEntries is off', async () => {
		buildFixture();
		const { unmount } = render(ChatMessagesPerfWrapper);

		await tick();
		await waitFor(cmpRow);
		expect(rowCount()).toBe(6);

		settingsStore.config.contextShowCompactionEntries = false;
		await tick();
		await tick();

		expect(cmpRow()).toBeNull();
		expect(rowCount()).toBe(5);

		settingsStore.config.contextShowCompactionEntries = true;

		unmount();
		conversationsStore.activeMessages = [];
	});

	it('marks a split-turn entry and notes the in-turn user request', async () => {
		const system = makeMessage({ content: 'You are helpful.', role: MessageRole.SYSTEM, type: MessageType.SYSTEM });
		const user = makeMessage({ content: 'refactor the module' });
		const assistant = makeMessage({
			role: MessageRole.ASSISTANT,
			toolCalls: JSON.stringify([
				{
					function: { arguments: '{}', name: 'edit_file' },
					id: 'call_2',
					type: 'function'
				}
			])
		});
		const tool = makeMessage({ content: 'edited', role: MessageRole.TOOL, toolCallId: 'call_2' });
		const cmp = makeCompaction({
			compactionMeta: {
				estimatedTokensBefore: 900,
				firstKeptMessageId: assistant.id,
				isSplitTurn: true,
				summarizedCount: 2
			}
		});

		conversationsStore.activeMessages = [system, user, assistant, tool, cmp];
		const { unmount } = render(ChatMessagesPerfWrapper);

		await tick();
		const row = await waitFor(cmpRow);

		expect(row.textContent).toContain('Context compacted (mid-turn)');

		await userEvent.click(row.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
		await tick();
		await waitFor(() => row.querySelector('pre'));

		// kept boundary is an assistant with tool calls -> tool names, not content
		expect(row.textContent).toContain('assistant: tool_calls edit_file');
		expect(row.textContent).toContain('This turn');

		unmount();
		conversationsStore.activeMessages = [];
	});
});

describe('ChatMessageCompaction entry actions (Phase 2 P2.5)', () => {
	it('edits the summary in place and saves it through the store', async () => {
		const { cmp } = buildFixture();
		const updateSpy = vi.spyOn(chatStore, 'updateCompactionSummary').mockResolvedValue(undefined);

		const { row, unmount } = await openExpandedEntry();

		const editButton = findRowButton(row, 'Edit');
		expect(editButton).not.toBeNull();
		await userEvent.click(editButton!);

		const textarea = await waitFor(() => row.querySelector<HTMLTextAreaElement>('textarea'));

		// prefilled with the stored summary, the fixed prefix stripped
		expect(textarea.value).toContain('The user asked to fix a bug');
		expect(textarea.value).not.toContain('Conversation summary');

		await userEvent.clear(textarea);
		await userEvent.type(textarea, 'Edited summary text');

		const saveButton = findRowButton(row, 'Save');
		expect(saveButton).not.toBeNull();
		await userEvent.click(saveButton!);

		expect(updateSpy).toHaveBeenCalledWith('cmp-conv', cmp.id, 'Edited summary text');

		unmount();
	});

	it('cancels the in-place edit without touching the store', async () => {
		buildFixture();
		const updateSpy = vi.spyOn(chatStore, 'updateCompactionSummary').mockResolvedValue(undefined);

		const { row, unmount } = await openExpandedEntry();

		await userEvent.click(findRowButton(row, 'Edit')!);

		const textarea = await waitFor(() => row.querySelector<HTMLTextAreaElement>('textarea'));
		await userEvent.clear(textarea);
		await userEvent.type(textarea, 'throwaway text');

		const cancelButton = findRowButton(row, 'Cancel');
		expect(cancelButton).not.toBeNull();
		await userEvent.click(cancelButton!);

		// the summary preview is back, the store was never called
		expect(row.querySelector('textarea')).toBeNull();
		expect(row.querySelector('pre')?.textContent).toContain('The user asked to fix a bug');
		expect(updateSpy).not.toHaveBeenCalled();

		unmount();
	});

	it('re-summarizes through the store for the in-effect entry', async () => {
		const { cmp } = buildFixture();
		const recompactSpy = vi.spyOn(chatStore, 'recompactConversationEntry').mockResolvedValue(undefined);

		const { row, unmount } = await openExpandedEntry();

		const recompactButton = findRowButton(row, 'Re-summarize');
		expect(recompactButton).not.toBeNull();
		await userEvent.click(recompactButton!);

		expect(recompactSpy).toHaveBeenCalledWith('cmp-conv', cmp.id);

		unmount();
	});

	it('restores the full context after confirmation through the store', async () => {
		const { cmp } = buildFixture();
		const expandSpy = vi.spyOn(chatStore, 'expandCompactionEntry').mockResolvedValue(undefined);

		const { row, unmount } = await openExpandedEntry();

		const restoreButton = findRowButton(row, 'Restore all context');
		expect(restoreButton).not.toBeNull();
		await userEvent.click(restoreButton!);

		// the confirmation dialog spells out what comes back
		const confirm = await waitFor(() =>
			[...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].find(
				(el) => el.textContent?.includes('Restore the full context')
			) ?? null
		);

		expect(confirm.textContent).toContain('3 compacted messages');
		expect(confirm.textContent).toContain('tokens');

		const confirmButton = [...confirm.querySelectorAll<HTMLButtonElement>('button')].find(
			(button) => button.textContent?.trim() === 'Restore'
		);

		expect(confirmButton).not.toBeNull();
		await userEvent.click(confirmButton!);

		expect(expandSpy).toHaveBeenCalledWith('cmp-conv', cmp.id);

		unmount();
	});

	it('shows a Stop button in place of the actions while compacting', async () => {
		buildFixture();
		contextStatsStore.setCompacting('cmp-conv');

		const { row, unmount } = await openExpandedEntry();

		const stopButton = findRowButton(row, 'Stop');

		expect(stopButton).not.toBeNull();
		expect(stopButton?.disabled).toBe(false);
		expect(findRowButton(row, 'Edit')).toBeNull();
		expect(findRowButton(row, 'Re-summarize')).toBeNull();
		expect(findRowButton(row, 'Restore all context')).toBeNull();

		unmount();
	});

	it('Stop calls stopCompaction while a summary is in flight', async () => {
		buildFixture();
		contextStatsStore.setCompacting('cmp-conv');
		const stopSpy = vi.spyOn(chatStore, 'stopCompaction');

		const { row, unmount } = await openExpandedEntry();

		await userEvent.click(findRowButton(row, 'Stop')!);

		expect(stopSpy).toHaveBeenCalledTimes(1);

		unmount();
	});

	it('disables Re-summarize when the boundary no longer exists', async () => {
		const system = makeMessage({ content: 'You are helpful.', role: MessageRole.SYSTEM, type: MessageType.SYSTEM });
		const user = makeMessage({ content: 'early question' });
		const assistant = makeMessage({ content: 'early answer', role: MessageRole.ASSISTANT });
		const cmp = makeCompaction({
			compactionMeta: {
				estimatedTokensBefore: 500,
				firstKeptMessageId: 'missing-id',
				summarizedCount: 2
			}
		});

		conversationsStore.activeMessages = [system, user, assistant, cmp];
		const { unmount } = render(ChatMessagesPerfWrapper);

		await tick();
		const row = await waitFor(cmpRow);
		await userEvent.click(row.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
		await tick();
		await waitFor(() => row.querySelector('pre'));

		expect(findRowButton(row, 'Re-summarize')?.disabled).toBe(true);
		// editing and restoring stay available (the store handles the fail-open case)
		expect(findRowButton(row, 'Edit')?.disabled).toBe(false);
		expect(findRowButton(row, 'Restore all context')?.disabled).toBe(false);

		unmount();
	});
});
