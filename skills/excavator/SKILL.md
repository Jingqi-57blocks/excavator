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
- any output language.

Examples:

```text
/excavator overview --audience product
/excavator overview --audience engineering
/excavator feature "Account access" --audience both
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
  "workdir": "/workspace/excavator-work",
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

## Authoring workflow

The prepare command creates a run under the target's own directory inside the workdir, `<workdir>/<project>[-<hash>]/runs/<run-id>/`, alongside that target's caches. The `<project>` segment is the target's basename; the `-<hash>` suffix is added only when a different target would collide on that basename. Use the `runDir` value the command prints rather than composing the path. When runs from the old un-suffixed `<workdir>/<project>/runs/` layout are stranded by such a collision, prepare emits a warning that names the old path; those historical runs are not picked up automatically.

```text
<workdir>/<project>[-<hash>]/runs/<run-id>/
├── context/
├── evidence.json
├── analysis-scope.json
├── provider-status.json
├── workitems.json
├── traces.json
├── timeline.jsonl
├── checklist.json              # compatibility view of workitems
├── prompts/
├── sections/
├── claims/
├── history/
├── reports/
│   └── companions/
├── audit/
├── run.json
└── metrics.json
```

Budgets derive from the request size (the number of requested documents and features), not a fixed ceiling. Check status after each major section and stop when the authoring budget is exceeded. A budget timeout stops the *next* section, never the one in hand: the current section is checkpointed to disk before the run stops, and `excavator resume --run <run-dir>` continues from the first incomplete section.

Plan the following before drafting, not at audit:

- **Evidence-level markers are mandatory.** Every substantive section must carry a real backtick evidence-level marker in its visible prose — `fact`, `verified`, `inferred`, or `unavailable`, or their localized equivalents in the requested output language. Under the current assurance version, a substantive section with no real marker is a hard audit error, not a warning. See `references/writing-rules.md` for the marker semantics and the claim binding contract.
- **Equivalence needs every side.** A `fact` claim that asserts equivalence, consistency, sameness, or shared values or behavior across implementations, modules, repositories, or runtime parts must cite evidence for every compared side and group it in the claim's `sides` field; when only one side is observed, record the other's evidence or downgrade to `inferred`.
- **Material flows need a verified trace, planned up front.** A material work item for a normal, decision, or reversal flow, a state lifecycle, or a side effect (notifications or exports) that ends `found` requires a verified trace. A `found` flow item with no trace is a hard audit error, so plan the traces while investigating rather than discovering the requirement at audit.
- **The feature fact pack is a floor, not a ceiling.** Each feature scope carries a deterministic fact pack (`context/features/<feature>.factpack.json`, also rendered as a section of the scope) that enumerates six categories — entrypoints, entities, states, config-keys, jobs, external-calls — each item at `file:line`, with a per-category coverage row (method, item count, truncated flag, note). It is an enumeration of what was found inside the feature boundary, not a sample. When a category is marked truncated or carries an incompleteness note, treat it as a floor: investigate beyond it with `search` and `source`, and do not treat the listed items as the complete set.

For each document:

1. Read its prompt file.
2. Start its timer:

   ```bash
   excavator begin --run <run-dir> --document <document-id>
   ```

3. Write one template section at a time.
4. If the prepared context does not identify the relevant path, search under the immutable run snapshot and retain the reusable receipt:

   ```bash
   excavator search \
     --run <run-dir> --terms "permission,authorize,role" \
     --path-prefixes "src,services" --max-results 50 \
     --reason "investigate inline authorization"
   ```

   Repeating the same snapshot-bound search is a cache hit. A searched-not-found checklist result cites the returned `SEARCH-*` evidence ID.

5. If more source is required, record the bounded excerpt before using it:

   ```bash
   excavator source \
     --run <run-dir> --path <relative-path> --start <line> --end <line> \
     --reason "why this excerpt is needed"
   ```

6. Generate the claims skeleton from the written section, then fill it in:

   ```bash
   excavator claims scaffold \
     --run <run-dir> --document <document-id> --section <n> \
     --file <section.md>
   ```

   It emits one claim stub per substantive segment using the exact segmentation the audit enforces, so a hand-derived skeleton can never drift from what audit expects. Each stub defaults to the `fact` marker with empty `evidenceIds` and `workItemIds`; fill in the evidence and work-item links and adjust each marker to the right evidence level before checkpointing.

7. Save each section and its claims immediately:

   ```bash
   excavator checkpoint \
     --run <run-dir> --document <document-id> --section <n> \
     --file <section.md> --claims <section-claims.json>
   ```

   Each claim names an exact statement that appears in the section. `fact`, `verified`, and `inferred` claims cite evidence IDs that also appear in the section's collapsed evidence block. `unavailable` claims carry a reason and no evidence IDs.

8. Treat `workitems.json` as the primary investigation plan and coverage ledger. Every required item ends as `found`, `searched-not-found`, `cannot-determine`, or `not-applicable`:

   ```bash
   excavator workitem --run <run-dir> --file <workitem-updates.json>
   ```

   Do not delete a required item. A search that finds nothing records its searched scope and supporting `SEARCH-*` receipt. An item that static analysis cannot answer records why, what would settle it, and evidence establishing the limitation. `checklist.json` is retained as a compatibility projection and may still be updated through the legacy `checklist` command.

9. Record traces for evidenced call flows, business flows, data flows, state transitions, cross-repository paths, and analysis paths:

   ```bash
   excavator trace --run <run-dir> --file <trace-updates.json>
   ```

   A verified trace has sequential steps and evidence for every step. Claims and work items may cite trace IDs. As stated above, a material feature work item for a normal, decision, or reversal flow, a lifecycle, or a side effect requires a verified trace when its status is `found`.

10. Check status after every major section. Stop when the authoring budget is exceeded; do not silently extend it. Once a document's sections are all checkpointed, audit that document in isolation before moving on:

    ```bash
    excavator audit --run <run-dir> --document <document-id>
    ```

    A single-document audit checks that document's sections, claims, and the shared evidence catalog as hard errors, but run-wide completeness checks (plan and checklist completion, material work-item coverage) degrade to advisory findings and no run state is mutated. Use it mid-authoring; it does not replace the final full-run audit.

11. Assemble and audit the whole run:

    ```bash
    excavator assemble --run <run-dir>
    excavator audit --run <run-dir>
    ```

## Recovery

On interruption or timeout:

```bash
excavator resume --run <run-dir>
```

Resume from the first incomplete section. Do not rebuild CodeGraph, shared context, feature scopes, or completed sections. If the original model session cannot resume, read the document prompt, completed sections, and only the incremental context needed for the next section.

## Report contracts

Read `references/writing-rules.md` and the appropriate template:

- `references/product-overview.md`
- `references/product-feature.md`
- `references/engineering-overview.md`
- `references/engineering-feature.md`

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

`timeline.jsonl` is append-only and hash-chained. It records preparation, investigation searches and source windows, checkpoints and revisions, work-item and trace updates, assembly, audit, timeout, and recovery. The assembled report directory contains machine-readable claims, traces, and coverage companions for each document.
