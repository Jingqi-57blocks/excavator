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
INVESTIGATION: search / source / trace dispose every required work item
            |
            v
freeze — deterministic completeness gate → knowledge.json
            |
            v
AUTHORING: Evidence → Claim → Trace consumed as frozen input
  (supplement = explicit, recorded exception)
            |
            v
section checkpoints + append-only timeline
            |
            v
Markdown reports + machine-readable companions
            |
            v
audit (also reconciles post-freeze mutations against the frozen record)
```

The core loop has two phases split by `freeze`. Investigation prepares and disposes the plan; freeze
records the frozen knowledge; authoring consumes it and produces the report. This confines run-to-run
variance to the expression layer — reproducibility (see `direction.md`) never required byte-identical
prose, only a stable evidence set, work-item disposition and trace set before writing begins.

## Source and provider boundary

The source provider is mandatory and is the final evidence source. CodeGraph is optional. Normal report generation never installs CodeGraph or creates a database. Provider selection is deterministic:

1. explicit source-only mode;
2. explicit readable database;
3. auto-detected `<target>/.codegraph/codegraph.db`;
4. source-only fallback.

`provider-status.json` persists every provider's availability, selection state, capabilities, path, version or database identity, and selection reason. The provider registry digest is bound into the run manifest and analysis scope.

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

## Investigation freeze

`excavator freeze --run <run-dir>` is a deterministic, model-free gate between investigation and
authoring. It admits a run only when the investigation would already pass audit: every required work
item disposed, every `found` material flow carrying a verified trace, the evidence catalog and its
digest intact, and the snapshot unchanged. The gate reuses the exact assurance functions
(`auditWorkItems`, `auditTraces`, `auditEvidenceCatalog`) the full audit uses, so the two can never
enforce two different rule sets.

On success it writes `knowledge.json` (knowledge-v1): the frozen fingerprints of the run's artifacts —
sorted evidence ids and digest, work-item dispositions and digest, trace ids and digest, per-feature
fact-pack digests, an optional cross-feature digest — plus a machine-readable completeness report and
an append-only `supplements` ledger. It copies no evidence content and builds no ontology; authoring
keeps reading the existing `evidence.json`, `workitems.json`, `traces.json` and `context/*`, which are
now complete and frozen. `manifest.frozenAt`/`manifest.knowledgeDigest` are stamped and an
`investigation.frozen` timeline event is appended. The digest covers the frozen core (everything except
`supplements`), so appending a supplement never changes it.

Freeze also renders one authoring packet per document under `context/authoring/<document-id>.md`: a
deterministic, model-free view of the frozen knowledge organized by the report section each work item is
assigned to (`reportSection`). Each section block lists its work items, the fact-pack items whose category
that section owns (states, entry points, config keys, jobs, entities, external calls — mapped from the
work-item dimension, not from any target's names), and the frozen evidence — source excerpts clipped to a
line/character ceiling, fact-pack and search receipts as summary lines, and traces as one-line references,
deduplicated across sections. The packet copies nothing that is not already frozen and is a regenerable
view, not part of the frozen core: it carries no digest and changing it cannot pollute the assurance chain.
It addresses transport — knowledge that was mined but never reached the section that needed it — and the
wall-clock and context cost of re-reading `evidence.json`; it cannot deepen an investigation, so knowledge
the investigation never recorded cannot appear in it. A warning-level audit advisory,
`auditAuthoringPacketConsumption`, self-gated on the packet existing, flags a section whose listed evidence
no claim consumed — a whole section ignoring its packet, never a depth shortfall.

Under the current assurance version freeze is a hard precondition of authoring, enforced at two points
that move together. `begin` refuses to start authoring a run that is not yet frozen. As a backstop for
any path that bypasses `begin`, the audit fails a run that carries authoring activity but no preceding
`investigation.frozen` event: no freeze event at all, or a first authoring event whose sequence precedes
the freeze (authored, then froze). Both checks are gated on the run's stamped assurance version, so a run
prepared before freeze became mandatory is grandfathered — the older soft guidance still applies and the
gate never retroactively fails it.

After freeze the five runtime mutators (`search`, `source`, `workitem`, `checklist`, `trace`) refuse a
change unless it carries a supplement — a `--supplement-reason` and the `--supplement-workitem` it is
charged to (both required, and the work item must resolve in `workitems.json`). A recorded supplement
appends to `knowledge.json.supplements[]`, increments `metrics.supplements` and marks its timeline
event. The audit reconciles the frozen record against the current run: every added evidence id, changed
work-item disposition or added trace must be charged to a supplement, and every gated investigation
timeline event after the freeze must carry the supplement marker — a silent bypass is an audit error.
The reconciliation is symmetric: a supplement only ever adds, so a frozen evidence id, work item or trace
that has vanished from the run is a silent deletion of recorded knowledge and is always an error.
These checks are self-gated on `knowledge.json` existing, so runs that were never frozen (including
legacy runs) are unaffected.

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
