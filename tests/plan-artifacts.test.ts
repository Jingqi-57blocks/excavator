import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InvestigationPlan } from "../src/base/types.ts";
import { stableJson } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import {
  FIRST_PLAN_REVISION,  buildPlanArtifacts,
  planCatalogDigest,
  planCatalogPath,
  planCatalogProblems,
  planDagPath,
  planDagProblems,
  proposalFromPlanCatalog,
  readPlanCatalog,
  readPlanDag,
  writePlanArtifacts,
  type PlanArtifacts,
  type PlanCatalogArtifact
} from "../src/report/plan-artifacts.ts";
import { validatePlan } from "../src/report/plan-validation.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { topicsPath, writeTopicCatalog } from "../src/report/topics-artifact.ts";
import type { TopicCatalogArtifact } from "../src/report/topic-catalog.ts";
import { miniRun, materialWorkItemIds, topicsBinding } from "./plan-fixture.ts";

// `plan/catalog.json` and `plan/dag.json`: written once per epoch, re-derived on read, and — the load-bearing one
// for R4 — carrying topic REFERENCES rather than flattened id bags. 57B-453 measured what flattening costs: 60% of
// one document's material work items had no evidence of theirs in the packet and nothing could say which id
// belonged to which obligation. The test below proves the reference path answers that question and that the plan
// catalog itself holds none of those ids.

async function planned(): Promise<{ runDir: string; catalog: TopicCatalogArtifact; artifacts: PlanArtifacts }> {
  const run = await miniRun();
  const { runDir, catalog, requests } = run;
  await writeTopicCatalog(runDir, catalog);
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const report = validatePlan({ catalog, requests, proposal, registry: REPORT_POLICY_REGISTRY, budgetTable: PLAN_BUDGET_TABLE, evidence: run.evidenceById, reach: run.reach, epochCoverage: run.epochCoverage });
  const artifacts = buildPlanArtifacts({ catalog, requests, proposal, budgetTable: PLAN_BUDGET_TABLE, verdict: report.overall, revision: FIRST_PLAN_REVISION });
  await writePlanArtifacts(runDir, artifacts, catalog, { kind: "record" });
  return { runDir, catalog, artifacts };
}

async function edited(runDir: string, path: string, mutate: (value: Record<string, unknown>) => void): Promise<unknown> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeFile(path, `${stableJson(value)}\n`);
  return value;
}

// --- ① bindings by reference, never flattened ---------------------------------------------------------

test("the plan catalog carries topic references only: no evidence or trace id reaches it, and none is needed", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const catalogBytes = await readFile(planCatalogPath(runDir), "utf8");
  const topicsBytes = await readFile(topicsPath(runDir), "utf8");

  const evidenceIds = new Set(catalog.topics.flatMap((topic) => topic.bindings.flatMap((binding) => binding.evidenceIds)));
  const traceIds = new Set(catalog.topics.flatMap((topic) => topic.bindings.flatMap((binding) => binding.traceIds)));
  assert.equal(evidenceIds.size, 5, "the fixture binds 5 distinct evidence ids");
  assert.equal(traceIds.size, 1);
  for (const id of [...evidenceIds, ...traceIds]) {
    assert.ok(!catalogBytes.includes(id), `${id} was flattened into plan/catalog.json`);
    assert.ok(topicsBytes.includes(id), `${id} must stay addressable in plan/topics.json`);
  }
  // The unit rows carry exactly two fields per topic, and the digest is what makes the reference safe.
  for (const unit of artifacts.planCatalog.units) {
    for (const reference of unit.topics) assert.deepEqual(Object.keys(reference).sort(), ["obligationScope", "topicDigest", "topicId"]);
  }

  // And the question 57B-453 could not answer: which evidence grounds THIS obligation. Answered through the
  // reference, and compared against workitems.json verbatim — no id join anywhere.
  const target = (await materialWorkItemIds(runDir))[0]!;
  const ledger = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as InvestigationPlan;
  const expected = ledger.items.find((item) => item.id === target)!;
  const recorded = await readPlanCatalog(runDir, catalog);
  const referenced = new Set(recorded.units.flatMap((unit) => unit.topics.map((topic) => topic.topicId)));
  const bindings = catalog.topics
    .filter((topic) => referenced.has(topic.topicId))
    .flatMap((topic) => topic.bindings.filter((binding) => binding.workItemId === target));
  assert.ok(bindings.length > 0, "the obligation must be reachable through the plan's topic references");
  for (const binding of bindings) {
    assert.deepEqual([...binding.evidenceIds], [...expected.evidenceIds], "the evidence ids must equal the ledger's, in its order");
    assert.deepEqual([...binding.traceIds], [...expected.traceIds]);
  }
});

// --- ② write-once, per epoch --------------------------------------------------------------------------

test("writing the same plan twice is a no-op; different bytes for the same epoch are refused", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const before = await readFile(planCatalogPath(runDir), "utf8");
  const dagBefore = await readFile(planDagPath(runDir), "utf8");
  await writePlanArtifacts(runDir, artifacts, catalog, { kind: "record" });
  assert.equal(await readFile(planCatalogPath(runDir), "utf8"), before);
  assert.equal(await readFile(planDagPath(runDir), "utf8"), dagBefore);

  const drifted: PlanArtifacts = {
    planCatalog: { ...artifacts.planCatalog, units: artifacts.planCatalog.units.slice(1) },
    dag: artifacts.dag
  };
  await assert.rejects(async () => writePlanArtifacts(runDir, drifted, catalog, { kind: "record" }), /already records a different plan catalog; it is written once per epoch/);
  assert.equal(await readFile(planCatalogPath(runDir), "utf8"), before, "the refusal leaves the recorded bytes alone");
});

test("a new epoch supersedes: a re-frozen run can be re-planned instead of being written off", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const nextEpoch: TopicCatalogArtifact = { ...catalog, knowledgeEpoch: catalog.knowledgeEpoch + 1 };
  await writeTopicCatalog(runDir, nextEpoch);
  const recordedTopics = JSON.parse(await readFile(topicsPath(runDir), "utf8")) as TopicCatalogArtifact;
  assert.equal(recordedTopics.knowledgeEpoch, catalog.knowledgeEpoch + 1);

  const successor: PlanArtifacts = {
    planCatalog: { ...artifacts.planCatalog, knowledgeEpoch: nextEpoch.knowledgeEpoch, topicsDigest: (await import("../src/report/topics-artifact.ts")).topicCatalogDigest(nextEpoch) },
    dag: { ...artifacts.dag, knowledgeEpoch: nextEpoch.knowledgeEpoch }
  };
  const withDigest: PlanArtifacts = {
    planCatalog: successor.planCatalog,
    dag: { ...successor.dag, planCatalogDigest: planCatalogDigest(successor.planCatalog) }
  };
  await writePlanArtifacts(runDir, withDigest, nextEpoch, { kind: "record" });
  const reread = await readPlanCatalog(runDir, nextEpoch);
  assert.equal(reread.knowledgeEpoch, nextEpoch.knowledgeEpoch);
});

test("the same inputs produce the same plan bytes, twice", async () => {
  const first = await planned();
  const second = await planned();
  assert.equal(stableJson(first.artifacts.planCatalog), stableJson(second.artifacts.planCatalog));
  assert.equal(stableJson(first.artifacts.dag), stableJson(second.artifacts.dag));
  assert.equal(await readFile(planCatalogPath(first.runDir), "utf8"), await readFile(planCatalogPath(second.runDir), "utf8"));
  assert.equal(await readFile(planDagPath(first.runDir), "utf8"), await readFile(planDagPath(second.runDir), "utf8"));
});

// --- ③ the reader re-derives -------------------------------------------------------------------------

test("a plan recorded under an earlier schema is a NAMED refusal that says re-plan, never a cross-schema read", async () => {
  const { runDir, catalog } = await planned();
  const recorded = JSON.parse(await readFile(planCatalogPath(runDir), "utf8")) as PlanCatalogArtifact;

  // R5b bumps three schemas at once — the proposal (topic references carry an obligation scope), the plan catalog
  // (so does the recorded reference, and the measured `inputBytes` field is gone) and the budget (two output
  // numbers). A v1 plan therefore fails on each, and every message says what to do rather than only what is wrong.
  const asV1 = { ...recorded, version: "plan-catalog-v1", proposalVersion: "plan-proposal-v1" };
  const problems = planCatalogProblems(asV1, catalog);
  assert.ok(problems.some((problem) => /^version "plan-catalog-v1" is not plan-catalog-v3; this plan was recorded under an earlier schema and no cross-schema read exists — re-plan this run$/.test(problem)), problems.join(" | "));
  assert.ok(problems.some((problem) => /^proposalVersion "plan-proposal-v1" is not plan-proposal-v2; the proposal schema this plan was validated against is superseded — re-plan this run$/.test(problem)), problems.join(" | "));

  // And a v1 BUDGET echo — the two output numbers absent — is named field by field rather than defaulted.
  const v1Budget = {
    ...recorded,
    budget: {
      version: "plan-budget-v1",
      documents: recorded.budget.documents.map((row) => ({
        documentId: row.documentId, detailBudget: row.detailBudget,
        perUnitInputBytes: row.perUnitInputBytes, totalInputBytes: row.totalInputBytes
      }))
    }
  };
  const budgetProblems = planCatalogProblems(v1Budget, catalog);
  assert.ok(budgetProblems.some((problem) => /budget documents\[0\] is missing field "perUnitOutputBytes"/.test(problem)), budgetProblems.join(" | "));
  assert.ok(budgetProblems.some((problem) => /budget documents\[0\] is missing field "perUnitSummaryBytes"/.test(problem)), budgetProblems.join(" | "));

  // Through the gate, the same refusal reaches the operator by name.
  await writeFile(planCatalogPath(runDir), `${stableJson(asV1)}\n`);
  await assert.rejects(() => readPlanCatalog(runDir, catalog), /re-plan this run/);
});

test("a hand-edited obligation accounting, disposition or topic digest fails by name at the file boundary", async () => {
  const { runDir, catalog } = await planned();

  const wideDenominator = JSON.parse(await readFile(planCatalogPath(runDir), "utf8")) as PlanCatalogArtifact;
  const tampered = { ...wideDenominator, obligationAccounting: { ...wideDenominator.obligationAccounting, waived: 99, waivedObligations: [] } };
  assert.ok(planCatalogProblems(tampered, catalog).some((problem) => /obligationAccounting is not the reading its own units and dispositions derive/.test(problem)));

  // The shape gate 1b exists for: a topic pulled out of every unit AND waived, with the recorded reading left
  // saying nothing was waived. The re-derivation is what makes the edited reading a named failure.
  const target = (await materialWorkItemIds(runDir))[0]!;
  const waivedTopicIds = topicsBinding(catalog, target);
  const hidden = {
    ...wideDenominator,
    units: wideDenominator.units.map((unit) => ({ ...unit, topics: unit.topics.filter((topic) => !waivedTopicIds.includes(topic.topicId)) })),
    dispositions: wideDenominator.dispositions.map((row) => waivedTopicIds.includes(row.topicId)
      ? { ...row, state: "omitted-for-audience" as const, lensPolicyId: "lens.product-manager" }
      : row)
  };
  assert.ok(planCatalogProblems(hidden, catalog).some((problem) => /obligationAccounting is not the reading its own units and dispositions derive/.test(problem)),
    "waiving a bound topic and leaving the recorded reading untouched must fail by name");

  await edited(runDir, planCatalogPath(runDir), (value) => {
    const units = value.units as Array<{ topics: Array<{ topicDigest: string }> }>;
    const withTopic = units.find((unit) => unit.topics.length > 0)!;
    withTopic.topics[0]!.topicDigest = "0".repeat(64);
  });
  await assert.rejects(async () => readPlanCatalog(runDir, catalog), /references topic .* at digest "0{64}", but that topic now digests to /);
});

test("a synthesis row with a topic, and a leaf row with children, are refused when the plan is read back", async () => {
  const { catalog, artifacts } = await planned();
  const synthesis = artifacts.planCatalog.units.find((unit) => unit.kind === "synthesis")!;
  const leaf = artifacts.planCatalog.units.find((unit) => unit.kind === "leaf")!;
  assert.throws(
    () => proposalFromPlanCatalog({ ...artifacts.planCatalog, units: artifacts.planCatalog.units.map((unit) => unit.unitId === synthesis.unitId ? { ...unit, topics: leaf.topics } : unit) }),
    /Recorded synthesis unit .* references \d+ topic\(s\); a synthesis writes from child summaries only/
  );
  assert.throws(
    () => proposalFromPlanCatalog({ ...artifacts.planCatalog, units: artifacts.planCatalog.units.map((unit) => unit.unitId === leaf.unitId ? { ...unit, childUnitIds: [synthesis.unitId] } : unit) }),
    /Recorded leaf unit .* names 1 child unit\(s\); only a synthesis has children/
  );
  void catalog;
});

test("the DAG is re-derived from the catalog's units: an edited edge, order or digest fails by name", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const recorded = await readPlanCatalog(runDir, catalog);

  const extraEdge = { ...artifacts.dag, edges: [...artifacts.dag.edges, { parentUnitId: "a", childUnitId: "b" }] };
  assert.ok(planDagProblems(extraEdge, recorded).some((problem) => /edges is not the edge set its units derive/.test(problem)));

  const reversedOrder = {
    ...artifacts.dag,
    documents: artifacts.dag.documents.map((row) => ({ ...row, authoringOrder: [...row.authoringOrder].reverse() }))
  };
  assert.ok(planDagProblems(reversedOrder, recorded).some((problem) => /documents is not the per-document authoring order its units derive/.test(problem)));

  const foreignPlan = { ...artifacts.dag, planCatalogDigest: "f".repeat(64) };
  assert.ok(planDagProblems(foreignPlan, recorded).some((problem) => /planCatalogDigest "f{64}" is not the digest of this run's plan\/catalog\.json/.test(problem)));

  // The PREVIOUS schema, not an invented one: a v1 DAG carries no plan revision, and reading it under v2's rules
  // would be asserting that the old writer recorded a succession it had no field for.
  await edited(runDir, planDagPath(runDir), (value) => { value.version = "plan-dag-v1"; });
  await assert.rejects(async () => readPlanDag(runDir, recorded), /version "plan-dag-v1" is not plan-dag-v2/);
});

test("the authoring order puts every child before its parent, and the roots are one per document", async () => {
  const { artifacts } = await planned();
  for (const document of artifacts.dag.documents) {
    const positions = new Map(document.authoringOrder.map((unitId, index) => [unitId, index]));
    for (const edge of artifacts.dag.edges) {
      if (!positions.has(edge.parentUnitId)) continue;
      assert.ok(positions.get(edge.parentUnitId)! > positions.get(edge.childUnitId)!,
        `${edge.parentUnitId} must be written after its child ${edge.childUnitId}`);
    }
    assert.equal(document.authoringOrder.at(-1), document.rootUnitId, "the root is written last");
  }
  assert.deepEqual(artifacts.planCatalog.documents.map((row) => row.documentId),
    ["feature-leave-product", "overview-engineering", "overview-product"]);
});

test("a plan whose validation found violations cannot be recorded at all", async () => {
  const run = await miniRun();
  const { runDir, catalog, requests } = run;
  void runDir;
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const broken = { ...proposal, units: proposal.units.filter((unit) => unit.documentId !== "overview-product") };
  const report = validatePlan({ catalog, requests, proposal: broken, registry: REPORT_POLICY_REGISTRY, budgetTable: PLAN_BUDGET_TABLE, evidence: run.evidenceById, reach: run.reach, epochCoverage: run.epochCoverage });
  assert.throws(
    () => buildPlanArtifacts({ catalog, requests, proposal: broken, budgetTable: PLAN_BUDGET_TABLE, verdict: report.overall, revision: FIRST_PLAN_REVISION }),
    /The plan cannot be recorded: validation found 1 problem\(s\)/
  );
});
