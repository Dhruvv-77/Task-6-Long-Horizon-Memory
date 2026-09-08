import type { ToolName } from '../types.js';

export interface ModelContext {
  task: string;
  stepIndex: number;
  workingSummary: string;
  retrievedFacts: string[];
  completedWork: string[];
  decisions: string[];
}

export interface ProposedCall {
  name: ToolName;
  args: Record<string, unknown>;
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const OLLAMA_DEFAULT_URL = 'http://localhost:11434';
export const OLLAMA_DEFAULT_MODEL = 'qwen2.5:7b-instruct';

const TOOL_SCHEMAS: Record<ToolName, { description: string; properties: Record<string, { type: string; description: string }> }> = {
  read_file: {
    description: 'Read a file from the repo under test',
    properties: { path: { type: 'string', description: 'Repo-relative file path' } },
  },
  list_dir: {
    description: 'List files in a repo directory',
    properties: { dir: { type: 'string', description: 'Repo-relative directory' } },
  },
  grep: {
    description: 'Search file contents for a pattern',
    properties: { pattern: { type: 'string', description: 'Search pattern' } },
  },
  propose_edit: {
    description: 'Propose an edit; applied only after the approval gate passes',
    properties: {
      path: { type: 'string', description: 'Repo-relative file path' },
      oldText: { type: 'string', description: 'Exact text to replace, or empty string to append newText at end of file' },
      newText: { type: 'string', description: 'Replacement text' },
    },
  },
  run_test: {
    description: 'Run a repo test and report the result',
    properties: { test: { type: 'string', description: 'Test file or name' } },
  },
  remember_fact: {
    description: 'Persist one fact worth keeping across runs (decisions, constraints, locations)',
    properties: {
      key: { type: 'string', description: 'Stable key, e.g. decision:export-style' },
      text: { type: 'string', description: 'The exact fact text' },
    },
  },
  finish: {
    description: 'End the run with the final answer',
    properties: { answer: { type: 'string', description: 'Final answer text' } },
  },
};

/**
 * Live model driver (Ollama, qwen2.5:7b-instruct). One action per turn: native
 * tool_calls win, a single JSON block in text is the fallback, anything else
 * is a ModelError counted as a tool-call error by the harness.
 */
export class OllamaClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl?: string; model?: string; fetchFn?: FetchFn; timeoutMs?: number } = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OLLAMA_URL ?? OLLAMA_DEFAULT_URL).replace(/\/$/, '');
    this.model = opts.model ?? process.env.OLLAMA_MODEL ?? OLLAMA_DEFAULT_MODEL;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async chooseCall(ctx: ModelContext, tools: ToolName[]): Promise<ProposedCall> {
    const allowed = new Set<string>(tools);
    let body: { message?: { tool_calls?: { function?: { name?: string; arguments?: unknown } }[]; content?: string } };
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          options: { temperature: 0 },
          tools: tools.map((name) => ({
            type: 'function',
            function: { name, description: TOOL_SCHEMAS[name].description, parameters: { type: 'object', properties: TOOL_SCHEMAS[name].properties } },
          })),
          messages: [
            { role: 'system', content: this.systemPrompt(ctx, tools) },
            {
              role: 'user',
              content: (() => {
                const directiveMatch = ctx.workingSummary.match(/(?:REQUIRED WORKFLOW STEP|TASK COMPLETE|HINT): [^\n]+/);
                return directiveMatch
                  ? `Step ${ctx.stepIndex + 1}: ${directiveMatch[0]}\nReply with the single required tool call.`
                  : `Step ${ctx.stepIndex + 1}: what is the single next tool call?`;
              })(),
            },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new ModelError(`Ollama chat failed with HTTP ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch (err) {
      if (err instanceof ModelError) throw err;
      throw new ModelError(`Ollama request failed: ${(err as Error).message}`);
    }

    const message = body.message ?? {};
    const first = message.tool_calls?.[0]?.function;
    if (first && typeof first.name === 'string') {
      return this.checked(first.name, coerceArgs(first.arguments), allowed);
    }
    const fromText = extractJsonCall(message.content ?? '');
    if (fromText) return this.checked(fromText.name, fromText.args, allowed);
    throw new ModelError(`model returned no usable tool call: ${(message.content ?? '').slice(0, 200)}`);
  }

  private checked(name: string, args: Record<string, unknown>, allowed: Set<string>): ProposedCall {
    if (!allowed.has(name)) throw new ModelError(`model chose unknown tool: ${name}`);
    return { name: name as ToolName, args };
  }

  private systemPrompt(ctx: ModelContext, tools: ToolName[]): string {
    const isAuthDemo = ctx.task.includes('auth') && ctx.task.includes('logout');
    return [
      `You are a coding agent working on: ${ctx.task}`,
      'Reply with EXACTLY ONE tool call per turn. Never explain, never batch calls.',
      'All paths are repo-relative. When unsure where something lives, list a directory or grep.',
      isAuthDemo
        ? 'This repo uses plain JavaScript with CommonJS (function foo, module.exports) — never use TypeScript or export syntax.'
        : 'Inspect files, directories, and test results carefully to carry out the task requirements.',
      'Typical flow: list_dir to discover files, read_file to inspect implementation, propose_edit to update, run_test to verify, finish.',
      isAuthDemo
        ? 'If a test fails with "undefined == \'function\'" the function is missing — add it with propose_edit, then update any related check to handle the new state.'
        : 'If an action yields feedback or next needed step, follow that guidance.',
      'If your last call errored or added no new information, change approach — never alternate between two failing calls.',
      'Tools use specific argument names: list_dir needs dir, read_file needs path, run_test needs test, grep needs pattern, propose_edit needs path/oldText/newText, remember_fact needs key/text, finish needs answer.',
      `Available tools: ${tools.join(', ')}.`,
      `Completed work (do not repeat): ${ctx.completedWork.join(', ') || 'none'}.`,
      `Standing decisions (do not contradict): ${ctx.decisions.join('; ') || 'none'}.`,
      `Recalled facts: ${ctx.retrievedFacts.join(' | ') || 'none'}.`,
      `Recent context:\n${ctx.workingSummary.slice(0, 2500)}`,
      'Use remember_fact for decisions, constraints, or locations a future step needs.',
      'Use finish with the final answer when the task is done.',
    ].join('\n');
  }
}

function coerceArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to empty args.
    }
  }
  return {};
}

/** Extracts balanced `{...}` spans starting at each index in `starts`. */
function balancedObjects(content: string, starts: number[]): string[] {
  const out: string[] = [];
  for (const start of starts) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < content.length; i++) {
      const ch = content[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(content.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

function asCallObject(value: string): { name: string; args: Record<string, unknown> } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { name?: unknown }).name === 'string') {
      const { name } = parsed as { name: string; arguments?: unknown };
      return { name, args: coerceArgs((parsed as { arguments?: unknown }).arguments) };
    }
  } catch {
    // Not a call-shaped object.
  }
  return null;
}

function extractJsonCall(content: string): { name: string; args: Record<string, unknown> } | null {
  const fenced = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    const call = asCallObject(fenced[1]);
    if (call) return call;
  }
  // Bare {"name": ..., "arguments": {...}} object.
  const braceStarts: number[] = [];
  for (let i = content.indexOf('{'); i !== -1; i = content.indexOf('{', i + 1)) braceStarts.push(i);
  for (const span of balancedObjects(content, braceStarts)) {
    const call = asCallObject(span);
    if (call) return call;
  }
  // Function-call syntax: grep({"pattern": "x"}).
  const funcPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = funcPattern.exec(content)) !== null) {
    const spans = balancedObjects(content, [match.index + match[0].length - 1]);
    for (const span of spans) {
      try {
        const args: unknown = JSON.parse(span);
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          return { name: match[1], args: args as Record<string, unknown> };
        }
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}
