---
id: excavator-writing-rules
version: 1.3.0
---

# Excavator writing rules

These rules apply to every report.

## Evidence language

Every material statement uses one of four semantic levels:

- **fact** — directly supported by CodeGraph or a recorded source excerpt;
- **inferred** — a business or technical interpretation grounded in named facts;
- **verified** — a hypothesis was searched and the searched scope is recorded;
- **unavailable** — static source review cannot answer it.

Render these semantic markers consistently in the requested output language, choosing from the vocabulary the audit recognises: `references/evidence-markers.json` lists the accepted token for every level in every supported language. Do not copy the English marker words into a report when they would be unnatural in that language, and do not invent a synonym — that file is the contract, and a marker outside it leaves its chapter reported as having no evidence level at all.

The audit reads a marker as a WHOLE backticked token. A component name that merely contains a marker word is therefore not a marker.

Place each marker by these rules:

- Attach the marker inline at the end of the statement it qualifies, on the same line, or place it inside the qualified table cell or a dedicated level column.
- Do not write a marker as its own standalone paragraph, and do not introduce one with an "Evidence level:" lead-in.
- Every substantive chapter keeps at least one marker in visible prose outside its `<details>` evidence block, because the audit reads markers only from the visible reading flow.

CodeGraph is a navigation index, not the complete source of truth. When graph data is missing, unresolved, ambiguous, unsupported, or lacks the semantic detail needed for a statement, read a bounded source window and record it as evidence.

### Comparison claims cite every side

A claim that asserts equivalence, consistency, sameness, or shared values or behavior across implementations, modules, repositories, or runtime parts is a multi-source claim. Mark it `fact` only when it cites evidence for every compared side and groups that evidence per side in the claim's `sides` field (each group is a non-empty, non-overlapping subset of the claim's `evidenceIds`). When only one side has recorded evidence, either record the missing side's evidence first or downgrade the claim to `inferred` and name which side was observed. `fact` is reserved for what the cited evidence directly shows; a single-sided citation cannot establish a two-sided equivalence, and splitting one comparison into two single-sided `fact` claims does not satisfy this rule.

## Current state only

Describe what the reviewed snapshot contains and what its paths permit. Do not provide recommendations, remediation plans, target architectures, migration steps, acceptance criteria, or action items.

**Exception — PRD reports' acceptance chapter.** A PRD report's acceptance chapter is exempt from the acceptance-criteria prohibition: each acceptance item restates a current behavior that is already shown in the report's evidence. Introducing behavior not shown in evidence remains forbidden, so the chapter is a checklist view of established facts, never a list of new requirements.

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

## PRD reports

The `prd` feature audience produces a requirement-shaped statement of a capability's current behavior (`references/prd-feature.md`). It is feature-only — there is no prd overview. Its rules refine, not replace, the general rules above:

- No background chapter. Open with current behavior; do not write goals, history or roadmap narrative.
- Every rule line carries the actual formula or threshold **values** from the evidence, not a vague description of the rule.
- UI strings and notification templates are quoted **verbatim** from the source string literals or template constants, with a cited source window. A string assembled at runtime, or a template that lives outside the reviewed source, is not covered — do not write it.
- The permission matrix distinguishes authorization that is **declared** (middleware, route guards) from authorization enforced by an **inline check** inside the handler.
- Acceptance items are claim-bound like any substantive statement (see the acceptance-chapter exception under "Current state only").
- Prefer tables, lists and short paragraphs; no long prose. Implementation identifiers stay in the collapsed evidence blocks, the same as product reports.
- A PRD covers only what the code can analyze. Things code inherently cannot give — runtime configuration values, rendered pixels or animation, real delivery success, design intent — are simply **not written**; padding the report with "unavailable" placeholders for them violates readability. Reserve `unavailable` / `cannot-determine` for something that *should* exist in the code but was not found this pass.

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

The audit segments each section into substantive statements and requires every one to be covered by a claim. These rules are fixed, and the claims sidecar has to match them exactly: one claim per substantive segment, each with its `evidenceIds`/`workItemIds` filled in and its marker set to the right evidence level.

- **Invisible text is excluded first.** Collapsed `<details>` blocks, fenced code blocks, and HTML comments do not produce segments and are not scanned for statement prose.
- **Structural lines are dropped.** Headings (`#`–`######`) and table separator rows (the `| --- | --- |` line) never yield a segment.
- **List and emphasis wrappers are peeled.** Leading list markers (`-`, `*`, `+`, `1.`, `1)`), `**bold**` wrappers, and backtick-wrapped evidence-marker words (`fact`/`verified`/`inferred`/`unavailable` and their localized equivalents) are removed before segmentation.
- **Table rows bind per cell.** A row that starts and ends with `|` is split on `|`; empty cells are dropped and the remaining cells are joined with the full-width separator `；`. Because segmentation then splits on `；`, each cell becomes its own candidate statement — a claim must cover each substantive cell, not the row as a whole. Header cells count too.
- **Statements split on terminators.** Within a line, text is split after `。！？!?；;` and after a period that is followed by whitespace and an uppercase letter or digit.
- **The substantive threshold is 8 semantic characters.** A candidate is substantive only when it contains at least 8 semantic characters, where a semantic character matches `\p{Letter}` or `\p{Number}` (Unicode letters and digits). Punctuation, spaces and symbols do not count toward the threshold.
- **Normalization is shared by segments and claims.** Both a segment and a claim `statement` are normalized the same way before comparison: the characters `` ` ``, `*`, `_`, `>`, `#` and `-` are replaced with a space, runs of whitespace collapse to one space, and the result is trimmed.
- **A claim statement must be bindable.** It must normalize to at least 6 characters and appear verbatim in the section's normalized visible text. A shorter statement is reported `statement is too short to bind`: a two- or three-character string is contained by most sentences of any length, so it is bound to nothing in particular.
- **Coverage is containment, either direction, from bindable claims only.** A substantive segment is covered when some claim that clears the 6-character threshold has a normalized statement that contains the segment or is contained by it. An uncovered segment is an `unclaimed substantive statement` error. The two rules share one threshold on purpose: a claim that cannot be bound to the prose cannot vouch for the prose, so a stub statement never silences an unclaimed sentence — it is reported beside it.

## Report section derivation

For a feature report, every investigation dimension carries an auto-derived `reportSection` that maps it to a canonical chapter index: boundary → 1; entry points and callers → 2; normal, decision and reversal flows → 3; types, states, calculations and validation → 4; authorization and data scope → 5; entities and storage → 6; files, integrations and notifications → 7; failure modes and transactions → 8; configuration and background work → 9; connected change scope → 10; tests, documentation and unfinished code → 11; coverage and open investigation → 12.

This number is only the work-item-to-section link the audit checks when a claim cites a work item; it does not set the report's chapter titles. The report's chapter headings always follow the per-type template you are writing, so a product chapter may carry a different title or order than the dimension number — that divergence is expected, not an error. Overview documents carry no `reportSection`, so the link is enforced only for feature reports.

## Logic-disposition work items

Every rescued `logic` fact-pack function — a business or decision function structural analysis pulled into the feature boundary, marked with a `signal` — is promoted to a `logic-disposition` work item in `workitems.json` (`feature:<key>:logic:<name>@<path>:<line>`). These items are **material and required**, so an undisposed one blocks freeze and fails the audit — the mechanism that stops an author from silently skipping a deciding function.

- **No pinned section.** A behavioral rule may legitimately belong to the flow, decision or authorization chapter, so a logic-disposition item carries no `reportSection`; place it where its behavior belongs. The authoring packet lists these under a trailing "Logic disposition" block rather than under one section.
- **Cover the behavior, not the name.** A legitimate disposition is a visible claim that describes the business behavior and cites the deciding source window, with the item's id in the claim's `workItemIds`. The prose need **not** contain the identifier — identifiers stay in the collapsed evidence block or coverage chapter (product reports keep them out of prose). The coverage ledger binds through the cited evidence, so "covered the behavior" counts.
- **Boundary noise is `not-applicable`.** A rescued item that turns out to be boundary noise is disposed `not-applicable` with a reason, satisfied by a linked `unavailable` (or `verified`) claim. One claim may batch-dispose several n/a items by listing them all in its `workItemIds` array.

## Easy-to-miss audit rules

Three rules trip authors most often. Each is a hard audit **error**, not a warning:

- **Reverse evidence-block rule.** Every evidence id listed in a section's `<details>` block must be cited by at least one claim in that same section. The check runs in the direction authors do not expect: declaring an evidence id in the evidence block but never binding it to a claim is an error, not a harmless extra. List only the evidence ids the section's claims actually cite.
- **`unavailable` claims need a reason and no evidence.** An `unavailable` claim must carry a `reason` and must cite no evidence ids. Omitting the reason, or attaching evidence ids to an `unavailable` claim, fails the audit.
- **`searched-not-found` needs a clean search receipt.** A `searched-not-found` disposition requires a zero-match, non-truncated `SEARCH-*` receipt. A receipt that contains any match, or that is marked `truncated: true`, cannot support `searched-not-found`; investigate further or choose a different disposition.

## Trace accounting

Use traces when a report describes an ordered process rather than an isolated fact. A trace may represent a call flow, business flow, data flow, state transition, cross-repository path, or analysis path. Each verified step cites evidence. Claims may cite trace IDs in addition to evidence IDs. Do not convert a list of similarly named files into a flow unless the connection is established.
