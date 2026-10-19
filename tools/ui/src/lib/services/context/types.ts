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
 * Compaction mode (`contextCompactionMode` setting, 2026-10-17 dual-mode spec,
 * context-enhance/02 §3.3):
 * - `recent-window` (A): keep the most recent messages verbatim
 *   (at least `contextKeepRecentTokens` of byte count, walked back from the
 *   last message) and summarize the rest; triggers at `window − keep`, where
 *   window = min(n_ctx, `contextMaxContextOverride`);
 * - `threshold-target` (B = v3 + N6, **default**): kept suffix ≤ (threshold − keepTarget)%
 *   × n_ctx; success = head + summary ≤ keepTarget% × n_ctx.
 *
 * The mode only shapes the cut-point decision (trigger / planner / success
 * check); existing compaction entries are mode-agnostic (the builder applies
 * them the same way in both modes).
 */
export type CompactionMode = 'recent-window' | 'threshold-target';

/**
 * The user's answer to the over-target compaction gate (both modes share the
 * mechanism; only the success formula differs, context-enhance/02 §6):
 * - `use`: accept the over-target summary and create the entry;
 * - `retry`: run the summary loop again with a fresh attempt counter;
 * - `skip`: do not compact (the full context is kept).
 * Aborting the flow / the stop-compaction controller while the gate is open
 * resolves as `skip` (fail-open).
 */
export type CompactionDecision = 'use' | 'retry' | 'skip';

/**
 * Budget and safety limits for compaction cut-point selection (v4: all
 * counts are real tokens — 02-data-model §3.4).
 */
export interface CompactionBudget {
	/** Max real tokens for the kept suffix (path[cutIndex..end]). */
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
	 * Minimum real tokens in the summarize region (path[systemStart..cutIndex));
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
	/**
	 * Real tokens of the full path before compaction (v4): the system head
	 * counts 0 (folded into the first segment total) and the not-yet-sent
	 * tail is estimated at bytes/4.
	 */
	estimatedTokensBefore: number;
	/**
	 * Real tokens of the kept window after compaction (excludes the
	 * not-yet-existing summary text; the real "after" size is computable once
	 * the summary is produced).
	 */
	estimatedTokensAfter: number;
	/**
	 * Real tokens of the kept region (path[cutIndex..end], the tail at
	 * bytes/4). The success check (evaluateCompactionResult) prices the
	 * post-compaction context as summary + kept.
	 */
	keptTokens: number;
	/**
	 * Per-message real token map of the path at plan time
	 * (deriveRealMessageTokens); the success check and the inspector read
	 * per-message sizes from it.
	 */
	realMessageTokens: Map<string, number>;
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
 * One row of the built payload: the API message plus the DB id it was
 * converted from (the compaction entry's id for the summary row). The
 * inspector maps rows back to the per-message real tokens through it; the
 * send path strips the field when serializing (it never reaches the wire).
 */
export interface ContextPayloadMessage extends ApiChatMessageData {
	/** DB id of the message this API message was converted from. */
	sourceId?: string;
}

/**
 * Result of {@link buildLlmContext}: the exact payload that goes to the LLM
 * plus the compaction state that produced it.
 */
export interface ContextBuildResult {
	/** The exact API payload (converted, attachments → content parts), each row tagged with its source id. */
	messages: ContextPayloadMessage[];
	/** null = no compaction entry on the path (plain full-context send). */
	compaction: ContextCompactionInfo | null;
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
