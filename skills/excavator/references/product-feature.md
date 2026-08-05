---
id: feature-product
title: Feature report for product readers
navTitle: Feature report
kind: feature
audience: product
order: 20
---

# Feature report for product readers

Audience: product managers, business owners, and operations leads. Explain how one business capability currently works, what happens in exceptional paths, and how it relates to other capabilities. Keep implementation details out of the reading flow and do not provide recommendations.

## 1. What the capability is and where its boundary lies

Explain the business purpose, user actions, user groups, entry points in interface language, required preconditions, included scope, and deliberately excluded adjacent scope.

## 2. How a person uses it

Explain the user journey in order: choices, success results, failure messages, return or retry paths, approvals, and role differences. Do not construct a journey from entry-point names alone.

## 3. Business rules enforced by the capability

Cover required fields, formats, money, quantity, time, uniqueness, ordering, calculations, approvals, cancellation, and automatic handling. State when and where each rule is enforced. Present disagreements in the same rule first.

## 4. States and lifecycle

List states, initial and terminal states, triggers, manual or automatic transitions, reversibility, and side effects. Include a Mermaid state diagram using the requested output language.

## 5. Who can do what and see what

Explain confirmed view, create, change, delete, approve, export, bulk, and proxy operations, plus data scope. State the visibility boundary between entry-point declarations and inline authorization.

## 6. Data and fields

Explain the business records involved, the meaning and source of key fields, editability, sensitivity, deletion behavior, and other capabilities that read the same data.

## 7. Other effects triggered when it runs

Explain notifications, email, push, financial changes, permission changes, audit records, synchronization, and external calls. Distinguish known call sites from runtime recipients or message content that static review cannot establish.

## 8. What happens when things go wrong

Investigate empty input, invalid input, duplicate submission, concurrent changes, permission changes, deleted records, partial success, boundary values, network failure, and external-service failure. Explain the visible result, data state, and retry behavior supported by source.

## 9. Configuration, switches, and automatic work

Explain relevant configuration keys, whether defaults are visible, environment or customer differences, behavior when a switch is off, and related scheduled work.

## 10. Current problems and connected scope

List only target-attributable feature problems: locatable rule gaps, implementation differences, permission or data-scope defects, contradictory target tests or documentation, explicitly unfinished target code, discarded target errors, and target entries with no caller found after a complete recorded search. Explain connected entries, records, scheduled work, and other capabilities without recommendations.

Do not list CodeGraph limitations, unresolved graph references, source fallback, provider coverage, candidate counts, static-review limitations, Excavator behavior, prompt quality, audit limitations or analysis performance here. Put those only in section 12 or in an Excavator validation report.

## 11. Glossary

List business terms used by the report, source-language names, and requested-language renderings.

## 12. Coverage and questions static review cannot answer

Explain graph nodes, files, source excerpts, test evidence, unresolved relationships, excluded files, and runtime questions that remain unavailable.
