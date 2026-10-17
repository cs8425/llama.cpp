<script lang="ts">
	import { Loader2, Square } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { MessageType } from '$lib/enums';
	import { agenticStore, chatStore, contextStatsStore, conversationsStore } from '$lib/stores';

	interface Props {
		class?: string;
	}

	let { class: className = '' }: Props = $props();

	// N7 (04-ui §4.2): shown only while the ACTIVE conversation owns the
	// in-flight summary (a background compaction of another conversation never
	// shows here), and only until the new cmp row takes over the tail the
	// moment compaction completes. The over-target card's display is handled
	// by the parent (ChatMessages renders this row in the card's else branch).
	let visible = $derived.by(() => {
		const conv = conversationsStore.activeConversation;

		if (!conv) return false;
		if (!contextStatsStore.compacting || contextStatsStore.compactingConvId !== conv.id) return false;

		const messages = conversationsStore.activeMessages;
		const tail = messages[messages.length - 1];

		return !tail || tail.type !== MessageType.COMPACTION;
	});

	// Stop dispatch (04-ui §4.2): in-loop (agentic running) → the flow's own
	// abort (the shared flow signal interrupts the summary, which fails open,
	// and ends the flow); post-flow / manual → the dedicated stop-compaction
	// abort (no cmp, "Compaction stopped" toast).
	function handleStop() {
		const conv = conversationsStore.activeConversation;

		if (conv && agenticStore.isRunning(conv.id)) {
			void chatStore.stopGeneration();
		} else {
			chatStore.stopCompaction();
		}
	}
</script>

{#if visible}
	<div class="{className}">
		<div
			aria-live="polite"
			class="border-border/60 bg-muted/30 mx-auto w-full max-w-xl rounded-md border px-3 py-2 text-xs"
			role="status"
		>
			<div class="text-muted-foreground flex items-center gap-2">
				<Loader2 class="text-muted-foreground/60 h-3.5 w-3.5 shrink-0 animate-spin" />

				<span class="text-foreground/80 font-medium">Compacting context…</span>

				<Button class="ml-auto h-7 gap-1 px-2 text-xs" onclick={handleStop} variant="destructive">
					<Square class="h-3.5 w-3.5" />

					Stop
				</Button>
			</div>
		</div>
	</div>
{/if}
