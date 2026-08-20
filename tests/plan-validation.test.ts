import test from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE, planBudgetFor, type PlanBudgetTable } from "../src/report/plan-budget.ts";
import { parsePlanProposal, PLAN_PROPOSAL_VERSION, type PlanProposal } from "../src/report/plan-proposal.ts";
import { summariseObligationAccounting, WAIVING_DISPOSITION_STATES } from "../src/report/plan-obligation-conservation.ts";
import { summarisePlanValidation, validatePlan, type PlanValidationReport } from "../src/report/plan-validation.ts";
import { unitDagOrder } from "../src/report/unit-dag-order.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { TOPIC_FACETS } from "../src/report/topic-candidate.ts";
import { materialTopics, type TopicCatalogArtifact } from "../src/report/topic-catalog.ts";
import type { ReportRequestsArtifact } from "../src/report/report-requests-artifact.ts";
import { materialWorkItemIds, miniRun, topicsBinding, type MiniRun } from "./plan-fixture.ts";

// Plan validation over `tests/fixtures/topic-catalog-mini` (57B-434 R3). The fixture's numbers are hand-checkable:
// 6 work items of which 3 are material, 7 material topics, 22 topics over 6 facets. That gap — 7 topic-granular
// rows vs 3 obligation-granular ones — is the whole reason gate 1 was split into 1a and 1b, and it is why the
// obligation accounting below is computed from the bindings rather than from the topic count.
//
// Every proposal here goes through `parsePlanProposal` first, so a negative fixture is exercised through the same
// door a model's bytes would come through, not handed to the validator as a typed object it could never receive.

let mini: MiniRun | null = null;
async function fixture(): Promise<MiniRun> {
  return (mini ??= await miniRun());
}

/** Parse a raw proposal the way the CLI would, and refuse to continue on a parse failure. */
function parsed(raw: unknown): PlanProposal {
  const result = parsePlanProposal(raw);
  assert.equal(result.proposal !== null, true, `the proposal must parse: ${result.problems.join("; ")}`);
  return result.proposal!;
}

/**
 * Validate against the mini fixture's own evidence records.
 *
 * The evidence and the reach come from the one fixture this suite loads, and the guard is fail-closed rather than
 * a default: R5b's budget check MEASURES each unit by rendering its packet, so an empty evidence map would make
 * every unit measure small and every budget assertion below pass for the wrong reason.
 */
function validate(
  catalog: TopicCatalogArtifact,
  requests: ReportRequestsArtifact,
  proposal: PlanProposal,
  budgetTable: PlanBudgetTable = PLAN_BUDGET_TABLE
): PlanValidationReport {
  if (mini === null) throw new Error("validate() needs the mini fixture: await fixture() before calling it");
  return validatePlan({
    catalog,
    requests,
    proposal,
    registry: REPORT_POLICY_REGISTRY,
    budgetTable,
    evidence: mini.evidenceById,
    reach: mini.reach
  });
}

/** The fixture plan as untyped JSON, so a test can edit one field and re-parse it. */
function raw(proposal: PlanProposal): Record<string, unknown> {
  return JSON.parse(stableJson(proposal)) as Record<string, unknown>;
}

/**
 * The same plan with a set of topics taken out of every unit: a leaf left with no topic is dropped, and each
 * document's synthesis is rebuilt over whatever units remain. That is what a planner deciding "this topic is not
 * in this document" would actually produce, and it keeps the plan structurally legal so the ONLY thing the test
 * is measuring is where the obligations went.
 */
function withoutTopics(base: PlanProposal, removed: readonly string[]): unknown[] {
  const kept = base.units
    .filter((unit) => unit.kind !== "synthesis")
    .map((unit) => ({ ...unit, topics: (unit as { topics: readonly { topicId: string }[] }).topics.filter((topic) => !removed.includes(topic.topicId)) }))
    .filter((unit) => unit.kind !== "leaf" || unit.topics.length > 0);
  const synthesis = base.units
    .filter((unit) => unit.kind === "synthesis")
    .map((unit) => ({
      ...unit,
      childUnitIds: kept.filter((child) => child.documentId === unit.documentId).map((child) => child.unitId).sort((a, b) => a.localeCompare(b))
    }));
  return [...kept, ...synthesis].sort((a, b) => a.unitId.localeCompare(b.unitId));
}

function problemsOf(report: PlanValidationReport): readonly string[] {
  assert.equal(report.overall.conclusion, "violations", `expected violations, got ${report.overall.conclusion}`);
  return report.overall.conclusion === "violations" ? report.overall.problems : [];
}

// --- ① the happy path, and the two denominators it keeps apart -------------------------------------------

test("the fixture plan validates complete, and its verdict lines name every facet", async () => {
  const { catalog, requests } = await fixture();
  const report = validate(catalog, requests, parsed(raw(buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE))));
  assert.equal(report.overall.conclusion, "complete");
  assert.deepEqual(report.problems, []);
  assert.equal(report.dispositions.length, materialTopics(catalog).length);
  assert.deepEqual(report.facets.map((row) => row.facet), [...TOPIC_FACETS]);
  const lines = summarisePlanValidation(report);
  assert.equal(lines.length, TOPIC_FACETS.length + 1);
  assert.match(lines[0]!, /^overall — complete: all 7 material topic\(s\) carry a disposition$/);
  // The facets with no material topic read vacuous, never complete: 57B-449's rule one level up.
  assert.match(lines.find((line) => line.startsWith("entity"))!, /^entity — vacuous: the material-topic denominator is empty/);
  assert.match(lines.find((line) => line.startsWith("route"))!, /^route — vacuous: the material-topic denominator is empty/);
  assert.match(lines.find((line) => line.startsWith("feature"))!, /^feature — complete: all 2 material topic\(s\)/);
});

test("the obligation denominator is the ledger's material bucket, and every obligation lands in a unit", async () => {
  const { runDir, catalog, requests } = await fixture();
  const report = validate(catalog, requests, parsed(raw(buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE))));
  const fromLedger = await materialWorkItemIds(runDir);
  assert.equal(fromLedger.length, 3, "the fixture's own ledger holds 3 material obligations");
  assert.equal(report.obligations.materialObligations, fromLedger.length,
    "the 1b denominator must be workitems.json's material bucket, not the 7 material TOPICS");
  assert.notEqual(report.obligations.materialObligations, materialTopics(catalog).length,
    "the two denominators differ on this fixture, which is why the gate was split");
  assert.equal(report.obligations.inUnits, 3);
  assert.deepEqual(report.obligations.waivedObligations, [], "the tripwire list is empty by default");
  assert.equal(report.obligations.unplaced, 0);
  assert.equal(report.obligations.undispositioned, 0);
  assert.deepEqual(report.obligations.waivedByState.map((row) => row.state), [...WAIVING_DISPOSITION_STATES]);
  assert.match(summariseObligationAccounting(report.obligations),
    /^3 material obligation\(s\): 3 in units, 0 waived \(cannot-determine=0, not-applicable=0, omitted-for-audience=0\), 0 claimed but unplaced, 0 undispositioned$/);
});

// --- ② THE TRIPWIRE: a waived topic takes its obligations out, by id ------------------------------------

test("waiving every topic that binds an obligation lists that obligation by id, with its exit state", async () => {
  const { runDir, catalog, requests } = await fixture();
  const target = (await materialWorkItemIds(runDir))[0]!;
  const waivedTopics = topicsBinding(catalog, target);
  assert.ok(waivedTopics.length >= 2, "the obligation must bind more than one topic, or waiving proves nothing");

  const base = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  // Take the waived topics out of every unit, and mark them omitted for a lens this plan actually reads under.
  const proposal = parsed({
    ...raw(base),
    units: withoutTopics(base, waivedTopics),
    dispositions: (base.dispositions as Array<{ topicId: string }>).map((row) => waivedTopics.includes(row.topicId)
      ? { topicId: row.topicId, state: "omitted-for-audience", reason: "", lensPolicyId: "lens.product-manager" }
      : row)
  });
  const report = validate(catalog, requests, proposal);

  // Waiving is LEGAL — the plan still concludes — but it is never silent.
  assert.equal(report.overall.conclusion, "complete", stableJson(report.problems));
  const waivedIds = report.obligations.waivedObligations.map((row) => row.workItemId);
  assert.ok(waivedIds.includes(target), `the waived obligation ${target} must be listed by id, got ${stableJson(waivedIds)}`);
  const row = report.obligations.waivedObligations.find((entry) => entry.workItemId === target)!;
  assert.equal(row.state, "omitted-for-audience");
  assert.deepEqual([...row.topicIds], waivedTopics, "the row names every topic that waived it");
  assert.equal(report.obligations.waived, waivedIds.length);
  assert.equal(report.obligations.waivedByState.find((entry) => entry.state === "omitted-for-audience")!.obligations, waivedIds.length);
  assert.equal(report.obligations.inUnits + report.obligations.waived + report.obligations.unplaced + report.obligations.undispositioned,
    report.obligations.materialObligations, "the four buckets conserve");
  assert.match(summariseObligationAccounting(report.obligations), /omitted-for-audience=\d+/);
});

test("a placing disposition no unit honours is a violation, not a silent exit", async () => {
  const { runDir, catalog, requests } = await fixture();
  const target = (await materialWorkItemIds(runDir))[0]!;
  const orphaned = topicsBinding(catalog, target);
  const base = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  // Same topics removed from every unit, but still dispositioned `primary`: the plan claims coverage and nothing
  // writes it. That is the shape a naive "topic has a disposition, so it is handled" check would pass.
  const proposal = parsed({ ...raw(base), units: withoutTopics(base, orphaned) });
  const report = validate(catalog, requests, proposal);
  const problems = problemsOf(report);
  assert.ok(problems.some((problem) => problem.includes(target) && /the plan says it is covered and nothing writes it/.test(problem)),
    stableJson(problems));
  assert.equal(report.obligations.unplaced, report.obligations.unplacedObligations.length);
  assert.ok(report.obligations.unplaced > 0);
  assert.equal(report.obligations.inUnits + report.obligations.waived + report.obligations.unplaced + report.obligations.undispositioned,
    report.obligations.materialObligations);
});

// --- ③ reference, graph and structure negatives --------------------------------------------------------

test("an unknown topic id, an unknown child unit and a self-referencing synthesis each fail by name", async () => {
  const { catalog, requests } = await fixture();
  const base = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);

  const unknownTopic = parsed({
    ...raw(base),
    units: base.units.map((unit) => unit.kind === "appendix" ? { ...unit, topics: [{ topicId: "feature:0000000000000000", obligationScope: { kind: "all" } }] } : unit)
  });
  assert.ok(problemsOf(validate(catalog, requests, unknownTopic))
    .some((problem) => /names topic "feature:0000000000000000", which is not in this catalog/.test(problem)));

  const unknownChild = parsed({
    ...raw(base),
    units: base.units.map((unit) => unit.kind === "synthesis" ? { ...unit, childUnitIds: [...unit.childUnitIds, "no-such-unit"].sort() } : unit)
  });
  assert.ok(problemsOf(validate(catalog, requests, unknownChild))
    .some((problem) => /names child unit "no-such-unit", which the proposal does not declare/.test(problem)));

  const selfChild = parsed({
    ...raw(base),
    units: base.units.map((unit) => unit.kind === "synthesis" ? { ...unit, childUnitIds: [unit.unitId] } : unit)
  });
  assert.ok(problemsOf(validate(catalog, requests, selfChild)).some((problem) => /names itself as a child/.test(problem)));
});

test("a cycle in the unit graph fails by name and names the path", async () => {
  const { catalog, requests } = await fixture();
  const base = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const document = "overview-product";
  const cyclic = parsed({
    ...raw(base),
    units: [
      ...base.units.filter((unit) => unit.documentId !== document),
      { kind: "synthesis", unitId: `${document}::synthesis::a`, documentId: document, title: "a", childUnitIds: [`${document}::synthesis::b`] },
      { kind: "synthesis", unitId: `${document}::synthesis::b`, documentId: document, title: "b", childUnitIds: [`${document}::synthesis::a`] }
    ].sort((a, b) => a.unitId.localeCompare(b.unitId))
  });
  const problems = problemsOf(validate(catalog, requests, cyclic));
  assert.ok(problems.some((problem) => /the unit graph has a cycle: .*::synthesis::a -> .*::synthesis::b -> .*::synthesis::a/.test(problem)), stableJson(problems));

  // The order function itself reports the cycle rather than a partial order.
  const order = unitDagOrder(cyclic.units);
  assert.equal(order.state, "cyclic");
});

test("a document with no unit, a unit for an unrequested document, and two roots each fail by name", async () => {
  const { catalog, requests } = await fixture();
  const base = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);

  const missingDocument = parsed({ ...raw(base), units: base.units.filter((unit) => unit.documentId !== "overview-engineering") });
  assert.ok(problemsOf(validate(catalog, requests, missingDocument))
    .some((problem) => /document "overview-engineering" is requested and no unit writes any part of it/.test(problem)));

  const strayDocument = parsed({
    ...raw(base),
    units: [...base.units, { kind: "appendix", unitId: "zzz::appendix::stray", documentId: "overview-nobody-asked-for", title: "stray", topics: [] }]
  });
  assert.ok(problemsOf(validate(catalog, requests, strayDocument))
    .some((problem) => /names document "overview-nobody-asked-for", which no recorded request asks for/.test(problem)));

  const twoRoots = parsed({
    ...raw(base),
    units: [...base.units, { kind: "appendix", unitId: "overview-product::appendix::second-root", documentId: "overview-product", title: "second root", topics: [] }]
      .sort((a, b) => a.unitId.localeCompare(b.unitId))
  });
  assert.ok(problemsOf(validate(catalog, requests, twoRoots))
    .some((problem) => /document "overview-product" has 2 root unit\(s\)/.test(problem)));
});

// --- ④ budget: unsatisfiable is named, never truncated ------------------------------------------------

test("a unit over its document's per-unit budget is named, with both byte numbers and its topics", async () => {
  const { catalog, requests } = await fixture();
  // A table small enough that the fixture's own dossiers overflow it. Injected rather than assumed: a budget check
  // that can only run against the real table can only ever go green.
  const tiny: PlanBudgetTable = {
    version: "plan-budget-test-tiny",
    allowances: {
      compact: { perUnitInputBytes: 100, totalInputBytes: 100, perUnitOutputBytes: 50, perUnitSummaryBytes: 10 },
      standard: { perUnitInputBytes: 100, totalInputBytes: 100, perUnitOutputBytes: 50, perUnitSummaryBytes: 10 },
      detailed: { perUnitInputBytes: 100, totalInputBytes: 100, perUnitOutputBytes: 50, perUnitSummaryBytes: 10 }
    }
  };
  const proposal = parsed(raw(buildFixturePlan(catalog, requests, tiny)));
  const problems = problemsOf(validate(catalog, requests, proposal, tiny));
  assert.ok(problems.some((problem) => /renders a \d+-byte packet, \d+ byte\(s\) over the 100-byte per-unit input budget of document /.test(problem)), stableJson(problems));
  assert.ok(problems.some((problem) => /divide its obligations across more units — nothing here truncates a packet to fit/.test(problem)));
  assert.ok(problems.some((problem) => /would read \d+ bytes of packet across its units, \d+ byte\(s\) over its standard total input budget of 100/.test(problem)));
  // The synthesis is bounded rather than rendered, and its overrun prints the arithmetic that produced it.
  assert.ok(problems.some((problem) => /synthesis unit .* would be handed up to \d+ bytes — \d+ fixed plus \d+ child summar\(ies\) at the declared 10-byte bound each/.test(problem)), stableJson(problems));
});

test("a proposal that echoes a budget of its own is refused; the derived one is the only one that counts", async () => {
  const { catalog, requests } = await fixture();
  const base = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const inflated = parsed({
    ...raw(base),
    budget: {
      version: base.budget.version,
      documents: base.budget.documents.map((row) => ({ ...row, perUnitInputBytes: row.perUnitInputBytes * 1000, totalInputBytes: row.totalInputBytes * 1000 }))
    }
  });
  const problems = problemsOf(validate(catalog, requests, inflated));
  assert.ok(problems.some((problem) => /echoes a budget that is not the one the recorded requests derive; a plan does not set its own budget/.test(problem)), stableJson(problems));
  // And the derived budget is what the report carries.
  assert.equal(stableJson(validate(catalog, requests, parsed(raw(base))).budget), stableJson(planBudgetFor(requests, PLAN_BUDGET_TABLE)));
});

// --- ⑤ dispositions: R2's rules, reached through the plan --------------------------------------------

test("a missing, duplicated or unknown-state disposition fails by name through plan validation", async () => {
  const { catalog, requests } = await fixture();
  const base = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const rows = base.dispositions as Array<{ topicId: string; state: string; reason: string; lensPolicyId: string }>;

  const missing = parsed({ ...raw(base), dispositions: rows.slice(1) });
  assert.ok(problemsOf(validate(catalog, requests, missing)).some((problem) => /carries no disposition/.test(problem)));

  const duplicated = parsed({ ...raw(base), dispositions: [...rows, rows[0]!] });
  assert.ok(problemsOf(validate(catalog, requests, duplicated)).some((problem) => /is a second disposition for topic/.test(problem)));

  const unknownState = parsed({ ...raw(base), dispositions: rows.map((row, index) => index === 0 ? { ...row, state: "handled" } : row) });
  assert.ok(problemsOf(validate(catalog, requests, unknownState)).some((problem) => /state "handled" is not one of: /.test(problem)));
});

test("an unknown topic may not be rendered not-applicable, and an omission must name a lens this plan reads", async () => {
  const { catalog, requests } = await fixture();
  const base = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const rows = base.dispositions as Array<{ topicId: string; state: string; reason: string; lensPolicyId: string }>;
  const unknownTopicId = catalog.topics.find((topic) => topic.unknown && topic.materiality === "material")!.topicId;

  const asNotApplicable = parsed({
    ...raw(base),
    dispositions: rows.map((row) => row.topicId === unknownTopicId
      ? { ...row, state: "not-applicable", reason: "it does not apply" }
      : row)
  });
  assert.ok(problemsOf(validate(catalog, requests, asNotApplicable))
    .some((problem) => /is marked unknown; an undetermined subject may never be reported as provably inapplicable/.test(problem)));

  // `lens.sre` is registered, so R2's arity check passes — but no request in this plan is written under it.
  const foreignLens = parsed({
    ...raw(base),
    dispositions: rows.map((row, index) => index === 0 ? { ...row, state: "omitted-for-audience", lensPolicyId: "lens.sre" } : row)
  });
  assert.ok(problemsOf(validate(catalog, requests, foreignLens))
    .some((problem) => /is omitted for lens policy "lens\.sre", which no document in this plan is written under/.test(problem)), "a plan may not omit for an audience nobody asked for");
});

// --- ⑥ the vacuous arm still validates the rest of the plan ------------------------------------------

test("a catalog with no material topic reads vacuous, and a broken plan over it still reads violations", async () => {
  const { catalog, requests } = await fixture();
  const empty: TopicCatalogArtifact = {
    ...catalog,
    topics: catalog.topics.filter((topic) => topic.materiality !== "material"),
    materiality: { ...catalog.materiality, material: 0 },
    obligationAccounting: { total: 0, assigned: 0, unassigned: 0, unassignedWorkItemIds: [] }
  };
  const proposal = parsed(raw(buildFixturePlan(empty, requests, PLAN_BUDGET_TABLE)));
  const report = validate(empty, requests, proposal);
  assert.equal(report.overall.conclusion, "vacuous");
  assert.match(summarisePlanValidation(report)[0]!, /^overall — vacuous: the material-topic denominator is empty, so nothing was checked — /);
  assert.equal(report.obligations.materialObligations, 0);

  const broken = parsed({ ...raw(proposal), units: proposal.units.filter((unit) => unit.documentId !== "overview-engineering") });
  const brokenReport = validate(empty, requests, broken);
  assert.equal(brokenReport.overall.conclusion, "violations",
    "an empty denominator must not swallow a structural problem: vacuous is about the denominator, not about the plan");
});

test("an obligation no topic carries is a plan violation, because no plan could dispose of it", async () => {
  const { catalog, requests } = await fixture();
  const stranded: TopicCatalogArtifact = {
    ...catalog,
    obligationAccounting: { total: catalog.obligationAccounting.total + 1, assigned: catalog.obligationAccounting.assigned, unassigned: 1, unassignedWorkItemIds: ["W-nobody-carries-me"] }
  };
  const report = validate(stranded, requests, parsed(raw(buildFixturePlan(stranded, requests, PLAN_BUDGET_TABLE))));
  assert.ok(problemsOf(report).some((problem) => /leaves 1 obligation\(s\) bound to no topic \(W-nobody-carries-me\); no plan can dispose of an obligation no topic carries/.test(problem)));
});

// --- ⑦ the fixture generator itself ------------------------------------------------------------------

test("the fixture plan is deterministic, mints no unit for an absent facet, and puts every material topic in one", async () => {
  const { catalog, requests } = await fixture();
  const first = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const second = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  assert.equal(stableJson(first), stableJson(second));
  assert.equal(first.version, PLAN_PROPOSAL_VERSION);

  const kinds = new Set(first.units.map((unit) => unit.kind));
  assert.deepEqual([...kinds].sort(), ["appendix", "leaf", "synthesis"]);
  const leafFacets = first.units.filter((unit) => unit.kind === "leaf").map((unit) => unit.unitId.split("::leaf::")[1]!);
  assert.deepEqual([...new Set(leafFacets)].sort(), ["coverage", "feature", "work-item-dimension"],
    "no leaf is minted for the entity, external-system or route facets: they hold no material topic on this fixture");

  const inUnits = new Set(first.units.flatMap((unit) => "topics" in unit ? unit.topics.map((topic) => topic.topicId) : []));
  for (const topic of materialTopics(catalog)) assert.ok(inUnits.has(topic.topicId), `${topic.topicId} must be in a unit`);
  assert.deepEqual((first.dispositions as Array<{ state: string }>).map((row) => row.state), materialTopics(catalog).map(() => "primary"));
});
