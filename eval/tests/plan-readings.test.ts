// Plan readings of the two R0 baselines (57B-434 R3).
//
// `eval/golden/plan-readings-{wcp,cebreo}.json` are produced by
// `npm run eval -- plan-readings --run <dir> --out <file>` against the archival run directories (which are NOT in
// this repository). They are records, not assertions about a run this suite can re-derive — so what is asserted
// here is their INTERNAL consistency plus the readings this slice exists to produce:
//
//   * gate 1b conserves: material obligations = in units + waived + unplaced + undispositioned, with no residue,
//     and every count has its id list beside it;
//   * the packet fits its declared bound, or says by name that it did not — never silently;
//   * the three bucket definitions are in the packet VERBATIM, including the sentence that says `unobligated` is a
//     missing join rather than an unreachable subject (wcp: 1,434 route topics);
//   * every verdict is one of the three states, and cebreo's empty denominators read `vacuous`, never `complete`;
//   * the fixture plan mints no leaf for a facet with no material topic — it does not forge cebreo's absent
//     features into units;
//   * and R5a's ownership: every material obligation a document reaches is owned by exactly one of its units, every
//     unit has a row (a zero is visible), and nothing is owned by nobody.
//
// A hand-edited number in either file breaks one of those identities.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AUTHORING_UNIT_KINDS } from "../../src/report/plan-proposal.ts";
import { WAIVING_DISPOSITION_STATES } from "../../src/report/plan-obligation-conservation.ts";
import { MATERIALITY_BUCKET_DEFINITIONS } from "../../src/report/planner-packet.ts";
import { FORBIDDEN_INPUT_PREFIXES } from "../../src/report/topic-catalog-source.ts";
import { TOPIC_FACETS } from "../../src/report/topic-candidate.ts";
import { PLAN_READINGS_VERSION, type PlanReadings } from "../plan-readings.ts";

const HERE = import.meta.dirname;
const READINGS = ["wcp", "cebreo"].map((target) => ({ target, path: join(HERE, "..", "golden", `plan-readings-${target}.json`) }));

async function readings(path: string): Promise<PlanReadings> {
  return JSON.parse(await readFile(path, "utf8")) as PlanReadings;
}

test("every checked-in plan reading is internally consistent", async () => {
  for (const { target, path } of READINGS) {
    const row = await readings(path);
    assert.equal(row.version, PLAN_READINGS_VERSION, `${target}: version`);

    // Gate 1b: the four buckets are exhaustive over the material obligation denominator.
    const { obligations } = row;
    assert.equal(
      obligations.inUnits + obligations.waived + obligations.unplaced + obligations.undispositioned,
      obligations.materialObligations,
      `${target}: the obligation buckets must conserve, with no unexplained residue`
    );
    assert.equal(obligations.waivedObligations.length, obligations.waived, `${target}: every waived obligation is listed by id`);
    assert.equal(obligations.unplacedObligations.length, obligations.unplaced, `${target}: every unplaced obligation is listed by id`);
    assert.equal(obligations.undispositionedObligations.length, obligations.undispositioned, `${target}: every undispositioned obligation is listed by id`);
    assert.deepEqual(obligations.waivedByState.map((entry) => entry.state), [...WAIVING_DISPOSITION_STATES], `${target}: one row per waiving state, always`);
    assert.equal(obligations.waivedByState.reduce((total, entry) => total + entry.obligations, 0), obligations.waived,
      `${target}: the per-state census must sum to the waived count`);

    // The packet's bound: fits, or says so.
    assert.ok(row.packetByteLimit > 0, `${target}: the packet declares a bound`);
    if (row.packetBytes <= row.packetByteLimit) assert.deepEqual(row.packetLimitations, [], `${target}: a packet within its bound records no limitation`);
    else assert.equal(row.packetLimitations.length, 1, `${target}: a packet over its bound records the overrun rather than truncating`);

    // The bucket definitions, verbatim, all three.
    assert.deepEqual([...row.bucketDefinitions], [...MATERIALITY_BUCKET_DEFINITIONS], `${target}: the three bucket definitions must be rendered verbatim`);

    // Verdicts: one row per facet, in order, each one of the three states.
    assert.deepEqual(row.facetVerdicts.map((entry) => entry.facet), [...TOPIC_FACETS], `${target}: one verdict row per facet, in order`);
    for (const entry of [...row.facetVerdicts.map((facet) => facet.verdict), row.overallVerdict]) {
      assert.match(entry, /^(complete|vacuous|violations): /, `${target}: every verdict is one of the three states`);
    }

    // Units and documents.
    assert.deepEqual(row.unitsByKind.map((entry) => entry.kind), [...AUTHORING_UNIT_KINDS], `${target}: one row per unit kind`);
    assert.equal(row.unitsByKind.reduce((total, entry) => total + entry.units, 0), row.units, `${target}: the kinds must sum to the unit count`);
    assert.equal(row.documents.reduce((total, document) => total + document.units, 0), row.units, `${target}: the documents must hold every unit`);
    for (const document of row.documents) {
      assert.ok(document.inputBytes <= document.totalInputBytes, `${target}: ${document.documentId} must fit its document budget`);
      assert.ok(document.rootUnitId.endsWith("::synthesis::document"), `${target}: ${document.documentId} assembles from one synthesis root`);
      assert.ok(document.units >= 2, `${target}: a document has at least an appendix and a root`);
    }

    // R5b: every unit's MEASURED packet fits its per-unit bound, and the ladder's work is recorded.
    assert.deepEqual([...row.overBudgetUnitIds], [], `${target}: after the budget refinement no unit is over its own bound`);
    assert.equal(row.unitBytes.length, row.units, `${target}: every unit is measured, none skipped`);
    for (const unit of row.unitBytes) {
      assert.ok(["rendered", "bounded"].includes(unit.costState), `${target}: ${unit.unitId} cost state ${unit.costState}`);
      assert.equal(unit.overBy, 0, `${target}: ${unit.unitId} is ${unit.bytes} bytes against a ${unit.byteLimit}-byte bound`);
      assert.ok(unit.bytes <= unit.byteLimit, `${target}: ${unit.unitId}`);
    }
    assert.equal(row.unitBytes.reduce((total, unit) => total + unit.bytes, 0),
      row.documents.reduce((total, document) => total + document.inputBytes, 0),
      `${target}: the per-document measured bytes are the per-unit ones, summed`);
    assert.ok(row.refinementPasses >= 1, `${target}: the refinement always takes at least one measurement pass`);
    for (const division of row.divisions) {
      assert.ok(["facet", "topic", "dimension", "items"].includes(division.level), `${target}: ${division.level} is not a ladder rung`);
      assert.ok(division.partUnitIds.length >= 2, `${target}: a division makes at least two parts, or it is not a division`);
      assert.ok(division.measuredBytes > division.byteLimit, `${target}: only an over-budget unit is divided`);
    }

    // R5a's ownership, per document: the counts conserve and no obligation is left owner-less.
    assert.deepEqual(row.ownership.map((entry) => entry.documentId), row.documents.map((document) => document.documentId),
      `${target}: one ownership row per document, in the same order`);
    for (const entry of row.ownership) {
      const owned = entry.ownedByUnit.reduce((total, unit) => total + unit.owned, 0);
      assert.equal(owned + entry.unownedObligationIds.length, entry.reachedObligations,
        `${target}: ${entry.documentId} must account for every material obligation its units reach`);
      assert.deepEqual([...entry.unownedObligationIds], [], `${target}: ${entry.documentId} leaves no obligation owned by nobody`);
      assert.equal(entry.ownedByUnit.length, row.documents.find((document) => document.documentId === entry.documentId)!.units,
        `${target}: ${entry.documentId} has one ownership row per unit, so a unit owning nothing is a visible zero`);
      for (const unit of entry.ownedByUnit) {
        assert.ok(["owning", "referencing", "topic-free"].includes(unit.role), `${target}: ${unit.unitId} role ${unit.role}`);
        if (unit.role !== "owning") assert.equal(unit.owned, 0, `${target}: only an owning unit may own an obligation (${unit.unitId})`);
      }
    }

    for (const entry of row.namedEmptyFacets) {
      assert.ok(entry.reason.trim() !== "", `${target}: the ${entry.facet} facet is ${entry.state} and must say why`);
      assert.ok(["ledger-absent", "ledger-empty"].includes(entry.state), `${target}: ${entry.state} is not one of the two empty states`);
    }
    for (const readPath of row.readPaths) {
      for (const prefix of FORBIDDEN_INPUT_PREFIXES) {
        assert.ok(!readPath.startsWith(prefix), `${target}: ${readPath} is an authoring-side input`);
      }
    }
  }
});

test("the wcp reading records 847 material obligations, all of them in units, and the 1,434 unobligated routes", async () => {
  const row = await readings(READINGS[0]!.path);
  // The epic's two denominators, side by side: 7 topic-granular rows carry 847 obligation-granular ones. Reading
  // the 7 green rows as "847 obligations handled" is exactly what splitting gate 1 into 1a and 1b forbids.
  assert.equal(row.materialTopics, 7);
  assert.equal(row.obligations.materialObligations, 847);
  assert.equal(row.obligations.inUnits, 847);
  assert.equal(row.obligations.waived, 0);
  assert.deepEqual(row.obligations.waivedObligations, [], "the tripwire list is empty on a plan that waives nothing");
  assert.equal(row.overallVerdict, "complete: all 7 material topic(s) carry a disposition");
  assert.match(row.obligationSummary, /^847 material obligation\(s\): 847 in units, 0 waived \(cannot-determine=0, not-applicable=0, omitted-for-audience=0\), 0 claimed but unplaced, 0 undispositioned$/);

  // The route facet: 1,434 topics no obligation binds to, with the definition that says what that means.
  assert.equal(row.routeFacetUnobligated, 1434);
  assert.ok(row.bucketDefinitions.some((definition) => definition.includes("nobody computes the join between the route ledger and the obligation ledger")));
  assert.ok(row.bucketDefinitions.some((definition) => definition.includes("`route-handler` and `recovered-route-handler`")));

  // The entity facet's absence, in the producer's own words.
  const entity = row.namedEmptyFacets.find((entry) => entry.facet === "entity")!;
  assert.equal(entity.state, "ledger-absent");
  assert.match(entity.reason, /facts\/producers\/db-schema\.json records status unavailable: policy: not-run-scoped/);

  // Four documents, and the packet fits its bound with room to spare — the measured number the bound was set from.
  assert.equal(row.documents.length, 4);
  assert.equal(row.packetBytes, 394778);
  assert.equal(row.packetByteLimit, 524288);
  assert.deepEqual(row.packetLimitations, []);
  // R5b: the four feature leaves were each divided into six parts, so 12 leaves became 32 and 20 units became 40.
  assert.deepEqual(row.unitsByKind, [
    { kind: "appendix", units: 4 },
    { kind: "bridge", units: 0 },
    { kind: "leaf", units: 32 },
    { kind: "synthesis", units: 4 }
  ]);
  assert.equal(row.units, 40);
  assert.equal(row.refinementPasses, 5, "four rounds of division and a fifth pass that found nothing left over budget");
  assert.equal(row.divisions.length, 20, "five divisions per document, four documents");

  // The ladder, on a real corpus: every rung above `facet` fires, and `facet` does not — the feature leaf names one
  // facet, so there is nothing to divide there, and the epic's sketch of "flow/state branch" and "entity cluster"
  // has no structure in this catalog to correspond to. `items` is the floor above a single obligation.
  const levels = new Map<string, number>();
  for (const division of row.divisions) levels.set(division.level, (levels.get(division.level) ?? 0) + 1);
  assert.deepEqual([...levels.entries()].sort(), [["dimension", 12], ["items", 4], ["topic", 4]]);

  // Every unit is inside its own bound after the division, and each document's measured total is inside its own.
  assert.deepEqual([...row.overBudgetUnitIds], [], "the residual R5a left at four over-budget feature leaves is zero");
  for (const document of row.documents) {
    assert.equal(document.units, 10);
    assert.ok(document.inputBytes > 3_000_000 && document.inputBytes <= 3_145_728,
      `${document.documentId}: ${document.inputBytes} measured bytes against the standard 3,145,728-byte document total`);
  }

  // R5a's ownership survives the division verbatim: 847 obligations per document, owned exactly once, now spread
  // across the five feature parts that hold material obligations rather than concentrated in one leaf.
  assert.equal(row.ownership.length, 4);
  for (const entry of row.ownership) {
    assert.equal(entry.reachedObligations, 847, entry.documentId);
    assert.deepEqual(entry.ownedByUnit.filter((unit) => unit.owned > 0).map((unit) => unit.owned).sort((a, b) => a - b),
      [24, 24, 254, 271, 274], entry.documentId);
    assert.equal(entry.ownedByUnit.filter((unit) => unit.owned > 0).reduce((total, unit) => total + unit.owned, 0), 847,
      `${entry.documentId}: the scoped parts own between them exactly what the undivided leaf owned`);
    assert.equal(entry.ownedByUnit.length, 10, `${entry.documentId}: eight leaves, an appendix and the synthesis root`);
  }
});

test("the cebreo reading is the zero-feature shape: vacuous, no forged feature unit, both empty states visible", async () => {
  const row = await readings(READINGS[1]!.path);
  assert.equal(row.materialTopics, 0);
  assert.equal(row.obligations.materialObligations, 0);
  assert.match(row.overallVerdict, /^vacuous: the material-topic denominator is empty, so nothing was checked — /);
  assert.ok(!row.overallVerdict.startsWith("complete"));
  for (const entry of row.facetVerdicts) assert.match(entry.verdict, /^vacuous: /, `${entry.facet} must be vacuous, never complete`);

  // The fixture plan mints no leaf at all here: there is no material topic to write from, and it does not invent
  // a feature the run does not have. What it does mint is the deterministic appendix — gate 10's path.
  assert.deepEqual(row.unitsByKind, [
    { kind: "appendix", units: 1 },
    { kind: "bridge", units: 0 },
    { kind: "leaf", units: 0 },
    { kind: "synthesis", units: 1 }
  ]);
  assert.equal(row.documents.length, 1);
  assert.equal(row.documents[0]!.units, 2);
  // R5b's second-shape check: nothing here is over budget, so the division never fires and the pre-check is an
  // identity. One measurement pass, no division, the appendix far inside its bound.
  assert.equal(row.refinementPasses, 1);
  assert.deepEqual([...row.divisions], []);
  assert.deepEqual([...row.overBudgetUnitIds], []);

  // Ownership on the zero-material arm: reachable is empty, so every unit owns zero — and the row exists, which is
  // the difference between "nothing was material" and "nobody asked".
  assert.deepEqual(row.ownership, [{
    documentId: "overview-product",
    reachedObligations: 0,
    ownedByUnit: [
      { unitId: "overview-product::appendix::coverage", kind: "appendix", role: "owning", owned: 0 },
      { unitId: "overview-product::synthesis::document", kind: "synthesis", role: "topic-free", owned: 0 }
    ],
    unownedObligationIds: []
  }]);

  // `ledger-absent` and `ledger-empty` are two different sentences, and this run has both.
  const states = new Set(row.namedEmptyFacets.map((entry) => entry.state));
  assert.deepEqual([...states].sort(), ["ledger-absent", "ledger-empty"]);
  const feature = row.namedEmptyFacets.find((entry) => entry.facet === "feature")!;
  assert.equal(feature.state, "ledger-empty");
  assert.match(feature.reason, /contract\/run-intent\.json binds no feature to this run/);
  const route = row.namedEmptyFacets.find((entry) => entry.facet === "route")!;
  assert.equal(route.state, "ledger-absent");
  assert.match(route.reason, /facts\/producers\/codegraph\.json records status unavailable: index-not-present/);
});
