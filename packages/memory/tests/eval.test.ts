import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/eval/metrics.js';
import { readScenarios, runEval } from '../src/eval/runner.js';
import type { GoldenScenario, ScenarioResult } from '../src/types.js';

function miniStandard(): GoldenScenario {
  return {
    id: 'mini-standard',
    category: 'standard_long_horizon',
    task: 'rename helper across files',
    steps: [
      { tool: 'read_file', args: { path: 'a.ts' }, output: `content A ${'x'.repeat(200)}`, completes: 'a' },
      { tool: 'read_file', args: { path: 'b.ts' }, output: `content B ${'y'.repeat(200)}`, completes: 'b' },
      { tool: 'read_file', args: { path: 'c.ts' }, output: `content C ${'z'.repeat(200)}`, completes: 'c' },
      { tool: 'read_file', args: { path: 'd.ts' }, output: `content D ${'w'.repeat(200)}`, completes: 'd' },
      { tool: 'finish', args: { answer: 'renamed in 4 files' }, output: 'renamed in 4 files' },
    ],
    killAfterStep: 2,
  };
}

function miniRecall(): GoldenScenario {
  return {
    id: 'mini-recall',
    category: 'recall_dependent',
    task: 'migrate database config',
    steps: [
      { tool: 'read_file', args: { path: 'db.ts' }, output: `config ${'x'.repeat(200)}` },
      {
        tool: 'remember_fact',
        args: { key: 'db-host', text: 'postgres primary at db.internal port 5432' },
        output: 'remembered',
      },
      { tool: 'read_file', args: { path: 'f1.ts' }, output: `f1 ${'y'.repeat(200)}` },
      { tool: 'read_file', args: { path: 'f2.ts' }, output: `f2 ${'z'.repeat(200)}` },
      { tool: 'read_file', args: { path: 'f3.ts' }, output: `f3 ${'w'.repeat(200)}` },
      { tool: 'finish', args: { answer: 'migration done' }, output: 'migration done' },
    ],
    killAfterStep: 3,
    recallCheck: { query: 'which database host and port for production', mustContain: 'db.internal' },
  };
}

describe('aggregate', () => {
  it('averages applicable runs and reports null for inapplicable metrics', () => {
    const results: ScenarioResult[] = [
      {
        scenarioId: 'a', category: 'standard_long_horizon', strategy: 'tiered_memory',
        mode: 'deterministic', toolCallErrors: 0,
        completed: true, resumeCorrect: true, budgetAdherent: true, maxUsageRatio: 0.9,
        compactions: 1, recallCorrect: null, polluted: null,
        finalAnswer: 'done', stepsExecuted: 5,
      },
      {
        scenarioId: 'b', category: 'standard_long_horizon', strategy: 'tiered_memory',
        mode: 'deterministic', toolCallErrors: 0,
        completed: false, resumeCorrect: false, budgetAdherent: false, maxUsageRatio: 1.2,
        compactions: 0, recallCorrect: null, polluted: null,
        finalAnswer: '', stepsExecuted: 3,
      },
    ];
    const metrics = aggregate('tiered_memory', results);
    expect(metrics.resumeCorrectness).toBe(0.5);
    expect(metrics.contextBudgetAdherence).toBe(0.5);
    expect(metrics.completionRate).toBe(0.5);
    expect(metrics.recallAccuracy).toBeNull();
    expect(metrics.memoryPollutionRate).toBeNull();
  });
});

describe('runEval', () => {
  it('runs a scenario under two strategies and scores resume correctness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'task6-eval-'));
    const { results } = await runEval([miniStandard()], {
      strategies: ['tiered_memory', 'no_memory'],
      workRoot: root,
      driverMode: 'scripted',
    });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(typeof r.resumeCorrect).toBe('boolean');
      expect(r.recallCorrect).toBeNull();
      expect(r.polluted).toBeNull();
    }
    expect(results.find((r) => r.strategy === 'tiered_memory')!.resumeCorrect).toBe(true);
  });

  it('recall succeeds with tiered retrieval but fails under naive truncation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'task6-eval-'));
    const { results } = await runEval([miniRecall()], {
      strategies: ['tiered_memory', 'naive_truncation'],
      workRoot: root,
      driverMode: 'scripted',
    });
    expect(results.find((r) => r.strategy === 'tiered_memory')!.recallCorrect).toBe(true);
    expect(results.find((r) => r.strategy === 'naive_truncation')!.recallCorrect).toBe(false);
  });

  it('recall fails under summarization-only: payloads are not retained', async () => {
    const root = mkdtempSync(join(tmpdir(), 'task6-eval-'));
    const { results } = await runEval([miniRecall()], {
      strategies: ['summarization_only'],
      workRoot: root,
      driverMode: 'scripted',
    });
    expect(results[0].recallCorrect).toBe(false);
  });
});

describe('golden-memory.jsonl', () => {
  it('holds 12 scenarios in a 7/3/2 split, each with a mid-run kill', () => {
    const path = fileURLToPath(new URL('../../../evals/golden-memory.jsonl', import.meta.url));
    const scenarios = readScenarios(path);
    expect(scenarios).toHaveLength(12);
    const count = (c: string) => scenarios.filter((s) => s.category === c).length;
    expect(count('standard_long_horizon')).toBe(7);
    expect(count('recall_dependent')).toBe(3);
    expect(count('memory_pollution')).toBe(2);
    for (const s of scenarios) {
      expect(s.killAfterStep).toBeDefined();
      expect(s.killAfterStep!).toBeLessThan(s.steps.length);
    }
    expect(scenarios.filter((s) => s.killMidToolCall)).not.toHaveLength(0);
    expect(scenarios.filter((s) => s.category === 'recall_dependent').every((s) => s.recallCheck)).toBe(true);
    expect(scenarios.filter((s) => s.category === 'memory_pollution').every((s) => s.staleStrings?.length)).toBe(true);
  });
});

describe('readScenarios', () => {
  it('parses JSONL and rejects unknown categories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task6-eval-'));
    const path = join(dir, 'scenarios.jsonl');
    writeFileSync(path, `${JSON.stringify(miniStandard())}\n{"id": "bad", "category": "nope"}\n`);
    expect(() => readScenarios(path)).toThrow(/category/);
  });
});
