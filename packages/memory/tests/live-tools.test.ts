import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeLiveTool } from '../src/agent/live-tools.js';
import { PersistentMemoryStore } from '../src/memory/persistent.js';
import { DiskStore } from '../src/store/disk.js';
import type { ToolCall } from '../src/types.js';
import { ApprovalViolation } from '../src/agent/tools.js';

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'task6-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function runtime() {
  const dir = mkdtempSync(join(tmpdir(), 'task6-livemem-'));
  return { persistent: new PersistentMemoryStore(new DiskStore(dir), 'live-1'), decisions: [] as string[], stepIndex: 0 };
}

function call(name: ToolCall['name'], args: Record<string, unknown>): ToolCall {
  return { id: `live-${name}`, name, arguments: args };
}

describe('executeLiveTool', () => {
  it('reads a file inside the repo', async () => {
    const repo = repoWith({ 'src/auth.js': 'export function login() {}\n' });
    const out = await executeLiveTool(call('read_file', { path: 'src/auth.js' }), { repoDir: repo }, runtime());
    expect(out.result.ok).toBe(true);
    expect(out.result.output).toContain('export function login');
  });

  it('reports a missing file instead of throwing', async () => {
    const repo = repoWith({});
    const out = await executeLiveTool(call('read_file', { path: 'nope.js' }), { repoDir: repo }, runtime());
    expect(out.result.ok).toBe(false);
  });

  it('lists directories and greps contents', async () => {
    const repo = repoWith({ 'src/a.js': 'const session = 1;\n', 'src/b.js': 'nothing here\n' });
    const list = await executeLiveTool(call('list_dir', { dir: 'src' }), { repoDir: repo }, runtime());
    expect(list.result.output).toContain('a.js');
    const grep = await executeLiveTool(call('grep', { pattern: 'session' }), { repoDir: repo }, runtime());
    expect(grep.result.ok).toBe(true);
    expect(grep.result.output).toContain('src/a.js');
  });

  it('applies an edit that passes the approval gate', async () => {
    const repo = repoWith({ 'src/auth.js': 'export function login() {}\n' });
    const out = await executeLiveTool(
      call('propose_edit', { path: 'src/auth.js', oldText: 'login() {}', newText: 'login() { return true; }' }),
      { repoDir: repo },
      runtime(),
    );
    expect(out.result.ok).toBe(true);
    const reread = await executeLiveTool(call('read_file', { path: 'src/auth.js' }), { repoDir: repo }, runtime());
    expect(reread.result.output).toContain('return true');
  });

  it('appends when oldText is empty (append-only edits cannot corrupt code)', async () => {
    const repo = repoWith({ 'src/auth.js': 'export function login() {}\n' });
    const out = await executeLiveTool(
      call('propose_edit', { path: 'src/auth.js', oldText: '', newText: 'export function logout() {}\n' }),
      { repoDir: repo },
      runtime(),
    );
    expect(out.result.ok).toBe(true);
    const reread = await executeLiveTool(call('read_file', { path: 'src/auth.js' }), { repoDir: repo }, runtime());
    expect(reread.result.output).toBe('export function login() {}\nexport function logout() {}\n');
  });

  it('rejects appending a function that already exists in the file', async () => {
    const repo = repoWith({ 'src/auth.js': 'function login() {}\nfunction logout() { return true; }\n' });
    const out = await executeLiveTool(
      call('propose_edit', { path: 'src/auth.js', oldText: '', newText: 'function logout() { return false; }\n' }),
      { repoDir: repo },
      runtime(),
    );
    expect(out.result.ok).toBe(false);
    expect(out.result.output).toContain('already defines function logout');
  });

  it('blocks edits outside the repo loudly', async () => {
    const repo = repoWith({ 'src/auth.js': 'x\n' });
    await expect(
      executeLiveTool(call('propose_edit', { path: '../outside.js', oldText: 'x', newText: 'y' }), { repoDir: repo }, runtime()),
    ).rejects.toBeInstanceOf(ApprovalViolation);
    await expect(
      executeLiveTool(call('read_file', { path: '/etc/hostname' }), { repoDir: repo }, runtime()),
    ).rejects.toBeInstanceOf(ApprovalViolation);
  });

  it('runs repo tests and reports pass/fail', async () => {
    const repo = repoWith({
      'test/ok.test.js': "const { test } = require('node:test');\ntest('ok', () => {});\n",
      'test/bad.test.js': "const { test } = require('node:test');\ntest('bad', () => { throw new Error('boom'); });\n",
    });
    const pass = await executeLiveTool(call('run_test', { test: 'test/ok.test.js' }), { repoDir: repo }, runtime());
    expect(pass.result.ok).toBe(true);
    const fail = await executeLiveTool(call('run_test', { test: 'test/bad.test.js' }), { repoDir: repo }, runtime());
    expect(fail.result.ok).toBe(false);
    expect(fail.result.output).toContain('boom');
  });

  it('shares the remember_fact path with the scripted executor', async () => {
    const repo = repoWith({});
    const rt = runtime();
    const out = await executeLiveTool(
      call('remember_fact', { key: 'decision:x', text: 'do the simple thing' }),
      { repoDir: repo },
      rt,
    );
    expect(out.result.ok).toBe(true);
    expect(rt.decisions).toContain('do the simple thing');
  });
});
