// Unit packet readings of the two R0 baselines (57B-434 R4b, narrowed to the owner by R5a, divided by R5b).
//
// `eval/golden/unit-packet-readings-{wcp,cebreo}.json` are produced by
// `npm run eval -- unit-packet-readings --run <dir> --out <file>` against the archival run directories (which are
// NOT in this repository). They are records, not assertions about a run this suite can re-derive — so what is
// asserted here is their INTERNAL consistency plus the one reading this slice exists to produce:
//
//   * 57B-453 IS CLOSED ON THE PACKET SIDE, now under R5a's STRICTER reading: every material obligation in units
//     has every one of its own evidence ids in the packet of the unit that OWNS it — not merely in one of the three
//     units that could reach it. `evidenceAbsent` is 0. The measurement it replaces, on this same baseline and its
//     per-document packets, was 179 of 310 (60.1%) and 409 of 564 (74.5%);
//   * R5a's ownership reading: no material obligation is OWED by more than one unit of one document. Before this
//     slice every wcp document owed the same 847 obligations three times over (847 through its feature leaf, 847
//     through its work-item-dimension leaf, 164 through its coverage leaf) and rendered the evidence in full each
//     time — which is what put one document's four packets at 4,243,714 bytes against a 3,145,728-byte budget;
//   * nothing is dropped to fit: a packet is either inside its declared bound or records the overrun, and the two
//     are mutually exclusive rather than "usually" one of them;
//   * the mechanism-A residue is counted, not silent: `bound + unbound == frozen` for the evidence ledger, with the
//     unbound records broken down by kind (cebreo: the 27 records 57B-453 measured);
//   * gate 1b's four buckets conserve and are READ from the plan, and the open-origin exemption is visible (wcp: 0);
//   * a synthesis unit is NAMED as unrenderable on an archival run, never silently absent from the census;
//   * cebreo's zero-material shape reads as itself: no leaf, an appendix that still renders, and `ledger-absent`
//     and `ledger-empty` kept as two different sentences;
//   * R5b's SAME-SOURCE TRIPWIRE: per unit, the plan's budget pre-check (`precheckBytes`) equals the rendered
//     packet (`packetBytes`) exactly. R4b's pre-check was a PROXY over canonical topic rows and was out by about
//     9x, silently, because nothing put the two numbers next to each other;
//   * R5b's acceptance: zero units over their per-unit input bound (four before, all of them feature leaves), and
//     every document's measured total inside its own document budget — with the division's own overhead in it.
//
// A hand-edited number in either file breaks one of those identities.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AUTHORING_UNIT_KINDS } from "../../src/report/plan-proposal.ts";
import { UNIT_PACKET_FORBIDDEN_INPUT_PREFIXES } from "../../src/report/unit-packet-source.ts";
import { UNIT_PACKET_READINGS_VERSION, type UnitPacketReadings } from "../unit-packet-readings.ts";

const HERE = import.meta.dirname;
const READINGS = ["wcp", "cebreo"].map((target) => ({ target, path: join(HERE, "..", "golden", `unit-packet-readings-${target}.json`) }));

async function readings(path: string): Promise<UnitPacketReadings> {
  return JSON.parse(await readFile(path, "utf8")) as UnitPacketReadings;
}

test("every checked-in unit packet reading is internally consistent", async () => {
  for (const { target, path } of READINGS) {
    const row = await readings(path);
    assert.equal(row.version, UNIT_PACKET_READINGS_VERSION, `${target}: version`);

    // Every planned unit is either rendered or named as unrenderable. No unit is simply absent.
    assert.equal(row.rendered.length + row.notRenderable.length, row.units, `${target}: every unit is accounted for`);
    assert.deepEqual(row.unitsByKind.map((entry) => entry.kind), [...AUTHORING_UNIT_KINDS], `${target}: one row per unit kind`);
    assert.equal(row.unitsByKind.reduce((total, entry) => total + entry.units, 0), row.units, `${target}: the kinds sum to the unit count`);
    for (const entry of row.notRenderable) assert.ok(entry.reason.trim() !== "", `${target}: ${entry.unitId} must say why`);

    for (const unit of row.rendered) {
      assert.equal(unit.renderedTwiceIdentical, true, `${target}: ${unit.unitId} must render the same bytes twice`);
      assert.ok(unit.packetByteLimit > 0, `${target}: ${unit.unitId} declares a bound`);
      // Inside the bound or the overrun is recorded — never both, never neither.
      if (unit.packetBytes <= unit.packetByteLimit) assert.deepEqual(unit.packetLimitations, [], `${target}: ${unit.unitId} fits and records nothing`);
      else {
        assert.equal(unit.packetLimitations.length, 1, `${target}: ${unit.unitId} is over its bound and records exactly one overrun`);
        assert.match(unit.packetLimitations[0]!, /NOTHING has been dropped or shortened/, `${target}: ${unit.unitId}`);
      }
      assert.ok(unit.materialObligations <= unit.obligations, `${target}: ${unit.unitId} material obligations are a subset`);
      assert.ok(unit.openOriginExempt <= unit.reachableMaterial, `${target}: ${unit.unitId} exemptions are a subset of the reach`);
      assert.equal(unit.kind === "synthesis", false, `${target}: a synthesis packet cannot be rendered from an archival run`);
      // THE SAME-SOURCE TRIPWIRE (R5b): the plan's budget pre-check and the packet an author reads are one
      // composition. R4b's proxy was out by about 9x here and nothing compared the two numbers.
      assert.equal(unit.precheckBytes, unit.packetBytes,
        `${target}: ${unit.unitId} - the plan's pre-check must BE the renderer, not an estimate beside it`);
      // R5a/R5b: a unit's reach splits into what it owns, what it stubs and what its scope excludes, with nothing
      // unaccounted for. The third bucket is zero on an undivided plan.
      assert.equal(unit.ownedMaterial + unit.stubObligations + unit.scopeExcludedMaterial, unit.reachableMaterial,
        `${target}: ${unit.unitId} must own, stub or scope out every material obligation it reaches`);
      assert.ok(unit.scopeExcludedMaterial <= unit.scopeExcludedObligations, `${target}: ${unit.unitId}`);
    }

    // Gate 1b's four buckets, READ from the plan and conserving.
    const { obligations } = row;
    assert.equal(obligations.inUnits + obligations.waived + obligations.unplaced + obligations.undispositioned,
      obligations.materialObligations, `${target}: the obligation buckets must conserve`);
    assert.equal(row.inUnitsObligations, obligations.inUnits, `${target}: the closure reading's denominator IS the plan's in-units bucket`);

    // The 57B-453 closure reading, owner-scoped.
    assert.equal(row.evidenceAbsent, row.absentBindings.length, `${target}: every absent binding is listed by id`);
    assert.equal(row.evidenceAbsent, 0, `${target}: every in-unit material obligation's own evidence must reach the packet of the unit that OWNS it`);
    assert.ok(row.ownerEvidenceRequired >= row.evidenceRequired,
      `${target}: the owner-scoped denominator counts one requirement per document that must ground the obligation, so it is never smaller`);

    // R5a's ownership reading: nothing is owed twice, and every unit has a row.
    assert.equal(row.obligationsOwedByMoreThanOneUnit, row.ownership.reduce((total, entry) => total + entry.owedByMoreThanOneUnit, 0),
      `${target}: the run-level duplication count is the sum of the per-document ones`);
    assert.equal(row.obligationsOwedByMoreThanOneUnit, 0, `${target}: no material obligation may be owed by two units of one document`);
    for (const entry of row.ownership) {
      assert.equal(entry.owedByUnit.reduce((total, unit) => total + unit.owed, 0), entry.reachedObligations,
        `${target}: ${entry.documentId} owes every material obligation it reaches exactly once`);
      assert.deepEqual([...entry.unownedObligationIds], [], `${target}: ${entry.documentId} leaves no obligation owned by nobody`);
    }

    // R5b: after the budget refinement no unit is over its own bound, and every document's measured total — the
    // synthesis units' bounded cost included — is inside its own document total.
    assert.equal(row.overBudgetUnits, 0, `${target}: no unit may be over its per-unit input budget after division`);
    assert.equal(row.documents.reduce((total, document) => total + document.units, 0), row.units, `${target}: every unit belongs to a document`);
    for (const document of row.documents) {
      assert.ok(document.measuredBytes <= document.totalInputBytes,
        `${target}: ${document.documentId} reads ${document.measuredBytes} bytes against a ${document.totalInputBytes}-byte total`);
      assert.ok(document.renderedBytes <= document.measuredBytes,
        `${target}: ${document.documentId} - the rendered units are a subset of the measured ones`);
    }
    assert.ok(row.refinementPasses >= 1, `${target}: the refinement always takes at least one measurement pass`);
    for (const division of row.divisions) {
      assert.ok(["facet", "topic", "dimension", "items"].includes(division.level), `${target}: ${division.level} is not a ladder rung`);
      assert.ok(division.partUnitIds.length >= 2, `${target}: a division makes at least two parts, or it is not a division`);
    }

    // Mechanism A: the residue is counted, and it conserves against the frozen set.
    assert.equal(row.boundEvidenceIds + row.unboundEvidenceIds, row.frozenEvidenceIds,
      `${target}: every frozen evidence record is either bound by a work item or counted as unbound`);
    assert.equal(row.unboundEvidenceByKind.reduce((total, entry) => total + entry.records, 0), row.unboundEvidenceIds,
      `${target}: the per-kind census sums to the unbound count`);

    for (const entry of row.namedEmptyFacets) {
      assert.ok(["ledger-absent", "ledger-empty"].includes(entry.state), `${target}: ${entry.state} is not one of the two empty states`);
      assert.ok(entry.reason.trim() !== "", `${target}: the ${entry.facet} facet must say why it is empty`);
    }
    for (const readPath of row.readPaths) {
      for (const prefix of UNIT_PACKET_FORBIDDEN_INPUT_PREFIXES) {
        assert.ok(!readPath.startsWith(prefix), `${target}: ${readPath} is an authoring-side input`);
      }
    }
  }
});

test("the wcp reading closes 57B-453 on the packet side: 0 of 3,580 owner-scoped evidence bindings absent", async () => {
  const row = await readings(READINGS[0]!.path);
  assert.equal(row.obligations.materialObligations, 847);
  assert.equal(row.inUnitsObligations, 847);
  // 895 distinct (obligation, evidence) pairs, and 3,580 of them once per document that must ground the obligation:
  // four documents reach all 847, so the author-facing requirement is four times the run-level one.
  assert.equal(row.evidenceRequired, 895);
  assert.equal(row.ownerEvidenceRequired, 3580);
  assert.equal(row.evidenceAbsent, 0);
  assert.deepEqual(row.absentBindings, []);

  // R5a survives R5b's division verbatim: one owner per obligation per document, now spread across the scoped
  // parts. Before ownership each document owed all 847 through its feature leaf AND its work-item-dimension leaf,
  // and 164 of them through its coverage leaf as well — 3,388 duplicated owed instances across the four documents.
  assert.equal(row.obligationsOwedByMoreThanOneUnit, 0);
  assert.equal(row.ownership.length, 4);
  for (const entry of row.ownership) {
    assert.equal(entry.reachedObligations, 847, entry.documentId);
    assert.deepEqual(entry.owedByUnit.filter((unit) => unit.owed > 0).map((unit) => unit.owed).sort((a, b) => a - b),
      [24, 24, 254, 271, 274], entry.documentId);
    assert.equal(entry.owedByUnit.reduce((total, unit) => total + unit.owed, 0), 847,
      `${entry.documentId}: the scoped parts owe between them exactly what the undivided feature leaf owed`);
  }
  // The other two leaves still SEE all of it and say whose it is: uncapped stub rows, no evidence body.
  const stubs = new Map(row.rendered.map((unit) => [unit.unitId, unit.stubObligations]));
  for (const entry of row.ownership) {
    assert.equal(stubs.get(`${entry.documentId}::leaf::work-item-dimension`), 847);
    assert.equal(stubs.get(`${entry.documentId}::leaf::coverage`), 164);
  }

  // The open-origin bucket: latent on this baseline, and visible as a zero rather than absent.
  assert.deepEqual(row.openOriginExemptObligations, []);
  for (const unit of row.rendered) assert.equal(unit.openOriginExempt, 0);

  // 40 units, 36 rendered, the 4 synthesis roots named. Twenty units before the division; the four feature leaves
  // became six parts each.
  assert.equal(row.units, 40);
  assert.equal(row.rendered.length, 36);
  assert.equal(row.refinementPasses, 5);
  assert.equal(row.divisions.length, 20);
  assert.deepEqual(row.notRenderable.map((entry) => entry.unitId).sort(), [
    "feature-晋升管理-01e5065d19-engineering::synthesis::document",
    "feature-请假管理-8c2d685d81-product::synthesis::document",
    "overview-engineering::synthesis::document",
    "overview-product::synthesis::document"
  ]);

  // THE R5b RESIDUAL IS CLOSED. R5a left four over-budget units (the FEATURE leaves, 1,993,296-1,993,499 bytes
  // each against a 786,432-byte bound) because the plan validated a PROXY — the canonical bytes of a unit's topic
  // rows, which do not include the evidence an author reads, and which was out by about 9x. Under the true measure
  // the division brings that residual to zero, and nothing was truncated to do it.
  const overBudget = row.rendered.filter((unit) => unit.packetLimitations.length === 1);
  assert.deepEqual(overBudget.map((unit) => unit.unitId), [], "zero over-budget units, down from four");
  assert.equal(row.overBudgetUnits, 0);
  for (const unit of row.rendered) assert.equal(unit.packetByteLimit, 786_432);

  // And the document-level sum, which is what made ownership the prerequisite of R5b's budget truth: the four
  // packets of one document were 4,243,714 bytes against `standard`'s 3,145,728-byte document total before R5a
  // deduplicated them to 2,439,928, and division cannot change a sum. Division DOES add overhead — a per-part
  // header, and an evidence record two parts both bind is rendered in both — and this is the measured size of it.
  assert.equal(row.documents.length, 4);
  for (const document of row.documents) {
    assert.ok(document.measuredBytes <= 3_145_728, `${document.documentId}: ${document.measuredBytes} bytes must fit the standard document total`);
    assert.ok(document.measuredBytes > 3_000_000, `${document.documentId}: ${document.measuredBytes} bytes — the margin is 3.5%, and a suspiciously small total would mean rows went missing`);
  }

  // Mechanism A on this baseline: 931 of 1,884 frozen records are bound by no work item — including the manifest,
  // README, scope and provider rows a coverage section is required to report.
  assert.equal(row.frozenEvidenceIds, 1884);
  assert.equal(row.boundEvidenceIds, 953);
  assert.equal(row.unboundEvidenceIds, 931);
  const byKind = new Map(row.unboundEvidenceByKind.map((entry) => [entry.kind, entry.records]));
  assert.deepEqual([byKind.get("manifest"), byKind.get("readme"), byKind.get("provider"), byKind.get("scope")], [11, 3, 1, 1]);
});

test("the cebreo reading is the zero-material shape: no leaf, an appendix that renders, 27 unbound records", async () => {
  const row = await readings(READINGS[1]!.path);
  assert.equal(row.obligations.materialObligations, 0);
  assert.equal(row.inUnitsObligations, 0);
  assert.equal(row.evidenceRequired, 0);
  assert.equal(row.evidenceAbsent, 0);
  assert.deepEqual(row.unitsByKind, [
    { kind: "appendix", units: 1 },
    { kind: "bridge", units: 0 },
    { kind: "leaf", units: 0 },
    { kind: "synthesis", units: 1 }
  ]);
  assert.equal(row.rendered.length, 1);
  // The second shape: nothing is over budget, so the division never fires and the pre-check is an identity.
  assert.equal(row.refinementPasses, 1);
  assert.deepEqual([...row.divisions], []);
  assert.equal(row.overBudgetUnits, 0);
  const appendix = row.rendered[0]!;
  assert.equal(appendix.kind, "appendix");
  assert.equal(appendix.precheckBytes, appendix.packetBytes, "the pre-check is an identity where no division is needed");
  assert.equal(appendix.scopeExcludedObligations, 0, "an undivided plan excludes nothing by scope");
  assert.equal(appendix.reachableMaterial, 0, "nothing material is reachable, which is `vacuous` and not `complete`");
  assert.equal(appendix.ownedMaterial, 0);
  assert.equal(appendix.stubObligations, 0, "there is nothing to stub either: ownership is vacuous on the empty set");
  assert.deepEqual(appendix.packetLimitations, [], "the zero-material appendix fits its bound with room to spare");
  assert.deepEqual(row.ownership, [{
    documentId: "overview-product",
    reachedObligations: 0,
    owedByUnit: [
      { unitId: "overview-product::appendix::coverage", owed: 0 },
      { unitId: "overview-product::synthesis::document", owed: 0 }
    ],
    owedByMoreThanOneUnit: 0,
    unownedObligationIds: []
  }]);

  // The 27 records 57B-453 measured as never reaching a packet. They are now enumerated by the deterministic tail.
  assert.equal(row.frozenEvidenceIds, 62);
  assert.equal(row.boundEvidenceIds, 35);
  assert.equal(row.unboundEvidenceIds, 27);
  const byKind = new Map(row.unboundEvidenceByKind.map((entry) => [entry.kind, entry.records]));
  assert.deepEqual([byKind.get("manifest"), byKind.get("readme"), byKind.get("provider"), byKind.get("scope")], [13, 1, 1, 1]);

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
