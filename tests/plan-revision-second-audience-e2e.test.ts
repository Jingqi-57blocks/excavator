/**
 * The epic's headline case, end to end on a real run: a second audience is requested and NOTHING already written
 * is drawn again — plus the reverse, which is what makes the first claim mean something.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE R6b ADMISSION E2E. That file establishes what the admission does with a
 * superseded plan. This one establishes that the superseded plan is reachable AT ALL through supported operations,
 * and that the whole chain — append a request, record the next plan revision, admit — buys the reuse the epic
 * claims. Before this slice the same scenario needed two plan artifacts deleted from the run directory to reach the
 * candidate state; the fixture no longer has a path that does that, so if the revision machinery stopped working
 * these tests would go red rather than quietly testing a hand-made state.
 *
 * THE TWO DIRECTIONS, AND WHY BOTH. Forward: appending a document leaves every unit of the document already
 * written admissible, byte for byte, because the identity of a unit does not carry the plan-global request digest.
 * Reverse: editing THE FIRST DOCUMENT'S OWN request row rebuilds every one of its units. A reuse claim with no
 * reverse case is indistinguishable from a cache that always says "reusable" — the per-document request row is
 * load-bearing, and this is the test that shows it carrying weight.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { exists, writeJson } from "../src/base/util.ts";
import { planCatalogDigest, readPlanCatalog } from "../src/report/plan-artifacts.ts";
import { planRevisionArchive, readPlanRevisionSuccession } from "../src/report/plan-revision.ts";
import { buildReportRequestsArtifact, reportRequestsPath } from "../src/report/report-requests-artifact.ts";
import type { LegacyDocumentRequest } from "../src/report/legacy-request-mapping.ts";
import { readTopicCatalog } from "../src/report/topics-artifact.ts";
import { admitUnits, planUnitAdmission } from "../src/report/unit-cache-admission-run.ts";
import { readUnitLedger } from "../src/report/unit-ledger.ts";
import { manifestOf, planViewOf } from "./unit-fixture.ts";
import {
  ADMISSION_AUTHORSHIP,
  FIRST_DOCUMENT,
  SECOND_DOCUMENT,
  admissionRun,
  authorEveryUnit,
  recordPlan,
  requestSecondDocument,
  withExtraLeaf
} from "./unit-cache-admission-fixture.ts";

const FIRST_UNITS = [
  `${FIRST_DOCUMENT}::appendix::coverage`,
  `${FIRST_DOCUMENT}::leaf::extra`,
  `${FIRST_DOCUMENT}::synthesis::document`
];
const SECOND_UNITS = [`${SECOND_DOCUMENT}::appendix::coverage`, `${SECOND_DOCUMENT}::synthesis::document`];

/** The unit ids of one outcome bucket of an executed admission, ascending. */
function outcomeIds(report: Awaited<ReturnType<typeof admitUnits>>, outcome: "admitted" | "fell-to-rebuild" | "skipped-new"): string[] {
  return report.outcomes.filter((row) => row.outcome === outcome).map((row) => row.unit.unitId).sort();
}

// --- ① the flagship: one more audience, nothing re-drawn ----------------------------------------------

test("a second audience is requested, the plan is revised, and every unit already written is reused rather than re-drawn", async () => {
  const run = await admissionRun();
  const recordedBefore = await readPlanCatalog(run.runDir, await readTopicCatalog(run.runDir));
  await authorEveryUnit(run);
  const before = await readUnitLedger(run.runDir, run.manifest.id);
  assert.deepEqual(before.units.map((row) => row.unitId).sort(), FIRST_UNITS);

  // The two supported acts, in order: append the request, then record the revision that covers it.
  await requestSecondDocument(run);
  const revised = await recordPlan(run, "two-documents", withExtraLeaf(FIRST_DOCUMENT));
  const current = await readPlanCatalog(run.runDir, await readTopicCatalog(run.runDir));

  // The bookkeeping: the next revision, naming its predecessor, with the predecessor archived unchanged.
  assert.equal(current.planRevision, recordedBefore.planRevision + 1);
  assert.equal(current.previousPlanCatalogDigest, planCatalogDigest(recordedBefore));
  assert.equal(current.revisionReason, "the two-documents scenario re-plans this run");
  const archive = planRevisionArchive(run.runDir, current.knowledgeEpoch, recordedBefore.planRevision);
  assert.equal(JSON.parse(await readFile(archive.catalog, "utf8")).planRevision, recordedBefore.planRevision);
  // The chain reads back from the archive, and its last link is the plan the units were written against. (The run
  // is at revision 2: the frozen run's own plan, the fixture's extra leaf, and this append.)
  const succession = await readPlanRevisionSuccession(run.runDir, current);
  assert.equal(succession.length, current.planRevision);
  assert.equal(succession.at(-1), `revision ${current.planRevision} supersedes revision ${recordedBefore.planRevision} (${planCatalogDigest(recordedBefore)})`);

  // The reuse, in both passes: what the cache plan says, and what the admission then does.
  const planOnly = await planUnitAdmission(run.runDir, ADMISSION_AUTHORSHIP);
  assert.deepEqual(planOnly.intents.filter((row) => row.intent === "admit").map((row) => row.unit.unitId).sort(), FIRST_UNITS);
  assert.deepEqual(planOnly.intents.filter((row) => row.intent === "rebuild").map((row) => row.unit.unitId).sort(), []);
  assert.deepEqual(planOnly.intents.filter((row) => row.intent === "new").map((row) => row.unit.unitId).sort(), SECOND_UNITS);

  const report = await admitUnits(run.runDir, ADMISSION_AUTHORSHIP);
  assert.deepEqual(outcomeIds(report, "admitted"), FIRST_UNITS, "every unit of the document already written is admitted");
  assert.deepEqual(outcomeIds(report, "fell-to-rebuild"), [], "the second audience re-draws nothing");
  assert.deepEqual(outcomeIds(report, "skipped-new"), SECOND_UNITS, "only the new document has to be written");
  assert.equal(report.account.reused, FIRST_UNITS.length);
  assert.deepEqual(report.account.statements, [
    "planned = admitted + fell-to-rebuild + skipped-new: 5 = 3 + 0 + 2",
    "ledger rows = offered as candidates + excluded: 3 = 3 + 0"
  ]);

  // Byte for byte, and recorded under the revision now in force.
  const after = await readUnitLedger(run.runDir, run.manifest.id);
  for (const unitId of FIRST_UNITS) {
    const was = before.units.find((row) => row.unitId === unitId)!;
    const now = after.units.find((row) => row.unitId === unitId)!;
    assert.deepEqual([now.contentDigest, now.claimsDigest, now.summaryDigest], [was.contentDigest, was.claimsDigest, was.summaryDigest]);
    assert.equal(now.planCatalogDigest, revised.view.planCatalogDigest);
    assert.equal(now.provenance.kind, "cache-admitted");
  }
  assert.equal(await exists(planRevisionArchive(run.runDir, current.knowledgeEpoch, current.planRevision).catalog), false,
    "the revision in force is not archived: the archive holds what was superseded");
});

// --- ② the reverse: the first document's own request row is load-bearing -------------------------------

test("editing the first document's own request row rebuilds every one of its units, so the reuse above is not vacuous", async () => {
  const run = await admissionRun();
  await authorEveryUnit(run);
  const before = await readUnitLedger(run.runDir, run.manifest.id);
  assert.deepEqual(before.units.map((row) => row.unitId).sort(), FIRST_UNITS);

  // The perturbation is the SAME KIND of fact as the append — one recorded request row — but it lands on the
  // document that was already written. Hand-written because the append door refuses to edit a recorded row: what
  // is being established is that the unit identity carries its own document's request, not that the door works.
  const manifest = await manifestOf(run.runDir);
  const edited: LegacyDocumentRequest = {
    documentId: FIRST_DOCUMENT,
    kind: manifest.documents[0]!.kind,
    audience: manifest.documents[0]!.audience,
    featureKey: null,
    detailLevel: "detailed",
    language: manifest.request.language
  };
  assert.notEqual(edited.detailLevel, manifest.request.detailLevel ?? "standard", "the fixture's own detail level must actually move");
  await writeJson(reportRequestsPath(run.runDir), buildReportRequestsArtifact([edited]));

  const revised = await recordPlan(run, "detailed-first-document", withExtraLeaf(FIRST_DOCUMENT));
  assert.equal((await readPlanCatalog(run.runDir, await readTopicCatalog(run.runDir))).planRevision, 2);

  const plan = await planUnitAdmission(run.runDir, ADMISSION_AUTHORSHIP);
  assert.deepEqual(plan.intents.filter((row) => row.intent === "admit").map((row) => row.unit.unitId).sort(), [],
    "a changed request row for this document leaves none of its units reusable");
  assert.deepEqual(plan.intents.filter((row) => row.intent === "rebuild").map((row) => row.unit.unitId).sort(), FIRST_UNITS);

  const report = await admitUnits(run.runDir, ADMISSION_AUTHORSHIP);
  assert.deepEqual(outcomeIds(report, "admitted"), []);
  assert.deepEqual(outcomeIds(report, "fell-to-rebuild"), FIRST_UNITS);
  assert.equal(report.account.reused, 0);
  // And nothing was recorded under the revision in force: a rebuild is written by an author, not admitted.
  const after = await readUnitLedger(run.runDir, run.manifest.id);
  assert.deepEqual(after.units.filter((row) => row.planCatalogDigest === revised.view.planCatalogDigest).map((row) => row.unitId), []);
});

// --- ③ the archive is the only history, and it survives further revisions -----------------------------

test("every revision this run passed through is archived once, and the chain reads back to revision 0", async () => {
  const run = await admissionRun();
  await authorEveryUnit(run);
  await requestSecondDocument(run);
  await recordPlan(run, "two-documents", withExtraLeaf(FIRST_DOCUMENT));
  await admitUnits(run.runDir, ADMISSION_AUTHORSHIP);
  // A third revision on top of an admitted run: the units admitted a moment ago become candidates again.
  await recordPlan(run, "retitled-again", (units, catalog) => withExtraLeaf(FIRST_DOCUMENT)(units, catalog)
    .map((unit) => (unit.unitId === `${FIRST_DOCUMENT}::leaf::extra` ? { ...unit, title: "Two more obligation dimensions, again" } : unit)));

  const current = await readPlanCatalog(run.runDir, await readTopicCatalog(run.runDir));
  assert.equal(current.planRevision, 3, "revision 0 from the frozen run, then the fixture's leaf, the append, and this one");
  const succession = await readPlanRevisionSuccession(run.runDir, current);
  assert.equal(succession.length, 3);
  assert.match(succession[0]!, /^revision 1 supersedes revision 0 \([0-9a-f]{64}\)$/);
  assert.match(succession[2]!, /^revision 3 supersedes revision 2 \([0-9a-f]{64}\)$/);
  for (const revision of [0, 1, 2]) {
    assert.ok(await exists(planRevisionArchive(run.runDir, current.knowledgeEpoch, revision).catalog), `revision ${revision} is archived`);
    assert.ok(await exists(planRevisionArchive(run.runDir, current.knowledgeEpoch, revision).dag), `revision ${revision}'s graph is archived`);
  }
  const view = await planViewOf(run.runDir);
  assert.equal(view.planCatalogDigest, planCatalogDigest(current), "the view reads the revision in force");
});
