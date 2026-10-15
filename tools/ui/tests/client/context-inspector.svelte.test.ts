// Pins the context inspector (context-enhance Phase 1 5.7 + Phase 2 P2.4):
// the dialog must show the exact payload `buildLlmContext` produces for the
// active path (WYSIWYG with the send path) — payload rows with role badges
// and token estimates, the compacted-out region, the fail-open boundary
// warning and a Copy JSON action that replaces base64 bodies with
// placeholders. P2.4 adds the manual-intervention actions, all spied on the
// chatStore: edit the summary in place (prefix stripped), move the kept-from
// boundary through the grouped select, Compact now, Expand (with
// confirmation) and Re-summarize; while `contextStatsStore.compacting` the
// spinner row shows and every action is disabled.
//
// Layout round: the whole Advanced controls block sits at the top (below the
// context-usage block, above the payload list) with exactly one Compact now
// control in the dialog (the boundary warning no longer carries its own), and
// a Back to top button at the bottom returns the scroll container to the top.
//
// Run: npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts

import DialogContextInspector from '$lib/components/app/dialogs/DialogContextInspector.svelte';
import { MessageRole, MessageType } from '$lib/enums';
import { SUMMARY_CONTENT_PREFIX } from '$lib/services/context';
import { contextStatsStore } from '$lib/stores/chat/context-stats.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { modelsStore } from '$lib/stores/models/index.svelte';
import type { DatabaseConversation, DatabaseMessage } from '$lib/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userEvent } from 'vitest/browser';

// --- fixture ---------------------------------------------------------------

let seq = 0;

function makeMessage(overrides: Partial<DatabaseMessage>): DatabaseMessage {
	return {
		children: [],
		content: '',
		convId: 'insp-conv',
		id: `m${seq++}`,
		parent: null,
		role: MessageRole.USER,
		timestamp: 1760314440000,
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
 * Returns the messages the action tests address.
 */
function buildCompactedFixture(): {
	assistant: DatabaseMessage;
	cmp: DatabaseMessage;
	kept: DatabaseMessage;
	user: DatabaseMessage;
} {
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

	return { assistant, cmp, kept, user };
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

function dialogText(): string {
	return document.querySelector('[role="dialog"]')?.textContent ?? '';
}

// Payload row expanders only — scoped to the payload list's <li> rows. The
// Advanced section's bits-ui Select trigger is also a button[aria-expanded]
// inside the dialog, so an unscoped selector would count it as a row.
function payloadRowButtons(): HTMLButtonElement[] {
	return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] li button[aria-expanded]')];
}

function dialogButtons(): HTMLButtonElement[] {
	return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
}

function findDialogButton(label: string): HTMLButtonElement | null {
	return dialogButtons().find((button) => button.textContent?.trim().includes(label)) ?? null;
}

function mockClipboard(): { writeText: ReturnType<typeof vi.fn> } {
	const writeText = vi.fn().mockResolvedValue(undefined);

	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

	return { writeText };
}

// The inspector acts on the ACTIVE conversation; the store methods resolve
// convId from it.
function setActiveConversation() {
	conversationsStore.activeConversation = {
		currNode: '',
		id: 'insp-conv',
		lastModified: 0,
		name: 'Inspector conversation'
	} as unknown as DatabaseConversation;
}

async function openInspector() {
	const { unmount } = render(DialogContextInspector, { open: true });

	await waitFor(() => (payloadRowButtons().length === 4 ? document.querySelector('[role="dialog"]') : null));

	return { unmount };
}

afterEach(() => {
	vi.restoreAllMocks();
	conversationsStore.activeMessages = [];
	conversationsStore.activeConversation = null;
	contextStatsStore.compacting = false;
});

// --- tests -----------------------------------------------------------------

describe('DialogContextInspector (read-only, Phase 1)', () => {
	it('lists the compacted payload with badges, tokens and the dropped region', async () => {
		buildCompactedFixture();
		vi.spyOn(modelsStore, 'activeModelId', 'get').mockReturnValue('test-model');
		vi.spyOn(modelsStore.props, 'getModelContextSize').mockReturnValue(32768);

		const { unmount } = await openInspector();

		const text = dialogText();

		// header: model, n_ctx and the estimate bar (percent of n_ctx)
		expect(text).toContain('test-model');
		expect(text).toContain('32,768');
		expect(text).toContain('% of n_ctx');
		expect(text).toContain('Estimated send:');

		// payload = system, summary, kept user, final assistant (cmp node itself is not re-sent)
		expect(text).toContain('(4 messages)');
		expect(text).toContain('summary');
		expect(text).not.toContain('no longer exists');

		// the summary row carries the stored content (prefix included — WYSIWYG)
		const summaryRow = payloadRowButtons()[1];
		expect(summaryRow.textContent).toContain('Conversation summary');

		// the tool result stays out of the payload (it is only listed as dropped)
		expect(payloadRowButtons().some((row) => row.textContent?.includes('file contents'))).toBe(false);

		// compacted-out region: the 3 messages before the boundary, grayscale list
		expect(text).toContain('Compacted out');
		expect(text).toContain('(3 messages, not sent');
		expect(text).toContain('help me fix the bug');
		expect(text).toContain('(tool_calls)');

		// per-row token estimates sum up to the header estimate
		const rowTokens = payloadRowButtons()
			.map((row) => Number(row.textContent?.match(/~([\d,]+) tok/)?.[1]?.replace(/,/g, '')))
			.filter((n) => Number.isFinite(n));

		expect(rowTokens).toHaveLength(4);
		const headerTokens = Number(text.match(/Estimated send:\s*([\d,]+) tokens/)?.[1]?.replace(/,/g, ''));

		expect(rowTokens.reduce((a, b) => a + b, 0)).toBe(headerTokens);

		unmount();
	});

	it('expands a row to the full message text', async () => {
		buildCompactedFixture();
		const { unmount } = await openInspector();

		// row 3 is the kept user message
		const row = payloadRowButtons()[2];
		expect(row.textContent).toContain('thanks, that worked');
		expect(document.querySelector('[role="dialog"] pre')).toBeNull();

		await userEvent.click(row);
		await waitFor(() => document.querySelector('[role="dialog"] pre'));

		expect(document.querySelector('[role="dialog"] pre')?.textContent).toContain('thanks, that worked');

		// collapse again
		const collapsed = payloadRowButtons()[2];
		expect(collapsed.getAttribute('aria-expanded')).toBe('true');
		await userEvent.click(collapsed);

		expect(document.querySelector('[role="dialog"] pre')).toBeNull();

		unmount();
	});

	it('shows the fail-open warning and the full path when the boundary is lost', async () => {
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
		const { unmount } = await openInspector();

		const text = dialogText();

		// warning bar
		expect(text).toContain('no longer exists');
		expect(document.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull();

		// full path is sent: system, user, assistant, cmp-as-plain-user
		expect(text).toContain('(4 messages)');
		expect(text).not.toContain('Compacted out');
		expect(text).toContain('early question');

		unmount();
	});

	it('copies the payload JSON with base64 bodies replaced by placeholders', async () => {
		const { writeText } = mockClipboard();
		buildCompactedFixture();
		const { unmount } = await openInspector();

		const copyButton = findDialogButton('Copy JSON');

		expect(copyButton).not.toBeNull();
		await userEvent.click(copyButton!);
		await waitFor(() => findDialogButton('Copied'));

		expect(writeText).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(writeText.mock.calls[0][0] as string) as Array<{
			content: string;
			role: string;
		}>;

		expect(payload).toHaveLength(4);
		expect(payload[0].role).toBe('system');
		// the summary travels as a user turn with the stored content (prefix included)
		expect(payload[1].role).toBe('user');
		expect(payload[1].content).toContain('Conversation summary');
		// no base64 ever leaves the dialog
		expect(writeText.mock.calls[0][0]).not.toContain('base64,');

		// feedback swaps the label
		expect(dialogText()).toContain('Copied');

		unmount();
	});
});

describe('DialogContextInspector (actions, Phase 2 P2.4)', () => {
	it('edits the summary in place and saves it through the store', async () => {
		const { cmp } = buildCompactedFixture();
		setActiveConversation();
		const updateSpy = vi.spyOn(chatStore, 'updateCompactionSummary').mockResolvedValue(undefined);

		const { unmount } = await openInspector();

		const editButton = document.querySelector<HTMLButtonElement>(
			'[role="dialog"] button[aria-label="Edit summary"]'
		);

		expect(editButton).not.toBeNull();
		await userEvent.click(editButton!);

		const textarea = await waitFor(
			() => document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')
		);

		// prefilled with the stored summary, the fixed prefix stripped
		expect(textarea.value).toContain('The user asked to fix a bug');
		expect(textarea.value).not.toContain('Conversation summary');

		await userEvent.clear(textarea);
		await userEvent.type(textarea, 'Edited summary text');

		const saveButton = findDialogButton('Save');
		expect(saveButton).not.toBeNull();
		await userEvent.click(saveButton!);

		expect(updateSpy).toHaveBeenCalledWith('insp-conv', cmp.id, 'Edited summary text');

		unmount();
	});

	it('Compact now calls the store with auto: false', async () => {
		buildCompactedFixture();
		setActiveConversation();
		const compactSpy = vi.spyOn(chatStore, 'compactConversation').mockResolvedValue(undefined);

		const { unmount } = await openInspector();

		const compactButton = findDialogButton('Compact now');
		expect(compactButton).not.toBeNull();
		await userEvent.click(compactButton!);

		expect(compactSpy).toHaveBeenCalledWith('insp-conv', { auto: false });

		unmount();
	});

	it('Expand asks for confirmation and restores through the store', async () => {
		const { cmp } = buildCompactedFixture();
		setActiveConversation();
		const expandSpy = vi.spyOn(chatStore, 'expandCompactionEntry').mockResolvedValue(undefined);

		const { unmount } = await openInspector();

		const expandButton = findDialogButton('Expand');
		expect(expandButton).not.toBeNull();
		await userEvent.click(expandButton!);

		// the confirmation dialog spells out what comes back
		const confirm = await waitFor(() =>
			[...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].find(
				(el) => el.textContent?.includes('Restore the full context')
			) ?? null
		);

		expect(confirm.textContent).toContain('3 compacted messages');
		expect(confirm.textContent).toContain('tokens');

		const confirmButton = [...confirm.querySelectorAll<HTMLButtonElement>('button')].find(
			(button) => button.textContent?.trim() === 'Expand'
		);

		expect(confirmButton).not.toBeNull();
		await userEvent.click(confirmButton!);

		expect(expandSpy).toHaveBeenCalledWith('insp-conv', cmp.id);

		unmount();
	});

	it('Re-summarize calls the store for the in-effect entry', async () => {
		const { cmp } = buildCompactedFixture();
		setActiveConversation();
		const recompactSpy = vi.spyOn(chatStore, 'recompactConversationEntry').mockResolvedValue(undefined);

		const { unmount } = await openInspector();

		const recompactButton = findDialogButton('Re-summarize');
		expect(recompactButton).not.toBeNull();
		await userEvent.click(recompactButton!);

		expect(recompactSpy).toHaveBeenCalledWith('insp-conv', cmp.id);

		unmount();
	});

	it('moves the kept-from boundary through the grouped select', async () => {
		const { assistant, cmp } = buildCompactedFixture();
		setActiveConversation();
		const moveSpy = vi.spyOn(chatStore, 'moveCompactionBoundary').mockResolvedValue(undefined);

		const { unmount } = await openInspector();

		// the trigger shows the current boundary
		const trigger = document.querySelector<HTMLButtonElement>(
			'[role="dialog"] [data-slot="select-trigger"]'
		);
		expect(trigger).not.toBeNull();
		expect(trigger!.textContent).toContain('thanks, that worked');

		await userEvent.click(trigger!);

		// the options are portaled. The first message after the system head can
		// never be a boundary (the summary would cover nothing, so the store
		// rejects it with "Nothing to summarize") — the earliest pickable one
		// is the assistant tool_calls turn; select it from the "Within a turn
		// (assistant)" group.
		const option = await waitFor(() =>
			[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
				(el) => el.textContent?.includes('read_file')
			) ?? null
		);

		await userEvent.click(option);

		expect(moveSpy).toHaveBeenCalledWith('insp-conv', cmp.id, assistant.id);

		unmount();
	});

	it('shows a Stop button in place of the actions while compacting', async () => {
		buildCompactedFixture();
		setActiveConversation();
		contextStatsStore.compacting = true;

		const { unmount } = await openInspector();

		expect(dialogText()).toContain('Compacting context…');

		// the summary-producing actions are replaced by a single enabled Stop
		const stopButton = findDialogButton('Stop');

		expect(stopButton).not.toBeNull();
		expect(stopButton?.disabled).toBe(false);
		expect(findDialogButton('Compact now')).toBeNull();
		expect(findDialogButton('Expand')).toBeNull();
		expect(findDialogButton('Re-summarize')).toBeNull();

		// the non-summary actions stay disabled
		expect(
			document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Edit summary"]')?.disabled
		).toBe(true);
		expect(
			document.querySelector<HTMLButtonElement>('[role="dialog"] [data-slot="select-trigger"]')?.disabled
		).toBe(true);

		unmount();
	});

	it('Stop calls stopCompaction while a summary is in flight', async () => {
		buildCompactedFixture();
		setActiveConversation();
		contextStatsStore.compacting = true;
		const stopSpy = vi.spyOn(chatStore, 'stopCompaction');

		const { unmount } = await openInspector();

		await userEvent.click(findDialogButton('Stop')!);

		expect(stopSpy).toHaveBeenCalledTimes(1);

		unmount();
	});
});

describe('DialogContextInspector (layout: controls on top, back to top)', () => {
	it('keeps a single Compact now control above the payload list', async () => {
		buildCompactedFixture();
		setActiveConversation();

		const { unmount } = await openInspector();

		// exactly one compact control in the whole dialog (the boundary warning
		// no longer carries its own copy)
		const compactButtons = dialogButtons().filter(
			(button) => button.textContent?.trim() === 'Compact now'
		);

		expect(compactButtons).toHaveLength(1);

		// the controls section sits above the payload list in document order
		const payloadHeading = [...document.querySelectorAll<HTMLElement>('[role="dialog"] h3')].find(
			(el) => el.textContent?.includes('Actual payload')
		);

		expect(payloadHeading).not.toBeNull();
		expect(compactButtons[0].compareDocumentPosition(payloadHeading!) & Node.DOCUMENT_POSITION_FOLLOWING)
			.toBeTruthy();

		unmount();
	});

	it('shows the boundary warning without a duplicate compact action', async () => {
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
		setActiveConversation();

		const { unmount } = await openInspector();

		const alert = document.querySelector<HTMLElement>('[role="dialog"] [role="alert"]');

		expect(alert).not.toBeNull();
		expect(alert?.textContent).toContain('no longer exists');
		// the warning is text-only — the single compact action lives in the
		// Advanced block at the top
		expect(alert?.querySelector('button')).toBeNull();
		expect(dialogButtons().filter((button) => button.textContent?.trim() === 'Compact now')).toHaveLength(1);

		unmount();
	});

	it('Back to top scrolls the dialog content back to the top', async () => {
		buildCompactedFixture();
		setActiveConversation();

		const { unmount } = await openInspector();

		const backToTop = findDialogButton('Back to top');
		expect(backToTop).not.toBeNull();

		const content = document.querySelector<HTMLDivElement>('[role="dialog"][data-slot="dialog-content"]');
		expect(content).not.toBeNull();

		// The app's Tailwind CSS (overflow-y-auto on the dialog content) is not
		// loaded in the browser test environment, so make the element a scroll
		// container explicitly — mirroring the production class — and force an
		// overflow (80px is below any rendered content height) so there is a
		// scroll position to reset.
		content!.style.overflowY = 'auto';
		content!.style.maxHeight = '80px';
		content!.scrollTop = content!.scrollHeight;
		expect(content!.scrollTop).toBeGreaterThan(0);

		await userEvent.click(backToTop!);

		// smooth scrolling animates; wait for it to settle at the top
		await waitFor(() => (content!.scrollTop === 0 ? content : null));
		expect(content!.scrollTop).toBe(0);

		unmount();
	});
});
