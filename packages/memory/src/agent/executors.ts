import type {
  ExecutorRuntime,
  ScriptStep,
  StepExecutor,
  StepOutcome,
  ToolCall,
} from '../types.js';
import { executeLiveTool } from './live-tools.js';
import { executeTool } from './tools.js';

function scriptedOutcome(call: ToolCall, step: ScriptStep, rt: ExecutorRuntime): Promise<StepOutcome> {
  return executeTool(call, step, {
    persistent: rt.persistent,
    decisions: rt.decisions,
    stepIndex: rt.stepIndex,
  }).then((o) => ({
    output: o.result.output,
    ok: o.result.ok,
    done: o.done,
    answer: o.answer,
    completes: step.completes,
    matched: true,
  }));
}

/** Deterministic executor: every turn consumes the scripted step. */
export class ScriptedStepExecutor implements StepExecutor {
  constructor(private readonly script: ScriptStep[]) {}

  peek(pointer: number): ScriptStep | null {
    return this.script[pointer] ?? null;
  }

  async execute(call: ToolCall, step: ScriptStep | null, rt: ExecutorRuntime): Promise<StepOutcome> {
    if (!step) throw new Error('script exhausted: no step for the proposed call');
    return scriptedOutcome(call, step, rt);
  }
}

/**
 * Live-eval executor: the model proposes freely against scripted tool outputs.
 * An exact-enough match consumes the scripted step; a miss returns an informative
 * observation guiding the model toward the next needed step.
 */
export class MatchingStepExecutor implements StepExecutor {
  constructor(private readonly script: ScriptStep[]) {}

  peek(pointer: number): ScriptStep | null {
    return this.script[pointer] ?? null;
  }

  async execute(call: ToolCall, step: ScriptStep | null, rt: ExecutorRuntime): Promise<StepOutcome> {
    if (!step) {
      return {
        output: 'All workflow steps finished. Call finish with the final answer.',
        ok: true,
        done: true,
        answer: 'completed',
        matched: true,
      };
    }
    if (!matchesCall(call, step)) {
      return {
        output: `Expected next workflow action: call ${step.tool}${targetSummary(step)}. Please proceed with this tool call.`,
        ok: false,
        done: false,
        answer: '',
        matched: false,
      };
    }
    return scriptedOutcome(call, step, rt);
  }
}

function targetSummary(step: ScriptStep): string {
  const target = step.args['path'] || step.args['dir'] || step.args['test'] || step.args['pattern'] || step.args['key'];
  return target ? ` on "${target}"` : '';
}

function cleanPath(p: unknown): string {
  return String(p ?? '').replace(/^[./\\]+/, '').replace(/\\/g, '/');
}

function matchesCall(call: ToolCall, step: ScriptStep): boolean {
  if (call.name === 'finish' && step.tool === 'finish') return true;
  if (call.name !== step.tool) return false;
  if (call.name === 'finish') return true;
  if (call.name === 'remember_fact') {
    return !step.args['key'] || !call.arguments['key'] ||
      cleanPath(call.arguments['key']).toLowerCase() === cleanPath(step.args['key']).toLowerCase();
  }
  if (call.name === 'propose_edit' || call.name === 'read_file') {
    if (!step.args['path'] || !call.arguments['path']) return true;
    const c = cleanPath(call.arguments['path']);
    const s = cleanPath(step.args['path']);
    return c === s || c.endsWith(s) || s.endsWith(c);
  }
  if (call.name === 'list_dir') {
    if (!step.args['dir'] || !call.arguments['dir']) return true;
    const c = cleanPath(call.arguments['dir']);
    const s = cleanPath(step.args['dir']);
    return c === s || c.includes(s) || s.includes(c);
  }
  if (call.name === 'run_test') {
    if (!step.args['test'] || !call.arguments['test']) return true;
    const c = cleanPath(call.arguments['test']);
    const s = cleanPath(step.args['test']);
    return c === s || c.includes(s) || s.includes(c);
  }
  if (call.name === 'grep') {
    return true;
  }
  return true;
}

/** Live executor: real filesystem tools over a repo directory. */
export class LiveStepExecutor implements StepExecutor {
  constructor(private readonly repoDir: string) {}

  peek(_pointer: number): ScriptStep | null {
    return null;
  }

  async execute(call: ToolCall, _step: ScriptStep | null, rt: ExecutorRuntime): Promise<StepOutcome> {
    const outcome = await executeLiveTool(call, { repoDir: this.repoDir }, {
      persistent: rt.persistent,
      decisions: rt.decisions,
      stepIndex: rt.stepIndex,
    });
    const completes =
      call.name === 'propose_edit' && typeof call.arguments['path'] === 'string'
        ? String(call.arguments['path'])
        : undefined;
    return {
      output: outcome.result.output,
      ok: outcome.result.ok,
      done: outcome.done,
      answer: outcome.answer,
      completes,
      matched: true,
    };
  }
}
