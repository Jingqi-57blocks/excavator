---
id: feature-engineering
title: Feature report for engineering readers
navTitle: Engineering feature report
kind: feature
audience: engineering
order: 40
---

# Feature report for engineering readers

Audience: developers and technical leads. Explain one capability's business behavior and current implementation, including entries, call paths, data, authorization, configuration, jobs, external dependencies, failure paths, and tests. Do not provide redesign or remediation.

### Detailed report floor

When the request uses `detailed` mode, the report must be an auditable inventory rather than a high-level synopsis.

- Section 1 includes a boundary table covering repositories, runtime units, file/node counts, inclusions and explicit exclusions.
- Section 2 includes separate inventories for UI entries, APIs/callbacks/commands, scheduled entries, callers and handler-resolution status.
- Section 3 includes Mermaid traces for the normal path and every material decision or reversal path established by source.
- Section 4 enumerates every material type or category, state and transition, calculation, threshold, required-field rule, duplicate/idempotency rule, regional difference and implementation difference. Use comparison tables instead of prose compression.
- Section 5 uses a role-by-action table and distinguishes declared middleware, inline authorization and list/object data scope.
- Section 6 inventories entities, material fields and relationships, readers, writers, transactions and visible model-shape differences.
- Section 7 inventories each file/message/export/notification/integration side effect and the data category transferred.
- Section 8 distinguishes validation failure, missing data, persistence failure, external failure, asynchronous failure and partial success.
- Section 9 inventories configuration keys, defaults when visible, switches, jobs, schedules, timeouts and multi-instance coordination evidence.
- Section 10 includes a Mermaid dependency/change-scope diagram grounded in established edges or verified traces.
- Section 11 maps tests and documentation to the material journeys and rules, and lists current contradictions or unfinished paths individually.
- Section 12 quantifies graph, source, evidence, file, work-item and unresolved-reference coverage and states exclusions.

Do not copy a prior report as evidence. A prior report may be used only as a checklist of questions; every retained fact must be re-established from the current snapshot.


## 1. Capability responsibility and technical boundary

Explain the business purpose, participating repositories and runtime units, included graph nodes and files, and deliberately excluded adjacent capabilities.

## 2. Entry points and callers

List pages, APIs, public links, callbacks, commands, and scheduled tasks. Explain visible callers, possible workspace-external callers, and handler-resolution status.

## 3. Main execution paths

Trace control flow from entries through service and data layers, external calls, and return paths. Mark graph gaps and connections confirmed from source.

## 4. Business rules, states, and consistency

Explain validation, calculations, boundary values, state transitions, duplicate submission, concurrency, and rule differences across repositories or runtime parts.

## 5. Authentication, authorization, and data scope

Explain authentication middleware, token types, role checks, object-level permissions, inline handler checks, public entries, and visible data-scope rules.

## 6. Data model and storage

Explain tables or entities, fields, relationships, readers and writers, transactions, snapshots, soft deletion, shared storage, and model-shape differences between parts.

## 7. Files, messages, and external integrations

Explain upload/download paths, object storage, exports, email, messaging, push notifications, third-party APIs, and the categories of data transferred.

## 8. Errors, transactions, and recovery behavior

Explain error propagation, logs, asynchronous results, retry evidence, partial success, transaction boundaries, and the data state visible in source.

## 9. Configuration, switches, and background work

Explain configuration-key names, whether defaults are visible, feature switches, scheduled work, timeouts, and environment differences. Never output secret values.

## 10. Dependencies and connected change scope

Explain callers, callees, shared data, adjacent capabilities, jobs, and external dependencies. State reachability and connection, not a prediction that a change must break something.

## 11. Tests, documentation, and current implementation problems

Explain target test evidence, target documentation, explicitly unfinished target code, target contradictions, entries with no caller found after a complete recorded search, and current locatable target problems.

Do not classify unresolved graph edges, CodeGraph limitations, source fallback, provider coverage, candidate counts, static-review limitations, Excavator behavior or analysis performance as target implementation problems. Put them only in section 12 or in an Excavator validation report.

## 12. Coverage and questions static review cannot answer

Explain graph nodes, relationships, files, source excerpts, cache reuse, excluded files, and runtime questions unavailable to static review.
