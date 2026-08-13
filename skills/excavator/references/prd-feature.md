---
id: feature-prd
title: PRD-style feature specification
navTitle: PRD feature specification
kind: feature
audience: prd
order: 50
---

# PRD-style feature specification

Audience: product managers, business analysts and engineers who need a precise, requirement-shaped statement of how one capability currently behaves. Reconstruct the capability as a PRD reverse-engineered from the code: exact rules with their formulas and boundary values, a permission matrix, precise frontend interaction, verbatim notification templates, and an acceptance checklist. This is a **current-behavior** document — describe only what the reviewed snapshot does. Do not provide recommendations, remediation, target architecture or migration steps.

The `##` chapters below are the fixed contract and the checkpoint index: keep them, in this order, numbered 1..10. Within each chapter, the `###` sub-structure adapts to the feature — add, rename or drop sub-headings to fit what the code actually implements. Prefer Markdown tables and short lists over prose; a PRD is an inventory of rules, not an essay.

Attach each evidence-level marker inline at the end of the statement it qualifies, or place it in the qualified table cell or a dedicated level column; do not leave a marker on its own line or behind an "Evidence level:" lead-in.

A PRD covers **only what the code can analyze**. Things code inherently cannot give — runtime configuration values, rendered pixels or animation, real delivery success, design intent or business rationale — are simply left out; do not pad the report with "unavailable" placeholders for them. Reserve `unavailable` / cannot-determine for something that *should* exist in the code but was not found in this pass.

## 1. Feature overview and boundary

Open directly with what the capability currently does and where its boundary lies. **Do not write a background, goals or roadmap narrative** — no "why we built this", no history, no future plans. State the current behavior, the user groups (roles) who interact with it, and the entry points in interface language. Present the in-scope and deliberately-excluded adjacent behavior as an in/out-of-scope Markdown table (item, in or out of scope, note). Enumerate roles and entry points as lists.

## 2. Business rules

Enumerate every rule the code enforces. Present them as a Markdown table (rule, formula or threshold, condition, where enforced) — carry the actual formula or boundary value from the evidence in the second column, never a vague description. Fold configuration-driven thresholds into the same table with their source. Add a separate edge-case table (case, input, resulting behavior) and, where the capability has time boundaries, a time-boundary rules table (boundary, value, effect). When the source contains two rules that disagree, present the disagreement first, before the settled rules.

## 3. States and lifecycle

List the states, their triggers, whether each transition is manual or automatic, reversibility and side effects. Present a state Markdown table (state, meaning, trigger, manual or automatic, side effects) alongside a Mermaid state diagram in the requested output language. Where a state's value can only be determined at a particular moment (for example, a batch that runs at a fixed time), record that when-decidable timing explicitly.

## 4. Permissions

State who can perform each action and what data each role can see. Present a role-by-action Markdown matrix (role, and one column per action: view, create, edit, delete, approve, export…) plus a data-scope table (role, visible scope). State the visibility boundary between authorization that is declared (middleware, route guards) and authorization enforced by an inline check inside the handler.

## 5. Data and linkage

Explain the business records the capability reads and writes, the meaning and source of key fields, and the cross-capability side effects — which other capabilities read or write the same records, and what this capability triggers in them. Present the key fields as a Markdown table (record, field, meaning, source) and the linkages as a table (linked capability, shared record or trigger, effect). State reachability and what is shared rather than predicting that a change must affect the other capability.

## 6. Frontend interaction

Specify, per page and per time slot or display region, exactly what the interface shows. Cover display colors, symbols, empty-slot / empty-state rendering, click interactions, and the AM/PM (or equivalent) time-slot mapping where the capability splits a record across slots. Quote **hover-tooltip and other UI text verbatim** from the source string literals — source-string literals are first-class evidence here, cited to their source window. Present the display rules as Markdown tables (scenario, symbol or color, verbatim text). Runtime-rendered pixels, animation or layout that no source string establishes are out of scope — do not invent them.

## 7. Notifications

Inventory every notification the capability emits. Present a trigger × recipient × channel Markdown table (trigger event, recipient, channel). For each template the code assembles from a fixed template constant, quote the template **verbatim as a Markdown blockquote**, and cite the source window of the template constant. A message body assembled at runtime, or a template that lives outside the reviewed source, is not covered — say the notification exists and name its trigger, but do not fabricate its wording.

## 8. Failure and edge behavior

Explain what the code actually permits on the abnormal paths: empty or invalid input, duplicate submission, concurrent changes, deleted or missing records, partial success, boundary values, and external-service failure. Present each as a row in a Markdown table (scenario, what the current code permits, resulting data state). Describe only behavior the source establishes.

## 9. Acceptance checklist

Restate the confirmed rules from chapters 2–8 as a checkbox list — one `- [ ]` item per rule, grouped by area with `###` sub-headings that mirror the feature's structure. Each item is a 1:1 restatement of an already-evidenced current behavior, and is claim-bound exactly like any substantive statement (a visible claim citing the same evidence). This chapter introduces **no** behavior that is not already shown in the evidence of chapters 2–8; it is a checklist view of established facts, not new requirements.

## 10. Appendix: glossary, coverage and open questions

Confine all analysis-method information to this chapter. Include a glossary (business term, source-language name, requested-language rendering); coverage counts (graph nodes, files, source excerpts, searches, with denominators where they represent coverage); and open questions — things that should exist in the code but were not found in this pass, recorded as `unavailable` / cannot-determine with the searched scope. CodeGraph coverage, unresolved references, source-window budgets, provider selection and static-review limitations belong only here.
