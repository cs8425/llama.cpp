<script lang="ts">
	/**
	 * Context Inspector — "what exactly goes to the LLM".
	 *
	 * Read-only view over `buildLlmContext(activeMessages)`: the same choke
	 * point the send path uses, so what is shown here is what goes over the
	 * wire (WYSIWYG, context-enhance/03 §2). Phase 1 is read-only: payload
	 * rows, per-message token estimates, the compacted-out region, the
	 * fail-open boundary warning and a Copy JSON action. Editing (summary /
	 * breakpoint / compact / expand) lands in Phase 2.
	 *
	 * The payload is built once per open. The entry point (context gauge
	 * popup) is disabled while the model responds, so the active path is
	 * stable for the whole time the dialog is open; a pre-send snapshot
	 * replaces this in Phase 2 (context-enhance/04 §2.1).
	 */
	import { AlertTriangle, Braces, Check, Copy, Loader2 } from '@lucide/svelte';
	import {
		colorLevelBgClass,
		colorLevelFromPercent,
		colorLevelTextClass
	} from '$lib/components/app/chat/ChatForm/ChatFormContextGauge/context-gauge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ContentPartType, MessageRole } from '$lib/enums';
	import { buildLlmContext, estimateApiMessageTokens } from '$lib/services/context';
	import type { ContextBuildResult } from '$lib/services/context';
	import { contextStatsStore, conversationsStore } from '$lib/stores';
	import type { ApiChatMessageContentPart, ApiChatMessageData, DatabaseMessage } from '$lib/types';
	import { formatFileSize, formatNumber } from '$lib/utils/formatters';
	import { toast } from 'svelte-sonner';

	interface Props {
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
	}

	let { onOpenChange, open = $bindable(false) }: Props = $props();

	let building = $state(false);
	let copied = $state(false);
	let expandedRow = $state<number | null>(null);
	let result = $state<ContextBuildResult | null>(null);

	let nCtx = $derived(contextStatsStore.contextTotal);
	let modelId = $derived(contextStatsStore.activeModelId);
	let path = $derived(conversationsStore.activeMessages);
	let headLength = $derived(path[0]?.role === MessageRole.SYSTEM ? 1 : 0);

	let percent = $derived.by(() => {
		if (!result || nCtx === null || nCtx <= 0) return null;

		return Math.min(100, (result.estimatedTokens / nCtx) * 100);
	});
	let colorLevel = $derived(colorLevelFromPercent(percent));

	$effect(() => {
		if (!open) {
			building = false;
			copied = false;
			expandedRow = null;
			result = null;

			return;
		}

		let cancelled = false;
		building = true;
		result = null;

		void buildLlmContext(path).then((built) => {
			if (cancelled) return;

			building = false;
			result = built;
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

	function handleOpenChange(nextOpen: boolean) {
		open = nextOpen;
		onOpenChange?.(nextOpen);
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

	function apiPreviewText(message: ApiChatMessageData): string {
		const text = contentText(message.content).trim().replace(/\s+/g, ' ');

		if (text) return text;

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

		if (text) return text;

		if (message.toolCalls) return '(tool_calls)';

		return '(empty)';
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
	<Dialog.Content class="sm:max-w-2xl md:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<Braces class="h-5 w-5" />

				Context Inspector
			</Dialog.Title>

			<Dialog.Description>
				The exact payload the next request sends to the LLM, built by the same code path as sending.
			</Dialog.Description>
		</Dialog.Header>

		{#if building || !result}
			<div class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
				<Loader2 class="h-4 w-4 animate-spin" />

				Building payload…
			</div>
		{:else}
			<div class="flex flex-col gap-4">
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
							The compaction boundary no longer exists on this path, so the full context is being
							sent. Consider re-compacting.
						</span>
					</div>
				{/if}

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

					<ul class="flex flex-col divide-y divide-border/40 rounded-md border border-border/50">
						{#each payloadRows as row, index (index)}
							<li>
								<button
									aria-expanded={expandedRow === index}
									class="hover:bg-muted/40 flex w-full items-start gap-2 px-3 py-2 text-left"
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

									<span class="text-foreground/80 min-w-0 flex-1 truncate text-xs">{row.text}</span>

									<span class="text-muted-foreground font-mono shrink-0 pt-0.5 text-[10px]">
										~{formatNumber(row.tokens)} tok
									</span>
								</button>

								{#if expandedRow === index}
									<pre
										class="text-foreground/80 mx-3 mb-2 max-h-48 overflow-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap"
									>{fullText(row.message)}</pre
									>
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

						<ul class="opacity-60 flex flex-col divide-y divide-border/30 rounded-md border border-border/40">
							{#each droppedRows as row (row.message.id)}
								<li class="flex items-start gap-2 px-3 py-1.5">
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
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
