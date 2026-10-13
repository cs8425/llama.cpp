// Pins the chat-list rendering of compaction entries (context-enhance Phase 1, 5.6):
// a `type: 'compaction'` node is a user-role tree node, so the list must give it
// its OWN row (never merged into the preceding assistant's agentic group),
// render it through ChatMessageCompaction (not a user bubble), and hide it
// entirely when `contextShowCompactionEntries` is off.
//
// Run: npx vitest --project=client --run tests/client/chat-message-compaction.svelte.test.ts

import ChatMessagesPerfWrapper from './components/ChatMessagesPerfWrapper.svelte';
import { MessageRole } from '$lib/enums';
import { SUMMARY_CONTENT_PREFIX } from '$lib/services/context';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import type { DatabaseMessage } from '$lib/types';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
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
		type: 'text',
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
		type: 'compaction',
		...overrides
	});
}

/**
 * Path: system, user, assistant(tool_calls) → tool, cmp, user, assistant.
 * Returns the messages plus the kept-region start the cmp claims.
 */
function buildFixture(): { kept: DatabaseMessage } {
	const system = makeMessage({ content: 'You are helpful.', role: MessageRole.SYSTEM, type: 'system' });
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

	return { kept };
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
	return [...document.querySelectorAll('.chat-message')].find((row) =>
		row.textContent?.includes('Context compacted')
	) ?? null;
}

function rowCount(): number {
	return document.querySelectorAll('.chat-message').length;
}

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
		const agenticRow = [...document.querySelectorAll('.chat-message')].find((r) =>
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
		const system = makeMessage({ content: 'You are helpful.', role: MessageRole.SYSTEM, type: 'system' });
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
