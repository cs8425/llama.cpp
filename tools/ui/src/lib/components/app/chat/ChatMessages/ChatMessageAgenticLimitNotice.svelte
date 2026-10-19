<script lang="ts">
	import { AlertTriangle, Play, X } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { agenticStore, chatStore, conversationsStore } from '$lib/stores';

	interface Props {
		class?: string;
	}

	let { class: className = '' }: Props = $props();

	// Shown only while the ACTIVE conversation carries a hard-limit notice
	// (07 D8). The notice persists across renders (no toast) until the user
	// resumes the flow or dismisses the row.
	let notice = $derived.by(() => {
		const conv = conversationsStore.activeConversation;

		if (!conv) return null;

		return agenticStore.getHardLimitNotice(conv.id);
	});

	// Resume: continue the loop from the active path tail with a fresh turn
	// counter and time budget (07 §4.6 / D9).
	function handleResume() {
		void chatStore.resumeAgenticFlowFromTail();
	}

	// Dismiss: drop the notice row without resuming (07 D8).
	function handleDismiss() {
		const conv = conversationsStore.activeConversation;

		if (conv) agenticStore.clearHardLimitNotice(conv.id);
	}
</script>

{#if notice}
	<div class="{className}">
		<div
			aria-live="polite"
			class="border-border/60 bg-muted/30 mx-auto w-full max-w-xl rounded-md border px-3 py-2 text-xs"
			role="status"
		>
			<div class="text-muted-foreground flex items-center gap-2">
				<AlertTriangle class="text-muted-foreground/60 h-3.5 w-3.5 shrink-0" />

				<span class="text-foreground/80 font-medium">Agentic hard time limit reached.</span>

				<div class="ml-auto flex shrink-0 items-center gap-1">
					<Button class="h-7 gap-1 px-2 text-xs" onclick={handleResume} variant="default">
						<Play class="h-3.5 w-3.5" />

						Resume
					</Button>

					<Button class="h-7 gap-1 px-2 text-xs" onclick={handleDismiss} variant="ghost">
						<X class="h-3.5 w-3.5" />

						Dismiss
					</Button>
				</div>
			</div>
		</div>
	</div>
{/if}
