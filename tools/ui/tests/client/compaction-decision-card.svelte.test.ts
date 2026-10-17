// Pins the shared over-target compaction gate (dual-mode, 02-data-model §6):
// the card shows the post-compaction size against the mode target and the
// attempts already made, and its three buttons resolve the gate (use /
// retry / skip). The store gate layer is pinned too: request → pending state
// → resolve, and an aborted signal (flow stop / stop-compaction controller)
// resolves as skip — fail-open, no entry is created.
//
// Run: npx vitest --project=client --run tests/client/compaction-decision-card.svelte.test.ts

import ChatCompactionDecisionCard from '$lib/components/app/chat/ChatMessages/ChatMessageActions/ChatMessageActionCard/ChatCompactionDecisionCard.svelte';
import { agenticStore } from '$lib/stores/agentic/index.svelte';
import type { CompactionDecisionRequest } from '$lib/stores/agentic/gates.svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

function makeRequest(overrides: Partial<CompactionDecisionRequest> = {}): CompactionDecisionRequest {
	return {
		attempts: 3,
		convId: 'card-conv',
		mode: 'recent-window',
		postSize: 12345,
		target: 8000,
		...overrides
	};
}

function bodyText(): string {
	return document.body.textContent ?? '';
}

function findButton(label: string): HTMLButtonElement | null {
	return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
		(button) => button.textContent?.trim() === label
	) ?? null;
}

describe('ChatCompactionDecisionCard', () => {
	it('shows the post size against the window target, the attempts and the three actions', () => {
		const onDecision = vi.fn();
		const { unmount } = render(ChatCompactionDecisionCard, {
			props: { onDecision, request: makeRequest() }
		});

		expect(bodyText()).toContain('Context compaction exceeded the window target');
		expect(bodyText()).toContain('~12,345 of ~8,000 allowed');
		expect(bodyText()).toContain('(after 3 attempts)');
		expect(bodyText()).toContain('Keep it?');
		expect(findButton('Use this summary')).not.toBeNull();
		expect(findButton('Re-compact')).not.toBeNull();
		expect(findButton('Skip')).not.toBeNull();

		unmount();
	});

	it('uses the keep-target label in threshold-target mode', () => {
		const onDecision = vi.fn();
		const { unmount } = render(ChatCompactionDecisionCard, {
			props: { onDecision, request: makeRequest({ mode: 'threshold-target' }) }
		});

		expect(bodyText()).toContain('keep target');
		expect(bodyText()).not.toContain('window target');

		unmount();
	});

	it('omits the attempts note on the first attempt', () => {
		const onDecision = vi.fn();
		const { unmount } = render(ChatCompactionDecisionCard, {
			props: { onDecision, request: makeRequest({ attempts: 1 }) }
		});

		expect(bodyText()).not.toContain('attempts');
		expect(bodyText()).toContain('allowed. Keep it?');

		unmount();
	});

	it('Use this summary resolves the gate with use', async () => {
		const onDecision = vi.fn();
		const { unmount } = render(ChatCompactionDecisionCard, {
			props: { onDecision, request: makeRequest() }
		});

		await userEvent.click(findButton('Use this summary')!);

		expect(onDecision).toHaveBeenCalledWith('use');
		expect(onDecision).toHaveBeenCalledTimes(1);

		unmount();
	});

	it('Re-compact resolves the gate with retry', async () => {
		const onDecision = vi.fn();
		const { unmount } = render(ChatCompactionDecisionCard, {
			props: { onDecision, request: makeRequest() }
		});

		await userEvent.click(findButton('Re-compact')!);

		expect(onDecision).toHaveBeenCalledWith('retry');

		unmount();
	});

	it('Skip resolves the gate with skip', async () => {
		const onDecision = vi.fn();
		const { unmount } = render(ChatCompactionDecisionCard, {
			props: { onDecision, request: makeRequest() }
		});

		await userEvent.click(findButton('Skip')!);

		expect(onDecision).toHaveBeenCalledWith('skip');

		unmount();
	});
});

describe('agenticStore compaction-decision gate', () => {
	afterEach(() => {
		// clear any leftover pending state (a no-op when nothing is pending)
		agenticStore.resolveCompactionDecision('card-conv', 'skip');
	});

	it('request → pending state → resolve(use) → promise resolves and the state clears', async () => {
		const request = makeRequest();
		const promise = agenticStore.requestCompactionDecision(request);

		expect(agenticStore.getPendingCompactionDecision('card-conv')).toEqual(request);

		agenticStore.resolveCompactionDecision('card-conv', 'use');

		await expect(promise).resolves.toBe('use');
		expect(agenticStore.getPendingCompactionDecision('card-conv')).toBeNull();
	});

	it('resolves as skip when the signal aborts while the gate is open', async () => {
		const controller = new AbortController();
		const promise = agenticStore.requestCompactionDecision(makeRequest(), controller.signal);

		controller.abort();

		await expect(promise).resolves.toBe('skip');
		expect(agenticStore.getPendingCompactionDecision('card-conv')).toBeNull();
	});

	it('resolves as skip immediately for an already-aborted signal', async () => {
		const controller = new AbortController();
		controller.abort();
		const promise = agenticStore.requestCompactionDecision(makeRequest(), controller.signal);

		await expect(promise).resolves.toBe('skip');
		expect(agenticStore.getPendingCompactionDecision('card-conv')).toBeNull();
	});
});
