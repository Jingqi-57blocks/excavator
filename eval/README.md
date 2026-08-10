# eval — semantic knowledge diff harness

A deterministic diagnostic loop for "change something → see a **semantic** before/after".
It is **not** an audit gate: it does not touch `ASSURANCE_VERSION` and is not wired into
`excavator audit`. It extracts normalized `Knowledge` from a run directory and diffs it
against a hand-written `expected-knowledge.json`.

Zero runtime dependencies, zero model calls in the harness itself. The only model step is
producing a run (authoring); everything the harness does is a pure function of files on disk.

## What it produces

- `knowledge.ts` — run dir → `Knowledge` (facts, relations, coverage, unknowns, prepare horizon). Read-only on the run.
- `expected.ts` — load + hand-written structural validation of `expected-knowledge-v1` (zero-dep; no Ajv).
- `diff.ts` — pure `Knowledge × Expected → Diff` (found / missing+attribution / forbidden hits / coverage failures).
- `cli.ts` — `extract` and `diff` commands.

## Commands

```
npm run eval -- extract --run <dir> [--out <file>]
npm run eval -- diff --run <dir> --expected <file> [--json] [--prepare-only]
npm run eval -- view --run <dir> [--json]
```

`diff` exits **1** on any mustFind missing, forbidden violation, or coverage failure; **0** otherwise.

`view` has no semantic-fail concept: it exits **0** on success and **2** on error (missing run dir,
missing `metrics.json`/`timeline.jsonl`, malformed timeline). It is read-only on the run dir.

## `view` — run observability

Renders one existing run's `metrics.json` + `timeline.jsonl` into a readable view. Default output is
text; `--json` emits the structured `RunStats` model (consumed by the next increment — cross-run
metrics delta — so it is internal/evolving and carries **no** stability promise). `view` reads only
those two files; it produces `run-stats.ts` (pure `runDir → RunStats`) and renders via
`render-run-stats.ts` (which owns every human string).

- `run-stats.ts` — `runDir → RunStats`. Read-only, zero-dep. Exports the `RunStats` types.
- `render-run-stats.ts` — `RunStats → string`. Owns the honesty legend, action-specific narrative
  summaries, and the generic fallback for UNKNOWN actions/stages.

### Wall-clock attribution (the gap algorithm)

Excavator records event timestamps, not per-step durations, so per-stage/per-document wall clock is
**gap-attributed**:

- events are ordered by `sequence` (file order out of order is a WARN in `anomalies`, never a failure);
- `metrics.startedAt → at[event 1]` is the **prepare** stage's opening gap (event 1 is `run.prepared`);
- for every later event `i`, `gap = at[i] − at[i−1]`, charged to the **stage of event `i`** — the event
  that *closes* the gap, i.e. where the wall time went;
- negative gaps (clock skew) clamp to 0 and raise an `anomaly`;
- the run total is the authoritative `startedAt → finishedAt`, kept next to `metrics.timing.totalMs`
  as a cross-check.

Per-document split buckets each gap to the **last-seen** `document.begin` (a `document.begin`'s own
opening gap lands in the document it opens; gaps before the first one go to `(before first document)`).

### Honesty legend (mandatory, rendered in every text view)

The gap-attributed wall clock **includes the host agent's own thinking and CLI execution between
calls**, which Excavator cannot observe or separate out. Only the Core prepare timings
(`metrics.timing`) are directly measured. The **top-N longest gaps** table exists to show that
invisible latency as raw fact rather than smoothing it away. The view runs **no audit** and does
**not** verify the timeline hash chain.

### Counter attribution semantics (shown raw, never reconciled)

- **Searches** — the view prints one line per `source.search` timeline event *and* the metrics
  counters side by side, because they legitimately differ and are never silently reconciled:
  `metrics.sourceSearches` counts cache **misses** only, `metrics.sourceSearchCacheHits` counts cache
  **hits** only, so `sourceSearches + sourceSearchCacheHits = ` the number of timeline search events.
  `metrics.sourceFilesSearched` counts files scanned across cache-missing searches (a cache hit scans
  none).
- **Graph queries** — reported as **counts only** (`graphQueries` / `graphQueryCacheHits`). There are
  no graph-query timeline events, so a per-query narrative is impossible without a Core change to the
  hash-chain event stream (out of scope — see `docs/pending-decisions.md`).

## Diff semantics (summary)

- **fact hit** — a claim whose cited `S-*` window matches an anchor (path in three forms:
  `root/path` exact | `endsWith("/"+path)` | bare `path` exact; line overlap when the anchor
  carries lines, else path suffices) **and**, if `statementPatterns` are given, all of them match
  that claim's statement (AND). The evidence anchor is the primary signal; text patterns are
  optional, change-resistant tightening.
- **relation hit** — a trace step whose evidence covers an anchor (optional `stepPatterns` match the step action).
- **unknown hit** — an `unavailable` claim or `cannot-determine` workitem whose text matches all `patterns` (AND).
- **forbidden violation** — a claim with a marker in the rule's set (default `fact`/`verified`) whose
  statement matches all patterns (AND) → a red hallucination.
- **coverage check** — for a `dimension`, at least one workitem of that dimension must have a status in
  `expect` (this is how `searched-not-found` honesty is asserted).
- **miss attribution** — a missing mustFind whose anchor file is in the prepared horizon (fact-pack files
  or feature scope) → `authoring-miss`; not in scope → `prepare-miss`.

## Loop latency tiers

The point of the harness is that most iterations never call a model:

- **(a) change the harness or `expected-knowledge.json` → re-diff an existing run: sub-second.**
  Pure recomputation over files already on disk. Fastest inner loop for tuning anchors, patterns,
  forbidden pins and coverage expectations.
- **(b) change prepare rules → `--prepare-only`: seconds, zero-model.**
  Runs only the anchor-⊆-scope containment check. Answers "did the changed prepare still put every
  expected anchor in scope?" without authoring anything.
- **(c) change a SKILL / prompt → one small `leave-mini` authoring run (minutes; the only model step) →
  diff sub-second.** Author once against the tiny fixture, then re-diff instantly. Keep the fixture
  small precisely so this single model step stays cheap.

## Fixtures

- `fixtures/leave-mini/` — a ~9-file synthetic leave service (authorization: employee/manager/hr roles
  + a data-scope rule; approval-flow: two-level approval + balance deduction), a fixed `request.json`
  (zh-CN), and a hand-written `expected-knowledge.json`. It deliberately implements **no notification**
  capability, so the `no-email-notification` forbidden pin catches that specific hallucination.
- `tests/fixtures/run-mini/` — hand-written run artifacts (evidence/claims/traces/workitems/checklist/
  factpack/scope) plus `expected-pass.json` / `expected-fail.json` that drive the deterministic tests.
