import test from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { parsePlanProposal } from "../src/report/plan-proposal.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { documentRootUnitIds } from "../src/report/unit-dag-order.ts";
import { singleParentProblems } from "../src/report/unit-parentage.ts";
import { parentUnitIdByChild } from "../src/report/unit-assembly.ts";
import { validatePlan } from "../src/report/plan-validation.ts";
import type { ProposedUnit } from "../src/report/plan-proposal.ts";
import { miniRun, type MiniRun } from "./plan-fixture.ts";

// THE TREE LAW (57B-434 R7c prerequisite, reported out of R7b). `documentRootUnitIds` counts the units NO unit
// names as a child; that is a check on the SET of named children, so a proposal where two syntheses both name the
// same leaf still has exactly one root and used to pass validation whole. The tests below are half about the shape
// slipping through (one root, two parents) and half about the two defences being independent: one over a PROPOSAL,
// one over the RECORDED dag edges, so removing either leaves a reachable hole.

let mini: MiniRun | null = null;
async function fixture(): Promise<MiniRun> {
  return (mini ??= await miniRun());
}

function synthesis(unitId: string, documentId: string, childUnitIds: readonly string[]): ProposedUnit {
  return { kind: "synthesis", unitId, documentId, title: unitId, childUnitIds };
}

function leaf(unitId: string, documentId: string): ProposedUnit {
  return { kind: "leaf", unitId, documentId, title: unitId, topics: [] };
}

// --- the pure reading ------------------------------------------------------------------------------------------

test("a unit named by two parents is a named problem, and a unit named by one is not", () => {
  const units = [
    leaf("d::leaf::x", "d"),
    synthesis("d::synthesis::a", "d", ["d::leaf::x"]),
    synthesis("d::synthesis::b", "d", ["d::leaf::x"]),
    synthesis("d::synthesis::r", "d", ["d::synthesis::a", "d::synthesis::b"])
  ];
  const problems = singleParentProblems(units);
  assert.equal(problems.length, 1, problems.join(" | "));
  assert.match(problems[0]!, /unit "d::leaf::x" is named as a child 2 time\(s\), by "d::synthesis::a" and "d::synthesis::b"/);
  assert.match(problems[0]!, /a document is a TREE/);
  // The shape the ROOT COUNT cannot see: this proposal has EXACTLY ONE root, so the pre-existing check passes it.
  assert.deepEqual(documentRootUnitIds(units, "d"), ["d::synthesis::r"], "one root, and a leaf under two parents underneath it");
  assert.deepEqual(singleParentProblems([leaf("d::leaf::x", "d"), synthesis("d::synthesis::a", "d", ["d::leaf::x"])]), []);
  assert.deepEqual(singleParentProblems([]), []);
});

test("one parent naming the same child twice is still a refusal, and a self-child is left to the reference check", () => {
  const twice = singleParentProblems([leaf("d::leaf::x", "d"), synthesis("d::synthesis::a", "d", ["d::leaf::x", "d::leaf::x"])]);
  assert.equal(twice.length, 1, twice.join(" | "));
  assert.match(twice[0]!, /is named as a child 2 time\(s\), by "d::synthesis::a"/, "the count a reader needs is the number of NAMINGS");
  // A unit naming itself is already a named reference problem where references are checked; counting it here would
  // report the same defect twice under two different sentences.
  assert.deepEqual(singleParentProblems([synthesis("d::synthesis::a", "d", ["d::synthesis::a"])]), []);
});

test("the problems are ascending by child id, so two runs read the same list", () => {
  const problems = singleParentProblems([
    leaf("d::leaf::b", "d"),
    leaf("d::leaf::a", "d"),
    synthesis("d::synthesis::p", "d", ["d::leaf::b", "d::leaf::a"]),
    synthesis("d::synthesis::q", "d", ["d::leaf::a", "d::leaf::b"])
  ]);
  assert.equal(problems.length, 2);
  assert.ok(problems[0]!.includes("d::leaf::a"), problems[0]);
  assert.ok(problems[1]!.includes("d::leaf::b"), problems[1]);
});

// --- through the real door: a proposal parsed the way a model's bytes would be -----------------------------------

test("plan validation refuses a two-parent proposal by name, and the same plan without the second parent passes it", async () => {
  const run = await fixture();
  const base = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const validate = (units: readonly unknown[]) => {
    const parsedProposal = parsePlanProposal(JSON.parse(stableJson({ ...base, units })) as Record<string, unknown>);
    assert.ok(parsedProposal.proposal, `the proposal must parse: ${parsedProposal.problems.join("; ")}`);
    return validatePlan({
      catalog: run.catalog,
      requests: run.requests,
      proposal: parsedProposal.proposal,
      registry: REPORT_POLICY_REGISTRY,
      budgetTable: PLAN_BUDGET_TABLE,
      evidence: run.evidenceById,
      reach: run.reach,
      epochCoverage: run.epochCoverage
    });
  };

  // The baseline: the fixture plan is a tree, and this check says nothing about it.
  const clean = validate(base.units);
  assert.deepEqual(clean.problems.filter((problem) => problem.includes("is named as a child")), []);

  // The shape: a second synthesis in the same document names a leaf the document synthesis already names, and the
  // document synthesis names the second synthesis — so there is still exactly ONE root.
  const shared = "feature-leave-product::leaf::feature";
  const extra = "feature-leave-product::synthesis::bridge";
  const units = base.units
    .map((unit) => unit.unitId === "feature-leave-product::synthesis::document" && unit.kind === "synthesis"
      ? { ...unit, childUnitIds: [...unit.childUnitIds, extra].sort((a, b) => a.localeCompare(b)) }
      : unit)
    .concat([synthesis(extra, "feature-leave-product", [shared])])
    .sort((a, b) => a.unitId.localeCompare(b.unitId));
  const report = validate(units);
  const named = report.problems.filter((problem) => problem.includes("is named as a child"));
  assert.equal(named.length, 1, report.problems.join(" | "));
  assert.ok(named[0]!.includes(JSON.stringify(shared)), named[0]);
  assert.ok(named[0]!.includes(JSON.stringify(extra)), named[0]);
  assert.ok(named[0]!.includes(JSON.stringify("feature-leave-product::synthesis::document")), named[0]);
  // And the old check is silent about it: exactly one root, which is why this needed its own law.
  assert.deepEqual(
    report.documents.find((document) => document.documentId === "feature-leave-product")!.rootUnitIds,
    ["feature-leave-product::synthesis::document"]
  );
  assert.deepEqual(report.problems.filter((problem) => problem.includes("root unit(s)")), []);
});

// --- the second defence is a different input, so neither check covers for the other ------------------------------

test("assembly still refuses the same shape from RECORDED dag edges, which no plan check can reach", () => {
  // A hand-edited `plan/dag.json`, or edges recorded by an older writer, never pass through plan validation again.
  const edges = [
    { parentUnitId: "d::synthesis::a", childUnitId: "d::leaf::x" },
    { parentUnitId: "d::synthesis::b", childUnitId: "d::leaf::x" }
  ];
  assert.throws(() => parentUnitIdByChild(edges), /is a child of both/);
  assert.equal(singleParentProblems([
    leaf("d::leaf::x", "d"),
    synthesis("d::synthesis::a", "d", ["d::leaf::x"]),
    synthesis("d::synthesis::b", "d", ["d::leaf::x"])
  ]).length, 1, "the proposal-side check sees the proposal; the edge-side check sees the recorded graph");
});
