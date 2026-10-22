<script lang="ts">
	import { Check, Pencil, RefreshCw, Square, UnfoldVertical } from '@lucide/svelte';
	import DialogConfirmation from '$lib/components/app/dialogs/DialogConfirmation.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { MessageRole } from '$lib/enums';
	import {
		deriveRealMessageTokens,
		messageBytes,
		messageSize,
		SUMMARY_CONTENT_PREFIX,
		tailStartOf
	} from '$lib/services/context';
	import { chatStore, contextStatsStore, conversationsStore } from '$lib/stores';
	import type { DatabaseMessage } from '$lib/types';
	import { formatNumber, formatTime } from '$lib/utils/formatters';

	interface Props {
		class?: string;
		message: DatabaseMessage;
	}

	let { class: className = '', message }: Props = $props();

	// Collapsed by default; expanding is local state. The expanded region also
	// carries the manual-intervention actions (P2.5), all through chatStore.
	let expanded = $state(false);
	let draftSummary = $state('');
	let editingSummary = $state(false);
	let showExpandConfirm = $state(false);

	let meta = $derived(message.compactionMeta);
	let path = $derived(conversationsStore.activeMessages);
	let headLength = $derived(path[0]?.role === MessageRole.SYSTEM ? 1 : 0);
	// N7: the compaction state is per-conversation — a background compaction of
	// another conversation must not flip this entry to its Stop state.
	let compacting = $derived(
		contextStatsStore.compacting && contextStatsStore.compactingConvId === message.convId
	);

	// The store actions are I7-guarded anyway (isChatLoading / compacting);
	// the UI just gives feedback while the context is busy.
	let actionsBlocked = $derived(compacting || chatStore.isLoading);

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

	// v4: real per-message tokens (server timings); the not-yet-sent tail is
	// estimated at bytes/4, the system head counts 0.
	let realTokens = $derived(deriveRealMessageTokens(path));
	let tailStart = $derived(tailStartOf(path));

	// The entry's own size (N13 D3): the stored `summaryTokens` (the summary
	// call's real completion tokens, bytes/4 when the server did not report)
	// — for older entries without the field, the real token count when the
	// server data covers it, else the bytes/4 estimate (the entry is usually
	// the not-yet-sent tail).
	let summaryTokens = $derived.by(() => {
		if (meta?.summaryTokens !== undefined) return meta.summaryTokens;

		const real = realTokens.get(message.id);

		return real ?? Math.round(messageBytes(message) / 4);
	});

	// Absent boundary id = deliberate empty kept (02-§2): the summary covers
	// everything before the entry. (A meta-less entry reads the same — the
	// system never writes one, so it is not distinguished.)
	let emptyKept = $derived(meta?.firstKeptMessageId === undefined);

	// The kept-region start the entry claims, resolved against the active path.
	// -1 = the boundary message no longer exists (the builder then fails open
	// to a full send); the row surfaces that instead of a stale preview.
	let keptMessageIndex = $derived(
		meta?.firstKeptMessageId ? conversationsStore.findMessageIndex(meta.firstKeptMessageId) : -1
	);
	let keptMessage = $derived(
		keptMessageIndex >= 0 ? conversationsStore.activeMessages[keptMessageIndex] : null
	);

	// Same validity rule as the builder's boundaryValid (I1/I3): an absent id
	// is a valid empty kept; a present id must exist on the path and must not
	// point at the system-prompt head.
	let boundaryValid = $derived(
		emptyKept || (keptMessageIndex !== -1 && !(headLength > 0 && keptMessageIndex === 0))
	);

	// What expand grows the context back to: the full path, and what the
	// summary currently covers on it (the entry itself is the summary, not
	// covered content — excluded). Display only, real tokens (v4).
	let fullPathTokens = $derived.by(
		() => path.reduce((sum, msg, i) => sum + messageSize(msg, realTokens, i >= tailStart), 0)
	);

	// Exclusive end of the covered region: the boundary when present, the end
	// of the path for an empty-kept entry, nothing when the boundary is lost
	// (the builder fail-opens to a full send, so nothing is covered).
	let droppedEnd = $derived.by(() => {
		if (emptyKept) return path.length;

		return keptMessageIndex > headLength ? keptMessageIndex : 0;
	});
	let droppedCount = $derived.by(() => {
		if (droppedEnd === 0) return 0;

		return path.slice(headLength, droppedEnd).filter((msg) => msg.id !== message.id).length;
	});
	let droppedTokens = $derived.by(() => {
		if (droppedEnd === 0) return 0;

		return path
			.slice(headLength, droppedEnd)
			.reduce(
				(sum, msg, i) =>
					msg.id === message.id ? sum : sum + messageSize(msg, realTokens, headLength + i >= tailStart),
				0
			);
	});

	let expandDescription = $derived.by(() => {
		if (boundaryValid) {
			return `The summary is deleted and the ${droppedCount} compacted messages are restored. The estimated context grows from ~${formatNumber(
				fullPathTokens - droppedTokens
			)} back to ~${formatNumber(fullPathTokens)} tokens.`;
		}

		return 'The summary no longer matches this path (the full context is already being sent). Removing it restores the compacted messages as regular entries.';
	});

	function toggleExpanded() {
		expanded = !expanded;
	}

	function startEditingSummary() {
		draftSummary = summaryText;
		editingSummary = true;
	}

	function cancelEditingSummary() {
		draftSummary = '';
		editingSummary = false;
	}

	async function saveSummary() {
		const text = draftSummary;

		draftSummary = '';
		editingSummary = false;

		if (!text.trim()) return;

		await chatStore.updateCompactionSummary(message.convId, message.id, text);
	}

	async function handleRecompact() {
		await chatStore.recompactConversationEntry(message.convId, message.id);
	}

	// N3: aborts the in-flight summary call (store fails open — no cmp node);
	// compacting resets in the store's finally, which flips the row back to the
	// normal action buttons.
	function handleStopCompaction() {
		chatStore.stopCompaction();
	}

	function requestExpand() {
		showExpandConfirm = true;
	}

	async function handleExpandConfirmed() {
		showExpandConfirm = false;

		await chatStore.expandCompactionEntry(message.convId, message.id);
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
				{#if editingSummary}
					<div class="flex flex-col gap-2">
						<Textarea bind:value={draftSummary} class="min-h-24 font-mono text-xs" />

						<div class="flex gap-2">
							<Button
								class="h-7 gap-1 px-2 text-xs"
								disabled={actionsBlocked || !draftSummary.trim()}
								onclick={saveSummary}
							>
								<Check class="h-3.5 w-3.5" />

								Save
							</Button>

							<Button class="h-7 px-2 text-xs" variant="outline" onclick={cancelEditingSummary}>
								Cancel
							</Button>
						</div>
					</div>
				{:else}
					<pre
						class="text-foreground/80 max-h-64 overflow-auto font-mono text-xs break-words whitespace-pre-wrap">{summaryText}</pre
					>
				{/if}

				<div class="text-muted-foreground flex flex-col gap-1">
					{#if emptyKept}
						<span>Kept from: none — every message is covered by the summary</span>
					{:else if keptMessage}
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

				<div class="flex flex-wrap gap-2 border-t border-border/50 pt-2">
					{#if compacting}
						<Button class="h-7 gap-1 px-2 text-xs" onclick={handleStopCompaction} variant="destructive">
							<Square class="h-3.5 w-3.5" />

							Stop
						</Button>
					{:else}
						<Button
							class="h-7 gap-1 px-2 text-xs"
							disabled={actionsBlocked}
							onclick={startEditingSummary}
							variant="outline"
						>
							<Pencil class="h-3.5 w-3.5" />

							Edit
						</Button>

						<Button
							class="h-7 gap-1 px-2 text-xs"
							disabled={actionsBlocked || !boundaryValid}
							onclick={handleRecompact}
							variant="outline"
						>
							<RefreshCw class="h-3.5 w-3.5" />

							Re-summarize
						</Button>

						<Button
							class="h-7 gap-1 px-2 text-xs"
							disabled={actionsBlocked}
							onclick={requestExpand}
							variant="outline"
						>
							<UnfoldVertical class="h-3.5 w-3.5" />

							Restore all context
						</Button>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	<DialogConfirmation
		bind:open={showExpandConfirm}
		confirmText="Restore"
		description={expandDescription}
		onConfirm={handleExpandConfirmed}
		onCancel={() => (showExpandConfirm = false)}
		title="Restore the full context?"
	/>
</div>
