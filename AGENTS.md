# AGENTS.md — Task 6 Long-Horizon Memory

## What this is
Durable, bounded-context memory layer for the Task 3 coding agent (PRD v1.0, 26 Aug 2026). Extends agent loop so work spanning >1 context window and cold restarts resume correctly. Zero-cost, local-only (Node 20+/TS strict/Vitest/Ollama). Primary package is `packages/memory` per PRD §8.1.

## Repo reality
This repo (`Task 6 memory`) is the runnable implementation. It contains `packages/memory`, `evals/golden-memory.jsonl`, `demo-repo`, and the PRD PDFs. Earlier scaffolding referenced a sibling `../Task-6-Memorry-And-Context-Engineering` (typo `Memorry`) — that layout has been consolidated here. If you edit/run Task 6 code, `cd` to this root; `packages/memory` is the only workspace package.

## Structure
```
Task 6 memory/
├── packages/memory/src/
│   ├── cli.ts                   # commander CLI: `run` + `eval`
│   ├── config.ts                # DEFAULT_WORKING_CONFIG, MEMORY_DIR, estimateTokens
│   ├── types.ts                 # PersistentFact, EpisodicSummary, ExecutionCheckpoint, MemoryStrategy, recentCalls
│   ├── memory/{working,episodic,persistent}.ts
│   ├── retrieval/{bm25,hybrid,vector}.ts # BM25 + vector (nomic-embed-text or hashed fallback) + RRF k=60
│   ├── store/disk.ts            # atomic .tmp→.json writes, .memory/{checkpoint,facts,summaries}.json, recentCalls
│   ├── agent/{loop,model,tools,driver,executors,live-tools}.ts
│   └── eval/{runner,metrics,compare}.ts
├── packages/memory/tests/       # 11 suites, 69 tests
├── evals/golden-memory.jsonl    # 12 scenarios: 7 standard + 3 recall + 2 pollution
├── demo-repo/                   # live demo: src/auth.js + test/auth.test.js (add logout)
├── DESIGN.md / NOTES.md / RESULTS.md
└── pnpm-workspace.yaml / package.json  (root scripts delegate to @task6/memory)
```
`.memory/`, `.memory-live/` and `.memory_eval_tmp/` are gitignored runtime artifacts — never commit. `demo-repo` is intentionally small and git-tracked for live runs.

## Toolchain
- **Node 20+**, **pnpm** (workspace). Root `allowBuilds: esbuild: true`. `module: NodeNext`, `type: module` everywhere.
- **TypeScript strict**, `target ES2022`, `skipLibCheck`. Build = `tsc` (`outDir dist`, `rootDir src`).
- **Ollama** optional: `qwen2.5:3b-instruct` / `qwen2.5:7b-instruct` for generation, `nomic-embed-text` for vectors. Eval has fast deterministic mode without Ollama; `pnpm memory run` auto-detects Ollama and falls back to scripted demo if unreachable.
- No vector DB/Redis/LangChain — SQLite/files only per NFR-7.

## Key commands
From this repo root (`Task 6 memory`):
```sh
pnpm install
pnpm build                         # pnpm --filter @task6/memory build  →  tsc
pnpm test                          # pnpm --filter @task6/memory test   →  vitest run (69 tests, ~3s)
pnpm memory run --task "add logout to the auth module so its tests pass" # runs directly on Ollama by default
pnpm memory run --task "rename the auth module and update all 40+ call sites" --deterministic
pnpm memory eval                   # 12 scenarios × 4 strategies (performed by Ollama live by default)
pnpm memory eval --deterministic   # fast offline deterministic simulation (~6s)
pnpm memory eval --compare baseline.json
```
From `packages/memory` directly:
```sh
pnpm test                          # tests/**/*.test.ts, 20s timeout (vitest.config.ts:8)
pnpm build                         # tsc only
npx tsx src/cli.ts run --task "add logout to the auth module so its tests pass"
npx tsx src/cli.ts eval            # performed by Ollama live by default
npx tsx src/cli.ts eval --deterministic # fast offline simulation
```

## Architecture quirks (would miss without reading code)
- **WorkingMemory** (`src/memory/working.ts`, `src/config.ts:4`): `maxTokens 4000 / maxMessages 12 / compactionThreshold 0.75`. Eval harness overrides to `1500/8/0.7` (`src/eval/runner.ts:61`). Ratio = `max(tokens/maxTokens, messages/maxMessages)`. `shouldCompact()` at ratio ≥ threshold; `isOverflowing()` at strict `>`.
- **Token estimate** is `Math.ceil(text.length/4)` (`src/config.ts:16`) — not a tokenizer. Applied to `content` + `toolCall` JSON.
- **Compaction** (`src/memory/episodic.ts:compactOldestMessages`): keeps 2 newest non-system messages, compacts rest into one `[EPISODIC MEMORY COMPACTION]` system message + `EpisodicSummary`. Before compaction, extracts `decision:`/`constraint:` lines and `remember_fact` tool calls into `PersistentMemoryStore` — this is why `tiered_memory` preserves recall.
- **PersistentMemory** (`src/memory/persistent.ts`): key-based supersession — new `key` (case-insensitive) marks old `active=false, supersededBy=newId`. Retrieval defaults to `active` only.
- **Hybrid retrieval** (`src/retrieval/hybrid.ts`, `bm25.ts`, `vector.ts`): BM25 + vector cosine (Ollama `nomic-embed-text` or token-set fallback) fused via **RRF k=60**. Default `topK 5`. Must filter `active` before ranking.
- **Checkpoint / crash safety** (`src/store/disk.ts:32`, `src/agent/loop.ts`): writes are atomic (`file.tmp.<rand>` → rename, with Windows EPERM retry). Loop saves `lastToolCall` as `pending` *before* `executeTool`, then `completed`. On restart, `loadCheckpoint()` replays pending tool via `executeTool` and appends `[TOOL RESULT (RECOVERED)]`. `recentCalls` is persisted in the checkpoint (`src/types.ts:94`, `loop.ts:212`) so stuck-loop detection survives compaction. Mid-tool-kill test is `simulateMidToolCrash` at step 3.
- **Live mode** (`src/agent/model.ts`, `live-tools.ts`, `driver.ts`, `loop.ts:228`): Ollama `qwen2.5:7b-instruct` drives tool calls; `nomic-embed-text` optional for vectors. `propose_edit` supports `oldText=""` append with duplicate-function guard and preview on success. `run_test` validates test path and hints `test/auth.test.js`. Loop injects hints when `lastOutput` shows `undefined == 'function'` or `already defines function`, and auto-completes cleanly when all tests pass.
- **MemoryStrategy** (`src/types.ts:76`): `no_memory | naive_truncation | summarization_only | tiered_memory`. `naive_truncation` calls `truncateNaive()` (drops oldest non-system until under budget). `summarization_only` compacts but never persists facts for retrieval.

## Evaluation
- Golden set `evals/golden-memory.jsonl` — exactly 12 JSONL lines (PRD §12). Categories: `standard_long_horizon` (7), `recall_dependent` (3, constraint injected step 2), `memory_pollution` (2, stale key at step 1 then fresh at step 4/5).
- Runner `src/eval/runner.ts:44` runs each scenario per strategy in isolated `DiskStore(scenarioTmpDir)`, checkpoints at step 5 to verify `coldRestartSuccessful`, then checks `budgetExceededCount`, `recalledCorrectly` (via `memory.retrieve(query, 5)`), `staleFactResurfaced`.
- Metrics `src/eval/metrics.ts`: `resumeCorrectness`, `contextBudgetAdherence`, `recallAccuracy`, `memoryPollutionRate` — all deterministic except live Ollama path.
- `RESULTS.md`/`baseline.json` are generated artifacts; reproduce via `pnpm memory eval`.

## Tests
- `packages/memory/tests/`: `working-memory.test.ts`, `compaction.test.ts`, `retrieval.test.ts`, `cold-restart.test.ts`, `loop.test.ts`, `eval.test.ts`, `live-tools.test.ts`, `model.test.ts` etc (11 suites, 69 tests). Run with `pnpm --filter @task6/memory test` or `vitest run` inside `packages/memory`.
- No per-test CLI — use `pnpm test -- compaction` filter inside `packages/memory`.

## Gotchas
- Path with space: always quote `"Task 6 memory"` in shell. Prefer `workdir` param over `cd`.
- `MEMORY_DIR` resolves from `process.cwd()` (`src/config.ts:10`) — `pnpm memory eval` can run from package or workspace root.
- Checkpoint directories `.memory/` and `.memory-live/` are automatically reset on fresh CLI runs unless `--resume` is explicitly passed.
- Token budget uses char estimate — changing it changes compaction timing and `RESULTS.md` numbers.
- Do not inject whole persistent store into prompt — selective RRF retrieval is required (PRD FR-7/FR-11).
- `demo-repo/src/auth.js` is automatically restored to clean state before live runs if `logout` was already present, allowing runs to be repeated idempotently.
