<script lang="ts">
	import ChatMessageActionCard from './ChatMessageActionCard.svelte';
	import { RotateCw } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import type { AgenticContinueReason } from '$lib/stores/agentic/gates.svelte';

	interface Props {
		onDecision: (shouldContinue: boolean) => void;
		/** Why the loop paused (07 D3/D5): `turns` or `softTime`. */
		reason?: AgenticContinueReason;
	}

	let { onDecision, reason = 'turns' }: Props = $props();

	// D10: the soft-time card uses distinct wording; the turn card keeps the
	// original text.
	const title = $derived(
		reason === 'softTime'
			? 'Agentic soft time limit reached. Continue?'
			: 'Agentic turn limit reached. Continue?'
	);
</script>

<ChatMessageActionCard icon={RotateCw}>
	{#snippet message()}
		{title}
	{/snippet}

	{#snippet actions()}
		<Button onclick={() => onDecision(true)} size="sm">Continue</Button>

		<Button
			class="text-destructive hover:text-destructive"
			onclick={() => onDecision(false)}
			size="sm"
			variant="destructive"
		>
			Stop
		</Button>
	{/snippet}
</ChatMessageActionCard>
