# NOTES.md — Task 6 Long-Horizon Memory

## What a summarization pass predictably loses (tested, not asserted)

1. **Verbatim tool output.** Compacted tool results are condensed to shape-only notes
   (`[tool output: N chars, M lines]`). Test: `compaction.test.ts` — "loses verbatim
   detail" compacts a 500-char output containing `TransActionId 9f3x` and asserts the
   summary is shorter and the token `9f3x` is gone.
2. **Exact fact payloads (summarization-only).** Without persistence, a summary notes
   *that* a fact was recorded (`Noted (content dropped): db-host`) but not its content.
   Test: the eval golden recall cases score `recallCorrect=false` under
   `summarization_only` (`eval.test.ts`), while the same cases score true under tiered.
3. **Tool-call argument payloads.** Assistant previews render as `[tool call: name]`
   without arguments, so a `remember_fact` payload cannot leak into a summary through
   its call envelope. (Found while writing the recall tests: the first-line preview
   initially quoted the full call JSON and summarization-only "recalled" by accident.)
4. **Ordering nuance across many compactions.** Older summaries roll into a single
   `DIGEST` keeping step ranges and preserved facts only. Test: `rollUpSummaries`
   keeps the newest full summary plus one digest; re-rolling is safe because the
   digest round-trips through the same `Preserved:` shape.

## How it is mitigated

- **Extract-then-compact:** `decision:` / `constraint:` lines and `remember_fact` calls
  are pulled into persistent memory *before* anything is discarded — but only under
  `tiered_memory`. This ordering is what preserves recall.
- **Key-based supersession:** a repeated key (case-insensitive) retires the old fact.
  Retrieval ranks active facts only, so corrections win and stale facts do not resurface
  (the 2 pollution scenarios guard this; `persistent.test.ts` pins the mechanism).
- **Bounded working state:** resume injects only the latest summary; retrieval notes
  rotate to one message; summaries roll up to newest-plus-digest. Without these,
  system messages accumulate and compaction can never recover — found via a real
  `budget_exceeded` on resume during development, fixed, and covered by
  `cold-restart.test.ts`.
- **Write-ahead checkpoints:** the pending call is logged before execution and the
  executed id recorded right after, so all three kill timings (between steps,
  mid-tool-call, post-execute) resume exactly once. Atomic tmp→rename writes (with a
  short retry for Windows file locking) mean a kill can never leave half-written JSON.

## Why RRF over weighted averaging (Task 2 reuse)

Cosine similarity lives in roughly [0,1] with a compressed useful range; BM25 is
unbounded and corpus-dependent. Averaging them needs a normalisation constant that
breaks the moment the corpus changes. RRF discards magnitudes and fuses rank positions
(`1/(60+rank)`), so it is scale-free. k=60 per the Task 2 brief.

## No LLM judge — deliberately

Faithfulness-style judging would need a model and a rubric, which would break the
"every number reproduces from a fresh clone" gate. All four metrics are computed from
run artifacts with string/subset comparisons (completed-work prefix equality, usage
ratios, retrieval hit checks, stale-string absence). There is no judge-leakage class
of error because there is no judge.

## What MCP / Task 3 / Task 4 contributed

- Task 3: one tool call per turn, harness-enforced budgets, stuck-loop abort (same
  call 3×), approval gate that fails loudly, JSONL-style per-step records.
- Task 4: typed trajectory events, "shared state, not shared context" (the reason
  facts are retrieved per step, never injected wholesale), trajectory-level scoring
  precedent for resume correctness.
- Forbidden carry-overs respected: no agent frameworks, no shell tools, no servers —
  files + in-process code only.
