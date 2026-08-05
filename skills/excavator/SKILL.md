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
excavator codegraph build --target /workspace/project --quiet
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

The prepare command creates:

```text
runs/<run-id>/
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

6. Save each section and its claims immediately:

   ```bash
   excavator checkpoint \
     --run <run-dir> --document <document-id> --section <n> \
     --file <section.md> --claims <section-claims.json>
   ```

   Each claim names an exact statement that appears in the section. `fact`, `verified`, and `inferred` claims cite evidence IDs that also appear in the section's collapsed evidence block. `unavailable` claims carry a reason and no evidence IDs.

7. Treat `workitems.json` as the primary investigation plan and coverage ledger. Every required item ends as `found`, `searched-not-found`, `cannot-determine`, or `not-applicable`:

   ```bash
   excavator workitem --run <run-dir> --file <workitem-updates.json>
   ```

   Do not delete a required item. A search that finds nothing records its searched scope and supporting `SEARCH-*` receipt. An item that static analysis cannot answer records why, what would settle it, and evidence establishing the limitation. `checklist.json` is retained as a compatibility projection and may still be updated through the legacy `checklist` command.

8. Record traces for evidenced call flows, business flows, data flows, state transitions, cross-repository paths, and analysis paths:

   ```bash
   excavator trace --run <run-dir> --file <trace-updates.json>
   ```

   A verified trace has sequential steps and evidence for every step. Claims and work items may cite trace IDs. Material feature work items for normal flow, lifecycle, or side effects require a trace when their status is `found`.

9. Check status after every major section. Stop when the authoring budget is exceeded; do not silently extend it.
10. Assemble and audit:

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
- any substantive sentence or table row is not bound to a claim;
- a claim statement is not present in the section;
- claim evidence is not cited in that section's evidence block;
- the analysis scope or provider registry changes after preparation;
- the append-only timeline digest chain is broken;
- a required work item remains pending, is removed, or cites invalid evidence;
- a material flow work item has no verified trace;
- a trace contains missing evidence, claims, documents, or non-sequential steps;
- the target source or CodeGraph identity changes after preparation.

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
