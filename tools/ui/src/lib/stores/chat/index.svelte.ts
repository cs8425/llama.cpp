/**
 * chatStore - Chat lifecycle, streaming and message operations
 *
 * Owns the active conversation's chat state: sending messages, streaming
 * responses, editing/regeneration flows and per-conversation processing
 * activity. Composes the stream manager, message flows, activity ledger and
 * processing snapshot; persists through conversationsStore.
 *
 * Uses ChatService for the API layer and conversationsStore for persistence.
 */

import { CWD_CLEARED_TEXT, SYSTEM_MESSAGE_PLACEHOLDER, TITLE_GENERATION } from '$lib/constants';
import {
	ErrorDialogType,
	MessageRole,
	MessageType,
	ReasoningEffort,
	StreamConnectionState
} from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import {
	type CompactionPlan,
	type SummaryResult,
	SUMMARY_CONTENT_PREFIX,
	byteLength,
	computeCompactionBudget,
	computeSummaryMaxTokens,
	estimateTokens,
	MIN_SUMMARIZE_TOKENS,
	planCompaction,
	planCompactionRecentWindow,
	shouldTriggerCompaction,
	summarizeWithRetry,
	toCompactionMode,
	toSummaryMode
} from '$lib/services/context';
import type { CompactionMode } from '$lib/services/context';
import { DatabaseService } from '$lib/services/database.service';
// direct imports between stores, not via the barrel, to avoid circular deps
import { agenticStore } from '$lib/stores/agentic/index.svelte';
import { chatActivityStore } from '$lib/stores/chat/activity.svelte';
import { contextStatsStore } from '$lib/stores/chat/context-stats.svelte';
import { type ChatFlowsHost, ChatMessageFlows } from '$lib/stores/chat/flows.svelte';
import { chatProcessingStore } from '$lib/stores/chat/processing.svelte';
import { type ChatStreamHost, ChatStreamManager } from '$lib/stores/chat/streams.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { mcpStore } from '$lib/stores/mcp/index.svelte';
import { modelsStore } from '$lib/stores/models/index.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { toolsStore } from '$lib/stores/tools.svelte';
import type {
	ApiChatMessageData,
	ChatMessagePromptProgress,
	ChatMessageTimings,
	ChatStreamCallbacks,
	DatabaseMessage,
	DatabaseMessageExtra,
	ErrorDialogState
} from '$lib/types';
import {
	filterByLeafNodeId,
	findMessageById,
	formatCwdMessage,
	getConversationModel,
	isAbortError,
	normalizeModelName
} from '$lib/utils';
import { SvelteMap } from 'svelte/reactivity';
import { toast } from 'svelte-sonner';

class ChatStore implements ChatStreamHost, ChatFlowsHost {
	chatReasoningStates = new SvelteMap<string, boolean>();
	chatStreamingStates = new SvelteMap<
		string,
		{ response: string; messageId: string; model?: string | null }
	>();
	errorDialogState = $state<ErrorDialogState | null>(null);
	// true while the context inspector dialog is open (Phase 1 read-only;
	// entry point: the context gauge popup)
	showContextInspector = $state(false);
	// true while the active conversation has a local pipe (send, attach or resume-wait)
	isLoading = $derived(this.activity.isLocal(conversationsStore.activeConversation?.id ?? ''));
	// true while the active conversation streams reasoning content but no visible content yet
	isReasoning = $derived(
		this.chatReasoningStates.get(conversationsStore.activeConversation?.id ?? '') ?? false
	);
	pendingEditMessageId = $state<string | null>(null);
	// resumable stream connection state for the active conversation
	// streaming -> bytes flowing normally, resuming -> waiting on /v1/stream reconnect, lost -> unrecoverable
	streamConnectionState = $state<StreamConnectionState>(StreamConnectionState.STREAMING);
	private abortControllers = new SvelteMap<string, AbortController>();
	private addFilesHandler: ((files: File[]) => void) | null = $state(null);
	// N3: the in-flight manual compaction's summary call (compact / recompact /
	// backward boundary move). stopCompaction() aborts it; in-loop compaction
	// keeps the flow's own signal.
	private compactionAbortController: AbortController | null = null;
	// message flows: edit, regenerate, continue, delete
	private flows = new ChatMessageFlows(this);
	private isEditModeActive = $state(false);
	private pendingDraftFiles = $state<ChatUploadedFile[]>([]);
	private pendingDraftMessage = $state<string>('');
	/** Reactive: queued pending messages for non-agentic streaming */
	private pendingMessages = new SvelteMap<
		string,
		{ content: string; extras?: DatabaseMessageExtra[] }
	>();
	private preEncodeAbortController: AbortController | null = null;

	// server-side stream sessions: discovery, attach/replay, resume retry, remote sync
	private streams = new ChatStreamManager(this);

	/** Conv activity (local pipe / remote session), composed here. */
	get activity() {
		return chatActivityStore;
	}

	/** Processing state, composed here so consumers have a single chat scope. */
	get processing() {
		return chatProcessingStore;
	}

	/**
	 * Abort the current agentic flow signal without clearing loading state.
	 * Used by "Send immediately" to force the agentic loop to exit so that
	 * the pending steering message can be re-sent.
	 *
	 * Any tool calls captured mid-stream are dropped before the abort so the
	 * pending message (or a manual follow-up) does not re-send a half-received
	 * tool call with invalid JSON arguments to the server. Mirrors what the
	 * Stop button already does through stopGenerationForChat.
	 */
	async abortCurrentFlow(convId: string): Promise<void> {
		await this.savePartialResponseIfNeeded(convId);
		const c = this.abortControllers.get(convId);

		if (c) {
			c.abort();
			this.abortControllers.delete(convId);
		}
	}

	async addMessage(
		role: MessageRole,
		content: string,
		type: MessageType = MessageType.TEXT,
		parent: string = '-1',
		extras?: DatabaseMessageExtra[],
		isSynthetic?: boolean
	): Promise<DatabaseMessage> {
		const activeConv = conversationsStore.activeConversation;

		if (!activeConv) throw new Error('No active conversation');

		let parentId: string | null = null;

		if (parent === '-1') {
			const am = conversationsStore.activeMessages;

			if (am.length > 0) parentId = am[am.length - 1].id;
			else {
				const all = await conversationsStore.getConversationMessages(activeConv.id);
				const r = all.find((m) => m.parent === null && m.type === 'root');

				parentId = r ? r.id : await DatabaseService.createRootMessage(activeConv.id);
			}
		} else parentId = parent;

		const message = await DatabaseService.createMessageBranch(
			{
				children: [],
				content,
				convId: activeConv.id,
				extra: extras,
				isSynthetic,
				role,
				timestamp: Date.now(),
				toolCalls: '',
				type
			},
			parentId
		);

		conversationsStore.addMessageToActive(message);
		await conversationsStore.updateCurrentNode(message.id);
		conversationsStore.updateConversationTimestamp();

		return message;
	}
	async addSystemPrompt(): Promise<void> {
		let activeConv = conversationsStore.activeConversation;

		if (!activeConv) {
			await conversationsStore.createConversation();
			activeConv = conversationsStore.activeConversation;
		}

		if (!activeConv) return;

		try {
			const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
			const rootMessage = allMessages.find((m) => m.type === 'root' && m.parent === null);
			const rootId = rootMessage
				? rootMessage.id
				: await DatabaseService.createRootMessage(activeConv.id);
			const existingSystemMessage = allMessages.find(
				(m) => m.role === MessageRole.SYSTEM && m.parent === rootId
			);

			if (existingSystemMessage) {
				this.pendingEditMessageId = existingSystemMessage.id;

				if (!conversationsStore.activeMessages.some((m) => m.id === existingSystemMessage.id))
					conversationsStore.activeMessages.unshift(existingSystemMessage);

				return;
			}

			const am = conversationsStore.activeMessages;
			const firstActiveMessage = am.find((m) => m.parent === rootId);
			const systemMessage = await DatabaseService.createSystemMessage(
				activeConv.id,
				SYSTEM_MESSAGE_PLACEHOLDER,
				rootId
			);

			if (firstActiveMessage) {
				await DatabaseService.updateMessage(firstActiveMessage.id, {
					parent: systemMessage.id
				});
				await DatabaseService.updateMessage(systemMessage.id, {
					children: [firstActiveMessage.id]
				});
				const updatedRootChildren = rootMessage
					? rootMessage.children.filter((id: string) => id !== firstActiveMessage.id)
					: [];

				await DatabaseService.updateMessage(rootId, {
					children: [
						...updatedRootChildren.filter((id: string) => id !== systemMessage.id),
						systemMessage.id
					]
				});
				const firstMsgIndex = conversationsStore.findMessageIndex(firstActiveMessage.id);

				if (firstMsgIndex !== -1)
					conversationsStore.updateMessageAtIndex(firstMsgIndex, {
						parent: systemMessage.id
					});
			}

			conversationsStore.activeMessages.unshift(systemMessage);
			this.pendingEditMessageId = systemMessage.id;
			conversationsStore.updateConversationTimestamp();
		} catch (error) {
			console.error('Failed to add system prompt:', error);
		}
	}
	cancelPreEncode(): void {
		if (this.preEncodeAbortController) {
			this.preEncodeAbortController.abort();
			this.preEncodeAbortController = null;
		}
	}

	/**
	 * Resets the loading, streaming and processing state for a conversation
	 * after a generation ends or errors. Shared by the flows' exit paths.
	 */
	cleanupStreaming(convId: string): void {
		this.setChatLoading(convId, false);
		this.clearChatStreaming(convId);
		this.processing.setState(convId, null);
	}
	clearChatStreaming(convId: string, messageId?: string): void {
		// session aware: a stale generation must not wipe a newer one's streaming state on the
		// same conversation, that would drop the frozen stop identity and stop the wrong session
		if (messageId !== undefined) {
			const cur = this.chatStreamingStates.get(convId);

			if (cur && cur.messageId !== messageId) return;
		}

		this.chatStreamingStates.delete(convId);
	}
	clearEditMode(): void {
		this.isEditModeActive = false;
		this.addFilesHandler = null;
	}

	clearPendingEditMessageId(): void {
		this.pendingEditMessageId = null;
	}

	clearPendingMessage(convId: string): void {
		this.pendingMessages.delete(convId);
	}

	consumePendingDraft(): { message: string; files: ChatUploadedFile[] } | null {
		if (!this.pendingDraftMessage && this.pendingDraftFiles.length === 0) return null;

		const d = { files: [...this.pendingDraftFiles], message: this.pendingDraftMessage };

		this.pendingDraftMessage = '';
		this.pendingDraftFiles = [];

		return d;
	}

	consumePendingMessage(
		convId: string
	): { content: string; extras?: DatabaseMessageExtra[] } | null {
		const msg = this.pendingMessages.get(convId);

		if (!msg) return null;

		this.pendingMessages.delete(convId);

		return msg;
	}

	async continueAssistantMessage(messageId: string): Promise<void> {
		return this.flows.continueAssistantMessage(messageId);
	}

	async createAssistantMessage(parentId?: string): Promise<DatabaseMessage> {
		const activeConv = conversationsStore.activeConversation;

		if (!activeConv) throw new Error('No active conversation');

		return await DatabaseService.createMessageBranch(
			{
				children: [],
				content: '',
				convId: activeConv.id,
				model: null,
				role: MessageRole.ASSISTANT,
				timestamp: Date.now(),
				toolCalls: '',
				type: MessageType.TEXT
			},
			parentId || null
		);
	}

	async deleteMessage(messageId: string): Promise<void> {
		return this.flows.deleteMessage(messageId);
	}

	/**
	 * Server-side stream sessions (discovery, attach/replay, resume retry,
	 * remote-running snapshot) live in ChatStreamManager.
	 */
	async discoverActiveStream(convId: string): Promise<void> {
		return this.streams.discoverActiveStream(convId);
	}

	dismissErrorDialog(): void {
		this.errorDialogState = null;
	}

	async editAssistantMessage(
		messageId: string,
		newContent: string,
		shouldBranch: boolean
	): Promise<void> {
		return this.flows.editAssistantMessage(messageId, newContent, shouldBranch);
	}

	async editMessageWithBranching(
		messageId: string,
		newContent: string,
		newExtras?: DatabaseMessageExtra[]
	): Promise<void> {
		return this.flows.editMessageWithBranching(messageId, newContent, newExtras);
	}

	async editUserMessagePreserveResponses(
		messageId: string,
		newContent: string,
		newExtras?: DatabaseMessageExtra[]
	): Promise<void> {
		return this.flows.editUserMessagePreserveResponses(messageId, newContent, newExtras);
	}

	getAddFilesHandler(): ((files: File[]) => void) | null {
		return this.addFilesHandler;
	}

	/** Convs with any activity (local pipe or remote session), sidebar spinners. */
	getAllLoadingChats(): string[] {
		return this.activity.loadingConvs;
	}

	getApiOptions(): Record<string, unknown> {
		const currentConfig = settingsStore.config;
		const hasValue = (value: unknown): boolean =>
			value !== undefined && value !== null && value !== '';
		const apiOptions: Record<string, unknown> = { stream: true, timings_per_token: true };

		if (serverStore.isRouterMode) {
			const modelName = modelsStore.selectedModelName;

			if (modelName) apiOptions.model = modelName;
		}

		if (currentConfig.systemMessage) apiOptions.systemMessage = currentConfig.systemMessage;

		if (currentConfig.disableReasoningParsing) apiOptions.disableReasoningParsing = true;

		if (currentConfig.excludeReasoningFromContext) apiOptions.excludeReasoningFromContext = true;

		// an explicit reasoning choice overrides the server default, DEFAULT sends nothing
		const effort = conversationsStore.preferences.getReasoningEffort();

		if (effort !== ReasoningEffort.DEFAULT) {
			apiOptions.enableThinking = effort !== ReasoningEffort.OFF;

			if (effort !== ReasoningEffort.OFF) apiOptions.reasoningEffort = effort;
		}

		if (hasValue(currentConfig.temperature))
			apiOptions.temperature = Number(currentConfig.temperature);

		if (hasValue(currentConfig.max_tokens))
			apiOptions.max_tokens = Number(currentConfig.max_tokens);

		if (hasValue(currentConfig.dynatemp_range))
			apiOptions.dynatemp_range = Number(currentConfig.dynatemp_range);

		if (hasValue(currentConfig.dynatemp_exponent))
			apiOptions.dynatemp_exponent = Number(currentConfig.dynatemp_exponent);

		if (hasValue(currentConfig.top_k)) apiOptions.top_k = Number(currentConfig.top_k);

		if (hasValue(currentConfig.top_p)) apiOptions.top_p = Number(currentConfig.top_p);

		if (hasValue(currentConfig.min_p)) apiOptions.min_p = Number(currentConfig.min_p);

		if (hasValue(currentConfig.xtc_probability))
			apiOptions.xtc_probability = Number(currentConfig.xtc_probability);

		if (hasValue(currentConfig.xtc_threshold))
			apiOptions.xtc_threshold = Number(currentConfig.xtc_threshold);

		if (hasValue(currentConfig.typ_p)) apiOptions.typ_p = Number(currentConfig.typ_p);

		if (hasValue(currentConfig.repeat_last_n))
			apiOptions.repeat_last_n = Number(currentConfig.repeat_last_n);

		if (hasValue(currentConfig.repeat_penalty))
			apiOptions.repeat_penalty = Number(currentConfig.repeat_penalty);

		if (hasValue(currentConfig.presence_penalty))
			apiOptions.presence_penalty = Number(currentConfig.presence_penalty);

		if (hasValue(currentConfig.frequency_penalty))
			apiOptions.frequency_penalty = Number(currentConfig.frequency_penalty);

		if (hasValue(currentConfig.dry_multiplier))
			apiOptions.dry_multiplier = Number(currentConfig.dry_multiplier);

		if (hasValue(currentConfig.dry_base)) apiOptions.dry_base = Number(currentConfig.dry_base);

		if (hasValue(currentConfig.dry_allowed_length))
			apiOptions.dry_allowed_length = Number(currentConfig.dry_allowed_length);

		if (hasValue(currentConfig.dry_penalty_last_n))
			apiOptions.dry_penalty_last_n = Number(currentConfig.dry_penalty_last_n);

		if (currentConfig.samplers) apiOptions.samplers = currentConfig.samplers;

		if (hasValue(currentConfig.backend_sampling))
			apiOptions.backend_sampling = currentConfig.backend_sampling;

		if (currentConfig.customJson) apiOptions.custom = currentConfig.customJson;

		return apiOptions;
	}

	getChatStreaming(convId: string): { response: string; messageId: string } | undefined {
		return this.getChatStreamingState(convId);
	}

	async getDeletionInfo(messageId: string): Promise<{
		totalCount: number;
		userMessages: number;
		assistantMessages: number;
		messageTypes: string[];
	}> {
		return this.flows.getDeletionInfo(messageId);
	}

	getOrCreateAbortController(convId: string): AbortController {
		let c = this.abortControllers.get(convId);

		if (!c || c.signal.aborted) {
			c = new AbortController();
			this.abortControllers.set(convId, c);
		}

		return c;
	}

	getPendingMessageContent(convId: string): string | null {
		return this.pendingMessages.get(convId)?.content ?? null;
	}

	getPendingMessageExtras(convId: string): DatabaseMessageExtra[] | undefined {
		return this.pendingMessages.get(convId)?.extras;
	}

	getResumeModel(convId: string): string | null {
		return this.streams.getResumeModel(convId);
	}

	hasPendingDraft(): boolean {
		return Boolean(this.pendingDraftMessage) || this.pendingDraftFiles.length > 0;
	}

	hasPendingMessage(convId: string): boolean {
		return this.pendingMessages.has(convId);
	}

	injectPendingMessage(convId: string, content: string, extras?: DatabaseMessageExtra[]): void {
		this.pendingMessages.set(convId, { content, extras });
	}

	isChatLoading(convId: string): boolean {
		return this.activity.isLocal(convId);
	}

	isChatLoadingInternal(convId: string): boolean {
		return this.activity.isLocal(convId) || this.chatStreamingStates.has(convId);
	}

	isEditing(): boolean {
		return this.isEditModeActive;
	}

	/** True while the active conversation has a live streaming pipe. */
	isStreaming(): boolean {
		return this.chatStreamingStates.has(conversationsStore.activeConversation?.id ?? '');
	}

	/**
	 * Compacts a conversation: replaces the messages before a safe boundary
	 * with a model-generated summary stored as a compaction entry node
	 * (context-enhance/02 §2, 06-status §5.5).
	 *
	 * `auto: true` (called between flows) additionally requires the last prompt
	 * to have reached the configured threshold of n_ctx; `auto: false` is the
	 * manual "Compact now" action and skips that check.
	 *
	 * Fail-open everywhere: a missing plan, an unknown n_ctx or a failed
	 * summary call leaves the conversation untouched.
	 */
	async compactConversation(convId: string, options: { auto?: boolean } = {}): Promise<void> {
		const auto = options.auto === true;

		// I7: never compact while a stream or agentic flow owns the context,
		// and never run two summary calls at once.
		if (this.isChatLoading(convId) || agenticStore.isRunning(convId)) return;

		if (contextStatsStore.compacting) return;

		const isActive = conversationsStore.activeConversation?.id === convId;
		const path = await this.resolveConversationPath(convId);

		if (!path || path.length === 0) return;

		const config = settingsStore.config;
		const nCtx = this.getContextSizeForConversation(convId, path);

		if (nCtx === null || nCtx <= 0) {
			if (!auto) toast.info('Model context size unknown');

			return;
		}

		const mode: CompactionMode = toCompactionMode(config.contextCompactionMode);

		// Auto compaction needs the master switch on AND the mode-specific
		// trigger crossed; the manual action skips both gates.
		if (auto) {
			if (!config.contextAutoCompaction) return;

			let lastPrompt: number | null = null;

			for (let i = path.length - 1; i >= 0; i--) {
				const message = path[i];

				if (message.role === MessageRole.ASSISTANT && message.timings?.prompt_n != null) {
					lastPrompt = message.timings.prompt_n;

					break;
				}
			}

			const effectiveLastPrompt =
				lastPrompt ?? path.reduce((sum, message) => sum + estimateTokens(message), 0);

			if (
				!shouldTriggerCompaction(mode, {
					contextCompactionThreshold: config.contextCompactionThreshold,
					contextKeepRecentTokens: config.contextKeepRecentTokens,
					contextMaxContextOverride: config.contextMaxContextOverride,
					lastPrompt: effectiveLastPrompt,
					nCtx
				})
			)
				return;
		}

		const plan =
			mode === 'recent-window'
				? planCompactionRecentWindow(path, {
						keepRecentTokens: config.contextKeepRecentTokens,
						minKeptMessages: config.contextKeepMinMessages,
						minKeptUserTurns: config.contextKeepMinUserTurns,
						minSummarizeTokens: MIN_SUMMARIZE_TOKENS
					})
				: planCompaction(path, computeCompactionBudget(nCtx, config));

		if (!plan) {
			if (!auto) toast.info('No range to compact');

			return;
		}

		// Snapshot the pre-compaction path: the active array is mutated by
		// addMessageToActive below, and the pre-encode must warm the new
		// prefix (old path + cmp) without duplicating the entry.
		const preCompactionPath = [...path];
		const model = this.resolveCompactionModel(path);

		contextStatsStore.compacting = true;
		const abortController = new AbortController();
		this.compactionAbortController = abortController;

		try {
			// The shared over-target mechanism (both modes): summarize →
			// mode-specific success check → retry → user gate (the card mounts
			// as an independent row at the end of the message list; the Stop
			// button / an abort resolves it as skip).
			const summary = await this.runCompactionSummary(
				convId,
				plan,
				model,
				nCtx,
				mode,
				config,
				abortController.signal
			);

			if (!summary) {
				toast.info('Compaction skipped');

				return;
			}

			const cmp = await DatabaseService.createCompactionMessage({
				compactionMeta: {
					estimatedTokensBefore: plan.estimatedTokensBefore,
					firstKeptMessageId: plan.firstKeptMessageId,
					isSplitTurn: plan.isSplitTurn || undefined,
					model: model ?? undefined,
					summarizedCount: plan.toSummarize.length
				},
				content: `${SUMMARY_CONTENT_PREFIX} ${summary.content}`,
				convId,
				parentId: path[path.length - 1].id
			});

			if (isActive) {
				conversationsStore.addMessageToActive(cmp);
				await conversationsStore.updateCurrentNode(cmp.id);
			} else {
				await DatabaseService.updateCurrentNode(convId, cmp.id);
				conversationsStore.applyConversationUpdate(convId, { currNode: cmp.id });
			}

			conversationsStore.updateConversationTimestamp(convId);

			// Warm the KV cache with the NEW prefix so the next turn does not
			// pay a full re-prompt on top of the summary call.
			await this.triggerPreEncode(preCompactionPath, cmp, cmp.content, model);

			const estimatedAfter = plan.estimatedTokensAfter + byteLength(cmp.content);

			toast.success(`Context compacted: ~${plan.estimatedTokensBefore} → ~${estimatedAfter} tokens`);
		} catch (error) {
			// Fail-open: no cmp node was created (or it was created but the
			// state updates failed) — the conversation keeps its full context.
			if (isAbortError(error)) {
				toast.info('Compaction stopped');
			} else {
				toast.error(`Compaction failed: ${error instanceof Error ? error.message : 'unknown error'}`);
			}
		} finally {
			this.compactionAbortController = null;
			contextStatsStore.compacting = false;
		}
	}

	/**
	 * Stops the in-flight manual compaction (N3): aborts the summary call, which
	 * fails open — no cmp node is created, `compacting` resets and the UI's
	 * Stop button flips back to the normal actions. In-loop compaction is
	 * stopped through the flow's own abort, not this method.
	 */
	stopCompaction(): void {
		if (this.compactionAbortController) {
			this.compactionAbortController.abort();
		}
	}

	/**
	 * n_ctx of the conversation being compacted: the active model's context
	 * size for the active conversation, the conversation's own model (ROUTER)
	 * or the single served model otherwise.
	 */
	private getContextSizeForConversation(convId: string, path: DatabaseMessage[]): number | null {
		if (conversationsStore.activeConversation?.id === convId) {
			return contextStatsStore.contextTotal;
		}

		const modelName = getConversationModel(path) ?? modelsStore.activeModelId;

		return modelName ? modelsStore.props.getModelContextSize(modelName) : null;
	}

	/**
	 * Model for the summary call: the ROUTER selection first (mirrors
	 * streamChatCompletion), the conversation's own model as fallback; null in
	 * single-model mode (the server has exactly one model).
	 */
	private resolveCompactionModel(path: DatabaseMessage[]): string | null {
		if (!serverStore.isRouterMode) return null;

		return modelsStore.selectedModelName ?? getConversationModel(path);
	}

	/**
	 * Expands a compaction entry: the entry is deleted, its children are
	 * re-attached to its parent and the full context is restored
	 * (context-enhance/02 §4). The active conversation's message list is
	 * re-derived from the new currNode.
	 */
	async expandCompactionEntry(convId: string, cmpId: string): Promise<void> {
		if (this.isChatLoading(convId) || agenticStore.isRunning(convId)) return;

		try {
			const newCurrNode = await DatabaseService.expandCompactionMessage(convId, cmpId);

			conversationsStore.applyConversationUpdate(convId, { currNode: newCurrNode });

			if (conversationsStore.activeConversation?.id === convId) {
				await conversationsStore.refreshActiveMessages();
			}

			conversationsStore.updateConversationTimestamp(convId);
			toast.success('Full context restored');
		} catch (error) {
			console.error('Failed to expand compaction entry:', error);
			toast.error(`Expand failed: ${error instanceof Error ? error.message : 'unknown error'}`);
		}
	}

	/**
	 * Moves a compaction entry's kept-region boundary (context-enhance/02 §4):
	 * forward (kept grows) only updates the metadata — the existing summary now
	 * covers a bit more, which is harmless; backward (kept shrinks) re-summarizes
	 * the enlarged region so no message is silently lost. The new boundary must
	 * be a user or assistant message on the path (I4).
	 */
	async moveCompactionBoundary(
		convId: string,
		cmpId: string,
		newFirstKeptMessageId: string
	): Promise<void> {
		if (this.isChatLoading(convId) || agenticStore.isRunning(convId)) return;

		if (contextStatsStore.compacting) return;

		const path = await this.resolveConversationPath(convId);

		if (!path) return;

		const found = this.findCompactionEntry(path, cmpId);

		if (!found) {
			toast.info('Compaction entry not found');

			return;
		}

		const currentIndex = this.keptWindowStartOf(path, found.entry);

		if (currentIndex === -1) {
			toast.info('Compaction boundary no longer exists — compact again to recreate it');

			return;
		}

		const newIndex = path.findIndex((message) => message.id === newFirstKeptMessageId);

		if (newIndex === -1 || newIndex === currentIndex) return;

		// I4: the kept region must start on a user or assistant message, never a
		// tool result or the system prompt.
		if (path[newIndex].role !== MessageRole.USER && path[newIndex].role !== MessageRole.ASSISTANT) {
			toast.info('The boundary can only be placed before a user or assistant message');

			return;
		}

		if (newIndex <= this.headLengthOf(path)) {
			toast.info('Nothing to summarize');

			return;
		}

		const baseMeta = found.entry.compactionMeta;

		if (!baseMeta) {
			toast.info('Compaction entry is missing metadata — compact again to recreate it');

			return;
		}

		const headLength = this.headLengthOf(path);
		const metaUpdates = {
			firstKeptMessageId: newFirstKeptMessageId,
			isSplitTurn: path[newIndex].role === MessageRole.ASSISTANT || undefined,
			summarizedCount: path.slice(headLength, newIndex).length
		};

		if (newIndex < currentIndex) {
			// Forward move: metadata only — the summary already covers the region.
			const updates = {
				compactionMeta: { ...baseMeta, ...metaUpdates }
			};

			try {
				await DatabaseService.updateMessage(cmpId, updates);

				if (conversationsStore.activeConversation?.id === convId) {
					conversationsStore.updateMessageAtIndex(found.index, updates);
				}

				conversationsStore.updateConversationTimestamp(convId);
				toast.success('Boundary moved');
			} catch (error) {
				console.error('Failed to move compaction boundary:', error);
				toast.error('Failed to move boundary');
			}

			return;
		}

		// Backward move: the enlarged region must be re-summarized (02-§4).
		contextStatsStore.compacting = true;
		const abortController = new AbortController();
		this.compactionAbortController = abortController;

		try {
			const summary = await this.summarizeRegion(
				convId,
				path,
				newIndex,
				path[newIndex].role === MessageRole.ASSISTANT,
				cmpId,
				abortController.signal
			);

			if (!summary) {
				toast.info('Compaction skipped');

				return;
			}

			const model = this.resolveCompactionModel(path);
			const updates = {
				compactionMeta: {
					...baseMeta,
					...metaUpdates,
					estimatedTokensBefore: path.reduce((sum, message) => sum + estimateTokens(message), 0),
					model: model ?? undefined
				},
				content: `${SUMMARY_CONTENT_PREFIX} ${summary.content}`
			};

			await DatabaseService.updateMessage(cmpId, updates);

			if (conversationsStore.activeConversation?.id === convId) {
				conversationsStore.updateMessageAtIndex(found.index, updates);
			}

			conversationsStore.updateConversationTimestamp(convId);
			toast.success('Boundary moved — summary regenerated');
		} catch (error) {
			if (isAbortError(error)) {
				toast.info('Compaction stopped');
			} else {
				toast.error(`Boundary move failed: ${error instanceof Error ? error.message : 'unknown error'}`);
			}
		} finally {
			this.compactionAbortController = null;
			contextStatsStore.compacting = false;
		}
	}

	/**
	 * Re-summarizes the same region a compaction entry covers
	 * (path[head..boundary), including older entries per I2) and updates the
	 * entry's content and metadata in place (context-enhance/02 §4). A missing
	 * boundary (deletion/branching) is surfaced, not repaired.
	 */
	async recompactConversationEntry(convId: string, cmpId: string): Promise<void> {
		if (this.isChatLoading(convId) || agenticStore.isRunning(convId)) return;

		if (contextStatsStore.compacting) return;

		const path = await this.resolveConversationPath(convId);

		if (!path) return;

		const found = this.findCompactionEntry(path, cmpId);

		if (!found) {
			toast.info('Compaction entry not found');

			return;
		}

		const boundaryIndex = this.keptWindowStartOf(path, found.entry);

		if (boundaryIndex === -1) {
			toast.info('Compaction boundary no longer exists — compact again to recreate it');

			return;
		}

		const baseMeta = found.entry.compactionMeta;

		if (!baseMeta) {
			toast.info('Compaction entry is missing metadata — compact again to recreate it');

			return;
		}

		// The effective region excludes the entry itself (it is the summary
		// being rewritten). With an empty-kept entry the window start sits one
		// past the entry, so this is what catches a fully-deleted pre-entry
		// region — summarizing nothing would be a wasted LLM call.
		const region = path
			.slice(this.headLengthOf(path), boundaryIndex)
			.filter((message) => message.id !== cmpId);

		if (region.length === 0) {
			toast.info('Nothing to summarize');

			return;
		}

		contextStatsStore.compacting = true;
		const abortController = new AbortController();
		this.compactionAbortController = abortController;

		try {
			const summary = await this.summarizeRegion(
				convId,
				path,
				boundaryIndex,
				baseMeta.isSplitTurn === true,
				cmpId,
				abortController.signal
			);

			if (!summary) {
				toast.info('Compaction skipped');

				return;
			}

			const model = this.resolveCompactionModel(path);
			const updates = {
				compactionMeta: {
					...baseMeta,
					estimatedTokensBefore: path.reduce((sum, message) => sum + estimateTokens(message), 0),
					model: model ?? undefined
				},
				content: `${SUMMARY_CONTENT_PREFIX} ${summary.content}`
			};

			await DatabaseService.updateMessage(cmpId, updates);

			if (conversationsStore.activeConversation?.id === convId) {
				conversationsStore.updateMessageAtIndex(found.index, updates);
			}

			conversationsStore.updateConversationTimestamp(convId);
			toast.success('Summary regenerated');
		} catch (error) {
			if (isAbortError(error)) {
				toast.info('Compaction stopped');
			} else {
				toast.error(`Re-summarization failed: ${error instanceof Error ? error.message : 'unknown error'}`);
			}
		} finally {
			this.compactionAbortController = null;
			contextStatsStore.compacting = false;
		}
	}

	/**
	 * Edits a compaction entry's summary text in place (manual intervention,
	 * context-enhance/02 §4): the content is rewritten with the same prefix the
	 * node was created with; the metadata is untouched. Takes effect on the next
	 * turn's payload (the builder is WYSIWYG with the stored content).
	 */
	async updateCompactionSummary(convId: string, cmpId: string, plainText: string): Promise<void> {
		const trimmed = plainText.trim();

		if (!trimmed) return;

		if (this.isChatLoading(convId) || agenticStore.isRunning(convId)) return;

		const path = await this.resolveConversationPath(convId);

		if (!path) return;

		const found = this.findCompactionEntry(path, cmpId);

		if (!found) return;

		const content = `${SUMMARY_CONTENT_PREFIX} ${trimmed}`;

		try {
			await DatabaseService.updateMessage(cmpId, { content });

			if (conversationsStore.activeConversation?.id === convId) {
				conversationsStore.updateMessageAtIndex(found.index, { content });
			}

			conversationsStore.updateConversationTimestamp(convId);
			toast.success('Summary updated');
		} catch (error) {
			console.error('Failed to update compaction summary:', error);
			toast.error('Failed to update summary');
		}
	}

	/**
	 * Start index of the entry's kept window on the path: the boundary message
	 * when `firstKeptMessageId` exists, one past the entry when it is absent
	 * (deliberate empty kept, 02-§2). -1 only when a *present* id no longer
	 * exists (the I3 fail-open).
	 */
	private keptWindowStartOf(path: DatabaseMessage[], entry: DatabaseMessage): number {
		const boundaryId = entry.compactionMeta?.firstKeptMessageId;

		if (boundaryId === undefined) {
			return path.findIndex((message) => message.id === entry.id) + 1;
		}

		return path.findIndex((message) => message.id === boundaryId);
	}

	/** The compaction entry at `cmpId` on the path (with its index), or null. */
	private findCompactionEntry(
		path: DatabaseMessage[],
		cmpId: string
	): { entry: DatabaseMessage; index: number } | null {
		const index = path.findIndex((message) => message.id === cmpId);

		if (index === -1 || path[index].type !== MessageType.COMPACTION) return null;

		return { entry: path[index], index };
	}

	/** Length of the system-prompt head of a path (the head is never summarized, I1). */
	private headLengthOf(path: DatabaseMessage[]): number {
		return path[0]?.role === MessageRole.SYSTEM ? 1 : 0;
	}

	/**
	 * Root→leaf path of a conversation: the live array for the active
	 * conversation, DB + leaf filter otherwise (same shape as loadConversation).
	 * null when the conversation does not exist.
	 */
	private async resolveConversationPath(convId: string): Promise<DatabaseMessage[] | null> {
		const conversation = conversationsStore.conversations.find((c) => c.id === convId);

		if (!conversation) return null;

		if (conversationsStore.activeConversation?.id === convId) {
			return conversationsStore.activeMessages;
		}

		const allMessages = await conversationsStore.getConversationMessages(convId);

		return conversation.currNode
			? (filterByLeafNodeId(allMessages, conversation.currNode, false) as DatabaseMessage[])
			: allMessages;
	}

	/**
	 * The shared over-target mechanism for this store's compaction paths
	 * (compact / recompact / backward boundary move; both modes): summarize →
	 * mode-specific success check → retry (`contextSummaryMaxAttempts`) → user
	 * gate (the card mounts as an independent row at the end of the message
	 * list; the Stop button / an abort resolves it as skip).
	 *
	 * @returns The summary (success, or the user's "use it"), or null when the
	 *   user skipped — the caller must NOT create/update the entry. Throws on
	 *   summary-call failure / abort (the caller fails open).
	 */
	private async runCompactionSummary(
		convId: string,
		plan: CompactionPlan,
		model: string | null,
		nCtx: number,
		mode: CompactionMode,
		config: typeof settingsStore.config,
		signal: AbortSignal
	): Promise<SummaryResult | null> {
		return summarizeWithRetry(plan, model, signal, {
			checkParams: {
				contextKeepRecentTokens: config.contextKeepRecentTokens,
				contextKeepTargetPercent: config.contextKeepTargetPercent,
				contextMaxContextOverride: config.contextMaxContextOverride,
				nCtx
			},
			compactionMode: mode,
			excludeReasoning: config.excludeReasoningFromContext === true,
			gate: {
				requestDecision: (p) => agenticStore.requestCompactionDecision({ ...p, convId }, signal)
			},
			maxAttempts: config.contextSummaryMaxAttempts,
			// unknown context size → summarizeMessages' built-in 1024 default
			maxTokens:
				nCtx > 0
					? computeSummaryMaxTokens(nCtx, config.contextSummaryMaxTokensPercent)
					: undefined,
			mode: toSummaryMode(config.contextSummaryMode),
			prompt: config.contextSummaryPrompt.trim() || undefined
		});
	}

	/**
	 * The compaction plan for a manual re-summarization region: everything
	 * before `boundaryIndex` (the system-prompt head and the entry node itself
	 * excluded — the summary being rewritten is never part of its own input;
	 * with an empty-kept entry the window start sits one past the entry, so
	 * the filter is what keeps it out).
	 */
	private buildRegionPlan(
		path: DatabaseMessage[],
		boundaryIndex: number,
		isSplitTurn: boolean,
		entryId: string
	): CompactionPlan {
		const headLength = this.headLengthOf(path);

		return {
			cutIndex: boundaryIndex,
			estimatedTokensAfter: path
				.slice(boundaryIndex)
				.reduce((sum, message) => sum + estimateTokens(message), 0),
			estimatedTokensBefore: path.reduce((sum, message) => sum + estimateTokens(message), 0),
			firstKeptMessageId: path[boundaryIndex]?.id,
			isSplitTurn,
			kept: path.slice(boundaryIndex),
			systemHead: headLength === 1 ? path[0] : null,
			toSummarize: path.slice(headLength, boundaryIndex).filter((message) => message.id !== entryId)
		};
	}

	/**
	 * Shared summary call for the manual re-summarizations (recompact, backward
	 * boundary move): builds the region plan, resolves the model like
	 * compactConversation and runs the shared over-target mechanism (both
	 * modes). `signal` carries the stop-compaction abort (N3).
	 * Returns null when the user skipped at the gate.
	 */
	private async summarizeRegion(
		convId: string,
		path: DatabaseMessage[],
		boundaryIndex: number,
		isSplitTurn: boolean,
		entryId: string,
		signal: AbortSignal
	): Promise<SummaryResult | null> {
		const config = settingsStore.config;
		const nCtx = this.getContextSizeForConversation(convId, path);
		const plan = this.buildRegionPlan(path, boundaryIndex, isSplitTurn, entryId);

		return this.runCompactionSummary(
			convId,
			plan,
			this.resolveCompactionModel(path),
			nCtx ?? 0,
			toCompactionMode(config.contextCompactionMode),
			config,
			signal
		);
	}

	/**
	 * Record a working-directory change into chat history as a synthetic
	 * user message, so the model sees it on its next turn (the client
	 * sends the cwd itself via the x-tool-cwd header on tool calls).
	 * A plain user message is used because some chat templates reject
	 * tool messages without a preceding tool call.
	 */
	async recordCwdChange(cwd: string | null): Promise<void> {
		const content = cwd
			? formatCwdMessage(cwd, await toolsStore.resolveServerHome())
			: CWD_CLEARED_TEXT;
		// Reuse the trailing cwd row when it is already the last message, so
		// repeated picks update it in place instead of stacking another row.
		const last = conversationsStore.activeMessages[conversationsStore.activeMessages.length - 1];

		if (last && last.role === MessageRole.USER && last.isSynthetic === true) {
			await DatabaseService.updateMessage(last.id, { content, isSynthetic: true });
			conversationsStore.updateMessageAtIndex(conversationsStore.activeMessages.length - 1, {
				content,
				isSynthetic: true
			});

			return;
		}

		await this.addMessage(MessageRole.USER, content, MessageType.TEXT, '-1', undefined, true);
	}

	async regenerateMessage(messageId: string): Promise<void> {
		return this.flows.regenerateMessage(messageId);
	}

	async regenerateMessageWithBranching(messageId: string, modelOverride?: string): Promise<void> {
		return this.flows.regenerateMessageWithBranching(messageId, modelOverride);
	}

	async removeSystemPromptPlaceholder(messageId: string): Promise<boolean> {
		const activeConv = conversationsStore.activeConversation;

		if (!activeConv) return false;

		try {
			const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
			const systemMessage = findMessageById(allMessages, messageId);

			if (!systemMessage || systemMessage.role !== MessageRole.SYSTEM) return false;

			const rootMessage = allMessages.find((m) => m.type === 'root' && m.parent === null);

			if (!rootMessage) return false;

			if (allMessages.length === 2 && systemMessage.children.length === 0) {
				await conversationsStore.deleteConversation(activeConv.id);

				return true;
			}

			for (const childId of systemMessage.children) {
				await DatabaseService.updateMessage(childId, { parent: rootMessage.id });
				const childIndex = conversationsStore.findMessageIndex(childId);

				if (childIndex !== -1)
					conversationsStore.updateMessageAtIndex(childIndex, { parent: rootMessage.id });
			}
			await DatabaseService.updateMessage(rootMessage.id, {
				children: [
					...rootMessage.children.filter((id: string) => id !== messageId),
					...systemMessage.children
				]
			});
			await DatabaseService.deleteMessage(messageId);
			const systemIndex = conversationsStore.findMessageIndex(messageId);

			if (systemIndex !== -1) conversationsStore.activeMessages.splice(systemIndex, 1);

			conversationsStore.updateConversationTimestamp();

			return false;
		} catch (error) {
			console.error('Failed to remove system prompt placeholder:', error);

			return false;
		}
	}

	savePendingDraft(message: string, files: ChatUploadedFile[]): void {
		this.pendingDraftMessage = message;
		this.pendingDraftFiles = [...files];
	}
	async sendMessage(content: string, extras?: DatabaseMessageExtra[]): Promise<void> {
		if (!content.trim() && (!extras || extras.length === 0)) return;

		const activeConv = conversationsStore.activeConversation;

		// If agentic loop is running, inject as a steering message instead of starting a new flow
		if (activeConv && agenticStore.isRunning(activeConv.id)) {
			agenticStore.injectSteeringMessage(activeConv.id, content, extras);

			return;
		}

		// If non-agentic streaming is active, queue as a pending message to send after completion
		if (activeConv && this.isChatLoadingInternal(activeConv.id)) {
			this.injectPendingMessage(activeConv.id, content, extras);

			return;
		}

		// Cancel any in-flight pre-encode request
		this.cancelPreEncode();

		// Consume MCP resource attachments - converts them to extras and clears the live store
		const resourceExtras = mcpStore.consumeResourceAttachmentsAsExtras();
		const allExtras = resourceExtras.length > 0 ? [...(extras || []), ...resourceExtras] : extras;

		let isNewConversation = false;

		if (!activeConv) {
			await conversationsStore.createConversation();
			isNewConversation = true;
		}

		const currentConv = conversationsStore.activeConversation;

		if (!currentConv) return;

		this.showErrorDialog(null);
		this.setChatLoading(currentConv.id, true);
		this.clearChatStreaming(currentConv.id);
		try {
			let parentIdForUserMessage: string | undefined;

			if (isNewConversation) {
				const rootId = await DatabaseService.createRootMessage(currentConv.id);
				const currentConfig = settingsStore.config;
				const systemPrompt = currentConfig.systemMessage?.toString().trim();

				let sysOrRootId = rootId;

				if (systemPrompt) {
					const systemMessage = await DatabaseService.createSystemMessage(
						currentConv.id,
						systemPrompt,
						rootId
					);

					conversationsStore.addMessageToActive(systemMessage);
					sysOrRootId = systemMessage.id;
				}

				// Reflect a working directory picked on the new-chat screen into
				// chat history before the first user message, so the model sees
				// it on its first turn. createConversation() has already threaded
				// the pending pick onto the conversation.
				if (currentConv.cwd) {
					const cwdMessage = await this.addMessage(
						MessageRole.USER,
						formatCwdMessage(currentConv.cwd, await toolsStore.resolveServerHome()),
						MessageType.TEXT,
						sysOrRootId,
						undefined,
						true
					);

					parentIdForUserMessage = cwdMessage.id;
				} else {
					parentIdForUserMessage = sysOrRootId;
				}
			}

			const userMessage = await this.addMessage(
				MessageRole.USER,
				content,
				MessageType.TEXT,
				parentIdForUserMessage ?? '-1',
				allExtras
			);

			if (isNewConversation && content)
				await conversationsStore.applyTitleFromContent(currentConv.id, content);

			const assistantMessage = await this.createAssistantMessage(userMessage.id);

			conversationsStore.addMessageToActive(assistantMessage);
			await this.streamChatCompletion(
				conversationsStore.activeMessages.slice(0, -1),
				assistantMessage,
				undefined,
				undefined,
				undefined,
				settingsStore.config.titleGenerationUseLLM && isNewConversation ? content : undefined
			);
		} catch (error) {
			if (isAbortError(error)) {
				this.setChatLoading(currentConv.id, false);

				return;
			}

			console.error('Failed to send message:', error);
			this.setChatLoading(currentConv.id, false);
			const dialogType =
				error instanceof Error && error.name === 'TimeoutError'
					? ErrorDialogType.TIMEOUT
					: ErrorDialogType.SERVER;
			const contextInfo = (
				error as Error & { contextInfo?: { n_prompt_tokens: number; n_ctx: number } }
			).contextInfo;

			this.showErrorDialog({
				contextInfo,
				message: error instanceof Error ? error.message : 'Unknown error',
				type: dialogType
			});
		}
	}

	setChatLoading(convId: string, loading: boolean): void {
		if (loading) {
			this.activity.markLocal(convId);
		} else {
			this.activity.localEnded(convId);
			this.setChatReasoning(convId, false);
		}
	}

	setChatReasoning(convId: string, reasoning: boolean): void {
		if (reasoning) this.chatReasoningStates.set(convId, true);
		else this.chatReasoningStates.delete(convId);
	}

	setChatStreaming(
		convId: string,
		response: string,
		messageId: string,
		model?: string | null
	): void {
		this.chatStreamingStates.set(convId, {
			messageId,
			model: model ?? this.chatStreamingStates.get(convId)?.model,
			response
		});
	}

	setEditModeActive(handler: (files: File[]) => void): void {
		this.isEditModeActive = true;
		this.addFilesHandler = handler;
	}

	showErrorDialog(state: ErrorDialogState | null): void {
		this.errorDialogState = state;
	}

	async stopGeneration(): Promise<void> {
		const activeConv = conversationsStore.activeConversation;

		if (!activeConv) return;

		await this.stopGenerationForChat(activeConv.id);
	}

	async stopGenerationForChat(convId: string): Promise<void> {
		await this.savePartialResponseIfNeeded(convId);
		// tell the server to stop the generation, not just drop the HTTP socket. without this the
		// detached drain keeps producing tokens until eos or max_tokens. use the frozen identity
		// captured when the session started, not the live dropdown
		const streamStateForStop = this.chatStreamingStates.get(convId);
		const modelForStop = streamStateForStop?.model ?? ChatService.getStreamState(convId)?.model;

		void ChatService.cancelServerStream(convId, modelForStop);
		// an explicit stop leaves nothing to resume and kills a pending resume retry
		ChatService.clearStreamState(convId);
		this.streams.cancelResumeRetry(convId);
		this.abortRequest(convId);
		this.setChatLoading(convId, false);
		this.clearChatStreaming(convId);
		this.processing.setState(convId, null);
		this.clearPendingMessage(convId);
	}

	async streamChatCompletion(
		allMessages: DatabaseMessage[],
		assistantMessage: DatabaseMessage,
		onComplete?: (content: string) => Promise<void>,
		onError?: (error: Error) => void,
		modelOverride?: string | null,
		firstUserMessageContent?: string
	): Promise<void> {
		// the ::model suffix in the stream identity is only for router mode, where it routes to the
		// owning child. in single-model mode the identity stays the bare conv id so that attach, stop
		// and reattach all agree, regardless of fresh send vs regenerate passing a resolved model
		let effectiveModel: string | null | undefined = undefined;

		if (serverStore.isRouterMode) {
			const conversationModel = getConversationModel(allMessages);

			effectiveModel = modelOverride || modelsStore.selectedModelName || conversationModel;
		}

		if (serverStore.isRouterMode && effectiveModel) {
			if (!modelsStore.props.getModelProps(effectiveModel))
				await modelsStore.props.fetchModelProps(effectiveModel);
		}

		// Mutable state for the current message being streamed
		let currentMessageId = assistantMessage.id;
		let streamedContent = '';
		let streamedReasoningContent = '';
		let resolvedModel: string | null = null;
		let modelPersisted = false;

		const convId = assistantMessage.convId;

		// Tracks the last message created in this flow. Used as the parent for the next
		// turn's assistant message so createAssistantMessage does not have to read
		// conversationsStore.activeMessages, which may belong to a different conversation
		// after the user navigates while the loop is still running.
		let lastCreatedInFlow = currentMessageId;

		// freeze the POST identity from t0 so a stop cancels with the exact session key,
		// never a stale or empty model resolved later
		this.setChatStreaming(convId, streamedContent, currentMessageId, effectiveModel);

		const recordModel = (modelName: string | null | undefined, persistImmediately = true): void => {
			if (!modelName) return;

			const n = normalizeModelName(modelName);

			if (!n || n === resolvedModel) return;

			resolvedModel = n;
			const idx = conversationsStore.findMessageIndex(currentMessageId);

			conversationsStore.updateMessageAtIndex(idx, { model: n });

			if (persistImmediately && !modelPersisted) {
				modelPersisted = true;
				DatabaseService.updateMessage(currentMessageId, { model: n }).catch(() => {
					modelPersisted = false;
					resolvedModel = null;
				});
			}
		};

		let completionIdRecorded = false;

		const recordCompletionId = (id: string): void => {
			if (!id || completionIdRecorded) return;

			completionIdRecorded = true;
			const idx = conversationsStore.findMessageIndex(currentMessageId);

			conversationsStore.updateMessageAtIndex(idx, { completionId: id });
			DatabaseService.updateMessage(currentMessageId, { completionId: id }).catch(() => {
				completionIdRecorded = false;
			});
		};
		const updateStreamingUI = () => {
			this.setChatStreaming(convId, streamedContent, currentMessageId, effectiveModel);
			const idx = conversationsStore.findMessageIndex(currentMessageId);

			conversationsStore.updateMessageAtIndex(idx, { content: streamedContent });
		};
		const cleanupStreamingState = () => {
			this.setChatLoading(convId, false);
			this.clearChatStreaming(convId, currentMessageId);
			this.processing.setState(convId, null);
		};

		this.processing.setActiveConversation(convId);
		const abortController = this.getOrCreateAbortController(convId);
		const streamCallbacks: ChatStreamCallbacks = {
			createAssistantMessage: async () => {
				// Reset streaming state for new message
				streamedContent = '';
				streamedReasoningContent = '';

				const msg = await DatabaseService.createMessageBranch(
					{
						children: [],
						content: '',
						convId,
						model: resolvedModel,
						role: MessageRole.ASSISTANT,
						timestamp: Date.now(),
						toolCalls: '',
						type: MessageType.TEXT
					},
					lastCreatedInFlow
				);

				if (conversationsStore.activeConversation?.id === convId) {
					conversationsStore.addMessageToActive(msg);
				}

				currentMessageId = msg.id;
				lastCreatedInFlow = msg.id;

				return msg;
			},
			createToolResultMessage: async (
				toolCallId: string,
				content: string,
				extras?: DatabaseMessageExtra[],
				toolCwd?: string
			) => {
				const msg = await DatabaseService.createMessageBranch(
					{
						children: [],
						content,
						convId,
						extra: extras,
						role: MessageRole.TOOL,
						timestamp: Date.now(),
						toolCallId,
						toolCalls: '',
						toolCwd,
						type: MessageType.TEXT
					},
					currentMessageId
				);

				// mirror into the active store and move the node pointer only when this
				// conversation is displayed; otherwise persist the node move straight to
				// the db for the owning conv so a foreign conv's currNode stays untouched
				if (conversationsStore.activeConversation?.id === convId) {
					conversationsStore.addMessageToActive(msg);
					await conversationsStore.updateCurrentNode(msg.id);
				} else {
					await DatabaseService.updateCurrentNode(convId, msg.id);
				}

				lastCreatedInFlow = msg.id;

				return msg;
			},
			onAssistantTurnComplete: async (
				content: string,
				reasoningContent: string | undefined,
				timings: ChatMessageTimings | undefined,
				toolCalls: import('$lib/types/api').ApiChatCompletionToolCall[] | undefined
			) => {
				const updateData: Record<string, unknown> = {
					content,
					reasoningContent: reasoningContent || undefined,
					timings,
					toolCalls: toolCalls ? JSON.stringify(toolCalls) : ''
				};

				if (resolvedModel && !modelPersisted) updateData.model = resolvedModel;

				await DatabaseService.updateMessage(currentMessageId, updateData);
				const idx = conversationsStore.findMessageIndex(currentMessageId);
				const uiUpdate: Partial<DatabaseMessage> = {
					content,
					reasoningContent: reasoningContent || undefined,
					toolCalls: toolCalls ? JSON.stringify(toolCalls) : ''
				};

				if (timings) uiUpdate.timings = timings;

				if (resolvedModel) uiUpdate.model = resolvedModel;

				// touch the active ui array and node pointer only when this conversation
				// is displayed; otherwise persist the node move straight to the db so a
				// foreign conv's currNode stays untouched
				if (conversationsStore.activeConversation?.id === convId) {
					conversationsStore.updateMessageAtIndex(idx, uiUpdate);
					await conversationsStore.updateCurrentNode(currentMessageId);
				} else {
					await DatabaseService.updateCurrentNode(convId, currentMessageId);
				}
			},
			onAttachments: (messageId: string, extras: DatabaseMessageExtra[]) => {
				if (!extras.length) return;

				const idx = conversationsStore.findMessageIndex(messageId);

				if (idx === -1) return;

				const msg = conversationsStore.activeMessages[idx];
				const updatedExtras = [...(msg.extra || []), ...extras];

				conversationsStore.updateMessageAtIndex(idx, { extra: updatedExtras });
				DatabaseService.updateMessage(messageId, { extra: updatedExtras }).catch(console.error);
			},
			onChunk: (chunk: string) => {
				streamedContent += chunk;
				updateStreamingUI();
				this.setChatReasoning(convId, false);
			},
			onCompletionId: (id: string) => recordCompletionId(id),
			onError: async (error: Error) => {
				if (isAbortError(error)) {
					cleanupStreamingState();
					// If aborted with a pending message (e.g. "Send immediately"), re-send it
					const pending = this.consumePendingMessage(convId);

					if (pending) {
						this.sendMessage(pending.content, pending.extras);
					}

					return;
				}

				console.error('Streaming error:', error);
				// keep whatever was streamed so far, the message stays in memory and in DB
				await this.savePartialResponseIfNeeded(convId);
				cleanupStreamingState();
				this.clearPendingMessage(convId);

				const contextInfo = (
					error as Error & { contextInfo?: { n_prompt_tokens: number; n_ctx: number } }
				).contextInfo;

				this.showErrorDialog({
					contextInfo,
					message: error.message,
					type: error.name === 'TimeoutError' ? ErrorDialogType.TIMEOUT : ErrorDialogType.SERVER
				});

				if (onError) onError(error);
			},
			onFlowComplete: (finalTimings?: ChatMessageTimings) => {
				if (finalTimings) {
					const idx = conversationsStore.findMessageIndex(assistantMessage.id);

					conversationsStore.updateMessageAtIndex(idx, { timings: finalTimings });
					DatabaseService.updateMessage(assistantMessage.id, {
						timings: finalTimings
					}).catch(console.error);
				}

				cleanupStreamingState();

				if (onComplete) onComplete(streamedContent);

				if (serverStore.isRouterMode) modelsStore.fetchRouterModels().catch(console.error);

				// Pre-encode conversation in KV cache for faster next turn
				if (settingsStore.config.preEncodeConversation) {
					this.triggerPreEncode(
						allMessages,
						assistantMessage,
						streamedContent,
						effectiveModel,
						!!settingsStore.config.excludeReasoningFromContext
					);
				}
			},
			onModel: (modelName: string) => recordModel(modelName),
			onReasoningChunk: (chunk: string) => {
				streamedReasoningContent += chunk;
				// mark streaming state so a stop mid-thinking can persist the partial reasoning
				this.setChatStreaming(convId, streamedContent, currentMessageId, effectiveModel);
				const idx = conversationsStore.findMessageIndex(currentMessageId);

				conversationsStore.updateMessageAtIndex(idx, {
					reasoningContent: streamedReasoningContent
				});
				this.setChatReasoning(convId, true);
			},
			onTimings: (timings?: ChatMessageTimings, promptProgress?: ChatMessagePromptProgress) => {
				this.processing.applyStreamTimings(timings, promptProgress, convId);
			},
			onToolCallsStreaming: (toolCalls) => {
				const idx = conversationsStore.findMessageIndex(currentMessageId);

				conversationsStore.updateMessageAtIndex(idx, {
					toolCalls: JSON.stringify(toolCalls)
				});
			},
			onTurnComplete: (intermediateTimings: ChatMessageTimings) => {
				// Update the first assistant message with cumulative agentic timings
				const idx = conversationsStore.findMessageIndex(assistantMessage.id);

				conversationsStore.updateMessageAtIndex(idx, { timings: intermediateTimings });
			},
			updateToolResultMessage: async (
				messageId: string,
				content: string,
				extras?: DatabaseMessageExtra[]
			) => {
				// Persist latest content + merged extras; mirror into the active
				// store so the chat view sees live updates for streaming tools
				// (e.g. exec_shell_command). The existing tool message node
				// pointer stays put - the renderer is already scoped to it.
				const updates: Partial<DatabaseMessage> = { content };

				if (extras) {
					const idx = conversationsStore.findMessageIndex(messageId);
					const existing = idx >= 0 ? (conversationsStore.activeMessages[idx]?.extra ?? []) : [];
					const merged = [...existing, ...extras];

					updates.extra = merged;
				}

				if (conversationsStore.activeConversation?.id === convId) {
					const idx = conversationsStore.findMessageIndex(messageId);

					if (idx >= 0) conversationsStore.updateMessageAtIndex(idx, updates);
				}

				await DatabaseService.updateMessage(messageId, updates);
			}
		};
		const toolPolicy = {
			disabledToolCategories: conversationsStore.preferences.getDisabledToolCategories(),
			disabledTools: conversationsStore.preferences.getDisabledTools()
		};

		{
			const agenticResult = await agenticStore.runAgenticFlow({
				callbacks: streamCallbacks,
				conversationId: convId,
				flowRootMessageId: assistantMessage.id,
				messages: allMessages,
				options: {
					...this.getApiOptions(),
					...(effectiveModel ? { model: effectiveModel } : {})
				},
				signal: abortController.signal,
				toolPolicy
			});

			if (agenticResult.handled) {
				// Generate LLM based title for new conversations after agentic flow completes
				if (firstUserMessageContent) {
					await this.generateTitleWithLLM(firstUserMessageContent, streamedContent, convId);
				}

				// Check if there's a pending steering message to re-send
				const pending = agenticStore.consumePendingSteeringMessage(convId);

				if (pending) {
					await this.sendMessage(pending.content, pending.extras);
				}

				// Auto-compaction check between flows (02-data-model §6): the
				// method no-ops unless the switch is on and the last prompt
				// crossed the threshold; fire-and-forget so the completion
				// handler (and any re-send above) is not delayed by a summary call.
				void this.compactConversation(convId, { auto: true }).catch(console.error);

				return;
			}
		}

		await ChatService.sendMessage(
			allMessages,
			{
				...this.getApiOptions(),
				...(effectiveModel ? { model: effectiveModel } : {}),
				onChunk: streamCallbacks.onChunk,
				onComplete: async (
					finalContent?: string,
					reasoningContent?: string,
					timings?: ChatMessageTimings,
					toolCalls?: string
				) => {
					const content = streamedContent || finalContent || '';
					const reasoning = streamedReasoningContent || reasoningContent;
					const updateData: Record<string, unknown> = {
						content,
						reasoningContent: reasoning || undefined,
						timings,
						toolCalls: toolCalls || ''
					};

					if (resolvedModel && !modelPersisted) updateData.model = resolvedModel;

					await DatabaseService.updateMessage(currentMessageId, updateData);
					const idx = conversationsStore.findMessageIndex(currentMessageId);
					const uiUpdate: Partial<DatabaseMessage> = {
						content,
						reasoningContent: reasoning || undefined,
						toolCalls: toolCalls || ''
					};

					if (timings) uiUpdate.timings = timings;

					if (resolvedModel) uiUpdate.model = resolvedModel;

					conversationsStore.updateMessageAtIndex(idx, uiUpdate);
					await conversationsStore.updateCurrentNode(currentMessageId);
					cleanupStreamingState();

					if (onComplete) await onComplete(content);

					if (serverStore.isRouterMode) modelsStore.fetchRouterModels().catch(console.error);

					// Generate LLM based title for new conversations (avoids stale reference
					// issue when user switches conversations while streaming)
					if (firstUserMessageContent) {
						await this.generateTitleWithLLM(firstUserMessageContent, streamedContent, convId);
					}

					// Check if there's a pending message queued during streaming
					const pending = this.consumePendingMessage(convId);

					if (pending) {
						await this.sendMessage(pending.content, pending.extras);
					}

					// Auto-compaction check between flows (02-data-model §6):
					// no-op unless the switch is on and the threshold crossed.
					void this.compactConversation(convId, { auto: true }).catch(console.error);
				},
				onCompletionId: streamCallbacks.onCompletionId,
				onConnectionState: (state: StreamConnectionState) => {
					if (convId === conversationsStore.activeConversation?.id) {
						this.streamConnectionState = state;
					}
				},
				onError: streamCallbacks.onError,
				onModel: streamCallbacks.onModel,
				onReasoningChunk: streamCallbacks.onReasoningChunk,
				onTimings: streamCallbacks.onTimings,
				stream: true
			},
			convId,
			abortController.signal
		);
	}

	syncLoadingStateForChat(convId: string): void {
		const s = this.chatStreamingStates.get(convId);

		this.processing.setActiveConversation(convId);

		// Sync streaming content to activeMessages so UI displays current content
		if (s?.response && s?.messageId) {
			const idx = conversationsStore.findMessageIndex(s.messageId);

			if (idx !== -1) {
				conversationsStore.updateMessageAtIndex(idx, { content: s.response });
			}
		}
	}

	async syncRemoteRunningStreams(): Promise<void> {
		return this.streams.syncRemoteRunningStreams();
	}

	/**
	 * Message flows (edit / regenerate / continue / delete) live in
	 * ChatMessageFlows; these delegate so consumers keep a single entry point.
	 */
	async updateMessage(messageId: string, newContent: string): Promise<void> {
		return this.flows.updateMessage(messageId, newContent);
	}
	private abortRequest(convId?: string): void {
		if (convId) {
			const c = this.abortControllers.get(convId);

			if (c) {
				c.abort();
				this.abortControllers.delete(convId);
			}
		} else {
			for (const c of this.abortControllers.values()) c.abort();
			this.abortControllers.clear();
		}
	}

	private async generateTitleWithLLM(
		userContent: string,
		assistantContent: string,
		convId: string
	): Promise<void> {
		const effectiveModel =
			serverStore.isRouterMode && modelsStore.selectedModelName
				? modelsStore.selectedModelName
				: undefined;
		const configValue = settingsStore.config;
		const titlePromptTemplate =
			typeof configValue.titleGenerationPrompt === 'string' &&
			configValue.titleGenerationPrompt.trim()
				? configValue.titleGenerationPrompt
				: TITLE_GENERATION.DEFAULT_PROMPT;
		const titlePrompt = titlePromptTemplate
			.replace('{{USER}}', String(userContent || ''))
			.replace('{{ASSISTANT}}', String(assistantContent || ''));
		const titleMessage: ApiChatMessageData = {
			content: titlePrompt,
			role: MessageRole.USER
		};
		const titleResponse = await ChatService.generateTitle(titleMessage, effectiveModel);

		if (!titleResponse) {
			return;
		}

		let cleanTitle = titleResponse.trim();

		cleanTitle = cleanTitle
			.replace(TITLE_GENERATION.PREFIX_PATTERN, '')
			.replace(TITLE_GENERATION.QUOTE_PATTERN, '')
			.trim();

		if (!cleanTitle || cleanTitle.length < TITLE_GENERATION.MIN_LENGTH) {
			const firstLine = userContent.split('\n').find((l) => l.trim().length > 0);

			cleanTitle = firstLine ? firstLine.trim() : TITLE_GENERATION.FALLBACK;
		}

		if (cleanTitle && cleanTitle.length >= TITLE_GENERATION.MIN_LENGTH) {
			await conversationsStore.updateConversationName(convId, cleanTitle);
		}
	}

	private getChatStreamingState(
		convId: string
	): { response: string; messageId: string } | undefined {
		return this.chatStreamingStates.get(convId);
	}

	private async savePartialResponseIfNeeded(convId?: string): Promise<void> {
		const conversationId = convId || conversationsStore.activeConversation?.id;

		if (!conversationId) return;

		const streamingState = this.getChatStreamingState(conversationId);

		if (!streamingState) return;

		const messages =
			conversationId === conversationsStore.activeConversation?.id
				? conversationsStore.activeMessages
				: await conversationsStore.getConversationMessages(conversationId);

		if (!messages.length) return;

		const lastMessage = messages[messages.length - 1];

		if (lastMessage?.role !== MessageRole.ASSISTANT) return;

		const partialContent = streamingState.response;
		const partialReasoning = lastMessage.reasoningContent || '';
		// snapshot the streamed tool calls before clearing so we still know whether
		// anything was captured when deciding to skip the DB write below
		const hadPartialToolCalls = !!lastMessage.toolCalls?.trim();

		// nothing to persist when content, reasoning, and streamed tool calls are all empty
		// (e.g. stop before any token). otherwise drop the partial tool call and write whatever
		// was streamed: incomplete arguments (truncated JSON, missing closing quote) would
		// otherwise be re-sent to the server on the next turn and rejected.
		if (!partialContent.trim() && !partialReasoning.trim() && !hadPartialToolCalls) return;

		try {
			const updateData: {
				content?: string;
				reasoningContent?: string;
				toolCalls?: string;
				timings?: ChatMessageTimings;
			} = {
				toolCalls: ''
			};

			if (partialContent.trim()) updateData.content = partialContent;

			if (partialReasoning.trim()) updateData.reasoningContent = partialReasoning;

			const lastKnownState = this.processing.getState(conversationId);

			if (lastKnownState) {
				updateData.timings = {
					cache_n: lastKnownState.cacheTokens || 0,
					predicted_ms:
						lastKnownState.tokensPerSecond && lastKnownState.tokensDecoded
							? (lastKnownState.tokensDecoded / lastKnownState.tokensPerSecond) * 1000
							: undefined,
					predicted_n: lastKnownState.tokensDecoded || 0,
					prompt_ms: lastKnownState.promptMs,
					prompt_n: lastKnownState.promptTokens || 0
				};
			}

			await DatabaseService.updateMessage(lastMessage.id, updateData);
			lastMessage.content = partialContent;
			// mirror the drop into the in-memory message so the next request sent via
			// sendMessage (queued pending, Send immediately, or manual follow-up) reads
			// the cleared value, not whatever the streaming widget had been showing
			lastMessage.toolCalls = '';

			if (updateData.timings) lastMessage.timings = updateData.timings;
		} catch (error) {
			lastMessage.content = partialContent;
			lastMessage.toolCalls = '';
			console.error('Failed to save partial response:', error);
		}
	}

	private async triggerPreEncode(
		allMessages: DatabaseMessage[],
		assistantMessage: DatabaseMessage,
		assistantContent: string,
		model?: string | null,
		excludeReasoning?: boolean
	): Promise<void> {
		this.cancelPreEncode();
		this.preEncodeAbortController = new AbortController();

		const signal = this.preEncodeAbortController.signal;

		try {
			const allIdle = await ChatService.areAllSlotsIdle(model, signal);

			if (!allIdle || signal.aborted) return;

			const messagesWithAssistant: DatabaseMessage[] = [
				...allMessages,
				{ ...assistantMessage, content: assistantContent }
			];

			await ChatService.preEncode(messagesWithAssistant, model, excludeReasoning, signal);
		} catch (err) {
			if (!isAbortError(err)) {
				console.warn('[ChatStore] Pre-encode failed:', err);
			}
		}
	}
}

export const chatStore = new ChatStore();
