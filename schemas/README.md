# Excavator core artifact schemas (v1)

JSON Schema 2020-12 is the only public contract of Excavator Core (`docs/tool-selection.md` §三). Everything an external
consumer may rely on — Evidence, Finding, Claim, Coverage — is defined here; the semantics behind these fields live in
`docs/direction.md` §八 (core artifacts) and §十二 (dual-snapshot compatibility).

## Files

| File | Contract |
|---|---|
| `common.schema.json` | Shared `$defs` only: `schemaVersion`, `snapshotId`, `artifactId`, `confidence`, `creationMethod`, `idArray`. Never validated on its own. |
| `evidence.schema.json` | A source or structured observation bound to exactly one Snapshot. |
| `finding.schema.json` | Shared envelope plus a payload discriminated by the nine finding types. |
| `claim.schema.json` | A sentence or table row of formal output, bound to Findings or Evidence. |
| `coverage.schema.json` | Per-dimension accountability: found, searched-not-found, provider-unsupported, unresolved, external-unknown. |
| `examples/manifest.json` | Every example artifact with the schema it belongs to and its expected verdict. Invalid entries also declare `errorPathIncludes`, the fragment the validation error must contain. |

`tests/schemas.test.ts` compiles all five schemas, walks the manifest, and rehearses mapping real run artifacts onto the
contract. The generated standalone validators (`docs/tool-selection.md` §三) arrive with the Ajv build pipeline; Core
itself never loads Ajv and never compiles schemas at runtime.

## Version policy

- The contract version lives in two places that move together: the `v1` segment of every `$id`, and the `schemaVersion`
  constant inside each artifact. A breaking change means a new `$id` version segment and a new `schemaVersion` value, not
  an edit in place.
- Inside v1, every artifact object sets `additionalProperties: false`. Unknown fields are rejected rather than ignored,
  so a consumer can tell a v1 artifact from a later one without guessing.
- Payloads of the seven non-comparison, non-sufficiency finding types are deliberately minimal (`summary` only, extra
  properties allowed). Deeper definitions are earned by real consumers (`docs/direction.md` §十七), not written ahead of
  them.

## Dual-snapshot rules (`docs/direction.md` §十二)

| # | Rule | Where it is expressed |
|---|---|---|
| 1 | Every Evidence belongs to a single Snapshot | `evidence.schema.json`: `snapshotId` is a required singular string, never an array. |
| 2 | A Finding may reference several Snapshots | `finding.schema.json`: `snapshotIds` is a required array (`minItems: 1`, unique). |
| 3 | A Comparison Finding states before and after explicitly | `finding.schema.json`: `type: "comparison"` requires `beforeSnapshotId` and `afterSnapshotId` in the payload. |
| 4 | Cache keys and entity identity do not assume a single Snapshot | Not expressible in a schema — it is an implementation constraint on caching and identity, landing in Phase 1B/5. |
| 5 | A Claim may reference a Comparison Finding | `claim.schema.json`: `findingIds` accepts any Finding id, including comparison findings; nothing binds a Claim to one Snapshot. |

## Assurance rules carried by the Finding schema

`docs/direction.md` §九 makes these mandatory for the Interactive Profile, so they are schema-enforced rather than
convention:

- `creationMethod` is required and explicit (`deterministic` or `agent-interpreted`).
- `basis: "evidence"` requires a non-empty `evidenceIds`.
- `basis: "inference"` and `basis: "unavailable"` require a non-empty `reason`.
- A `provider-sufficiency` payload must carry required capabilities, available capabilities, target coverage, unresolved
  relations, source-fallback usage, source confirmation of key relations and ceiling reasons — and must **not** carry a
  `score` or `totalScore` property. A sufficiency verdict is never decided by a single unexplainable total.
