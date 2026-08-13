// 57B-377 gate: the module-local strong-rescue floor. Adding a frontend CodeGraph makes wcp-ui a
// graph-set member and pulls its leave components into scope; the floor must recover the backend
// rescue (syncLvCompleted) that the 4-module global prune displaces, WITHOUT re-ranking the global
// prune at all. Zero model, zero database — a frozen candidate pool + synthetic pools prove it.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadPrunePool, prunePool, prunePoolToNodes } from "../prune-replay.ts";
import { boundaryRecall } from "../boundary.ts";
import { loadBoundaryGold } from "../boundary-gold.ts";
import { pruneFeatureGraph, rescueQuotaFor, rescueSignalsFor, NAME_TOKEN_EXACT } from "../../src/context/feature-prune.ts";
import { pruneFeatureGraphWithModuleFloor } from "../../src/context/prune-module-floor.ts";
import { ID_SEPARATOR } from "../../src/codegraph/codegraph-set.ts";

const WCP_LEAVE = join(import.meta.dirname, "..", "fixtures", "wcp-leave");
const BACKEND_POOL = join(WCP_LEAVE, "prune-pool.json.gz");
const FRONTEND_POOL = join(WCP_LEAVE, "prune-pool-frontend.json.gz");
const FRONTEND_GOLD = join(WCP_LEAVE, "boundary-gold-frontend.json");

const moduleOf = (id: string): string => {
  const i = String(id).indexOf(ID_SEPARATOR);
  return i < 0 ? "" : String(id).slice(0, i);
};

// ---- 1. Frontend gate: the floor recovers syncLvCompleted AND lands the 3 frontend sensors ----

test("57B-377 gate: frontend pool passes the frontend gold 16/16 and lands at exactly 251 nodes", () => {
  const pool = loadPrunePool(FRONTEND_POOL);
  const report = boundaryRecall(prunePoolToNodes(pool), loadBoundaryGold(FRONTEND_GOLD));
  assert.equal(report.summary.pass, true);
  assert.equal(report.summary.mustFindMissing, 0);
  assert.equal(report.summary.mustFind, 16); // 13 backend (T1/T2) + 3 frontend (F1-ui)
  assert.equal(report.summary.mustFindFound, 16);
  const found = new Set(report.found.map((entry) => entry.id));
  for (const id of [
    "T1-calculationAuto", "T1-isIgnoreHolidayLvType", "T1-syncLvCompleted",
    "F1-ui-applyLeave", "F1-ui-leaveApprovalActions", "F1-ui-exportLeaveRequestModal"
  ]) assert.ok(found.has(id), `expected ${id} to be in bounds`);
  // Exactly one node floored back beyond the global 250, and never an explosion.
  assert.equal(report.summary.nodeCount, 251);
  assert.ok(report.summary.nodeCount <= pool.maxFeatureNodes + 3 * rescueQuotaFor(pool.maxFeatureNodes),
    `nodeCount ${report.summary.nodeCount} within no-explosion bound`);
});

// ---- 2. ★ The core no-op proof: an existing multi-module pool is byte-identical to the global prune ----

test("57B-377: existing (backend) pool is BYTE-IDENTICAL to the un-floored global prune", () => {
  const pool = loadPrunePool(BACKEND_POOL);
  const anchors = pool.anchorTerms ?? [];
  const global = pruneFeatureGraph(pool.nodes, pool.edges, pool.seeds, anchors, pool.maxFeatureNodes);
  const floored = pruneFeatureGraphWithModuleFloor(pool.nodes, pool.edges, pool.seeds, anchors, pool.maxFeatureNodes);
  assert.equal(JSON.stringify(floored.nodes), JSON.stringify(global.nodes), "nodes byte-identical");
  assert.equal(JSON.stringify(floored.edges), JSON.stringify(global.edges), "edges byte-identical");
});

// ---- 3. Single-module / no-namespace pools are a provable no-op ----

test("57B-377: a pool restricted to one module equals the un-floored global prune", () => {
  const pool = loadPrunePool(FRONTEND_POOL);
  const only = "wcp-ui"; // one of the frontend pool's modules
  const nodes = pool.nodes.filter((node: any) => moduleOf(node.id) === only);
  const ids = new Set(nodes.map((node: any) => String(node.id)));
  const edges = pool.edges.filter((edge: any) => ids.has(String(edge.source)) && ids.has(String(edge.target)));
  const seeds = pool.seeds.filter((seed: any) => moduleOf(seed.id) === only);
  const anchors = pool.anchorTerms ?? [];
  assert.ok(nodes.length > 0 && new Set(nodes.map((n: any) => moduleOf(n.id))).size === 1, "single module sub-pool");
  const global = pruneFeatureGraph(nodes, edges, seeds, anchors, pool.maxFeatureNodes);
  const floored = pruneFeatureGraphWithModuleFloor(nodes, edges, seeds, anchors, pool.maxFeatureNodes);
  assert.deepEqual(floored, global);
});

test("57B-377: a namespace-free (bare-id) pool equals the un-floored global prune", () => {
  const nodes = [
    { id: "s1", name: "leaveController", kind: "function", filePath: "app/leaveController.js", startLine: 1, endLine: 9 },
    { id: "n1", name: "leaveService", kind: "function", filePath: "app/leaveService.js", startLine: 1, endLine: 9 },
    { id: "n2", name: "helper", kind: "function", filePath: "app/helper.js", startLine: 1, endLine: 9 },
    { id: "n3", name: "leaveCron", kind: "function", filePath: "app/jobs/leaveCron.js", startLine: 1, endLine: 9 }
  ];
  const edges = [{ source: "n1", target: "s1", kind: "calls", line: 3 }];
  const seeds = [nodes[0]];
  const anchors = ["leave"];
  const global = pruneFeatureGraph(nodes, edges, seeds, anchors, 3);
  const floored = pruneFeatureGraphWithModuleFloor(nodes, edges, seeds, anchors, 3);
  assert.equal(new Set(nodes.map((n) => moduleOf(n.id))).size, 1, "no namespace -> single implicit module");
  assert.deepEqual(floored, global);
});

// ---- 4. No-explosion: weak candidates float nothing; strong ones stay bounded by R per module ----

/** A synthetic namespaced node. `moduleId` becomes the NUL-prefix that groups it. */
function n(moduleId: string, localId: string, name: string, filePath: string): any {
  return { id: `${moduleId}${ID_SEPARATOR}${localId}`, name, kind: "function", filePath, startLine: 1, endLine: 9 };
}

test("57B-377 no-explosion: a multi-module pool of only-weak rescues floors NOTHING (byte-identical)", () => {
  // Two modules. `anchor`-named nodes score exactly NAME_TOKEN_EXACT (=220, a bare single token, no
  // bridge/scheduler) -> total == 220, which fails the strong gate (total > 220). `junk` nodes have
  // name==0 but a bridge edge to an anchor node -> total>0 but name==0, also failing the gate. So
  // every module-local rescue is weak and the floor adds nothing, whatever the global displacement.
  const nodes: any[] = [];
  const edges: any[] = [];
  const seeds: any[] = [];
  for (const m of ["m1", "m2"]) {
    const seed = n(m, "seed", `${m}Root`, `${m}/root.js`);
    nodes.push(seed);
    seeds.push(seed);
    for (let i = 0; i < 6; i += 1) {
      const anchorNode = n(m, `a${i}`, "leave", `${m}/plain/a${i}.js`); // bare 220
      const junkNode = n(m, `j${i}`, "zzz", `${m}/plain/j${i}.js`);     // name 0, bridge only
      nodes.push(anchorNode, junkNode);
      edges.push({ source: junkNode.id, target: anchorNode.id, kind: "calls", line: 2 });
    }
  }
  const anchors = ["leave"];
  const cap = 8;
  const signals = rescueSignalsFor(nodes, edges, anchors);
  assert.ok([...signals.values()].every((s) => !(s.name > 0 && s.total > NAME_TOKEN_EXACT)), "no strong candidate exists");
  const global = pruneFeatureGraph(nodes, edges, seeds, anchors, cap);
  const floored = pruneFeatureGraphWithModuleFloor(nodes, edges, seeds, anchors, cap);
  assert.equal(JSON.stringify(floored), JSON.stringify(global), "weak-only pool: floor is byte-identical");
});

test("57B-377 no-explosion: strong module-local rescues are floored back, at most R per module", () => {
  // Two modules, each with many strong scheduler rescues (anchor token in the NAME -> 220, plus a
  // scheduler path -> +80 => total 300 > 220, name > 0). The path carries no anchor so they do NOT
  // climb into Stage 1; they compete for the shared rescue quota and get displaced across modules.
  const nodes: any[] = [];
  const seeds: any[] = [];
  const perModule = 10;
  for (const m of ["m1", "m2"]) {
    const seed = n(m, "seed", `${m}Root`, `${m}/root.js`);
    nodes.push(seed);
    seeds.push(seed);
    for (let i = 0; i < perModule; i += 1) {
      nodes.push(n(m, `s${String(i).padStart(2, "0")}`, `leaveSync${i}`, `${m}/jobs/task${String(i).padStart(2, "0")}.go`));
    }
  }
  const anchors = ["leave"];
  const cap = 10;
  const R = rescueQuotaFor(cap);
  const global = pruneFeatureGraph(nodes, [], seeds, anchors, cap);
  const floored = pruneFeatureGraphWithModuleFloor(nodes, [], seeds, anchors, cap);
  const baseIds = new Set(global.nodes.map((node: any) => String(node.id)));
  const added = floored.nodes.filter((node: any) => !baseIds.has(String(node.id)));
  assert.ok(added.length > 0, "strong displaced rescues are floored back");
  const signals = rescueSignalsFor(nodes, [], anchors);
  for (const node of added) {
    const s = signals.get(String(node.id))!;
    assert.ok(s.name > 0 && s.total > NAME_TOKEN_EXACT, "every floored node cleared the strong gate");
  }
  const perModuleAdded = new Map<string, number>();
  for (const node of added) perModuleAdded.set(moduleOf(node.id), (perModuleAdded.get(moduleOf(node.id)) ?? 0) + 1);
  for (const [m, count] of perModuleAdded) assert.ok(count <= R, `module ${m} floored ${count} <= R=${R}`);
  assert.ok(floored.nodes.length <= cap + 2 * R, "bounded by cap + moduleCount*R");
});

// ---- 5. Provenance + determinism ----

test("57B-377: floored nodes carry a `module-floor:` provenance and add only the `rescued` key", () => {
  const pool = loadPrunePool(FRONTEND_POOL);
  const anchors = pool.anchorTerms ?? [];
  const global = pruneFeatureGraph(pool.nodes, pool.edges, pool.seeds, anchors, pool.maxFeatureNodes);
  const floored = pruneFeatureGraphWithModuleFloor(pool.nodes, pool.edges, pool.seeds, anchors, pool.maxFeatureNodes);
  const baseIds = new Set(global.nodes.map((node: any) => String(node.id)));
  const added = floored.nodes.filter((node: any) => !baseIds.has(String(node.id)));
  assert.ok(added.length > 0, "the frontend pool floors at least one node");
  const byId = new Map(pool.nodes.map((node: any) => [String(node.id), node]));
  for (const node of added) {
    assert.ok(String(node.rescued).startsWith("module-floor: "), "carries the module-floor provenance prefix");
    const original = byId.get(String(node.id));
    assert.ok(original, "floored node came from the pool");
    // Only the `rescued` key is added: every original field is preserved verbatim.
    for (const key of Object.keys(original)) assert.deepEqual(node[key], original[key]);
  }
});

test("57B-377: the floored prune is deterministic (two runs are byte-identical)", () => {
  const pool = loadPrunePool(FRONTEND_POOL);
  assert.equal(JSON.stringify(prunePool(pool).nodes), JSON.stringify(prunePool(pool).nodes));
  assert.equal(JSON.stringify(prunePool(pool).edges), JSON.stringify(prunePool(pool).edges));
});
