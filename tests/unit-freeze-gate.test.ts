import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { RunManifest } from "../src/base/types.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import { exists } from "../src/base/util.ts";
import { readTimeline } from "../src/base/timeline.ts";
import { freezeRun } from "../src/run/run.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { searchSourceEvidence } from "../src/run/stages/investigation-stage.ts";
import { assembleUnits, UNIT_ASSEMBLE_MODES } from "../src/run/stages/unit-assemble-stage.ts";
import { checkpointEveryUnit, collectedRun } from "./unit-assembly-fixture.ts";
import { plannedRun, unitDraftFor, type PlannedRun } from "./unit-fixture.ts";

/**
 * The freeze-before-authoring HARD gate, on the unit path — its two refusals, at the entry points that hold it.
 *
 * `assertCurrentKnowledgeEpochForAuthoring` is one function, and every call site of it is on the unit path. Grepped
 * over `src/` when this was written (`grep -rn assertCurrentKnowledgeEpochForAuthoring src/`, four call sites plus
 * the definition and one comment): `draft --unit` (`unit-draft.ts`), `collect --units` (`unit-collect.ts`),
 * `unit-cache-admit` (`unit-cache-admission-run.ts`) and `assemble --units` (`unit-assemble-stage.ts`). The section
 * path's `begin` was the only call a fixture ever pointed at (`tests/freeze-hard-gate.test.ts` ①②) and it was
 * deleted with the section chain in 57B-480; `begin` has no unit-path counterpart, because a unit is drafted
 * against the plan rather than against a document that has been started.
 *
 * TWO REFUSALS, NOT ONE, and this file holds both because they fail for different reasons:
 *   * NO FREEZE STAMP. A plan can only be recorded on a frozen run, but the stamp can be removed afterwards —
 *     which is exactly what a run restored from a half-copied workspace looks like.
 *   * UNSEALED SUPPLEMENTS. A run can be frozen, planned and fully collected, and THEN take a supplement. The
 *     knowledge it was authored from is about to be superseded, so shipping it would produce a deliverable that
 *     neither mentions the new knowledge nor says the knowledge is moving. This is why `assemble --units` holds
 *     the gate even though `collect --units` already did: collect passing says nothing about the moment of
 *     shipping, and assembly is the last authoring entry point a run passes through (57B-493).
 *
 * BOTH DIRECTIONS, because the gate is version-gated. Under the current assurance version the refusal is by name
 * and nothing is written; under a pre-v3 stamp the same run authors, since a run prepared before the gate existed
 * must be grandfathered rather than failed. The pre-v3 literal is not the current `ASSURANCE_VERSION`, which is
 * all `runUsesCurrentAssurance` asks.
 *
 * EVERY ARM HAS ITS CONTROL, on the same run and at the same entry point: the freeze stamp goes back and the SAME
 * draft input is admitted; the assembly that the supplement refuses is one that assembled a moment earlier; and
 * the supplement loop is run to its end until a deliverable really ships. Without those, a refusal caused by the
 * input itself would read as a refusal caused by the gate.
 */

const LEGACY_VERSION = "assurance-v2-redaction-v4";

async function patchManifest(runDir: string, mutate: (manifest: RunManifest) => void): Promise<void> {
  const path = join(runDir, "run.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as RunManifest;
  mutate(manifest);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** A planned run whose freeze stamp has been removed: frozen enough to hold a plan, not enough to author. */
async function unfrozenPlannedRun(): Promise<{ run: PlannedRun; unitId: string }> {
  const run = await plannedRun();
  const unitId = run.view.collectionOrder[0]!;
  await patchManifest(run.runDir, (manifest) => { delete (manifest as { frozenAt?: string }).frozenAt; });
  return { run, unitId };
}

test("draft --unit refuses an unfrozen current-version run by name and writes nothing", async () => {
  const { run, unitId } = await unfrozenPlannedRun();
  const draft = await unitDraftFor(run, unitId);
  await assert.rejects(() => draftUnit(run.runDir, draft), /not frozen/);

  // The refusal leaves no half-written unit behind: no receipt, no content, no claims, no summary.
  const paths = unitPaths(run.runDir, unitId);
  for (const path of [paths.receipt, paths.content, paths.claims, paths.summary]) {
    assert.equal(await exists(path), false, path);
  }
});

test("collect --units refuses an unfrozen current-version run by the same name", async () => {
  const { run } = await unfrozenPlannedRun();
  await assert.rejects(() => collectUnits(run.runDir), /not frozen/);
});

test("a pre-v3 run drafts a unit without freezing", async () => {
  const { run, unitId } = await unfrozenPlannedRun();
  await patchManifest(run.runDir, (manifest) => { manifest.assuranceVersion = LEGACY_VERSION; });
  const receipt = await draftUnit(run.runDir, await unitDraftFor(run, unitId));
  assert.equal(receipt.unitId, unitId);
  assert.ok(await exists(unitPaths(run.runDir, unitId).receipt));
});

test("restoring the freeze stamp admits the very draft the gate refused", async () => {
  const { run, unitId } = await unfrozenPlannedRun();
  const draft = await unitDraftFor(run, unitId);
  await assert.rejects(() => draftUnit(run.runDir, draft), /not frozen/);
  await patchManifest(run.runDir, (manifest) => { manifest.frozenAt = run.manifest.frozenAt; });
  const receipt = await draftUnit(run.runDir, draft);
  assert.equal(receipt.unitId, unitId, "the draft was legal all along; only the freeze stamp was missing");
});

test("assemble --units refuses an unfrozen current-version run in both modes", async () => {
  const { run } = await unfrozenPlannedRun();
  // Nothing in this run is drafted, so the all-or-nothing refusal is waiting too. Hearing THIS one, in both
  // modes, is what says the knowledge gate runs before the assembly is computed rather than after.
  for (const mode of UNIT_ASSEMBLE_MODES) await assert.rejects(() => assembleUnits(run.runDir, mode), /not frozen/, mode);
});

// --- the supplement arm: the same gate at the shipping entry point -------------------------------------

/** Record one real supplement, through the command an operator would run rather than by writing the ledger. */
async function recordRealSupplement(runDir: string): Promise<void> {
  const plan = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as { items: Array<{ id: string }> };
  await searchSourceEvidence(runDir, ["Leave requests"], "post-collect supplement", { maxResults: 5 }, {
    reason: "the collected units' epoch lacks this search",
    workItemId: plan.items[0]!.id
  });
}

test("a supplement recorded after collect refuses both assemble modes by name, and ships nothing", async () => {
  const run = await collectedRun();
  // THE CONTROL, at the same entry point and on the same run: this assembly is legal right now, and `plan-only`
  // proves it without putting a file where the last assertion looks. Without it, the refusals below would also be
  // produced by a run that could never have assembled at all.
  const admitted = await assembleUnits(run.runDir, "plan-only");
  assert.equal(admitted.knowledgeEpoch, 0);
  assert.ok(admitted.documents.length > 0, "the control assembly really did produce a document");

  await recordRealSupplement(run.runDir);
  for (const mode of UNIT_ASSEMBLE_MODES) {
    await assert.rejects(() => assembleUnits(run.runDir, mode), (error: Error) => {
      assert.match(error.message, /has unsealed supplements/, mode);
      assert.match(error.message, /excavator freeze --run/, `${mode} must name the way out`);
      return true;
    });
  }
  // "Shipped nothing" is asserted against the paths the CONTROL said `write` would produce, not against the
  // `reports/` directory — `prepare` already creates that, so an emptiness check on it would pass by accident.
  const wouldHaveShipped = [
    ...admitted.documents.flatMap((document) => [document.path, document.claimsCompanion.path, document.tracesCompanion.path]),
    admitted.coverageCompanion.path
  ];
  assert.equal(wouldHaveShipped.length, 4, "the control named every file the write arm would have put on the shelf");
  for (const path of wouldHaveShipped) {
    assert.equal(await exists(join(run.runDir, ...path.split("/"))), false, `${path} was shipped behind the gate`);
  }
  assert.deepEqual((await readTimeline(run.runDir)).filter((event) => event.action === "units.assembled"), []);
});

test("re-freeze, re-plan and redraw put the refused assembly back on the shelf, on the sealed epoch", async () => {
  const run = await collectedRun();
  await recordRealSupplement(run.runDir);
  await assert.rejects(() => assembleUnits(run.runDir, "write"), /has unsealed supplements/);

  assert.equal((await freezeRun(run.runDir)).frozen, true);
  // The supplement arm is clear and the NEXT gate is heard, named separately: the recorded plan still projects
  // epoch 0. Asserted rather than stepped over, because "a re-freeze on its own lets the old assembly ship" is
  // the wrong reading of this recovery — the deliverable has to be redrawn against the epoch that superseded it.
  await assert.rejects(() => assembleUnits(run.runDir, "write"), /the plan was superseded by a re-freeze/);

  await planRun(run.runDir, { mode: "fixture" }, { kind: "record" });
  await checkpointEveryUnit(run);
  const shipped = await assembleUnits(run.runDir, "write");
  assert.equal(shipped.written, true);
  assert.equal(shipped.knowledgeEpoch, 1, "the deliverable is assembled from the sealed epoch, not the stale one");
  assert.ok(shipped.documents.length > 0);
  for (const document of shipped.documents) {
    assert.ok(await exists(join(run.runDir, ...document.path.split("/"))), `${document.path} was not written`);
  }
});
