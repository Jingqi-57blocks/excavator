# Authoring packet — feature-leave-engineering

Sealed knowledge epoch: 0

This packet renders the frozen investigation knowledge this document must cover, organized by report section. It is a deterministic view of `evidence.json`, `workitems.json`, `traces.json` and the feature fact pack; it adds nothing that is not already frozen. Write from each section's block: cover every listed work item, deterministic fact and evidence excerpt, or state explicitly why it does not apply.

## Completeness
Work items required for this document, by disposition: found 2, searched-not-found 1.

Searched but not found:
- `W-3` — src/**/*.ts for resubmit and reopen

## Section 1 — Entry points

### Work items
- `W-1` — api-entrypoints · found · material · the leave route is the entry point

### Deterministic facts
No fact pack was produced for this feature; this section has no deterministic fact floor.

### Evidence
- `E-1` — leave route handler (`src/leave.ts:10-12`)

```
app.post('/leave', requireManager, createLeave);
const MAX_DAYS = 20;
return { ok: true };
```
- `E-2` — search "leave, approval": 7 candidate file(s), 2 match(es)

### Traces
- `T-1` — employee submits a leave request · verified · 2 steps

## Section 2 — Data model

### Work items
- `W-2` — entities-and-fields · found · material · leave requests carry a day count

### Deterministic facts
No fact pack was produced for this feature; this section has no deterministic fact floor.

### Evidence
- `E-1` — see the section 1 block

### Traces
- `T-1` — see the section 1 block

## Logic disposition — rescued decision functions (place each where its behavior belongs)

### Work items
- `W-3` — decision-flow · searched-not-found · non-material · a rejected request can be resubmitted
  - search scope: src/**/*.ts for resubmit and reopen

### Deterministic facts
No fact pack was produced for this feature; this section has no deterministic fact floor.

### Evidence
- `E-3` — README leave section (`README.md:1-2`)

```
# Leave
Requests are approved by a manager.
```
