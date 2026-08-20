// Unit packet readings of the two R0 baselines (57B-434 R4b).
//
// `eval/golden/unit-packet-readings-{wcp,cebreo}.json` are produced by
// `npm run eval -- unit-packet-readings --run <dir> --out <file>` against the archival run directories (which are
// NOT in this repository). They are records, not assertions about a run this suite can re-derive — so what is
// asserted here is their INTERNAL consistency plus the one reading this slice exists to produce:
//
//   * 57B-453 IS CLOSED ON THE PACKET SIDE: every material obligation in units has every one of its own evidence
//     ids in the packet of a unit that names one of its binding topics. `evidenceAbsent` is 0. The measurement it
//     replaces, on this same baseline and its per-document packets, was 179 of 310 (60.1%) and 409 of 564 (74.5%);
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
    }

    // Gate 1b's four buckets, READ from the plan and conserving.
    const { obligations } = row;
    assert.equal(obligations.inUnits + obligations.waived + obligations.unplaced + obligations.undispositioned,
      obligations.materialObligations, `${target}: the obligation buckets must conserve`);
    assert.equal(row.inUnitsObligations, obligations.inUnits, `${target}: the closure reading's denominator IS the plan's in-units bucket`);

    // The 57B-453 closure reading.
    assert.equal(row.evidenceAbsent, row.absentBindings.length, `${target}: every absent binding is listed by id`);
    assert.equal(row.evidenceAbsent, 0, `${target}: every in-unit material obligation's own evidence must reach a packet that names it`);

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

test("the wcp reading closes 57B-453 on the packet side: 0 of 895 required evidence bindings absent", async () => {
  const row = await readings(READINGS[0]!.path);
  assert.equal(row.obligations.materialObligations, 847);
  assert.equal(row.inUnitsObligations, 847);
  assert.equal(row.evidenceRequired, 895);
  assert.equal(row.evidenceAbsent, 0);
  assert.deepEqual(row.absentBindings, []);

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

  // The measured cost of carrying the whole binding: the two biggest leaf kinds are over the plan's per-unit input
  // allowance, and say so instead of dropping a row. This is the number R5's budget system has to answer for — the
  // plan validated `unitInputBytes` over topic ROWS, which does not include the evidence an author actually reads.
  const overBudget = row.rendered.filter((unit) => unit.packetLimitations.length === 1);
  assert.equal(overBudget.length, 8);
  for (const unit of overBudget) assert.ok(unit.unitId.endsWith("::leaf::feature") || unit.unitId.endsWith("::leaf::work-item-dimension"), unit.unitId);
  for (const unit of row.rendered) assert.equal(unit.packetByteLimit, 786_432);

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
  assert.deepEqual(appendix.packetLimitations, [], "the zero-material appendix fits its bound with room to spare");

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
