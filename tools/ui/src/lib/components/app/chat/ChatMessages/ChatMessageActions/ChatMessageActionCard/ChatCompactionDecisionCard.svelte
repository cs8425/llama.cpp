<script lang="ts">
	import { Scale } from '@lucide/svelte';
	import { ChatMessageActionCard } from '$lib/components/app';
	import { Button } from '$lib/components/ui/button';
	import type { CompactionDecision } from '$lib/services/context';
	import type { CompactionDecisionRequest } from '$lib/stores/agentic/gates.svelte';
	import { formatNumber } from '$lib/utils/formatters';

	interface Props {
		request: CompactionDecisionRequest;
		onDecision: (decision: CompactionDecision) => void;
	}

	let { onDecision, request }: Props = $props();

	const targetLabel = $derived(
		request.mode === 'recent-window' ? 'window target' : 'keep target'
	);
</script>

<ChatMessageActionCard icon={Scale}>
	{#snippet message()}
		Context compaction exceeded the {targetLabel}: ~{formatNumber(request.postSize)} of
		~{formatNumber(request.target)} allowed
		{#if request.attempts > 1}
			(after {request.attempts} attempts)
		{/if}. Keep it?
	{/snippet}

	{#snippet actions()}
		<Button onclick={() => onDecision('use')} size="sm">Use this summary</Button>

		<Button onclick={() => onDecision('retry')} size="sm" variant="secondary">
			Re-compact
		</Button>

		<Button
			class="text-destructive hover:text-destructive"
			onclick={() => onDecision('skip')}
			size="sm"
			variant="destructive"
		>
			Skip
		</Button>
	{/snippet}
</ChatMessageActionCard>
