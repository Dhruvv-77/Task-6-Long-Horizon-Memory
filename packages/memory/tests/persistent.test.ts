import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistentMemoryStore } from '../src/memory/persistent.js';
import { DiskStore } from '../src/store/disk.js';

function freshMemory() {
  const store = new DiskStore(mkdtempSync(join(tmpdir(), 'task6-persist-')));
  return new PersistentMemoryStore(store, 'run-1');
}

describe('PersistentMemoryStore', () => {
  it('stores a fact as active with a sequence number', () => {
    const mem = freshMemory();
    const fact = mem.remember('auth-path', 'auth lives in src/auth', 2);
    expect(fact.active).toBe(true);
    expect(fact.seq).toBe(1);
    expect(mem.activeFacts()).toHaveLength(1);
  });

  it('supersedes a fact remembered under the same key (case-insensitive)', () => {
    const mem = freshMemory();
    const oldFact = mem.remember('API-Base', 'api at /v1', 1);
    const newFact = mem.remember('api-base', 'api at /v2', 4);
    expect(oldFact.active).toBe(false);
    expect(oldFact.supersededBy).toBe(newFact.id);
    expect(newFact.active).toBe(true);
    expect(mem.activeFacts()).toHaveLength(1);
    expect(mem.activeFacts()[0].text).toContain('/v2');
  });

  it('keeps facts with different keys side by side', () => {
    const mem = freshMemory();
    mem.remember('a', 'first fact', 1);
    mem.remember('b', 'second fact', 2);
    expect(mem.activeFacts()).toHaveLength(2);
  });

  it('recalls the relevant fact and never a superseded one', async () => {
    const mem = freshMemory();
    mem.remember('auth-path', 'auth module entry is src/auth/index.ts', 1);
    mem.remember('recipe', 'chocolate cake needs flour sugar oven', 1);
    mem.remember('auth-path', 'auth module moved to src/identity/index.ts', 5);
    const hits = await mem.recall({ text: 'where is the auth module entry', topK: 5 });
    expect(hits[0].fact.text).toContain('src/identity/index.ts');
    expect(hits.some((h) => h.fact.text.includes('src/auth/index.ts'))).toBe(false);
  });

  it('continues the sequence across a restart from the same store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task6-persist-'));
    const first = new PersistentMemoryStore(new DiskStore(dir), 'run-1');
    first.remember('k', 'v1', 1);
    const second = new PersistentMemoryStore(new DiskStore(dir), 'run-2');
    expect(second.remember('k2', 'v2', 1).seq).toBe(2);
  });
});
