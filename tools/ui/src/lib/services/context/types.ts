/**
 * Context management (compaction) core types.
 *
 * Pure data shapes shared by the context builder, the compaction policy and
 * the summary helpers. No store imports allowed in this directory — the
 * pure functions here must stay unit-testable without any Svelte runtime.
 */

import type { ApiChatMessageData } from '$lib/types/api';
import type { DatabaseMessage } from '$lib/types/database';

/**
 * Budget and safety limits for compaction cut-point selection.
 */
export interface CompactionBudget {
	/** Max estimated tokens for the kept suffix (path[cutIndex..end]). */
	keepBudgetTokens: number;
	/** Boundary cut: minimum number of user messages that must stay in the kept region (I5). */
	minKeptUserTurns: number;
	/**
	 * Split cut: minimum total messages that must stay in the kept region (I5).
	 * 0 = an empty kept region is allowed (the cut may land after the last
	 * message, compacting everything).
	 */
	minKeptMessages: number;
	/**
	 * Minimum estimated tokens in the summarize region (path[systemStart..cutIndex));
	 * smaller regions are not worth a summary round-trip.
	 */
	minSummarizeTokens: number;
}

/**
 * Result of {@link planCompaction}: where to cut and what to summarize.
 */
export interface CompactionPlan {
	/**
	 * Cut before `path[cutIndex]`; that message's role is user or assistant
	 * (I4), never a tool result. `cutIndex = path.length` = cut after the last
	 * message (empty kept region — split cuts only, I5 with minKeptMessages 0).
	 */
	cutIndex: number;
	/** true = split user-message span (the cut landed inside a single span, or after the last message). */
	isSplitTurn: boolean;
	/**
	 * id of `path[cutIndex]` — the start of the send window; **absent when
	 * `cutIndex = path.length` (empty kept region, everything compacted)**.
	 */
	firstKeptMessageId?: string;
	/**
	 * The system-prompt head (`path[0]` when it is a SYSTEM message), sent first
	 * in the prefix-stable summary payload so its prefix matches the main
	 * conversation payload; null when the path has no system prompt.
	 */
	systemHead: DatabaseMessage | null;
	/** `path[systemStart..cutIndex)` — messages to summarize; never includes the system prompt (I1). */
	toSummarize: DatabaseMessage[];
	/** `path[cutIndex..end]` — messages kept verbatim. */
	kept: DatabaseMessage[];
	/** Estimated tokens of the full path before compaction. */
	estimatedTokensBefore: number;
	/**
	 * Estimated tokens of the kept window after compaction.
	 * Excludes the not-yet-existing summary text; the real "after" size is
	 * computable once the summary is produced.
	 */
	estimatedTokensAfter: number;
}

/**
 * Compaction state of a built context, for the inspector / gauge.
 */
export interface ContextCompactionInfo {
	/** id of the compaction entry node that is in effect (the last one on the path, I2). */
	entryId: string;
	/**
	 * The boundary id the entry claims. **Absent = empty kept region** (a
	 * deliberate state: kept = the messages after the entry, usually none) —
	 * NOT a fail-open. A present id that no longer exists is the fail-open.
	 */
	firstKeptMessageId?: string;
	/**
	 * Number of path messages (excluding the system prompt head) dropped from
	 * the payload and covered by the summary. The in-effect entry itself is the
	 * summary, not a dropped message, so it is not counted.
	 */
	droppedCount: number;
	/**
	 * false = the boundary id exists but no longer does on the path; the full
	 * path was sent instead (fail-open, I3). The inspector must surface this.
	 * An absent id is a valid empty kept region, not an invalid boundary.
	 */
	boundaryValid: boolean;
}

/**
 * Result of {@link buildLlmContext}: the exact payload that goes to the LLM
 * plus the compaction state that produced it.
 */
export interface ContextBuildResult {
	/** The exact API payload (converted, attachments → content parts). */
	messages: ApiChatMessageData[];
	/** null = no compaction entry on the path (plain full-context send). */
	compaction: ContextCompactionInfo | null;
	/** Estimated tokens of the payload, from the same estimator as the policy. */
	estimatedTokens: number;
}

/**
 * Options for {@link buildLlmContext}.
 */
export interface ContextBuildOptions {
	/**
	 * When true, `reasoning_content` is stripped from the result, mirroring the
	 * existing `excludeReasoningFromContext` switch so the inspector can show
	 * the exact outgoing payload.
	 */
	excludeReasoning?: boolean;
}
