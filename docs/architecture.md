# Excavator architecture

Excavator separates deterministic investigation state from AI interpretation. Deterministic code establishes the source boundary, provider selection, investigation plan, evidence identity, flow traces, checkpoints, performance counters and audit gates. The AI reads prepared artifacts and writes the requested report language.

## Runtime flow

```text
source workspace
  + optional provider indexes
            |
            v
Git-aware source manifest + immutable snapshot
            |
            v
provider registry + analysis scope
            |
            v
shared project context + reusable feature scopes
            |
            v
investigation work items
            |
            v
Evidence → Claim → Trace
            |
            v
section checkpoints + append-only timeline
            |
            v
Markdown reports + machine-readable companions
            |
            v
audit
```

## Source and provider boundary

The source provider is mandatory and is the final evidence source. CodeGraph is optional. Normal report generation never installs CodeGraph or creates a database. Provider selection is deterministic:

1. explicit source-only mode;
2. explicit readable database;
3. auto-detected `<target>/.codegraph/codegraph.db`;
4. source-only fallback.

`provider-status.json` persists every provider's availability, selection state, capabilities, path, version or database identity, and selection reason. The provider registry digest is bound into the run manifest and analysis scope.

## SOUP inventory

`soup.ts` builds a deterministic, model-free inventory of third-party components (software of unknown provenance) inside the snapshot boundary: it reuses `createSnapshot` to bind a `snapshotId`, then merges parser output into version-stable `components`/`gaps`/`coverage` with a `createdAt`-free digest, exposing `soupEvidence()` for downstream reports. `soup-parsers.ts` holds the table of 15 pure, vertical-neutral manifest/lockfile/container parsers (npm, NuGet, Python, Go, containers); each reports a component's version only when it is an exact pin, so a component group with no exact version anywhere becomes a structural gap.

## Analysis scope

`analysis-scope.json` records:

- source snapshot and repositories;
- Git-aware inclusion policy;
- ignore-policy and source-manifest digests;
- provider mode and provider-registry digest;
- requested documents and output language;
- deterministic budgets;
- the fact that target runtime execution is disabled.

The audit rejects a scope whose digest, snapshot, provider registry or requested document set changes.

## Investigation plan and coverage

`workitems.json` is created before authoring. Each project or feature hypothesis is linked to the documents that require it. Work items move through:

```text
pending → in_progress → found | searched-not-found | cannot-determine | not-applicable
```

A completed item records evidence, traces, search scope, limitations and timestamps. The legacy `checklist.json` is a compatibility projection.

## Evidence, claims and traces

- **Evidence** is an immutable observation bound to the snapshot and a digest.
- **Claim** binds an exact visible sentence or table row to evidence and optional traces.
- **Trace** records sequential call, data, business, state, cross-repository or analysis steps.

Verified trace steps require evidence. Material feature work items for normal flow, lifecycle or side effects require a trace when found.

## Append-only timeline

`timeline.jsonl` is hash-chained. Each event contains a sequence number, previous digest and current digest. Events record preparation, document starts, searches, source windows, checkpoints, revisions, work-item updates, trace updates, assembly, audit and recovery. The audit rejects missing, reordered or modified events.

## Checkpoint and correction model

Sections and claims are written atomically. Revising an existing checkpoint archives the prior section and claims under `history/<document>/` before replacement. The timeline distinguishes a first checkpoint from a revision.

## Report companions

Each assembled report has:

- `<document>.claims.json`;
- `<document>.traces.json`;
- `<document>.coverage.json`.

These companions preserve machine-auditable detail while the product-facing Markdown remains readable.

## Cache and performance

Shared project context is built once per snapshot. A normalized feature scope is built once and reused across audiences. Source windows, graph queries and source searches are cached and deduplicated. Metrics record graph queries, source reads, source characters, search coverage, claims, traces, work-item completion and timeline event count.

## Language boundary

All Skill instructions, report contracts, prepared prompts and investigation guidance are English. The request language controls only report content and visible labels. Multilingual source evidence stays in separate context and evidence files.
