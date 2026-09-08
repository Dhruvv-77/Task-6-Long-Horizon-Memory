import type { ScriptStep, ToolCall, ToolResult } from '../types.js';
import type { PersistentMemoryStore } from '../memory/persistent.js';

export class ApprovalViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalViolation';
  }
}

export interface ToolRuntime {
  persistent: PersistentMemoryStore;
  decisions: string[];
  stepIndex: number;
}

export interface ToolOutcome {
  result: ToolResult;
  done: boolean;
  answer: string;
}

/**
 * Blocks edits outside the repo under test. Fails loudly (throws) so the run
 * aborts as a distinct safety failure instead of silently skipping the edit.
 */
const FORBIDDEN_PATH = /(^|[\\/])(\.\.|node_modules|evals|\.memory)([\\/]|$)|^\//;

/**
 * Executes one tool call against the deterministic script step. The Task 3
 * surface (read_file, list_dir, grep, propose_edit, run_test) plus the Task 6
 * persistent-memory write (remember_fact) and run terminator (finish).
 */
export async function executeTool(
  call: ToolCall,
  script: ScriptStep,
  rt: ToolRuntime,
): Promise<ToolOutcome> {
  const ok = script.ok ?? true;
  if (call.name === 'finish' || script.tool === 'finish') {
    const answer =
      typeof call.arguments['answer'] === 'string'
        ? (call.arguments['answer'] as string)
        : script.output;
    return { result: { id: call.id, ok: true, output: answer }, done: true, answer };
  }

  switch (call.name) {
    case 'read_file':
    case 'list_dir':
    case 'grep':
    case 'run_test':
      return { result: { id: call.id, ok, output: script.output }, done: false, answer: '' };

    case 'propose_edit': {
      const path = call.arguments['path'] ?? script.args['path'];
      const diff = call.arguments['diff'] ?? call.arguments['newText'] ?? script.args['diff'] ?? 'applied edit';
      if (typeof path !== 'string' || path.length === 0 || FORBIDDEN_PATH.test(path)) {
        throw new ApprovalViolation(
          `propose_edit blocked: path ${JSON.stringify(String(path))} is outside the repo under test`,
        );
      }
      if (typeof diff !== 'string' || diff.length === 0) {
        throw new ApprovalViolation('propose_edit blocked: empty diff applies nothing');
      }
      return {
        result: { id: call.id, ok, output: script.output || `applied edit to ${path}` },
        done: false,
        answer: '',
      };
    }

    case 'remember_fact': {
      const key = (typeof script.args['key'] === 'string' ? script.args['key'] : call.arguments['key']) as string;
      const text = (typeof script.args['text'] === 'string' ? script.args['text'] : call.arguments['text']) as string;
      if (!key || !text) {
        return {
          result: { id: call.id, ok: false, output: 'remember_fact needs non-empty key and text' },
          done: false,
          answer: '',
        };
      }
      rt.persistent.remember(key, text, rt.stepIndex);
      if (key.toLowerCase().startsWith('decision') && !rt.decisions.includes(text)) {
        rt.decisions.push(text);
      }
      return {
        result: { id: call.id, ok: true, output: `remembered [${key}]` },
        done: false,
        answer: '',
      };
    }
  }
}
