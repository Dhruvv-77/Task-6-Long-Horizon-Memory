import type { DriverContext, ModelDriver, ProposedStep, ScriptStep } from '../types.js';
import { OllamaClient } from './model.js';

/** Deterministic driver: replays the scripted step for the current index. */
export class ScriptedDriver implements ModelDriver {
  constructor(private readonly script: ScriptStep[]) {}

  async nextCall(ctx: DriverContext): Promise<ProposedStep> {
    const step = this.script[ctx.stepIndex];
    if (!step) throw new Error(`script exhausted at step ${ctx.stepIndex}`);
    return { name: step.tool, args: step.args };
  }
}

export interface LiveDriverOptions {
  baseUrl?: string;
  model?: string;
  client?: OllamaClient;
  /** Top-level repo layout, shown to the model so it never has to guess paths. */
  repoTree?: string;
}

/** Live driver: qwen2.5:7b-instruct chooses each tool call. */
export class OllamaDriver implements ModelDriver {
  private readonly client: OllamaClient;
  private readonly repoTree?: string;

  constructor(opts: LiveDriverOptions = {}) {
    this.client = opts.client ?? new OllamaClient({ baseUrl: opts.baseUrl, model: opts.model });
    this.repoTree = opts.repoTree;
  }

  async nextCall(ctx: DriverContext): Promise<ProposedStep> {
    const call = await this.client.chooseCall(
      {
        task: ctx.task,
        stepIndex: ctx.stepIndex,
        workingSummary: `${this.repoTree ? `Repo layout (top level): ${this.repoTree}\n` : ''}${ctx.workingSummary}`,
        retrievedFacts: ctx.retrievedFacts,
        completedWork: ctx.completedWork,
        decisions: ctx.decisions,
      },
      ['read_file', 'list_dir', 'grep', 'propose_edit', 'run_test', 'remember_fact', 'finish'],
    );
    return { name: call.name, args: call.args };
  }
}

/** True when an Ollama server answers (used to pick live vs fallback). */
export async function probeOllama(baseUrl?: string, timeoutMs = 5000): Promise<boolean> {
  const base = (baseUrl ?? process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}
