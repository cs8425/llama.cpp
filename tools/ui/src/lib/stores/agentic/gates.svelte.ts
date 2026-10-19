/**
 * AgenticGates - User interaction gates for the agentic loop
 *
 * Owns the state the loop waits on between turns: tool permission requests,
 * turn-limit continue prompts and queued steering messages. The loop awaits
 * requestPermission/requestContinue; the UI resolves them through
 * resolvePermission/resolveContinue. Owned by agenticStore, no host coupling.
 */

import { ToolPermissionDecision } from '$lib/enums';
// direct imports between stores, not via the barrel, to avoid circular deps
import type { CompactionDecision, CompactionMode } from '$lib/services/context';
import { permissionsStore } from '$lib/stores/permissions.svelte';
import { toolsStore } from '$lib/stores/tools.svelte';
import type { DatabaseMessageExtra, SteeringMessage } from '$lib/types';
import { SvelteMap } from 'svelte/reactivity';

/**
 * Reason an agentic loop is pausing for a “continue?” decision (07 D3/D5):
 * `turns` = the turn-count limit, `softTime` = the soft wall-time limit.
 */
export type AgenticContinueReason = 'turns' | 'softTime';

/**
 * The pending over-target compaction request (both modes; the shared gate,
 * 02-data-model §6). The card displays `postSize` vs `target` and the
 * attempts already made; the loop awaits the decision.
 */
export interface CompactionDecisionRequest {
	convId: string;
	/** The active mode (selects the card's target wording). */
	mode: CompactionMode;
	/** The post-compaction size the mode checks (A: head + summary + kept; B: head + summary). */
	postSize: number;
	/** The mode target (A: window − keep; B: keepTarget% × n_ctx). */
	target: number;
	/** Summary attempts already made (the card shows them). */
	attempts: number;
}

export class AgenticGates {
	/** Resolve functions for pending continue Promises; nothing derives from this map */
	private continueResolvers = new SvelteMap<string, (shouldContinue: boolean) => void>();
	/**
	 * Dedicated reactive state for pending continue requests. The value is the
	 * reason the loop paused (`turns` | `softTime`), or `null` when none is
	 * pending (07 D3/D5).
	 */
	private pendingContinueRequests = new SvelteMap<string, AgenticContinueReason | null>();

	/** Resolve functions for pending compaction-decision Promises; nothing derives from this map */
	private compactionDecisionResolvers = new SvelteMap<
		string,
		(decision: CompactionDecision) => void
	>();
	/** Dedicated reactive state for pending over-target compaction requests */
	private pendingCompactionDecisions = new SvelteMap<string, CompactionDecisionRequest | null>();

	/** Dedicated reactive state for pending permission requests (ensures immediate UI updates) */
	private pendingPermissions = new SvelteMap<
		string,
		{ toolName: string; serverLabel: string } | null
	>();
	/** Resolve functions for pending permission Promises; nothing derives from this map */
	private permissionResolvers = new SvelteMap<string, (decision: ToolPermissionDecision) => void>();

	/** Reactive: queued steering messages to inject between turns */
	private steeringMessages = new SvelteMap<string, SteeringMessage>();

	/**
	 * In-chat persistent notice set when a hard time limit stops the flow
	 * (07 D8). `{ at }` is the `Date.now()` timestamp when the limit fired; the
	 * UI renders the Resume/Dismiss row while this is non-null.
	 */
	private hardLimitNotices = new SvelteMap<string, { at: number } | null>();

	/**
	 * Drop all pending gate state for a conversation, e.g. when a flow exits.
	 */
	clear(conversationId: string): void {
		this.pendingPermissions.set(conversationId, null);
		this.permissionResolvers.delete(conversationId);
		this.pendingContinueRequests.set(conversationId, null);
		this.continueResolvers.delete(conversationId);
		this.pendingCompactionDecisions.set(conversationId, null);
		this.compactionDecisionResolvers.delete(conversationId);
		this.steeringMessages.delete(conversationId);
		this.hardLimitNotices.set(conversationId, null);
	}

	/**
	 * Clear the pending steering message without consuming it.
	 */
	clearSteeringMessage(conversationId: string): void {
		this.steeringMessages.delete(conversationId);
	}

	/**
	 * Consume and return the pending steering message for re-sending.
	 * Called by chatStore after the agentic flow exits.
	 */
	consumePendingSteeringMessage(conversationId: string): SteeringMessage | null {
		const msg = this.steeringMessages.get(conversationId);

		if (!msg) return null;

		this.steeringMessages.delete(conversationId);

		return msg;
	}

	getPendingContinueRequest(conversationId: string): AgenticContinueReason | null {
		return this.pendingContinueRequests.get(conversationId) ?? null;
	}

	/** The hard-limit notice for a conversation, or null when none is shown (07 D8). */
	getHardLimitNotice(conversationId: string): { at: number } | null {
		return this.hardLimitNotices.get(conversationId) ?? null;
	}

	/** Set the hard-limit notice (called at the two hard-stop points, 07 §4.3). */
	setHardLimitNotice(conversationId: string, at: number): void {
		this.hardLimitNotices.set(conversationId, { at });
	}

	/** Clear the hard-limit notice (Dismiss / Resume / new flow / deletion). */
	clearHardLimitNotice(conversationId: string): void {
		this.hardLimitNotices.set(conversationId, null);
	}

	/** The pending over-target compaction request (the card's data), or null. */
	getPendingCompactionDecision(conversationId: string): CompactionDecisionRequest | null {
		return this.pendingCompactionDecisions.get(conversationId) ?? null;
	}

	getPendingPermissionRequest(
		conversationId: string
	): { toolName: string; serverLabel: string } | null {
		return this.pendingPermissions.get(conversationId) ?? null;
	}

	getPendingSteeringMessageContent(conversationId: string): string | null {
		return this.steeringMessages.get(conversationId)?.content ?? null;
	}

	getPendingSteeringMessageExtras(conversationId: string): DatabaseMessageExtra[] | undefined {
		return this.steeringMessages.get(conversationId)?.extras;
	}

	hasPendingSteeringMessage(conversationId: string): boolean {
		return this.steeringMessages.has(conversationId);
	}

	/**
	 * Queue a steering message. When the current agentic turn completes,
	 * the flow exits and the caller re-sends the message as a normal chat message.
	 */
	injectSteeringMessage(
		conversationId: string,
		content: string,
		extras?: DatabaseMessageExtra[]
	): void {
		this.steeringMessages.set(conversationId, { content, extras });
	}

	async requestContinue(
		conversationId: string,
		signal?: AbortSignal,
		reason: AgenticContinueReason = 'turns'
	): Promise<boolean> {
		this.pendingContinueRequests.set(conversationId, reason);

		return new Promise<boolean>((resolve) => {
			if (signal?.aborted) {
				this.pendingContinueRequests.set(conversationId, null);
				resolve(false);

				return;
			}

			this.continueResolvers.set(conversationId, (shouldContinue) => {
				this.pendingContinueRequests.set(conversationId, null);
				resolve(shouldContinue);
			});

			signal?.addEventListener(
				'abort',
				() => {
					const resolver = this.continueResolvers.get(conversationId);

					if (resolver) {
						this.continueResolvers.delete(conversationId);
						this.pendingContinueRequests.set(conversationId, null);
						resolve(false);
					}
				},
				{ once: true }
			);
		});
	}

	/**
	 * Ask the user about an over-target compaction result (shared by both
	 * modes, 02-data-model §6). The loop awaits the decision; an aborted
	 * signal (flow stop / the stop-compaction controller) resolves as `skip`
	 * (fail-open, no entry is created).
	 */
	async requestCompactionDecision(
		request: CompactionDecisionRequest,
		signal?: AbortSignal
	): Promise<CompactionDecision> {
		const { convId } = request;

		this.pendingCompactionDecisions.set(convId, request);

		return new Promise<CompactionDecision>((resolve) => {
			if (signal?.aborted) {
				this.pendingCompactionDecisions.set(convId, null);
				resolve('skip');

				return;
			}

			this.compactionDecisionResolvers.set(convId, (decision) => {
				this.pendingCompactionDecisions.set(convId, null);
				resolve(decision);
			});

			signal?.addEventListener(
				'abort',
				() => {
					const resolver = this.compactionDecisionResolvers.get(convId);

					if (resolver) {
						this.compactionDecisionResolvers.delete(convId);
						this.pendingCompactionDecisions.set(convId, null);
						resolve('skip');
					}
				},
				{ once: true }
			);
		});
	}

	async requestPermission(
		conversationId: string,
		toolName: string,
		serverLabel: string,
		signal?: AbortSignal
	): Promise<ToolPermissionDecision> {
		const permissionKey = toolsStore.getPermissionKey(toolName);

		if (permissionKey && permissionsStore.hasTool(permissionKey)) {
			return ToolPermissionDecision.ONCE;
		}

		this.pendingPermissions.set(conversationId, { serverLabel, toolName });

		return new Promise<ToolPermissionDecision>((resolve) => {
			if (signal?.aborted) {
				this.pendingPermissions.set(conversationId, null);
				resolve(ToolPermissionDecision.DENY);

				return;
			}

			this.permissionResolvers.set(conversationId, (decision) => {
				this.pendingPermissions.set(conversationId, null);

				if (decision === ToolPermissionDecision.ALWAYS && permissionKey) {
					permissionsStore.allowTool(permissionKey);
				} else if (decision === ToolPermissionDecision.ALWAYS_SERVER) {
					const serverToolKeys = toolsStore.allTools
						.filter((t) =>
							t.serverName
								? t.serverName === serverLabel
								: toolsStore.getToolServerLabel(t.definition.function.name) === serverLabel
						)
						.map((t) => toolsStore.getPermissionKey(t.definition.function.name)!)
						.filter((k): k is string => k !== null);

					permissionsStore.allowTools(serverToolKeys);
				}

				resolve(decision);
			});

			signal?.addEventListener(
				'abort',
				() => {
					const resolver = this.permissionResolvers.get(conversationId);

					if (resolver) {
						this.permissionResolvers.delete(conversationId);
						this.pendingPermissions.set(conversationId, null);
						resolve(ToolPermissionDecision.DENY);
					}
				},
				{ once: true }
			);
		});
	}

	resolveContinue(conversationId: string, shouldContinue: boolean): void {
		const resolver = this.continueResolvers.get(conversationId);

		if (resolver) {
			this.continueResolvers.delete(conversationId);
			resolver(shouldContinue);
		}
	}

	resolveCompactionDecision(conversationId: string, decision: CompactionDecision): void {
		const resolver = this.compactionDecisionResolvers.get(conversationId);

		if (resolver) {
			this.compactionDecisionResolvers.delete(conversationId);
			resolver(decision);
		}
	}

	resolvePermission(conversationId: string, decision: ToolPermissionDecision): void {
		const resolver = this.permissionResolvers.get(conversationId);

		if (resolver) {
			this.permissionResolvers.delete(conversationId);
			resolver(decision);
		}
	}
}
