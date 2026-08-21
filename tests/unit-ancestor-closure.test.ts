/**
 * R7c - the ONE derivation of "who else has to be written again" (`unit-ancestor-closure.ts`).
 *
 * THE LAST TEST IN THIS FILE IS THE POINT OF THE FILE. R6a's invalidation plan and R7c's repair set both propagate
 * "this unit moved" up the plan's child edges. Two implementations of that would be two answers to the same
 * question, and the day they disagreed an operator would have no way to tell which one the run acted on. So the
 * predicate lives in one place and the last test runs BOTH consumers over one plan and asserts they agree unit for
 * unit: withhold a candidate for a set of seeds, and R6a's non-reusable set is exactly this file's closure.
 *
 * The rest is the closure's own contract: the transitive walk, the `via` reasons being COMPLETE (a parent pulled in
 * by its first child must still name the second one), and the three refusals — a seed outside the plan, a child
 * outside the plan, a unit declared twice — none of which may be a row quietly dropped.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ancestorClosure, blockingChildUnitIds, type UnitChildEdges } from "../src/report/unit-ancestor-closure.ts";
import { deriveUnitCachePlan, type CandidateSource } from "../src/report/unit-cache-plan.ts";
import { heldCandidates, identityFixture, plannedIdentities } from "./unit-cache-identity-fixture.ts";

/** A three-level tree: two leaves under a mid synthesis, that under the root, plus an untouched sibling leaf. */
const TREE: readonly UnitChildEdges[] = [
  { unitId: "doc::leaf::a", childUnitIds: [] },
  { unitId: "doc::leaf::b", childUnitIds: [] },
  { unitId: "doc::leaf::c", childUnitIds: [] },
  { unitId: "doc::mid", childUnitIds: ["doc::leaf::a", "doc::leaf::b"] },
  { unitId: "doc::root", childUnitIds: ["doc::mid", "doc::leaf::c"] }
];

function ids(units: readonly UnitChildEdges[], seeds: readonly string[]): readonly string[] {
  return ancestorClosure(units, seeds).map((row) => row.unitId);
}

test("a leaf pulls in every unit written from it, transitively, and nothing else", () => {
  assert.deepEqual(ids(TREE, ["doc::leaf::a"]), ["doc::leaf::a", "doc::mid", "doc::root"]);
  // The sibling subtree is untouched: that is the whole economic claim of a repair set.
  assert.ok(!ids(TREE, ["doc::leaf::a"]).includes("doc::leaf::b"));
  assert.ok(!ids(TREE, ["doc::leaf::a"]).includes("doc::leaf::c"));
});

test("a seed with no parent is the whole closure, and the root seeds only itself", () => {
  assert.deepEqual(ids([{ unitId: "solo", childUnitIds: [] }], ["solo"]), ["solo"]);
  assert.deepEqual(ids(TREE, ["doc::root"]), ["doc::root"]);
});

test("no seed is no closure, and the empty set is not an error", () => {
  assert.deepEqual(ids(TREE, []), []);
});

test("a unit pulled in by one child still names the other child that also moved", () => {
  // The regression this pins: derive the `via` lists as the loop admits units and `doc::mid` records whichever of
  // its two children was seen first, so the reason names one of two moved children and the operator cannot see the
  // second. The lists are therefore derived after membership reaches its fixpoint.
  const closure = ancestorClosure(TREE, ["doc::leaf::a", "doc::leaf::b"]);
  const mid = closure.find((row) => row.unitId === "doc::mid");
  assert.deepEqual(mid?.viaChildUnitIds, ["doc::leaf::a", "doc::leaf::b"]);
  assert.deepEqual(closure.find((row) => row.unitId === "doc::root")?.viaChildUnitIds, ["doc::mid"]);
  // A seed carries no `via`: it was named directly, which is the stronger statement about why it is here.
  for (const seed of ["doc::leaf::a", "doc::leaf::b"]) {
    assert.deepEqual(closure.find((row) => row.unitId === seed)?.viaChildUnitIds, []);
  }
});

test("a seed that is also an ancestor of another seed still reads as named directly", () => {
  const closure = ancestorClosure(TREE, ["doc::leaf::a", "doc::mid"]);
  assert.deepEqual(closure.map((row) => row.unitId), ["doc::leaf::a", "doc::mid", "doc::root"]);
  assert.deepEqual(closure.find((row) => row.unitId === "doc::mid")?.viaChildUnitIds, []);
});

test("the three refusals are named, and none of them is a dropped row", () => {
  assert.throws(() => ancestorClosure(TREE, ["doc::leaf::z"]), /named as a repair seed, but the unit edge list does not hold it/);
  assert.throws(
    () => ancestorClosure([{ unitId: "doc::root", childUnitIds: ["doc::gone"] }], []),
    /written from child "doc::gone", which the unit edge list does not hold/
  );
  assert.throws(
    () => ancestorClosure([{ unitId: "doc::a", childUnitIds: [] }, { unitId: "doc::a", childUnitIds: [] }], []),
    /holds "doc::a" twice/
  );
});

test("blockingChildUnitIds answers the same question for one unit, ascending", () => {
  const moved = new Set(["doc::leaf::b", "doc::leaf::a"]);
  assert.deepEqual(blockingChildUnitIds(["doc::leaf::b", "doc::leaf::a"], (id) => moved.has(id)), ["doc::leaf::a", "doc::leaf::b"]);
  assert.deepEqual(blockingChildUnitIds(["doc::leaf::c"], (id) => moved.has(id)), []);
});

// --- the agreement: R6a's propagation and this closure are one relation --------------------------------

const SOURCE_DIGEST = "a".repeat(64);

test("R6a's non-reusable set over withheld candidates is exactly this file's ancestor closure", async () => {
  const fix = await identityFixture();
  const planned = plannedIdentities(fix, fix.base);
  const edges: readonly UnitChildEdges[] = fix.base.planCatalog.units.map((unit) => ({ unitId: unit.unitId, childUnitIds: unit.childUnitIds }));
  const identities = planned.flatMap((row) => (row.derivation === "children-unavailable" ? [] : [row.identity]));
  const source: CandidateSource = {
    origin: "prior-verified-units",
    runId: fix.base.planCatalog.runId,
    knowledgeEpoch: fix.base.planCatalog.knowledgeEpoch,
    planCatalogDigests: [SOURCE_DIGEST]
  };
  // Two seed shapes, because a single one could agree by accident: a leaf deep in one document, and a leaf plus a
  // sibling leaf of another document, so the closure has to stop at two different roots.
  const leaves = fix.base.planCatalog.units.filter((unit) => unit.kind === "leaf").map((unit) => unit.unitId).sort();
  assert.ok(leaves.length >= 2, `the fixture plan must hold at least two leaves to seed; it holds ${leaves.length}`);
  for (const seeds of [[leaves[0]!], [leaves[0]!, leaves[leaves.length - 1]!]]) {
    const withheld = new Set(seeds);
    const plan = deriveUnitCachePlan({
      planned,
      candidates: heldCandidates(identities.filter((identity) => !withheld.has(identity.unitId))),
      candidateSource: source
    });
    const nonReusable = plan.entries.filter((entry) => entry.status !== "reusable").map((entry) => entry.unitId).sort();
    assert.deepEqual(nonReusable, [...ids(edges, seeds)].sort(),
      `R6a and the ancestor closure must name one set for seeds ${seeds.join(", ")}; they are one relation, and two answers to "who else has to be written again" is the failure this shared file exists to prevent`);
    // And the shapes agree too: every seed is `new` (no candidate) and every ancestor is `rebuild` naming a child.
    for (const seed of seeds) assert.equal(plan.entries.find((entry) => entry.unitId === seed)?.status, "new");
    for (const unitId of nonReusable.filter((id) => !withheld.has(id))) {
      const entry = plan.entries.find((row) => row.unitId === unitId)!;
      assert.equal(entry.status, "rebuild");
      assert.equal(entry.status === "rebuild" ? entry.reason.cause : null, "child-not-reusable");
    }
  }
});
