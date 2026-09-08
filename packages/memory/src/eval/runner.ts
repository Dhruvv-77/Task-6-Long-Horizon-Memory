import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { EVAL_WORKING_CONFIG } from '../config.js';
import { OllamaDriver, probeOllama } from '../agent/driver.js';
import { AgentLoop, SimulatedCrash, type ExecutorKind } from '../agent/loop.js';
import { PersistentMemoryStore } from '../memory/persistent.js';
import { DiskStore } from '../store/disk.js';
import {
  MEMORY_STRATEGIES,
  type GoldenScenario,
  type MemoryStrategy,
  type ScenarioResult,
  type StrategyMetrics,
} from '../types.js';
import { aggregate } from './metrics.js';

const TOOL_NAMES = [
  'read_file',
  'list_dir',
  'grep',
  'propose_edit',
  'run_test',
  'remember_fact',
  'finish',
] as const;

const scriptStepSchema = z.object({
  tool: z.enum(TOOL_NAMES),
  args: z.record(z.unknown()),
  output: z.string(),
  ok: z.boolean().optional(),
  completes: z.string().optional(),
});

const scenarioSchema = z.object({
  id: z.string(),
  category: z.enum(['standard_long_horizon', 'recall_dependent', 'memory_pollution']),
  task: z.string(),
  steps: z.array(scriptStepSchema).min(1),
  killAfterStep: z.number().int().positive().optional(),
  killMidToolCall: z.boolean().optional(),
  recallCheck: z.object({ query: z.string(), mustContain: z.string() }).optional(),
  staleStrings: z.array(z.string()).optional(),
});

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
}

export function readScenarios(path: string): GoldenScenario[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line, i) => {
      const parsed = scenarioSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(`scenario line ${i + 1}: ${formatIssues(parsed.error)}`);
      }
      return parsed.data as GoldenScenario;
    });
}

export type RunMode = 'live' | 'deterministic';

export interface EvalOptions {
  strategies?: MemoryStrategy[];
  workRoot?: string;
  maxSteps?: number;
  topK?: number;
  /**
   * 'live' (default) runs live with Ollama driving the evaluation.
   * 'scripted' pins deterministic simulation (for offline tests/baselines).
   */
  driverMode?: 'auto' | 'scripted' | 'live';
  onProgress?: (scenario: GoldenScenario, strategy: MemoryStrategy, current: number, total: number) => void;
  onFinishRun?: (scenario: GoldenScenario, strategy: MemoryStrategy, result: ScenarioResult) => void;
}

export interface EvalReport {
  results: ScenarioResult[];
  metrics: StrategyMetrics[];
}

export async function runEval(
  scenarios: GoldenScenario[],
  opts: EvalOptions = {},
): Promise<EvalReport> {
  const strategies = opts.strategies ?? [...MEMORY_STRATEGIES];
  const workRoot = opts.workRoot ?? mkdtempSync(join(tmpdir(), 'task6-eval-'));
  const mode = await selectMode(opts);
  if (mode === 'live') {
    process.env.OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  }
  const results: ScenarioResult[] = [];
  const totalRuns = scenarios.length * strategies.length;
  let currentRun = 0;
  for (const scenario of scenarios) {
    for (const strategy of strategies) {
      currentRun += 1;
      opts.onProgress?.(scenario, strategy, currentRun, totalRuns);
      const res = await runOne(scenario, strategy, workRoot, opts, mode);
      opts.onFinishRun?.(scenario, strategy, res);
      results.push(res);
    }
  }
  return {
    results,
    metrics: strategies.map((s) => aggregate(s, results.filter((r) => r.strategy === s))),
  };
}

async function selectMode(opts: EvalOptions): Promise<RunMode> {
  if (opts.driverMode === 'scripted') return 'deterministic';
  if (!(await probeOllama())) {
    throw new Error('Evaluation requires a running Ollama server at http://localhost:11434. Please ensure Ollama is running.');
  }
  return 'live';
}

function extractScenarioTree(scenario: GoldenScenario): string {
  const paths = new Set<string>();
  for (const s of scenario.steps) {
    if (s.args['path']) paths.add(String(s.args['path']));
    if (s.args['dir']) paths.add(String(s.args['dir']));
    if (s.args['test']) paths.add(String(s.args['test']));
  }
  return Array.from(paths).join(' ');
}

async function runOne(
  scenario: GoldenScenario,
  strategy: MemoryStrategy,
  workRoot: string,
  opts: EvalOptions,
  mode: RunMode,
): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(workRoot, `${scenario.id}-${strategy}-`));
  const executor: ExecutorKind = mode === 'live' ? 'match' : 'script';
  const repoTree = mode === 'live' ? extractScenarioTree(scenario) : undefined;
  const base = {
    task: scenario.task,
    strategy,
    config: EVAL_WORKING_CONFIG,
    script: scenario.steps,
    topK: opts.topK,
    maxSteps: opts.maxSteps,
    driver: mode === 'live' ? new OllamaDriver({ repoTree }) : undefined,
    executor,
  };
  const hasKill = scenario.killAfterStep != null;

  const first = new AgentLoop({
    ...base,
    store: new DiskStore(dir),
    persistent: new PersistentMemoryStore(new DiskStore(dir), `${scenario.id}-1`),
    runId: `${scenario.id}-1`,
    killAfterStep: scenario.killAfterStep,
    killMidToolCall: scenario.killMidToolCall,
  });

  let preKill: { completedWork: string[]; decisions: string[]; stepIndex: number } | null = null;
  let completedStepsBeforeCrash = 0;
  try {
    const only = await first.run();
    if (!hasKill) {
      return scoreResult(scenario, strategy, only, null, 0, dir, mode, only.toolCallErrors);
    }
    // A kill was configured but never fired (e.g. kill past the script end).
    return scoreResult(
      scenario, strategy, only,
      { completedWork: [], decisions: [], stepIndex: 0 }, 0, dir, mode, only.toolCallErrors,
    );
  } catch (err) {
    if (!(err instanceof SimulatedCrash)) throw err;
    const cp = new DiskStore(dir).loadCheckpoint();
    preKill = {
      completedWork: cp?.completedWork ?? [],
      decisions: cp?.decisions ?? [],
      stepIndex: cp?.stepIndex ?? 0,
    };
    completedStepsBeforeCrash = preKill.stepIndex;
  }

  const second = new AgentLoop({
    ...base,
    store: new DiskStore(dir),
    persistent: new PersistentMemoryStore(new DiskStore(dir), `${scenario.id}-2`),
    runId: `${scenario.id}-2`,
  });
  const final = await second.run();
  return scoreResult(scenario, strategy, final, preKill, completedStepsBeforeCrash, dir, mode, final.toolCallErrors);
}

async function scoreResult(
  scenario: GoldenScenario,
  strategy: MemoryStrategy,
  final: Awaited<ReturnType<AgentLoop['run']>>,
  preKill: { completedWork: string[]; decisions: string[]; stepIndex: number } | null,
  completedStepsBeforeCrash: number,
  dir: string,
  mode: RunMode,
  toolCallErrors: number,
): Promise<ScenarioResult> {
  let resumeCorrect: boolean | null = null;
  if (preKill) {
    const prefix = final.completedWork.slice(0, preKill.completedWork.length);
    const noDuplicates = new Set(final.completedWork).size === final.completedWork.length;
    const decisionsKept = preKill.decisions.every((d) => final.decisions.includes(d));
    resumeCorrect =
      final.completed &&
      noDuplicates &&
      decisionsKept &&
      JSON.stringify(prefix) === JSON.stringify(preKill.completedWork);
  }

  let recallCorrect: boolean | null = null;
  if (scenario.recallCheck) {
    const { query, mustContain } = scenario.recallCheck;
    if (strategy === 'tiered_memory') {
      const recallStore = new PersistentMemoryStore(new DiskStore(dir), 'eval-recall');
      const hits = await recallStore.recall({ text: query, topK: 5 });
      recallCorrect = hits.some((h) => h.fact.text.includes(mustContain));
    } else if (strategy === 'summarization_only') {
      recallCorrect = final.workingSnapshot.join('\n').includes(mustContain);
    } else {
      recallCorrect =
        final.completed && [...final.workingSnapshot, final.finalAnswer].join('\n').includes(mustContain);
    }
  }

  let polluted: boolean | null = null;
  if (scenario.staleStrings && scenario.staleStrings.length > 0) {
    const surfaced = [final.finalAnswer, ...final.lastRetrievedTexts].join('\n');
    polluted = scenario.staleStrings.some((s) => surfaced.includes(s));
  }

  return {
    scenarioId: scenario.id,
    category: scenario.category,
    strategy,
    mode,
    toolCallErrors,
    completed: final.completed,
    resumeCorrect,
    budgetAdherent: final.maxUsageRatio <= 1,
    maxUsageRatio: final.maxUsageRatio,
    compactions: final.compactions,
    recallCorrect,
    polluted,
    finalAnswer: final.finalAnswer,
    stepsExecuted: completedStepsBeforeCrash + final.stepsExecuted,
  };
}
