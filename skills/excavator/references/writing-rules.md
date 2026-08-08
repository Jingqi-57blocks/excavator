---
id: excavator-writing-rules
version: 1.2.0
---

# Excavator writing rules

These rules apply to every report.

## Evidence language

Every material statement uses one of four semantic levels:

- **fact** — directly supported by CodeGraph or a recorded source excerpt;
- **inferred** — a business or technical interpretation grounded in named facts;
- **verified** — a hypothesis was searched and the searched scope is recorded;
- **unavailable** — static source review cannot answer it.

Render these semantic markers naturally and consistently in the requested output language. Do not copy the English marker words into a report when they would be unnatural in that language.

CodeGraph is a navigation index, not the complete source of truth. When graph data is missing, unresolved, ambiguous, unsupported, or lacks the semantic detail needed for a statement, read a bounded source window and record it as evidence.

### Comparison claims cite every side

A claim that asserts equivalence, consistency, sameness, or shared values or behavior across implementations, modules, repositories, or runtime parts is a multi-source claim. Mark it `fact` only when it cites evidence for every compared side and groups that evidence per side in the claim's `sides` field (each group is a non-empty, non-overlapping subset of the claim's `evidenceIds`). When only one side has recorded evidence, either record the missing side's evidence first or downgrade the claim to `inferred` and name which side was observed. `fact` is reserved for what the cited evidence directly shows; a single-sided citation cannot establish a two-sided equivalence, and splitting one comparison into two single-sided `fact` claims does not satisfy this rule.

## Current state only

Describe what the reviewed snapshot contains and what its paths permit. Do not provide recommendations, remediation plans, target architectures, migration steps, acceptance criteria, or action items.

A problem may include:

- the exact contradictory or incomplete behavior;
- the path that reaches it when established;
- the first-order consequence that the code permits;
- confidence and evidence.

It must not include advice about how to fix it.

## Target-problem attribution

A target report's risk or current-problem section contains only conditions attributable to the reviewed target snapshot. A listed problem must be grounded in target code, target configuration declarations, target data-model declarations, target tests or documentation, or a target execution path established from those artifacts.

The following are analysis-method information, not target problems, and MUST NOT appear in a target risk/current-problem section:

- CodeGraph coverage, unresolved references, route-parent or handler-resolution limitations;
- source fallback, source-window budgets, candidate-node/file counts or provider selection;
- Excavator behavior, prompt quality, audit behavior, analysis time or cache behavior;
- static-review limitations or unavailable runtime evidence by themselves.

Place these only in the coverage/static-review-boundary chapter or in an Excavator validation report. A target problem may still be listed when source review establishes the target behavior itself; describe the target behavior directly without mentioning how the analyser discovered it.

## Static-review boundary

Static source can show registered routes, declared jobs, configuration keys, data access, conditions, and calls. It cannot establish production traffic, current configuration values, actual delivery success, business ownership, live data volumes, incidents, or whether a feature is actively used.

Use careful language:

- “observed call sites”, not “traffic”;
- “no caller found in the reviewed workspace”, not “unused”;
- “no rule found in the reviewed paths”, not “the rule does not exist”;
- “a scheduled job is registered”, not “the job runs”.

## Readability

- Open with a direct sentence explaining what the project or feature is.
- Use the target language consistently, including punctuation and diagram labels.
- Product-facing reports keep repository names, paths, endpoints, tables, classes and functions inside collapsed evidence blocks.
- Engineering reports may use technical identifiers where they are necessary, but explain their role before listing them.
- Each chapter uses clear bold lead-ins and closes with a short synthesis of what the chapter means for understanding the rest of the report.
- Use Markdown tables and Mermaid diagrams where they improve comprehension.
- Every section with factual findings includes a `<details>` evidence block.
- Counts must say what was counted and include denominators where they represent coverage.

## Investigation economy

- Reuse the shared project context across all requested documents.
- Reuse one feature scope for product and engineering versions of the same feature.
- Do not repeat graph queries or source windows already present in the run evidence catalog.
- Stop investigation only after every material work item assigned to the requested document is dispositioned and represented by a visible claim in its assigned chapter.
- Do not widen into an unbounded repository scan. Use bounded searches for unresolved material items, retain search receipts, and mark the item `unavailable` only when the static-review limitation is established.


## Detailed-report mode

`detailed` is the default report mode. It is an enumeration contract, not a request for verbose prose.

- Build a chapter inventory before drafting prose.
- Preserve distinct entry points, types, states, rules, thresholds, regional or runtime variants, data fields, readers, writers, side effects, jobs, errors, tests and unresolved questions as distinct report items.
- Do not merge several materially different facts into a single generic sentence merely because they share a feature name.
- Every material work item names the chapter where it must appear. At least one visible claim in that chapter lists the work-item ID and reuses the item's evidence or verified trace.
- Tables are preferred for inventories and comparisons. Mermaid is required for ordered flows and connected change scope when those chapters are material.
- A large candidate context is not itself coverage. Coverage means the material inventory was dispositioned, represented in the report, and audited.

`standard` mode keeps the same evidence rules but may intentionally produce a compact report and does not enforce the detailed density floor.

## Evidence accounting

Each section is checkpointed with a claims sidecar. A claim binds one exact visible statement to its evidence level:

- `fact`, `verified`, and `inferred` claims cite one or more evidence IDs;
- those evidence IDs also appear in that section's collapsed evidence block;
- `unavailable` claims cite no evidence and state why static review cannot answer;
- a claim statement is copied exactly from the section, not paraphrased in metadata.

Before audit, every required item in `workitems.json` is completed. A missing, pending, or in-progress item is an omission, not a successful report. `searched-not-found` records the searched scope and a complete zero-result search receipt; `cannot-determine` records the missing information, what would settle it, and evidence for the static-analysis limitation. Material flow, lifecycle, and side-effect findings use a verified trace with evidence for every step. `checklist.json` is only a compatibility projection.

## Claim binding contract

The audit segments each section into substantive statements and requires every one to be covered by a claim. These rules are fixed; `excavator claims scaffold --run <run> --document <id> --section <n> --file section.md` emits one stub per substantive segment using this exact segmentation, so hand-deriving it is unnecessary — fill the stubs' `evidenceIds`/`workItemIds` and adjust markers.

- **Invisible text is excluded first.** Collapsed `<details>` blocks, fenced code blocks, and HTML comments do not produce segments and are not scanned for statement prose.
- **Structural lines are dropped.** Headings (`#`–`######`) and table separator rows (the `| --- | --- |` line) never yield a segment.
- **List and emphasis wrappers are peeled.** Leading list markers (`-`, `*`, `+`, `1.`, `1)`), `**bold**` wrappers, and backtick-wrapped evidence-marker words (`fact`/`verified`/`inferred`/`unavailable` and their localized equivalents) are removed before segmentation.
- **Table rows bind per cell.** A row that starts and ends with `|` is split on `|`; empty cells are dropped and the remaining cells are joined with the full-width separator `；`. Because segmentation then splits on `；`, each cell becomes its own candidate statement — a claim must cover each substantive cell, not the row as a whole. Header cells count too.
- **Statements split on terminators.** Within a line, text is split after `。！？!?；;` and after a period that is followed by whitespace and an uppercase letter or digit.
- **The substantive threshold is 8 semantic characters.** A candidate is substantive only when it contains at least 8 semantic characters, where a semantic character matches `\p{Letter}` or `\p{Number}` (Unicode letters and digits). Punctuation, spaces and symbols do not count toward the threshold.
- **Normalization is shared by segments and claims.** Both a segment and a claim `statement` are normalized the same way before comparison: the characters `` ` ``, `*`, `_`, `>`, `#` and `-` are replaced with a space, runs of whitespace collapse to one space, and the result is trimmed.
- **Coverage is containment, either direction.** A substantive segment is covered when some claim's normalized statement contains the segment or is contained by it. An uncovered segment is an `unclaimed substantive statement` error. Separately, a claim `statement` must normalize to at least 6 characters and appear verbatim in the section's normalized visible text.

## Trace accounting

Use traces when a report describes an ordered process rather than an isolated fact. A trace may represent a call flow, business flow, data flow, state transition, cross-repository path, or analysis path. Each verified step cites evidence. Claims may cite trace IDs in addition to evidence IDs. Do not convert a list of similarly named files into a flow unless the connection is established.
