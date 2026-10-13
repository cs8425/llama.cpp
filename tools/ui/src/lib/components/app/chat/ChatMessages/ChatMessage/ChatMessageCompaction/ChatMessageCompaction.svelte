<script lang="ts">
	import { RefreshCw } from '@lucide/svelte';
	import { MessageRole } from '$lib/enums';
	import { estimateTokens, SUMMARY_CONTENT_PREFIX } from '$lib/services/context';
	import { conversationsStore } from '$lib/stores';
	import type { DatabaseMessage } from '$lib/types';
	import { formatNumber, formatTime } from '$lib/utils/formatters';

	interface Props {
		class?: string;
		message: DatabaseMessage;
	}

	let { class: className = '', message }: Props = $props();

	// Collapsed by default; expanding is purely local state (Phase 1 has no
	// store-backed actions on the entry yet).
	let expanded = $state(false);

	let meta = $derived(message.compactionMeta);

	// The stored content carries the fixed summary prefix (added at node
	// creation); strip it so the body reads as the plain summary text.
	let summaryText = $derived(
		message.content.startsWith(SUMMARY_CONTENT_PREFIX)
			? message.content.slice(SUMMARY_CONTENT_PREFIX.length).trim()
			: message.content
	);

	let timestampLabel = $derived.by(() => {
		const date = new Date(message.timestamp);

		return `${date.toLocaleDateString()} ${formatTime(date)}`;
	});

	// Current size of the entry itself, from the same estimator the policy uses.
	let summaryTokens = $derived(estimateTokens(message));

	// The kept-region start the entry claims, resolved against the active path.
	// -1 = the boundary message no longer exists (the builder then fails open
	// to a full send); the row surfaces that instead of a stale preview.
	let keptMessageIndex = $derived(
		meta?.firstKeptMessageId ? conversationsStore.findMessageIndex(meta.firstKeptMessageId) : -1
	);
	let keptMessage = $derived(
		keptMessageIndex >= 0 ? conversationsStore.activeMessages[keptMessageIndex] : null
	);

	function toggleExpanded() {
		expanded = !expanded;
	}

	function keptPreview(message: DatabaseMessage): string {
		if (message.role === MessageRole.ASSISTANT && message.toolCalls) {
			const names = toolCallNames(message.toolCalls);

			if (names.length > 0) return `assistant: tool_calls ${names.join(', ')}`;
		}

		const text = message.content.trim().replace(/\s+/g, ' ');

		if (!text) return `${message.role}: (empty)`;

		const preview = text.length > 48 ? `${text.slice(0, 48)}…` : text;

		return `${message.role}: “${preview}”`;
	}

	function toolCallNames(toolCallsJson: string): string[] {
		try {
			const parsed: unknown = JSON.parse(toolCallsJson);

			if (!Array.isArray(parsed)) return [];

			return parsed
				.map((call) => {
					const fn = (call as { function?: { name?: unknown } })?.function;

					return typeof fn?.name === 'string' ? fn.name : undefined;
				})
				.filter((name): name is string => name !== undefined);
		} catch {
			return [];
		}
	}
</script>

<div class="{className}">
	<div
		class="border-border/60 bg-muted/30 mx-auto w-full max-w-xl rounded-md border text-xs"
		role="status"
	>
		<div class="text-muted-foreground flex items-center gap-2 px-3 pt-2">
			<RefreshCw class="text-muted-foreground/60 h-3.5 w-3.5 shrink-0" />

			<span class="text-foreground/80 font-medium">
				Context compacted{meta?.isSplitTurn ? ' (mid-turn)' : ''}
			</span>

			<span class="text-muted-foreground/80">· {timestampLabel}</span>

			<button
				class="text-foreground/70 hover:bg-muted hover:text-foreground ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium"
				aria-expanded={expanded}
				onclick={toggleExpanded}
			>
				{expanded ? 'Hide summary' : 'Show summary'}
			</button>
		</div>

		<div class="text-muted-foreground px-3 pb-2">
			Summarized {formatNumber(meta?.summarizedCount ?? 0)} messages
			{#if meta?.estimatedTokensBefore !== undefined}
				(~{formatNumber(meta.estimatedTokensBefore)} → ~{formatNumber(summaryTokens)} tokens)
			{/if}
		</div>

		{#if expanded}
			<div class="border-border/60 flex flex-col gap-2 border-t px-3 py-2">
				<pre
					class="text-foreground/80 max-h-64 overflow-auto font-mono text-xs break-words whitespace-pre-wrap">{summaryText}</pre>

				<div class="text-muted-foreground flex flex-col gap-1">
					{#if keptMessage}
						<span>Kept from: #{keptMessageIndex + 1} ({keptPreview(keptMessage)})</span>
					{:else}
						<span class="text-amber-400">
							Kept from: unknown — the boundary message no longer exists, so the full
							context is sent
						</span>
					{/if}

					{#if meta?.isSplitTurn}
						<span>This turn's user request is included in the summary.</span>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>
