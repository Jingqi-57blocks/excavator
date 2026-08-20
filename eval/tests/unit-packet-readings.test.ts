// Unit packet readings of the two R0 baselines (57B-434 R4b, narrowed to the owner by R5a).
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
//     and `ledger-empty` kept as two different sentences.
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
      // R5a: a unit's reach splits into what it owns and what it stubs, with nothing unaccounted for.
      assert.equal(unit.ownedMaterial + unit.stubObligations, unit.reachableMaterial,
        `${target}: ${unit.unitId} must own or stub every material obligation it reaches`);
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

  // R5a: one owner per obligation per document. Before this slice each document owed all 847 through its feature
  // leaf AND its work-item-dimension leaf, and 164 of them through its coverage leaf as well — 847 obligations owed
  // by more than one unit, per document, 3,388 across the four.
  assert.equal(row.obligationsOwedByMoreThanOneUnit, 0);
  assert.equal(row.ownership.length, 4);
  for (const entry of row.ownership) {
    assert.equal(entry.reachedObligations, 847, entry.documentId);
    assert.deepEqual(entry.owedByUnit.filter((unit) => unit.owed > 0).map((unit) => [unit.unitId, unit.owed]),
      [[`${entry.documentId}::leaf::feature`, 847]], entry.documentId);
  }
  // The other two leaves still SEE all of it and say whose it is: uncapped stub rows, no evidence body.
  const stubs = new Map(row.rendered.map((unit) => [unit.unitId, unit.stubObligations]));
  for (const entry of row.ownership) {
    assert.equal(stubs.get(`${entry.documentId}::leaf::feature`), 0);
    assert.equal(stubs.get(`${entry.documentId}::leaf::work-item-dimension`), 847);
    assert.equal(stubs.get(`${entry.documentId}::leaf::coverage`), 164);
  }

  // The open-origin bucket: latent on this baseline, and visible as a zero rather than absent.
  assert.deepEqual(row.openOriginExemptObligations, []);
  for (const unit of row.rendered) assert.equal(unit.openOriginExempt, 0);

  // 20 units, 16 rendered, the 4 synthesis roots named.
  assert.equal(row.units, 20);
  assert.equal(row.rendered.length, 16);
  assert.deepEqual(row.notRenderable.map((entry) => entry.unitId).sort(), [
    "feature-晋升管理-01e5065d19-engineering::synthesis::document",
    "feature-请假管理-8c2d685d81-product::synthesis::document",
    "overview-engineering::synthesis::document",
    "overview-product::synthesis::document"
  ]);

  // The measured cost of carrying the whole binding, after deduplication: only the four FEATURE leaves are still
  // over the plan's per-unit input allowance, down from eight (the four work-item-dimension leaves fell back inside
  // their bound once they stopped re-rendering the owner's evidence). That residual is the number R5b's budget
  // system has to answer for — the plan validated `unitInputBytes` over topic ROWS, which does not include the
  // evidence an author actually reads — and it is a per-unit overrun, not a document-level one any more.
  const overBudget = row.rendered.filter((unit) => unit.packetLimitations.length === 1);
  assert.equal(overBudget.length, 4);
  for (const unit of overBudget) assert.ok(unit.unitId.endsWith("::leaf::feature"), unit.unitId);
  for (const unit of row.rendered) assert.equal(unit.packetByteLimit, 786_432);

  // And the document-level sum, which is what made ownership the prerequisite of R5b's budget truth: the four
  // packets of one document were 4,243,714 bytes against `standard`'s 3,145,728-byte document total, and splitting
  // cannot change a sum. Deduplicated, every document is inside it.
  const perDocument = new Map<string, number>();
  for (const unit of row.rendered) perDocument.set(unit.documentId, (perDocument.get(unit.documentId) ?? 0) + unit.packetBytes);
  assert.equal(perDocument.size, 4);
  for (const [documentId, bytes] of perDocument) {
    assert.ok(bytes < 3_145_728, `${documentId}: ${bytes} bytes of packets must fit the standard document total`);
    assert.ok(bytes > 2_000_000, `${documentId}: ${bytes} bytes — a suspiciously small total would mean rows went missing`);
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
  const appendix = row.rendered[0]!;
  assert.equal(appendix.kind, "appendix");
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
