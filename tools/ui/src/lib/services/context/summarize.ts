/**
 * Summary generation for compaction.
 *
 * `buildSummaryTranscript` is pure (unit-tested); `summarizeMessages` is the
 * one async LLM call — a non-streaming `ChatService.sendMessage`, same pattern
 * as `generateTitleWithLLM`. On failure the caller must NOT create the
 * compaction node (fail-open: keep the full context).
 */

import { AttachmentType, MessageRole } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import { formatFileSize } from '$lib/utils/formatters';
import type { CompactionPlan } from './types';

/**
 * Fixed prefix stored in the compaction entry's content so the model knows the
 * message is a summary, not a user turn. Applied at node creation (Phase 1),
 * not by the builder — the builder must stay WYSIWYG with the stored content.
 */
export const SUMMARY_CONTENT_PREFIX = '[Conversation summary — earlier messages were compacted]';

/** Default system prompt for the summary call (overridable via settings). */
export const DEFAULT_SUMMARY_PROMPT = `Summarize the conversation so far for future context. Preserve, concretely:
1) decisions and their reasons,
2) facts, names, paths, URLs,
3) code changes / file operations performed,
4) tool results that matter,
5) open tasks and constraints.
Be dense; drop small talk.`;

/**
 * Variant used when the cut splits a single user-message span
 * (`isSplitTurn = true`): the value of the summarized half is not "history"
 * but "in-progress state" — what the agent is doing and how far it got.
 */
export const SPLIT_TURN_SUMMARY_PROMPT = `Summarize for future context, in two parts:
(a) Earlier conversation: decisions, facts, paths, completed work.
(b) In-progress turn (prefix only): the current task goal (the user's request,
verbatim if short), steps already taken, files touched, tool results that
matter, and the likely next step.
Be dense; drop small talk.`;

/** Options for {@link summarizeMessages}. */
export interface SummarizeOptions {
	/** Max tokens for the summary (default 1024). */
	maxTokens?: number;
	/** Sampling temperature (default 0.2 — dense, low-creativity). */
	temperature?: number;
	/** Custom summary instruction; overrides the default / split-turn prompt. */
	prompt?: string;
}

/**
 * Renders the summarize region as a plain-text transcript for the summary
 * call. Attachments become placeholders (never base64) so the summary prompt
 * stays small; tool calls are reduced to their names.
 */
export function buildSummaryTranscript(messages: DatabaseMessage[]): string {
	return messages
		.map((message) => {
			const parts: string[] = [];

			for (const extra of message.extra ?? []) {
				parts.push(attachmentPlaceholder(extra));
			}

			if (message.toolCalls) {
				parts.push(`[tool_calls: ${summarizeToolCalls(message.toolCalls)}]`);
			}

			const content = message.content.trim();

			if (content) {
				parts.push(content);
			}

			return parts.length > 0 ? `[${message.role}] ${parts.join('\n')}` : '';
		})
		.filter((line) => line.length > 0)
		.join('\n\n');
}

function attachmentPlaceholder(extra: DatabaseMessageExtra): string {
	switch (extra.type) {
		case AttachmentType.IMAGE:
			return `[image: ${extra.name}]`;
		case AttachmentType.PDF:
			return extra.processedAsImages
				? `[pdf: ${extra.name}, ${extra.images?.length ?? 0} pages as images]`
				: `[pdf: ${extra.name}]`;
		case AttachmentType.AUDIO:
			return `[audio: ${extra.name}]`;
		case AttachmentType.VIDEO:
			return `[video: ${extra.name}]`;
		default:
			// TEXT / LEGACY_CONTEXT / MCP_PROMPT / MCP_RESOURCE
			return `[file: ${extra.name}${extra.size ? `, ${formatFileSize(extra.size)}` : ''}]`;
	}
}

function summarizeToolCalls(toolCallsJson: string): string {
	try {
		const parsed: unknown = JSON.parse(toolCallsJson);

		if (Array.isArray(parsed) && parsed.length > 0) {
			const names = parsed
				.map((call) => (call && typeof call === 'object' ? (call as { name?: unknown }).name : undefined))
				.filter((name): name is string => typeof name === 'string' && name.length > 0);

			if (names.length > 0) return names.join(', ');
		}
	} catch {
		// malformed JSON — fall through to the generic placeholder
	}

	return 'unparsed';
}

/**
 * Runs the summary LLM call for a compaction plan.
 *
 * @param plan - The plan whose `toSummarize` region gets summarized.
 * @param model - Model to use (the conversation's model; required in ROUTER mode).
 * @param signal - Abort signal (bound to the flow abort for mid-loop compaction).
 * @param options - maxTokens / temperature / custom prompt.
 * @returns The summary text (trimmed). Throws on any failure — the caller must
 *   treat that as "do not compact".
 */
export async function summarizeMessages(
	plan: CompactionPlan,
	model: string | null,
	signal?: AbortSignal,
	options: SummarizeOptions = {}
): Promise<string> {
	const systemPrompt =
		options.prompt?.trim() || (plan.isSplitTurn ? SPLIT_TURN_SUMMARY_PROMPT : DEFAULT_SUMMARY_PROMPT);
	const transcript = buildSummaryTranscript(plan.toSummarize);

	const response = await ChatService.sendMessage(
		[
			{ content: systemPrompt, role: MessageRole.SYSTEM },
			{ content: transcript, role: MessageRole.USER }
		],
		{
			max_tokens: options.maxTokens ?? 1024,
			model: model ?? undefined,
			stream: false,
			temperature: options.temperature ?? 0.2
		},
		undefined,
		signal
	);

	const summary = typeof response === 'string' ? response.trim() : '';

	if (!summary) {
		throw new Error('Summary generation returned an empty response');
	}

	return summary;
}
