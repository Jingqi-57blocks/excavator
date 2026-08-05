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
