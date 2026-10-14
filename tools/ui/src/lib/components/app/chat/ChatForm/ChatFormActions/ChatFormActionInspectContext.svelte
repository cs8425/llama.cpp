<script lang="ts">
	import { Eye } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { ICON_CLASS_DEFAULT } from '$lib/constants';
	import { chatStore } from '$lib/stores';

	interface Props {
		disabled?: boolean;
	}

	let { disabled = false }: Props = $props();

	// the dialog shows the NEXT send, which is not defined mid-stream — the
	// same gate as the gauge popup entry
	let blocked = $derived(disabled || chatStore.isLoading);

	let tooltipText = $derived(
		blocked ? 'Unavailable while the model is responding' : 'Inspect what the LLM sees (Shift+Ctrl/⌘+I)'
	);
</script>

<Tooltip.Root>
	<Tooltip.Trigger class="w-full">
		<Button
			class="bg-background h-9 w-9 rounded-full p-0 shadow-sm md:h-8 md:w-8 dark:bg-muted-foreground/15"
			disabled={blocked}
			onclick={() => (chatStore.showContextInspector = true)}
			type="button"
			variant="ghost"
		>
			<span class="sr-only">{tooltipText}</span>

			<Eye class={ICON_CLASS_DEFAULT} />
		</Button>
	</Tooltip.Trigger>

	<Tooltip.Content>
		<p>{tooltipText}</p>
	</Tooltip.Content>
</Tooltip.Root>
