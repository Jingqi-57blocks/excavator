---
name: excavator
description: Generate product-facing and engineering-facing project overviews and feature reports from a target source workspace, optionally using an existing CodeGraph database as an acceleration layer.
---

# Excavator

Use this skill when a user asks to understand a source workspace and produce one or more Markdown reports about the whole project or named business capabilities.

## Invocation

User-facing command: `/excavator`

Supported requests:

- project overview only;
- one feature report;
- several feature reports;
- overview plus one or several feature reports;
- product audience, engineering audience, or both;
- a `prd` feature audience — a requirement-shaped statement of a feature's current behavior. Feature-only: there is no prd overview, and `both`/`all` never imply prd (request it by name);
- any output language.

Examples:

```text
/excavator overview --audience product
/excavator overview --audience engineering
/excavator feature "Account access" --audience both
/excavator feature "Attendance check-in" --audience prd
/excavator report --overview both --feature "Account access" --feature "Billing"
/excavator resume <run-id>
```

## Inputs

Required:

- target source directory.

Optional:

- an explicit CodeGraph SQLite database; otherwise Excavator auto-detects `<target>/.codegraph/codegraph.db`;
- source-only mode, when requested;
- output language, defaulting to the user's language;
- requested audiences and feature subjects;
- feature search aliases generated from the user's subject.

Treat the target as read-only. Do not run target scripts, install target dependencies, start services, execute migrations, connect to databases, or display secret configuration values.

All Skill instructions, report templates, prepared prompts, and tool-facing investigation instructions are written in English. The requested language controls only the generated report content, headings, diagram labels, and visible evidence-level wording.

## Architecture boundary

Source code is the required and complete reviewed artifact. CodeGraph is an optional compressed navigation index. Normal report generation must not install CodeGraph, run its installer, or create an index automatically.

Use CodeGraph to:

- locate files, symbols, routes and likely entry points;
- expand calls, references and type relationships;
- narrow a feature boundary;
- avoid repeated repository searches.

Provider selection:

- honor explicit source-only mode first;
- otherwise use an explicit readable database;
- otherwise auto-detect `<target>/.codegraph/codegraph.db`;
- otherwise continue in source-only mode.

Read bounded source windows when:

- CodeGraph is absent;
- a language or file is not indexed;
- extraction recorded an error;
- a relationship is unresolved;
- several candidates are ambiguous;
- the graph has a name but not enough semantics;
- permissions, rules, states, error handling, storage, handler roles or route composition must be confirmed;
- graph and source appear to disagree.

Do not reject an unsupported project merely because CodeGraph coverage is incomplete. Switch the affected scope to source fallback.

## Request preparation

Create a request JSON and run:

```bash
excavator prepare --request request.json
```

Example:

```json
{
  "target": "/workspace/project",
  "language": "en-US",
  "workdir": "/workspace/.work",
  "overviewAudiences": ["product", "engineering"],
  "features": [
    {
      "subject": "Account access",
      "aliases": ["access", "permission", "role"],
      "audiences": ["product", "engineering"]
    }
  ]
}
```

Generate aliases semantically from the subject before preparing the run. Aliases are navigation terms, not report terminology.


## Optional index management

Do not install CodeGraph automatically. When the user explicitly asks to inspect or build the optional index:

```bash
excavator codegraph status --target /workspace/project
excavator codegraph build --target /workspace/project
```

`codegraph build` only invokes an existing `codegraph` executable. If it is missing, return the installation choices emitted by the command and let the user decide. Never execute installer commands on the user's behalf as part of report generation.

## Context reuse

A combined request is one investigation, not several independent runs.

- Build the shared project context once.
- Build one scope per normalized feature subject.
- Product and engineering reports for the same feature reuse that scope.
- All documents reuse the same evidence catalog and source-window cache.
- Do not repeat a graph query or source window already present in the run.
- When multiple features share a source window, cite the same evidence ID.

## Investigation workflow

The prepare command creates a run under the target's own directory inside the workdir, `<workdir>/<project>[-<hash>]/runs/<run-id>/`, alongside that target's caches. The `<project>` segment is the target's basename; the `-<hash>` suffix is added only when a different target would collide on that basename. Use the `runDir` value the command prints rather than composing the path. When runs from the old un-suffixed `<workdir>/<project>/runs/` layout are stranded by such a collision, prepare emits a warning that names the old path; those historical runs are not picked up automatically.

```text
<workdir>/<project>[-<hash>]/runs/<run-id>/
├── context/
│   └── authoring/            # per-document authoring packets (written by freeze)
├── evidence.json
├── analysis-scope.json
├── provider-status.json
├── workitems.json
├── traces.json
├── knowledge.json              # frozen investigation record (written by freeze)
├── timeline.jsonl
├── checklist.json              # compatibility view of workitems
├── prompts/
├── sections/
├── claims/
├── history/
├── drafts/                     # pending parallel-draft receipts, cleared by collect
├── reports/
│   └── companions/
├── audit/
├── run.json
└── metrics.json
```

Investigate before you write. After prepare and before any `begin`, work the plan in `workitems.json` feature by feature and dimension by dimension so that all knowledge is in place before authoring starts.

- Treat `workitems.json` as the primary investigation plan and coverage ledger. Every required item ends as `found`, `searched-not-found`, `cannot-determine`, or `not-applicable`. Do not delete a required item. An item that static analysis cannot answer records why, what would settle it, and evidence establishing the limitation.

  ```bash
  excavator workitem --run <run-dir> --file <workitem-updates.json>
  ```

- Reading is accounted for, not assumed. A `logic-disposition` work item names one decision function and its line span; disposing it `found` requires at least one recorded source window that OVERLAPS that span. Freeze rejects a `found` disposition whose citations never touch the function it reports — record the window over the decision function, or dispose the item `cannot-determine` / `not-applicable` with its reason.

- Freeze also reports a read residual: every in-boundary decision function that was never opened, or only partly opened, with the unread line ranges. Those are advisories, not blockers. Clear the ones that matter before freezing, and read the ranges rather than the signature — a decision function's thresholds and branch conditions live in its body, so opening only its opening lines leaves the rule unread. `coverage/read-obligations.json` (the frozen denominator) and `coverage/read-residual.json` (what was and was not read) carry the detail. Read coverage is relative to the retained boundary: full coverage never means nothing was missed.

- Search under the immutable run snapshot when the prepared context does not identify a path, and retain the reusable receipt. Repeating the same snapshot-bound search is a cache hit; a `searched-not-found` disposition cites the returned `SEARCH-*` evidence ID.

  ```bash
  excavator search \
    --run <run-dir> --terms "permission,authorize,role" \
    --path-prefixes "src,services" --max-results 50 \
    --reason "investigate inline authorization"
  ```

- Record a bounded source excerpt before using it, when more source is required than the context carries.

  ```bash
  excavator source \
    --run <run-dir> --path <relative-path> --start <line> --end <line> \
    --reason "why this excerpt is needed"
  ```

- Record a trace for each evidenced call, business, data, state, cross-repository or analysis path. A verified trace has sequential steps and evidence for every step.

  ```bash
  excavator trace --run <run-dir> --file <trace-updates.json>
  ```

Establish the following while investigating, not at audit:

- **Equivalence needs every side.** A `fact` claim that asserts equivalence, consistency, sameness, or shared values or behavior across implementations, modules, repositories, or runtime parts must cite evidence for every compared side and group it in the claim's `sides` field; when only one side is observed, record the other's evidence or downgrade to `inferred`.
- **Material flows need a verified trace, planted up front.** A material work item for a normal, decision, or reversal flow, a state lifecycle, or a side effect (notifications or exports) that ends `found` requires a verified trace. A `found` flow item with no trace is a hard audit error, so record the trace while investigating rather than discovering the requirement at audit.
- **The feature fact pack is a floor, not a ceiling.** Each feature scope carries a deterministic fact pack (`context/features/<feature>.factpack.json`, also rendered as a section of the scope) that enumerates six categories — entrypoints, entities, states, config-keys, jobs, external-calls — each item at `file:line`, with a per-category coverage row (method, item count, truncated flag, note). It is an enumeration of what was found inside the feature boundary, not a sample. When a category is marked truncated or carries an incompleteness note, treat it as a floor: investigate beyond it with `search` and `source`, and do not treat the listed items as the complete set.
- **Read past the shape into the decision.** Enumerating names — states, types, methods, rules — is the shallow half of investigation. For each named thing, a report needs the condition, value, caller, or outcome that gives it meaning. Disposing an item on names alone leaves the deciding half uninvestigated. The four points below are the recurring shapes of that deciding half; apply them to any domain, never by looking for a specific value.
- **Tiers and levels have a selecting condition.** When a states or flow enumeration lists tiers or levels — approval tiers, escalation levels, graded thresholds — locate the condition that selects each tier before disposing the decision-flow or calculations-and-thresholds item. The tier names are the shallow half; the numeric or record condition that routes into each tier is the half a report needs.
- **A named function or method has callers — or provably none.** When the investigation names a function, method, or handler, resolve who calls it before disposing the item. "Defined in the code" and "reached from an entry point" are different findings: a method with no caller in the reviewed workspace is a distinct, reportable fact ("no caller found in the reviewed paths"), not a detail to drop. Search the identifier across the scope before treating it as used or as dead.
- **A rule with a value states the value and its source.** When a business rule turns on a specific value — a limit, a count, a duration, a status code, a role rank — record the literal and the `file:line` where the code compares against it, not merely that "a check exists". A rule described without its deciding value is the shallow half; the value and the guard that reads it are what a report needs.
- **A condition with branches states each branch's outcome.** When code branches on a condition — a type, a status, an office, a flag — enumerate what each branch does, not only that a branch exists. A conditional reported as "handles different cases" without naming the cases and their distinct outcomes has been read but not investigated.

`checklist.json` is retained as a compatibility projection and may still be updated through the legacy `checklist` command.

## Freeze

When every required work item is disposed and every material flow is traced, freeze the investigation:

```bash
excavator freeze --run <run-dir>
```

Freeze is a deterministic gate: it admits the run only when the investigation would already pass audit — every required item disposed, every `found` material flow carrying a verified trace, the evidence catalog and its digest intact, and the snapshot unchanged. On a non-zero exit it reports the exact gaps — items still pending, flows still missing a trace — so continue investigating and freeze again. On success it writes `knowledge.json`, the frozen record authoring consumes, and renders one authoring packet per document under `context/authoring/<document-id>.md`: a deterministic, model-free view of the frozen knowledge organized by report section, listing the work items, deterministic facts and evidence excerpts each section must cover. Freeze once; a change after freeze goes through the supplement channel described below.

Under the current assurance version freeze is a hard precondition of authoring, not a suggestion: `excavator begin` refuses an unfrozen run, and a run authored without — or before — a freeze fails audit. Runs prepared under an older assurance version are grandfathered and keep the earlier soft guidance.

## Authoring workflow

Budgets derive from the request size (the number of requested documents and features), not a fixed ceiling. Check status after each major section and stop when the authoring budget is exceeded. A budget timeout stops the *next* section, never the one in hand: the current section is checkpointed to disk before the run stops, and `excavator resume --run <run-dir>` continues from the first incomplete section.

Authoring consumes the frozen knowledge and does not re-investigate. Every substantive section must carry a real backtick evidence-level marker in its visible prose — `fact`, `verified`, `inferred`, or `unavailable`, or their localized equivalents in the requested output language. Under the current assurance version, a substantive section with no real marker is a hard audit error, not a warning. See `references/writing-rules.md` for the marker semantics and the claim binding contract.

Author each document one section at a time. Two shapes produce the same audited result: a fully serial `checkpoint` per section (below), and — when the host can run concurrent writing subtasks — a parallel `draft` per section followed by one serial `collect` (see *Parallel drafting*). The parallel shape only moves where each section's timeline event is recorded, into `collect`; the workflow remains valid fully serial.

For each document:

1. Read its prompt file.
2. Start its timer:

   ```bash
   excavator begin --run <run-dir> --document <document-id>
   ```

3. Write one template section at a time. Start from that section's block in `context/authoring/<document-id>.md`, drawing on the frozen evidence, work items and traces already in the run: cover every work item, deterministic fact and evidence excerpt the block lists for the section, or state explicitly why it does not apply.
4. Generate the claims skeleton from the written section, then fill it in:

   ```bash
   excavator claims scaffold \
     --run <run-dir> --document <document-id> --section <n> \
     --file <section.md>
   ```

   It emits one claim stub per substantive segment using the exact segmentation the audit enforces, so a hand-derived skeleton can never drift from what audit expects. Each stub defaults to the `fact` marker with empty `evidenceIds` and `workItemIds`; fill in the evidence and work-item links and adjust each marker to the right evidence level before checkpointing.

5. Save each section and its claims immediately:

   ```bash
   excavator checkpoint \
     --run <run-dir> --document <document-id> --section <n> \
     --file <section.md> --claims <section-claims.json>
   ```

   Each claim names an exact statement that appears in the section. `fact`, `verified`, and `inferred` claims cite evidence IDs that also appear in the section's collapsed evidence block. `unavailable` claims carry a reason and no evidence IDs. Claims also list the work-item IDs they satisfy, and every material work item required for the document must be represented by at least one claim that reuses that work item's evidence or trace.

6. Check status after every major section. Stop when the authoring budget is exceeded; do not silently extend it. Once a document's sections are all checkpointed, audit that document in isolation before moving on:

   ```bash
   excavator audit --run <run-dir> --document <document-id>
   ```

   A single-document audit checks that document's sections, claims, and the shared evidence catalog as hard errors, but run-wide completeness checks (plan and checklist completion, material work-item coverage) degrade to advisory findings and no run state is mutated. Use it mid-authoring; it does not replace the final full-run audit.

7. Assemble and audit the whole run:

   ```bash
   excavator assemble --run <run-dir>
   excavator audit --run <run-dir>
   ```

### Parallel drafting

The per-section work in steps 3–5 — read the section's packet block, write the section, scaffold and fill its claims — is independent across sections once the investigation is frozen, so the host may run it concurrently. When the host can run concurrent writing subtasks, `begin` each document serially as in step 2, then spawn one writing subtask per not-yet-complete section. Each subtask reads its section block in `context/authoring/<document-id>.md` and the document prompt, writes the section, scaffolds and fills its claims, and records the section with `draft` in place of `checkpoint`:

```bash
excavator draft \
  --run <run-dir> --document <document-id> --section <n> \
  --file <section.md> --claims <section-claims.json>
```

`draft` writes only that section's files and a receipt under `drafts/`; it never touches the shared timeline, manifest or metrics, so concurrent drafts of different sections cannot collide. It runs the same section and claims validation `checkpoint` does, and refuses an unfrozen run exactly as `begin` does. A host that cannot run concurrent subtasks simply keeps using `checkpoint` and never needs `draft` or `collect`.

**Concurrency contract.** While drafts are in flight, the only run-changing command that may run is `draft`. Keep `begin`, `checkpoint`, `collect`, `assemble`, `audit` and any supplement (a `source`, `search`, `workitem`, `checklist` or `trace` carrying `--supplement-reason`) in serial segments — never concurrent with a draft or with each other. `status` and `claims scaffold` are read-only and may run anytime. Draft exactly one writer per section. If a subtask finds a knowledge gap while writing, do not open a supplement in parallel: record the gap and defer it to a serial segment after collect.

**Collect barrier.** When every drafting subtask has finished, record them all with one serial `collect`:

```bash
excavator collect --run <run-dir>
```

`collect` reads the receipts in a deterministic order — document order, then section index — and appends each section's timeline event and manifest update one at a time, so the append-only hash chain is identical to a serial run's. It is a no-op when nothing is pending, so it is safe to rerun. After collect, run the per-document scoped `audit`, then `assemble` and audit the whole run exactly as in steps 6–7. A revised section after collect may go back through `draft` (and another `collect`) or through `checkpoint`; both paths are valid.

When the frozen knowledge is genuinely insufficient — a claim you cannot ground in any existing evidence, or a work item whose frozen disposition is wrong — do not re-open routine investigation and do not edit the artifacts silently. First decide whether it is an expression problem; the evidence you need is usually already in the catalog under a different framing. Only when it is a real knowledge gap, re-run the relevant command with a supplement, which performs the operation and records the exception in the coverage ledger:

```bash
excavator search \
  --run <run-dir> --terms "escalation,approver" \
  --reason "confirm an escalation path the frozen evidence does not cover" \
  --supplement-reason "the frozen catalog carries no evidence for multi-level escalation" \
  --supplement-workitem feature:<key>:decision-flow
```

The same `--supplement-reason` and `--supplement-workitem` pair applies to `source`, `workitem`, `checklist` and `trace`. Both flags are required together, and the work item must already exist in `workitems.json`. Every supplement is counted in `metrics.supplements` and audited: a post-freeze mutation with no recorded supplement fails audit.

## Recovery

On interruption or timeout:

```bash
excavator resume --run <run-dir>
```

Resume from the first incomplete section. Do not rebuild CodeGraph, shared context, feature scopes, or completed sections. If the original model session cannot resume, read the document prompt, completed sections, and only the incremental context needed for the next section.

A failed parallel drafting subtask leaves no receipt, so its section is never collected and stays incomplete — `resume` and `status` list it like any other unwritten section. Re-draft that section and run `collect` again; an uncollected receipt left over from an interrupted run is recorded by the next `collect` and, until then, surfaces as an audit warning.

## Report contracts

Read `references/writing-rules.md` and the appropriate template:

- `references/product-overview.md`
- `references/product-feature.md`
- `references/engineering-overview.md`
- `references/engineering-feature.md`
- `references/prd-feature.md` (the `prd` feature audience; feature-only, no prd overview)

Product reports explain business meaning and current behavior without implementation detail in the reading flow.

Engineering reports include business behavior plus current technical implementation: repository and runtime responsibilities, stacks, communication, APIs, storage, files, authentication, configuration, jobs, errors, tests and technical problems.

Both report types:

- reflect the current snapshot only;
- may infer business meaning from code when grounded and marked;
- distinguish fact, inference, verified search and unavailable information;
- state observed problems and what the code permits;
- do not provide recommendations, remediation, future architecture or action items;
- produce Markdown as the primary output.

## HTML conversion

HTML conversion is a separate tool with no analysis dependency:

```bash
excavator-html build \
  --input <run-dir>/reports \
  --output <site-dir> \
  --title "Project report"
```

It reads only final Markdown files. The top navigation includes only the supplied reports, ordered by front matter. It must not read CodeGraph, source files, run caches or evidence catalogs.


## Assurance rules

The audit must fail when any of these is true:

- a cited evidence ID is absent;
- a source range is outside the target, outside the file, stale, or from another snapshot;
- a structured evidence digest no longer matches;
- a section has substantive prose but no claims sidecar;
- a substantive section carries no real evidence-level marker (under the current assurance version);
- any substantive sentence or table row is not bound to a claim;
- a claim statement is not present in the section;
- claim evidence is not cited in that section's evidence block;
- the analysis scope or provider registry changes after preparation;
- the append-only timeline digest chain is broken;
- a required work item remains pending, is removed, or cites invalid evidence;
- a material flow work item has no verified trace;
- a trace contains missing evidence, claims, documents, or non-sequential steps;
- a claim declares comparison `sides` with fewer than two groups, overlapping groups, or evidence the claim does not cite;
- a current-version run is authored without first freezing the investigation, or was authored before the freeze;
- a frozen evidence id, work item or trace is deleted from the run after freeze;
- an investigation artifact is mutated after freeze without a recorded supplement;
- the frozen knowledge digest no longer matches the run manifest;
- the target source or CodeGraph identity changes after preparation.

Audit also warns — without failing — when a `fact` claim uses comparative wording but cites a single source unit and declares no `sides`, so a single-sided equivalence is surfaced for the author to cite the other side or downgrade.

These rules are framework- and project-independent. Never add a target-project name, hard-coded route, table, role, repository, business identifier, or special-case parser to satisfy a real-project test. Express every fix as a generic invariant or a synthetic fixture.

## Assurance artifact model

Use this chain for report claims:

```text
Analysis Scope
  → Investigation WorkItem
  → Evidence
  → Claim
  → Trace
  → Report paragraph or table row
```

`timeline.jsonl` is append-only and hash-chained. It records preparation, investigation searches and source windows, the investigation freeze, checkpoints and revisions, work-item and trace updates, assembly, audit, timeout, and recovery. The assembled report directory contains machine-readable claims, traces, and coverage companions for each document.
