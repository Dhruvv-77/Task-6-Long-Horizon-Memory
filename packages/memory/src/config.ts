/**
 * Budgets, thresholds and constants. Token counting is a deliberate
 * `ceil(chars/4)` estimate (DESIGN.md open question) so behaviour is
 * identical across strategies and reproducible without a tokenizer.
 */

export interface WorkingMemoryConfig {
  maxTokens: number;
  maxMessages: number;
  compactionThreshold: number;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Production default: the current step's context, bounded, always fits. */
export const DEFAULT_WORKING_CONFIG: WorkingMemoryConfig = {
  maxTokens: 4000,
  maxMessages: 12,
  compactionThreshold: 0.75,
};

/** Smaller caps so the deterministic eval forces compaction quickly. */
export const EVAL_WORKING_CONFIG: WorkingMemoryConfig = {
  maxTokens: 1500,
  maxMessages: 8,
  compactionThreshold: 0.7,
};

/** RRF fusion constant, per the Task 2 brief. */
export const RRF_K = 60;

/** Default number of persistent facts retrieved per step. */
export const DEFAULT_TOP_K = 5;

/** On-disk state directory for checkpoints, facts and summaries. */
export const MEMORY_DIR = '.memory';

/** Hard stop so a runaway scripted run cannot loop forever. */
export const DEFAULT_MAX_STEPS = 40;
