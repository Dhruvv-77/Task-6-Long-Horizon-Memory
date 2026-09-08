import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiskStore } from '../src/store/disk.js';
import type { ExecutionCheckpoint, PersistentFact } from '../src/types.js';

function freshStore(): DiskStore {
  return new DiskStore(mkdtempSync(join(tmpdir(), 'task6-store-')));
}

function sampleCheckpoint(): ExecutionCheckpoint {
  return {
    task: 'rename the auth module',
    strategy: 'tiered_memory',
    stepIndex: 7,
    completedWork: ['auth/login.ts', 'auth/session.ts'],
    decisions: ['keep public export names stable'],
    executedCallIds: ['c1', 'c2'],
    compactionCount: 1,
    episodic: [],
    updatedAt: 123,
  };
}

describe('DiskStore checkpoints', () => {
  it('round-trips a checkpoint through disk', () => {
    const store = freshStore();
    store.saveCheckpoint(sampleCheckpoint());
    expect(store.loadCheckpoint()).toEqual(sampleCheckpoint());
  });

  it('returns null when no checkpoint exists yet', () => {
    expect(freshStore().loadCheckpoint()).toBeNull();
  });

  it('leaves no tmp files behind (atomic write)', () => {
    const store = freshStore();
    store.saveCheckpoint(sampleCheckpoint());
    const leftovers = readdirSync(store.dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('round-trips persistent facts and summaries', () => {
    const store = freshStore();
    const facts: PersistentFact[] = [
      {
        id: 'f1', key: 'auth-path', text: 'auth lives in src/auth',
        step: 2, runId: 'r1', seq: 1, active: true,
      },
    ];
    store.saveFacts(facts);
    expect(store.loadFacts()).toEqual(facts);
    expect(store.loadSummaries()).toEqual([]);
  });

  it('clearAll removes all persisted state', () => {
    const store = freshStore();
    store.saveCheckpoint(sampleCheckpoint());
    store.clearAll();
    expect(store.loadCheckpoint()).toBeNull();
  });
});
