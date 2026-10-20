// Pins the agentic loop-limit UI (context-enhance/07):
// - the "continue?" card shows two distinct texts (turns / softTime, D10)
// - the in-chat hard-limit notice row (D8) renders only for the ACTIVE
//   conversation, Dismiss clears it, Resume calls resumeAgenticFlowFromTail,
//   and Resume is disabled while that conversation is loading.
//
// Run: npx vitest --project=client --run tests/client/agentic-limits.svelte.test.ts

import ChatMessageActionCardContinueRequest from '$lib/components/app/chat/ChatMessages/ChatMessageActions/ChatMessageActionCard/ChatMessageActionCardContinueRequest.svelte';
import ChatMessageAgenticLimitNotice from '$lib/components/app/chat/ChatMessages/ChatMessageAgenticLimitNotice.svelte';
import { agenticStore } from '$lib/stores/agentic/index.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import type { DatabaseConversation } from '$lib/types';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userEvent } from 'vitest/browser';

const CONV_ID = 'limit-conv';

function bodyText(): string {
	return document.body.textContent ?? '';
}

function findButton(label: string): HTMLButtonElement | null {
	return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
		(button) => button.textContent?.trim() === label
	) ?? null;
}

function makeConversation(id: string): DatabaseConversation {
	return {
		currNode: 'node-1',
		id,
		lastModified: 1000,
		name: 'conversation'
	} as DatabaseConversation;
}

/**
 * The notice setter is an internal gate action (the public facade only exposes
 * get/clear, 07 §4.5); reach it through the store's gates instance for setup.
 */
function setNotice(convId: string, at: number): void {
	const gates = (agenticStore as unknown as {
		gates: { setHardLimitNotice: (id: string, at: number) => void };
	}).gates;

	gates.setHardLimitNotice(convId, at);
}

afterEach(() => {
	vi.restoreAllMocks();
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	agenticStore.clearHardLimitNotice(CONV_ID);
	agenticStore.clearHardLimitNotice('other-conv');
	chatStore.activity.localEnded(CONV_ID);
});

describe('ChatMessageActionCardContinueRequest', () => {
	it('shows the turn-limit text by default (reason=turns)', () => {
		const onDecision = vi.fn();
		const { unmount } = render(ChatMessageActionCardContinueRequest, {
			props: { onDecision }
		});

		expect(bodyText()).toContain('Agentic turn limit reached. Continue?');
		expect(bodyText()).not.toContain('soft time limit');

		unmount();
	});

	it('shows the soft-time text for reason=softTime (D10)', () => {
		const onDecision = vi.fn();
		const { unmount } = render(ChatMessageActionCardContinueRequest, {
			props: { onDecision, reason: 'softTime' }
		});

		expect(bodyText()).toContain('Agentic soft time limit reached. Continue?');
		expect(bodyText()).not.toContain('turn limit');

		unmount();
	});

	it('Continue resolves true and Stop resolves false', async () => {
		const onDecision = vi.fn();
		const { unmount } = render(ChatMessageActionCardContinueRequest, {
			props: { onDecision, reason: 'softTime' }
		});

		await userEvent.click(findButton('Continue')!);
		expect(onDecision).toHaveBeenLastCalledWith(true);

		await userEvent.click(findButton('Stop')!);
		expect(onDecision).toHaveBeenLastCalledWith(false);

		unmount();
	});
});

describe('ChatMessageAgenticLimitNotice', () => {
	it('renders nothing when the active conversation has no notice', async () => {
		conversationsStore.activeConversation = makeConversation(CONV_ID);
		const { unmount } = render(ChatMessageAgenticLimitNotice);

		await tick();

		expect(bodyText()).not.toContain('Agentic hard time limit reached.');

		unmount();
	});

	it('renders the row when the active conversation carries a notice', async () => {
		conversationsStore.activeConversation = makeConversation(CONV_ID);
		setNotice(CONV_ID, 1234567890);
		const { unmount } = render(ChatMessageAgenticLimitNotice);

		await tick();

		expect(bodyText()).toContain('Agentic hard time limit reached.');
		expect(findButton('Resume')).not.toBeNull();
		expect(findButton('Dismiss')).not.toBeNull();

		unmount();
	});

	it('is scoped to the active conversation (a notice on another conv is not shown)', async () => {
		conversationsStore.activeConversation = makeConversation(CONV_ID);
		setNotice('other-conv', 1234567890);
		const { unmount } = render(ChatMessageAgenticLimitNotice);

		await tick();

		expect(bodyText()).not.toContain('Agentic hard time limit reached.');

		unmount();
	});

	it('Dismiss clears the notice and hides the row', async () => {
		conversationsStore.activeConversation = makeConversation(CONV_ID);
		setNotice(CONV_ID, 1234567890);
		const { unmount } = render(ChatMessageAgenticLimitNotice);

		await tick();
		expect(findButton('Dismiss')).not.toBeNull();

		await userEvent.click(findButton('Dismiss')!);
		await tick();

		expect(agenticStore.getHardLimitNotice(CONV_ID)).toBeNull();
		expect(bodyText()).not.toContain('Agentic hard time limit reached.');

		unmount();
	});

	it('Resume calls resumeAgenticFlowFromTail', async () => {
		conversationsStore.activeConversation = makeConversation(CONV_ID);
		setNotice(CONV_ID, 1234567890);
		const resumeSpy = vi.spyOn(chatStore, 'resumeAgenticFlowFromTail').mockResolvedValue(undefined);
		const { unmount } = render(ChatMessageAgenticLimitNotice);

		await tick();
		expect(findButton('Resume')).not.toBeNull();

		await userEvent.click(findButton('Resume')!);

		expect(resumeSpy).toHaveBeenCalledTimes(1);

		unmount();
	});

	it('disables Resume while the active conversation is loading', async () => {
		conversationsStore.activeConversation = makeConversation(CONV_ID);
		setNotice(CONV_ID, 1234567890);
		chatStore.activity.markLocal(CONV_ID);
		const { unmount } = render(ChatMessageAgenticLimitNotice);

		await tick();

		const resume = findButton('Resume');

		expect(resume).not.toBeNull();
		expect(resume?.disabled).toBe(true);
		expect(findButton('Dismiss')?.disabled).toBe(false);

		unmount();
	});
});
