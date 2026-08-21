/**
 * What a plan revision costs in work already done, reported by the revision itself.
 *
 * THE STATE UNDER TEST is the one 57B-434 R6d left unreported: a unit is drafted, not yet collected, and then the
 * plan is revised. The receipt stays on disk and `collectUnits` refuses it by name — correct behaviour, and the
 * reason nothing is deleted — but the refusal used to arrive at the next collect, one unit at a time, long after
 * the decision that caused it.
 *
 * THE READING IS TIED TO THE REFUSAL IT PREDICTS. The end-to-end test below does not just read the field: it then
 * runs `collectUnits` and asserts the refusal names the SAME unit. A reading that could name a different set than
 * the barrier refuses would be a second answer to one question, and this file is where that would show up.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { strandedUnitDrafts } from "../src/report/plan-revision-stranded.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { appendReportRequest } from "../src/report/report-requests-append.ts";
import { plannedDocumentId } from "../src/report/legacy-request-mapping.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import type { UnitDraftReceipt } from "../src/report/unit-receipt.ts";
import { plannedRun, planViewOf, unitDraftFor } from "./unit-fixture.ts";

/** A receipt stub carrying only the two fields this reading compares. */
function receipt(unitId: string, planCatalogDigest: string): UnitDraftReceipt {
  return { unitId, planCatalogDigest } as unknown as UnitDraftReceipt;
}

test("the reading is the receipts whose plan is not the one on disk, ascending, with a sentence either way", () => {
  const current = "a".repeat(64);
  const superseded = "b".repeat(64);
  const none = strandedUnitDrafts([receipt("u-1", current), receipt("u-2", current)], current);
  assert.deepEqual(none.unitIds, []);
  assert.match(none.sentence, /^No drafted unit is waiting to be collected against a superseded plan, so this plan costs no re-drawing \(2 pending draft\(s\) checked against plan aaaaaaaaaaaaaaaa\)$/);

  const some = strandedUnitDrafts([receipt("u-2", superseded), receipt("u-1", superseded), receipt("u-3", current)], current);
  assert.deepEqual(some.unitIds, ["u-1", "u-2"], "ascending, and only the ones written against another plan");
  assert.match(some.sentence, /^2 drafted unit\(s\) were written against a superseded plan and must be re-drafted before they can be collected — collect refuses them by name: u-1, u-2$/);

  // The zero case over nothing at all is still a measured zero, not an absence.
  assert.deepEqual(strandedUnitDrafts([], current).unitIds, []);
  assert.match(strandedUnitDrafts([], current).sentence, /\(0 pending draft\(s\) checked against plan aaaaaaaaaaaaaaaa\)/);
});

test("a revise names the drafted-but-uncollected unit it stranded, and not the one already collected", async () => {
  const run = await plannedRun(["product"]);
  const appendix = [...run.view.byId.values()].find((unit) => unit.kind === "appendix")!;
  const synthesis = [...run.view.byId.values()].find((unit) => unit.kind === "synthesis")!;

  // The appendix is drafted AND collected: collect deletes its receipt, so it is no longer pending and a revision
  // costs nothing for it. The synthesis is drafted and left uncollected — the state the reading exists for.
  await draftUnit(run.runDir, await unitDraftFor(run, appendix.unitId));
  await collectUnits(run.runDir);
  await draftUnit(run.runDir, await unitDraftFor({ ...run, view: await planViewOf(run.runDir) }, synthesis.unitId));

  // A second audience is requested, so the recorded plan no longer covers the request set and a revision is the
  // supported way forward — the epic's own headline operation, and the one that strands the draft above.
  await appendReportRequest(run.runDir, {
    documentId: plannedDocumentId("overview", "engineering", null),
    kind: "overview", audience: "engineering", featureKey: null, detailLevel: "standard", language: "zh-CN"
  });
  const revised = await planRun(run.runDir, { mode: "fixture" }, { kind: "revise", reason: "a second audience was requested" });
  assert.equal(revised.revision.planRevision, 1);
  assert.deepEqual([...revised.revision.strandedDrafts.unitIds], [synthesis.unitId],
    "the pending draft is named; the collected one is in the ledger and costs nothing");
  assert.match(revised.revision.strandedDrafts.sentence,
    new RegExp(`^1 drafted unit\\(s\\) were written against a superseded plan and must be re-drafted before they can be collected — collect refuses them by name: ${synthesis.unitId}$`));

  // The reading is not a guess about what collect will do: collect refuses exactly that id.
  await assert.rejects(async () => collectUnits(run.runDir),
    new RegExp(`Unit draft receipt for "${synthesis.unitId}" was written against plan [0-9a-f]{16} but this run records plan [0-9a-f]{16}; re-draft it against the recorded plan`));
});

test("a revision that strands nothing says so as a measured zero", async () => {
  const run = await plannedRun(["product"]);
  await appendReportRequest(run.runDir, {
    documentId: plannedDocumentId("overview", "engineering", null),
    kind: "overview", audience: "engineering", featureKey: null, detailLevel: "standard", language: "zh-CN"
  });
  const revised = await planRun(run.runDir, { mode: "fixture" }, { kind: "revise", reason: "a second audience was requested" });
  assert.deepEqual(revised.revision.strandedDrafts.unitIds, []);
  assert.match(revised.revision.strandedDrafts.sentence, /^No drafted unit is waiting to be collected against a superseded plan, so this plan costs no re-drawing \(0 pending draft\(s\) checked against plan [0-9a-f]{16}\)$/);
});

test("revision 0 takes the same reading, so a run that already holds receipts is not a blind spot", async () => {
  const run = await plannedRun(["product"]);
  // Recording the same plan bytes again is a no-op that still reports: the receipts on disk (none here) are checked
  // against the plan on disk, by the one derivation, on both recording arms.
  const again = await planRun(run.runDir, { mode: "fixture" }, { kind: "record" });
  assert.equal(again.revision.planRevision, 0);
  assert.deepEqual(again.revision.strandedDrafts.unitIds, []);
  assert.match(again.revision.strandedDrafts.sentence, /^No drafted unit is waiting/);
});
