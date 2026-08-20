import test from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE, planBudgetFor, validatePlanBudgetTable, detailBudgetAllowance, ALLOWANCE_FIELDS, type PlanBudgetTable } from "../src/report/plan-budget.ts";
import {
  AUTHORING_UNIT_KINDS,
  PLAN_PROPOSAL_VERSION,
  parsePlanProposal,
  unitArityProblems,
  unitChildIds,
  unitTopicIds
} from "../src/report/plan-proposal.ts";
import { PLAN_BUDGET_VERSION } from "../src/report/plan-budget.ts";
import { PLAN_CATALOG_VERSION } from "../src/report/plan-artifacts.ts";
import { PLAN_VALIDATION_VERSION } from "../src/report/plan-validation.ts";
import { UNIT_PACKET_VERSION } from "../src/report/unit-packet.ts";
import { DETAIL_BUDGETS } from "../src/report/report-request-v2.ts";
import { miniRequests } from "./plan-fixture.ts";

// The proposal parser: the door a model's bytes come through. Every negative below is a NAMED problem, and the
// parse either yields a whole proposal or none — there is no partially understood proposal, because a unit whose
// kind or arity nobody could classify is exactly the row that would later be treated as covering something.

const requests = miniRequests();

function legalUnits(): unknown[] {
  return [
    { kind: "leaf", unitId: "overview-product::leaf::a", documentId: "overview-product", title: "a", topics: [{ topicId: "feature:1111111111111111", obligationScope: { kind: "all" } }] },
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

test("a synthesis carrying topics is refused in the words of the rule it breaks", () => {
  const withTopics = problems(proposal({
    units: [
      { kind: "leaf", unitId: "overview-product::leaf::a", documentId: "overview-product", title: "a", topics: [{ topicId: "feature:1111111111111111", obligationScope: { kind: "all" } }] },
      { kind: "synthesis", unitId: "overview-product::synthesis::root", documentId: "overview-product", title: "root", childUnitIds: ["overview-product::leaf::a"], topics: [{ topicId: "feature:1111111111111111", obligationScope: { kind: "all" } }] }
    ]
  }));
  assert.ok(withTopics.some((problem) => /is a synthesis unit carrying "topics"; a synthesis writes from child summaries only and may never hang a topic directly/.test(problem)), stableJson(withTopics));
});

test("each kind's arity is enforced, and the enforcement is per kind", () => {
  assert.deepEqual(unitArityProblems({ kind: "appendix", unitId: "u", documentId: "d", title: "t", topics: [] }), [],
    "an appendix may carry no topic: the deterministic tail exists whether or not the catalog holds a topic for it");
  assert.ok(unitArityProblems({ kind: "leaf", unitId: "u", documentId: "d", title: "t", topics: [] })[0]!
    .includes("a leaf writes from a topic dossier"));
  assert.ok(unitArityProblems({ kind: "bridge", unitId: "u", documentId: "d", title: "t", topics: [{ topicId: "a", obligationScope: { kind: "all" } }] })[0]!
    .includes("a bridge explains a relation between topics and needs at least two"));
  assert.ok(unitArityProblems({ kind: "synthesis", unitId: "u", documentId: "d", title: "t", childUnitIds: [] })[0]!
    .includes("a synthesis writes from child summaries"));

  const emptyLeaf = problems(proposal({
    units: [
      { kind: "leaf", unitId: "overview-product::leaf::a", documentId: "overview-product", title: "a", topics: [] },
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
  const scoped = (topicId: string): unknown => ({ topicId, obligationScope: { kind: "all" } });
  assert.ok(problems(proposal({
    units: [{ kind: "leaf", unitId: "u", documentId: "d", title: "t", topics: [scoped("b"), scoped("a")] }]
  })).some((problem) => /topics\[1\] topicId "a" does not follow "b"; the topic references must be strictly ascending by topic id/.test(problem)));
  assert.ok(problems(proposal({
    units: [{ kind: "leaf", unitId: "u", documentId: "d", title: "t", topics: [scoped("a"), scoped("a")] }]
  })).some((problem) => /topics\[1\] topicId "a" does not follow "a"/.test(problem)),
    "a repeated topic is refused rather than merged: two scopes over one topic in one unit is two answers");
  assert.ok(problems(proposal({
    units: [
      { kind: "leaf", unitId: "b", documentId: "d", title: "t", topics: [scoped("x")] },
      { kind: "leaf", unitId: "a", documentId: "d", title: "t", topics: [scoped("x")] }
    ]
  })).some((problem) => /unitId "a" does not follow "b"; the units must be strictly ascending by unit id/.test(problem)));
  assert.ok(problems(proposal({
    units: [{ kind: "leaf", unitId: "u", documentId: "d", title: "t", topics: [{ topicId: "a", obligationScope: { kind: "work-items", workItemIds: ["W-2", "W-1"] } }] }]
  })).some((problem) => /obligationScope workItemIds \["W-2","W-1"\] is not sorted and de-duplicated/.test(problem)));
  assert.ok(problems(proposal({
    units: [{ kind: "leaf", unitId: "u", documentId: "d", title: "t", topics: [{ topicId: "a", obligationScope: { kind: "work-items", workItemIds: [] } }] }]
  })).some((problem) => /obligationScope names no work item; a unit scoped to no obligation has nothing to write/.test(problem)));
  assert.ok(problems(proposal({
    units: [{ kind: "leaf", unitId: "u", documentId: "d", title: "t", topics: [{ topicId: "a" }] }]
  })).some((problem) => /topics\[0\] has fields topicId; a topic reference carries exactly obligationScope and topicId/.test(problem)),
    "the scope is REQUIRED: an absent one would default to `all`, and a divided plan would silently be a duplicated one");
  assert.ok(problems(proposal({
    units: [{ kind: "leaf", unitId: "u", documentId: "d", title: "t", topics: [{ topicId: "a", obligationScope: { kind: "all", workItemIds: ["W-1"] } }] }]
  })).some((problem) => /obligationScope is `all` and carries "workItemIds"/.test(problem)));
  assert.ok(problems(proposal({
    units: [{ kind: "leaf", unitId: "u", documentId: "d", title: "t", topics: [{ topicId: "a", obligationScope: { kind: "everything" } }] }]
  })).some((problem) => /obligationScope kind "everything" is not one of: all, work-items/.test(problem)));
});

test("a wrong version, a non-array and a malformed budget echo are each named", () => {
  assert.ok(problems(proposal({ version: "plan-proposal-v1" })).some((problem) => /version "plan-proposal-v1" is not plan-proposal-v2/.test(problem)),
    "the v1 schema is not read: a recorded v1 plan is a named refusal that says re-plan, not a compatibility path");
  assert.ok(problems(proposal({ units: "many" })).some((problem) => /units "many" is not an array/.test(problem)));
  assert.ok(problems(proposal({ dispositions: {} })).some((problem) => /dispositions \{\} is not an array/.test(problem)));
  assert.ok(problems(proposal({ budget: { version: "v", documents: [{ documentId: "d", detailBudget: "huge", perUnitInputBytes: 1, totalInputBytes: 1, perUnitOutputBytes: 1, perUnitSummaryBytes: 1 }] } }))
    .some((problem) => /detailBudget "huge" is not one of: compact, standard, detailed/.test(problem)));
  assert.ok(problems(proposal({ budget: { version: "v", documents: [{ documentId: "d", detailBudget: "standard", perUnitInputBytes: 0, totalInputBytes: 1, perUnitOutputBytes: 1, perUnitSummaryBytes: 1 }] } }))
    .some((problem) => /perUnitInputBytes 0 is not a positive integer/.test(problem)));
  // The two OUTPUT numbers are required in the echo too: a budget row missing one is a row that bounds nothing.
  assert.ok(problems(proposal({ budget: { version: "v", documents: [{ documentId: "d", detailBudget: "standard", perUnitInputBytes: 1, totalInputBytes: 1 }] } }))
    .some((problem) => /is missing field "perUnitOutputBytes"/.test(problem)));
  assert.ok(problems(proposal({ budget: { version: "v", documents: [{ documentId: "d", detailBudget: "standard", perUnitInputBytes: 1, totalInputBytes: 1, perUnitOutputBytes: 1 }] } }))
    .some((problem) => /is missing field "perUnitSummaryBytes"/.test(problem)));
  assert.ok(problems([]).some((problem) => /is an array, not a proposal object/.test(problem)));
});

/**
 * The five schema versions R5b moves, pinned in one place.
 *
 * Not ceremony: each of them is what a recorded artifact is compared against, and the whole "no cross-schema read"
 * rule stands on them being bumped together. A silent miss would let a v1 plan validate under v2 rules — a premise
 * the old validator never checked, believed because a string still matched.
 */
test("the five schema versions this slice bumps are pinned together", () => {
  assert.equal(PLAN_PROPOSAL_VERSION, "plan-proposal-v2", "topic references carry an obligation scope");
  assert.equal(PLAN_BUDGET_VERSION, "plan-budget-v2", "the allowance table declares two output numbers");
  assert.equal(PLAN_CATALOG_VERSION, "plan-catalog-v2", "the recorded reference carries the scope; the measured field is gone");
  assert.equal(PLAN_VALIDATION_VERSION, "plan-validation-v2", "the budget pre-check is the renderer, and the partition law is new");
  assert.equal(UNIT_PACKET_VERSION, "unit-packet-v3", "the packet is scope-aware and prints a declared output bound");
});

// --- the budget table ---------------------------------------------------------------------------------

test("the budget table is complete in both directions and its ladder is ordered", () => {
  validatePlanBudgetTable();
  for (const member of DETAIL_BUDGETS) assert.ok(detailBudgetAllowance(member).perUnitInputBytes > 0);
  assert.ok(detailBudgetAllowance("compact").perUnitInputBytes < detailBudgetAllowance("standard").perUnitInputBytes);
  assert.ok(detailBudgetAllowance("standard").perUnitInputBytes < detailBudgetAllowance("detailed").perUnitInputBytes);

  for (const member of DETAIL_BUDGETS) {
    for (const field of ALLOWANCE_FIELDS) assert.ok(detailBudgetAllowance(member)[field] > 0, `${member} must declare ${field}`);
  }
  // Each of the four numbers is required in BOTH directions: a member with one missing is a named refusal, not a
  // row that silently reads as unbounded on that side.
  for (const field of ALLOWANCE_FIELDS) {
    const withoutField = { ...detailBudgetAllowance("standard") } as Record<string, number>;
    delete withoutField[field];
    const gap: PlanBudgetTable = { version: "t", allowances: { ...PLAN_BUDGET_TABLE.allowances, standard: withoutField as unknown as ReturnType<typeof detailBudgetAllowance> } };
    assert.throws(() => validatePlanBudgetTable(gap), new RegExp(`declares ${field} undefined`), `${field} must be required`);
  }
  const missing: PlanBudgetTable = { version: "t", allowances: { compact: detailBudgetAllowance("compact"), standard: detailBudgetAllowance("standard") } };
  assert.throws(() => validatePlanBudgetTable(missing), /No plan budget allowance is declared for detail budget\(s\) detailed/);
  const phantom: PlanBudgetTable = { version: "t", allowances: { ...PLAN_BUDGET_TABLE.allowances, exhaustive: { perUnitInputBytes: 1, totalInputBytes: 1, perUnitOutputBytes: 1, perUnitSummaryBytes: 1 } } };
  assert.throws(() => validatePlanBudgetTable(phantom), /declares allowances for unknown detail budget\(s\) exhaustive/);
  const inverted: PlanBudgetTable = { version: "t", allowances: { ...PLAN_BUDGET_TABLE.allowances, compact: { perUnitInputBytes: 10, totalInputBytes: 5, perUnitOutputBytes: 4, perUnitSummaryBytes: 2 } } };
  assert.throws(() => validatePlanBudgetTable(inverted), /which is below its own per-unit allowance/);
});

test("the per-document budget is one row per request, derived from that request's detail budget", () => {
  const budget = planBudgetFor(requests, PLAN_BUDGET_TABLE);
  assert.deepEqual(budget.documents.map((row) => row.documentId), ["feature-leave-product", "overview-engineering", "overview-product"]);
  for (const row of budget.documents) {
    assert.equal(row.detailBudget, "standard");
    assert.equal(row.perUnitInputBytes, detailBudgetAllowance("standard").perUnitInputBytes);
  }
  // R5b: the four numbers are all required, and the row carries every one of them. The v1 PROXY measure
  // (`unitInputBytes` over canonical topic rows) is gone rather than corrected — it was out by 9x against what a
  // packet renders, and `plan-packet-measure.ts` is now the only input measure there is.
  for (const row of budget.documents) {
    for (const field of ALLOWANCE_FIELDS) assert.ok(row[field] > 0, `${row.documentId} must declare ${field}`);
    assert.ok(row.perUnitSummaryBytes < row.perUnitOutputBytes, "a summary is a projection of the unit it summarises");
    assert.ok(row.perUnitOutputBytes < row.perUnitInputBytes, "a unit may not write more than it reads");
  }
});

test("the fixture plan's echoed budget is the derived one, byte for byte", async () => {
  const { miniRun } = await import("./plan-fixture.ts");
  const { catalog, requests: recorded } = await miniRun();
  const plan = buildFixturePlan(catalog, recorded, PLAN_BUDGET_TABLE);
  assert.equal(stableJson(plan.budget), stableJson(planBudgetFor(recorded, PLAN_BUDGET_TABLE)));
});
