import { describe, expect, it } from 'vitest';
import { bm25Rank } from '../src/retrieval/bm25.js';
import { cosine, embed, embedCached, embedLocal } from '../src/retrieval/vector.js';
import { retrieveFacts, rrfFuse } from '../src/retrieval/hybrid.js';
import type { PersistentFact } from '../src/types.js';

const FACTS: PersistentFact[] = [
  {
    id: 'f1', key: 'auth-path', text: 'auth module lives in src/auth with login redirect',
    step: 1, runId: 'r', seq: 1, active: true,
  },
  {
    id: 'f2', key: 'recipe', text: 'chocolate cake recipe with flour sugar oven',
    step: 1, runId: 'r', seq: 2, active: true,
  },
  {
    id: 'f3', key: 'old-auth', text: 'auth module lives in lib/legacy deprecated',
    step: 0, runId: 'r', seq: 0, active: false,
  },
];

describe('bm25Rank', () => {
  it('ranks the document with the rare exact term first', () => {
    const ranked = bm25Rank(
      'login redirect',
      FACTS.map((f) => ({ id: f.id, text: f.text })),
    );
    expect(ranked[0].id).toBe('f1');
  });
});

describe('vector similarity', () => {
  it('embeds deterministically and scores identical texts at 1', () => {
    expect(embedLocal('auth module')).toEqual(embedLocal('auth module'));
    expect(cosine(embedLocal('auth module'), embedLocal('auth module'))).toBeCloseTo(1);
  });

  it('caches embeddings by exact text instead of recomputing', async () => {
    const cache = new Map<string, number[]>();
    const first = await embedCached('auth module login', 'document', cache);
    expect(cache.size).toBe(1);
    const second = await embedCached('auth module login', 'document', cache);
    expect(cache.size).toBe(1);
    expect(second).toEqual(first);
  });

  it('falls back to local embeddings when Ollama is unreachable', async () => {
    process.env.OLLAMA_URL = 'http://127.0.0.1:1';
    try {
      expect(await embed('auth module', 'query')).toEqual(embedLocal('auth module'));
    } finally {
      delete process.env.OLLAMA_URL;
    }
  });
});

describe('rrfFuse', () => {
  it('scores symmetric ranks equally (scale-free fusion)', () => {
    const scores = rrfFuse([['a', 'b'], ['b', 'a']], 60);
    expect(scores.get('a')).toBeCloseTo(scores.get('b')!);
  });

  it('prefers documents ranked by both rankers', () => {
    const scores = rrfFuse([['a', 'b'], ['a']], 60);
    expect(scores.get('a')!).toBeGreaterThan(scores.get('b')!);
  });
});

describe('retrieveFacts', () => {
  it('retrieves the relevant active fact first', async () => {
    const hits = await retrieveFacts({ text: 'where does the auth module live login', topK: 5 }, FACTS);
    expect(hits[0].fact.id).toBe('f1');
  });

  it('never returns inactive (superseded) facts', async () => {
    const hits = await retrieveFacts({ text: 'auth module legacy', topK: 5 }, FACTS);
    expect(hits.some((h) => h.fact.id === 'f3')).toBe(false);
  });

  it('respects topK', async () => {
    const hits = await retrieveFacts({ text: 'auth', topK: 1 }, FACTS);
    expect(hits).toHaveLength(1);
  });
});
