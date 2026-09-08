import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKING_CONFIG } from '../src/config.js';
import { compactOldestMessages, rollUpSummaries } from '../src/memory/episodic.js';
import { PersistentMemoryStore } from '../src/memory/persistent.js';
import { WorkingMemory } from '../src/memory/working.js';
import { DiskStore } from '../src/store/disk.js';

function setup() {
  const working = new WorkingMemory(DEFAULT_WORKING_CONFIG);
  const persistent = new PersistentMemoryStore(
    new DiskStore(mkdtempSync(join(tmpdir(), 'task6-compact-'))),
    'run-1',
  );
  working.add({ role: 'system', content: 'task: rename auth module', step: 0 });
  working.add({ role: 'assistant', content: 'step 1: list files\ndecision: keep public export names stable', step: 1 });
  working.add({ role: 'tool', content: 'src/auth/login.ts\nsrc/auth/session.ts\nconstraint: never weaken the auth test assertion', step: 1 });
  working.add({
    role: 'assistant',
    content: 'step 2: read login',
    step: 2,
    toolCall: { id: 'c1', name: 'remember_fact', arguments: { key: 'login-owner', text: 'login.ts owned by team identity' } },
  });
  working.add({ role: 'tool', content: 'export function login() {}', step: 2 });
  working.add({ role: 'assistant', content: 'step 3: edit session.ts', step: 3 });
  return { working, persistent };
}

describe('compactOldestMessages', () => {
  it('keeps the two newest non-system messages plus a single summary message', () => {
    const { working, persistent } = setup();
    const summary = compactOldestMessages(working, persistent, 'run-1', true);
    expect(summary).not.toBeNull();
    expect(working.messages.filter((m) => m.role === 'system')).toHaveLength(2); // prompt + summary
    expect(working.messages.some((m) => m.content.includes('[EPISODIC MEMORY COMPACTION]'))).toBe(true);
    expect(working.messages.some((m) => m.content === 'step 3: edit session.ts')).toBe(true);
    expect(summary!.fromStep).toBe(1);
  });

  it('extracts decisions, constraints and remember_fact calls before compacting', () => {
    const { working, persistent } = setup();
    const summary = compactOldestMessages(working, persistent, 'run-1', true);
    const texts = persistent.activeFacts().map((f) => f.text);
    expect(texts.some((t) => t.includes('keep public export names stable'))).toBe(true);
    expect(texts.some((t) => t.includes('never weaken the auth test assertion'))).toBe(true);
    expect(texts.some((t) => t.includes('login.ts owned by team identity'))).toBe(true);
    expect(summary!.preservedFacts).toHaveLength(3);
  });

  it('does not persist anything when persistence is disabled (summarization-only)', () => {
    const { working, persistent } = setup();
    compactOldestMessages(working, persistent, 'run-1', false);
    expect(persistent.activeFacts()).toHaveLength(0);
    expect(working.messages.some((m) => m.content.includes('[EPISODIC MEMORY COMPACTION]'))).toBe(true);
  });

  it('loses verbatim detail: the summary condenses tool output instead of quoting it', () => {
    const { working, persistent } = setup();
    working.add({ role: 'tool', content: `bulk output TransActionId 9f3x ${'z'.repeat(500)}`, step: 0 });
    const before = working.messages.map((m) => m.content).join('\n').length;
    const summary = compactOldestMessages(working, persistent, 'run-1', true);
    const after = working.messages.map((m) => m.content).join('\n').length;
    expect(after).toBeLessThan(before);
    expect(summary!.text.includes('9f3x')).toBe(false);
  });

  it('rolls older summaries into one bounded digest that keeps preserved facts', () => {
    const { working, persistent } = setup();
    compactOldestMessages(working, persistent, 'run-1', true);
    working.add({ role: 'assistant', content: 'step 4: more edits', step: 4 });
    working.add({ role: 'tool', content: 'ok', step: 4 });
    working.add({ role: 'assistant', content: 'step 5: even more edits', step: 5 });
    working.add({ role: 'tool', content: 'ok', step: 5 });
    compactOldestMessages(working, persistent, 'run-1', true);
    working.add({ role: 'assistant', content: 'step 6: yet more edits', step: 6 });
    working.add({ role: 'tool', content: 'ok', step: 6 });
    working.add({ role: 'assistant', content: 'step 7: still more edits', step: 7 });
    working.add({ role: 'tool', content: 'ok', step: 7 });
    compactOldestMessages(working, persistent, 'run-1', true);
    const before = working.messages.filter((m) => m.content.startsWith('[EPISODIC MEMORY COMPACTION]'));
    expect(before.length).toBeGreaterThan(1);
    rollUpSummaries(working, 1);
    const markers = working.messages.filter((m) => m.content.startsWith('[EPISODIC MEMORY COMPACTION]'));
    expect(markers).toHaveLength(2); // newest full summary + one digest
    const digest = markers.find((m) => m.content.includes('DIGEST'))!;
    expect(digest.content).toContain('keep public export names stable');
  });

  it('returns null when there is nothing worth compacting', () => {
    const working = new WorkingMemory(DEFAULT_WORKING_CONFIG);
    const persistent = new PersistentMemoryStore(
      new DiskStore(mkdtempSync(join(tmpdir(), 'task6-compact-'))),
      'run-1',
    );
    working.add({ role: 'system', content: 'prompt', step: 0 });
    working.add({ role: 'user', content: 'hi', step: 1 });
    expect(compactOldestMessages(working, persistent, 'run-1', true)).toBeNull();
  });
});
