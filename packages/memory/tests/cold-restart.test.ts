import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVAL_WORKING_CONFIG } from '../src/config.js';
import { AgentLoop, SimulatedCrash, type LoopOptions } from '../src/agent/loop.js';
import { PersistentMemoryStore } from '../src/memory/persistent.js';
import { DiskStore } from '../src/store/disk.js';
import type { ScriptStep } from '../src/types.js';

function workScript(): ScriptStep[] {
  const steps: ScriptStep[] = [];
  for (let i = 1; i <= 6; i++) {
    steps.push({
      tool: 'propose_edit',
      args: { path: `src/auth/file${i}.ts`, diff: `rename ${i}` },
      output: `edited file${i}`,
      completes: `file${i}`,
    });
  }
  steps.push({ tool: 'finish', args: { answer: 'all 6 files renamed' }, output: 'all 6 files renamed' });
  return steps;
}

function resumeHarness(dir: string, script: ScriptStep[], extra?: Partial<LoopOptions>) {
  const store = new DiskStore(dir);
  return new AgentLoop({
    task: 'rename the auth module',
    strategy: 'tiered_memory',
    store,
    persistent: new PersistentMemoryStore(store, 'run-2'),
    config: EVAL_WORKING_CONFIG,
    script,
    runId: 'run-2',
    ...extra,
  });
}

describe('cold restart', () => {
  it('resumes between steps without repeating completed work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task6-crash-'));
    const script = workScript();
    const first = resumeHarness(dir, script, { runId: 'run-1', killAfterStep: 3 });
    await expect(first.run()).rejects.toBeInstanceOf(SimulatedCrash);

    const second = resumeHarness(dir, script);
    const result = await second.run();
    expect(result.completed).toBe(true);
    expect(result.finalAnswer).toBe('all 6 files renamed');
    expect(result.stepsExecuted).toBe(4); // steps 4-6 plus finish
    expect(result.completedWork).toEqual(['file1', 'file2', 'file3', 'file4', 'file5', 'file6']);
  });

  it('a mid-tool-call kill executes the pending call exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task6-crash-'));
    const script = workScript();
    const first = resumeHarness(dir, script, {
      runId: 'run-1',
      killAfterStep: 2,
      killMidToolCall: true,
    });
    await expect(first.run()).rejects.toBeInstanceOf(SimulatedCrash);

    const second = resumeHarness(dir, script);
    const result = await second.run();
    expect(result.completed).toBe(true);
    expect(result.completedWork).toEqual(['file1', 'file2', 'file3', 'file4', 'file5', 'file6']);
    const store = new DiskStore(dir);
    const ids = store.loadCheckpoint()!.executedCallIds;
    expect(new Set(ids).size).toBe(ids.length); // no duplicate execution
  });

  it('a kill after execute but before checkpointing never double-applies the edit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task6-crash-'));
    const script = workScript();
    const first = resumeHarness(dir, script, { runId: 'run-1', killAfterExecuteStep: 2 });
    await expect(first.run()).rejects.toBeInstanceOf(SimulatedCrash);

    const second = resumeHarness(dir, script);
    const result = await second.run();
    expect(result.completed).toBe(true);
    expect(result.completedWork).toEqual(['file1', 'file2', 'file3', 'file4', 'file5', 'file6']);
  });

  it('preserves decisions across the restart without contradiction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task6-crash-'));
    const script: ScriptStep[] = [
      {
        tool: 'remember_fact',
        args: { key: 'decision:export-style', text: 'keep public export names stable' },
        output: 'remembered',
      },
      ...workScript(),
    ];
    const first = resumeHarness(dir, script, { runId: 'run-1', killAfterStep: 4 });
    await expect(first.run()).rejects.toBeInstanceOf(SimulatedCrash);

    const second = resumeHarness(dir, script);
    const result = await second.run();
    expect(result.completed).toBe(true);
    expect(result.decisions).toContain('keep public export names stable');
  });
});
