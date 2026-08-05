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

## 1. Project purpose and boundary

Explain what the project is, which organizational activities it supports, its main users, its core scenarios, the internal and external boundary, and any stage information that static source cannot establish. The opening must be understandable to a business reader who has never seen the project.

## 2. System parts and responsibilities

Explain the user-facing applications, independently operated services, and background components, including each part's business responsibility, users, and currently reachable entry points. Do not equate repository count with system-part count.

## 3. Business domains and capability map

Organize domains, capabilities, and user actions in business language. Cover employee-facing use, administration, external users, automation, import and export, notifications, and third-party integrations. Explain relationships between capabilities without expanding the internal implementation of one feature.

## 4. Users, roles, and permission boundary

List the main user groups and roles, the operations and data scopes that can be confirmed, and the boundary between permissions declared at entry points and permissions enforced inside processing logic. State the limitation when a complete matrix cannot be established.

## 5. Core business objects and lifecycles

Explain the main business objects, their relationships, who creates or changes them, and their important states and transitions. Identify objects connected to money, permissions, or sensitive information without exposing raw table names in the reading flow.

## 6. Data landscape and movement

Explain where data comes from, which parts read or write it, how it is shared or handed over, which data leaves the project, and which capabilities support export, deletion, archiving, or isolation. Do not infer business ownership from observed reads or writes.

## 7. External dependencies and integrations

Name external products, their purpose, the capabilities that depend on them, the data sent or received, and the failure behavior visible in source. Do not infer that infrastructure has no retries merely because application code has none.

## 8. Operations and back-office capabilities

Explain administration, approvals, finance, bulk operations, import and export, manual compensation, reporting, scheduled work, and audit records. Include hard limits that have direct business meaning.

## 9. Risks and current state

Include only target-attributable contradictions, reachable permission problems, shared writes, rule differences, explicitly unfinished target code, target documentation conflicts, and target entry points with no caller found after a complete recorded search. Each item states its target evidence, what the current target code permits, priority, and confidence. Do not include remediation.

Do not include CodeGraph or Excavator limitations, unresolved graph references, source fallback, provider coverage, analysis budgets, static-review limitations or analysis performance. Those belong only in section 10 or in an Excavator validation report.
""
)
p.write_text(s)

p=Path('skills/excavator/references/engineering-overview.md')
s=p.read_text()
s=s.replace(
"## 11. Tests, documentation, and current technical problems

Explain test types and distribution, repository documentation, explicit TODO or deprecation markers, structural conflicts, shared writes, duplicate entries, and unresolved dependencies. Describe current problems without solutions.
",

## 10. Coverage and source snapshot

Explain repository revisions, uncommitted changes, the reviewed file boundary, Git ignore rules, CodeGraph coverage, source fallback, unresolved relationships, and questions static analysis cannot answer. This chapter describes the analysis boundary and must not present analyser limitations as project defects.
