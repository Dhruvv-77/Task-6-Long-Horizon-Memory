import { DEFAULT_TOP_K, RRF_K } from '../config.js';
import type { PersistentFact, RetrievalQuery, RetrievedFact } from '../types.js';
import { bm25Rank } from './bm25.js';
import { cosine, embedCached } from './vector.js';

/**
 * Hybrid retrieval (Task 2 method, facts-only index): BM25 for exact matches
 * plus vector cosine for semantic matches, fused with Reciprocal Rank Fusion.
 * RRF is scale-free — it uses rank position only — so unbounded BM25 scores
 * and compressed cosine similarities need no normalisation constant.
 */
export function rrfFuse(rankings: string[][], k: number = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

export async function retrieveFacts(
  query: RetrievalQuery,
  facts: PersistentFact[],
  cache?: Map<string, number[]>,
): Promise<RetrievedFact[]> {
  const topK = query.topK && query.topK > 0 ? query.topK : DEFAULT_TOP_K;
  const active = facts.filter((f) => f.active);
  if (active.length === 0) return [];

  const docs = active.map((f) => ({ id: f.id, text: `${f.key} ${f.text}` }));
  const bm25 = bm25Rank(query.text, docs).map((d) => d.id);

  const queryVec = await embedCached(query.text, 'query', cache);
  const docVecs = await Promise.all(docs.map((d) => embedCached(d.text, 'document', cache)));
  const byVector = docs
    .map((d, i) => ({ id: d.id, score: cosine(queryVec, docVecs[i]) }))
    .sort((a, b) => b.score - a.score)
    .map((d) => d.id);

  const fused = rrfFuse([bm25, byVector]);
  const byId = new Map(active.map((f) => [f.id, f]));
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ fact: byId.get(id)!, score }));
}
