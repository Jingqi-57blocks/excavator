# Excavator

Excavator is a lightweight, AI-first project reporting Skill.

It uses CodeGraph as a navigation index to reduce repository search and token use, then reads bounded source windows whenever the index is absent, unsupported, unresolved, ambiguous or semantically insufficient. The deterministic runtime handles scope preparation, deduplication, caching, timing, recovery and audit. The AI handles interpretation and writing.

## Reports

Excavator supports four report contracts:

| Scope | Product audience | Engineering audience |
|---|---|---|
| Whole project | Product overview | Engineering overview |
| Named capability | Product feature report | Engineering feature report |

A single run may request any combination:

- one overview;
- both overview audiences;
- one feature;
- multiple features;
- overview plus multiple features;
- one or both audiences per feature.

All requested documents share one project investigation. The same feature is scoped once and reused by both audiences.

## Requirements

- Node.js 22.5 or newer.
- No runtime npm dependencies.
- Optional CodeGraph SQLite database.
- `git` is used only to identify source snapshot revisions and dirty state.

The executable shebang enables Node 22 type stripping. `node:sqlite` remains marked experimental by Node and may emit a warning when commands are invoked through `node` rather than the executable files.

## Quick start

```bash
npm test

./src/cli.ts overview \
  --target /path/to/project \
  --audience both \
  --language zh-CN \
  --workdir /tmp/excavator-work
```

For mixed requests use a request file:

```bash
./src/cli.ts prepare --request request.json
```

Then follow the generated prompt files. Every completed section is checkpointed with a small claims sidecar, and every generated investigation item receives a disposition before audit.

```bash
./src/cli.ts checkpoint \
  --run <run-dir> --document <document-id> --section 1 \
  --file section.md --claims section-claims.json

./src/cli.ts checklist \
  --run <run-dir> --file checklist-updates.json
```

Claims bind exact visible statements to evidence IDs. The checklist prevents a predefined investigation category from disappearing silently; every item ends as `hit`, `searched-not-found`, or `cannot-determine`.

## Source fallback

CodeGraph is never treated as the complete source of truth. Excavator reads source directly when:

- CodeGraph is missing;
- an eligible file is not indexed;
- extraction errors exist;
- relationships are unresolved;
- candidates are ambiguous;
- route composition, handler roles, permissions, rules, states, data semantics or errors require confirmation.

Secret-bearing files such as `.env`, private keys and certificates are excluded from source enumeration. Configuration excerpts redact values associated with secret-like keys.


## Optional CodeGraph

Normal report commands do not require CodeGraph:

```bash
excavator overview --target ./workspace --audience both
```

Provider selection is deterministic:

1. `--no-codegraph` forces source-only analysis.
2. `--codegraph /path/to/codegraph.db` uses that database when readable.
3. Otherwise Excavator auto-detects `<target>/.codegraph/codegraph.db`.
4. If no database is available, analysis continues from source without an error.

Excavator does not install CodeGraph. To inspect the optional integration:

```bash
excavator codegraph status --target ./workspace
```

To build or refresh an index with an already-installed CodeGraph CLI:

```bash
excavator codegraph build --target ./workspace
```

For a new target this invokes `codegraph init <target>`, which indexes as part of initialization; for an already-initialized target it invokes `codegraph index <target>`, which rebuilds the index from scratch. The returned `command` reports the exact arguments used.

Supported options:

- `--binary /custom/path/codegraph` selects a CodeGraph executable.
- `--force` passes CodeGraph's own `--force`, which only permits a path that looks like a home directory or filesystem root. It does not force a rebuild; `codegraph index` already rebuilds.
- `--quiet` suppresses progress output and applies to the refresh path only, because CodeGraph's `init` does not accept it.

If the CLI is missing, Excavator prints installation choices and stops without downloading or installing anything.

## Cache and recovery

A workdir holds one directory per analyzed target, named after the target's basename. Runs and caches for a target live together, so a project's state can be inspected or removed in one step.

```text
.excavator-work/
└── <project>/
    ├── .target                     # absolute path this directory belongs to
    ├── cache/
    │   ├── contexts/<snapshot-id>/
    │   ├── features/<snapshot-id>/
    │   ├── searches/<snapshot-id>/
    │   └── source-windows/
    └── runs/
        └── <run-id>/
            ├── context/
            ├── prompts/
            ├── sections/
            ├── claims/
            ├── reports/
            ├── audit/
            ├── evidence.json
            ├── checklist.json
            ├── run.json
            └── metrics.json
```

When two targets share a basename, the second directory is suffixed with a digest of its absolute path. The `.target` marker records ownership, so a target always resolves to the same directory.

Cache keys include the source snapshot, optional provider identity, builder version and normalized request. Completed sections and claims are written atomically. A resumed run starts at the first incomplete section and reuses prepared context. Orphan temporary files left by a killed process are ignored.

## Timing

The default budgets are:

- context preparation: 3 minutes;
- authoring per document: 12 minutes;
- 40 graph queries;
- 70 source windows;
- 160,000 source characters.

Use `begin` before authoring. `checkpoint` stops the document when its authoring budget has elapsed and writes a timeout diagnostic.

## Standalone HTML converter

`excavator-html` is independent from report analysis:

```bash
./packages/excavator-html/src/cli.ts build \
  --input .excavator-work/runs/<run-id>/reports \
  --output ./report-site \
  --title "Project report"
```

It converts final Markdown into a static site with the reference report styling, dynamic module navigation, page table of contents, responsive layout, evidence details and Mermaid diagrams. Only supplied Markdown files appear in navigation.

## Tests

```bash
npm test
```

The test suite covers:

- automatic CodeGraph discovery with unindexed-source fallback;
- explicit source-only mode even when a database exists;
- optional CodeGraph CLI status/build commands without automatic installation;
- source-only mode;
- shared context reuse across product and engineering audiences;
- feature-scope reuse;
- multi-feature combined runs;
- zero repeated graph/source reads on a warm cache;
- section checkpoints, timeout and resume;
- evidence identity, source range, snapshot and digest validation;
- section claims bound to visible report statements;
- required investigation checklist disposition accounting;
- Markdown assembly and audit;
- dynamic HTML navigation and styling.

## Real-workspace smoke test

The smoke test never executes target code. It prepares a combined request twice and verifies the warm run performs no graph queries or source reads.

```bash
EXCAVATOR_TARGET=/path/to/workspace \
EXCAVATOR_FEATURE="Account access" \
EXCAVATOR_FEATURE_ALIASES="access,permission,role" \
npm run test:workspace
```


## Assurance boundary

Excavator cannot prove that static analysis found every runtime behavior. It makes omissions visible instead: the run initializes generic project or feature investigation items, requires each item to be dispositioned, validates every cited evidence identity, reopens source ranges during audit, and rejects reports whose supported statements are not represented in section claims. Unsupported CodeGraph coverage is handled by source fallback rather than a framework-specific reader.
