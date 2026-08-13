---
id: project-engineering
title: Project overview for engineering readers
navTitle: Engineering overview
kind: overview
audience: engineering
order: 30
---

# Project overview for engineering readers

Audience: developers and technical leads. Describe the current business and implementation landscape, including repositories, stacks, runtime boundaries, communication, data, files, configuration, jobs, tests, and current technical problems. Do not propose a target architecture or remediation.

Present inventories and comparisons — repositories and runtime units, stacks, interfaces and entry points, data models, identity and authorization, external integrations, configuration and jobs, and tests — as Markdown tables, and present enumerated items as Markdown lists rather than prose paragraphs. Tables are preferred for inventories and comparisons; use tables and Mermaid diagrams wherever they improve comprehension. Attach each evidence-level marker inline at the end of the statement it qualifies, or place it in the qualified table cell or a dedicated level column; do not leave a marker on its own line or behind an "Evidence level:" lead-in.

## 1. System purpose, scope, and source snapshot

Explain the business problem, target workspace, repository revisions, uncommitted changes, Git-aware source boundary, and static-review limits.

## 2. Repositories and runtime units

List repositories, applications, services, background processes, and scripts with their responsibilities. Distinguish source repositories from independently deployed or operated runtime units.

## 3. Technology stack and build model

Explain languages, frameworks, important libraries, package management, build tools, runtime entry points, and version evidence. State only what the current declarations support; do not infer production versions.

## 4. Runtime topology and communication

Explain front ends, services, gateway evidence, synchronous APIs, shared databases, messaging, file handoffs, and direct or indirect cross-repository dependencies. Include a Mermaid diagram.

## 5. Interfaces and entry points

Explain user-interface routes, HTTP APIs, public APIs, callbacks, commands, scheduled tasks, and public links. Distinguish registered entries, resolved handlers, and unresolved entries.

## 6. Code organization and call structure

Explain major packages, modules, components, service layers, data layers, and call directions. Identify highly connected nodes, cycles, or truncated areas without substituting artifact counts for architecture explanation.

When `context/cross-feature.json` is present (a run that covers two or more features), include a cross-feature relationship matrix or table grounded in it: for each related pair of features, show the files, entities and configuration keys they share. This is deterministic prepared context (set intersection over feature scopes and fact packs), not an audited claim; honor its notes, including that cross-module CodeGraph edges are not represented, so the relationships are limited to shared files, entities and configuration keys.

## 7. Data models, storage, and files

Explain database technologies, ORM or query approaches, shared tables or models, read/write boundaries, transaction evidence, caches, object storage, upload/download paths, and exported files.

## 8. Identity, authentication, and authorization

Explain identity providers, tokens, sessions, middleware, roles, inline authorization, public entries, object-level checks, and permission problems visible in the reviewed source.

## 9. External integrations and failure paths

Explain external products, client wrappers, call sites, timeouts, error propagation, logging, discarded asynchronous results, and recovery behavior visible in source.

## 10. Configuration, jobs, deployment, and observability

Explain configuration sources, safe environment templates, containers, CI evidence, scheduled work, logs, health checks, metrics, and tracing. Never output secret values.

## 11. Tests, documentation, and current technical problems

Explain test types and distribution, repository documentation, explicit TODO or deprecation markers, structural conflicts, shared writes, duplicate entries, and unresolved dependencies. Describe current problems without solutions.

List only problems attributable to the reviewed target snapshot. Do not include CodeGraph or Excavator limitations, unresolved graph references, source fallback, provider coverage, analysis budgets, static-review limitations or analysis performance. Those belong only in section 12 or in an Excavator validation report.

## 12. Coverage and unresolved information

Explain the Git-aware file boundary, CodeGraph support, source fallback, query and source budgets, unresolved nodes, excluded files, and questions that require runtime or infrastructure information.

## 13. Database design

Describe the physical database schema the reviewed source declares: the tables, their columns, and the relationships between them. Resolve every column and type from declarations in the reviewed source. Never output stored data values or secrets.

For each table, give its name followed by a Markdown table with one row per column: column name, type, nullable, default, and key (primary, foreign, unique, or index). Resolve columns by source priority: migration scripts and raw DDL are the authoritative physical schema; model declarations and their field-to-column mapping (field tags, annotations, or schema-builder calls) come next; the columns a query layer actually reads or writes are supporting evidence. When a declaration window directly supports a column row, mark that row a fact.

Derive relationships only from declared foreign keys, explicit association declarations, or join conditions present in the reviewed source. Mark a relationship inferred when it rests on name similarity rather than a declaration, and name what the inference is based on. Present the relationships as a Mermaid `erDiagram`.

When a table is read or written by more than one runtime unit, cross-reference the shared-storage findings in section 7 rather than restating them.

State coverage honestly: report how many tables were enumerated against how many were found, and carry the denominator wherever a count represents coverage. If the reviewed source declares no database at all, record one searched statement, marked verified and backed by a search receipt for the schema, migration, and data-access locations examined, rather than leaving this chapter empty. Do not pad the chapter with placeholders for information the source cannot provide.
