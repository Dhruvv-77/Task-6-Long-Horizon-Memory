import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MEMORY_DIR } from '../config.js';
import type { EpisodicSummary, ExecutionCheckpoint, PersistentFact } from '../types.js';

/**
 * File-backed state for checkpoints, persistent facts and episodic summaries.
 * All writes are atomic (write to `file.tmp.<rand>`, then rename) so killing
 * the process mid-write can never leave a half-written JSON file behind.
 */
export class DiskStore {
  readonly dir: string;

  constructor(baseDir: string = MEMORY_DIR) {
    this.dir = baseDir;
  }

  checkpointPath(): string {
    return join(this.dir, 'checkpoint.json');
  }

  factsPath(): string {
    return join(this.dir, 'facts.json');
  }

  summariesPath(): string {
    return join(this.dir, 'summaries.json');
  }

  loadCheckpoint(): ExecutionCheckpoint | null {
    return readJson<ExecutionCheckpoint>(this.checkpointPath());
  }

  saveCheckpoint(cp: ExecutionCheckpoint): void {
    writeJsonAtomic(this.checkpointPath(), cp);
  }

  loadFacts(): PersistentFact[] {
    return readJson<PersistentFact[]>(this.factsPath()) ?? [];
  }

  saveFacts(facts: PersistentFact[]): void {
    writeJsonAtomic(this.factsPath(), facts);
  }

  loadSummaries(): EpisodicSummary[] {
    return readJson<EpisodicSummary[]>(this.summariesPath()) ?? [];
  }

  saveSummaries(summaries: EpisodicSummary[]): void {
    writeJsonAtomic(this.summariesPath(), summaries);
  }

  clearAll(): void {
    if (existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
  }
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp.${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  // Windows file locking (indexer/AV on synced folders) can transiently
  // refuse the rename; retry briefly instead of failing the whole run.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      lastError = err;
      sleepSync(10 * (attempt + 1));
    }
  }
  throw lastError;
}
