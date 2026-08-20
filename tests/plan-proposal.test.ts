import test from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE, planBudgetFor, validatePlanBudgetTable, detailBudgetAllowance, unitInputBytes, type PlanBudgetTable } from "../src/report/plan-budget.ts";
import {
  AUTHORING_UNIT_KINDS,
  PLAN_PROPOSAL_VERSION,
  parsePlanProposal,
  unitArityProblems,
  unitChildIds,
  unitTopicIds
} from "../src/report/plan-proposal.ts";
import { DETAIL_BUDGETS } from "../src/report/report-request-v2.ts";
import { miniRequests } from "./plan-fixture.ts";

// The proposal parser: the door a model's bytes come through. Every negative below is a NAMED problem, and the
// parse either yields a whole proposal or none — there is no partially understood proposal, because a unit whose
// kind or arity nobody could classify is exactly the row that would later be treated as covering something.

const requests = miniRequests();

function legalUnits(): unknown[] {
  return [
    { kind: "leaf", unitId: "overview-product::leaf::a", documentId: "overview-product", title: "a", topicIds: ["feature:1111111111111111"] },
    { kind: "synthesis", unitId: "overview-product::synthesis::root", documentId: "overview-product", title: "root", childUnitIds: ["overview-product::leaf::a"] }
  ];
}

function proposal(overrides: Record<string, unknown> = {}): unknown {
  return { version: PLAN_PROPOSAL_VERSION, units: legalUnits(), dispositions: [], budget: planBudgetFor(requests, PLAN_BUDGET_TABLE), ...overrides };
}

function problems(value: unknown): readonly string[] {
  const result = parsePlanProposal(value);
  assert.equal(result.proposal, null, "the fixture must not parse");
  return result.problems;
}

test("a legal proposal parses, and its accessors are exhaustive over the kinds", () => {
  const parsed = parsePlanProposal(proposal());
  assert.deepEqual(parsed.problems, []);
  assert.ok(parsed.proposal);
  const [leaf, synthesis] = parsed.proposal!.units;
  assert.deepEqual([...unitTopicIds(leaf!)], ["feature:1111111111111111"]);
  assert.deepEqual([...unitChildIds(leaf!)], [], "a leaf has no children");
  assert.deepEqual([...unitTopicIds(synthesis!)], [], "a synthesis names no topic at all");
  assert.deepEqual([...unitChildIds(synthesis!)], ["overview-product::leaf::a"]);
  assert.deepEqual([...AUTHORING_UNIT_KINDS], ["appendix", "bridge", "leaf", "synthesis"]);
});

test("a synthesis carrying topicIds is refused in the words of the rule it breaks", () => {
  const withTopics = problems(proposal({
    units: [
      { kind: "leaf", unitId: "overview-product::leaf::a", documentId: "overview-product", title: "a", topicIds: ["feature:1111111111111111"] },
      { kind: "synthesis", unitId: "overview-product::synthesis::root", documentId: "overview-product", title: "root", childUnitIds: ["overview-product::leaf::a"], topicIds: ["feature:1111111111111111"] }
    ]
  }));
  assert.ok(withTopics.some((problem) => /is a synthesis unit carrying "topicIds"; a synthesis writes from child summaries only and may never hang a topic directly/.test(problem)), stableJson(withTopics));
});

test("each kind's arity is enforced, and the enforcement is per kind", () => {
  assert.deepEqual(unitArityProblems({ kind: "appendix", unitId: "u", documentId: "d", title: "t", topicIds: [] }), [],
    "an appendix may carry no topic: the deterministic tail exists whether or not the catalog holds a topic for it");
  assert.ok(unitArityProblems({ kind: "leaf", unitId: "u", documentId: "d", title: "t", topicIds: [] })[0]!
    .includes("a leaf writes from a topic dossier"));
  assert.ok(unitArityProblems({ kind: "bridge", unitId: "u", documentId: "d", title: "t", topicIds: ["a"] })[0]!
    .includes("a bridge explains a relation between topics and needs at least two"));
  assert.ok(unitArityProblems({ kind: "synthesis", unitId: "u", documentId: "d", title: "t", childUnitIds: [] })[0]!
    .includes("a synthesis writes from child summaries"));

  const emptyLeaf = problems(proposal({
    units: [
      { kind: "leaf", unitId: "overview-product::leaf::a", documentId: "overview-product", title: "a", topicIds: [] },
      { kind: "synthesis", unitId: "overview-product::synthesis::root", documentId: "overview-product", title: "root", childUnitIds: ["overview-product::leaf::a"] }
    ]
  }));
  assert.ok(emptyLeaf.some((problem) => /^units\[0\] leaf unit .* names no topic/.test(problem)), stableJson(emptyLeaf));
});

test("an unknown kind, a missing field and an unknown field are each named", () => {
  assert.ok(problems(proposal({ units: [{ kind: "chapter", unitId: "u", documentId: "d", title: "t", topicIds: ["a"] }] }))
    .some((problem) => /kind "chapter" is not one of: appendix, bridge, leaf, synthesis/.test(problem)));
  assert.ok(problems(proposal({ units: [{ kind: "leaf", documentId: "d", title: "t", topicIds: ["a"] }] }))
    .some((problem) => /is missing field "unitId"/.test(problem)));
  assert.ok(problems(proposal({ units: [{ kind: "leaf", unitId: "u", documentId: "d", title: "t", topicIds: ["a"], order: 3 }] }))
    .some((problem) => /has unknown field "order"/.test(problem)));
  assert.ok(problems(proposal({ coverage: "97%" })).some((problem) => /has unknown field "coverage"/.test(problem)),
    "a proposal has nowhere to state its own coverage");
});

test("an unsorted or duplicated id list, and non-ascending unit ids, are named rather than sorted quietly", () => {
  assert.ok(problems(proposal({
    units: [{ kind: "leaf", unitId: "u", documentId: "d", title: "t", topicIds: ["b", "a"] }]
  })).some((problem) => /topicIds \["b","a"\] is not sorted and de-duplicated/.test(problem)));
  assert.ok(problems(proposal({
    units: [{ kind: "leaf", unitId: "u", documentId: "d", title: "t", topicIds: ["a", "a"] }]
  })).some((problem) => /is not sorted and de-duplicated/.test(problem)));
  assert.ok(problems(proposal({
    units: [
      { kind: "leaf", unitId: "b", documentId: "d", title: "t", topicIds: ["x"] },
      { kind: "leaf", unitId: "a", documentId: "d", title: "t", topicIds: ["x"] }
    ]
  })).some((problem) => /unitId "a" does not follow "b"; the units must be strictly ascending by unit id/.test(problem)));
});

test("a wrong version, a non-array and a malformed budget echo are each named", () => {
  assert.ok(problems(proposal({ version: "plan-proposal-v2" })).some((problem) => /version "plan-proposal-v2" is not plan-proposal-v1/.test(problem)));
  assert.ok(problems(proposal({ units: "many" })).some((problem) => /units "many" is not an array/.test(problem)));
  assert.ok(problems(proposal({ dispositions: {} })).some((problem) => /dispositions \{\} is not an array/.test(problem)));
  assert.ok(problems(proposal({ budget: { version: "v", documents: [{ documentId: "d", detailBudget: "huge", perUnitInputBytes: 1, totalInputBytes: 1 }] } }))
    .some((problem) => /detailBudget "huge" is not one of: compact, standard, detailed/.test(problem)));
  assert.ok(problems(proposal({ budget: { version: "v", documents: [{ documentId: "d", detailBudget: "standard", perUnitInputBytes: 0, totalInputBytes: 1 }] } }))
    .some((problem) => /perUnitInputBytes 0 is not a positive integer/.test(problem)));
  assert.ok(problems([]).some((problem) => /is an array, not a proposal object/.test(problem)));
});

// --- the budget table ---------------------------------------------------------------------------------

test("the budget table is complete in both directions and its ladder is ordered", () => {
  validatePlanBudgetTable();
  for (const member of DETAIL_BUDGETS) assert.ok(detailBudgetAllowance(member).perUnitInputBytes > 0);
  assert.ok(detailBudgetAllowance("compact").perUnitInputBytes < detailBudgetAllowance("standard").perUnitInputBytes);
  assert.ok(detailBudgetAllowance("standard").perUnitInputBytes < detailBudgetAllowance("detailed").perUnitInputBytes);

  const missing: PlanBudgetTable = { version: "t", allowances: { compact: detailBudgetAllowance("compact"), standard: detailBudgetAllowance("standard") } };
  assert.throws(() => validatePlanBudgetTable(missing), /No plan budget allowance is declared for detail budget\(s\) detailed/);
  const phantom: PlanBudgetTable = { version: "t", allowances: { ...PLAN_BUDGET_TABLE.allowances, exhaustive: { perUnitInputBytes: 1, totalInputBytes: 1 } } };
  assert.throws(() => validatePlanBudgetTable(phantom), /declares allowances for unknown detail budget\(s\) exhaustive/);
  const inverted: PlanBudgetTable = { version: "t", allowances: { ...PLAN_BUDGET_TABLE.allowances, compact: { perUnitInputBytes: 10, totalInputBytes: 5 } } };
  assert.throws(() => validatePlanBudgetTable(inverted), /which is below its own per-unit allowance/);
});

test("the per-document budget is one row per request, derived from that request's detail budget", () => {
  const budget = planBudgetFor(requests, PLAN_BUDGET_TABLE);
  assert.deepEqual(budget.documents.map((row) => row.documentId), ["feature-leave-product", "overview-engineering", "overview-product"]);
  for (const row of budget.documents) {
    assert.equal(row.detailBudget, "standard");
    assert.equal(row.perUnitInputBytes, detailBudgetAllowance("standard").perUnitInputBytes);
  }
  assert.equal(unitInputBytes([]), 0, "a unit with no topic costs nothing, and says so with a number");
});

test("the fixture plan's echoed budget is the derived one, byte for byte", async () => {
  const { miniRun } = await import("./plan-fixture.ts");
  const { catalog, requests: recorded } = await miniRun();
  const plan = buildFixturePlan(catalog, recorded, PLAN_BUDGET_TABLE);
  assert.equal(stableJson(plan.budget), stableJson(planBudgetFor(recorded, PLAN_BUDGET_TABLE)));
});
