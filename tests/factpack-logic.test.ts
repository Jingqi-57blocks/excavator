import test from "node:test";
import assert from "node:assert/strict";
import { logicItems, logicClaimKey, LOGIC_LOCATION_SEP, type LogicFeatureGraph, type LogicSelection } from "../src/context/factpack-logic.ts";
import { buildFactPack } from "../src/context/factpack.ts";
import { auditRescuedLogicCoverage } from "../src/assurance/assurance.ts";
import { stableJson } from "../src/core/util.ts";
import type { SourceReader } from "../src/snapshot/source.ts";
import type { EvidenceItem } from "../src/core/types.ts";

// Synthetic small-graph unit tests for the complement enumeration. No fixtures, no CodeGraph: the rule,
// the tiering, the in-degree cap, the claim/kind exclusion and the honest empty case, each in isolation.

const KIND_CATEGORIES = new Set(["route", "class", "interface", "model", "enum", "import", "file"]);
const ROUTE_KINDS = new Set(["route"]);

function selection(over: Partial<LogicSelection> = {}): LogicSelection {
  return { claimedLocations: new Set(), excludedKinds: KIND_CATEGORIES, routeKinds: ROUTE_KINDS, cap: 3, ...over };
}

test("tiering: rescued < seed < route-pointed < rest, with the rescue reason carried as the signal", () => {
  const graph: LogicFeatureGraph = {
    nodes: [
      { id: "rest", kind: "function", name: "rest", filePath: "svc/z.go", startLine: 40, endLine: 41 },
      { id: "route-target", kind: "method", name: "approve", filePath: "svc/h.go", startLine: 30, endLine: 31 },
      { id: "seed", kind: "function", name: "createLeave", filePath: "svc/a.go", startLine: 10, endLine: 11 },
      { id: "rescued", kind: "function", name: "calcHours", filePath: "svc/c.go", startLine: 5, endLine: 6, rescued: "anchor-token leave" },
      { id: "r", kind: "route", name: "POST /leave", filePath: "svc/r.go", startLine: 1, endLine: 1 } // excluded kind
    ],
    edges: [{ source: "r", target: "route-target", kind: "calls" }],
    seeds: [{ id: "seed" }]
  };
  const items = logicItems(graph, selection());
  assert.deepEqual(items.map((item) => item.name), ["calcHours", "createLeave", "approve", "rest"]);
  assert.deepEqual(items.map((item) => item.rank), [0, 1, 2, 3]);
  // The excluded-kind route never becomes a logic item.
  assert.ok(!items.some((item) => item.name === "POST /leave"));
  // Only the rescued (tier-0) item carries a signal, and it is the rescue reason.
  assert.equal(items[0].signal, "anchor-token leave");
  assert.ok(items.slice(1).every((item) => item.signal === undefined));
});

test("membership: an already-claimed exact location and import/file kinds are excluded", () => {
  const graph: LogicFeatureGraph = {
    nodes: [
      { id: "keep", kind: "function", name: "keep", filePath: "svc/a.go", startLine: 10, endLine: 12 },
      { id: "claimed", kind: "function", name: "claimedAtSameLine", filePath: "svc/a.go", startLine: 20, endLine: 22 },
      { id: "imp", kind: "import", name: "fmt", filePath: "svc/a.go", startLine: 1, endLine: 1 },
      { id: "fil", kind: "file", name: "a.go", filePath: "svc/a.go", startLine: 0, endLine: 0 }
    ],
    edges: [],
    seeds: []
  };
  // A structural category already claimed svc/a.go:20 — the exact (filePath, line), not a range.
  const items = logicItems(graph, selection({ claimedLocations: new Set([logicClaimKey("svc/a.go", 20)]) }));
  assert.deepEqual(items.map((item) => item.name), ["keep"]);
});

test("claim exclusion is exact-line and path-normalized (a backslash path still matches)", () => {
  const graph: LogicFeatureGraph = {
    nodes: [{ id: "n", kind: "function", name: "fn", filePath: "svc\\win.go", startLine: 7, endLine: 9 }],
    edges: [],
    seeds: []
  };
  // The claim was recorded with a forward-slash path; normalization makes the two agree.
  const items = logicItems(graph, selection({ claimedLocations: new Set([logicClaimKey("svc/win.go", 7)]) }));
  assert.deepEqual(items, []);
});

test("in-degree cap: one caller's multiplicity is capped so a broad-fan-in node outranks a hot single caller", () => {
  const nodes: LogicFeatureGraph["nodes"] = [
    { id: "A", kind: "function", name: "A", filePath: "z/a.go", startLine: 1, endLine: 2 }, // one caller, 5 parallel edges
    { id: "B", kind: "function", name: "B", filePath: "z/b.go", startLine: 1, endLine: 2 }, // four distinct callers
    { id: "cA", kind: "function", name: "cA", filePath: "c/a.go", startLine: 1, endLine: 2 },
    { id: "c1", kind: "function", name: "c1", filePath: "c/1.go", startLine: 1, endLine: 2 },
    { id: "c2", kind: "function", name: "c2", filePath: "c/2.go", startLine: 1, endLine: 2 },
    { id: "c3", kind: "function", name: "c3", filePath: "c/3.go", startLine: 1, endLine: 2 },
    { id: "c4", kind: "function", name: "c4", filePath: "c/4.go", startLine: 1, endLine: 2 }
  ];
  const edges = [
    ...Array.from({ length: 5 }, () => ({ source: "cA", target: "A", kind: "calls" })),
    { source: "c1", target: "B", kind: "calls" },
    { source: "c2", target: "B", kind: "calls" },
    { source: "c3", target: "B", kind: "calls" },
    { source: "c4", target: "B", kind: "calls" }
  ];
  const graph: LogicFeatureGraph = { nodes, edges, seeds: [] };

  const rankOf = (items: ReturnType<typeof logicItems>, name: string) => items.find((item) => item.name === name)!.rank!;
  const capped = logicItems(graph, selection({ cap: 3 }));
  // Capped: A's in-degree = min(5,3) = 3 < B's 4, so B (broad fan-in) ranks ahead of A.
  assert.ok(rankOf(capped, "B") < rankOf(capped, "A"));
  // Uncapped: A's raw in-degree = 5 > B's 4, so the single hot caller would have won — proving the cap bit.
  const uncapped = logicItems(graph, selection({ cap: 1_000 }));
  assert.ok(rankOf(uncapped, "A") < rankOf(uncapped, "B"));
});

const IDLE_READER = { window: async () => { throw new Error("unused"); } } as unknown as SourceReader;

test("buildFactPack: logic is method none (honest empty) when no feature graph is supplied", async () => {
  const pack = await buildFactPack({ snapshotId: "snap", featureKey: "k", files: [], graph: null, sourceReader: IDLE_READER });
  const logic = pack.coverage.find((entry) => entry.category === "logic")!;
  assert.equal(logic.method, "none");
  assert.equal(logic.itemCount, 0);
  assert.ok(!pack.items.some((item) => item.category === "logic"));
});

test("buildFactPack: with a feature graph, logic enumerates the complement in rank order (method graph)", async () => {
  const featureGraph: LogicFeatureGraph = {
    nodes: [
      { id: "seed", kind: "function", name: "createLeave", filePath: "svc/a.go", startLine: 10, endLine: 11 },
      { id: "rescued", kind: "function", name: "calcHours", filePath: "svc/c.go", startLine: 5, endLine: 6, rescued: "abbrev-token lv" },
      { id: "r", kind: "route", name: "POST /leave", filePath: "svc/r.go", startLine: 1, endLine: 1 }
    ],
    edges: [],
    seeds: [{ id: "seed" }]
  };
  const pack = await buildFactPack({ snapshotId: "snap", featureKey: "k", files: [], graph: null, sourceReader: IDLE_READER, featureGraph });
  const logic = pack.coverage.find((entry) => entry.category === "logic")!;
  assert.equal(logic.method, "graph");
  assert.equal(logic.itemCount, 2); // the route (excluded kind) is not a logic item
  const logicItemsOut = pack.items.filter((item) => item.category === "logic");
  assert.deepEqual(logicItemsOut.map((item) => item.name), ["calcHours", "createLeave"]); // rescued (tier0) before seed (tier1)
  assert.equal(logicItemsOut[0].signal, "abbrev-token lv");
});

test("the separator is an escaped control char, and no output carries a literal NUL byte", () => {
  assert.notEqual(LOGIC_LOCATION_SEP, "\u0000");
  assert.ok(!logicClaimKey("svc/a.go", 10).includes("\u0000"));
  const graph: LogicFeatureGraph = {
    nodes: [{ id: "n", kind: "function", name: "fn", filePath: "svc/a.go", startLine: 1, endLine: 2, rescued: "anchor-token leave" }],
    edges: [],
    seeds: []
  };
  assert.ok(!stableJson(logicItems(graph, selection())).includes("\u0000"));
});

function logicEvidence(items: Array<{ name?: string; filePath?: string; line?: number; signal?: string }>): EvidenceItem {
  return { id: "FACT-k-logic-snap", snapshotId: "snap", kind: "derived", title: "Fact pack: logic", data: { category: "logic", items }, reason: "test", digest: "d" };
}

test("rescued-logic advisory: warns (once) for each rescued fact the report leaves unrepresented, only rescued ones", () => {
  const factEvidence = [logicEvidence([
    { name: "calcHours", filePath: "svc/c.go", line: 5, signal: "anchor-token leave" },
    { name: "plainLogic", filePath: "svc/a.go", line: 1 } // no signal -> never nagged
  ])];
  // A report that names the non-rescued item but not the rescued one still warns about the rescued one.
  const missing = auditRescuedLogicCoverage("doc", "the report mentions plainLogic only", factEvidence);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].level, "warning");
  assert.match(missing[0].message, /calcHours/);
  // Mentioning the rescued item (by name or path:line) satisfies the advisory.
  assert.deepEqual(auditRescuedLogicCoverage("doc", "we cover calcHours here", factEvidence), []);
  assert.deepEqual(auditRescuedLogicCoverage("doc", "see svc/c.go:5 for the rule", factEvidence), []);
  // No logic evidence at all -> nothing to reconcile.
  assert.deepEqual(auditRescuedLogicCoverage("doc", "anything", []), []);
});
