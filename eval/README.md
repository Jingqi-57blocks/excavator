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
```

`diff` exits **1** on any mustFind missing, forbidden violation, or coverage failure; **0** otherwise.

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
