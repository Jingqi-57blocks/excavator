import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type { SectionClaim } from "../src/base/types.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { readUnitClaimBindingForRun, summariseUnitClaimBindingReading } from "../src/report/unit-claim-binding-source.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import { claimFor, materialisedRun, unitDraftWithClaims, unitDraftWithProse, type MaterialisedRun } from "./unit-grounding-fixture.ts";

// THE RUN-LEVEL READING of the binding contract (57B-491): what `audit --units` reports beside the grounding
// verdict. Every arm the reading can take is asserted here — a written unit that binds, a written unit that does
// not, a planned unit nobody has written, and a unit whose two artifacts are not both on disk.
//
// NOTHING IS WRITTEN BY ANY OF IT. The reading opens the plan and each unit's bytes; the assertions below are
// about what it says, and the run it says it about is unchanged after it says it.

function leafOf(run: MaterialisedRun): string {
  const unitId = run.view.collectionOrder.find((id) => id.endsWith("::leaf::work-item-dimension"));
  if (!unitId) throw new Error("the materialised run must have a work-item-dimension leaf");
  return unitId;
}

function claimsFor(run: MaterialisedRun): SectionClaim[] {
  return [
    claimFor("C-found", run.foundWorkItemId, { evidenceIds: [run.foundEvidenceId] }),
    claimFor("C-unresolved", run.unresolvedWorkItemId, { marker: "unavailable" })
  ];
}

test("a run with nothing written reports every planned unit as unwritten, never as clean", async () => {
  const run = await materialisedRun();
  const reading = await readUnitClaimBindingForRun(run.runDir);
  assert.deepEqual(reading.units, [], "no unit has bytes on disk yet");
  assert.equal(reading.unwritten.length, run.view.units.length);
  // "Nothing was checked" is a sentence of its own, and it names which of the two artifacts is missing.
  for (const row of reading.unwritten) assert.match(row.reason, /has no content\.md and no claims\.json on disk/);
  assert.match(reading.summary, /0 of 4 planned unit\(s\) checked/);
});

test("a written unit whose prose states what its claims claim reads complete, with its denominators", async () => {
  const run = await materialisedRun();
  const unitId = leafOf(run);
  await draftUnit(run.runDir, await unitDraftWithClaims(run, unitId, claimsFor(run)));
  await collectUnits(run.runDir);

  const reading = await readUnitClaimBindingForRun(run.runDir);
  const row = reading.units.find((unit) => unit.unitId === unitId);
  assert.deepEqual(row?.verdict, { conclusion: "complete", segments: 2, statements: 2 });
  assert.deepEqual(row?.problems, []);
  assert.equal(row?.documentId, "overview-product");
  assert.ok(summariseUnitClaimBindingReading(reading).some((line) => line.startsWith(`complete: unit ${unitId} binds all 2`)),
    summariseUnitClaimBindingReading(reading).join("\n"));
});

test("a written unit whose claims are nowhere in its prose reads violations, naming the unit and the statement", async () => {
  const run = await materialisedRun();
  const unitId = leafOf(run);
  const unbound = "## 材料\n\n本单元的正文完全不提任何 claim 所声称的内容。`事实`\n";
  await draftUnit(run.runDir, await unitDraftWithProse(run, unitId, claimsFor(run), unbound));
  await collectUnits(run.runDir);

  const row = (await readUnitClaimBindingForRun(run.runDir)).units.find((unit) => unit.unitId === unitId);
  assert.equal(row?.verdict.conclusion, "violations");
  assert.deepEqual(row?.problems.map((problem) => problem.kind), ["statement-absent", "statement-absent", "unclaimed-statement"]);
  assert.deepEqual(row?.problems.map((problem) => problem.claimId), ["C-found", "C-unresolved", null]);
  assert.ok(row?.problems.every((problem) => problem.message.includes(unitId)), "every problem names the unit it is about");
});

test("a unit with prose on disk but no claims sidecar is unwritten, naming the half that is missing", async () => {
  const run = await materialisedRun();
  const unitId = leafOf(run);
  await draftUnit(run.runDir, await unitDraftWithClaims(run, unitId, claimsFor(run)));
  await collectUnits(run.runDir);
  // An interrupted draft is the real shape of this: bytes for one artifact, none for the other. It must not be
  // checked against half its input, and it must not read as clean.
  await rm(unitPaths(run.runDir, unitId).claims);

  const reading = await readUnitClaimBindingForRun(run.runDir);
  assert.deepEqual(reading.units, []);
  const row = reading.unwritten.find((unit) => unit.unitId === unitId);
  assert.match(row?.reason ?? "", /has no claims\.json on disk/);
  assert.doesNotMatch(row?.reason ?? "", /content\.md/);
});
