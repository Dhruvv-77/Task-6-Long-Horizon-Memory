import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVAL_WORKING_CONFIG } from '../src/config.js';
import { AgentLoop, isStuckLoop, type LoopOptions } from '../src/agent/loop.js';
import { PersistentMemoryStore } from '../src/memory/persistent.js';
import { DiskStore } from '../src/store/disk.js';
import type { ScriptStep } from '../src/types.js';

function harness(script: ScriptStep[], extra?: Partial<LoopOptions>) {
  const dir = mkdtempSync(join(tmpdir(), 'task6-loop-'));
  const store = new DiskStore(dir);
  const persistent = new PersistentMemoryStore(store, 'run-1');
  const base: LoopOptions = {
    task: 'rename the auth module',
    strategy: 'tiered_memory',
    store,
    persistent,
    config: EVAL_WORKING_CONFIG,
    script,
    runId: 'run-1',
    ...extra,
  };
  return new AgentLoop(base);
}

const read = (output: string): ScriptStep => ({ tool: 'read_file', args: { path: 'a.ts' }, output });
const finish = (answer: string): ScriptStep => ({ tool: 'finish', args: { answer }, output: answer });

describe('AgentLoop', () => {
  it('completes a short script and returns the final answer', async () => {
    const loop = harness([read('contents'), finish('done: renamed')]);
    const result = await loop.run();
    expect(result.completed).toBe(true);
    expect(result.reason).toBe('finished');
    expect(result.finalAnswer).toBe('done: renamed');
  });

  it('no_memory fails past the cap instead of forgetting', async () => {
    const big = 'x'.repeat(800);
    const script = [0, 1, 2, 3].map(
      (i): ScriptStep => ({ tool: 'read_file', args: { path: `big${i}.ts` }, output: big }),
    );
    script.push(finish('done'));
    const loop = harness(script, { strategy: 'no_memory' });
    const result = await loop.run();
    expect(result.completed).toBe(false);
    expect(result.reason).toBe('budget_exceeded');
    expect(result.maxUsageRatio).toBeGreaterThan(1);
  });

  it('naive_truncation survives the same workload by dropping old context', async () => {
    const big = 'x'.repeat(800);
    const script = [0, 1, 2, 3].map(
      (i): ScriptStep => ({ tool: 'read_file', args: { path: `big${i}.ts` }, output: big }),
    );
    script.push(finish('done'));
    const loop = harness(script, { strategy: 'naive_truncation' });
    const result = await loop.run();
    expect(result.completed).toBe(true);
    expect(result.maxUsageRatio).toBeLessThanOrEqual(1);
  });

  it('detects triple repeats and two-call ping-pongs as stuck', () => {
    expect(isStuckLoop(['a', 'a'])).toBe(false);
    expect(isStuckLoop(['a', 'a', 'a'])).toBe(true);
    expect(isStuckLoop(['a', 'b', 'a'])).toBe(false);
    expect(isStuckLoop(['a', 'b', 'a', 'b'])).toBe(true);
    expect(isStuckLoop(['a', 'a', 'a', 'a'])).toBe(true);
  });

  it('aborts a two-call ping-pong without burning the budget', async () => {
    const a: ScriptStep = { tool: 'read_file', args: { path: 'x.ts' }, output: 'missing' };
    const b: ScriptStep = { tool: 'list_dir', args: { dir: 'y' }, output: 'missing' };
    const loop = harness([{ ...a }, { ...b }, { ...a }, { ...b }, finish('done')]);
    const result = await loop.run();
    expect(result.completed).toBe(false);
    expect(result.reason).toBe('stuck_loop');
  });

  it('aborts a stuck loop repeating the identical call three times', async () => {
    const same: ScriptStep = { tool: 'grep', args: { pattern: 'auth' }, output: 'hit' };
    const loop = harness([{ ...same }, { ...same }, { ...same }, finish('done')]);
    const result = await loop.run();
    expect(result.completed).toBe(false);
    expect(result.reason).toBe('stuck_loop');
  });

  it('fails loudly on an approval-gate violation', async () => {
    const loop = harness([
      { tool: 'propose_edit', args: { path: '../outside.ts', diff: 'evil' }, output: '' },
      finish('done'),
    ]);
    const result = await loop.run();
    expect(result.completed).toBe(false);
    expect(result.reason).toBe('approval_violation');
  });

  it('persists remember_fact calls and records decisions', async () => {
    const loop = harness([
      {
        tool: 'remember_fact',
        args: { key: 'decision:export-style', text: 'keep public export names stable' },
        output: 'remembered',
      },
      finish('done'),
    ]);
    const result = await loop.run();
    expect(result.completed).toBe(true);
    expect(result.decisions).toContain('keep public export names stable');
  });
});
