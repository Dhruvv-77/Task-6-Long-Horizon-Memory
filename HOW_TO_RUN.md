# HOW_TO_RUN.md — Task 6 Long-Horizon Memory (Step-by-Step)

Complete command reference for `Task 6 memory` — from fresh clone to live demo. All commands assume **PowerShell on Windows** (path contains a space). Use quoted paths or the `workdir` param in the agent harness.

---

## 0. Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | 20+ | `node --version` |
| pnpm | 9+ | `pnpm --version` |
| Ollama | optional, for live mode | `curl http://localhost:11434/api/tags` |
| OS | Windows 10/11 (also Linux/macOS) | — |

**Ollama models (if you want live mode):**
```powershell
ollama pull qwen2.5:7b-instruct
ollama pull qwen2.5:3b-instruct   # optional fallback
ollama pull nomic-embed-text       # optional, for vector retrieval
ollama list
# should show qwen2.5:7b-instruct, qwen2.5:3b-instruct, nomic-embed-text
```

> **Without Ollama** everything still works — `eval` and `run` fall back to fully deterministic scripted simulation (no network, ~6s).

**Path with space:** the workspace root is `Task 6 memory`. Always quote it:
```powershell
cd "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory"
```

---

## 1. Install

From the **workspace root** (`Task 6 memory/`):

```powershell
# 1a. Enter the workspace
cd "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory"

# 1b. Install deps (workspace)
pnpm install
```

Expected: `node_modules/` appears at root and `packages/memory/node_modules/`.

---

## 2. Build

```powershell
# 2a. Build from root (delegates to @task6/memory)
pnpm build
# equivalent: pnpm --filter @task6/memory build  →  tsc (outDir dist, rootDir src)

# 2b. Or from the package itself
cd "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory\packages\memory"
pnpm build
# uses: tsc  (ES2022, NodeNext, strict, skipLibCheck)
```

Expected: no errors, `packages/memory/dist/` created (`cli.js`, `agent/loop.js`, etc.).

---

## 3. Test

```powershell
# 3a. From root
cd "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory"
pnpm test
# equivalent: pnpm --filter @task6/memory test → vitest run (20s timeout)

# 3b. From package (more verbose)
cd "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory\packages\memory"
pnpm test

# 3c. Filter a single suite (e.g. compaction)
pnpm test -- compaction
pnpm test -- loop
pnpm test -- cold-restart
pnpm test -- live-tools
pnpm test -- model
```

Expected (69 tests, 11 suites):
```
 Test Files  11 passed (11)
      Tests  69 passed (69)
   Duration  ~3s
```

Key suites: `working-memory.test.ts` (4), `compaction.test.ts` (6), `retrieval.test.ts` (9), `cold-restart.test.ts` (4), `loop.test.ts` (8), `eval.test.ts` (6), `live-tools.test.ts` (9), `model.test.ts` (8), `store.test.ts` (5), `persistent.test.ts` (5), `config.test.ts` (5).

---

## 4. Runtime Artifacts & State Lifecycle

The agent writes atomic checkpoints, episodic summaries, and persistent facts on every step to `.memory` (or `.memory-live` when running live with Ollama).

- **Automatic fresh runs:** Starting a new run with `pnpm memory run --task "..."` automatically clears previous completed checkpoints, ensuring no state or tool call history leaks into a new run.
- **Resuming an interrupted run:** If a process was killed mid-run (simulating "close the laptop, come back tomorrow"), pass `--resume` to pick up exactly where execution left off:
  ```powershell
  pnpm memory run --task "..." --resume
  ```
- **Manual cleanup (optional):**
  ```powershell
  cd "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory"
  Get-ChildItem -Path . -Filter ".memory*" -Directory -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  ```

---

## 5. Run the Agent (`pnpm memory run`)

The agent automatically detects whether an Ollama server is running locally on port `11434`:
- **If Ollama is running:** Running `pnpm memory run --task "..."` automatically executes **live with Ollama (`qwen2.5:7b-instruct`)** on `demo-repo`.
- **If Ollama is stopped / not installed:** It falls back automatically to the **deterministic simulation**.
- **Flags:** You can explicitly force simulation with `--deterministic`, force Ollama with `--live`, or resume with `--resume`.

### 5.1 Live mode (Ollama `qwen2.5:7b-instruct`)

With Ollama running, simply execute with no extra flags needed:

```powershell
cd "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory"

# Canonical live task
pnpm memory run --task "add logout to the auth module so its tests pass"
```

The CLI automatically ensures `demo-repo/src/auth.js` starts from its clean pre-logout state and renders the structured output card:

```text
┌─────────────────────────────────────────────────────────────┐
│            Task 6 — Long-Horizon Memory Agent               │
└─────────────────────────────────────────────────────────────┘
  Task:     add logout to the auth module so its tests pass
  Strategy: tiered_memory
  Mode:     live (Ollama qwen2.5:7b)
  Budget:   15 max steps

┌────────────────────┬─────────────┐
│ Metric             │ Value       │
├────────────────────┼─────────────┤
│ Status             │ ✔ Completed │
├────────────────────┼─────────────┤
│ Termination Reason │ finished    │
├────────────────────┼─────────────┤
│ Steps Executed     │ 5 / 15      │
├────────────────────┼─────────────┤
│ Memory Compactions │ 1           │
├────────────────────┼─────────────┤
│ Peak Context Usage │ 58% of cap  │
├────────────────────┼─────────────┤
│ Tool-Call Errors   │ 0           │
└────────────────────┴─────────────┘

✔ Final Answer:
  added logout to src/auth.js with invalidated Set, session now checks it, all tests pass
```

**Verify the edit in demo-repo:**
```powershell
# Run the test directly
node --test "demo-repo/test/auth.test.js"
# # tests 2 # pass 2 # fail 0
```

### 5.2 Deterministic scripted simulation

If you want to run the 40+ call sites refactor simulation deterministically without Ollama:

```powershell
cd "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory"

# Force deterministic mode
pnpm memory run --task "rename the auth module and update all 40+ call sites" --deterministic

# Test different memory strategies
pnpm memory run --task "update all imports" --strategy no_memory --deterministic
pnpm memory run --task "update all imports" --strategy naive_truncation --deterministic
pnpm memory run --task "update all imports" --strategy summarization_only --deterministic
pnpm memory run --task "update all imports" --strategy tiered_memory --deterministic
```

Expected output:
```text
┌─────────────────────────────────────────────────────────────┐
│            Task 6 — Long-Horizon Memory Agent               │
└─────────────────────────────────────────────────────────────┘
  Task:     rename the auth module and update all 40+ call sites
  Strategy: tiered_memory
  Mode:     deterministic simulation
  Budget:   15 max steps

┌────────────────────┬─────────────┐
│ Metric             │ Value       │
├────────────────────┼─────────────┤
│ Status             │ ✔ Completed │
├────────────────────┼─────────────┤
│ Termination Reason │ finished    │
├────────────────────┼─────────────┤
│ Steps Executed     │ 15 / 15     │
├────────────────────┼─────────────┤
│ Memory Compactions │ 6           │
├────────────────────┼─────────────┤
│ Peak Context Usage │ 67% of cap  │
├────────────────────┼─────────────┤
│ Tool-Call Errors   │ 0           │
└────────────────────┴─────────────┘

✔ Final Answer:
  completed: rename the auth module and update all 40+ call sites
```

---

## 6. Evaluation (12 scenarios × 4 strategies = 48 runs)

### 6.1 Ollama Live Evaluation (`pnpm memory eval`)

By default, `pnpm memory eval` is performed **by Ollama only** (`qwen2.5:7b-instruct` driver + `nomic-embed-text` hybrid retrieval embeddings). If Ollama is not running on port 11434, the command halts and instructs you to start it.

```powershell
cd "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory"

# Run full 12-scenario evaluation via Ollama
pnpm memory eval

# Or evaluate a quick subset / limit
pnpm memory eval --limit 1
pnpm memory eval --strategies tiered_memory,no_memory
```

Output:
```text
┌─────────────────────────────────────────────────────────────┐
│         Task 6 — Golden Memory Evaluation Benchmark         │
└─────────────────────────────────────────────────────────────┘
  Mode:       live (Ollama qwen2.5:7b + nomic-embed-text)
  Scenarios:  12 (7 standard, 3 recall-dependent, 2 pollution)
  Evaluating: 4 memory strategies (48 total runs)...

  [standard_long_horizon] rename-auth-40-files
    [1/48] no_memory            ... terminated (113% cap, 4 steps)
    [2/48] naive_truncation     ... ✔ complete (13 steps, 100% cap)
    [3/48] summarization_only   ... terminated (63% cap, 7 steps)
    [4/48] tiered_memory        ... ✔ complete (13 steps, 88% cap)
  ...

┌────────────────────┬────────┬────────┬────────┬───────────┬────────────┬────┐
│ Strategy           │ Resume │ Budget │ Recall │ Pollution │ Completion │ N  │
├────────────────────┼────────┼────────┼────────┼───────────┼────────────┼────┤
│ no_memory          │ 0.00   │ 0.00   │ 0.00   │ 0.00      │ 0.00       │ 12 │
├────────────────────┼────────┼────────┼────────┼───────────┼────────────┼────┤
│ naive_truncation   │ 1.00   │ 1.00   │ 0.00   │ 0.00      │ 1.00       │ 12 │
├────────────────────┼────────┼────────┼────────┼───────────┼────────────┼────┤
│ summarization_only │ 1.00   │ 1.00   │ 0.00   │ 0.00      │ 1.00       │ 12 │
├────────────────────┼────────┼────────┼────────┼───────────┼────────────┼────┤
│ tiered_memory      │ 1.00   │ 1.00   │ 1.00   │ 0.00      │ 1.00       │ 12 │
└────────────────────┴────────┴────────┴────────┴───────────┴────────────┴────┘

Strategy Behavioral Breakdown:
  • no_memory:          12 aborts (exceeds budget past cap as expected)
  • naive_truncation:   3 recall misses (drops load-bearing context as expected)
  • summarization_only: 3 recall misses (loses exact payloads as expected)
  • tiered_memory:      0 failures (100% recall & budget adherence)
```

### 6.2 Offline Deterministic Simulation (`--deterministic`)

For instant unit simulation (~6s, no model calls):
```powershell
pnpm memory eval --deterministic
```

### 6.3 Compare against baseline (`baseline.json`)

Verify current evaluation directly against the golden reference baseline:

```powershell
pnpm memory eval --compare baseline.json
```

Output:
```text
📊 Baseline Comparison (Reference timestamp: 2026-09-07T04:21:35.015Z):
┌────────────────────┬──────────────┬──────────────┬──────────────┬───────────────┬────────────────┐
│ Strategy           │ Resume (Δ)   │ Budget (Δ)   │ Recall (Δ)   │ Pollution (Δ) │ Completion (Δ) │
├────────────────────┼──────────────┼──────────────┼──────────────┼───────────────┼────────────────┤
│ no_memory          │ 0.00 (±0.00) │ 0.00 (±0.00) │ 0.00 (±0.00) │ 0.00 (±0.00)  │ 0.00 (±0.00)   │
├────────────────────┼──────────────┼──────────────┼──────────────┼───────────────┼────────────────┤
│ naive_truncation   │ 1.00 (±0.00) │ 1.00 (±0.00) │ 0.00 (±0.00) │ 0.00 (±0.00)  │ 1.00 (±0.00)   │
├────────────────────┼──────────────┼──────────────┼──────────────┼───────────────┼────────────────┤
│ summarization_only │ 1.00 (±0.00) │ 1.00 (±0.00) │ 0.00 (±0.00) │ 0.00 (±0.00)  │ 1.00 (±0.00)   │
├────────────────────┼──────────────┼──────────────┼──────────────┼───────────────┼────────────────┤
│ tiered_memory      │ 1.00 (±0.00) │ 1.00 (±0.00) │ 1.00 (±0.00) │ 0.00 (±0.00)  │ 1.00 (±0.00)   │
└────────────────────┴──────────────┴──────────────┴──────────────┴───────────────┴────────────────┘
```

### 6.3 Live evaluation with Ollama (optional)

If you want to run the 12 golden scenarios through live Ollama inference:
```powershell
pnpm memory eval --live
```

> `evals/golden-memory.jsonl` holds exactly 12 JSONL lines: 7 `standard_long_horizon`, 3 `recall_dependent` (constraint at step 2, query at finish), 2 `memory_pollution` (stale key at step 1 → fresh at step 4/5, `staleStrings` must NOT surface).

### 6.4 Programmatic eval (for debugging)

Create `packages/memory/eval-probe.mts`:
```ts
import { readScenarios, runEval } from "./src/eval/runner.js";
const scenarios = readScenarios("../../evals/golden-memory.jsonl");
const report = await runEval(scenarios.slice(0,2), { strategies: ["tiered_memory"], driverMode: "scripted" });
console.log(report.metrics);
for (const r of report.results) console.log(r.scenarioId, r.completed, r.resumeCorrect, r.recallCorrect);
```
```powershell
npx tsx eval-probe.mts
```

---

## 7. Working with the Demo Repo

```powershell
cd "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory\demo-repo"

# Structure
Get-ChildItem -Recurse | Format-Table FullName
# src/auth.js        — implementation (login, session, [logout])
# test/auth.test.js  — 2 tests: login, logout

# Run test directly
node --test test/auth.test.js
```

The task `"add logout to the auth module so its tests pass"` expects:
```js
// before (failing):
module.exports = { login, session };
// after (passing):
const invalidated = new Set();
function session(token) { if (invalidated.has(token)) return false; return typeof token==='string' && token.startsWith('t-'); }
function logout(token) { invalidated.add(token); return true; }
module.exports = { login, session, logout };
```

---

## 8. Architecture Quick Reference

| Layer | File | Key |
|-------|------|-----|
| Config | `packages/memory/src/config.ts:4` | `maxTokens 4000 / maxMessages 12 / compactionThreshold 0.75` (eval: `1500/8/0.7` in `eval/runner.ts:61`), `estimateTokens = ceil(chars/4)` |
| Working | `memory/working.ts` | `usageRatio = max(tokens/maxTokens, messages/maxMessages)`, `shouldCompact >= threshold`, `isOverflowing >` |
| Episodic | `memory/episodic.ts` | `compactOldestMessages` keeps 2 newest non-system, extracts `decision:`/`remember_fact` to persistent before summarizing |
| Persistent | `memory/persistent.ts` | key case-insensitive supersession `active=false supersededBy=newId`, `retrieve` active-only |
| Retrieval | `retrieval/hybrid.ts:bm25.ts:vector.ts` | BM25 + cosine (nomic-embed-text or hash fallback) → RRF k=60, topK 5 |
| Checkpoint | `store/disk.ts:32` + `agent/loop.ts:100` | atomic `tmp.<rand>→rename` (EPERM retry on Windows), `pendingToolCall` before `executeTool`, `recentCalls` in checkpoint `types.ts:94` |
| Live | `agent/model.ts:72` + `live-tools.ts:97` + `driver.ts` | `OllamaClient` `qwen2.5:7b-instruct`, `propose_edit` `oldText=""` append with duplicate guard, `run_test` path hint |
| Loop | `agent/loop.ts:125` | plan-act-observe, `recentCalls` persisted, stuck-loop `3×` or `X Y X Y`, hint injection for `undefined == function` |

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `pnpm: command not found` | pnpm not installed | `npm install -g pnpm` or `corepack enable` |
| `OLLAMA_URL` probe fails, `mode=deterministic` | Ollama not running | Start Ollama (`ollama serve`), pull model: `ollama pull qwen2.5:7b-instruct` |
| `stuck_loop` after 2 `run_test` | Tests already pass or model loops | The CLI auto-resets `demo-repo/src/auth.js` and finishes automatically when tests pass |
| `Could not find 'test/auth.js'` | Wrong test path | Use `test/auth.test.js` (list with `list_dir "test"`) |
| `propose_edit: oldText not found` | Copy mismatch | `read_file` first, copy exact text including newlines |
| `budget_exceeded` in eval | No compaction | Check `strategy` is not `no_memory`; verify `EVAL_WORKING_CONFIG` caps |
| Previous run state leaking | Stale checkpoint | Fresh runs auto-clean old checkpoints unless `--resume` is explicitly passed |

---

## 10. One-Shot Fresh Clone Verification

```powershell
# From a fresh clone:
cd "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory"
pnpm install
pnpm build
pnpm test          # 69 passed
# deterministic eval (no Ollama needed):
cd packages\memory
npx tsx src/cli.ts eval --strategies tiered_memory
# should show tiered_memory 1.00 on all metrics

# live demo (needs Ollama):
Remove-Item -Recurse -Force .memory-live -ErrorAction SilentlyContinue
# ensure demo-repo/src/auth.js has no logout (see §5.2 step 1)
npx tsx src/cli.ts run --task "add logout to the auth module so its tests pass" --strategy tiered_memory --max-steps 15
# should end: mode=live completed=true finished steps=5
node --test "C:\Users\dhruv\Desktop\Codage-Habitation\Projects\Task 6 memory\demo-repo\test\auth.test.js"
# # pass 2 # fail 0
```

---

## 11. File Map for Reviewers

```
evals/golden-memory.jsonl         — 12 scenarios (PRD §12)
packages/memory/src/cli.ts        — `run` + `eval` commands
packages/memory/src/types.ts      — all shared types (ToolCall, MemoryStrategy, ExecutionCheckpoint with recentCalls)
packages/memory/src/config.ts     — budgets + estimateTokens
packages/memory/src/memory/       — working/episodic/persistent (tiered)
packages/memory/src/retrieval/    — bm25/vector/hybrid (RRF k=60)
packages/memory/src/store/disk.ts — atomic writes, .memory/*, recentCalls
packages/memory/src/agent/        — loop (hint+fallback), model (Ollama), driver, executors, live-tools
packages/memory/src/eval/         — runner (cold-restart + killMidToolCall), metrics, compare
packages/memory/tests/            — 11 suites, 69 tests
demo-repo/src/auth.js             — live target (add logout)
demo-repo/test/auth.test.js       — live verification
DESIGN.md / NOTES.md / RESULTS.md — rationale, loss analysis, numbers
HOW_TO_RUN.md                     — this file
```

For PRD details see `task-6-long-horizon-memory-INTERN.pdf:6` (layout) and `:12` (golden set).
