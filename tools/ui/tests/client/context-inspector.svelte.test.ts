// Pins the read-only context inspector (context-enhance Phase 1, 5.7): the
// dialog must show the exact payload `buildLlmContext` produces for the active
// path (WYSIWYG with the send path) — payload rows with role badges and token
// estimates, the compacted-out region, the fail-open boundary warning and a
// Copy JSON action that replaces base64 bodies with placeholders.
//
// Run: npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts

import DialogContextInspector from '$lib/components/app/dialogs/DialogContextInspector.svelte';
import { MessageRole, MessageType } from '$lib/enums';
import { SUMMARY_CONTENT_PREFIX } from '$lib/services/context';
import { modelsStore } from '$lib/stores/models/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import type { DatabaseMessage } from '$lib/types';
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
 * Returns the messages plus the kept-region start the cmp claims.
 */
function buildCompactedFixture(): { kept: DatabaseMessage } {
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

function dialogText(): string {
	return document.querySelector('[role="dialog"]')?.textContent ?? '';
}

function payloadRowButtons(): HTMLButtonElement[] {
	return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button[aria-expanded]')];
}

function mockClipboard(): { writeText: ReturnType<typeof vi.fn> } {
	const writeText = vi.fn().mockResolvedValue(undefined);

	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

	return { writeText };
}

afterEach(() => {
	vi.restoreAllMocks();
	conversationsStore.activeMessages = [];
});

// --- tests -----------------------------------------------------------------

describe('DialogContextInspector (read-only, Phase 1)', () => {
	it('lists the compacted payload with badges, tokens and the dropped region', async () => {
		buildCompactedFixture();
		vi.spyOn(modelsStore, 'activeModelId', 'get').mockReturnValue('test-model');
		vi.spyOn(modelsStore.props, 'getModelContextSize').mockReturnValue(32768);

		const { unmount } = render(DialogContextInspector, { open: true });

		await waitFor(() => (payloadRowButtons().length === 4 ? document.querySelector('[role="dialog"]') : null));

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
		const { unmount } = render(DialogContextInspector, { open: true });

		await waitFor(() => (payloadRowButtons().length === 4 ? document.querySelector('[role="dialog"]') : null));

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
		const { unmount } = render(DialogContextInspector, { open: true });

		await waitFor(() => (payloadRowButtons().length === 4 ? document.querySelector('[role="dialog"]') : null));

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
		const { unmount } = render(DialogContextInspector, { open: true });

		await waitFor(() => (payloadRowButtons().length === 4 ? document.querySelector('[role="dialog"]') : null));

		const copyButton = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
			(button) => button.textContent?.includes('Copy JSON')
		);

		expect(copyButton).not.toBeNull();
		await userEvent.click(copyButton!);
		await waitFor(() =>
			[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
				(button) => button.textContent?.includes('Copied')
			) ?? null
		);

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
