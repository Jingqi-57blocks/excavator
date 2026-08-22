/**
 * Plan revisions: the second axis of a recorded plan's identity, and everything that may not happen to it.
 *
 * WHAT THIS FILE IS FOR. `plan/catalog.json` is written once, and until this slice that meant a run could not be
 * re-planned inside its knowledge epoch at all — which is the state a unit cache needs (a superseded plan is the
 * only place candidates come from) and the state the epic's headline case produces (one more audience, no
 * knowledge change). The answer is not a relaxed write-once; it is a recorded revision. So what has to be proven
 * here is that the revision is a real premise rather than a number: revision 0 behaves exactly as it always did,
 * a revision names the digest of the plan it replaces, the replaced plan is on disk before the current one moves,
 * and a revision that supersedes nothing is refused instead of quietly re-digesting a whole run's receipts.
 *
 * WHY THE FALSIFICATIONS ARE IN THE TESTS RATHER THAN IN A COMMENT. Every refusal below was watched to fire: the
 * succession is tampered with, the archive is pre-filled with other bytes, an empty revision is attempted, the
 * revision fields are moved one at a time. A write-once law with no red case is a law nobody has seen work.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { exists, stableJson, writeJson } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import {
  FIRST_PLAN_REVISION,
  PLAN_REVISION_FIELDS,
  buildPlanArtifacts,
  planCatalogDigest,
  planCatalogPath,
  planCatalogProblems,
  planDagPath,
  planDagProblems,
  planRevisionOf,
  planRevisionProblems,
  readPlanCatalog,
  readPlanDag,
  writePlanArtifacts,
  type PlanArtifacts,
  type PlanCatalogArtifact
} from "../src/report/plan-artifacts.ts";
import {
  archivePlanRevision,
  nextPlanRevision,
  planToSupersede,
  planContentDigest,
  planRevisionArchive,
  readPlanRevisionSuccession,
  recordPlanRevision
} from "../src/report/plan-revision.ts";
import { validatePlan } from "../src/report/plan-validation.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { readTopicCatalog, writeTopicCatalog } from "../src/report/topics-artifact.ts";
import type { TopicCatalogArtifact } from "../src/report/topic-catalog.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { miniRun } from "./plan-fixture.ts";
import { frozenRun } from "./unit-fixture.ts";

/** A mini run with revision 0 of its plan recorded, through the same door the stage uses. */
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

/** The same plan, one revision later, with one unit's title moved so it says something different. */
function retitled(artifacts: PlanArtifacts, reason: string): PlanArtifacts {
  const planCatalog: PlanCatalogArtifact = {
    ...artifacts.planCatalog,
    ...nextPlanRevision(artifacts.planCatalog, reason),
    units: artifacts.planCatalog.units.map((unit, index) => (index === 0 ? { ...unit, title: `${unit.title} (revised)` } : unit))
  };
  // The graph carries the revision and the predecessor and NOT the reason: a reason is an audit fact about the
  // catalog, and the DAG's reader refuses a field it has no place for (it did, on the first version of this helper).
  return {
    planCatalog,
    dag: {
      ...artifacts.dag,
      planRevision: planCatalog.planRevision,
      previousPlanCatalogDigest: planCatalog.previousPlanCatalogDigest,
      planCatalogDigest: planCatalogDigest(planCatalog)
    }
  };
}

// --- ① revision 0 is what it always was ---------------------------------------------------------------

test("the first plan of an epoch is revision 0, supersedes nothing, and is still written once", async () => {
  const { runDir, catalog, artifacts } = await planned();
  assert.deepEqual(planRevisionOf(artifacts.planCatalog), { planRevision: 0, previousPlanCatalogDigest: null, revisionReason: null });
  assert.equal(artifacts.dag.planRevision, 0);
  assert.equal(artifacts.dag.previousPlanCatalogDigest, null);
  assert.deepEqual(await readPlanRevisionSuccession(runDir, artifacts.planCatalog), [], "revision 0 has no predecessor to walk to");
  assert.equal(await exists(planRevisionArchive(runDir, 0, 0).catalog), false, "recording revision 0 archives nothing");

  // The write-once law, unchanged in behaviour and now stated over (epoch, revision).
  const before = await readFile(planCatalogPath(runDir), "utf8");
  await writePlanArtifacts(runDir, artifacts, catalog, { kind: "record" });
  assert.equal(await readFile(planCatalogPath(runDir), "utf8"), before, "identical bytes are a no-op");
  const drifted: PlanArtifacts = { planCatalog: { ...artifacts.planCatalog, units: artifacts.planCatalog.units.slice(1) }, dag: artifacts.dag };
  await assert.rejects(async () => writePlanArtifacts(runDir, drifted, catalog, { kind: "record" }),
    /already records a different plan catalog; it is written once per epoch and revision/);
  assert.equal(await readFile(planCatalogPath(runDir), "utf8"), before, "the refusal leaves the recorded bytes alone");
});

test("a plain recording refuses to replace a revision the run already advanced past, and names the way forward", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const revision1 = retitled(artifacts, "one unit was retitled");
  await recordPlanRevision(runDir, revision1, catalog, artifacts);
  // A plain `record` of revision 0 over a run at revision 1: not "different bytes", a different REVISION.
  await assert.rejects(async () => writePlanArtifacts(runDir, artifacts, catalog, { kind: "record" }),
    /already records revision 1 of this epoch's plan catalog, and this one is revision 0; a recorded plan is replaced only by `plan --revise --reason <why>`/);
  assert.equal((await readPlanCatalog(runDir, catalog)).planRevision, 1, "the recorded revision stands");
});

// --- ② a revision names its predecessor, and the predecessor is on disk --------------------------------

test("a revision records the next number, names the digest it supersedes, and archives it byte for byte", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const archivedBytes = await readFile(planCatalogPath(runDir), "utf8");
  const archivedDagBytes = await readFile(planDagPath(runDir), "utf8");

  const revision1 = retitled(artifacts, "one unit was retitled");
  const recorded = await recordPlanRevision(runDir, revision1, catalog, artifacts);

  const current = await readPlanCatalog(runDir, catalog);
  assert.equal(current.planRevision, 1);
  assert.equal(current.previousPlanCatalogDigest, planCatalogDigest(artifacts.planCatalog));
  assert.equal(current.revisionReason, "one unit was retitled");
  const dag = await readPlanDag(runDir, current);
  assert.equal(dag.planRevision, 1, "the graph says which revision it belongs to");
  assert.equal(dag.previousPlanCatalogDigest, current.previousPlanCatalogDigest);

  // The superseded revision is on disk, unchanged, at the path the result names.
  assert.deepEqual(recorded.archive, planRevisionArchive(runDir, 0, 0));
  assert.equal(await readFile(recorded.archive.catalog, "utf8"), archivedBytes, "the archived revision is the bytes that were recorded");
  assert.equal(await readFile(recorded.archive.dag, "utf8"), archivedDagBytes);
  assert.deepEqual(recorded.succession, [`revision 1 supersedes revision 0 (${planCatalogDigest(artifacts.planCatalog)})`]);
});

test("two revisions chain, and the whole chain is walked back to revision 0 from the archive", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const revision1 = retitled(artifacts, "first revision");
  await recordPlanRevision(runDir, revision1, catalog, artifacts);
  const revision2 = retitled(revision1, "second revision");
  const recorded = await recordPlanRevision(runDir, revision2, catalog, revision1);

  assert.equal((await readPlanCatalog(runDir, catalog)).planRevision, 2);
  assert.deepEqual(recorded.succession, [
    `revision 1 supersedes revision 0 (${planCatalogDigest(artifacts.planCatalog)})`,
    `revision 2 supersedes revision 1 (${planCatalogDigest(revision1.planCatalog)})`
  ]);
  for (const revision of [0, 1]) assert.ok(await exists(planRevisionArchive(runDir, 0, revision).catalog), `revision ${revision} is archived`);
});

test("the succession is checked, not assumed: a tampered archive, a gap and a renumbering all fail by name", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const revision1 = retitled(artifacts, "first revision");
  await recordPlanRevision(runDir, revision1, catalog, artifacts);
  const archive = planRevisionArchive(runDir, 0, 0);

  // (a) the archived predecessor is edited: its digest no longer matches what revision 1 names.
  const archived = JSON.parse(await readFile(archive.catalog, "utf8")) as PlanCatalogArtifact;
  await writeJson(archive.catalog, { ...archived, runId: `${archived.runId}-edited` });
  await assert.rejects(async () => readPlanRevisionSuccession(runDir, revision1.planCatalog),
    /Plan revision 1 names predecessor "[0-9a-f]{64}", and the revision 0 archived at .* digests to [0-9a-f]{64}; the succession is broken/);

  // (b) the archived predecessor is renumbered: same bytes otherwise, wrong place in the chain.
  await writeJson(archive.catalog, { ...archived, planRevision: 7, previousPlanCatalogDigest: "a".repeat(64), revisionReason: "renumbered" });
  await assert.rejects(async () => readPlanRevisionSuccession(runDir, revision1.planCatalog),
    /archives revision 7 where the succession expects revision 0; the archived chain is renumbered/);

  // (c) the archive is gone: a succession cannot be read across a gap, and it does not read as "no predecessor".
  await rm(archive.catalog);
  await assert.rejects(async () => readPlanRevisionSuccession(runDir, revision1.planCatalog),
    /is missing; a plan revision's predecessor is archived, and a succession cannot be read across a gap/);
});

test("a further revision is refused while the archived chain is broken: the walk happens on the write path", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const revision1 = retitled(artifacts, "first revision");
  await recordPlanRevision(runDir, revision1, catalog, artifacts);
  // The archived predecessor is edited AFTER revision 1 was recorded. Nothing on the current path is wrong; what
  // is wrong is the history. A revise that only checked its immediate predecessor would sail past this.
  const archive = planRevisionArchive(runDir, 0, 0);
  const archived = JSON.parse(await readFile(archive.catalog, "utf8")) as PlanCatalogArtifact;
  await writeJson(archive.catalog, { ...archived, runId: `${archived.runId}-edited` });

  const revision2 = retitled(revision1, "second revision");
  await assert.rejects(async () => recordPlanRevision(runDir, revision2, catalog, revision1),
    /Plan revision 1 names predecessor "[0-9a-f]{64}", and the revision 0 archived at .* digests to [0-9a-f]{64}; the succession is broken/);
  assert.equal((await readPlanCatalog(runDir, catalog)).planRevision, 1, "the run stays where it was until the history reads");
});

test("an archived revision is never replaced, and the current plan is not touched until the archive holds it", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const archive = planRevisionArchive(runDir, 0, 0);

  // Something else is already at the archive path: the revise refuses and the current plan stays at revision 0.
  await mkdir(dirname(archive.catalog), { recursive: true });
  await writeJson(archive.catalog, { ...artifacts.planCatalog, runId: "another-run" });
  const revision1 = retitled(artifacts, "one unit was retitled");
  await assert.rejects(async () => recordPlanRevision(runDir, revision1, catalog, artifacts),
    /already archives a plan catalog that is not the one being archived; an archived plan revision is written once and never replaced/);
  assert.equal((await readPlanCatalog(runDir, catalog)).planRevision, 0, "nothing on the current path moved");

  // And re-archiving the identical revision is a no-op rather than a refusal, so a re-run of the same revise works.
  await writeJson(archive.catalog, artifacts.planCatalog);
  await writeJson(archive.dag, artifacts.dag);
  const again = await archivePlanRevision(runDir, artifacts);
  assert.deepEqual(again, archive);
});

test("the current plan may not be replaced by a revision whose predecessor was never archived", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const revision1 = retitled(artifacts, "one unit was retitled");
  const archive = planRevisionArchive(runDir, 0, 0);
  await assert.rejects(async () => writePlanArtifacts(runDir, revision1, catalog, {
    kind: "supersede", superseded: artifacts, archivedCatalogPath: archive.catalog, archivedDagPath: archive.dag
  }), /does not hold the plan catalog being superseded; a superseded plan revision is archived before it is replaced/);
  assert.equal((await readPlanCatalog(runDir, catalog)).planRevision, 0);

  // And a successor that does not follow the plan it would replace is refused before any archive check.
  await archivePlanRevision(runDir, artifacts);
  const skipped: PlanArtifacts = { planCatalog: { ...revision1.planCatalog, planRevision: 5 }, dag: revision1.dag };
  await assert.rejects(async () => writePlanArtifacts(runDir, skipped, catalog, {
    kind: "supersede", superseded: artifacts, archivedCatalogPath: archive.catalog, archivedDagPath: archive.dag
  }), /A plan revision follows the one it supersedes: this one is revision 5 and the plan it would replace is revision 0/);
  const forged: PlanArtifacts = { planCatalog: { ...revision1.planCatalog, previousPlanCatalogDigest: "b".repeat(64) }, dag: revision1.dag };
  await assert.rejects(async () => writePlanArtifacts(runDir, forged, catalog, {
    kind: "supersede", superseded: artifacts, archivedCatalogPath: archive.catalog, archivedDagPath: archive.dag
  }), /names predecessor "b{64}", but the plan it would replace digests to [0-9a-f]{64}; a succession is checked, never assumed/);
});

test("a revision derived from a predecessor the run has moved past is refused instead of dropping one", async () => {
  const { runDir, catalog, artifacts } = await planned();
  // TWO revisions derived from the SAME recorded plan — what two concurrent `plan --revise` runs produce, since
  // nothing in src/ locks a run directory. The first one lands; the second must not overwrite it, because the plan
  // it would replace is no longer on disk and nothing archived it.
  const first = retitled(artifacts, "the first revision to land");
  const second: PlanArtifacts = {
    planCatalog: { ...first.planCatalog, revisionReason: "the second revision, derived from the same predecessor" },
    dag: first.dag
  };
  await recordPlanRevision(runDir, first, catalog, artifacts);
  await assert.rejects(async () => recordPlanRevision(runDir, second, catalog, artifacts),
    /no longer holds the plan catalog this revision supersedes \(nor the one it would write\); the recorded plan moved after this revision was derived/);
  const recorded = await readPlanCatalog(runDir, catalog);
  assert.equal(recorded.revisionReason, "the first revision to land", "the revision that landed is the one on disk");
  assert.equal(stableJson(recorded), stableJson(first.planCatalog));
});

test("a revise interrupted after the graph landed is completed by re-running it, not wedged", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const revision1 = retitled(artifacts, "one unit was retitled");
  // The exact state an interrupted revise leaves: the revision it replaces archived, the NEW graph written, and the
  // catalog still the old one (the write order is graph first, catalog second, so the anchor moves last).
  await archivePlanRevision(runDir, artifacts);
  await writeJson(planDagPath(runDir), revision1.dag);
  // Every door refuses to read this run, by name, rather than reading a mismatched pair.
  await assert.rejects(async () => readPlanDag(runDir, artifacts.planCatalog),
    /planCatalogDigest "[0-9a-f]{64}" is not the digest of this run's plan\/catalog\.json/);

  // Re-running the same revision completes it: the archive write is a no-op, the graph is already the new one, and
  // the catalog moves last. Nothing had to be repaired by hand and nothing was silently rewritten.
  const completed = await recordPlanRevision(runDir, revision1, catalog, await planToSupersede(runDir, artifacts.planCatalog));
  assert.deepEqual(completed.succession, [`revision 1 supersedes revision 0 (${planCatalogDigest(artifacts.planCatalog)})`]);
  const current = await readPlanCatalog(runDir, catalog);
  assert.equal(current.planRevision, 1);
  assert.equal(stableJson(await readPlanDag(runDir, current)), stableJson(revision1.dag));
});

test("an unreadable graph with no revision in progress stays a named refusal, not a repair", async () => {
  const { runDir, artifacts } = await planned();
  // Same broken pair, WITHOUT the archive that says a revise of this revision began. This is a graph somebody
  // edited, and the reader's refusal is the whole point of re-deriving it — nothing may quietly rewrite it.
  await writeJson(planDagPath(runDir), { ...artifacts.dag, edges: [{ parentUnitId: "a", childUnitId: "b" }] });
  await assert.rejects(async () => planToSupersede(runDir, artifacts.planCatalog), /edges is not the edge set its units derive/);
});

// --- ③ a revision that supersedes nothing ------------------------------------------------------------

test("a revision of a plan that says exactly the same thing is refused, because it would re-digest every receipt", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const empty: PlanArtifacts = {
    planCatalog: { ...artifacts.planCatalog, ...nextPlanRevision(artifacts.planCatalog, "nothing actually changed") },
    dag: artifacts.dag
  };
  await assert.rejects(async () => recordPlanRevision(runDir, empty, catalog, artifacts),
    /is field for field the plan this run already records at revision 0 \(content digest [0-9a-f]{64}\); nothing is superseded/);
  assert.equal(await exists(planRevisionArchive(runDir, 0, 0).catalog), false, "a refused revision archives nothing");
  assert.equal((await readPlanCatalog(runDir, catalog)).planRevision, 0);
});

test("the content digest ignores exactly the three revision fields and nothing else", async () => {
  const { artifacts } = await planned();
  const base = planContentDigest(artifacts.planCatalog);
  assert.deepEqual([...PLAN_REVISION_FIELDS], ["planRevision", "previousPlanCatalogDigest", "revisionReason"]);
  const moved: PlanCatalogArtifact = {
    ...artifacts.planCatalog,
    planRevision: 9,
    previousPlanCatalogDigest: "c".repeat(64),
    revisionReason: "a reason"
  };
  assert.equal(planContentDigest(moved), base, "moving the revision record alone is not a different plan");
  assert.notEqual(planCatalogDigest(moved), planCatalogDigest(artifacts.planCatalog), "though it IS different bytes, which is why the comparison is needed");
  // Any other field, and the two plans are not the same plan. `runId` stands in for all of them: the digest is
  // over the whole object minus the closed list above, so a field nobody thought of is included by construction.
  assert.notEqual(planContentDigest({ ...artifacts.planCatalog, runId: "other" }), base);
  assert.notEqual(planContentDigest({ ...artifacts.planCatalog, units: artifacts.planCatalog.units.slice(1) }), base);
});

test("two runs revised the same way produce the same bytes, current and archived alike", async () => {
  const first = await planned();
  const second = await planned();
  await recordPlanRevision(first.runDir, retitled(first.artifacts, "the same reason"), first.catalog, first.artifacts);
  await recordPlanRevision(second.runDir, retitled(second.artifacts, "the same reason"), second.catalog, second.artifacts);
  for (const path of [planCatalogPath, planDagPath]) {
    assert.equal(await readFile(path(first.runDir), "utf8"), await readFile(path(second.runDir), "utf8"), `${path.name} is one byte sequence`);
  }
  const [a, b] = [planRevisionArchive(first.runDir, 0, 0), planRevisionArchive(second.runDir, 0, 0)];
  assert.equal(await readFile(a.catalog, "utf8"), await readFile(b.catalog, "utf8"), "and so is the archived revision");
  assert.equal(await readFile(a.dag, "utf8"), await readFile(b.dag, "utf8"));
});

// --- ④ the fields are validated at the file boundary --------------------------------------------------

test("an incoherent revision record is a named problem, in both artifacts, in every direction", async () => {
  const { runDir, catalog, artifacts } = await planned();
  const recorded = await readPlanCatalog(runDir, catalog);

  const cases: Array<[Partial<PlanCatalogArtifact>, RegExp]> = [
    [{ previousPlanCatalogDigest: "d".repeat(64) }, /planRevision 0 records previousPlanCatalogDigest "d{64}"; the first plan of an epoch supersedes nothing/],
    [{ revisionReason: "why" }, /planRevision 0 records revisionReason "why"; the first plan of an epoch is not a revision of anything/],
    [{ planRevision: 1 }, /planRevision 1 records no previousPlanCatalogDigest; a revision names the plan it supersedes/],
    [{ planRevision: 1, previousPlanCatalogDigest: "e".repeat(64) }, /planRevision 1 records no revisionReason; a revision states why the plan it supersedes was replaced/],
    [{ planRevision: -1 }, /planRevision -1 is not a non-negative integer/],
    [{ planRevision: 1.5 }, /planRevision 1.5 is not a non-negative integer/],
    [{ planRevision: 1, previousPlanCatalogDigest: "not-a-digest", revisionReason: "why" }, /previousPlanCatalogDigest "not-a-digest" is neither null nor a sha256 digest/],
    [{ planRevision: 1, previousPlanCatalogDigest: "f".repeat(64), revisionReason: "   " }, /revisionReason "   " is neither null nor a non-empty string/]
  ];
  for (const [patch, expected] of cases) {
    const problems = planCatalogProblems({ ...recorded, ...patch }, catalog);
    assert.ok(problems.some((problem) => expected.test(problem)), `${stableJson(patch)} -> ${problems.join(" | ")}`);
  }

  // A missing field is a missing field: it does not default to "revision 0 with no predecessor".
  const withoutRevision: Record<string, unknown> = { ...recorded };
  delete withoutRevision.planRevision;
  const missing = planCatalogProblems(withoutRevision, catalog);
  assert.ok(missing.some((problem) => /is missing field "planRevision"/.test(problem)), missing.join(" | "));
  assert.ok(missing.some((problem) => /planRevision undefined is not a non-negative integer/.test(problem)), missing.join(" | "));

  // The graph restates the catalog's revision, and a graph that disagrees with the catalog beside it is refused.
  assert.ok(planDagProblems({ ...artifacts.dag, planRevision: 3 }, recorded).some((problem) => /planRevision 3 is not the plan catalog's 0/.test(problem)));
  assert.ok(planDagProblems({ ...artifacts.dag, previousPlanCatalogDigest: "a".repeat(64) }, recorded)
    .some((problem) => /previousPlanCatalogDigest "a{64}" is not the plan catalog's null/.test(problem)));
});

test("a plan cannot be derived at an incoherent revision at all", async () => {
  const run = await miniRun();
  const proposal = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const report = validatePlan({ catalog: run.catalog, requests: run.requests, proposal, registry: REPORT_POLICY_REGISTRY, budgetTable: PLAN_BUDGET_TABLE, evidence: run.evidenceById, reach: run.reach, epochCoverage: run.epochCoverage });
  assert.throws(() => buildPlanArtifacts({
    catalog: run.catalog, requests: run.requests, proposal, budgetTable: PLAN_BUDGET_TABLE, verdict: report.overall,
    revision: { planRevision: 2, previousPlanCatalogDigest: null, revisionReason: null }
  }), /The plan cannot be derived at this revision: planRevision 2 records no previousPlanCatalogDigest/);
  assert.deepEqual(planRevisionProblems(FIRST_PLAN_REVISION), []);
});

// --- ⑤ the stage: `--revise` end to end on a real run ------------------------------------------------

test("plan --revise records the next revision of a real run, and a plain plan of the same run is unchanged bytes", async () => {
  const base = await frozenRun(["product"]);
  const first = await planRun(base.runDir, { mode: "fixture" }, { kind: "record" });
  const { strandedDrafts, ...firstRevision } = first.revision;
  assert.deepEqual(firstRevision, { planRevision: 0, previousPlanCatalogDigest: null, revisionReason: null, archive: null, succession: [] });
  // The stranded-draft reading is taken on this arm too, and over a run with no receipt it is a MEASURED zero
  // (it names the plan it checked against) rather than an absent field.
  assert.equal(strandedDrafts.state, "read");
  assert.match(strandedDrafts.sentence, /^No drafted unit is waiting to be collected against a superseded plan, so this plan costs no re-drawing \(0 pending draft\(s\) checked against plan [0-9a-f]{16}\)$/);
  const recordedBytes = await readFile(planCatalogPath(base.runDir), "utf8");

  // Re-running the same plan writes the same bytes: the revision did not make a repeat plan a new revision.
  const again = await planRun(base.runDir, { mode: "fixture" }, { kind: "record" });
  assert.equal(again.revision.planRevision, 0);
  assert.equal(await readFile(planCatalogPath(base.runDir), "utf8"), recordedBytes);

  // A revise of a run whose plan and requests have not moved supersedes nothing, and says so.
  await assert.rejects(async () => planRun(base.runDir, { mode: "fixture" }, { kind: "revise", reason: "no change at all" }),
    /nothing is superseded, so no revision is recorded/);
  assert.equal(await readFile(planCatalogPath(base.runDir), "utf8"), recordedBytes, "the refusal wrote nothing");
});

test("plan --revise on a run with no recorded plan, and with a blank reason, are both refused by name", async () => {
  const base = await frozenRun(["product"]);
  await assert.rejects(async () => planRun(base.runDir, { mode: "fixture" }, { kind: "revise", reason: "there is nothing here yet" }),
    /is missing, so there is no plan for --revise to supersede; record one first/);
  await planRun(base.runDir, { mode: "fixture" }, { kind: "record" });
  await assert.rejects(async () => planRun(base.runDir, { mode: "fixture" }, { kind: "revise", reason: "   " }),
    /A plan revision states why it was recorded; `--reason` may not be blank/);
});

test("a proposal that does not validate cannot become a revision, and leaves the recorded revision alone", async () => {
  const base = await frozenRun(["product"]);
  await planRun(base.runDir, { mode: "fixture" }, { kind: "record" });
  const bad = `${base.workdir}/broken-proposal.json`;
  await writeFile(bad, `${stableJson({ version: "plan-proposal-v2", units: [], dispositions: [], budget: { version: "plan-budget-v2", documents: [] } })}\n`);
  await assert.rejects(async () => planRun(base.runDir, { mode: "file", path: bad }, { kind: "revise", reason: "a broken proposal" }),
    /does not validate against this run's epoch/);
  assert.equal((await readPlanCatalog(base.runDir, await readTopicCatalog(base.runDir))).planRevision, 0);
  assert.equal(await exists(planRevisionArchive(base.runDir, 0, 0).catalog), false, "a refused revision archives nothing");
});
