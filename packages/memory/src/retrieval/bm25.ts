/**
 * Minimal BM25 over persistent facts (SQLite FTS5 equivalent for the
 * deterministic path). Catches exact matches: identifiers, paths, keywords.
 */

export interface ScoredDoc {
  id: string;
  score: number;
}

const K1 = 1.2;
const B = 0.75;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}

export function bm25Rank(query: string, docs: { id: string; text: string }[]): ScoredDoc[] {
  const terms = tokenize(query);
  const tokenized = docs.map((d) => ({ id: d.id, tokens: tokenize(d.text) }));
  const avgLen =
    tokenized.reduce((sum, d) => sum + d.tokens.length, 0) / Math.max(1, tokenized.length);
  const docFreq = new Map<string, number>();
  for (const d of tokenized) {
    for (const t of new Set(d.tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const scored = tokenized.map((d) => {
    let score = 0;
    for (const term of terms) {
      const tf = d.tokens.filter((t) => t === term).length;
      if (tf === 0) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (tokenized.length - df + 0.5) / (df + 0.5));
      score +=
        idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.tokens.length) / Math.max(1, avgLen))));
    }
    return { id: d.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
