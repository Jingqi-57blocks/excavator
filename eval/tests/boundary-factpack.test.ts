import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { boundaryRecall, derivationDrops, factPackItemsToNodes, type BoundaryReport } from "../boundary.ts";
import { loadBoundaryGold } from "../boundary-gold.ts";
import { loadFactpackFixture, fixtureFgNodes, fixtureFactPackNodes } from "../factpack-fixture.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const LEAVE_FX = join(FIXTURES, "wcp-leave", "factpack-fg.json.gz");
const LEAVE_GOLD = join(FIXTURES, "wcp-leave", "boundary-gold.json");
const PROMO_FX = join(FIXTURES, "wcp-promotion", "factpack-fg.json.gz");
const PROMO_GOLD = join(FIXTURES, "wcp-promotion", "boundary-gold.json");

function layers(fxFile: string, goldFile: string): { fg: BoundaryReport; factpack: BoundaryReport } {
  const fx = loadFactpackFixture(fxFile);
  const gold = loadBoundaryGold(goldFile);
  return { fg: boundaryRecall(fixtureFgNodes(fx), gold), factpack: boundaryRecall(fixtureFactPackNodes(fx), gold) };
}

const mustFindMissing = (r: BoundaryReport) => r.missing.filter((m) => m.mustFind).map((m) => m.id).sort();
const mustFindFound = (r: BoundaryReport) => r.found.filter((f) => f.mustFind).map((f) => f.id).sort();
const mustFindDrops = (fg: BoundaryReport, factpack: BoundaryReport) =>
  derivationDrops(fg, factpack).filter((d) => d.mustFind).map((d) => d.id).sort();

// ============================================================================
// PINNED RED (57B-372 PR-1). These tests encode CURRENT reality as a regression
// fact: the fact pack the author reads DROPS material business/decision functions
// that the FG node set (the layer 57B-370 measured) already holds. The `expected`
// arrays below are the SINGLE PLACE PR-2 flips: once the `logic` fact-pack category
// lands and rescues these symbols, move the ids from the "missing" arrays to the
// "found" arrays (leave) / assert them found (promotion).
// ============================================================================

// The 11 leave mustFinds the fact pack drops today: 3 T1 (rescued into the FG by 57B-371)
// + 8 T2 named handler methods/functions. Only the 2 route entrypoints survive.
const LEAVE_FACTPACK_DROPPED = [
  "T1-calculationAuto",
  "T1-isIgnoreHolidayLvType",
  "T1-syncLvCompleted",
  "T2-js-leaveRequestPreCheck",
  "T2-js-recordTakeLeaveHours",
  "T2-leave-approve",
  "T2-leave-creation",
  "T2-leave-export",
  "T2-leave-maxAvailableHoliday",
  "T2-leaveHistory-getHolidayHour",
  "T2-leaveHistory-updateHolidayHour"
];
const LEAVE_FACTPACK_SURVIVING = ["T2-handlers-leaveRoute", "T2-js-getMyLeaves"];

test("PINNED RED: leave FG layer is GREEN (13/13) — the false-positive gate 57B-370 measured", () => {
  const { fg } = layers(LEAVE_FX, LEAVE_GOLD);
  // 57B-371 rescued the 3 T1 misses into the FG node set, so the upstream metric now passes:
  // a gate that would greenlight the run even though the author never sees the dropped symbols.
  assert.equal(fg.summary.mustFind, 13);
  assert.equal(fg.summary.mustFindMissing, 0);
  assert.equal(fg.summary.pass, true);
});

test("PINNED RED: leave fact-pack layer is RED — 11 of 13 mustFind business functions dropped", () => {
  const { factpack } = layers(LEAVE_FX, LEAVE_GOLD);
  assert.equal(factpack.summary.pass, false);
  assert.equal(factpack.layer === undefined, true); // bare boundaryRecall does not stamp a layer
  assert.deepEqual(mustFindMissing(factpack), LEAVE_FACTPACK_DROPPED);
  assert.deepEqual(mustFindFound(factpack), LEAVE_FACTPACK_SURVIVING);
});

test("PINNED RED: leave derivation-drop view surfaces exactly the 11 found@fg ∧ missing@factpack mustFinds", () => {
  const { fg, factpack } = layers(LEAVE_FX, LEAVE_GOLD);
  assert.deepEqual(mustFindDrops(fg, factpack), LEAVE_FACTPACK_DROPPED);
});

// Promotion: all 4 mustFinds dropped at the fact pack. Of those, Info + PromotionForward
// are derivation drops (found@fg), while IsManager + IsLeader are additionally an upstream
// FG gap for this run (missing at BOTH layers) — the metric keeps the two classes distinct.
const PROMO_FACTPACK_DROPPED = ["auth-isLeader", "auth-isManager", "record-info", "record-promotionForward"];
const PROMO_DERIVATION_DROPS = ["record-info", "record-promotionForward"];

test("PINNED RED: promotion fact-pack layer drops all 4 mustFind auth/record symbols", () => {
  const { factpack } = layers(PROMO_FX, PROMO_GOLD);
  assert.equal(factpack.summary.pass, false);
  assert.equal(factpack.summary.mustFindFound, 0);
  assert.deepEqual(mustFindMissing(factpack), PROMO_FACTPACK_DROPPED);
});

test("PINNED RED: promotion derivation drops are Info + PromotionForward; IsManager/IsLeader are an upstream FG gap", () => {
  const { fg, factpack } = layers(PROMO_FX, PROMO_GOLD);
  // Only the two record methods were in the FG and then dropped by fact-pack derivation.
  assert.deepEqual(mustFindDrops(fg, factpack), PROMO_DERIVATION_DROPS);
  // IsManager/IsLeader never reached the FG for this run: missing at both layers, so NOT derivation drops.
  assert.deepEqual(mustFindMissing(fg), ["auth-isLeader", "auth-isManager"]);
});

// ---- fixture integrity: the committed fixtures are the real runs' snapshots ----

test("committed fixtures carry the real runs' FG + fact-pack snapshots with provenance", () => {
  const leave = loadFactpackFixture(LEAVE_FX);
  assert.equal(leave.featureKey, "请假-04b7219a9d");
  assert.equal(leave.nodes.length, 250);
  assert.equal(leave.claimedItems.length, 419);
  assert.match(leave._meta.command, /factpack-fixture\.ts/);
  assert.match(leave._meta.sourceRunDir, /run-2026_08_12_00_50-/);
  // The rescued flag from 57B-371 is preserved so the fg-layer story stays legible in the fixture.
  assert.equal(leave.nodes.some((n) => n.name === "CalculationAuto" && typeof n.rescued === "string"), true);

  const promo = loadFactpackFixture(PROMO_FX);
  assert.equal(promo.featureKey, "转正-070e0d15a9");
  assert.equal(promo.nodes.length, 250);
  assert.match(promo._meta.sourceRunDir, /run-2026_08_12_00_55-/);
});

test("factPackItemsToNodes maps line->startLine, endLine falls back to line, and dedupes", () => {
  const nodes = factPackItemsToNodes([
    { category: "entrypoints", name: "F", filePath: "m/a.go", line: 10, endLine: 20 },
    { category: "states", name: "G", filePath: "m/b.go", line: 5 }, // no endLine -> falls back to line
    { category: "entrypoints", name: "F", filePath: "m/a.go", line: 10, endLine: 20 } // exact dup -> dropped
  ]);
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0], { filePath: "m/a.go", name: "F", startLine: 10, endLine: 20 });
  assert.deepEqual(nodes[1], { filePath: "m/b.go", name: "G", startLine: 5, endLine: 5 });
});
