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

All Skill instructions, report templates, rendered planner and unit packets, and tool-facing investigation instructions are written in English. The requested language controls only the generated report content, headings, diagram labels, and visible evidence-level wording.

## Architecture boundary

**Machine artifacts are not model input.** `evidence.json` and its shards/content store, `workitems.json`, `traces.json`, `checklist.json`, `knowledge.json` and the machine fact pack (`context/features/<feature>.factpack.json`) are authoritative machine and audit storage: read them with Excavator commands, never by loading them into model context. What a unit is written from is its packet (`excavator plan-packet --run <run-dir> --unit <id>`), which renders every bound record in full and never truncates — so there is no gap in it that reaching for the raw files would close. Paths to those files appear in this document so you can recognise them, not so you can open them. (This rule used to live in the generated authoring prompt, which 57B-480 retired along with the section authoring path; it is stated here because it is a property of the boundary, not of that prompt.)

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
├── evidence.json
├── analysis-scope.json
├── provider-status.json
├── workitems.json
├── traces.json
├── knowledge.json              # frozen investigation record (written by freeze)
├── timeline.jsonl
├── checklist.json              # compatibility view of workitems
├── sections/
├── claims/
├── reports/
│   └── companions/
├── audit/
├── run.json
└── metrics.json
```

Investigate before you write. After prepare and before `freeze`, work the plan in `workitems.json` feature by feature and dimension by dimension so that all knowledge is in place before authoring starts.

- Treat `workitems.json` as the primary investigation plan and coverage ledger. Every required item ends as `found`, `searched-not-found`, `cannot-determine`, or `not-applicable`. Do not delete a required item. An item that static analysis cannot answer records why, what would settle it, and evidence establishing the limitation.

  ```bash
  excavator workitem --run <run-dir> --file <workitem-updates.json>
  ```

- Reading is accounted for, not assumed. A `logic-disposition` work item names one decision function and its line span; disposing it `found` requires at least one recorded source window that OVERLAPS that span. Freeze rejects a `found` disposition whose citations never touch the function it reports — record the window over the decision function, or dispose the item `cannot-determine` / `not-applicable` with its reason.

- The literal conditions found inside the windows you opened (`lv.Hours > 40` at its file and line) are recorded in `coverage/condition-inventory.json`. State every condition that carries reportable behavior and cite the window it came from; leaving one out is a decision, not an oversight. **Note the reduction:** the retired authoring packet used to lay this list out per section for the author to read before writing (57B-480). The unit packet does not carry it, so today the inventory reaches you as a recorded artifact and as an audit advisory after the fact, not as a pre-write list.

- Ask what you have not read, while reading is still free:

  ```bash
  excavator reading --run <run-dir>
  ```

  It lists the in-boundary decision functions no source window covers yet, grouped by file and ranked by unread weight, with the partition that carries this feature's vocabulary first and the rest counted per file below it. Run it before freezing: until then, opening a window is ordinary investigation, while afterwards the same window costs a supplement. It is an investment aid, not a checklist — open the files heavy enough to hide reportable behavior, leave the rest, and read the unread ranges rather than the signature, since a decision function's thresholds and branch conditions live in its body. Nothing counts how many entries you clear, and opening a window you do not use is recorded as a drive-by read. The command is read-only and can be run at any time, including after freeze.

- Freeze also reports the same residual as two aggregate advisories, and after freeze the coverage companion carries the read-obligation family with its own denominator. `coverage/read-obligations.json` (the frozen denominator) and `coverage/read-residual.json` (what was and was not read) carry the detail. **Note the reduction:** the retired authoring packet used to carry a `Reading boundary` block NAMING what was never opened for that document's feature (57B-480); the companion carries counts and unread-line totals, not the names, so run `excavator reading` before freeze if you want them named. Read coverage is relative to the retained boundary: full coverage never means nothing was missed.

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

When every required work item is disposed and every material flow is traced, check what is still unread and then freeze:

```bash
excavator reading --run <run-dir>
excavator freeze --run <run-dir>
```

Run `reading` first because freeze changes the price: before it, a window is ordinary investigation; after it, every window is a supplement charged to a work item. Whatever you decide to leave unread is a legitimate outcome — the point of asking beforehand is that it becomes a decision rather than an accident.

Freeze is a deterministic gate: it admits the run only when the investigation would already pass audit — every required item disposed, every `found` material flow carrying a verified trace, the evidence catalog and its digest intact, and the snapshot unchanged. On a non-zero exit it reports the exact gaps — items still pending, flows still missing a trace — so continue investigating and freeze again. The first success writes immutable epoch 0 at `knowledge.json`; each later success writes epoch N under `knowledge/epochs/epoch-N.json`, pins the previous epoch digest, and never changes earlier bytes. Supplements append separately to `knowledge/supplements.json`. Freeze writes the sealed epoch and nothing else for the author: the bounded, model-free view one authoring unit is written from is rendered on demand by `excavator plan-packet --run <run-dir> --unit <unit-id>`, from the recorded plan.

Redaction of secrets is part of that version: when it changes, every existing run drops out of the current assurance generation and is grandfathered, so a run must be re-prepared to be held to the strict checks again. Its recorded evidence is never rewritten.

Under the current assurance version freeze is a hard precondition of authoring, not a suggestion: `draft` and `checkpoint` refuse an unfrozen run, and a run authored without — or before — a freeze fails audit. Runs prepared under an older assurance version are grandfathered and keep the earlier soft guidance.

## Authoring workflow

Authoring is keyed by **authoring unit**, not by report section. A unit is one leaf or synthesis node of a recorded plan, identified by its own id in `plan/catalog.json`; the plan — not a fixed template — decides how many units a document has and in what order they are collected. Every authoring command below takes `--unit <id>` or the run-wide `--units`, and there is no section keying to fall back to.

A validated plan is a precondition of authoring, exactly as freeze is: with no `plan/topics.json` the authoring commands refuse by name and say which file is missing.

### 1. Record the plan

Read the planner view of the frozen run, write a proposal from it, then record it:

```bash
excavator plan-packet --run <run-dir> --over-budget refuse --out <planner-packet.md>
excavator plan --run <run-dir> --proposal <proposal.json>
```

`plan` writes `plan/topics.json`, `plan/catalog.json` and `plan/dag.json`. A proposal that does not validate is refused by name and writes nothing. A recorded plan is identified by (knowledge epoch, plan revision) and written once: re-recording identical bytes is a no-op, and different bytes for a revision already recorded are refused — `plan --revise --reason "<why>"` is the explicit way past that.

### 2. Write one unit at a time

Read the bounded view that unit is written from — every obligation as its own row with its own evidence and trace ids, every bound record in full, nothing clipped:

```bash
excavator plan-packet --run <run-dir> --unit <unit-id> --over-budget record-limitation --out <unit-packet.md>
```

Write the unit's three files: the Markdown content, its claims sidecar, and a summary that covers exactly the plan's topics for that unit and records the digests of the very bytes being written. Then record it:

```bash
excavator checkpoint \
  --run <run-dir> --unit <unit-id> \
  --file <content.md> --claims <claims.json> --summary <summary.json> \
  --authorship model-family:<name>
```

`checkpoint --unit` is exactly `draft --unit` followed by `collect --units`. `--authorship` is required and has no default: the ledger records who wrote the unit, and the cache identity is computed for that author.

Every substantive statement must carry a real backtick evidence-level marker in its visible prose — `fact`, `verified`, `inferred`, or `unavailable`, or their localized equivalents in the requested output language. Each claim names an exact statement that appears in the unit, cites evidence ids for `fact`/`verified`/`inferred`, carries a reason and no evidence for `unavailable`, and lists the work-item ids it satisfies. `collect` applies the grounding verdict at recording time: a unit whose claims leave a material obligation ungrounded is refused, its artifacts are left on disk, and `audit --units` says why. See `references/writing-rules.md` for the marker semantics and the claim binding contract.

### 3. Parallel drafting

The per-unit work is independent once the investigation is frozen and the plan is recorded, so a host that can run concurrent writing subtasks may spawn one subtask per unwritten unit. Each subtask reads its own unit packet, writes the three files, and records the unit with `draft` in place of `checkpoint`:

```bash
excavator draft \
  --run <run-dir> --unit <unit-id> \
  --file <content.md> --claims <claims.json> --summary <summary.json> \
  --authorship model-family:<name>
```

`draft` writes only that unit's own artifacts and a receipt; it never touches the shared unit ledger or the timeline, so concurrent drafts of distinct units cannot collide. A synthesis unit is written from its children's collected summaries, so draft it only after its children are collected.

**Concurrency contract.** While drafts are in flight, the only run-changing command that may run is `draft`. Keep `checkpoint`, `collect`, `assemble`, a run-wide `audit` (it writes `audit/audit.json`, appends a timeline event and moves `manifest.state`) and any supplement (a `source`, `search`, `workitem`, `checklist` or `trace` carrying `--supplement-reason`) in serial segments — never concurrent with a draft or with each other. `status`, `resume`, `audit --units`, `plan-packet` and `unit-consistency` are read-only and may run anytime. Draft exactly one writer per unit. If a subtask finds a knowledge gap while writing, do not open a supplement in parallel: record the gap and defer it to a serial segment after collect.

**Collect barrier.** When every drafting subtask has finished, record them all with one serial `collect`:

```bash
excavator collect --run <run-dir> --units
```

`collect` reads the pending receipts in the plan's own collection order and appends each unit's ledger row and timeline event one at a time, so the append-only hash chain is identical to a serial run's. It is a no-op when nothing is pending, so it is safe to rerun.

### 4. Audit, assemble, check

```bash
excavator audit --run <run-dir> --units
excavator assemble --run <run-dir> --units --mode write
excavator unit-consistency --run <run-dir>
excavator coverage-companion --run <run-dir> --out <coverage.md>
```

`audit --units` is the read-only rerun of the verdict `collect` already applied; its exit code follows the verdict. `assemble --units` is all-or-nothing per run: every unit of every planned document must be collected against the recorded plan and this epoch, and every unit's bytes on disk must still digest to what its ledger row promised, or the run is refused by name with the offending unit ids. `--mode write` puts the deliverable in `reports/`; `--mode plan-only` proves it could be written and writes nothing. `unit-consistency` then checks the assembled deliverable for the cross-unit defects no collect gate can see and prints the exact repair set, exiting non-zero when there is a finding.

### 5. Adding a document, and reusing verified units

A recorded request set grows one document at a time, and the recorded plan must then be revised before authoring resumes:

```bash
excavator request-append --run <run-dir> --kind overview --audience engineering --detail standard --language <tag>
excavator plan --run <run-dir> --proposal <proposal.json> --revise --reason "<why the recorded plan no longer covers the request set>"
```

Units already written and verified do not have to be rewritten when the plan is revised. Their cache identity is the packet they were written from, so a unit whose identity and bytes are unchanged can be re-entered through the same draft and collect gates:

```bash
excavator unit-cache-identity --run <run-dir> --authorship model-family:<name>
excavator unit-cache-admit --run <run-dir> --authorship model-family:<name> --mode plan-only
```

`--mode plan-only` decides and reports, writing nothing; `--mode admit` re-enters the admitted bytes through `draft` and `collect`, so every gate runs again and no stale receipt is ever revived. Every planned unit comes back as admitted, fell-to-rebuild with its cause, or skipped-new.

### Supplements during authoring

When the frozen knowledge is genuinely insufficient — a claim you cannot ground in any existing evidence, or a work item whose frozen disposition is wrong — do not re-open routine investigation and do not edit the artifacts silently. First decide whether it is an expression problem; the evidence you need is usually already in the catalog under a different framing. Only when it is a real knowledge gap, re-run the relevant command with a supplement, which performs the operation and records the exception in the coverage ledger:

```bash
excavator search \
  --run <run-dir> --terms "escalation,approver" \
  --reason "confirm an escalation path the frozen evidence does not cover" \
  --supplement-reason "the frozen catalog carries no evidence for multi-level escalation" \
  --supplement-workitem feature:<key>:decision-flow
```

The same `--supplement-reason` and `--supplement-workitem` pair applies to `source`, `workitem`, `checklist` and `trace`. Both flags are required together, and the work item must already exist in `workitems.json`. Every supplement is counted in `metrics.supplements` and audited: a post-freeze mutation with no recorded supplement fails audit. After the serial supplement segment, run `excavator freeze --run <run-dir>` again. It consumes all supplements since the current epoch into epoch N+1; `draft`, `checkpoint`, `collect` and `assemble` refuse to consume a stale epoch while supplements remain unsealed. A draft receipt records the epoch it consumed and must be re-drafted if a later epoch supersedes it.

## Recovery

On interruption, ask the run what is left and continue from there:

```bash
excavator status --run <run-dir> --units
excavator resume --run <run-dir> --units
```

Both are read-only: `collect` is the only writer of the shared unit ledger, so a unit run is resumed by drafting what is unwritten and collecting what is drafted — both named in the output. Every planned unit reads as exactly one of collected, drafted or unwritten, and a receipt or ledger row from a superseded epoch or plan is reported as superseded rather than silently dropped. Do not rebuild CodeGraph, shared context, feature scopes, or units already collected.

A failed drafting subtask leaves no receipt, so its unit is never collected and stays unwritten — `status --units` and `resume --units` list it like any other unwritten unit. Re-draft that unit and run `collect --units` again.

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
