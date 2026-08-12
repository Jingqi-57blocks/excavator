import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { boundaryRecall, derivationDrops, factPackItemsToNodes, type BoundaryReport } from "../boundary.ts";
import { loadBoundaryGold } from "../boundary-gold.ts";
import { loadFactpackFixture, fixtureFgNodes, fixtureFactPackNodes, fixturePostFixFactPackNodes } from "../factpack-fixture.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const LEAVE_FX = join(FIXTURES, "wcp-leave", "factpack-fg.json.gz");
const LEAVE_GOLD = join(FIXTURES, "wcp-leave", "boundary-gold.json");
const PROMO_FX = join(FIXTURES, "wcp-promotion", "factpack-fg.json.gz");
const PROMO_GOLD = join(FIXTURES, "wcp-promotion", "boundary-gold.json");

/** Three recall reports per run: the FG node set (57B-370), the PRE-PR-2 fact pack (the six structural
 *  categories only), and the POST-PR-2 fact pack the author now reads (claimed ∪ the logic complement). */
function layers(fxFile: string, goldFile: string): { fg: BoundaryReport; factpackPre: BoundaryReport; factpack: BoundaryReport } {
  const fx = loadFactpackFixture(fxFile);
  const gold = loadBoundaryGold(goldFile);
  return {
    fg: boundaryRecall(fixtureFgNodes(fx), gold),
    factpackPre: boundaryRecall(fixtureFactPackNodes(fx), gold),
    factpack: boundaryRecall(fixturePostFixFactPackNodes(fx), gold)
  };
}

const mustFindMissing = (r: BoundaryReport) => r.missing.filter((m) => m.mustFind).map((m) => m.id).sort();
const mustFindFound = (r: BoundaryReport) => r.found.filter((f) => f.mustFind).map((f) => f.id).sort();
const mustFindDrops = (fg: BoundaryReport, factpack: BoundaryReport) =>
  derivationDrops(fg, factpack).filter((d) => d.mustFind).map((d) => d.id).sort();

// ============================================================================
// POST-FIX (57B-372 PR-2). PR-1 pinned the pre-fix reality as a regression fact: the fact pack the
// author read dropped material business/decision functions the FG node set already held. PR-2 adds the
// `logic` complement — every retained FG node the six structural categories did not claim — so the pack
// the author reads is now `claimed ∪ logic`. These tests encode the post-fix reality; the pre-fix drop
// is kept alongside as the documented delta so the flip stays legible.
// ============================================================================

// The 11 leave mustFinds the six structural categories dropped: 3 T1 (rescued into the FG by 57B-371)
// + 8 T2 named handler methods/functions. The logic complement recovers ALL of them.
const LEAVE_STRUCTURAL_DROPPED = [
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

test("leave FG layer is GREEN (13/13) — the upstream metric 57B-370 measured", () => {
  const { fg } = layers(LEAVE_FX, LEAVE_GOLD);
  assert.equal(fg.summary.mustFind, 13);
  assert.equal(fg.summary.mustFindMissing, 0);
  assert.equal(fg.summary.pass, true);
});

test("leave fact-pack layer flips RED → GREEN: the logic complement recovers all 11 dropped functions", () => {
  const { factpackPre, factpack } = layers(LEAVE_FX, LEAVE_GOLD);
  // Documented delta: the six structural categories, on their own, still drop the 11 (pre-fix reality).
  assert.deepEqual(mustFindMissing(factpackPre), LEAVE_STRUCTURAL_DROPPED);
  // Post-fix: claimed ∪ logic reaches every mustFind — the consumption gap 57B-372 exists to close is gone.
  assert.equal(factpack.summary.pass, true);
  assert.deepEqual(mustFindMissing(factpack), []);
  assert.equal(mustFindFound(factpack).length, 13);
});

test("leave has no fact-pack derivation drops after the fix (found@fg ∧ missing@factpack is empty)", () => {
  const { fg, factpack } = layers(LEAVE_FX, LEAVE_GOLD);
  assert.deepEqual(mustFindDrops(fg, factpack), []);
});

// Promotion: the fact pack dropped all 4 mustFinds pre-fix. Of those, Info + PromotionForward are
// derivation drops (found@fg) that the logic complement recovers; IsManager + IsLeader are additionally
// an UPSTREAM FG gap for this run (missing at BOTH layers), which a fact-pack change cannot recover — it
// is tracked separately for 57B-320 and is OUT OF SCOPE for 57B-372.
const PROMO_DERIVATION_DROPS = ["record-info", "record-promotionForward"];
const PROMO_FG_GAP = ["auth-isLeader", "auth-isManager"];

test("promotion fact-pack layer recovers only its 2 derivation drops; the upstream FG gap remains", () => {
  const { factpackPre, factpack } = layers(PROMO_FX, PROMO_GOLD);
  // Pre-fix: the fact pack dropped all 4 (the 2 derivation drops + the 2 FG-gap symbols).
  assert.deepEqual(mustFindMissing(factpackPre), [...PROMO_FG_GAP, ...PROMO_DERIVATION_DROPS].sort());
  // Post-fix: the logic complement recovers exactly the 2 derivation drops. The 2 FG-gap symbols never
  // reached the FG for this run, so no fact-pack change can bring them in — they stay missing (57B-320).
  assert.deepEqual(mustFindFound(factpack), PROMO_DERIVATION_DROPS);
  assert.deepEqual(mustFindMissing(factpack), PROMO_FG_GAP);
  assert.equal(factpack.summary.pass, false);
});

test("promotion derivation drops are gone after the fix; the FG gap is unchanged and stays out of scope", () => {
  const { fg, factpack } = layers(PROMO_FX, PROMO_GOLD);
  // The 2 record methods were found@fg and are now found@factpack, so they are no longer derivation drops.
  assert.deepEqual(mustFindDrops(fg, factpack), []);
  // IsManager/IsLeader are missing at BOTH layers: an upstream FG gap, never a fact-pack derivation drop.
  assert.deepEqual(mustFindMissing(fg), PROMO_FG_GAP);
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
