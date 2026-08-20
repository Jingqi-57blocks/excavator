/**
 * THE PREMISE UNDER R6c'S RULING, as a check that goes red: an admission trusts no RECORD's verdict.
 *
 * R6c took the receipt schema version out of the identity key, and the whole argument for that rests on one
 * property of `unit-cache-admission-run.ts`: a candidate is a ledger row plus three artifacts, the row's promises
 * are re-verified against the bytes on disk, and the re-entry goes back through `draftUnit` and `collectUnits` with
 * every existing gate — so a receipt is never read, never revived, and its schema version cannot decide a reuse.
 * The day some path starts believing a record instead of re-checking it, that record's version belongs back in the
 * key, and this file is what says so out loud.
 *
 * TWO THINGS ARE ESTABLISHED HERE, and the second is the one the ruling needs:
 *
 *   1. NO CANDIDATE HAS A RECEIPT AT ALL. `collect` deletes a receipt when it records the draft it vouched for, so
 *      by the time a row is a candidate there is no receipt on disk to trust — and the receipt an admission does
 *      produce is minted after the decision, by `draftUnit`, under the plan now in force.
 *   2. A TAMPERED ROW IS NOT BELIEVED. The candidate's ledger row is edited to promise a different summary digest —
 *      the record, not the bytes — and the admission names the disagreement and falls to rebuild. Nothing is
 *      recorded, and the row itself is left alone. `tests/unit-cache-admission-e2e.test.ts` covers the mirror image
 *      (the BYTES moved and the row is intact); together they say the comparison is performed rather than assumed.
 *
 * Both go through the real doors on a real run directory. Nothing here hand-builds a prior state.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { exists } from "../src/base/util.ts";
import { admitUnits, planUnitAdmission } from "../src/report/unit-cache-admission-run.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { readUnitLedger, writeUnitLedger, type CollectedUnit, type UnitLedger } from "../src/report/unit-ledger.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import {
  ADMISSION_AUTHORSHIP,
  FIRST_DOCUMENT,
  admissionRun,
  authorEveryUnit,
  recordPlan,
  requestSecondDocument,
  withExtraLeaf
} from "./unit-cache-admission-fixture.ts";
import { unitDraftFor } from "./unit-fixture.ts";

const LEAF = `${FIRST_DOCUMENT}::leaf::extra`;
const APPENDIX = `${FIRST_DOCUMENT}::appendix::coverage`;
const SYNTHESIS = `${FIRST_DOCUMENT}::synthesis::document`;

/** One ledger row, or a named failure: a tamper on a row that is not there proves nothing. */
function rowOf(ledger: UnitLedger, unitId: string): CollectedUnit {
  const row = ledger.units.find((entry) => entry.unitId === unitId);
  if (!row) throw new Error(`the ledger holds no row for ${unitId}; the test's premise is gone`);
  return row;
}

test("a collected candidate has no receipt on disk, so no receipt schema version can decide its reuse", async () => {
  const run = await admissionRun();
  // Drafted and collected one unit at a time HERE rather than through the fixture's helper, so the receipt is
  // observed in both states at the same path. A test that only ever saw the absence could be passing on a path that
  // is never a receipt at all, which is a green test asserting nothing.
  for (const unitId of run.view.collectionOrder) {
    await draftUnit(run.runDir, await unitDraftFor(run, unitId));
    assert.equal(await exists(unitPaths(run.runDir, unitId).receipt), true, `${unitId}: a drafted unit HAS a receipt at this path`);
    const collected = await collectUnits(run.runDir);
    assert.ok(collected.collected.some((entry) => entry.unitId === unitId), `${unitId} must be recorded`);
    assert.equal(await exists(unitPaths(run.runDir, unitId).receipt), false, `${unitId}: and collect deleted it`);
  }
  const ledger = await readUnitLedger(run.runDir, run.manifest.id);
  assert.deepEqual(ledger.units.map((row) => row.unitId).sort(), [APPENDIX, LEAF, SYNTHESIS], "three verified candidates-to-be");
  for (const row of ledger.units) {
    assert.equal(await exists(unitPaths(run.runDir, row.unitId).receipt), false,
      `${row.unitId} is recorded and its receipt is gone: the candidate an admission may re-enter is a ledger row plus three artifacts, and there is no receipt in that set`);
  }

  // And the receipt an admission produces is minted AFTER the decision, by the draft door, for the plan in force:
  // the read-only pass decides with no receipt in existence at all.
  await requestSecondDocument(run);
  const replanned = await recordPlan(run, "two-documents", withExtraLeaf(FIRST_DOCUMENT));
  assert.notEqual(replanned.view.planCatalogDigest, run.view.planCatalogDigest, "the re-plan must supersede the rows, or there is nothing to admit");
  const plan = await planUnitAdmission(run.runDir, ADMISSION_AUTHORSHIP);
  assert.deepEqual(plan.intents.filter((intent) => intent.intent === "admit").map((intent) => intent.unit.unitId).sort(),
    [APPENDIX, LEAF, SYNTHESIS], "every candidate is admissible, decided with no receipt anywhere on disk");
  for (const row of ledger.units) assert.equal(await exists(unitPaths(run.runDir, row.unitId).receipt), false);
});

test("a candidate ledger row that promises a different summary digest is named and falls to rebuild", async () => {
  const run = await admissionRun();
  await authorEveryUnit(run);
  const before = await readUnitLedger(run.runDir, run.manifest.id);
  const target = rowOf(before, LEAF);

  // THE TAMPER IS ON THE RECORD, not on the bytes. Every artifact on disk is exactly what was verified; only the
  // row's promise about the summary moved. If the admission believed its own records, this row would be re-entered
  // and the tamper would be invisible.
  const tampered = `${"0".repeat(63)}1`;
  assert.notEqual(target.summaryDigest, tampered);
  await writeUnitLedger(run.runDir, {
    ...before,
    units: before.units.map((row) => (row.unitId === LEAF ? { ...row, summaryDigest: tampered } : row))
  });

  await requestSecondDocument(run);
  await recordPlan(run, "two-documents", withExtraLeaf(FIRST_DOCUMENT));

  const plan = await planUnitAdmission(run.runDir, ADMISSION_AUTHORSHIP);
  const offered = plan.ledgerRows.find((row) => row.unitId === LEAF);
  assert.equal(offered?.disposition.state, "offered", "the row is offered as a candidate and then checked");
  assert.equal(offered?.disposition.state === "offered" ? offered.disposition.verification.state : "", "drifted",
    "the row's promise is compared with the bytes, not taken as the verdict");
  const intent = plan.intents.find((row) => row.unit.unitId === LEAF);
  assert.equal(intent?.intent, "rebuild");
  assert.equal(intent?.intent === "rebuild" ? intent.cause : "", "candidate-drift");
  assert.match(intent?.intent === "rebuild" ? intent.statement : "", /summary digesting to [0-9a-f]{64}, but its ledger row promises 0{63}1/,
    "the refusal names the disagreement rather than reporting a miss");

  const report = await admitUnits(run.runDir, ADMISSION_AUTHORSHIP);
  const outcome = report.outcomes.find((row) => row.unit.unitId === LEAF);
  assert.equal(outcome?.outcome, "fell-to-rebuild");
  assert.equal(outcome?.outcome === "fell-to-rebuild" ? outcome.cause : "", "candidate-drift");
  assert.deepEqual(report.outcomes.filter((row) => row.outcome === "admitted").map((row) => row.unit.unitId), [APPENDIX],
    "a tampered row costs its own unit its admission and nothing else its own");

  // Nothing was recorded from the tampered row, and the row is left exactly as it was: this pass repairs no record.
  const after = await readUnitLedger(run.runDir, run.manifest.id);
  assert.equal(rowOf(after, LEAF).summaryDigest, tampered);
  assert.equal(rowOf(after, LEAF).planCatalogDigest, target.planCatalogDigest, "the tampered row was not re-recorded under the plan in force");
});
