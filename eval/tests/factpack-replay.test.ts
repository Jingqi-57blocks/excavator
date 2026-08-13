import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { boundaryRecall, factPackItemsToNodes } from "../boundary.ts";
import { loadBoundaryGold } from "../boundary-gold.ts";
import { loadFactpackFixture, fixtureLogicItems, type FactpackFixture } from "../factpack-fixture.ts";
import { logicClaimKey } from "../../src/context/factpack-logic.ts";
import { stableJson } from "../../src/core/util.ts";

// The 57B-372 PR-2 gate, replayed over BOTH real runs. The fixtures freeze the pruned FG and the six
// structural categories' items; `fixtureLogicItems` runs the production complement enumeration over them,
// so this asserts what the shipped code produces — not a re-derivation the test invented.

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const LEAVE_FX = join(FIXTURES, "wcp-leave", "factpack-fg.json.gz");
const LEAVE_GOLD = join(FIXTURES, "wcp-leave", "boundary-gold.json");
const PROMO_FX = join(FIXTURES, "wcp-promotion", "factpack-fg.json.gz");
const PROMO_GOLD = join(FIXTURES, "wcp-promotion", "boundary-gold.json");

interface Run {
  label: string;
  fxFile: string;
  goldFile: string;
  /** B: the exact frozen logic-item count — any drift (up or down) is a red flag to investigate. */
  frozenLogicCount: number;
  /** A: mustFinds still missing at the post-fix factpack layer (upstream FG gaps a fact-pack change cannot recover). */
  remainingMustFindMissing: string[];
  /** A: mustFinds the logic complement is expected to recover into the pack. */
  recovers: string[];
}

const RUNS: Run[] = [
  // leave: all 13 mustFinds reachable after the fix — 11 were derivation drops the complement recovers.
  { label: "leave", fxFile: LEAVE_FX, goldFile: LEAVE_GOLD, frozenLogicCount: 206, remainingMustFindMissing: [], recovers: [] },
  // promotion: the complement recovers the 2 derivation drops; auth-isLeader/isManager are an upstream FG
  // gap (missing at both layers, tracked for 57B-320) that no fact-pack change can bring in.
  { label: "promotion", fxFile: PROMO_FX, goldFile: PROMO_GOLD, frozenLogicCount: 176, remainingMustFindMissing: ["auth-isLeader", "auth-isManager"], recovers: ["record-info", "record-promotionForward"] }
];

const load = (fxFile: string): FactpackFixture => loadFactpackFixture(fxFile);

for (const run of RUNS) {
  test(`A recall — ${run.label}: claimed ∪ logic reaches every recoverable mustFind`, () => {
    const fx = load(run.fxFile);
    const gold = loadBoundaryGold(run.goldFile);
    const union = boundaryRecall(factPackItemsToNodes([...fx.claimedItems, ...fixtureLogicItems(fx)]), gold);
    const missing = union.missing.filter((m) => m.mustFind).map((m) => m.id).sort();
    assert.deepEqual(missing, run.remainingMustFindMissing, "only upstream FG gaps may remain at the factpack layer");
    for (const id of run.recovers) {
      assert.ok(union.found.some((f) => f.id === id), `logic complement should recover ${id}`);
    }
  });

  test(`B no-explosion — ${run.label}: logic count is bounded by maxNodes and pinned to its frozen value`, () => {
    const fx = load(run.fxFile);
    const logic = fixtureLogicItems(fx);
    assert.ok(logic.length <= fx.maxNodes, `logic ${logic.length} must not exceed maxNodes ${fx.maxNodes}`);
    assert.equal(logic.length, run.frozenLogicCount, "frozen logic-item count drifted — investigate before re-pinning");
  });

  test(`C determinism — ${run.label}: two enumerations are byte-identical`, () => {
    const fx = load(run.fxFile);
    assert.equal(stableJson(fixtureLogicItems(fx)), stableJson(fixtureLogicItems(fx)));
  });

  test(`D claim-exclusion — ${run.label}: no logic item shares a (filePath, line) with a claimed item`, () => {
    const fx = load(run.fxFile);
    const claimed = new Set(fx.claimedItems.map((item) => logicClaimKey(item.filePath, item.line)));
    for (const item of fixtureLogicItems(fx)) {
      assert.ok(!claimed.has(logicClaimKey(item.filePath, item.line)), `logic item ${item.name} collides with a claimed location`);
    }
  });

  test(`E rescued-must-arrive — ${run.label}: every rescued FG node reaches the author`, () => {
    const fx = load(run.fxFile);
    const logicLocations = new Set(fixtureLogicItems(fx).map((item) => logicClaimKey(item.filePath, item.line)));
    const claimedLocations = new Set(fx.claimedItems.map((item) => logicClaimKey(item.filePath, item.line)));
    // A rescued node is represented when it becomes a logic item OR its exact location was already claimed
    // by another category (e.g. a rescued type at a line the `states` scan matched). Either way it reaches
    // the author — never silently dropped. Both fixtures have at least one rescued node.
    const rescued = fx.nodes.filter((n) => typeof n.rescued === "string" && n.rescued.length);
    assert.ok(rescued.length > 0, "precondition: the fixture carries rescued nodes");
    for (const node of rescued) {
      const key = logicClaimKey(node.filePath, node.startLine);
      assert.ok(logicLocations.has(key) || claimedLocations.has(key), `rescued node ${node.name} is neither a logic item nor claimed elsewhere`);
    }
  });
}
