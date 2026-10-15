<script lang="ts">
	/**
	 * Context Inspector — "what exactly goes to the LLM".
	 *
	 * View over `buildLlmContext(activeMessages)`: the same choke point the
	 * send path uses, so what is shown here is what goes over the wire
	 * (WYSIWYG, context-enhance/03 §2). Payload rows with per-message token
	 * estimates, the compacted-out region, the fail-open boundary warning and
	 * a Copy JSON action, plus the manual-intervention actions
	 * (context-enhance/04 §2.2, P2.4): edit the summary in place, move the
	 * kept-from boundary, compact now, expand (restore) and re-summarize —
	 * all through chatStore.
	 *
	 * Layout: the action controls (the Advanced block — boundary select,
	 * Compact now, Expand, Re-summarize) sit at the top, right below the
	 * context-usage block, so the primary decision (is the context too full,
	 * should I compact) is made next to the number that motivates it. The
	 * payload list is the read-only scroll area; a Back to top button at the
	 * bottom returns the scroll container (Dialog.Content) to the top.
	 *
	 * The payload is rebuilt on open, after every action and whenever the
	 * active path changes while the dialog is open (the store actions mirror
	 * into activeMessages; the refresh tick makes the rebuild explicit).
	 */
	import {
		AlertTriangle,
		ArrowUpToLine,
		Braces,
		Check,
		Copy,
		Loader2,
		Pencil,
		RefreshCw,
		Shrink,
		Square,
		UnfoldVertical
	} from '@lucide/svelte';
	import {
		colorLevelBgClass,
		colorLevelFromPercent,
		colorLevelTextClass
	} from '$lib/components/app/chat/ChatForm/ChatFormContextGauge/context-gauge';
	import DialogConfirmation from '$lib/components/app/dialogs/DialogConfirmation.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Textarea } from '$lib/components/ui/textarea';
	import { ContentPartType, MessageRole } from '$lib/enums';
	import {
		buildLlmContext,
		estimateApiMessageTokens,
		estimateTokens,
		SUMMARY_CONTENT_PREFIX
	} from '$lib/services/context';
	import type { ContextBuildResult } from '$lib/services/context';
	import { chatStore, contextStatsStore, conversationsStore } from '$lib/stores';
	import type { ApiChatMessageContentPart, ApiChatMessageData, DatabaseMessage } from '$lib/types';
	import { formatFileSize, formatNumber } from '$lib/utils/formatters';
	import { toast } from 'svelte-sonner';

	interface Props {
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
	}

	let { onOpenChange, open = $bindable(false) }: Props = $props();

	let building = $state(false);
	let contentEl = $state<HTMLDivElement | null>(null);
	let copied = $state(false);
	let draftSummary = $state('');
	let editingSummary = $state(false);
	let expandedRow = $state<number | null>(null);
	let refreshTick = $state(0);
	let result = $state<ContextBuildResult | null>(null);
	let showExpandConfirm = $state(false);

	let nCtx = $derived(contextStatsStore.contextTotal);
	let modelId = $derived(contextStatsStore.activeModelId);
	let path = $derived(conversationsStore.activeMessages);
	let headLength = $derived(path[0]?.role === MessageRole.SYSTEM ? 1 : 0);
	let convId = $derived(conversationsStore.activeConversation?.id ?? null);
	let compacting = $derived(contextStatsStore.compacting);

	// The store methods are I7-guarded (isChatLoading / isRunning / compacting)
	// anyway; the UI just gives feedback while the context is being modified.
	let actionsBlocked = $derived(compacting || chatStore.isLoading || convId === null);

	let percent = $derived.by(() => {
		if (!result || nCtx === null || nCtx <= 0) return null;

		return Math.min(100, (result.estimatedTokens / nCtx) * 100);
	});
	let colorLevel = $derived(colorLevelFromPercent(percent));

	$effect(() => {
		void refreshTick;

		if (!open) {
			building = false;
			copied = false;
			draftSummary = '';
			editingSummary = false;
			expandedRow = null;
			showExpandConfirm = false;
			result = null;

			return;
		}

		let cancelled = false;
		building = true;

		// On a refresh after an action the previous result stays visible
		// until the new one lands (the rebuild is fast; a blank flash is noise).
		void buildLlmContext(path)
			.then((built) => {
				if (cancelled) return;

				building = false;
				result = built;
			})
			.catch((error) => {
				if (cancelled) return;

				building = false;
				console.error('Failed to build the LLM context:', error);
				toast.error('Failed to build the payload preview');
			});

		return () => {
			cancelled = true;
		};
	});

	interface PayloadRow {
		kind: string;
		message: ApiChatMessageData;
		text: string;
		tokens: number;
	}

	let payloadRows = $derived.by<PayloadRow[]>(() => {
		if (!result) return [];

		// With a valid compaction the summary is the message right after the
		// system-prompt head — that row gets its own badge instead of "user".
		const summaryIndex = result.compaction?.boundaryValid ? headLength : -1;

		return result.messages.map((message, index) => ({
			kind: index === summaryIndex ? 'summary' : message.role,
			message,
			text: apiPreviewText(message),
			tokens: estimateApiMessageTokens(message)
		}));
	});

	interface DroppedRow {
		index: number;
		message: DatabaseMessage;
	}

	let droppedRows = $derived.by<DroppedRow[]>(() => {
		const compaction = result?.compaction;

		if (!compaction?.boundaryValid) return [];

		const boundaryIndex = path.findIndex((message) => message.id === compaction.firstKeptMessageId);

		if (boundaryIndex <= headLength) return [];

		return path
			.slice(headLength, boundaryIndex)
			.map((message, offset) => ({
				index: headLength + offset + 1,
				message
			}))
			// The in-effect compaction entry is the summary itself, not a
			// dropped message — exclude it so the region lists only what
			// the summary covers.
			.filter((row) => row.message.id !== compaction.entryId);
	});

	interface BoundaryOption {
		group: MessageRole;
		id: string;
		label: string;
	}

	// I4: the boundary can only sit before a user or assistant message (never
	// a tool result, never the system head) — the same candidate set the
	// store validates in moveCompactionBoundary.
	let boundaryOptions = $derived.by<BoundaryOption[]>(() => {
		const options: BoundaryOption[] = [];

		path.forEach((message, index) => {
			if (index <= headLength) return;
			if (message.role !== MessageRole.USER && message.role !== MessageRole.ASSISTANT) return;

			options.push({
				group: message.role,
				id: message.id,
				label: boundaryLabel(message, index)
			});
		});

		return options;
	});
	let assistantBoundaryOptions = $derived(
		boundaryOptions.filter((option) => option.group === MessageRole.ASSISTANT)
	);
	let userBoundaryOptions = $derived(
		boundaryOptions.filter((option) => option.group === MessageRole.USER)
	);

	let selectedBoundary = $derived(
		result?.compaction?.boundaryValid ? result.compaction.firstKeptMessageId : ''
	);
	let selectedBoundaryLabel = $derived(
		boundaryOptions.find((option) => option.id === selectedBoundary)?.label ?? 'No valid boundary'
	);

	// Size of the un-compacted path — what the context grows back to on expand.
	let fullPathTokens = $derived(path.reduce((sum, message) => sum + estimateTokens(message), 0));

	let expandDescription = $derived.by(() => {
		const compaction = result?.compaction;

		if (!result || !compaction) return '';

		if (compaction.boundaryValid) {
			return `The summary is deleted and the ${droppedRows.length} compacted messages are restored. The estimated context grows from ~${formatNumber(
				result.estimatedTokens
			)} back to ~${formatNumber(fullPathTokens)} tokens.`;
		}

		return 'The summary no longer matches this path (the full context is already being sent). Removing it restores the compacted messages as regular entries.';
	});

	function handleOpenChange(nextOpen: boolean) {
		open = nextOpen;
		onOpenChange?.(nextOpen);
	}

	// The store actions mirror every change into activeMessages (which the
	// effect above already tracks); the tick makes the re-fetch explicit.
	function refreshPayload() {
		refreshTick++;
	}

	// The controls live at the top of the dialog, so long payload lists push
	// the bottom of the content well below the fold; a single tap returns the
	// scroll container (Dialog.Content) to the top.
	function scrollToTop() {
		contentEl?.scrollTo({ top: 0, behavior: 'smooth' });
	}

	async function handleCompactNow() {
		if (!convId) return;

		editingSummary = false;
		expandedRow = null;

		await chatStore.compactConversation(convId, { auto: false });
		refreshPayload();
	}

	// N3: aborts the in-flight summary call (store fails open — no cmp node);
	// compacting resets in the store's finally, which flips the UI back to the
	// normal action row. Nothing changed, so no payload refresh is needed.
	function handleStopCompaction() {
		chatStore.stopCompaction();
	}

	async function handleRecompact() {
		const cmpId = result?.compaction?.entryId;

		if (!convId || !cmpId) return;

		expandedRow = null;

		await chatStore.recompactConversationEntry(convId, cmpId);
		refreshPayload();
	}

	function requestExpand() {
		if (!result?.compaction) return;

		showExpandConfirm = true;
	}

	async function handleExpandConfirmed() {
		const cmpId = result?.compaction?.entryId;

		showExpandConfirm = false;

		if (!convId || !cmpId) return;

		expandedRow = null;

		await chatStore.expandCompactionEntry(convId, cmpId);
		refreshPayload();
	}

	async function handleBoundaryChange(value: string) {
		const cmpId = result?.compaction?.entryId;

		if (!convId || !cmpId || !value) return;

		await chatStore.moveCompactionBoundary(convId, cmpId, value);
		refreshPayload();
	}

	function startEditingSummary() {
		const row = payloadRows.find((entry) => entry.kind === 'summary');

		if (!row || typeof row.message.content !== 'string') return;

		draftSummary = stripSummaryPrefix(row.message.content);
		editingSummary = true;
		expandedRow = null;
	}

	function cancelEditingSummary() {
		draftSummary = '';
		editingSummary = false;
	}

	async function saveSummary() {
		const cmpId = result?.compaction?.entryId;

		if (!convId || !cmpId) return;

		const text = draftSummary;
		draftSummary = '';
		editingSummary = false;
		expandedRow = null;

		await chatStore.updateCompactionSummary(convId, cmpId, text);
		refreshPayload();
	}

	function badgeClass(kind: string): string {
		switch (kind) {
			case 'summary':
				return 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400';
			case MessageRole.SYSTEM:
				return 'border-border/60 bg-muted/50 text-muted-foreground';
			case MessageRole.USER:
				return 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400';
			case MessageRole.ASSISTANT:
				return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
			default:
				// tool
				return 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400';
		}
	}

	// Collapsed rows show a one-line preview; the full text stays reachable
	// through the expanded row and Copy JSON. Capping the preview keeps huge
	// tool results from rendering as single multi-KB text nodes (which also
	// pushed the dialog's min-content width past its bounds).
	const PREVIEW_MAX_LENGTH = 150;

	function clampPreview(text: string): string {
		return text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH)}…` : text;
	}

	function apiPreviewText(message: ApiChatMessageData): string {
		const text = contentText(message.content).trim().replace(/\s+/g, ' ');

		if (text) return clampPreview(text);

		const callNames = (message.tool_calls ?? [])
			.map((call) => call.function?.name)
			.filter((name): name is string => Boolean(name));

		if (callNames.length > 0) return `(tool_calls: ${callNames.join(', ')})`;

		return '(empty)';
	}

	function contentText(content: ApiChatMessageData['content']): string {
		if (typeof content === 'string') return content;

		return content
			.map((part) => {
				switch (part.type) {
					case ContentPartType.TEXT:
						return part.text ?? '';
					case ContentPartType.IMAGE_URL:
						return '[image]';
					case ContentPartType.INPUT_AUDIO:
						return '[audio]';
					default:
						return '[video]';
				}
			})
			.join(' ');
	}

	function fullText(message: ApiChatMessageData): string {
		const parts = [contentText(message.content).trim()];

		if (message.reasoning_content) {
			parts.push(`[reasoning]\n${message.reasoning_content}`);
		}

		if (message.tool_calls) {
			parts.push(`[tool_calls]\n${JSON.stringify(message.tool_calls, null, 2)}`);
		}

		return parts.filter((part) => part).join('\n\n');
	}

	function dbPreviewText(message: DatabaseMessage): string {
		const text = message.content.trim().replace(/\s+/g, ' ');

		if (text) return clampPreview(text);

		if (message.toolCalls) return '(tool_calls)';

		return '(empty)';
	}

	// The stored content carries the fixed summary prefix (added at node
	// creation); strip it so the editor reads as plain summary text.
	function stripSummaryPrefix(content: string): string {
		return content.startsWith(SUMMARY_CONTENT_PREFIX)
			? content.slice(SUMMARY_CONTENT_PREFIX.length).trim()
			: content;
	}

	function boundaryLabel(message: DatabaseMessage, index: number): string {
		if (message.role === MessageRole.ASSISTANT && message.toolCalls) {
			const names = toolCallNames(message.toolCalls);

			if (names.length > 0) return `#${index + 1} (assistant): tool_calls ${names.join(', ')}`;
		}

		const text = message.content.trim().replace(/\s+/g, ' ');

		if (!text) return `#${index + 1} (${message.role}): (empty)`;

		const preview = text.length > 48 ? `${text.slice(0, 48)}…` : text;

		return `#${index + 1} (${message.role}): “${preview}”`;
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

	async function copyPayloadJson() {
		if (!result) return;

		try {
			await navigator.clipboard.writeText(JSON.stringify(sanitizePayload(result.messages), null, 2));
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch {
			toast.error('Could not copy the payload to the clipboard');
		}
	}

	// Base64 bodies would blow up the clipboard, so they become size
	// placeholders in the copied JSON (the on-screen rows already do the same).
	function sanitizePayload(messages: ApiChatMessageData[]): ApiChatMessageData[] {
		return messages.map((message) => {
			if (typeof message.content === 'string') return message;

			return {
				...message,
				content: message.content.map(sanitizeContentPart)
			};
		});
	}

	function sanitizeContentPart(part: ApiChatMessageContentPart): ApiChatMessageContentPart {
		switch (part.type) {
			case ContentPartType.IMAGE_URL:
				return part.image_url?.url.startsWith('data:')
					? { ...part, image_url: { url: `[image: ${placeholderSize(part.image_url.url)}]` } }
					: part;
			case ContentPartType.INPUT_AUDIO:
				return part.input_audio
					? {
							...part,
							input_audio: {
								...part.input_audio,
								data: `[audio: ${placeholderSize(part.input_audio.data)}]`
							}
						}
					: part;
			case ContentPartType.INPUT_VIDEO:
				return part.input_video
					? {
							...part,
							input_video: {
								...part.input_video,
								data: `[video: ${placeholderSize(part.input_video.data)}]`
							}
						}
					: part;
			default:
				return part;
		}
	}

	function placeholderSize(base64: string): string {
		return formatFileSize(Math.max(0, Math.floor((base64.length * 3) / 4)));
	}
</script>

<Dialog.Root onOpenChange={handleOpenChange} {open}>
	<Dialog.Content bind:ref={contentEl} class="overflow-x-hidden w-full sm:max-w-2xl md:max-w-3xl">
		<Dialog.Header />

		<div class="flex flex-col gap-2">
			<Dialog.Title class="flex items-center gap-2">
				<Braces class="h-5 w-5" />

				Context Inspector
			</Dialog.Title>

			<Dialog.Description>
				The exact payload the next request sends to the LLM, built by the same code path as sending.
			</Dialog.Description>
		</div>

		{#if !result}
			<div class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
				<Loader2 class="h-4 w-4 animate-spin" />

				Building payload…
			</div>
		{:else}
			<div class="flex min-w-0 flex-col gap-4">
				<div class="flex flex-col gap-2">
					<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
						<span>
							<span class="text-muted-foreground">Model:</span>

							<span class="font-mono">{modelId ?? '—'}</span>
						</span>

						<span>
							<span class="text-muted-foreground">n_ctx:</span>

							{nCtx !== null ? formatNumber(nCtx) : '—'}
						</span>
					</div>

					<div class="flex flex-col gap-1">
						<div class="flex items-center justify-between gap-2 text-xs">
							<span>
								<span class="text-muted-foreground">Estimated send:</span>

								{formatNumber(result.estimatedTokens)} tokens
							</span>

							{#if percent !== null}
								<span class="font-medium {colorLevelTextClass(colorLevel)}">
									{percent.toFixed(1)}% of n_ctx
								</span>
							{/if}
						</div>

						{#if percent !== null}
							<div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
								<div
									class="h-full rounded-full {colorLevelBgClass(colorLevel)}"
									style="width: {percent}%"
								></div>
							</div>
						{/if}
					</div>
				</div>

				{#if result.compaction && !result.compaction.boundaryValid}
					<div
						class="text-destructive flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
						role="alert"
					>
						<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />

						<span>
							The compaction boundary no longer exists on this path, so the full context
							is being sent. Consider re-compacting.
						</span>
					</div>
				{/if}

				{#if compacting}
					<div
						class="flex items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
						role="status"
					>
						<Loader2 class="h-4 w-4 animate-spin" />

						Compacting context…
					</div>
				{/if}

				<div class="flex flex-col gap-3 border-t border-border/50 pt-3">
					<h3 class="text-sm font-medium">Advanced</h3>

					{#if result.compaction}
						<div class="flex flex-col gap-1.5">
							<span class="text-xs text-muted-foreground">Kept from (boundary)</span>

							<Select.Root
								onValueChange={handleBoundaryChange}
								type="single"
								value={selectedBoundary}
							>
								<Select.Trigger
									aria-label="Kept from boundary"
									class="w-full justify-start text-xs"
									disabled={actionsBlocked || !result.compaction.boundaryValid}
									size="sm"
								>
									{selectedBoundaryLabel}
								</Select.Trigger>

								<Select.Content>
									{#if userBoundaryOptions.length > 0}
										<Select.Group>
											<Select.GroupHeading>Turn boundaries (user)</Select.GroupHeading>

											{#each userBoundaryOptions as option (option.id)}
												<Select.Item label={option.label} value={option.id} />
											{/each}
										</Select.Group>
									{/if}

									{#if assistantBoundaryOptions.length > 0}
										<Select.Group>
											<Select.GroupHeading>Within a turn (assistant)</Select.GroupHeading>

											{#each assistantBoundaryOptions as option (option.id)}
												<Select.Item label={option.label} value={option.id} />
											{/each}
										</Select.Group>
									{/if}
								</Select.Content>
							</Select.Root>
						</div>
					{/if}

					<div class="flex flex-wrap gap-2">
						{#if compacting}
							<Button class="h-7 gap-1 px-2 text-xs" onclick={handleStopCompaction} variant="destructive">
								<Square class="h-3.5 w-3.5" />

								Stop
							</Button>
						{:else}
							<Button class="h-7 gap-1 px-2 text-xs" disabled={actionsBlocked} onclick={handleCompactNow}>
								<Shrink class="h-3.5 w-3.5" />

								Compact now
							</Button>

							{#if result.compaction}
								<Button
									class="h-7 gap-1 px-2 text-xs"
									disabled={actionsBlocked}
									onclick={requestExpand}
									variant="outline"
								>
									<UnfoldVertical class="h-3.5 w-3.5" />

									Expand
								</Button>

								<Button
									class="h-7 gap-1 px-2 text-xs"
									disabled={actionsBlocked || !result.compaction.boundaryValid}
									onclick={handleRecompact}
									variant="outline"
								>
									<RefreshCw class="h-3.5 w-3.5" />

									Re-summarize
								</Button>
							{/if}
						{/if}
					</div>
				</div>

				<div class="flex flex-col gap-2">
					<div class="flex items-center justify-between gap-2">
						<h3 class="text-sm font-medium">
							Actual payload

							<span class="text-muted-foreground">({result.messages.length} messages)</span>
						</h3>

						<Button class="h-7 gap-1 px-2 text-xs" variant="outline" onclick={copyPayloadJson}>
							{#if copied}
								<Check class="h-3.5 w-3.5" />

								Copied
							{:else}
								<Copy class="h-3.5 w-3.5" />

								Copy JSON
							{/if}
						</Button>
					</div>

					<ul class="max-w-2xl min-w-0 flex flex-col divide-y divide-border/40 rounded-md border border-border/50">
						{#each payloadRows as row, index (index)}
							<li class="min-w-0">
								<div class="flex items-start gap-1">
									<button
										aria-expanded={expandedRow === index}
										class="hover:bg-muted/40 flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left"
										onclick={() => (expandedRow = expandedRow === index ? null : index)}
									>
										<span class="shrink-0 pt-0.5">
											<span
												class={`rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${badgeClass(
													row.kind
												)}`}>
												{row.kind}
											</span>
										</span>

										<span class="text-foreground/80 min-w-0 flex-1 truncate text-xs"
										>{row.text}</span>

										<span class="text-muted-foreground font-mono shrink-0 pt-0.5 text-[10px]">
											~{formatNumber(row.tokens)} tok
										</span>
									</button>

									{#if row.kind === 'summary'}
										<button
											aria-label="Edit summary"
											class="text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 mt-2 mr-2 shrink-0 rounded p-1"
											disabled={actionsBlocked}
											title={
												actionsBlocked
													? 'Unavailable while the context is busy'
													: 'Edit the summary text'
											}
											onclick={startEditingSummary}
										>
											<Pencil class="h-3.5 w-3.5" />
										</button>
									{/if}
								</div>

								{#if expandedRow === index}
									<pre
										class="text-foreground/80 mx-3 mb-2 max-h-48 overflow-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap"
									>{fullText(row.message)}</pre
									>
								{/if}

								{#if editingSummary && row.kind === 'summary'}
									<div class="flex flex-col gap-2 px-3 pb-3">
										<Textarea bind:value={draftSummary} class="min-h-32 font-mono text-xs" />

										<div class="flex gap-2">
											<Button
												class="h-7 gap-1 px-2 text-xs"
												disabled={actionsBlocked || !draftSummary.trim()}
												onclick={saveSummary}
											>
												<Check class="h-3.5 w-3.5" />

												Save
											</Button>

											<Button
												class="h-7 px-2 text-xs"
												variant="outline"
												onclick={cancelEditingSummary}
											>
												Cancel
											</Button>
										</div>
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				</div>

				{#if droppedRows.length > 0}
					<div class="flex flex-col gap-2">
						<h3 class="text-sm font-medium">
							Compacted out

							<span class="text-muted-foreground">
								({droppedRows.length} messages, not sent — covered by the summary)
							</span>
						</h3>

						<ul class="opacity-60 max-w-2xl min-w-0 flex flex-col divide-y divide-border/30 rounded-md border border-border/40">
							{#each droppedRows as row (row.message.id)}
								<li class="min-w-0 flex items-start gap-2 px-3 py-1.5">
									<span class="text-muted-foreground font-mono shrink-0 pt-0.5 text-[10px]">
										#{row.index}
									</span>

									<span
										class="text-muted-foreground rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
									>
										{row.message.role}
									</span>

									<span class="text-muted-foreground min-w-0 flex-1 truncate text-xs">
										{dbPreviewText(row.message)}
									</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<div class="flex justify-center">
					<Button class="h-7 gap-1 px-2 text-xs" variant="outline" onclick={scrollToTop}>
						<ArrowUpToLine class="h-3.5 w-3.5" />

						Back to top
					</Button>
				</div>
			</div>
		{/if}
	</Dialog.Content>

	<DialogConfirmation
		bind:open={showExpandConfirm}
		confirmText="Expand"
		description={expandDescription}
		onConfirm={handleExpandConfirmed}
		onCancel={() => (showExpandConfirm = false)}
		title="Restore the full context?"
	/>
</Dialog.Root>
