import { randomUUID } from 'node:crypto';
import type { PersistentFact, RetrievalQuery, RetrievedFact } from '../types.js';
import { retrieveFacts } from '../retrieval/hybrid.js';
import type { DiskStore } from '../store/disk.js';

/**
 * Persistent memory: facts worth keeping across runs, written explicitly by
 * the agent — never a dump of the transcript. A repeated key (case-insensitive)
 * supersedes the older fact, which is the staleness signal: retrieval only
 * ever ranks active facts, so corrected information naturally wins.
 */
export class PersistentMemoryStore {
  private readonly disk: DiskStore;
  private readonly runId: string;
  private readonly facts: PersistentFact[];
  private readonly embedCache = new Map<string, number[]>();
  private nextSeq: number;

  constructor(disk: DiskStore, runId: string) {
    this.disk = disk;
    this.runId = runId;
    // In-memory working set: returned fact objects stay live, and every
    // mutation is persisted. A restart loads a fresh set from disk.
    this.facts = this.disk.loadFacts();
    this.nextSeq = this.facts.reduce((max, f) => Math.max(max, f.seq), 0) + 1;
  }

  private all(): PersistentFact[] {
    return this.facts;
  }

  activeFacts(): PersistentFact[] {
    return this.all().filter((f) => f.active);
  }

  remember(key: string, text: string, step: number): PersistentFact {
    const facts = this.all();
    const normalized = key.toLowerCase();
    const created: PersistentFact = {
      id: randomUUID(),
      key,
      text,
      step,
      runId: this.runId,
      seq: this.nextSeq++,
      active: true,
    };
    for (const f of facts) {
      if (f.active && f.key.toLowerCase() === normalized) {
        f.active = false;
        f.supersededBy = created.id;
      }
    }
    facts.push(created);
    this.disk.saveFacts(facts);
    return created;
  }

  recall(query: RetrievalQuery): Promise<RetrievedFact[]> {
    return retrieveFacts(query, this.all(), this.embedCache);
  }
}
