import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { ToolCall } from '../types.js';
import type { PersistentMemoryStore } from '../memory/persistent.js';
import { ApprovalViolation, executeTool, type ToolOutcome } from './tools.js';

export interface LiveToolOptions {
  repoDir: string;
  /** Command used to run a test file; defaults to `node --test <file>`. */
  testCommand?: string[];
  testTimeoutMs?: number;
}

export interface LiveRuntime {
  persistent: PersistentMemoryStore;
  decisions: string[];
  stepIndex: number;
}

const MAX_OUTPUT = 4000;
const MAX_GREP_HITS = 50;

/**
 * Resolves a repo-relative path and rejects anything escaping the repo
 * (.., absolute paths, symlink escapes). Loud failure, like the Task 3 gate.
 */
function resolveInRepo(repoDir: string, rel: string): string {
  // Absolute inputs are rejected outright: on Windows, join() would otherwise
  // swallow a leading '/' and silently resolve inside the repo.
  if (/^([a-zA-Z]:)?[\\/]/.test(rel)) {
    throw new ApprovalViolation(`absolute paths are forbidden: ${JSON.stringify(rel)}`);
  }
  const base = realpathSync(repoDir);
  const target = join(base, rel);
  const real = existsSync(target) ? realpathSync(target) : join(base, rel);
  if (real !== base && !real.startsWith(base + sep)) {
    throw new ApprovalViolation(`path escapes the repo under test: ${JSON.stringify(rel)}`);
  }
  return real;
}

function truncate(output: string): { output: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT) return { output, truncated: false };
  return { output: `${output.slice(0, MAX_OUTPUT)}\n…[truncated ${output.length - MAX_OUTPUT} chars]`, truncated: true };
}

function grepRepo(repoDir: string, pattern: string): string {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (hits.length >= MAX_GREP_HITS) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (/\.(ts|js|md|json)$/.test(entry.name)) {
        const lines = readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (hits.length < MAX_GREP_HITS && line.includes(pattern)) {
            const rel = full
              .slice(realpathSync(repoDir).length + 1)
              .split(sep)
              .join('/');
            hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
          }
        });
      }
    }
  };
  walk(realpathSync(repoDir));
  return hits.length > 0 ? hits.join('\n') : `no matches for ${JSON.stringify(pattern)}`;
}

function runTestFile(repoDir: string, test: string, opts: LiveToolOptions): Promise<{ ok: boolean; output: string }> {
  const cmd = opts.testCommand ?? ['node', '--test'];
  return new Promise((resolve) => {
    const child = execFile(
      cmd[0],
      [...cmd.slice(1), test],
      { cwd: repoDir, timeout: opts.testTimeoutMs ?? 60_000, windowsHide: true },
      (err, stdout, stderr) => {
        const combined = `${stdout}\n${stderr}`.trim();
        const tail = combined.length > MAX_OUTPUT ? `…${combined.slice(-MAX_OUTPUT)}` : combined;
        resolve({ ok: !err, output: tail || '(no output)' });
      },
    );
    void child;
  });
}

/**
 * Filesystem-backed executor for live runs: the same fixed tool surface as
 * the scripted path, but acting on a real repo. remember_fact/finish reuse
 * the shared implementation so both paths record memory identically.
 */
export async function executeLiveTool(
  call: ToolCall,
  opts: LiveToolOptions,
  rt: LiveRuntime,
): Promise<ToolOutcome> {
  const fail = (output: string): ToolOutcome => ({ result: { id: call.id, ok: false, output }, done: false, answer: '' });
  switch (call.name) {
    case 'read_file': {
      const path = call.arguments['path'];
      if (typeof path !== 'string') return fail('read_file needs a string path');
      let full: string;
      try {
        full = resolveInRepo(opts.repoDir, path);
      } catch (err) {
        throw err;
      }
      if (!existsSync(full) || !statSync(full).isFile()) {
        return fail(`file not found: ${path}`);
      }
      const t = truncate(readFileSync(full, 'utf8'));
      return { result: { id: call.id, ok: true, output: t.output, truncated: t.truncated }, done: false, answer: '' };
    }
    case 'list_dir': {
      const dir = call.arguments['dir'];
      if (typeof dir !== 'string') return fail('list_dir needs a string dir');
      const full = resolveInRepo(opts.repoDir, dir);
      if (!existsSync(full) || !statSync(full).isDirectory()) {
        return fail(`directory not found: ${dir}`);
      }
      return { result: { id: call.id, ok: true, output: readdirSync(full).join(' ') || '(empty)' }, done: false, answer: '' };
    }
    case 'grep': {
      const pattern = call.arguments['pattern'];
      if (typeof pattern !== 'string' || pattern.length === 0) return fail('grep needs a non-empty pattern');
      return { result: { id: call.id, ok: true, output: grepRepo(opts.repoDir, pattern) }, done: false, answer: '' };
    }
    case 'propose_edit': {
      const path = call.arguments['path'];
      const oldText = call.arguments['oldText'];
      const newText = call.arguments['newText'];
      if (typeof path !== 'string' || typeof oldText !== 'string' || typeof newText !== 'string') {
        return fail('propose_edit needs string path, oldText and newText');
      }
      const full = resolveInRepo(opts.repoDir, path);
      if (!existsSync(full) || !statSync(full).isFile()) {
        return fail(`propose_edit: no such file ${JSON.stringify(path)}`);
      }
      const content = readFileSync(full, 'utf8');
      if (oldText === '') {
        // Detect function-name collisions in append mode: if newText declares
        // a function that the file already defines, reject to prevent duplicates.
        const fnMatch = newText.match(/function\s+(\w+)/);
        if (fnMatch && new RegExp(`function\\s+${fnMatch[1]}\\b`).test(content)) {
          const hint = content.includes(`module.exports = { login, session };`) && fnMatch[1] === 'logout'
            ? ` You forgot to export it — use propose_edit with oldText "module.exports = { login, session };" and newText "module.exports = { login, session, logout };"`
            : '';
          return fail(`propose_edit: ${path} already defines function ${fnMatch[1]}; read the file and use propose_edit with exact oldText to replace instead of appending.${hint}`);
        }
        if (content.includes(newText.trim())) {
          return { result: { id: call.id, ok: true, output: `already present in ${path} (no duplicate appended)` }, done: false, answer: '' };
        }
        // Append-only edits cannot corrupt existing code: newText goes at EOF.
        // Include a content preview so the model can verify without an extra read.
        const joined = content.endsWith('\n') ? `${content}${newText}` : `${content}\n${newText}`;
        writeFileSync(full, joined.endsWith('\n') ? joined : `${joined}\n`, 'utf8');
        const preview = joined.slice(-400);
        return { result: { id: call.id, ok: true, output: `appended to ${path}\n--- preview ---\n${preview}` }, done: false, answer: '' };
      }
      const occurrences = content.split(oldText).length - 1;
      if (occurrences === 0) {
        return fail(`propose_edit: oldText not found in ${JSON.stringify(path)}; read the file and copy the exact text`);
      }
      if (occurrences > 1) {
        return fail(
          `propose_edit: oldText matches ${occurrences} times in ${JSON.stringify(path)}; include more surrounding text`,
        );
      }
      writeFileSync(full, content.replace(oldText, newText), 'utf8');
      return { result: { id: call.id, ok: true, output: `applied edit to ${path}` }, done: false, answer: '' };
    }
    case 'run_test': {
      const test = call.arguments['test'];
      if (typeof test !== 'string') return fail('run_test needs a string test');
      let resolvedTest = test;
      let resolved = join(opts.repoDir, resolvedTest);
      if (!existsSync(resolved)) {
        if (test.endsWith('.js') && existsSync(join(opts.repoDir, test.replace(/\.js$/, '.test.js')))) {
          resolvedTest = test.replace(/\.js$/, '.test.js');
          resolved = join(opts.repoDir, resolvedTest);
        } else if (!test.endsWith('.test.js') && existsSync(join(opts.repoDir, `${test}.test.js`))) {
          resolvedTest = `${test}.test.js`;
          resolved = join(opts.repoDir, resolvedTest);
        }
      }
      if (!existsSync(resolved)) {
        const testDir = join(opts.repoDir, 'test');
        let hint = '';
        if (existsSync(testDir)) {
          try {
            hint = ` (available: ${readdirSync(testDir).join(', ')})`;
          } catch {}
        }
        return fail(`Could not find '${test}'${hint} — use list_dir "test" to discover test files`);
      }
      const { ok, output } = await runTestFile(opts.repoDir, resolvedTest, opts);
      // If the test fails because a function is missing, nudge the model toward editing.
      const hint =
        !ok && output.includes("undefined") && output.includes('function')
          ? '\nHint: a function is missing — read the implementation file and add it with propose_edit.'
          : '';
      return { result: { id: call.id, ok, output: output + hint }, done: false, answer: '' };
    }
    case 'remember_fact':
    case 'finish':
      return executeTool(
        call,
        { tool: call.name, args: call.arguments, output: '' },
        { persistent: rt.persistent, decisions: rt.decisions, stepIndex: rt.stepIndex },
      );
  }
}
