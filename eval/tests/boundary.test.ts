import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  boundaryRecall,
  boundaryReportFromRun,
  nodesFromRun,
  loadNodesFile,
  exitCodeFor,
  factPackNodesFromRun,
  fgReportFromRun,
  factPackReportFromRun,
  derivationDrops,
  buildLayeredReport,
  layeredExitCode,
  type BoundaryNode
} from "../boundary.ts";
import { validateBoundaryGold, loadBoundaryGold, type BoundaryGold } from "../boundary-gold.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "boundary-run-mini");
const LAYERS_MINI = join(import.meta.dirname, "fixtures", "boundary-layers-mini");
const WCP_LEAVE = join(import.meta.dirname, "..", "fixtures", "wcp-leave");
const DEMO_NODES = join(WCP_LEAVE, "demo-run-fg-nodes.json");
const LEAVE_GOLD = join(WCP_LEAVE, "boundary-gold.json");

function gold(items: any[], target = "t"): BoundaryGold {
  return validateBoundaryGold({ version: "boundary-gold-v1", target, items });
}

// ---- loader: positive + negative ----

test("validateBoundaryGold accepts a well-formed gold and preserves anchors", () => {
  const g = gold([{ id: "a", mustFind: true, anchors: [{ path: "x/y.go", name: "F" }], note: "n" }]);
  assert.equal(g.version, "boundary-gold-v1");
  assert.equal(g.items[0].anchors[0].name, "F");
});

test("validateBoundaryGold rejects malformed input", () => {
  const cases: Array<[any, RegExp]> = [
    [{ version: "nope", target: "t", items: [] }, /version/],
    [{ version: "boundary-gold-v1", items: [{ id: "a", mustFind: true, anchors: [{ path: "p" }] }] }, /target/],
    [{ version: "boundary-gold-v1", target: "t", items: [] }, /items.*non-empty/],
    [{ version: "boundary-gold-v1", target: "t", items: [{ id: "a", mustFind: true, anchors: [{ name: "F" }] }] }, /anchors\[0\]\.path/],
    [{ version: "boundary-gold-v1", target: "t", items: [{ id: "a", mustFind: true, anchors: [] }] }, /anchors.*non-empty/],
    [{ version: "boundary-gold-v1", target: "t", items: [{ id: "a", anchors: [{ path: "p" }] }] }, /mustFind/],
    [{ version: "boundary-gold-v1", target: "t", items: [{ id: "a", mustFind: true, anchors: [{ path: "p", lines: "no-numbers" }] }] }, /lines.*line number/],
    [{ version: "boundary-gold-v1", target: "t", items: [
      { id: "dup", mustFind: true, anchors: [{ path: "p" }] },
      { id: "dup", mustFind: true, anchors: [{ path: "q" }] }
    ] }, /duplicate item id/]
  ];
  for (const [raw, re] of cases) assert.throws(() => validateBoundaryGold(raw), re);
});

// ---- boundaryRecall: pure matching semantics ----

const NODES: BoundaryNode[] = [
  { filePath: "mymod/internal/svc/a.go", name: "Alpha", startLine: 10, endLine: 20 },
  { filePath: "othermod/routes/x.js", name: "GET /things", startLine: 1, endLine: 3 },
  { filePath: "mymod/internal/svc/b.go", name: "Beta", startLine: 5, endLine: 15 }
];

test("name anchor matches via module-relative suffix path (db form vs prefixed evidence)", () => {
  const r = boundaryRecall(NODES, gold([{ id: "i", mustFind: true, anchors: [{ path: "internal/svc/a.go", name: "Alpha" }] }]));
  assert.equal(r.summary.mustFindFound, 1);
  assert.match(r.found[0].via, /mymod\/internal\/svc\/a\.go::Alpha/);
});

test("name anchor matches via full-prefix exact path", () => {
  const r = boundaryRecall(NODES, gold([{ id: "i", mustFind: true, anchors: [{ path: "othermod/routes/x.js", name: "GET /things" }] }]));
  assert.equal(r.summary.mustFindFound, 1);
});

test("path match with a wrong name is a miss (name is exact)", () => {
  const r = boundaryRecall(NODES, gold([{ id: "i", mustFind: true, anchors: [{ path: "internal/svc/a.go", name: "AlphaX" }] }]));
  assert.equal(r.summary.mustFindMissing, 1);
});

test("lines anchor uses overlap semantics (overlap found, disjoint missed)", () => {
  const found = boundaryRecall(NODES, gold([{ id: "i", mustFind: true, anchors: [{ path: "internal/svc/b.go", lines: "6-8" }] }]));
  assert.equal(found.summary.mustFindFound, 1);
  const missed = boundaryRecall(NODES, gold([{ id: "i", mustFind: true, anchors: [{ path: "internal/svc/b.go", lines: "100-110" }] }]));
  assert.equal(missed.summary.mustFindMissing, 1);
});

test("anchors are OR: a later anchor rescues an item whose first anchor misses", () => {
  const r = boundaryRecall(NODES, gold([{ id: "i", mustFind: true, anchors: [
    { path: "internal/svc/nope.go", name: "Ghost" },
    { path: "internal/svc/a.go", name: "Alpha" }
  ] }]));
  assert.equal(r.summary.mustFindFound, 1);
});

test("path-only anchor matches on file presence alone", () => {
  const r = boundaryRecall(NODES, gold([{ id: "i", mustFind: true, anchors: [{ path: "internal/svc/a.go" }] }]));
  assert.equal(r.summary.mustFindFound, 1);
});

test("summary separates mustFind from optional and counts nodes/files", () => {
  const r = boundaryRecall(NODES, gold([
    { id: "m", mustFind: true, anchors: [{ path: "internal/svc/a.go", name: "Alpha" }] },
    { id: "opt-miss", mustFind: false, anchors: [{ path: "internal/svc/ghost.go", name: "Ghost" }] }
  ]));
  assert.deepEqual(
    { mf: r.summary.mustFind, mff: r.summary.mustFindFound, opt: r.summary.optional, optMiss: r.summary.optionalMissing },
    { mf: 1, mff: 1, opt: 1, optMiss: 1 }
  );
  assert.equal(r.summary.nodeCount, 3);
  assert.equal(r.summary.fileCount, 3);
  assert.equal(r.summary.pass, true); // optional miss does not fail the gate
});

test("boundaryRecall is deterministic (same inputs -> deep-equal twice)", () => {
  const g = gold([{ id: "i", mustFind: true, anchors: [{ path: "internal/svc/a.go", name: "Alpha" }] }]);
  assert.deepEqual(boundaryRecall(NODES, g), boundaryRecall(NODES, g));
});

// ---- run adapters: shape discriminant, union/dedup, source coverage ----

test("nodesFromRun selects only FG-shaped graph entries and unions+dedupes them", () => {
  const nodes = nodesFromRun(FIXTURES);
  const names = nodes.map((n) => n.name).sort();
  assert.deepEqual(names, ["Alpha", "Beta", "GET /things"]); // union of FG-mini-1 + FG-mini-2, Alpha deduped
  assert.equal(nodes.some((n) => n.name === "Decoy"), false); // CG-NODES-* decoy is NOT credited
});

test("boundaryReportFromRun annotates misses with coveredBySourceWindow and gates on mustFind", () => {
  const report = boundaryReportFromRun(FIXTURES, loadBoundaryGold(join(FIXTURES, "gold-fail.json")));
  assert.equal(report.summary.pass, false); // decoy-must is a mustFind miss (proves the decoy was not credited)
  assert.equal(exitCodeFor(report), 1);
  const byId = Object.fromEntries(report.missing.map((m) => [m.id, m.coveredBySourceWindow]));
  assert.equal(byId["decoy-must"], false);
  assert.equal(byId["gap-src-covered"], true);
  assert.equal(byId["gap-fully-out"], false);
});

test("run in pass mode exits 0 with every mustFind in bounds", () => {
  const report = boundaryReportFromRun(FIXTURES, loadBoundaryGold(join(FIXTURES, "gold-pass.json")));
  assert.equal(report.summary.pass, true);
  assert.equal(report.summary.mustFindMissing, 0);
  assert.equal(exitCodeFor(report), 0);
});

// ---- real artifact pins the baseline ----

// ---- fact-pack (consumption) layer + layered report ----

test("factPackNodesFromRun unions every feature's fact-pack items and maps line->startLine", () => {
  const nodes = factPackNodesFromRun(LAYERS_MINI);
  assert.deepEqual(nodes.map((n) => n.name).sort(), ["Alpha"]); // the one fact-pack item the mini run claims
  assert.deepEqual(nodes[0], { filePath: "mod/svc/a.go", name: "Alpha", startLine: 10, endLine: 20 });
});

test("factPackNodesFromRun returns an empty set when a run has no fact pack", () => {
  assert.deepEqual(factPackNodesFromRun(FIXTURES), []); // boundary-run-mini has evidence.json but no context/features
});

test("fg and factpack run reports stamp their layer; factpack drops what fg captured", () => {
  const gold = loadBoundaryGold(join(LAYERS_MINI, "gold-both.json"));
  const fg = fgReportFromRun(LAYERS_MINI, gold);
  const factpack = factPackReportFromRun(LAYERS_MINI, gold);
  assert.equal(fg.layer, "fg");
  assert.equal(factpack.layer, "factpack");
  assert.equal(fg.summary.pass, true); // Alpha + Beta both in the FG node set
  assert.equal(factpack.summary.pass, false); // Beta dropped from the fact pack
  assert.deepEqual(factpack.missing.filter((m) => m.mustFind).map((m) => m.id), ["beta"]);
});

test("derivationDrops is exactly found@fg ∧ missing@factpack", () => {
  const fg = boundaryRecall(
    [
      { filePath: "mod/a.go", name: "Kept", startLine: 1, endLine: 9 },
      { filePath: "mod/b.go", name: "Dropped", startLine: 1, endLine: 9 }
    ],
    gold([
      { id: "kept", mustFind: true, anchors: [{ path: "mod/a.go", name: "Kept" }] },
      { id: "dropped", mustFind: true, anchors: [{ path: "mod/b.go", name: "Dropped" }] },
      { id: "never-anywhere", mustFind: false, anchors: [{ path: "mod/z.go", name: "Ghost" }] }
    ])
  );
  const factpack = boundaryRecall(
    [{ filePath: "mod/a.go", name: "Kept", startLine: 1, endLine: 9 }], // Dropped is not in the fact pack
    gold([
      { id: "kept", mustFind: true, anchors: [{ path: "mod/a.go", name: "Kept" }] },
      { id: "dropped", mustFind: true, anchors: [{ path: "mod/b.go", name: "Dropped" }] },
      { id: "never-anywhere", mustFind: false, anchors: [{ path: "mod/z.go", name: "Ghost" }] }
    ])
  );
  const drops = derivationDrops(fg, factpack);
  assert.deepEqual(drops.map((d) => d.id), ["dropped"]); // Kept survives; never-anywhere is missing at BOTH layers
  assert.equal(drops[0].mustFind, true);
});

test("buildLayeredReport unions the requested layers' gates and layeredExitCode follows", () => {
  const gold = loadBoundaryGold(join(LAYERS_MINI, "gold-both.json"));
  const fg = fgReportFromRun(LAYERS_MINI, gold);
  const factpack = factPackReportFromRun(LAYERS_MINI, gold);
  const both = buildLayeredReport("t", fg, factpack, ["fg", "factpack"]);
  assert.equal(both.pass, false); // factpack fails -> union fails
  assert.equal(layeredExitCode(both), 1);
  assert.deepEqual(both.derivationDrops.map((d) => d.id), ["beta"]);
  const fgOnly = buildLayeredReport("t", fg, undefined, ["fg"]);
  assert.equal(fgOnly.pass, true); // only fg requested, and fg passes
  assert.equal(layeredExitCode(fgOnly), 0);
  assert.deepEqual(fgOnly.derivationDrops, []); // no factpack report -> no drops computed
});

test("real demo FG nodes x wcp-leave gold: mustFind miss is exactly the 3 T1 out-of-bounds symbols", () => {
  const report = boundaryRecall(loadNodesFile(DEMO_NODES), loadBoundaryGold(LEAVE_GOLD));
  assert.deepEqual(
    { mf: report.summary.mustFind, found: report.summary.mustFindFound, miss: report.summary.mustFindMissing },
    { mf: 13, found: 10, miss: 3 }
  );
  const missIds = report.missing.filter((m) => m.mustFind).map((m) => m.id).sort();
  assert.deepEqual(missIds, ["T1-calculationAuto", "T1-isIgnoreHolidayLvType", "T1-syncLvCompleted"]);
  const foundIds = report.found.map((f) => f.id).sort();
  assert.deepEqual(foundIds, [
    "T2-handlers-leaveRoute", "T2-js-getMyLeaves", "T2-js-leaveRequestPreCheck", "T2-js-recordTakeLeaveHours",
    "T2-leave-approve", "T2-leave-creation", "T2-leave-export", "T2-leave-maxAvailableHoliday",
    "T2-leaveHistory-getHolidayHour", "T2-leaveHistory-updateHolidayHour"
  ]);
  assert.equal(report.summary.nodeCount, 250);
  assert.equal(report.summary.fileCount, 45);
  assert.equal(exitCodeFor(report), 1); // honest red today; 57B-371 turns it green
});
