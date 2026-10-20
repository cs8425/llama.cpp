/**
 * Tests for the AgenticGates state that backs the loop-limit behavior
 * (context-enhance/07 D3/D5/D8): the hard-limit notice row and the
 * turn/soft-time "continue?" reason.
 *
 * `toolsStore` / `permissionsStore` are mocked so importing the gates module
 * does not pull in the full store dependency graph.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/permissions.svelte', () => ({
	permissionsStore: {
		allowTool: vi.fn(),
		allowTools: vi.fn(),
		hasTool: vi.fn().mockReturnValue(false)
	}
}));

vi.mock('$lib/stores/tools.svelte', () => ({
	toolsStore: {
		allTools: [],
		getPermissionKey: vi.fn().mockReturnValue(null),
		getToolServerLabel: vi.fn().mockReturnValue('')
	}
}));

import { AgenticGates } from '$lib/stores/agentic/gates.svelte';

describe('AgenticGates hard-limit notice (07 D8)', () => {
	let gates: AgenticGates;

	beforeEach(() => {
		gates = new AgenticGates();
	});

	it('has no notice by default', () => {
		expect(gates.getHardLimitNotice('conv-1')).toBeNull();
	});

	it('stores and returns the timestamp set by setHardLimitNotice', () => {
		gates.setHardLimitNotice('conv-1', 1234567890);

		expect(gates.getHardLimitNotice('conv-1')).toEqual({ at: 1234567890 });
	});

	it('is scoped per conversation', () => {
		gates.setHardLimitNotice('conv-1', 100);
		gates.setHardLimitNotice('conv-2', 200);

		expect(gates.getHardLimitNotice('conv-1')).toEqual({ at: 100 });
		expect(gates.getHardLimitNotice('conv-2')).toEqual({ at: 200 });
	});

	it('clears the notice via clearHardLimitNotice', () => {
		gates.setHardLimitNotice('conv-1', 100);

		gates.clearHardLimitNotice('conv-1');

		expect(gates.getHardLimitNotice('conv-1')).toBeNull();
	});

	it('drops the notice when the whole gate state is cleared', () => {
		gates.setHardLimitNotice('conv-1', 100);

		gates.clear('conv-1');

		expect(gates.getHardLimitNotice('conv-1')).toBeNull();
	});
});

describe('AgenticGates continue reason (07 D3/D5)', () => {
	let gates: AgenticGates;

	beforeEach(() => {
		gates = new AgenticGates();
	});

	it('exposes the pending reason while a continue request is outstanding', async () => {
		const pending = gates.requestContinue('conv-1', undefined, 'softTime');

		expect(gates.getPendingContinueRequest('conv-1')).toBe('softTime');

		gates.resolveContinue('conv-1', true);
		await expect(pending).resolves.toBe(true);
	});

	it('defaults the reason to "turns"', async () => {
		const pending = gates.requestContinue('conv-1');

		expect(gates.getPendingContinueRequest('conv-1')).toBe('turns');

		gates.resolveContinue('conv-1', false);
		await expect(pending).resolves.toBe(false);
	});

	it('clears the pending request once resolved', async () => {
		const pending = gates.requestContinue('conv-1', undefined, 'turns');

		gates.resolveContinue('conv-1', true);
		await expect(pending).resolves.toBe(true);

		expect(gates.getPendingContinueRequest('conv-1')).toBeNull();
	});

	it('resolves false and clears the request when the signal is aborted', async () => {
		const controller = new AbortController();
		const pending = gates.requestContinue('conv-1', controller.signal, 'softTime');

		controller.abort();
		await expect(pending).resolves.toBe(false);

		expect(gates.getPendingContinueRequest('conv-1')).toBeNull();
	});

	it('resolves false immediately when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const pending = gates.requestContinue('conv-1', controller.signal, 'turns');

		await expect(pending).resolves.toBe(false);
		expect(gates.getPendingContinueRequest('conv-1')).toBeNull();
	});
});
