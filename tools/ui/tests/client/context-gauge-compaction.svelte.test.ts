// Pins the P2.6 surface of context management: the gauge popup's compaction
// status row ("Compacting context…" spinner, or "Compacted: N messages · ~X
// tokens saved" for the in-effect entry — X is the synchronous savings
// estimate), the chat form's inspector entry (Eye button, disabled mid-stream)
// and the Shift+Ctrl/⌘+I shortcut (no-op mid-stream or without an active
// conversation).
//
// Run: npx vitest --project=client --run tests/client/context-gauge-compaction.svelte.test.ts

import ContextGaugePopup from '$lib/components/app/chat/ChatForm/ChatFormContextGauge/ContextGaugePopup.svelte';
import { gaugePopup } from '$lib/components/app/chat/ChatForm/ChatFormContextGauge/gauge-popup.svelte';
import ChatFormActions from '$lib/components/app/chat/ChatForm/ChatFormActions/ChatFormActions.svelte';
import { MessageRole, MessageType } from '$lib/enums';
import { useKeyboardShortcuts } from '$lib/hooks/use-keyboard-shortcuts.svelte';
import { SUMMARY_CONTENT_PREFIX } from '$lib/services/context';
import { contextStatsStore } from '$lib/stores/chat/context-stats.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import type { DatabaseConversation, DatabaseMessage } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const DESKTOP = { height: 900, width: 1280 };

// --- fixture -----------------------------------------------------------------

let seq = 0;

function makeMessage(overrides: Partial<DatabaseMessage>): DatabaseMessage {
	return {
		children: [],
		content: '',
		convId: 'gauge-conv',
		id: `m${seq++}`,
		parent: null,
		role: MessageRole.USER,
		timestamp: 1760314440000,
		type: MessageType.TEXT,
		...overrides
	} as DatabaseMessage;
}

/**
 * Path: system, user, assistant(tool_calls) → tool, cmp, user, assistant.
 * Token estimate (chars/4): system 4, user 5, assistant 21, tool 4, cmp 33,
 * kept 5, final 4 → payload = 4 + 33 + 5 + 4 = 46, saved = 1840 − 46 = 1,794.
 */
function buildCompactedFixture(): void {
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
	const cmp = makeMessage({
		compactionMeta: {
			estimatedTokensBefore: 1840,
			firstKeptMessageId: kept.id,
			summarizedCount: 3
		},
		content: `${SUMMARY_CONTENT_PREFIX} The user asked to fix a bug; the agent read the file and applied a patch.`,
		role: MessageRole.USER,
		type: MessageType.COMPACTION
	});
	const finalAssistant = makeMessage({ content: 'you are welcome', role: MessageRole.ASSISTANT });

	conversationsStore.activeMessages = [system, user, assistant, tool, cmp, kept, finalAssistant];
}

function setActiveConversation(): void {
	conversationsStore.activeConversation = {
		currNode: '',
		id: 'gauge-conv',
		lastModified: 0,
		name: 'Gauge conversation'
	} as unknown as DatabaseConversation;
}

function openGauge() {
	const screen = render(ContextGaugePopup);

	gaugePopup.open = true;

	return screen;
}

afterEach(() => {
	vi.restoreAllMocks();
	conversationsStore.activeMessages = [];
	conversationsStore.activeConversation = null;
	contextStatsStore.compacting = false;
	chatStore.showContextInspector = false;
	gaugePopup.open = false;
});

// --- tests -------------------------------------------------------------------

describe('gauge popup compaction row (Phase 2 P2.6)', () => {
	beforeEach(async () => {
		await page.viewport(DESKTOP.width, DESKTOP.height);
	});

	it('shows "Compacting context…" with a spinner while a summary call runs', async () => {
		buildCompactedFixture();
		contextStatsStore.compacting = true;

		const screen = openGauge();

		await expect.element(screen.getByText('Compacting context…')).toBeVisible();

		const row = screen.getByText('Compacting context…');

		// spinner inside the row, and the compacted row is hidden meanwhile
		expect(row.parentElement?.querySelector('.animate-spin')).not.toBeNull();
		expect(screen.queryByText((content) => content.includes('tokens saved'))).toBeNull();
	});

	it('shows the in-effect entry savings above the inspector entry', async () => {
		buildCompactedFixture();

		const screen = openGauge();

		const row = await screen.findByText((content) => content.includes('tokens saved'));

		expect(row.textContent).toBe('Compacted: 3 messages · ~1,794 tokens saved');
		// the inspector entry stays below the row
		expect(screen.getByText('Inspect what the LLM sees →')).toBeVisible();
		expect(screen.queryByText('Compacting context…')).toBeNull();
	});

	it('shows no compaction row without a compaction entry', async () => {
		conversationsStore.activeMessages = [makeMessage({ content: 'hello' })];

		const screen = openGauge();

		await expect.element(screen.getByText('Inspect what the LLM sees →')).toBeVisible();
		expect(screen.queryByText((content) => content.includes('tokens saved'))).toBeNull();
		expect(screen.queryByText('Compacting context…')).toBeNull();
	});
});

describe('chat form inspector entry (Phase 2 P2.6)', () => {
	beforeEach(async () => {
		await page.viewport(DESKTOP.width, DESKTOP.height);
	});

	it('opens the context inspector from the Eye button', async () => {
		const screen = render(ChatFormActions);

		const eyeButton = screen.getByRole('button', { name: /Inspect what the LLM sees/ });

		expect(eyeButton).toBeVisible();
		expect(chatStore.showContextInspector).toBe(false);

		await userEvent.click(eyeButton);

		expect(chatStore.showContextInspector).toBe(true);
	});

	it('is disabled while the model responds', async () => {
		vi.spyOn(chatStore, 'isLoading', 'get').mockReturnValue(true);

		const screen = render(ChatFormActions);

		// the sr-only label switches to the disabled-state text
		const eyeButton = screen.getByRole('button', { name: /Unavailable while the model is responding/ });

		expect(eyeButton).toBeDisabled();
	});
});

describe('Shift+Ctrl/⌘+I shortcut (Phase 2 P2.6)', () => {
	function pressShortcut(): KeyboardEvent {
		const { handleKeydown } = useKeyboardShortcuts({});
		const event = new KeyboardEvent('keydown', { cancelable: true, ctrlKey: true, key: 'I', shiftKey: true });

		handleKeydown(event);

		return event;
	}

	it('opens the inspector for the active conversation', () => {
		setActiveConversation();

		const event = pressShortcut();

		expect(chatStore.showContextInspector).toBe(true);
		expect(event.defaultPrevented).toBe(true);
	});

	it('does nothing without an active conversation', () => {
		conversationsStore.activeConversation = null;

		const event = pressShortcut();

		expect(chatStore.showContextInspector).toBe(false);
		expect(event.defaultPrevented).toBe(false);
	});

	it('does nothing while the model responds', () => {
		setActiveConversation();
		vi.spyOn(chatStore, 'isLoading', 'get').mockReturnValue(true);

		pressShortcut();

		expect(chatStore.showContextInspector).toBe(false);
	});
});
