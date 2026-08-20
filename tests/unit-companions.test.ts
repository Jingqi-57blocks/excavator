/**
 * The claims and traces companions of the unit path.
 *
 * THE LOAD-BEARING TEST HERE IS THE FOLDING ONE. `assurance-artifacts.ts` records the measured cost of keying a
 * run's claims by claim id alone: 472 claims across 12 sections reported as 81, because 74 ids appeared 12 times
 * each. Units can collide the same way, so the aggregator takes its key function as a parameter and this file hands
 * it the WRONG one — a claim-id-only keyer, the design the companion rejects — and watches the refusal fire. A
 * collapse guard that can only ever be handed the correct keyer can only ever go green.
 *
 * The traces half tests the selection rule rather than a count: a trace reaches a document's companion only through
 * an explicit id reference (its own `documentIds`, or a unit claim's `traceIds`), never through the `claimIds` on a
 * trace step — that would be 57B-458's join, and a step naming `claim-1` cannot say which unit's `claim-1` it meant.
 * The negative fixture below is exactly that shape: a trace whose step cites `claim-1` while no claim cites it back.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { SectionClaim, TraceRecord } from "../src/base/types.ts";
import {
  aggregateUnitClaims,
  aggregateUnitTraces,
  unitClaimKey,
  UNIT_CLAIMS_COMPANION_VERSION,
  UNIT_TRACES_COMPANION_VERSION,
  type UnitClaimsAggregation
} from "../src/report/unit-companions.ts";

const DOCUMENT_ID = "overview-product";
const LEAF = `${DOCUMENT_ID}::leaf::route`;
const APPENDIX = `${DOCUMENT_ID}::appendix::coverage`;

function claim(id: string, statement: string, traceIds: string[] = []): SectionClaim {
  return { id, marker: "fact", statement, evidenceIds: ["S-aaaaaaaaaa"], traceIds, confidence: "high", status: "verified" };
}

/** Two units that both number their first claim `claim-1` — the legal shape a folding key destroys. */
function aggregation(traceIds: { leaf?: string[]; appendix?: string[] } = {}): UnitClaimsAggregation {
  return {
    runId: "run-x",
    documentId: DOCUMENT_ID,
    knowledgeEpoch: 2,
    planCatalogDigest: "d".repeat(64),
    units: [
      { unitId: LEAF, kind: "leaf", claims: [claim("claim-1", "the leaf says this", traceIds.leaf ?? [])] },
      { unitId: APPENDIX, kind: "appendix", claims: [claim("claim-1", "the appendix says this", traceIds.appendix ?? [])] }
    ]
  };
}

const TRACES: readonly TraceRecord[] = [
  {
    id: "T-bound", title: "bound to the document", type: "callflow", status: "verified", confidence: "high",
    documentIds: [DOCUMENT_ID], steps: [{ index: 1, action: "a", evidenceIds: ["S-aaaaaaaaaa"] }], createdAt: "2026-01-01T00:00:00.000Z"
  },
  {
    id: "T-cited", title: "cited by a unit claim", type: "callflow", status: "verified", confidence: "high",
    documentIds: [], steps: [{ index: 1, action: "a", evidenceIds: ["S-aaaaaaaaaa"] }], createdAt: "2026-01-01T00:00:00.000Z"
  },
  {
    id: "T-claim-id-join", title: "reachable only through a step claimId", type: "callflow", status: "verified", confidence: "high",
    documentIds: [], steps: [{ index: 1, action: "a", evidenceIds: ["S-aaaaaaaaaa"], claimIds: ["claim-1"] }], createdAt: "2026-01-01T00:00:00.000Z"
  }
];

test("two units may share a claim id, and the companion keeps two rows", () => {
  const companion = aggregateUnitClaims(aggregation(), unitClaimKey);
  assert.equal(companion.version, UNIT_CLAIMS_COMPANION_VERSION);
  assert.equal(companion.claims.length, 2, "one row for two claims is the 5.8x undercount this key exists to prevent");
  assert.deepEqual(companion.claims.map((row) => row.key), [`${APPENDIX}#claim-1`, `${LEAF}#claim-1`]);
  assert.deepEqual(companion.claims.map((row) => row.unitId), [APPENDIX, LEAF]);
  assert.deepEqual(companion.claims.map((row) => row.claimId), ["claim-1", "claim-1"]);
  assert.deepEqual(companion.claims.map((row) => row.claim.statement), ["the appendix says this", "the leaf says this"]);
  // The per-unit census keeps the plan's order, so a unit with no claim is a visible zero rather than an absence.
  assert.deepEqual(companion.units, [
    { unitId: LEAF, kind: "leaf", claims: 1 },
    { unitId: APPENDIX, kind: "appendix", claims: 1 }
  ]);
});

test("taking the unit out of the key makes the companion fold, and the aggregator refuses instead", () => {
  // The falsification: this is the keyer `assurance-artifacts.ts` measured. Nothing here can silently accept it.
  const claimIdOnly = (identity: { claimId: string }): string => identity.claimId;
  assert.throws(
    () => aggregateUnitClaims(aggregation(), claimIdOnly),
    /both key to "claim-1" in the claims companion of "overview-product"; two claims under one key is one claim wearing two identities/
  );
});

test("a unit that states no claim is still a row, and its document still has a companion", () => {
  const companion = aggregateUnitClaims({ ...aggregation(), units: [{ unitId: LEAF, kind: "leaf", claims: [] }] }, unitClaimKey);
  assert.deepEqual(companion.units, [{ unitId: LEAF, kind: "leaf", claims: 0 }]);
  assert.deepEqual(companion.claims, []);
  assert.equal(companion.documentId, DOCUMENT_ID);
  assert.equal(companion.planCatalogDigest, "d".repeat(64));
});

test("a trace reaches the companion by document binding or by an explicit claim citation, and by nothing else", () => {
  const companion = aggregateUnitTraces({ ...aggregation({ leaf: ["T-cited"] }), traces: TRACES });
  assert.equal(companion.version, UNIT_TRACES_COMPANION_VERSION);
  assert.equal(companion.catalogTraces, 3, "the denominator is the whole catalog, stated beside the subset");
  assert.deepEqual(companion.traces.map((row) => row.traceId), ["T-bound", "T-cited"]);
  assert.deepEqual(companion.traces.map((row) => row.inclusion), [["document-binding"], ["cited-by-unit-claim"]]);
  assert.deepEqual(companion.traces[1]!.citedBy, [{ unitId: LEAF, claimId: "claim-1" }]);
  assert.deepEqual(companion.traces[0]!.citedBy, []);
  // The 57B-458 refusal, as a property: the trace whose ONLY route in is a step `claimIds` match is absent.
  assert.ok(!companion.traces.some((row) => row.traceId === "T-claim-id-join"),
    "a trace step naming claim-1 cannot say which unit's claim-1 it meant, so it may not select a document's traces");
});

test("both reasons on one trace are both recorded, and every citing (unit, claim) is listed", () => {
  const traces: readonly TraceRecord[] = [{ ...TRACES[1]!, documentIds: [DOCUMENT_ID] }];
  const companion = aggregateUnitTraces({ ...aggregation({ leaf: ["T-cited"], appendix: ["T-cited"] }), traces });
  assert.equal(companion.traces.length, 1);
  assert.deepEqual(companion.traces[0]!.inclusion, ["cited-by-unit-claim", "document-binding"]);
  assert.deepEqual(companion.traces[0]!.citedBy, [
    { unitId: APPENDIX, claimId: "claim-1" },
    { unitId: LEAF, claimId: "claim-1" }
  ]);
});

test("a cited trace the catalog does not hold is a named bucket, never an absent trace", () => {
  const companion = aggregateUnitTraces({ ...aggregation({ leaf: ["T-nowhere", "T-cited"] }), traces: TRACES });
  assert.deepEqual(companion.citedTraceIdsNotInCatalog, ["T-nowhere"]);
  assert.deepEqual(companion.traces.map((row) => row.traceId), ["T-bound", "T-cited"]);
  // Reported, not thrown: a dangling citation is a content defect a re-draft fixes, and refusing to assemble over
  // it would make one bad citation unrecoverable.
  assert.deepEqual(aggregateUnitTraces({ ...aggregation(), traces: TRACES }).citedTraceIdsNotInCatalog, []);
});

test("an empty trace catalog produces an empty companion that still names its denominator", () => {
  const companion = aggregateUnitTraces({ ...aggregation(), traces: [] });
  assert.equal(companion.catalogTraces, 0);
  assert.deepEqual(companion.traces, []);
  assert.deepEqual(companion.citedTraceIdsNotInCatalog, []);
  assert.equal(companion.knowledgeEpoch, 2);
});

test("a traceIds that is not a list of ids is refused rather than iterated character by character", () => {
  // `assertValidClaim` never checks this field and `parseUnitClaims` ends in a cast, so a model-written sidecar can
  // hand over a bare string. Iterating it would turn one citation into three one-character ones — and would pull a
  // one-character catalog trace in with a reason nobody wrote.
  const bare = { ...aggregation(), units: [{ unitId: LEAF, kind: "leaf" as const, claims: [{ ...claim("claim-1", "s"), traceIds: "T-cited" as unknown as string[] }] }] };
  assert.throws(
    () => aggregateUnitTraces({ ...bare, traces: TRACES }),
    /records traceIds "T-cited", which is not a list of trace ids; the traces companion keys on those ids and will not key on the characters of a string/
  );
  for (const bad of [[""], ["  "], [42 as unknown as string], [null as unknown as string]]) {
    const rows = { ...aggregation(), units: [{ unitId: LEAF, kind: "leaf" as const, claims: [{ ...claim("claim-1", "s"), traceIds: bad }] }] };
    assert.throws(() => aggregateUnitTraces({ ...rows, traces: TRACES }), /is not a list of trace ids/, JSON.stringify(bad));
  }
});

test("one claim citing a trace twice is one citation, not two", () => {
  const twice = { ...aggregation(), units: [{ unitId: LEAF, kind: "leaf" as const, claims: [{ ...claim("claim-1", "s"), traceIds: ["T-cited", "T-cited"] }] }] };
  const companion = aggregateUnitTraces({ ...twice, traces: TRACES });
  assert.deepEqual(companion.traces.find((row) => row.traceId === "T-cited")!.citedBy, [{ unitId: LEAF, claimId: "claim-1" }]);
});
