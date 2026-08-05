# Excavator current-state baseline

> Baseline captured before the assurance-workflow refactor.
>
> Source under test: local optional-CodeGraph provider implementation.
> Automated test result: 42/42 passing on Node.js 22.

## 1. Current execution model

Excavator prepares a source snapshot, optionally opens a CodeGraph SQLite database, builds one shared project context and reusable feature contexts, then creates audience-specific authoring prompts. Source files remain the final evidence source; graph data is used as a navigation index.

Current reusable artifacts include:

- `snapshot.json` for the analyzed source boundary;
- `evidence.json` for source, graph, search and derived evidence;
- `checklist.json` for required investigation hypotheses;
- per-section Markdown checkpoints;
- per-section `claims.json` files;
- `run.json` and `metrics.json` for current state and aggregate performance;
- assembled Markdown reports and `audit/audit.json`.

## 2. Existing assurance controls

The current audit rejects:

- missing or duplicate evidence IDs;
- evidence that belongs to another snapshot;
- invalid source paths or line ranges;
- stale source digests;
- substantive report text without claims;
- claims that cite missing evidence;
- incomplete investigation checklist items;
- `searched-not-found` results without a complete zero-match search receipt;
- `cannot-determine` results without limitation evidence;
- recommendation or remediation language in current-state reports.

## 3. Existing recovery and efficiency controls

- Shared and feature contexts are cached by snapshot.
- Multiple audiences reuse the same feature scope.
- Source windows and search receipts are cached.
- Duplicate or overlapping source windows are merged.
- Runs have unique directories even when prepared in the same second.
- Completed sections are checkpointed atomically.
- An abruptly killed author process resumes from the first incomplete section.
- CodeGraph is optional: auto-detected when present, explicitly disabled with `--no-codegraph`, or specified with `--codegraph`.

## 4. Baseline performance observation

On the WCP multi-repository fixture, source-only preparation was lighter, while CodeGraph found a materially broader feature boundary. The previously recorded comparison showed:

| Metric | CodeGraph | Source only |
|---|---:|---:|
| Cold preparation | 1,112 ms | 901 ms |
| Graph queries | 17 | 0 |
| Source windows | 60 | 35 |
| Source characters | 126,131 | 55,944 |
| Evidence files | 44 | 28 |
| Leave boundary files | 77 | 5 |
| Worklog boundary files | 125 | 5 |

This established that CodeGraph is primarily a recall and relationship-navigation provider, not a guaranteed speed optimization.

## 5. Baseline limitations

### 5.1 Investigation coverage is primarily post-hoc

`checklist.json` is created before authoring, but it is mainly used as an audit gate. It does not represent assignment, progress, affected documents, start/completion timestamps or trace dependencies as a first-class investigation plan.

### 5.2 Claims have no first-class flow model

A claim can cite source or graph evidence, but there is no separate object for a call flow, business flow, state transition, data flow or cross-repository path. A local source excerpt may therefore support a narrow statement without proving the complete process described by a paragraph.

### 5.3 Run history is not append-only

`run.json` and `metrics.json` describe current state and aggregate counters. They do not provide a hash-chained history of searches, source reads, checkpoints, corrections, timeouts, resumes and audit outcomes.

### 5.4 Provider state is transient

The current run records the effective CodeGraph path and aggregate coverage, but it does not persist a complete provider registry describing source-provider readiness, CodeGraph database identity, selection reason, CLI availability and capabilities.

### 5.5 Corrections are represented by replacement

Evidence and claims are validated against the snapshot, but there is no general `supersedes` chain for claims, traces and work items. The audit cannot reconstruct why a conclusion changed across checkpoints.

## 6. Refactor target

The next version should add, without weakening current controls:

1. an explicit analysis-scope contract;
2. a pre-authoring work-item and coverage ledger;
3. an Evidence → Claim → Trace model;
4. a hash-chained append-only timeline;
5. a persisted provider registry;
6. correction and supersession metadata;
7. report companion files that preserve machine-auditable coverage without overloading product-facing Markdown.
