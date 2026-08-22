---
id: feature-prd
title: PRD-style feature specification
navTitle: PRD feature specification
kind: feature
audience: prd
order: 50
---

# PRD-style feature specification

Audience: product managers, business analysts and engineers who need a precise, requirement-shaped statement of how one capability currently behaves. Reconstruct the capability as a PRD reverse-engineered from the code: the flows a user lives through, exact rules with their formulas and boundary values, a permission matrix, page interaction down to the field, verbatim notification templates, and a stable requirement trace index. This is a **current-behavior** document — describe only what the reviewed snapshot does. Do not provide recommendations, remediation, target architecture or migration steps, and do not write acceptance criteria, sign-off conditions or checkbox lists: this document states how the capability behaves, never how someone would verify it.

**Write it as a product document.** One test decides every line of visible prose: could a person who only *uses* the running system — who never reads its code and never queries its database — observe this in the interface, or be told it as a business rule? If yes, it is product information and belongs in the chapter. If it takes reading code or inspecting the database to know it, it is implementation information and belongs only inside the collapsed evidence block. Where the same fact has both forms, write the product form — "the reset link stops working 30 minutes after the email is sent", not "the token lifetime is 1800 seconds". `references/writing-rules.md` states the full product/implementation split; the chapters below restate the part that trips authors in that chapter.

The `##` chapters below are the fixed contract and the checkpoint index: keep all eleven, in this order, numbered 1..11. The chapter count and the 1..11 numbering are fixed; each chapter's title is written in the requested output language. Within each chapter, the `###` sub-structure adapts to the feature — add, rename or drop sub-headings to fit what the code actually implements. Prefer Markdown tables and short lists over prose; a PRD is an inventory of rules, not an essay.

Attach each evidence-level marker inline at the end of the statement it qualifies, or place it in the qualified table cell or a dedicated level column; do not leave a marker on its own line or behind an "Evidence level:" lead-in.

A PRD covers **only what the code can analyze**. Things code inherently cannot give — runtime configuration values, rendered pixels or animation, real delivery success, design intent or business rationale — are simply left out; do not pad the report with "unavailable" placeholders for them. Reserve `unavailable` / cannot-determine for something that *should* exist in the code but was not found in this pass.

## 1. Feature overview and boundary

Open directly with what the capability currently does and where its boundary lies. **Do not write a background, goals or roadmap narrative** — no "why we built this", no history, no future plans. State the current behavior, the user groups (roles) who interact with it, and the entry points **in interface language**: the page name the user sees plus the frontend route path they can read in the address bar (`/manage/employee/list`), or the menu path when the page has no addressable route. **No API inventory belongs here** — no HTTP methods, no server route paths, no status codes, no controller or handler names; a user cannot see them, so they stay in the collapsed evidence block. Present the in-scope and deliberately-excluded adjacent behavior as an in/out-of-scope Markdown table (item, in or out of scope, note); out of scope means adjacent behavior this document does not cover, never a plan for a later release. Enumerate roles and entry points as lists.

## 2. Core flows

Give each material end-to-end flow its own numbered step list, `1.` to `N.`, in the order the user lives through it. Write every step from outside the system: what the user does, then what the system answers — "the user submits the form", "the system checks that the username is not already taken", "the page shows the success message and refreshes the list". One step is one observable move; a function call, a request, or a handler is not a step. Cover at least one flow per entry point listed in chapter 1, plus each flow that changes a record's state. Where a flow branches (approved or rejected, first attempt or repeat), either write the branch as a step that names both outcomes or give the branch its own list. This chapter answers *how the capability is used*; chapter 4 answers *what happens to the record*. Do not draw a state machine here and do not restate chapter 3's rules — reference them by their effect on the step.

## 3. Business rules

Enumerate every rule the code enforces. Present them as a Markdown table (rule, formula or threshold, condition, when the user meets it) — carry the actual formula or boundary value from the evidence in the second column, never a vague description. The fourth column is the interaction moment, in the user's terms: while typing, on submit, or after saving. **Which layer, middleware or function performs the check is not that column's content** — it is implementation and goes in the evidence block. Fold configuration-driven thresholds into the same table with their source. Add a separate edge-case table (case, input, resulting behavior) and, where the capability has time boundaries, a time-boundary rules table (boundary, value, effect). When the source contains two rules that disagree, present the disagreement first, before the settled rules.

## 4. States and lifecycle

List the states, their triggers, whether each transition is manual or automatic, reversibility and side effects. Present a state Markdown table (state, meaning, trigger, manual or automatic, side effects) alongside a Mermaid state diagram in the requested output language. Where a state's value can only be determined at a particular moment (for example, a batch that runs at a fixed time), record that when-decidable timing explicitly. Name each state as the interface names it to the user; where the stored value differs from the displayed label, the displayed label leads and the stored value belongs in the evidence block.

## 5. Permissions

State who can perform each action and what data each role can see. Present a role-by-action Markdown matrix (role or permission point, and one column per action: view, create, edit, delete, approve, export…) plus a data-scope table (role, visible scope). Name roles and permission points the way the product names them, and describe what a role without the permission experiences — the control is hidden, disabled, or the action is refused. **Keep the enforcement mechanism out of this chapter**: whether an authorization is declared on a route guard or in middleware, or enforced by an inline check inside a handler, is a code-structure distinction no user can observe. That distinction is recorded in the evidence block, and where it limits what the matrix could establish, stated in chapter 11. Only the outcome belongs here: who may do what, on which data.

## 6. Data and linkage

Explain the business records the capability keeps, field by field, and how they connect to the rest of the product. Present the fields as a Markdown table (record, field, business meaning, source, required / unique / editable, display rule — how an empty value, a truncated value, or a suspended option is shown) and the cross-capability effects as a second table (linked capability, shared record or trigger, effect). Use the names the interface shows the user; where a field is never displayed but its effect is (a computed eligibility, a derived date), describe the effect. **Storage structure does not appear in this chapter**: no table names, no column names, no column types, no indexes, no foreign keys, no schema definitions. All of it stays inside the collapsed evidence block. State reachability and what is shared rather than predicting that a change must affect the other capability.

## 7. Page interaction

Give every page and dialog the capability owns its own `###` sub-heading, and write each one in the same four parts, dropping a part the page does not have:

- **Entry** — the page name the user sees, its frontend route path or menu path, and which roles can reach it.
- **List area** — a list-field table (field, display rule: empty-value placeholder, truncation, date format, status marking, which fields are clickable and where they lead) and a filter-and-search table (control, what it narrows, default placeholder text, multi-select or single).
- **Form** — a field table (field, control type, required, input rule: length limit, format, uniqueness, option source, dependency on another field, what clearing the parent field does).
- **Actions and dialogs** — the buttons and their verbatim labels, what confirmation each destructive action asks for, and the verbatim message each outcome produces.

Quote **UI text verbatim** from the source string literals — labels, placeholders, tooltips, empty-state text, success and failure messages — and cite the source window; source-string literals are first-class evidence here. Where a display rule uses a color, a symbol, an empty-slot placeholder or a time-slot mapping, state it as the user sees it. Runtime-rendered pixels, animation or layout that no source string establishes are out of scope — do not invent them, and do not describe a component by its class or file name.

## 8. Notifications and audit records

Two inventories, each as a Markdown table.

First, every notification the capability emits: a trigger × recipient × channel table (trigger event, recipient, channel). For each template the code assembles from a fixed template constant, quote the template **verbatim as a Markdown blockquote**, and cite the source window of the template constant. A message body assembled at runtime, or a template that lives outside the reviewed source, is not covered — say the notification exists and name its trigger, but do not fabricate its wording.

Second, the operation and audit records the capability writes: a table (action, what record is written, which business fields the record carries, where a user can read it back). Record only what the code establishes — an action that writes no record is simply absent from the table, and where no page exposes the records, say so rather than assuming an entry exists.

## 9. Failure and edge behavior

Two `###` sub-sections.

- **Within this capability** — a scenario table (scenario, what the current code permits, resulting data state) covering empty or invalid input, duplicate submission, concurrent changes, deleted or missing records, partial success, boundary values, and external-service failure.
- **Shared interaction and error handling** — the handling this capability inherits from shared code: loading state, empty state and its verbatim text, the no-result-after-filtering text, the network-failure and server-failure messages, whether a raw server message is ever shown to the user, default page size and the page-size options, and what a changed filter does to the current page. Include a row only where the reviewed source establishes it; shared handling that lives outside this feature's boundary and was not read is left out, not guessed.

Describe only behavior the source establishes. A status code is not user-visible behavior — the message the user reads is.

## 10. Requirement trace index

A stable anchor list so later work can cite a line of this document without quoting it. Two lists, nothing else:

- **`FR-001`, `FR-002`, …** — one line per capability this document establishes, each a single sentence of product language, ending with the chapter that specifies it.
- **`PAGE-001`, `PAGE-002`, …** — one line per page entry from chapter 7, each with its frontend route path or menu path.

Number both lists from `001` upward in document order, three digits, and keep every id unique within the document. This chapter introduces **no** behavior that is not already specified above — it is an index, not a summary — and it defines **no other id series**: no acceptance ids, no component ids, no test ids. Each line is claim-bound exactly like any other substantive statement.

## 11. Appendix: glossary, coverage and open questions

Confine all analysis-method information to this chapter. Include a glossary (business term, source-language name, requested-language rendering); coverage counts (graph nodes, files, source excerpts, searches, with denominators where they represent coverage); the authorization-mechanism boundary kept out of chapter 5 — which actions are covered by a declared route or middleware rule and which by an inline check inside a handler, stated as a limit on what the permission matrix could establish; and open questions — things that should exist in the code but were not found in this pass, recorded as `unavailable` / cannot-determine with the searched scope. CodeGraph coverage, unresolved references, source-window budgets, provider selection and static-review limitations belong only here.
