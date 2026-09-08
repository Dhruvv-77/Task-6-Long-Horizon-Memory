/**
 * Vector similarity over persistent facts.
 *
 * Default path is a deterministic hashed-token embedding: zero cost, local,
 * and identical on every machine, which is what makes eval numbers reproduce
 * from a fresh clone. When OLLAMA_URL is set, `nomic-embed-text` is used with
 * the model-card task prefixes (`search_query:` / `search_document:`); any
 * failure falls back to the local embedder.
 */

export const EMBED_DIM = 64;

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function embedLocal(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 0);
  for (const token of tokens) vec[hashToken(token) % EMBED_DIM] += 1;
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return dot;
}

async function embedOllama(baseUrl: string, text: string, kind: 'query' | 'document'): Promise<number[]> {
  const prefix = kind === 'query' ? 'search_query: ' : 'search_document: ';
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: prefix + text }),
  });
  if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status}`);
  const body = (await res.json()) as { embedding?: number[] };
  if (!Array.isArray(body.embedding)) throw new Error('Ollama returned no embedding');
  return body.embedding;
}

export async function embed(text: string, kind: 'query' | 'document'): Promise<number[]> {
  const baseUrl = process.env.OLLAMA_URL;
  if (baseUrl) {
    try {
      return await embedOllama(baseUrl, text, kind);
    } catch {
      // Fall through to the deterministic local embedder.
    }
  }
  return embedLocal(text);
}

/**
 * Cached embedding. Fact texts repeat across steps constantly, so caching by
 * exact text keeps live (Ollama) evals tractable. Fact ids are UUIDs minted
 * per version and texts are immutable, so exact-text keys are safe.
 */
export async function embedCached(
  text: string,
  kind: 'query' | 'document',
  cache?: Map<string, number[]>,
): Promise<number[]> {
  const key = `${kind}:${text}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  const vec = await embed(text, kind);
  cache?.set(key, vec);
  return vec;
}
