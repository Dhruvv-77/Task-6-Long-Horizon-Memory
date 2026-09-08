# DESIGN.md — Task 6: Long-Horizon Memory and Context Engineering

Package `packages/memory`. Builds on Task 3 (plan-act-observe loop, one tool call per
turn, step + wall-clock budgets, fixed typed tool surface, approval gate, stuck-loop abort,
JSONL trajectory logging) and Task 4 (typed trajectory events, *shared state, not shared
context*, trajectory-level scoring). Reuses Task 2 hybrid retrieval (BM25 + vector, RRF k=60).
Runtime: Node 20+, TypeScript strict, Vitest. Zero cost, local only.

Evaluation is **deterministic simulation**: a scripted driver feeds tool results (no model
calls), so every number reproduces from a fresh clone with no Ollama dependency. A local
hash-based embedder is the default; Ollama `nomic-embed-text` is opt-in only.

## 1. Public interfaces and types

```ts
type MemoryStrategy = 'no_memory' | 'naive_truncation' | 'summarization_only' | 'tiered_memory';

interface WorkingMessage { role: 'system'|'user'|'assistant'|'tool'; content: string;
  tokens: number; step: number; toolCall?: ToolCall; }
interface WorkingMemoryConfig { maxTokens: number; maxMessages: number; compactionThreshold: number; }
// usageRatio = max(tokens/maxTokens, messages/maxMessages); compact when >= threshold.

interface EpisodicSummary { id: string; fromStep: number; toStep: number;
  text: string; preservedFacts: string[]; }

interface PersistentFact { id: string; key: string; text: string; step: number;
  runId: string; seq: number; active: boolean; supersededBy?: string; }

interface RetrievalQuery { text: string; topK: number; }   // default topK = 5
interface RetrievedFact { fact: PersistentFact; score: number; }

interface ExecutionCheckpoint { task: string; strategy: MemoryStrategy; stepIndex: number;
  completedWork: string[]; decisions: string[]; pendingToolCall?: ToolCall;
  compactionCount: number; episodic: EpisodicSummary[]; updatedAt: number; }
```

- **Compaction trigger:** `usageRatio() >= compactionThreshold`. Oldest ~half of non-system
  messages collapse into one `[EPISODIC MEMORY COMPACTION]` system message + `EpisodicSummary`.
  Before compacting, lines matching `decision:` / `constraint:` / `remember_fact` are extracted
  into `PersistentMemory` — this is what keeps recall-dependent cases solvable.
- **Retrieval query shape:** `{ text, topK }`. Hybrid BM25 + cosine similarity fused with RRF
  (k=60), ranked over **active** facts only. The agent queries per step; facts are never
  injected wholesale (Task 4 "shared state, not shared context").
- **Staleness signal:** `remember` with an existing key (case-insensitive) supersedes the old
  fact (`active=false, supersededBy=newId`). Retrieval defaults to active-only.
- **Checkpoint:** atomic `.memory/checkpoint.json` (write tmp + rename) after every step.
  Write-ahead: `pendingToolCall` is stored *before* `executeTool` runs and cleared after, so a
  mid-tool-call kill resumes by verifying (not blindly repeating) the pending call.

## 2. Three most likely failure modes, and the plan for each

1. **Summarization silently drops the load-bearing constraint.** The summary reads fine but is
   wrong. Plan: extract-then-compact (decisions/constraints persist *before* summarising) +
   dedicated recall-dependent golden cases that fail if the constraint is lost + NOTES.md
   analysis of what extractive summarisation predictably loses (verbatim outputs, ordering,
   negations), each with a test, not an assertion.
2. **A stale persisted fact beats a fresh observation.** Plan: key-based supersession with
   tombstones, active-only retrieval, and 2 memory-pollution scenarios where an early fact is
   later corrected — resurfacing the stale text fails the run.
3. **Cold-restart corruption on a mid-tool-call kill.** Plan: write-ahead pending-call record,
   idempotent simulated tools keyed by call id, resume path that verifies-then-continues;
   `cold-restart.test.ts` kills mid-tool-call (the ugly timing), not just between steps.

## 3. What we are deliberately not building, and why

- Full Task 2 corpus RAG: the retrieval index covers persistent facts only; reusing the *method*
  (BM25+vector+RRF), not rebuilding the code ingestor.
- Task 3 MCP server / Task 4 orchestrator rebuilds: out of scope for this package; we assume a
  minimal Task-3-compatible loop and Task-4-style typed trajectory events.
- Live-model eval: nondeterministic and Ollama-dependent; deterministic simulation is what makes
  the review gate ("every number reproduces") achievable.
- Vector DBs, servers, agent frameworks, shell tools: forbidden carry-over from Tasks 2–4.

## 4. Open questions

- Working-memory caps: production default (4000 tokens / 12 messages) vs smaller eval caps for
  speed — resolved via per-run config override, documented in `src/config.ts`.
- Token counting: exact tokenizer vs `ceil(chars/4)` estimate — using the estimate, documented
  as a deliberate simplification with identical behaviour across strategies.
