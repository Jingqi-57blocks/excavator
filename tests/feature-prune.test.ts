import test from "node:test";
import assert from "node:assert/strict";
import {
  consonantSkeleton,
  deriveAbbreviations,
  nameTokens,
  rescueQuotaFor,
  pruneFeatureGraph
} from "../src/context/feature-prune.ts";

// ---- consonant-skeleton abbreviation derivation (framework-agnostic, runtime-derived) ----

test("consonantSkeleton derives lv from leave and hldy from holiday", () => {
  assert.equal(consonantSkeleton("leave"), "lv");
  assert.equal(consonantSkeleton("holiday"), "hldy");
  assert.equal(consonantSkeleton("annual"), "annl");
});

test("consonantSkeleton lowercases before deriving", () => {
  assert.equal(consonantSkeleton("Leave"), "lv");
});

test("consonantSkeleton does not derive short (<5) terms like pto", () => {
  assert.equal(consonantSkeleton("pto"), null);
  assert.equal(consonantSkeleton("hr"), null);
});

test("consonantSkeleton skips non-ASCII terms (e.g. Chinese)", () => {
  assert.equal(consonantSkeleton("请假"), null);
  assert.equal(consonantSkeleton("annual leave"), null); // whitespace -> not a single ASCII token
});

test("deriveAbbreviations returns the deduped skeletons of eligible anchor terms only", () => {
  const abbrevs = deriveAbbreviations(["leave", "pto", "请假", "holiday", "annual leave"]);
  assert.deepEqual([...abbrevs].sort(), ["hldy", "lv"]);
});

// ---- name tokenization (camelCase / snake_case) ----

test("nameTokens splits camelCase into lowercase tokens of length >= 2", () => {
  const tokens = nameTokens("isIgnoreHolidayLvType");
  for (const t of ["ignore", "holiday", "lv", "type"]) assert.ok(tokens.has(t), `expected token ${t}`);
});

test("nameTokens splits snake_case and drops single letters/digits", () => {
  const tokens = nameTokens("sync_lv_completed2");
  assert.ok(tokens.has("sync"));
  assert.ok(tokens.has("lv"));
  assert.ok(tokens.has("completed"));
});

// ---- rescue quota R = min(24, max(8, round(maxNodes * 0.08))) ----

test("rescueQuotaFor clamps to [8, 24] around ~8% of the budget", () => {
  assert.equal(rescueQuotaFor(250), 20);
  assert.equal(rescueQuotaFor(100), 8); // round(8) = 8
  assert.equal(rescueQuotaFor(50), 8); // round(4) -> floor at 8
  assert.equal(rescueQuotaFor(300), 24); // round(24) = 24
  assert.equal(rescueQuotaFor(1000), 24); // ceiling at 24
});

// ---- synthetic-graph structural rescue ----

function node(id: string, name: string, filePath: string, kind = "function"): any {
  return { id, name, filePath, kind, signature: null, startLine: 1, endLine: 2 };
}
function edge(source: string, target: string, line: number, kind = "calls"): any {
  return { source, target, kind, line, metadata: {} };
}
const ANCHORS = ["leave"];

function rescuedOf(result: { nodes: any[] }): any[] {
  return result.nodes.filter((n) => typeof n.rescued === "string");
}

test("bridge is directional: a node that CALLS a name-matched node is rescued", () => {
  const nodes = [
    node("SEED", "Root", "a.go"),
    node("MATCH", "LeaveThing", "b.go"), // name matches anchor -> stage 1
    node("CALLER", "PlainCaller", "c.go") // no name signal; only an out-edge to MATCH
  ];
  const edges = [edge("CALLER", "MATCH", 10)];
  const result = pruneFeatureGraph(nodes, edges, [node("SEED", "Root", "a.go")], ANCHORS, 10);
  const caller = result.nodes.find((n) => n.id === "CALLER");
  assert.ok(caller?.rescued, "CALLER should be rescued via its out-edge to the matched node");
  assert.match(caller.rescued, /LeaveThing/);
});

test("hub exclusion: a node only CALLED BY matched nodes is not rescued via bridge", () => {
  const nodes = [
    node("SEED", "Root", "a.go"),
    node("MATCH", "LeaveThing", "b.go"),
    node("HUB", "SharedUtil", "d.go") // only in-edges from matched; no name signal, no out-edge to matched
  ];
  const edges = [edge("MATCH", "HUB", 20)];
  const result = pruneFeatureGraph(nodes, edges, [node("SEED", "Root", "a.go")], ANCHORS, 10);
  const hub = result.nodes.find((n) => n.id === "HUB");
  assert.ok(hub, "HUB is still present (via backfill) — the point is only that it is not RESCUED");
  assert.equal(hub.rescued, undefined, "a hub reached only by in-edges must not be rescued");
});

test("bridge multiplicity is capped at 3 per neighbour (a busier caller does not outrank)", () => {
  const nodes = [
    node("SEED", "Root", "a.go"),
    node("MATCH", "LeaveThing", "b.go"),
    node("X", "CallerX", "x.go"), // 3 call sites -> min(3,3)*60 = 180
    node("Y", "CallerY", "y.go") // 5 call sites -> capped at min(5,3)*60 = 180 (uncapped would be 300)
  ];
  const edges = [
    edge("X", "MATCH", 1), edge("X", "MATCH", 2), edge("X", "MATCH", 3),
    edge("Y", "MATCH", 1), edge("Y", "MATCH", 2), edge("Y", "MATCH", 3), edge("Y", "MATCH", 4), edge("Y", "MATCH", 5)
  ];
  const result = pruneFeatureGraph(nodes, edges, [node("SEED", "Root", "a.go")], ANCHORS, 10);
  const rescued = rescuedOf(result);
  const ix = rescued.findIndex((n) => n.id === "X");
  const iy = rescued.findIndex((n) => n.id === "Y");
  assert.ok(ix >= 0 && iy >= 0, "both callers rescued");
  // Capped -> X and Y tie on score, tie broken by path (x.go < y.go). Uncapped, Y (300) would lead.
  assert.ok(ix < iy, "capped multiplicity makes the busier caller Y tie-break AFTER X, not lead");
  assert.match(rescued[ix].rescued, /\(x3\)/);
  assert.match(rescued[iy].rescued, /\(x5\)/); // the reason still reports the true multiplicity
});

test("import/file kinds are never rescued", () => {
  const nodes = [
    node("SEED", "Root", "a.go"),
    node("MATCH", "LeaveThing", "b.go"),
    node("IMP", "leaveImport", "c.go", "import"), // name matches but kind is excluded
    node("FILE", "leaveFile", "d.go", "file")
  ];
  const result = pruneFeatureGraph(nodes, [], [node("SEED", "Root", "a.go")], ANCHORS, 10);
  assert.equal(result.nodes.find((n) => n.id === "IMP")?.rescued, undefined);
  assert.equal(result.nodes.find((n) => n.id === "FILE")?.rescued, undefined);
});

test("scheduler-path nodes get a rescue signal from a generic word list", () => {
  const nodes = [
    node("SEED", "Root", "a.go"),
    node("MATCH", "LeaveThing", "b.go"), // fills the second stage-1 seat so CRON falls to rescue
    node("CRON", "syncLvCompleted", "internal/third_party/cron/cron.go") // abbrev lv + scheduler path
  ];
  const result = pruneFeatureGraph(nodes, [], [node("SEED", "Root", "a.go")], ["leave"], 10);
  const cron = result.nodes.find((n) => n.id === "CRON");
  assert.ok(cron?.rescued, "cron entry rescued");
  assert.match(cron.rescued, /scheduler-path/);
  assert.match(cron.rescued, /abbrev-token lv/);
});

// ---- invariants ----

test("seeds are always retained", () => {
  const seeds = ["S1", "S2", "S3", "S4", "S5"].map((id) => node(id, "Unrelated", `seed-${id}.go`));
  const filler = Array.from({ length: 30 }, (_, i) => node(`F${i}`, "Filler", `f${i}.go`));
  const result = pruneFeatureGraph([...seeds, ...filler], [], seeds, ANCHORS, 20);
  const ids = new Set(result.nodes.map((n) => n.id));
  for (const seed of seeds) assert.ok(ids.has(seed.id), `seed ${seed.id} retained`);
});

test("retained node count never exceeds maxNodes", () => {
  const nodes = Array.from({ length: 100 }, (_, i) => node(`N${i}`, i % 2 ? "LeaveThing" : "Other", `n${i}.go`));
  for (const cap of [5, 13, 40, 99]) {
    const result = pruneFeatureGraph(nodes, [], [nodes[0]], ANCHORS, cap);
    assert.ok(result.nodes.length <= cap, `cap ${cap}: ${result.nodes.length}`);
    assert.equal(result.nodes.length, cap); // pool (100) > cap -> fills exactly
  }
});

test("edges are restricted to retained nodes and de-duplicated", () => {
  const nodes = [node("A", "LeaveA", "a.go"), node("B", "LeaveB", "b.go"), node("C", "OutOfScope", "c.go")];
  const edges = [
    edge("A", "B", 1), edge("A", "B", 1), // exact duplicate -> collapsed
    edge("A", "C", 2) // C is present here (small pool), so this survives only if C is retained
  ];
  const result = pruneFeatureGraph(nodes, edges, [nodes[0]], ANCHORS, 10);
  const retained = new Set(result.nodes.map((n) => n.id));
  for (const e of result.edges) assert.ok(retained.has(e.source) && retained.has(e.target));
  const abEdges = result.edges.filter((e) => e.source === "A" && e.target === "B");
  assert.equal(abEdges.length, 1, "duplicate A->B edge collapsed");
});

test("prune is deterministic (same inputs -> deep-equal outputs)", () => {
  const nodes = Array.from({ length: 40 }, (_, i) => node(`N${i}`, i % 3 ? "LeaveThing" : `Plain${i}`, `n${i % 7}.go`));
  const edges = [edge("N1", "N0", 1), edge("N2", "N0", 2), edge("N3", "N6", 3)];
  const seeds = [nodes[0]];
  assert.deepEqual(
    pruneFeatureGraph(nodes, edges, seeds, ANCHORS, 15),
    pruneFeatureGraph(nodes, edges, seeds, ANCHORS, 15)
  );
});
