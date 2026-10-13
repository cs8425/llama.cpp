/**
 * Context management (compaction) — pure core.
 *
 * `buildLlmContext` is the single choke point for "what gets sent to the LLM";
 * `planCompaction` / `estimateTokens` decide where a compaction cuts;
 * `summarizeMessages` produces the summary text.
 */

export { buildLlmContext, findLastCompactionEntry } from './context-builder';
export { estimateTokens, planCompaction } from './compaction-policy';
export {
	buildSummaryTranscript,
	DEFAULT_SUMMARY_PROMPT,
	SPLIT_TURN_SUMMARY_PROMPT,
	SUMMARY_CONTENT_PREFIX,
	summarizeMessages
} from './summarize';
export type { SummarizeOptions } from './summarize';
export type {
	CompactionBudget,
	CompactionPlan,
	ContextBuildOptions,
	ContextBuildResult,
	ContextCompactionInfo
} from './types';
