import test from "node:test";
import assert from "node:assert/strict";
import { readObligations } from "../src/obligation/read-obligations.ts";
import type { BoundaryFunctionsArtifact } from "../src/facts/probe/boundary-functions.ts";
import type { FeatureFactPack } from "../src/base/types.ts";
import { v2Pack } from "./factpack-v2-fixture.ts";

// The second source widens the denominator, which is the point — but widening a frozen artifact is exactly
// where a regression hides. These tests pin the three properties that make the widening safe: without a
// boundary artifact nothing changes at all; a first-source obligation is never re-judged by a supplement;
// and every candidate the second source declined to add is still counted somewhere a reader can see.

const PATH = "svc/internal/handlers/leave/service.go";

function factPack(items: Array<{ name: string; line: number; endLine?: number; signal?: string }>): FeatureFactPack {
  return v2Pack(items.map((item) => ({ category: "logic", name: item.name, filePath: PATH, line: item.line, endLine: item.endLine, signal: item.signal })), { snapshotId: "s", featureKey: "leave" });
}

function boundaryOf(functions: Array<{ name: string; startLine: number; endLine: number; probe?: "decision" | "no-decision" | "unavailable"; path?: string }>, extra: Partial<BoundaryFunctionsArtifact> = {}): BoundaryFunctionsArtifact {
  return {
    version: "boundary-functions-v1",
    snapshotId: "s",
    graphAvailable: true,
    enumeratedKinds: ["function", "method"],
    warnings: [],
    features: [{
      featureKey: "leave",
      files: 1,
      filesWithoutCandidates: [],
      truncated: false,
      warnings: [],
      functions: functions.map((fn) => ({ path: fn.path ?? PATH, name: fn.name, graphKind: "method", startLine: fn.startLine, endLine: fn.endLine, probe: fn.probe ?? "decision" })),
    }],
    ...extra,
  };
}

test("with no boundary artifact the output is byte-identical to the first source alone", () => {
  const packs = [factPack([{ name: "Approve", line: 362, endLine: 739 }, { name: "LeaveComment", line: 20, endLine: 20 }])];
  const before = readObligations(packs, []);
  const withNull = readObligations(packs, [], null);
  const withUndefined = readObligations(packs, [], undefined);
  assert.equal(JSON.stringify(withNull), JSON.stringify(before));
  assert.equal(JSON.stringify(withUndefined), JSON.stringify(before));
  assert.equal(before.summary.secondSource, undefined, "the block must be absent, not empty");
});

// The measured miss this slice exists for: the file was inside the boundary with obligations above and
// below, and the two functions in the gap carried none.
test("a decision function the first source never enumerated becomes an obligation of its own kind", () => {
  const packs = [factPack([{ name: "NewLvService", line: 48, endLine: 53 }, { name: "Approve", line: 362, endLine: 739 }])];
  const result = readObligations(packs, [], boundaryOf([
    { name: "Creation", startLine: 56, endLine: 133 },
    { name: "Demand", startLine: 136, endLine: 274 },
  ]));
  const supplements = result.obligations.filter((o) => o.kind === "boundary-decision-function");
  assert.deepEqual(supplements.map((o) => `${o.name}@${o.startLine}-${o.endLine}`), ["Creation@56-133", "Demand@136-274"]);
  assert.deepEqual(supplements.map((o) => o.tier), [2, 2]);
  assert.deepEqual(supplements.map((o) => o.gated), [false, false], "gating stays rescued-only");
  assert.equal(result.summary.secondSource?.added, 2);
  assert.equal(result.summary.counted, 4, "the denominator honestly grows");
});

test("a function both sources found is counted once, keeping the first source's kind and id", () => {
  const packs = [factPack([{ name: "Approve", line: 362, endLine: 739 }])];
  const result = readObligations(packs, [], boundaryOf([{ name: "Approve", startLine: 362, endLine: 739 }]));
  assert.equal(result.obligations.length, 1);
  assert.equal(result.obligations[0].kind, "decision-function");
  assert.equal(result.summary.secondSource?.duplicate, 1);
  assert.equal(result.summary.secondSource?.added, 0);
});

test("a supplement inside a counted first-source span is excluded as contained, and stays visible", () => {
  const packs = [factPack([{ name: "Approve", line: 362, endLine: 739 }])];
  const result = readObligations(packs, [], boundaryOf([{ name: "inner", startLine: 400, endLine: 420 }]));
  const inner = result.obligations.find((o) => o.name === "inner");
  assert.equal(inner?.excluded, "contained");
  assert.equal(result.summary.counted, 1, "the container already carries the read obligation");
  assert.equal(result.summary.total, 2, "excluded means visible, not dropped");
});

// A supplement may legitimately span a first-source item (an outer component around a retained inner
// symbol). Re-judging the first-source item would remove it from reconciliation entirely.
test("a first-source obligation is never re-judged as contained by a supplement that spans it", () => {
  const packs = [factPack([{ name: "innerRetained", line: 400, endLine: 420 }])];
  const result = readObligations(packs, [], boundaryOf([{ name: "OuterComponent", startLine: 300, endLine: 500 }]));
  const retained = result.obligations.find((o) => o.name === "innerRetained");
  assert.equal(retained?.excluded, undefined, "the first source's judgement is frozen");
  assert.equal(result.obligations.find((o) => o.name === "OuterComponent")?.excluded, undefined);
  assert.equal(result.summary.counted, 2);
});

test("a supplement nested in another supplement follows the ordinary containment rule", () => {
  const result = readObligations([factPack([])], [], boundaryOf([
    { name: "outer", startLine: 10, endLine: 90 },
    { name: "nested", startLine: 20, endLine: 30 },
  ]));
  assert.equal(result.obligations.find((o) => o.name === "nested")?.excluded, "contained");
  assert.equal(result.obligations.find((o) => o.name === "outer")?.excluded, undefined);
});

test("candidates the filter declined are counted, so the filter's own cost is auditable", () => {
  const result = readObligations([factPack([])], [], boundaryOf([
    { name: "Branching", startLine: 10, endLine: 20 },
    { name: "Getter", startLine: 30, endLine: 33, probe: "no-decision" },
    { name: "PerlSub", startLine: 40, endLine: 50, probe: "unavailable", path: "lib/ZMS/Leave.pm" },
  ]));
  const second = result.summary.secondSource;
  assert.equal(second?.candidates, 3);
  assert.equal(second?.decisionBearing, 1);
  assert.equal(second?.added, 1);
  assert.equal(second?.unprobed, 1, "a language nobody could judge is counted, not assumed clean");
  assert.deepEqual(result.obligations.map((o) => o.name), ["Branching"]);
});

test("a source-only run records the absence of the second source rather than omitting the block", () => {
  const result = readObligations([factPack([{ name: "Approve", line: 362, endLine: 739 }])], [], boundaryOf([], { graphAvailable: false }));
  assert.equal(result.summary.secondSource?.graphAvailable, false);
  assert.equal(result.summary.secondSource?.added, 0);
});

test("the merged artifact is byte-stable regardless of the boundary artifact's own ordering", () => {
  const packs = [factPack([{ name: "Approve", line: 362, endLine: 739 }])];
  const forward = readObligations(packs, [], boundaryOf([{ name: "Creation", startLine: 56, endLine: 133 }, { name: "Demand", startLine: 136, endLine: 274 }]));
  const reversed = readObligations(packs, [], boundaryOf([{ name: "Demand", startLine: 136, endLine: 274 }, { name: "Creation", startLine: 56, endLine: 133 }]));
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});
