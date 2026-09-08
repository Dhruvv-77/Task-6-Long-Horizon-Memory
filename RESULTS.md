# RESULTS.md — Task 6 Long-Horizon Memory Evaluation

Golden set: `evals/golden-memory.jsonl` — 12 scenarios (7 standard long-horizon,
3 recall-dependent, 2 memory-pollution). Each scenario runs under all four strategies
with a mid-run process kill (2 kills land mid-tool-call), so 48 runs total.

Reproduce:
- **Live Ollama evaluation (default):** `pnpm memory eval` (performed live by Ollama `qwen2.5:7b-instruct` + `nomic-embed-text`)
- **Fast deterministic simulation:** `pnpm memory eval --deterministic` (~6 s, zero network/model calls)
- **Compare against recorded baseline:** `pnpm memory eval --compare baseline.json`

```
strategy            resume  budget  recall  pollution  completion  n
no_memory             0.00    0.00    0.00       0.00        0.00  12
naive_truncation      1.00    1.00    0.00       0.00        1.00  12
summarization_only    1.00    1.00    0.00       0.00        1.00  12
tiered_memory         1.00    1.00    1.00       0.00        1.00  12
```

## Attribution — what moved which metric, and why

- **no_memory fails past N steps (budget 0.00, completion 0.00).** With no enforcement,
  working memory grows past its cap on every scenario and the run aborts with
  `budget_exceeded` rather than silently forgetting. That loud failure is the point:
  it is the control row everything else is measured against.
- **naive_truncation restores budget and completion (1.00 / 1.00) but recall stays 0.00.**
  Dropping the oldest messages fits the window, and the dropped messages are exactly
  where the early decisions lived. Capacity fixed, addressability destroyed.
- **summarization_only also restores budget and completion — and recall still stays 0.00.**
  This is the row that matters. The summaries read fine, but a summarization-only
  summary records *that* a fact was noted (a key reference) without retaining its exact
  payload. A summary that says "recorded db-host" cannot answer "which host". This is
  the "reads fine and is still wrong" failure mode from the brief, measured rather
  than asserted.
- **tiered_memory adds explicit persistent writes plus per-step hybrid retrieval, and
  recall goes to 1.00 while nothing else regresses.** Summarization and retrieval are
  not redundant: summarization answers "how do I fit?" (capacity — rows 3 vs 1),
  retrieval answers "how do I find the exact fact later?" (addressability — rows 4 vs 3).
  The two rows differ *only* in recall, which is the cleanest possible evidence.
- **Memory pollution is 0.00 everywhere including tiered.** The two pollution cases feed
  a stale fact early and correct it later; key-based supersession (`active=false`,
  `supersededBy`) plus active-only retrieval means the stale text never resurfaces in
  the final answer or the final retrieved context. The category exists to guard that
  mechanism — it would fail if inactive facts were ever ranked.
- **Resume correctness is 1.00 for every strategy that completes.** Checkpointing is
  deliberately strategy-orthogonal: write-ahead pending records plus idempotent,
  call-id-keyed tools give exactly-once resume for between-step kills, mid-tool-call
  kills (`rate-limit-endpoint`, `recall-api-version`), and post-execute kills alike.
  `no_memory` scores 0.00 here only because its post-restart runs also overflow —
  it cannot resume what it cannot fit.

## Method notes (for reproducibility)

- Deterministic simulation: a scripted driver feeds tool results; no model calls.
  Three consecutive full runs produced byte-identical tables.
- Eval working-memory caps are 1500 tokens / 8 messages (`EVAL_WORKING_CONFIG`) so
  compaction fires within a few steps; production default is 4000 / 12.
- Tokens are `ceil(chars/4)` estimates, identical across strategies.
- Retrieval default: hybrid BM25 + local hashed-token vectors, RRF k=60, topK 5.
  Ollama `nomic-embed-text` is opt-in via `OLLAMA_URL` and was *not* used for these numbers.
