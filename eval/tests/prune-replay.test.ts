// 57B-371 gate: the zero-model, zero-database replay that must pass BEFORE any budget is spent on a
// real authoring run. It loads the frozen candidate pool (the exact nodes + closure edges + seeds +
// anchor terms the real pipeline fed the prune, generated once from real databases via
// `eval/cli.ts prune-replay --emit-pool`) and runs the NEW two-stage `pruneFeatureGraph` over it.
// The boundary gold's three T1 confirmed misses must turn green without dropping any T2 leave-core
// sentinel, and the node set must stay within its hard cap.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadPrunePool, prunePool, prunePoolToNodes } from "../prune-replay.ts";
import { boundaryRecall } from "../boundary.ts";
import { loadBoundaryGold } from "../boundary-gold.ts";
import { pruneFeatureGraph, rescueQuotaFor } from "../../src/context/feature-prune.ts";

const WCP_LEAVE = join(import.meta.dirname, "..", "fixtures", "wcp-leave");
const POOL = join(WCP_LEAVE, "prune-pool.json.gz");
const GOLD = join(WCP_LEAVE, "boundary-gold.json");

test("57B-371 gate: improved prune passes the boundary gold (13/13 mustFind) within the node cap", () => {
  const pool = loadPrunePool(POOL);
  const report = boundaryRecall(prunePoolToNodes(pool), loadBoundaryGold(GOLD));
  assert.equal(report.summary.pass, true); // the only gate: every mustFind is in bounds
  assert.equal(report.summary.mustFindMissing, 0);
  assert.equal(report.summary.mustFindFound, report.summary.mustFind);
  assert.equal(report.summary.mustFind, 13);
  assert.ok(report.summary.nodeCount <= pool.maxFeatureNodes, `nodeCount ${report.summary.nodeCount} <= ${pool.maxFeatureNodes}`);
  assert.equal(report.summary.nodeCount, 250);
});

test("57B-371 gate: the three T1 confirmed misses are all recovered", () => {
  const pool = loadPrunePool(POOL);
  const report = boundaryRecall(prunePoolToNodes(pool), loadBoundaryGold(GOLD));
  const found = new Set(report.found.map((entry) => entry.id));
  for (const id of ["T1-calculationAuto", "T1-isIgnoreHolidayLvType", "T1-syncLvCompleted"]) {
    assert.ok(found.has(id), `expected ${id} to be recovered`);
  }
});

test("57B-371 gate: the T2 leave-core sentinels stay in bounds (no re-ranking regression)", () => {
  const pool = loadPrunePool(POOL);
  const report = boundaryRecall(prunePoolToNodes(pool), loadBoundaryGold(GOLD));
  const found = new Set(report.found.map((entry) => entry.id));
  for (const entry of loadBoundaryGold(GOLD).items) {
    if (entry.mustFind && entry.id.startsWith("T2-")) assert.ok(found.has(entry.id), `T2 sentinel ${entry.id} dropped`);
  }
});

test("57B-371 gate: prune is deterministic (two runs are byte-identical)", () => {
  const pool = loadPrunePool(POOL);
  assert.equal(JSON.stringify(prunePool(pool).nodes), JSON.stringify(prunePool(pool).nodes));
  assert.equal(JSON.stringify(prunePool(pool).edges), JSON.stringify(prunePool(pool).edges));
});

test("57B-371 gate: node set fills to the cap exactly and never exceeds it", () => {
  const pool = loadPrunePool(POOL); // 1726 pool nodes, far above every cap below
  const anchors = pool.anchorTerms ?? [];
  for (const cap of [100, 175, 250]) {
    // The global prune (byte-unchanged by 57B-377) still fills to the cap EXACTLY.
    assert.equal(pruneFeatureGraph(pool.nodes, pool.edges, pool.seeds, anchors, cap).nodes.length, cap, `global cap ${cap}`);
    // prunePool now applies the 57B-377 module-local rescue floor, which is ADDITIVE: at tighter
    // budgets it adds module-local strong rescues the shared global quota displaced (e.g. the
    // maxAvailableHoliday T2 sentinel at cap 100), so it is bounded by cap + moduleCount*R (<=3
    // backend modules here), not pinned to the cap. At the production cap (250) it adds nothing.
    const floored = prunePool(pool, cap).nodes.length;
    assert.ok(floored >= cap && floored <= cap + 3 * rescueQuotaFor(cap), `floored cap ${cap}: ${floored}`);
  }
});

test("57B-371 gate: rescued nodes carry an explanation and only add a key", () => {
  const pool = loadPrunePool(POOL);
  const nodes = prunePool(pool).nodes;
  const rescued = nodes.filter((node: any) => typeof node.rescued === "string");
  assert.ok(rescued.length > 0, "expected at least one rescued node");
  const byId = new Map(pool.nodes.map((node: any) => [String(node.id), node]));
  for (const node of rescued) {
    assert.ok(node.rescued.length > 0);
    const original = byId.get(String(node.id));
    assert.ok(original, "rescued node came from the pool");
    // shape is unchanged apart from the added `rescued` key: every original field is preserved.
    for (const key of Object.keys(original)) assert.deepEqual(node[key], original[key]);
  }
});
