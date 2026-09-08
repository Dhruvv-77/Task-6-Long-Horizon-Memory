import { describe, expect, it } from 'vitest';
import { EVAL_WORKING_CONFIG, estimateTokens } from '../src/config.js';
import { WorkingMemory } from '../src/memory/working.js';

function msg(content: string, step = 0, role: 'user' | 'assistant' | 'tool' | 'system' = 'user') {
  return { role, content, step };
}

describe('WorkingMemory accounting', () => {
  it('counts tokens for content plus tool-call JSON', () => {
    const wm = new WorkingMemory(EVAL_WORKING_CONFIG);
    const toolCall = { id: 'c1', name: 'read_file' as const, arguments: { path: 'a.ts' } };
    wm.add({ ...msg('hello'), toolCall });
    expect(wm.tokenCount()).toBe(
      estimateTokens('hello') + estimateTokens(JSON.stringify(toolCall)),
    );
  });

  it('reports usage as the max of the token and message ratios', () => {
    const wm = new WorkingMemory({ maxTokens: 100, maxMessages: 10, compactionThreshold: 0.75 });
    wm.add(msg('x'.repeat(200))); // 50 tokens of 100 -> 0.5; 1 of 10 msgs -> 0.1
    expect(wm.usageRatio()).toBeCloseTo(0.5);
  });
});

describe('WorkingMemory limits', () => {
  it('requests compaction at the threshold but overflows only past the cap', () => {
    const wm = new WorkingMemory({ maxTokens: 100, maxMessages: 100, compactionThreshold: 0.75 });
    wm.add(msg('x'.repeat(300))); // 75 tokens -> ratio 0.75
    expect(wm.needsCompaction()).toBe(true);
    expect(wm.isOverflowing()).toBe(false);
    wm.add(msg('y'.repeat(120))); // +30 tokens -> 105/100, past the cap
    expect(wm.isOverflowing()).toBe(true);
  });

  it('naive truncation drops oldest non-system messages and keeps system ones', () => {
    const wm = new WorkingMemory({ maxTokens: 10, maxMessages: 3, compactionThreshold: 0.75 });
    wm.add(msg('system prompt', 0, 'system'));
    wm.add(msg('old step one'));
    wm.add(msg('old step two'));
    wm.add(msg('newest'));
    expect(wm.isOverflowing()).toBe(true);
    wm.truncateNaive();
    expect(wm.isOverflowing()).toBe(false);
    expect(wm.messages[0].role).toBe('system');
    expect(wm.messages.some((m) => m.content === 'old step one')).toBe(false);
    expect(wm.messages.some((m) => m.content === 'newest')).toBe(true);
  });
});
