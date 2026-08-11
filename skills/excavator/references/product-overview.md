---
id: project-product
title: Project overview for product readers
navTitle: Product overview
kind: overview
audience: product
order: 10
---

# Project overview for product readers

Audience: product managers, business owners, operations leads, and project managers. Explain what the current project is, who uses it, which business capabilities it contains, how those capabilities relate, and which current facts or problems are visible in the reviewed snapshot. Keep implementation details out of the reading flow and do not provide recommendations.

Present inventory, enumeration, and comparison content — capability lists, system parts, roles, business objects and their states, dependencies, and back-office capabilities — as Markdown tables, and present parallel or enumerated items as Markdown lists, rather than as prose paragraphs. Tables are preferred for inventories and comparisons; use tables and Mermaid diagrams wherever they improve comprehension. Attach each evidence-level marker inline at the end of the statement it qualifies, or place it in the qualified table cell or a dedicated level column; do not leave a marker on its own line or behind an "Evidence level:" lead-in.

## 1. Project purpose and boundary

Explain what the project is, which organizational activities it supports, its main users, its core scenarios, the internal and external boundary, and any stage information that static source cannot establish. The opening must be understandable to a business reader who has never seen the project. Enumerate the main users and core scenarios as a Markdown list once the opening narrative has introduced them.

## 2. System parts and responsibilities

Explain the user-facing applications, independently operated services, and background components, including each part's business responsibility, users, and currently reachable entry points. Do not equate repository count with system-part count. Present the parts as a Markdown table with one row per part (part, business responsibility, users, reachable entry points).

## 3. Business domains and capability map

Organize domains, capabilities, and user actions in business language. Cover employee-facing use, administration, external users, automation, import and export, notifications, and third-party integrations. Explain relationships between capabilities without expanding the internal implementation of one feature. Present the domain-to-capability map as a Markdown table or a nested Markdown list rather than a prose paragraph.

When `context/cross-feature.json` is present (a run that covers two or more features), include a cross-feature relationship matrix or table grounded in it: for each related pair of capabilities, show what they share (files, business objects, configuration keys). This is deterministic prepared context, not an audited claim; honor its notes, including that cross-module relationships are limited to shared files, objects and configuration keys.

## 4. Users, roles, and permission boundary

List the main user groups and roles, the operations and data scopes that can be confirmed, and the boundary between permissions declared at entry points and permissions enforced inside processing logic. State the limitation when a complete matrix cannot be established. Present roles and their confirmed operations and data scopes as a Markdown table (role, confirmed operations, data scope).

## 5. Core business objects and lifecycles

Explain the main business objects, their relationships, who creates or changes them, and their important states and transitions. Identify objects connected to money, permissions, or sensitive information without exposing raw table names in the reading flow. Present the business objects as a Markdown table (object, relationships, who creates or changes it, key states); a Mermaid state diagram may accompany an object with a material lifecycle.

## 6. Data landscape and movement

Explain where data comes from, which parts read or write it, how it is shared or handed over, which data leaves the project, and which capabilities support export, deletion, archiving, or isolation. Do not infer business ownership from observed reads or writes. Present readers, writers, and shared or exported data as a Markdown table, and enumerate the export, deletion, archiving, and isolation capabilities as a Markdown list.

## 7. External dependencies and integrations

Name external products, their purpose, the capabilities that depend on them, the data sent or received, and the failure behavior visible in source. Do not infer that infrastructure has no retries merely because application code has none. Present the dependencies as a Markdown table (external product, purpose, dependent capabilities, data exchanged, failure behavior).

## 8. Operations and back-office capabilities

Explain administration, approvals, finance, bulk operations, import and export, manual compensation, reporting, scheduled work, and audit records. Include hard limits that have direct business meaning. Present the back-office capabilities as a Markdown table or a Markdown list rather than a prose paragraph, and note each item's hard limits alongside it.

## 9. Current problems found

List only problems found in the reviewed snapshot; general state narrative belongs to sections 1–8. Include only target-attributable contradictions, reachable permission problems, shared writes, rule differences, explicitly unfinished target code, target documentation conflicts, and target entry points with no caller found after a complete recorded search. Each item states its target evidence, what the current target code permits, priority, and confidence. Do not include remediation. Present the items as a Markdown table or a Markdown list (item, target evidence, what current code permits, priority, confidence).

Do not include CodeGraph or Excavator limitations, unresolved graph references, source fallback, provider coverage, analysis budgets, static-review limitations or analysis performance. Those belong only in section 10 or in an Excavator validation report.

## 10. Coverage and source snapshot

Explain repository revisions, uncommitted changes, the reviewed file boundary, Git ignore rules, CodeGraph coverage, source fallback, unresolved relationships, and questions static analysis cannot answer. This chapter describes the analysis boundary and must not present analyser limitations as project defects. Present the coverage counts as a Markdown table and include denominators where they represent coverage.
