/**
 * R6b end to end, on real run directories: author, re-plan, admit — and every set asserted is computed HERE.
 *
 * WHY NOTHING IN THIS FILE IS COMPARED AGAINST A CHECKED-IN JSON. A recorded reading can only certify the fixture
 * that produced it; these tests have to certify the IMPLEMENTATION, so each one drives the real chain (`draftUnit`,
 * `collectUnits`, `planRun`, then `admitUnits`) against a run on disk and asserts the sets it just derived. The eval
 * readings exist for numbers in a PR table and are not evidence for anything here.
 *
 * THE FOUR THINGS BEING ESTABLISHED:
 *
 *   1. A re-plan that adds a document admits every unit of the documents already written, byte for byte, with the
 *      provenance recorded — and calls the new document's units new. That is the epic's own acceptance for R6.
 *   2. A re-plan that moves one unit rebuilds exactly that unit and its ancestors, admits its siblings, and the
 *      EXECUTION agrees with the invalidation plan id for id. Plan and execution are one derivation or the cache is
 *      two answers.
 *   3. Neither drifted bytes nor a broken grounding can ride in on a matching identity. The first is downgraded
 *      before anything is written; the second is refused by `collect`, which leaves the receipt so a correction can
 *      be collected. There is no path from "the identity matched" to "it is in the ledger".
 *   4. A candidate from another knowledge epoch is never a candidate, and "nothing to admit" is a different
 *      sentence from "everything was admitted" and from "it is all already recorded".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { auditTimeline, readTimeline } from "../src/base/timeline.ts";
import { exists, sha256, writeJson } from "../src/base/util.ts";
import { admitUnits, planUnitAdmission } from "../src/report/unit-cache-admission-run.ts";
import { cachePlanIds, type UnitAdmissionOutcome, type UnitAdmissionPlan, type UnitAdmissionReport } from "../src/report/unit-cache-admission.ts";
import { readUnitLedger, writeUnitLedger, type CollectedUnit } from "../src/report/unit-ledger.ts";
import { unitClaimsDigest, unitSummaryDigest, parseUnitSummary, validateUnitClaims, type UnitSummary } from "../src/report/unit-output.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import { loadUnitPlanView } from "../src/report/unit-plan-view.ts";
import { claimFor, materialisedRun, unitDraftWithClaims } from "./unit-grounding-fixture.ts";
import { plannedRun } from "./unit-fixture.ts";
import {
  ADMISSION_AUTHORSHIP,
  FIRST_DOCUMENT,
  SECOND_DOCUMENT,
  admissionRun,
  authorEveryUnit,
  recordPlan,
  requestSecondDocument,
  withExtraLeaf,
  withTitle
} from "./unit-cache-admission-fixture.ts";

const LEAF = `${FIRST_DOCUMENT}::leaf::extra`;
const APPENDIX = `${FIRST_DOCUMENT}::appendix::coverage`;
const SYNTHESIS = `${FIRST_DOCUMENT}::synthesis::document`;

/** The unit ids of one outcome bucket, ascending. */
function outcomeIds(report: UnitAdmissionReport, outcome: UnitAdmissionOutcome["outcome"]): string[] {
  return report.outcomes.filter((row) => row.outcome === outcome).map((row) => row.unit.unitId).sort();
}

/** The unit ids of one intent bucket of the read-only pass, ascending. */
function intentIds(plan: UnitAdmissionPlan, intent: "admit" | "rebuild" | "new"): string[] {
  return plan.intents.filter((row) => row.intent === intent).map((row) => row.unit.unitId).sort();
}

function rowOf(units: readonly CollectedUnit[], unitId: string): CollectedUnit {
  const row = units.find((entry) => entry.unitId === unitId);
  if (!row) throw new Error(`the ledger holds no row for ${unitId}; the test's premise is gone`);
  return row;
}

/** The cause of one fell-to-rebuild outcome, or a named failure: a bucket without its cause proves nothing. */
function rebuildCause(report: UnitAdmissionReport, unitId: string): string {
  const row = report.outcomes.find((entry) => entry.unit.unitId === unitId);
  if (!row || row.outcome !== "fell-to-rebuild") throw new Error(`${unitId} is ${row?.outcome ?? "absent"}, not fell-to-rebuild`);
  return row.cause;
}

// --- (1) the second audience: everything already written is admitted -----------------------------------

test("a second requested document admits every unit already written, byte for byte, and calls the new document's units new", async () => {
  const run = await admissionRun();
  const written = [...run.view.collectionOrder].sort();
  assert.deepEqual(written, [APPENDIX, LEAF, SYNTHESIS], "the fixture plans one appendix, a second leaf, and their synthesis");
  await authorEveryUnit(run);
  const before = await readUnitLedger(run.runDir, run.manifest.id);
  assert.deepEqual(before.units.map((row) => row.unitId).sort(), written);
  for (const row of before.units) assert.equal(row.provenance.kind, "fresh", `${row.unitId} was written, not admitted`);

  await requestSecondDocument(run);
  const replanned = await recordPlan(run, "two-documents", withExtraLeaf(FIRST_DOCUMENT));
  assert.notEqual(replanned.view.planCatalogDigest, run.view.planCatalogDigest, "the re-plan must supersede the rows, or there is nothing to admit");
  assert.equal(replanned.view.units.length, 5, "three units of the first document and two of the second");

  const report = await admitUnits(run.runDir, ADMISSION_AUTHORSHIP);
  assert.deepEqual(outcomeIds(report, "admitted"), written, "every unit of the document already written is admitted");
  assert.deepEqual(outcomeIds(report, "fell-to-rebuild"), [], "a second audience rewrites nothing of the first");
  assert.deepEqual(outcomeIds(report, "skipped-new"), [`${SECOND_DOCUMENT}::appendix::coverage`, `${SECOND_DOCUMENT}::synthesis::document`].sort());
  assert.deepEqual(report.account.statements, [
    "planned = admitted + fell-to-rebuild + skipped-new: 5 = 3 + 0 + 2",
    "ledger rows = offered as candidates + excluded: 3 = 3 + 0"
  ]);

  // The ledger: new rows under the plan now in force, the same bytes, and the provenance naming what they came from.
  const after = await readUnitLedger(run.runDir, run.manifest.id);
  for (const unitId of written) {
    const was = rowOf(before.units, unitId);
    const now = rowOf(after.units, unitId);
    assert.equal(now.planCatalogDigest, replanned.view.planCatalogDigest, `${unitId} is recorded under the plan in force`);
    assert.deepEqual(
      [now.contentDigest, now.claimsDigest, now.summaryDigest],
      [was.contentDigest, was.claimsDigest, was.summaryDigest],
      `${unitId} must be re-entered byte for byte`
    );
    assert.equal(now.packetIdentityDigest, was.packetIdentityDigest, `${unitId}'s freshly computed identity must be the one the decision was made on`);
    assert.deepEqual(now.provenance, {
      kind: "cache-admitted",
      source: {
        knowledgeEpoch: was.knowledgeEpoch,
        planCatalogDigest: was.planCatalogDigest,
        packetIdentityDigest: was.packetIdentityDigest,
        contentDigest: was.contentDigest,
        claimsDigest: was.claimsDigest,
        summaryDigest: was.summaryDigest
      }
    }, `${unitId}'s provenance must name the row it re-entered`);
    assert.ok(now.timelineSequence > was.timelineSequence, `${unitId} appended a new event`);
  }

  // The chain says so too: every admission is a timeline event, and the chain is still contiguous and valid.
  const admittedEvents = (await readTimeline(run.runDir))
    .filter((event) => (event.data as Record<string, unknown>)?.provenance === "cache-admitted");
  assert.deepEqual(admittedEvents.map((event) => (event.data as Record<string, unknown>).unitId as string).sort(), written);
  assert.deepEqual(await auditTimeline(run.runDir, run.manifest.id), []);

  // No receipt survives an admission: a stale one would be the next collect's problem.
  for (const unitId of written) assert.equal(await exists(unitPaths(run.runDir, unitId).receipt), false);
});

// --- (2) the moved unit: leaf and ancestors rebuilt, sibling admitted, plan and execution identical ----

test("one unit's title moves: exactly it and its ancestor fall to rebuild, its sibling is admitted, and the plan and the execution agree id for id", async () => {
  const run = await admissionRun();
  await authorEveryUnit(run);
  await recordPlan(run, "retitled", (units, catalog) =>
    withTitle(LEAF, "Two more obligation dimensions, retitled")(withExtraLeaf(FIRST_DOCUMENT)(units, catalog), catalog));

  // The read-only pass first, so the comparison below is between two independent passes over the same run.
  const plan = await planUnitAdmission(run.runDir, ADMISSION_AUTHORSHIP);
  assert.deepEqual(intentIds(plan, "admit"), [APPENDIX]);
  assert.deepEqual(intentIds(plan, "rebuild"), [LEAF, SYNTHESIS].sort());
  assert.deepEqual(intentIds(plan, "new"), []);
  // THE SAME-SOURCE ASSERTION: the intents are R6a's buckets, not a second opinion about them.
  assert.deepEqual(intentIds(plan, "admit"), cachePlanIds(plan.cachePlan, "reusable"));
  assert.deepEqual(intentIds(plan, "rebuild"), cachePlanIds(plan.cachePlan, "rebuild"));
  assert.deepEqual(intentIds(plan, "new"), cachePlanIds(plan.cachePlan, "new"));

  const report = await admitUnits(run.runDir, ADMISSION_AUTHORSHIP);
  assert.deepEqual(outcomeIds(report, "admitted"), [APPENDIX], "the sibling that did not move is reused");
  assert.deepEqual(outcomeIds(report, "fell-to-rebuild"), [LEAF, SYNTHESIS].sort());
  assert.deepEqual(outcomeIds(report, "admitted"), intentIds(plan, "admit"), "execution and plan name the same units");
  assert.deepEqual(outcomeIds(report, "fell-to-rebuild"), intentIds(plan, "rebuild"));
  assert.equal(rebuildCause(report, LEAF), "identity-differs");
  assert.equal(rebuildCause(report, SYNTHESIS), "identity-differs", "a synthesis whose child moved is rebuilt for the same reason the plan gives");

  // The reasons name what moved: the retitled unit's own identity, and the child that made the root stale.
  const leafRebuild = plan.cachePlan.entries.find((entry) => entry.unitId === LEAF);
  assert.equal(leafRebuild?.status, "rebuild");
  if (leafRebuild?.status === "rebuild") {
    assert.equal(leafRebuild.reason.cause, "recorded-identity-differs", "a live candidate's identity is known only from its ledger row");
    assert.match(leafRebuild.reason.statement, /the plan that candidate was drafted under is no longer on disk/);
  }
  const rootRebuild = plan.cachePlan.entries.find((entry) => entry.unitId === SYNTHESIS);
  if (rootRebuild?.status === "rebuild") {
    assert.equal(rootRebuild.reason.cause, "child-not-reusable");
    assert.deepEqual(rootRebuild.reason.cause === "child-not-reusable" ? [...rootRebuild.reason.blockingChildUnitIds] : [], [LEAF]);
  }

  // Only the admitted unit moved in the ledger; the two rebuilt ones still sit under the superseded plan.
  const after = await readUnitLedger(run.runDir, run.manifest.id);
  const current = await loadUnitPlanView(run.runDir);
  assert.deepEqual(after.units.filter((row) => row.planCatalogDigest === current.planCatalogDigest).map((row) => row.unitId), [APPENDIX]);
  assert.equal(rowOf(after.units, APPENDIX).provenance.kind, "cache-admitted");
  assert.equal(rowOf(after.units, LEAF).provenance.kind, "fresh", "a unit that fell to rebuild is not recorded again by the admission");
  assert.deepEqual(await auditTimeline(run.runDir, run.manifest.id), []);
});

// --- (3a) drifted bytes: the identity matched and the admission still refuses ---------------------------

test("a candidate whose artifacts moved on disk is named and falls to rebuild, and its neighbours are decided on their own", async () => {
  const run = await admissionRun();
  await authorEveryUnit(run);
  const before = await readUnitLedger(run.runDir, run.manifest.id);
  const paths = unitPaths(run.runDir, LEAF);
  const content = await readFile(paths.content, "utf8");
  // ONE byte, appended where nothing else can notice it: the plan, the topics and the identity are untouched.
  await writeFile(paths.content, `${content}x\n`);

  await requestSecondDocument(run);
  await recordPlan(run, "two-documents", withExtraLeaf(FIRST_DOCUMENT));
  const report = await admitUnits(run.runDir, ADMISSION_AUTHORSHIP);

  assert.equal(rebuildCause(report, LEAF), "candidate-drift");
  const drifted = report.outcomes.find((row) => row.unit.unitId === LEAF);
  assert.match(drifted?.outcome === "fell-to-rebuild" ? drifted.statement : "", /has content digesting to [0-9a-f]{64}, but its ledger row promises [0-9a-f]{64}/);
  assert.equal(rebuildCause(report, SYNTHESIS), "identity-differs", "its child holds no verified summary, so the root has no identity to compare");
  assert.deepEqual(outcomeIds(report, "admitted"), [APPENDIX], "a drifted neighbour does not cost the others their admission");

  // The ledger row of the drifted unit is untouched: nothing was recorded from bytes nobody verified.
  const after = await readUnitLedger(run.runDir, run.manifest.id);
  assert.deepEqual(rowOf(after.units, LEAF), rowOf(before.units, LEAF));
  // And the reading names the row rather than dropping it.
  const row = report.ledgerRows.find((entry) => entry.unitId === LEAF);
  assert.equal(row?.disposition.state, "offered");
  assert.equal(row?.disposition.state === "offered" ? row.disposition.verification.state : "", "drifted");
});

// --- (3b) the grounding audit is not bypassable --------------------------------------------------------

test("a candidate whose claims stopped grounding its obligations is refused by collect, keeps its receipt, and is collected after a fix", async () => {
  const run = await materialisedRun();
  const planned = { runDir: run.runDir, workdir: run.workdir, manifest: run.manifest, evidenceId: run.foundEvidenceId, view: run.view };
  // The obligation OWNER, by the same route `tests/unit-grounding.test.ts` names it: the work-item-dimension leaf.
  const owner = run.view.units.find((unit) => unit.unitId.endsWith("::leaf::work-item-dimension"));
  if (!owner) throw new Error("the materialised fixture must plan a work-item-dimension leaf that owns the material obligations");
  const right = [
    claimFor("C-found", run.foundWorkItemId, { evidenceIds: [run.foundEvidenceId] }),
    claimFor("C-unresolved", run.unresolvedWorkItemId, { marker: "unavailable" })
  ];
  for (const unitId of run.view.collectionOrder) {
    await draftUnit(run.runDir, await unitDraftWithClaims(run, unitId, unitId === owner.unitId ? right : []));
    await collectUnits(run.runDir);
  }

  // The tamper: claims that ground nothing, with the summary and the LEDGER ROW made to agree with them. This is
  // the shape an identity can never catch — claims are a unit's OUTPUT and no packet input mentions them — so the
  // grounding audit is the only thing between it and the ledger.
  const paths = unitPaths(run.runDir, owner.unitId);
  const wrong = validateUnitClaims(owner.unitId, owner.documentId, [claimFor("C-ungrounded", run.foundWorkItemId, { evidenceIds: [] })]);
  await writeJson(paths.claims, wrong);
  const parsed = parseUnitSummary(JSON.parse(await readFile(paths.summary, "utf8")) as unknown);
  if (!parsed.summary) throw new Error(`the fixture's own summary does not parse: ${parsed.problems.join("; ")}`);
  const summary: UnitSummary = { ...parsed.summary, claimsDigest: unitClaimsDigest(wrong) };
  await writeJson(paths.summary, summary);
  const ledger = await readUnitLedger(run.runDir, run.manifest.id);
  await writeUnitLedger(run.runDir, {
    ...ledger,
    units: ledger.units.map((row) => (row.unitId === owner.unitId
      ? { ...row, claimsDigest: unitClaimsDigest(wrong), summaryDigest: unitSummaryDigest(summary) }
      : row))
  });

  await requestSecondDocument(planned);
  // No plan reload between these two: the gate refuses a recorded plan that has no unit for a requested document,
  // which is exactly the window `recordPlan` closes. It needs the run's paths, not a view.
  await recordPlan(planned, "two-documents", (units) => units);
  const report = await admitUnits(run.runDir, ADMISSION_AUTHORSHIP);

  assert.equal(rebuildCause(report, owner.unitId), "collect-refused");
  const refused = report.outcomes.find((row) => row.unit.unitId === owner.unitId);
  assert.match(refused?.outcome === "fell-to-rebuild" ? refused.statement : "", /cannot be collected: .*obligation/);
  assert.deepEqual(outcomeIds(report, "admitted").filter((unitId) => unitId === owner.unitId), [], "nothing ungrounded reaches the ledger");
  assert.ok(await exists(paths.receipt), "the refused receipt stays on disk so a correction can be collected");
  const afterRefusal = await readUnitLedger(run.runDir, run.manifest.id);
  const current = await loadUnitPlanView(run.runDir);
  assert.equal(afterRefusal.units.some((row) => row.unitId === owner.unitId && row.planCatalogDigest === current.planCatalogDigest), false,
    "the refused unit has no row under the plan now in force");

  // No permanent write-off: re-draft the unit with claims that ground, and the same barrier records it.
  await draftUnit(run.runDir, await unitDraftWithClaims({ ...run, view: current }, owner.unitId, right));
  const collected = await collectUnits(run.runDir);
  assert.ok(collected.collected.some((receipt) => receipt.unitId === owner.unitId), "a corrected draft is collected");
  const fixed = rowOf((await readUnitLedger(run.runDir, run.manifest.id)).units, owner.unitId);
  assert.equal(fixed.provenance.kind, "fresh", "the corrected unit was written, not admitted");
  assert.deepEqual(await auditTimeline(run.runDir, run.manifest.id), []);
});

// --- (4a) another epoch's rows are never candidates ----------------------------------------------------

test("candidates from another knowledge epoch are excluded by name, and nothing is admitted", async () => {
  const run = await admissionRun();
  await authorEveryUnit(run);
  const ledger = await readUnitLedger(run.runDir, run.manifest.id);
  // The epoch perturbation, at the value layer: 57B-462 keeps a real re-freeze from reaching a new epoch's plan on
  // this branch, and what has to be asserted is the CANDIDATE side of the comparison.
  await writeUnitLedger(run.runDir, { ...ledger, units: ledger.units.map((row) => ({ ...row, knowledgeEpoch: row.knowledgeEpoch + 1 })) });

  const report = await admitUnits(run.runDir, ADMISSION_AUTHORSHIP);
  assert.equal(report.account.reused, 0, "nothing may be admitted from another epoch's rows");
  assert.deepEqual(outcomeIds(report, "skipped-new"), [...run.view.collectionOrder].sort());
  assert.match(report.candidateStatement, /^0 prior verified units: this run's unit ledger holds 3 row\(s\) and none is a candidate: 3 from another knowledge epoch/);
  for (const row of report.ledgerRows) {
    assert.equal(row.disposition.state, "excluded");
    assert.equal(row.disposition.state === "excluded" ? row.disposition.cause : "", "other-epoch");
    assert.match(row.disposition.state === "excluded" ? row.disposition.statement : "", /re-drawn, never admitted/);
  }
  // Nothing was written: the rows are still the perturbed ones and the chain did not move.
  const after = await readUnitLedger(run.runDir, run.manifest.id);
  assert.deepEqual(after.units.map((row) => row.knowledgeEpoch), ledger.units.map((row) => row.knowledgeEpoch + 1));
});

// --- (4b) the three empty-and-full readings are three different sentences ------------------------------

test("nothing to admit, everything admitted, and it is all already recorded are three distinguishable readings", async () => {
  // The zero-feature shape: one appendix and its synthesis, nothing authored yet.
  const fresh = await plannedRun(["product"]);
  assert.deepEqual([...fresh.view.collectionOrder], [APPENDIX, SYNTHESIS]);
  const first = await planUnitAdmission(fresh.runDir, ADMISSION_AUTHORSHIP);
  assert.match(first.candidateStatement, /^0 prior verified units: this run's unit ledger records no collected unit at all/);
  assert.deepEqual(intentIds(first, "new"), [APPENDIX, SYNTHESIS]);
  assert.deepEqual(intentIds(first, "admit"), []);
  assert.equal(first.account.offeredCandidates, 0);

  await authorEveryUnit(fresh);
  // Authored but not re-planned: every row is already collected under the plan in force — a different sentence.
  const recorded = await planUnitAdmission(fresh.runDir, ADMISSION_AUTHORSHIP);
  assert.match(recorded.candidateStatement, /^0 prior verified units: this run's unit ledger holds 2 row\(s\) and none is a candidate: 0 from another knowledge epoch and 2 already collected under the plan now in force$/);
  assert.notEqual(recorded.candidateStatement, first.candidateStatement);
  // And per unit, the sentence says the unit needs nothing written — the one thing "new" could be misread as.
  for (const intent of recorded.intents) {
    assert.equal(intent.intent, "new");
    assert.match(intent.statement, /is already collected under the plan now in force, so it offers nothing to admit and needs nothing written/);
  }
  for (const intent of first.intents) assert.doesNotMatch(intent.statement, /needs nothing written/, "a first pass must not say a unit is already recorded");

  // And after a re-plan, the same command offers them — the third sentence, with the plan they were verified under.
  await requestSecondDocument(fresh);
  const replanned = await recordPlan(fresh, "two-documents", (units) => units);
  const offering = await planUnitAdmission(fresh.runDir, ADMISSION_AUTHORSHIP);
  assert.match(offering.candidateStatement, new RegExp(`^2 prior verified unit\\(s\\) offered by run ${fresh.manifest.id}, knowledge epoch 0, plan catalog [0-9a-f]{64}$`));
  assert.deepEqual(intentIds(offering, "admit"), [APPENDIX, SYNTHESIS]);
  assert.equal(replanned.view.units.length, 4);
  // The read-only pass wrote nothing: the ledger still records the two units under the superseded plan.
  const ledger = await readUnitLedger(fresh.runDir, fresh.manifest.id);
  assert.deepEqual(ledger.units.map((row) => row.planCatalogDigest === replanned.view.planCatalogDigest), [false, false]);
});

// --- (3c) the re-entry tripwire leaves nothing collectable, and an unreadable artifact downgrades ------

test("a candidate whose recorded bytes are not the normalized ones is refused before anything is written", async () => {
  const run = await admissionRun();
  await authorEveryUnit(run);
  const before = await readUnitLedger(run.runDir, run.manifest.id);
  /*
   * A candidate whose recorded bytes are NOT normalized: on disk, verified by its own row, and impossible to
   * re-enter unchanged because `draftUnit` normalizes what it is handed.
   *
   * WHICH GATE CATCHES IT IS THE FINDING. Not the admission's own byte-identity tripwire — `draftUnit` refuses
   * first, when the summary it is handed disagrees with the bytes about to land, and it refuses BEFORE writing
   * anything. So this state costs the run nothing: no artifact is replaced, no receipt exists to be collected, and
   * the ledger row still points at the bytes it always did. The tripwire behind that gate (which also compares the
   * identity digest, something no other gate looks at) removes its receipt before throwing, so a refusal there
   * cannot leave a collectable draft either; there is no legal state that reaches it, which is why this test pins
   * the gate that does.
   */
  const paths = unitPaths(run.runDir, APPENDIX);
  const unnormalized = (await readFile(paths.content, "utf8")).trimEnd();
  await writeFile(paths.content, unnormalized);
  const summary = parseUnitSummary(JSON.parse(await readFile(paths.summary, "utf8")) as unknown);
  if (!summary.summary) throw new Error(`the fixture's own summary does not parse: ${summary.problems.join("; ")}`);
  const retold: UnitSummary = { ...summary.summary, contentDigest: sha256(unnormalized) };
  await writeJson(paths.summary, retold);
  await writeUnitLedger(run.runDir, {
    ...before,
    units: before.units.map((row) => (row.unitId === APPENDIX
      ? { ...row, contentDigest: sha256(unnormalized), summaryDigest: unitSummaryDigest(retold) }
      : row))
  });

  await requestSecondDocument(run);
  await recordPlan(run, "two-documents", withExtraLeaf(FIRST_DOCUMENT));
  await assert.rejects(() => admitUnits(run.runDir, ADMISSION_AUTHORSHIP),
    /disagrees with this run: records contentDigest [0-9a-f]{64} but the content beside it digests to [0-9a-f]{64}/);
  // THE POINT: nothing is collectable afterwards, so the bytes no gate accepted cannot become a record.
  assert.equal(await exists(paths.receipt), false, "a refused re-entry must not leave a collectable receipt");
  assert.equal(await readFile(paths.content, "utf8"), unnormalized, "the candidate's own artifact was not rewritten");
  const collected = await collectUnits(run.runDir);
  assert.deepEqual(collected.collected.map((receipt) => receipt.unitId), [], "there is nothing to collect");
  const after = await readUnitLedger(run.runDir, run.manifest.id);
  const current = await loadUnitPlanView(run.runDir);
  assert.equal(after.units.some((row) => row.planCatalogDigest === current.planCatalogDigest), false,
    "no unit was recorded under the plan now in force");
});

test("an artifact that exists but cannot be read downgrades one candidate instead of aborting the pass", async () => {
  const run = await admissionRun();
  await authorEveryUnit(run);
  await requestSecondDocument(run);
  await recordPlan(run, "two-documents", withExtraLeaf(FIRST_DOCUMENT));
  // `exists` is true and `readFile` is not: the shape a directory (or a permission change) at content.md takes.
  const paths = unitPaths(run.runDir, LEAF);
  await rm(paths.content);
  await mkdir(paths.content);

  const plan = await planUnitAdmission(run.runDir, ADMISSION_AUTHORSHIP);
  const row = plan.ledgerRows.find((entry) => entry.unitId === LEAF);
  assert.equal(row?.disposition.state, "offered");
  assert.equal(row?.disposition.state === "offered" ? row.disposition.verification.state : "", "drifted");
  assert.match(row?.disposition.state === "offered" && row.disposition.verification.state === "drifted"
    ? row.disposition.verification.problems.join("; ") : "", /content\.md could not be read: /);
  assert.deepEqual(intentIds(plan, "admit"), [APPENDIX], "the readable candidate is decided on its own");
});

// --- (3d) a drift on a row already collected under this plan is reported, not discarded ----------------

test("a drift on a unit already collected under the plan in force is named in the reading rather than measured and dropped", async () => {
  const run = await admissionRun();
  await authorEveryUnit(run);
  const paths = unitPaths(run.runDir, APPENDIX);
  await writeFile(paths.content, `${await readFile(paths.content, "utf8")}edited after collect\n`);

  const plan = await planUnitAdmission(run.runDir, ADMISSION_AUTHORSHIP);
  const row = plan.ledgerRows.find((entry) => entry.unitId === APPENDIX);
  assert.equal(row?.disposition.state, "excluded");
  assert.equal(row?.disposition.state === "excluded" ? row.disposition.cause : "", "collected-under-this-plan");
  assert.match(row?.disposition.state === "excluded" ? row.disposition.statement : "",
    /there is nothing to admit for it — but its artifacts on disk are no longer the bytes that row promised: Unit ".*" has content digesting to [0-9a-f]{64}, but its ledger row promises [0-9a-f]{64}/);
});
