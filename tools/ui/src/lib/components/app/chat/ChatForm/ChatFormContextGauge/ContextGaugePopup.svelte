<script lang="ts">
	import { colorLevelBgClass, colorLevelTextClass } from './context-gauge';
	import ContextGaugeDetails from './ContextGaugeDetails.svelte';
	import ContextGaugeLoadModel from './ContextGaugeLoadModel.svelte';
	import {
		gaugeCardEnter,
		gaugeCardLeave,
		gaugePopup,
		gaugePopupClose
	} from './gauge-popup.svelte';
	import * as Drawer from '$lib/components/ui/drawer';
	import { useContextGauge } from '$lib/hooks/use-context-gauge.svelte';
	import { chatStore, deviceStore } from '$lib/stores';
	import { formatParameters } from '$lib/utils/formatters';

	const gauge = useContextGauge();

	// The gauge hook wraps a processing state instance that only follows the
	// live stream while its own monitoring flag is set, so the card instance
	// starts monitoring like the dial does.
	$effect(() => {
		gauge.startMonitoring();
	});

	let cardEl = $state<HTMLElement | null>(null);

	// Any press outside the card and outside the dial closes the card.
	// Presses on the dial are excluded because the dial handles its own
	// toggle; the listener only exists while the card is open. A phone shows
	// the panel in a drawer instead, which brings its own dismissal.
	$effect(() => {
		if (!gaugePopup.open || deviceStore.isMobile) return;

		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;

			if (!(target instanceof Node)) return;

			if (cardEl?.contains(target)) return;

			if (target instanceof Element && target.closest('[data-context-gauge-trigger]')) return;

			gaugePopupClose();
		};

		document.addEventListener('pointerdown', onPointerDown, true);

		return () => document.removeEventListener('pointerdown', onPointerDown, true);
	});

	const showProgressBar = $derived(
		gauge.contextTotal !== null &&
			gauge.contextTotal > 0 &&
			(gauge.activeModelId !== null || gauge.isActiveModelLoaded)
	);
</script>

{#snippet usage()}
	<span class="font-mono text-muted-foreground">
		{formatParameters(gauge.contextUsed)}
		/ {gauge.contextTotal !== null ? formatParameters(gauge.contextTotal) : '-'}
	</span>
{/snippet}

{#snippet body()}
	{#if gauge.activeModelId !== null && !gauge.isActiveModelLoaded}
		<ContextGaugeLoadModel
			isLoading={gauge.isActiveModelLoading}
			modelId={gauge.activeModelId}
			onLoad={gauge.loadModel}
		/>
	{:else if showProgressBar}
		<div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
			<div
				class="h-full rounded-full transition-all duration-300 {colorLevelBgClass(
					gauge.colorLevel
				)}"
				style="width: {gauge.contextPercent}%"
			></div>
		</div>

		<div class="flex justify-between text-xs text-muted-foreground max-md:text-[13px]">
			<span>
				<span class={colorLevelTextClass(gauge.colorLevel)}>{gauge.contextPercent}%</span> used
			</span>

			<span>
				{formatParameters(gauge.contextAvailable ?? 0)} remaining
			</span>
		</div>
	{:else}
		<div class="text-xs text-muted-foreground">No context info available</div>
	{/if}

	{#if gauge.hasAnyUsage}
		<ContextGaugeDetails
			averageTokensPerSecond={gauge.averageTokensPerSecond}
			cumulativeCacheTotal={gauge.cumulativeCacheTotal}
			cumulativeOutput={gauge.cumulativeOutput}
			cumulativeRead={gauge.cumulativeRead}
			currentCache={gauge.currentCache}
			currentFresh={gauge.currentFresh}
			currentOutput={gauge.currentOutput}
			currentRead={gauge.currentRead}
			kvTotal={gauge.kvTotal}
			transientDetails={gauge.transientDetails}
		/>
	{/if}

	<!-- Inspector entry (Phase 1: the only one; form action + shortcut land in Phase 2).
		Disabled while the model responds: the dialog shows the NEXT send, and that
		is not defined mid-stream (a pre-send snapshot replaces this in Phase 2). -->
	<div class="border-border/50 border-t pt-2">
		<button
			class="text-foreground/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 text-left text-xs font-medium"
			disabled={chatStore.isLoading}
			onclick={() => (chatStore.showContextInspector = true)}
			title={
				chatStore.isLoading
					? 'Unavailable while the model is responding'
					: 'Show the exact payload sent to the LLM'
			}
		>
			Inspect what the LLM sees →
		</button>
	</div>
{/snippet}

{#if deviceStore.isMobile}
	<Drawer.Root bind:open={gaugePopup.open}>
		<Drawer.Content>
			<Drawer.Header>
				<Drawer.Title>Context</Drawer.Title>

				<Drawer.Description class="sr-only">
					Context window usage of the model the chat runs
				</Drawer.Description>
			</Drawer.Header>

			<div class="flex flex-col gap-2 px-4 pb-4 max-md:gap-3.5">
				{@render usage()}

				{@render body()}
			</div>
		</Drawer.Content>
	</Drawer.Root>
{:else if gaugePopup.open}
	<div
		bind:this={cardEl}
		class="absolute z-50 w-64 -translate-x-1/2 rounded-lg border border-border/50 bg-popover p-3 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10"
		onpointerenter={gaugeCardEnter}
		onpointerleave={gaugeCardLeave}
		role="status"
		style="left: {gaugePopup.centerX}px; bottom: {gaugePopup.bottom}px"
	>
		<div class="flex flex-col gap-2">
			<div class="flex items-center gap-2">
				<span class="font-medium">Context</span>

				<span class="text-muted-foreground">·</span>

				{@render usage()}
			</div>

			{@render body()}
		</div>
	</div>
{/if}
