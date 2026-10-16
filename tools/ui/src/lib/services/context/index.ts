/**
 * Context management (compaction) — pure core.
 *
 * `buildLlmContext` is the single choke point for "what gets sent to the LLM";
 * `planCompaction` (mode B) / `planCompactionRecentWindow` (mode A) decide
 * where a compaction cuts; `summarizeMessages` / `summarizeWithRetry` produce
 * the summary text (the latter runs the shared over-target mechanism:
 * success check → retry → user gate).
 */

export { buildLlmContext, findLastCompactionEntry } from './context-builder';
export {
	computeCompactionBudget,
	computeEffectiveWindow,
	computeSummaryMaxTokens,
	estimateApiMessageTokens,
	estimateCompactionSavings,
	estimateTokens,
	byteLength,
	evaluateCompactionResult,
	MIN_SUMMARIZE_TOKENS,
	nextCompactionStep,
	planCompaction,
	planCompactionRecentWindow,
	resolveSummarySize,
	shouldTriggerCompaction,
	toCompactionMode
} from './compaction-policy';
export type {
	CompactionCheckParams,
	CompactionCheckResult,
	CompactionSettings,
	CompactionTriggerParams,
	RecentWindowOptions
} from './compaction-policy';
export {
	buildSummaryTranscript,
	DEFAULT_SUMMARY_PROMPT,
	SPLIT_TURN_SUMMARY_PROMPT,
	SUMMARY_CONTENT_PREFIX,
	summarizeMessages,
	summarizeWithRetry,
	toSummaryMode
} from './summarize';
export type {
	CompactionSummaryGate,
	SummaryMode,
	SummaryResult,
	SummarizeOptions,
	SummarizeWithRetryOptions
} from './summarize';
export type {
	CompactionBudget,
	CompactionDecision,
	CompactionMode,
	CompactionPlan,
	ContextBuildOptions,
	ContextBuildResult,
	ContextCompactionInfo
} from './types';
