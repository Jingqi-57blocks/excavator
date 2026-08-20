import test from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import {
  FULL_OBLIGATION_SCOPE,
  OBLIGATION_SCOPE_KINDS,
  describeObligationScope,
  parseObligationScope,
  scopeIncludes,
  scopePartitionProblems,
  scopeSize,
  scopedWorkItemIds,
  type ObligationScope,
  type ScopePartitionUnit
} from "../src/report/obligation-scope.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { parsePlanProposal, type PlanProposal } from "../src/report/plan-proposal.ts";
import { validatePlan, type PlanValidationReport } from "../src/report/plan-validation.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { miniRun, type MiniRun } from "./plan-fixture.ts";

// THE PARTITION LAW: the anti-truncation tripwire of 57B-434 R5b.
//
// A division that lost a row would still pass every count downstream — the plan would simply not mention the
// obligation, the audit's denominator would shrink with it, and every gate would stay green. So the law is stated
// as a check with three named violations, and each one is exercised here against a REAL catalog through the same
// door a model's bytes come through (`parsePlanProposal` first, then `validatePlan`):
//
//   * an id no owning unit's scope covers  -> "scope N of them to nobody";
//   * an id two owning units' scopes cover -> "inside the scope of more than one OWNING unit";
//   * an id the topic does not bind at all -> "which that topic does not bind".
//
// The pure-function half is exercised first, because `scopePartitionProblems` is where the rule lives and the
// validator is only its caller.

let mini: MiniRun | null = null;
async function fixture(): Promise<MiniRun> {
  return (mini ??= await miniRun());
}

const OVERVIEW = "overview-product";
const LEAF_FEATURE = `${OVERVIEW}::leaf::feature`;
const SYNTHESIS = `${OVERVIEW}::synthesis::document`;

function parsed(raw: unknown): PlanProposal {
  const result = parsePlanProposal(raw);
  assert.equal(result.proposal !== null, true, `the proposal must parse: ${result.problems.join("; ")}`);
  return result.proposal!;
}

function raw(proposal: PlanProposal): Record<string, unknown> {
  return JSON.parse(stableJson(proposal)) as Record<string, unknown>;
}

function validate(run: MiniRun, proposal: PlanProposal): PlanValidationReport {
  return validatePlan({
    catalog: run.catalog,
    requests: run.requests,
    proposal,
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    evidence: run.evidenceById,
    reach: run.reach,
    epochCoverage: run.epochCoverage
  });
}

function problemsOf(report: PlanValidationReport): readonly string[] {
  assert.equal(report.overall.conclusion, "violations", `expected violations, got ${report.overall.conclusion}`);
  return report.overall.conclusion === "violations" ? report.overall.problems : [];
}

/** The feature leaf's one topic that actually binds obligations, and the ids it binds in the catalog's order. */
async function boundFeatureTopic(): Promise<{ readonly topicId: string; readonly workItemIds: readonly string[] }> {
  const run = await fixture();
  const proposal = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const leaf = proposal.units.find((unit) => unit.unitId === LEAF_FEATURE)!;
  const topics = leaf.kind === "synthesis" ? [] : leaf.topics;
  for (const reference of topics) {
    const topic = run.catalog.topics.find((row) => row.topicId === reference.topicId)!;
    if (topic.bindings.length >= 2) return { topicId: topic.topicId, workItemIds: topic.bindings.map((binding) => binding.workItemId) };
  }
  throw new Error("the mini fixture must offer a feature topic binding at least two obligations");
}

/** The fixture plan with the feature leaf's scope for one topic replaced. */
function withScope(base: PlanProposal, topicId: string, scope: ObligationScope): unknown[] {
  return base.units.map((unit) => {
    const row = JSON.parse(stableJson(unit)) as Record<string, unknown>;
    if (unit.unitId !== LEAF_FEATURE || unit.kind === "synthesis") return row;
    row.topics = unit.topics.map((reference) => reference.topicId === topicId
      ? { topicId: reference.topicId, obligationScope: scope }
      : JSON.parse(stableJson(reference)) as unknown);
    return row;
  });
}

// --- (1) the two arms, as pure functions --------------------------------------------------------------

test("the scope has exactly two arms, and both are closed", () => {
  assert.deepEqual([...OBLIGATION_SCOPE_KINDS], ["all", "work-items"]);
  assert.deepEqual(FULL_OBLIGATION_SCOPE, { kind: "all" });
  assert.equal(scopeIncludes(FULL_OBLIGATION_SCOPE, "anything-at-all"), true);
  assert.equal(scopeSize(FULL_OBLIGATION_SCOPE), null, "`all` has no count of its own: the topic decides");
  const subset: ObligationScope = { kind: "work-items", workItemIds: ["W-1", "W-3"] };
  assert.equal(scopeIncludes(subset, "W-1"), true);
  assert.equal(scopeIncludes(subset, "W-2"), false);
  assert.equal(scopeSize(subset), 2);
  assert.deepEqual([...scopedWorkItemIds(subset, ["W-3", "W-2", "W-1"])], ["W-3", "W-1"],
    "the selection keeps the ledger's own order, never the scope's");
  assert.deepEqual([...scopedWorkItemIds(FULL_OBLIGATION_SCOPE, ["W-2", "W-1"])], ["W-2", "W-1"]);
  assert.match(describeObligationScope(FULL_OBLIGATION_SCOPE), /^all — every obligation this topic binds$/);
  assert.match(describeObligationScope(subset), /^work-items — 2 named obligation\(s\) of this topic$/);
});

test("an empty explicit scope is refused at parse: a unit scoped to nothing has nothing to write", () => {
  const empty = parseObligationScope({ kind: "work-items", workItemIds: [] });
  assert.equal(empty.scope, null);
  assert.ok(empty.problems.some((problem) => /names no work item; a unit scoped to no obligation has nothing to write/.test(problem)),
    empty.problems.join(" | "));
  // And the reason it matters, stated in the message: a division allowed to emit one would have dropped rows while
  // every count still balanced.
  assert.ok(empty.problems.some((problem) => /every count still balanced/.test(problem)));
});

// --- (2) the partition law, over synthetic binding sets ------------------------------------------------

test("the partition law names a missing id, a doubly covered id and a stranger id — each by id", () => {
  const bindings = new Map<string, readonly string[]>([["T-1", ["W-1", "W-2", "W-3"]]]);
  const unitOf = (unitId: string, scope: ObligationScope, owning = true): ScopePartitionUnit =>
    ({ unitId, documentId: "doc", owning, topics: [{ topicId: "T-1", obligationScope: scope }] });

  assert.deepEqual(scopePartitionProblems(bindings, [unitOf("u", FULL_OBLIGATION_SCOPE)]), [],
    "one owning unit at `all` is the identity partition");
  assert.deepEqual(scopePartitionProblems(bindings, [
    unitOf("a", { kind: "work-items", workItemIds: ["W-1"] }),
    unitOf("b", { kind: "work-items", workItemIds: ["W-2", "W-3"] })
  ]), [], "two disjoint scopes that cover everything are an exact partition");

  const missing = scopePartitionProblems(bindings, [unitOf("a", { kind: "work-items", workItemIds: ["W-1", "W-3"] })]);
  assert.equal(missing.length, 1, missing.join(" | "));
  assert.match(missing[0]!, /topic "T-1" of document "doc" binds 3 obligation\(s\) and its owning unit\(s\) a scope 1 of them to nobody \(W-2\)/);
  assert.match(missing[0]!, /an obligation stops being written by anyone and nothing says so/);

  const duplicated = scopePartitionProblems(bindings, [
    unitOf("a", { kind: "work-items", workItemIds: ["W-1", "W-2"] }),
    unitOf("b", { kind: "work-items", workItemIds: ["W-2", "W-3"] })
  ]);
  assert.equal(duplicated.length, 1, duplicated.join(" | "));
  assert.match(duplicated[0]!, /has 1 obligation\(s\) inside the scope of more than one OWNING unit \(W-2 -> a \+ b\)/);

  const stranger = scopePartitionProblems(bindings, [unitOf("a", { kind: "work-items", workItemIds: ["W-1", "W-2", "W-3", "W-nope"] })]);
  assert.equal(stranger.length, 1, stranger.join(" | "));
  assert.match(stranger[0]!, /unit "a" scopes topic "T-1" to obligation\(s\) W-nope, which that topic does not bind/);

  // A REFERENCING unit is not part of the partition: a bridge points at obligations somebody else writes, so
  // requiring it to cover them would make "explain a relation" and "write the rows" one statement.
  assert.deepEqual(scopePartitionProblems(bindings, [
    unitOf("a", FULL_OBLIGATION_SCOPE),
    unitOf("b", { kind: "work-items", workItemIds: ["W-1"] }, false)
  ]), [], "a bridge's scope neither covers nor double-covers anything");
  // But its stranger ids are still refused: a plan may not describe an obligation a topic does not carry.
  const bridgeStranger = scopePartitionProblems(bindings, [
    unitOf("a", FULL_OBLIGATION_SCOPE),
    unitOf("b", { kind: "work-items", workItemIds: ["W-ghost"] }, false)
  ]);
  assert.equal(bridgeStranger.length, 1);
  assert.match(bridgeStranger[0]!, /unit "b" scopes topic "T-1" to obligation\(s\) W-ghost/);

  // A topic the catalog does not hold is SKIPPED rather than thrown on: validation already names it as a
  // reference problem, and crashing here would replace a list of named problems with the first one.
  assert.deepEqual(scopePartitionProblems(new Map(), [unitOf("a", { kind: "work-items", workItemIds: ["W-1"] })]), []);
});

// --- (3) the same three violations, through the validator, over a real catalog --------------------------

test("a scope that leaves one of a topic's obligations to nobody is a named plan violation", async () => {
  const run = await fixture();
  const { topicId, workItemIds } = await boundFeatureTopic();
  const base = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const dropped = workItemIds[0]!;
  const proposal = parsed({
    ...raw(base),
    units: withScope(base, topicId, { kind: "work-items", workItemIds: workItemIds.filter((id) => id !== dropped).sort((a, b) => a.localeCompare(b)) })
  });
  const report = validate(run, proposal);
  const problems = problemsOf(report);
  assert.ok(problems.some((problem) => problem.includes(`scope 1 of them to nobody (${dropped})`)), problems.join(" | "));

  // AND THIS IS WHY THE PARTITION LAW HAS TO BE ITS OWN CHECK. The obligation is not left unowned: it binds a
  // work-item-dimension topic too, so ownership quietly hands it to that leaf and the ownership reading reports no
  // violation at all. Nothing else in the system would have gone red — the plan would simply have stopped writing
  // this obligation where the author was told to write it, at a lower facet priority, silently.
  const owner = report.ownership.byDocument.get(OVERVIEW)!.ownerByObligation.get(dropped);
  assert.ok(owner, "the obligation still has an owner, through a topic of another facet");
  assert.notEqual(owner!.ownerUnitId, LEAF_FEATURE, "and it is no longer the feature leaf the scope dropped it from");
  assert.deepEqual([...report.ownership.byDocument.get(OVERVIEW)!.unowned], [],
    "ownership reports nothing wrong here, which is exactly what the partition law exists to catch");
});

test("two owning units holding one obligation is a named plan violation, and it names both units", async () => {
  const run = await fixture();
  const { topicId, workItemIds } = await boundFeatureTopic();
  const base = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const second = {
    kind: "leaf" as const,
    unitId: `${OVERVIEW}::leaf::feature-again`,
    documentId: OVERVIEW,
    title: "the same topic, again",
    topics: [{ topicId, obligationScope: { kind: "work-items", workItemIds: [workItemIds[0]!] } }]
  };
  const units = base.units.map((unit) => {
    const row = JSON.parse(stableJson(unit)) as Record<string, unknown>;
    if (unit.unitId !== SYNTHESIS || unit.kind !== "synthesis") return row;
    row.childUnitIds = [...unit.childUnitIds, second.unitId].sort((a, b) => a.localeCompare(b));
    return row;
  });
  const proposal = parsed({ ...raw(base), units: [...units, second].sort((a, b) => String((a as { unitId: string }).unitId).localeCompare(String((b as { unitId: string }).unitId))) });
  const problems = problemsOf(validate(run, proposal));
  assert.ok(problems.some((problem) =>
    problem.includes("inside the scope of more than one OWNING unit")
    && problem.includes(`${workItemIds[0]!} -> ${LEAF_FEATURE} + ${second.unitId}`)), problems.join(" | "));
  assert.ok(problems.some((problem) => problem.includes("a bridge may reference a topic another unit owns, a second owning unit may not")));
});

test("a scope naming an id its topic does not bind is a named plan violation", async () => {
  const run = await fixture();
  const { topicId, workItemIds } = await boundFeatureTopic();
  const base = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const proposal = parsed({
    ...raw(base),
    units: withScope(base, topicId, { kind: "work-items", workItemIds: [...workItemIds, "W-not-in-this-topic"].sort((a, b) => a.localeCompare(b)) })
  });
  const problems = problemsOf(validate(run, proposal));
  assert.ok(problems.some((problem) =>
    problem.includes(`scopes topic ${JSON.stringify(topicId)} to obligation(s) W-not-in-this-topic`)
    && problem.includes("a scope selects from a topic's own bindings and cannot introduce one")), problems.join(" | "));
});

test("a legal explicit scope over the whole topic validates, and the plan's accounting does not move", async () => {
  const run = await fixture();
  const { topicId, workItemIds } = await boundFeatureTopic();
  const base = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const explicit = parsed({
    ...raw(base),
    units: withScope(base, topicId, { kind: "work-items", workItemIds: [...workItemIds].sort((a, b) => a.localeCompare(b)) })
  });
  const withAll = validate(run, parsed(raw(base)));
  const withExplicit = validate(run, explicit);
  assert.equal(withExplicit.overall.conclusion, "complete",
    withExplicit.overall.conclusion === "violations" ? withExplicit.overall.problems.join("; ") : "");
  // `all` and "every id, spelled out" are the same partition, so the four obligation buckets and the ownership
  // reading are byte for byte the same. This is the assertion that a scope is a DIVISION and not a filter.
  assert.equal(stableJson(withExplicit.obligations), stableJson(withAll.obligations));
  assert.equal(stableJson(withExplicit.ownership.documents.map((row) => row.ownedByUnit)),
    stableJson(withAll.ownership.documents.map((row) => row.ownedByUnit)));
});
