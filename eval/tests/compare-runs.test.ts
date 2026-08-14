import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { computeRunStats } from "../run-stats.ts";
import { extractKnowledge, type Knowledge } from "../knowledge.ts";
import {
  compareRuns,
  anchorsOverlap,
  diffAnchors,
  collectFactAnchors,
  type Anchor,
  type MetricDelta,
  type RunComparison
} from "../compare-runs.ts";

const RUN_A = join(import.meta.dirname, "fixtures", "run-observe-mini");
const RUN_B = join(import.meta.dirname, "fixtures", "run-observe-mini-b");

function build(): RunComparison {
  return compareRuns(computeRunStats(RUN_A), computeRunStats(RUN_B), extractKnowledge(RUN_A), extractKnowledge(RUN_B));
}

function metric(comparison: RunComparison, key: string): MetricDelta {
  const found = comparison.metrics.flatMap((group) => group.metrics).find((m) => m.metric === key);
  assert.ok(found, `metric ${key} present`);
  return found!;
}

test("total wall clock delta is exact a/b/delta/pct and labels the faster run an improvement", () => {
  const total = metric(build(), "totalWallMs");
  assert.deepEqual(
    { a: total.a, b: total.b, delta: total.delta, pct: total.pct },
    { a: 370_000, b: 300_000, delta: -70_000, pct: -18.9 }
  );
  assert.equal(total.direction, "down");
  assert.equal(total.assessment, "improvement");
  assert.equal(total.notable, true);
});

test("a per-stage wall clock that went UP is labelled a regression (sign/label correct)", () => {
  const authoring = metric(build(), "stage.authoring");
  assert.deepEqual({ a: authoring.a, b: authoring.b, delta: authoring.delta }, { a: 200_000, b: 210_000, delta: 10_000 });
  assert.equal(authoring.direction, "up");
  assert.equal(authoring.assessment, "regression");
  // A stage present only in A (reflection) still appears, charged 0 on the B side.
  const reflection = metric(build(), "stage.reflection");
  assert.deepEqual({ a: reflection.a, b: reflection.b, delta: reflection.delta }, { a: 20_000, b: 0, delta: -20_000 });
});

test("search + counter deltas are exact, and count metrics never claim improvement/regression", () => {
  const comparison = build();
  const searches = metric(comparison, "timelineSearchEvents");
  assert.deepEqual({ a: searches.a, b: searches.b, delta: searches.delta, pct: searches.pct }, { a: 2, b: 1, delta: -1, pct: -50 });
  assert.equal(searches.assessment, "neutral"); // fewer searches is not asserted good or bad

  const windows = metric(comparison, "sourceWindows");
  assert.deepEqual({ a: windows.a, b: windows.b, delta: windows.delta, pct: windows.pct }, { a: 3, b: 4, delta: 1, pct: 33.3 });
  assert.equal(windows.assessment, "neutral");
  assert.equal(windows.direction, "up");
});

test("fact-anchors align by overlapping cited window: gained only in B, lost only in A, shared in both", () => {
  const k = build().knowledge;
  assert.deepEqual(k.factAnchors.gained, [{ path: "svc/audit/log.go", startLine: 8, endLine: 25 }]);
  assert.deepEqual(k.factAnchors.lost, [{ path: "svc/notify/email.go", startLine: 5, endLine: 30 }]);
  // login.go (10-42 vs 12-40, and 44-60 vs 44-60) + scope query.go overlap => 3 retained.
  assert.equal(k.factAnchors.shared, 3);
});

test("marker distribution delta is exact and emitted in the stable marker order", () => {
  const dist = build().knowledge.markerDistribution;
  assert.deepEqual(dist.map((d) => d.marker), ["fact", "verified", "inferred", "unavailable"]);
  assert.deepEqual(
    dist.map((d) => [d.marker, d.a, d.b, d.delta]),
    [["fact", 2, 3, 1], ["verified", 1, 0, -1], ["inferred", 1, 1, 0], ["unavailable", 1, 0, -1]]
  );
});

test("relations align by trace step anchors: one gained, one lost, one retained", () => {
  const relations = build().knowledge.relations;
  assert.deepEqual(relations.gained.map((r) => r.id), ["TR-2"]);
  assert.deepEqual(relations.lost.map((r) => r.id), ["TR-notify"]);
  assert.equal(relations.shared, 1);
});

test("coverage delta reports a dimension whose status changed, aligned by dimension not id", () => {
  const coverage = build().knowledge.coverage;
  assert.deepEqual(coverage.changed, [{ dimension: "data-scope", a: "found", b: "searched-not-found" }]);
  assert.deepEqual(coverage.added, []);
  assert.deepEqual(coverage.removed, []);
});

test("unknowns delta counts total and per-source", () => {
  const unknowns = build().knowledge.unknowns;
  assert.deepEqual(
    { a: unknowns.a, b: unknowns.b, delta: unknowns.delta },
    { a: 2, b: 1, delta: -1 }
  );
  assert.deepEqual(unknowns.bySource, { claim: { a: 1, b: 0 }, workitem: { a: 1, b: 1 } });
});

test("anchor alignment rule: same path overlapping = same fact; same path disjoint = different", () => {
  const base: Anchor = { path: "a.ts", startLine: 10, endLine: 20 };
  assert.equal(anchorsOverlap(base, { path: "a.ts", startLine: 18, endLine: 30 }), true); // overlap
  assert.equal(anchorsOverlap(base, { path: "a.ts", startLine: 20, endLine: 25 }), true); // touch at boundary
  assert.equal(anchorsOverlap(base, { path: "a.ts", startLine: 21, endLine: 30 }), false); // disjoint on same path
  assert.equal(anchorsOverlap(base, { path: "b.ts", startLine: 10, endLine: 20 }), false); // different path
});

test("diffAnchors treats an overlapping same-path window as retained but a disjoint one as gained/lost", () => {
  const a: Knowledge = {
    runDir: "A", relations: [], coverage: [], unknowns: [], prepareHorizon: { files: [], scopeText: "" },
    facts: [{ ref: "d#c1", documentId: "d", claimId: "c1", statement: "", marker: "fact", citedEvidenceCount: 0, searchEvidence: [], windows: [
      { id: "S-1", path: "svc/x.ts", startLine: 10, endLine: 20 },
      { id: "S-2", path: "svc/x.ts", startLine: 100, endLine: 120 }
    ] }]
  };
  const b: Knowledge = {
    runDir: "B", relations: [], coverage: [], unknowns: [], prepareHorizon: { files: [], scopeText: "" },
    facts: [{ ref: "d#c9", documentId: "d", claimId: "c9", statement: "", marker: "fact", citedEvidenceCount: 0, searchEvidence: [], windows: [
      { id: "S-9", path: "svc/x.ts", startLine: 15, endLine: 25 },  // overlaps A's 10-20 -> retained
      { id: "S-8", path: "svc/x.ts", startLine: 300, endLine: 330 } // disjoint on same path -> gained
    ] }]
  };
  const delta = diffAnchors(collectFactAnchors(a), collectFactAnchors(b));
  assert.deepEqual(delta.gained, [{ path: "svc/x.ts", startLine: 300, endLine: 330 }]);
  assert.deepEqual(delta.lost, [{ path: "svc/x.ts", startLine: 100, endLine: 120 }]);
  assert.equal(delta.shared, 1);
});

test("comparison is a pure report: no pass/fail field, both run ids surfaced", () => {
  const comparison = build();
  assert.equal("pass" in comparison, false);
  assert.equal(comparison.a.runId, "run-observe-mini");
  assert.equal(comparison.b.runId, "run-observe-mini-b");
});
