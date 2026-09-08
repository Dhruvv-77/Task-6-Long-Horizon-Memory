import { DEFAULT_WORKING_CONFIG, estimateTokens, type WorkingMemoryConfig } from '../config.js';
import type { WorkingMessage } from '../types.js';

/**
 * Working memory: the current step's context, bounded, always fits.
 * `usageRatio()` is the max of the token and message ratios. Compaction is
 * requested at the threshold; only a ratio strictly above 1.0 is overflow.
 */
export class WorkingMemory {
  readonly config: WorkingMemoryConfig;
  messages: WorkingMessage[] = [];

  constructor(config: WorkingMemoryConfig = DEFAULT_WORKING_CONFIG) {
    this.config = config;
  }

  add(input: Omit<WorkingMessage, 'tokens'> & { tokens?: number }): WorkingMessage {
    const message: WorkingMessage = {
      ...input,
      tokens:
        input.tokens ??
        estimateTokens(input.content) +
          (input.toolCall ? estimateTokens(JSON.stringify(input.toolCall)) : 0),
    };
    this.messages.push(message);
    return message;
  }

  tokenCount(): number {
    return this.messages.reduce((sum, m) => sum + m.tokens, 0);
  }

  usageRatio(): number {
    return Math.max(
      this.tokenCount() / this.config.maxTokens,
      this.messages.length / this.config.maxMessages,
    );
  }

  needsCompaction(): boolean {
    return this.usageRatio() >= this.config.compactionThreshold;
  }

  isOverflowing(): boolean {
    return this.usageRatio() > 1;
  }

  /**
   * Naive truncation: drop oldest non-system messages until back under budget.
   * System messages (including compaction summaries) are never dropped here.
   * Returns the number of removed messages.
   */
  truncateNaive(): number {
    let removed = 0;
    while (this.isOverflowing()) {
      const idx = this.messages.findIndex((m) => m.role !== 'system');
      if (idx === -1) break;
      this.messages.splice(idx, 1);
      removed += 1;
    }
    return removed;
  }
}
