import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateFeatureGraph, allocateFeatureGraphRecorded, consonantSkeleton, deriveAbbreviations, nameTokens
} from "../src/attribution/allocator.ts";
import { CONTRIBUTION_CHANNELS, WEIGHTS } from "../src/attribution/selection-trace.ts";
import { NO_RECALL } from "../src/attribution/allocator.ts";

function node(id: string, name: string, filePath: string, kind = "function"): any {
  return { id, name, filePath, kind, signature: null, startLine: 1, endLine: 2 };
}

function edge(source: string, target: string, line: number, kind = "calls"): any {
  return { source, target, kind, line, metadata: {} };
}

test("derived vocabulary remains deterministic and target-independent", () => {
  assert.equal(consonantSkeleton("Leave"), "lv");
  assert.equal(consonantSkeleton("holiday"), "hldy");
  assert.equal(consonantSkeleton("pto"), null);
  assert.equal(consonantSkeleton("请假"), null);
  assert.deepEqual([...deriveAbbreviations(["leave", "pto", "请假", "holiday"])].sort(), ["hldy", "lv"]);
  assert.ok(nameTokens("isIgnoreHolidayLvType").has("holiday"));
});

test("every pool node is eligible through fallback; no signal threshold admits candidates", () => {
  const nodes = Array.from({ length: 12 }, (_, index) => node(`N${index}`, "Unrelated", `src/z${index}.ts`));
  const recorded = allocateFeatureGraphRecorded(nodes, [], [], ["leave"], 5, NO_RECALL);
  assert.equal(recorded.trace.pool.length, 12);
  assert.equal(recorded.nodes.length, 5);
  for (const row of recorded.trace.pool) {
    assert.ok(row.contributions.some((item) => item.sourceChannel === "fallback"));
  }
});

test("producer raw strengths are ranked locally and only normalized ranks are fused", () => {
  const nodes = [
    node("SEED", "Root", "src/root.ts"),
    node("MATCH", "approveLeave", "src/leave.ts"),
    node("CALLER", "execute", "src/flow.ts")
  ];
  const recorded = allocateFeatureGraphRecorded(nodes, [edge("CALLER", "MATCH", 8)], [nodes[0]], ["leave"], 3, NO_RECALL);
  assert.equal(recorded.trace.fusion.rawScoresSummedAcrossChannels, false);
  for (const row of recorded.trace.pool) for (const contribution of row.contributions) {
    assert.ok(CONTRIBUTION_CHANNELS.includes(contribution.sourceChannel));
    assert.ok(Number.isInteger(contribution.rank) && contribution.rank > 0);
    assert.equal(
      contribution.normalizedContribution,
      WEIGHTS[contribution.sourceChannel] / (recorded.trace.fusion.rankConstant + contribution.rank)
    );
  }
});

test("each contribution carries source channel, reason, anchor and propagation path", () => {
  const nodes = [node("MATCH", "approveLeave", "src/leave.ts"), node("CALLER", "execute", "src/flow.ts")];
  const recorded = allocateFeatureGraphRecorded(nodes, [edge("CALLER", "MATCH", 8)], [], ["leave"], 2, NO_RECALL);
  const relation = recorded.trace.pool.find((row) => row.nodeId === "CALLER")!.contributions
    .find((item) => item.sourceChannel === "relation");
  assert.ok(relation);
  assert.match(relation.reason, /outgoing calls/);
  assert.equal(relation.anchor, "leave");
  assert.deepEqual(relation.propagationPath, ["CALLER->MATCH:calls"]);
  for (const row of recorded.trace.pool) for (const contribution of row.contributions) {
    assert.equal(contribution.anchor === null, contribution.sourceChannel === "fallback");
  }
});

test("relation propagation is directional: callers contribute, called hubs do not", () => {
  const nodes = [
    node("MATCH", "approveLeave", "src/leave.ts"),
    node("CALLER", "execute", "src/flow.ts"),
    node("HUB", "shared", "src/shared.ts")
  ];
  const recorded = allocateFeatureGraphRecorded(nodes, [
    edge("CALLER", "MATCH", 8),
    edge("MATCH", "HUB", 9)
  ], [], ["leave"], 3, NO_RECALL);
  const channel = (id: string): string[] => recorded.trace.pool.find((row) => row.nodeId === id)!.contributions.map((row) => row.sourceChannel);
  assert.ok(channel("CALLER").includes("relation"));
  assert.ok(!channel("HUB").includes("relation"));
});

test("the one seat cap produces total, named displacement and never over-allocates", () => {
  const nodes = Array.from({ length: 30 }, (_, index) => node(`N${index}`, index % 2 ? "LeaveThing" : "Other", `src/${index}.ts`));
  const recorded = allocateFeatureGraphRecorded(nodes, [], [nodes[0]], ["leave"], 7, NO_RECALL);
  assert.equal(recorded.nodes.length, 7);
  assert.equal(recorded.trace.pool.filter((row) => row.outcome !== "displaced").length, 7);
  for (const row of recorded.trace.pool) assert.equal(row.displacedBy, row.outcome === "displaced" ? "seat-cap" : null);
});

test("weight perturbations are counter-explainable by contribution deltas", () => {
  const nodes = Array.from({ length: 40 }, (_, index) =>
    node(`N${index}`, index % 3 === 0 ? `LeaveThing${index}` : `Helper${index}`, `src/${String(index).padStart(2, "0")}.ts`));
  const base = allocateFeatureGraphRecorded(nodes, [], [], ["leave"], 10, NO_RECALL);
  const moved = allocateFeatureGraphRecorded(nodes, [], [], ["leave"], 10, NO_RECALL, { weights: { ...WEIGHTS, lexical: 1.25 } });
  const baseIds = new Set(base.nodes.map((row) => String(row.id)));
  const movedIds = new Set(moved.nodes.map((row) => String(row.id)));
  const gained = [...movedIds].filter((id) => !baseIds.has(id));
  const lost = [...baseIds].filter((id) => !movedIds.has(id));
  assert.equal(gained.length, lost.length);
  for (const id of gained) {
    const before = base.trace.pool.find((row) => row.nodeId === id)!;
    const after = moved.trace.pool.find((row) => row.nodeId === id)!;
    const beforeLexical = before.contributions.find((row) => row.sourceChannel === "lexical")?.normalizedContribution ?? 0;
    const afterLexical = after.contributions.find((row) => row.sourceChannel === "lexical")?.normalizedContribution ?? 0;
    assert.ok(afterLexical > beforeLexical, `${id} gained a seat without a lexical counter`);
  }
});

test("document-frequency and derived expansion are explicit ablations, not hidden admission gates", () => {
  const nodes = [
    node("A", "approveLeave", "src/leave.ts"),
    node("B", "syncLvCompleted", "src/jobs/sync.ts"),
    node("C", "helper", "src/helper.ts")
  ];
  const full = allocateFeatureGraphRecorded(nodes, [], [], ["leave"], 3, NO_RECALL);
  const ablated = allocateFeatureGraphRecorded(nodes, [], [], ["leave"], 3, NO_RECALL, { documentFrequency: false, derivedTerms: false });
  assert.equal(full.trace.pool.length, ablated.trace.pool.length);
  assert.ok(full.trace.pool.find((row) => row.nodeId === "B")!.contributions.some((row) => row.sourceChannel === "derived"));
  assert.ok(!ablated.trace.pool.find((row) => row.nodeId === "B")!.contributions.some((row) => row.sourceChannel === "derived"));
});

test("trace-free and recorded paths are byte-identical and deterministic", () => {
  const nodes = Array.from({ length: 25 }, (_, index) => node(`N${index}`, `Leave${index}`, `src/${index}.ts`));
  const edges = nodes.slice(1).map((_, index) => edge(`N${index + 1}`, `N${index}`, index + 1));
  const recorded = allocateFeatureGraphRecorded(nodes, edges, [nodes[0]], ["leave"], 10, NO_RECALL);
  const plain = allocateFeatureGraph(nodes, edges, [nodes[0]], ["leave"], 10, NO_RECALL);
  assert.equal(JSON.stringify({ nodes: recorded.nodes, edges: recorded.edges }), JSON.stringify(plain));
  assert.equal(JSON.stringify(recorded), JSON.stringify(allocateFeatureGraphRecorded(nodes, edges, [nodes[0]], ["leave"], 10, NO_RECALL)));
});
