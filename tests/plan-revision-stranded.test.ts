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
import { strandedUnitDrafts, strandedUnitDraftsUnread, type StrandedUnitDrafts } from "../src/report/plan-revision-stranded.ts";
import { writeFile } from "node:fs/promises";
import { stableJson } from "../src/base/util.ts";
import { join } from "node:path";
import { collectUnits } from "../src/report/unit-collect.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { appendReportRequest } from "../src/report/report-requests-append.ts";
import { plannedDocumentId } from "../src/report/legacy-request-mapping.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import type { UnitDraftReceipt } from "../src/report/unit-receipt.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { readReportRequests } from "../src/report/report-requests-artifact.ts";
import { buildTopicCatalog } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import type { PlanProposal, ProposedUnit } from "../src/report/plan-proposal.ts";
import { manifestOf, plannedRun, planViewOf, unitDraftFor } from "./unit-fixture.ts";

/** The `read` arm's two buckets, with the arm itself asserted: a `not-read` reading is never an empty set. */
function readBuckets(reading: StrandedUnitDrafts): { redraftable: readonly string[]; unplannable: readonly string[] } {
  assert.equal(reading.state, "read", `the reading must have been taken: ${reading.sentence}`);
  return reading.state === "read"
    ? { redraftable: reading.redraftable, unplannable: reading.unplannable }
    : { redraftable: [], unplannable: [] };
}

/** A receipt stub carrying only the two fields this reading compares. */
function receipt(unitId: string, planCatalogDigest: string): UnitDraftReceipt {
  return { unitId, planCatalogDigest } as unknown as UnitDraftReceipt;
}

test("the two buckets are split the way collect splits them: dropped units first, then plan digest", () => {
  const current = "a".repeat(64);
  const superseded = "b".repeat(64);
  const plan = ["u-1", "u-2", "u-3"];

  const none = strandedUnitDrafts([receipt("u-1", current), receipt("u-2", current)], current, plan);
  assert.deepEqual(readBuckets(none), { redraftable: [], unplannable: [] });
  assert.match(none.sentence, /^No drafted unit is waiting to be collected against a superseded plan, so this plan costs no re-drawing \(2 pending draft\(s\) checked against plan aaaaaaaaaaaaaaaa\)$/);

  const some = strandedUnitDrafts([receipt("u-2", superseded), receipt("u-1", superseded), receipt("u-3", current)], current, plan);
  assert.deepEqual(readBuckets(some), { redraftable: ["u-1", "u-2"], unplannable: [] }, "ascending, and only the ones written against another plan");
  assert.match(some.sentence, /^2 drafted unit\(s\) were written against a superseded plan and must be re-drafted before they can be collected — collect refuses them by name: u-1, u-2$/);

  // THE SPLIT THAT MATTERS: a receipt whose unit the new plan DROPPED is not re-draftable. Collect reports it as
  // `unplanned` rather than refusing it, and `planUnit` refuses the id — so "re-draft it" would send an operator to
  // a dead end, which is exactly what one merged bucket used to say.
  const dropped = strandedUnitDrafts([receipt("u-gone", superseded), receipt("u-1", superseded)], current, plan);
  assert.deepEqual(readBuckets(dropped), { redraftable: ["u-1"], unplannable: ["u-gone"] });
  assert.match(dropped.sentence, /must be re-drafted before they can be collected — collect refuses them by name: u-1; and 1 drafted unit\(s\) name a unit this plan no longer holds, so they can be neither collected nor re-drafted and the work in them is lost: u-gone$/);

  // A dropped unit whose receipt digest happens to MATCH is still unplannable: the id test comes first, in the
  // order collect makes it, so the classification cannot depend on a digest coincidence.
  assert.deepEqual(readBuckets(strandedUnitDrafts([receipt("u-gone", current)], current, plan)), { redraftable: [], unplannable: ["u-gone"] });

  // The zero case over nothing at all is still a measured zero, not an absence.
  assert.deepEqual(readBuckets(strandedUnitDrafts([], current, plan)), { redraftable: [], unplannable: [] });
  assert.match(strandedUnitDrafts([], current, plan).sentence, /\(0 pending draft\(s\) checked against plan aaaaaaaaaaaaaaaa\)/);
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
  assert.deepEqual(readBuckets(revised.revision.strandedDrafts),
    { redraftable: [synthesis.unitId], unplannable: [] },
    "the pending draft is named as re-draftable; the collected one is in the ledger and costs nothing");
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
  assert.deepEqual(readBuckets(revised.revision.strandedDrafts), { redraftable: [], unplannable: [] });
  assert.match(revised.revision.strandedDrafts.sentence, /^No drafted unit is waiting to be collected against a superseded plan, so this plan costs no re-drawing \(0 pending draft\(s\) checked against plan [0-9a-f]{16}\)$/);
});

test("revision 0 takes the same reading, so a run that already holds receipts is not a blind spot", async () => {
  const run = await plannedRun(["product"]);
  // Recording the same plan bytes again is a no-op that still reports: the receipts on disk (none here) are checked
  // against the plan on disk, by the one derivation, on both recording arms.
  const again = await planRun(run.runDir, { mode: "fixture" }, { kind: "record" });
  assert.equal(again.revision.planRevision, 0);
  assert.deepEqual(readBuckets(again.revision.strandedDrafts), { redraftable: [], unplannable: [] });
  assert.match(again.revision.strandedDrafts.sentence, /^No drafted unit is waiting/);
});

test("a receipt directory that cannot be scanned is a `not-read` reading, and the plan is still recorded", async () => {
  const run = await plannedRun(["product"]);
  const appendix = [...run.view.byId.values()].find((unit) => unit.kind === "appendix")!;
  await draftUnit(run.runDir, await unitDraftFor(run, appendix.unitId));
  // A receipt that is no longer a receipt: `pendingUnitReceipts` refuses it by name, and that refusal must not
  // take down the command an operator reaches for to get a stuck run moving.
  await writeFile(join(unitPaths(run.runDir, appendix.unitId).receipt), "{ not a receipt }");
  await appendReportRequest(run.runDir, {
    documentId: plannedDocumentId("overview", "engineering", null),
    kind: "overview", audience: "engineering", featureKey: null, detailLevel: "standard", language: "zh-CN"
  });
  const revised = await planRun(run.runDir, { mode: "fixture" }, { kind: "revise", reason: "a second audience was requested" });
  assert.equal(revised.revision.planRevision, 1, "the plan revision was still recorded");
  assert.equal(revised.revision.strandedDrafts.state, "not-read");
  assert.match(revised.revision.strandedDrafts.sentence, /could not be read, so this plan's cost in re-drawing is unknown — not zero: .*could not be read as JSON/);

  // And the unread arm is not an empty set wearing a different word.
  assert.equal("redraftable" in revised.revision.strandedDrafts, false);
  assert.match(strandedUnitDraftsUnread("the scan said why").sentence, /unknown — not zero: the scan said why\./);
});

test("a draft whose unit the next revision DROPPED is named as unplannable, not as re-draftable", async () => {
  // The failure this pins: telling an operator to "re-draft" a unit the plan no longer holds sends them to
  // `planUnit`'s refusal, and saying nothing leaves a directory of drafts they think are pending. Reached the way
  // it happens for real — a proposal that re-names the unit, recorded as the next revision.
  const run = await plannedRun(["product"]);
  const appendix = [...run.view.byId.values()].find((unit) => unit.kind === "appendix")!;
  await draftUnit(run.runDir, await unitDraftFor(run, appendix.unitId));

  const rename = (unitId: string) => unitId === appendix.unitId ? `${unitId}-renamed` : unitId;
  const catalog = buildTopicCatalog(await loadTopicCatalogSource(run.runDir, await manifestOf(run.runDir)));
  const base = buildFixturePlan(catalog, await readReportRequests(run.runDir), PLAN_BUDGET_TABLE);
  const units: ProposedUnit[] = base.units.map((unit) => unit.kind === "synthesis"
    ? { ...unit, childUnitIds: unit.childUnitIds.map(rename).sort((a, b) => a.localeCompare(b)) }
    : { ...unit, unitId: rename(unit.unitId) });
  const proposal: PlanProposal = { ...base, units: units.sort((a, b) => a.unitId.localeCompare(b.unitId)) };
  const path = join(run.workdir, "proposal-dropped-unit.json");
  await writeFile(path, `${stableJson(proposal)}\n`);

  const revised = await planRun(run.runDir, { mode: "file", path }, { kind: "revise", reason: "the appendix unit was renamed" });
  assert.deepEqual(readBuckets(revised.revision.strandedDrafts), { redraftable: [], unplannable: [appendix.unitId] });
  assert.match(revised.revision.strandedDrafts.sentence,
    new RegExp(`^1 drafted unit\\(s\\) name a unit this plan no longer holds, so they can be neither collected nor re-drafted and the work in them is lost: ${appendix.unitId}$`));

  // Both halves of "it has no remedy" are real: collect REPORTS it rather than refusing, and no draft accepts it.
  const collected = await collectUnits(run.runDir);
  assert.deepEqual(collected.unplanned.map((receipt) => receipt.unitId), [appendix.unitId], "collect reports it, and does not refuse the run");
  await assert.rejects(async () => draftUnit(run.runDir, await unitDraftFor(run, appendix.unitId)),
    new RegExp(`Unknown authoring unit "${appendix.unitId}"`));
});
