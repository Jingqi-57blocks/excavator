import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { RunManifest } from "../src/base/types.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import { exists } from "../src/base/util.ts";
import { plannedRun, unitDraftFor, type PlannedRun } from "./unit-fixture.ts";

/**
 * The freeze-before-authoring HARD gate, on the unit path.
 *
 * `assertCurrentKnowledgeEpochForAuthoring` is one function with five callers, and the section path's `begin` was
 * the only one a fixture ever pointed at (`tests/freeze-hard-gate.test.ts` ①②). `begin` has no unit-path
 * counterpart — a unit is drafted against the plan, not against a document that has been started — so the gate's
 * two enforcement points here are `draft --unit` and `collect --units`, and both of them are load-bearing: a plan
 * can only be recorded on a frozen run, but the stamp can be removed afterwards, which is exactly what a run
 * restored from a half-copied workspace looks like.
 *
 * BOTH DIRECTIONS, because the gate is version-gated. Under the current assurance version the refusal is by name
 * and nothing is written; under a pre-v3 stamp the same run authors, since a run prepared before the gate existed
 * must be grandfathered rather than failed. The pre-v3 literal is not the current `ASSURANCE_VERSION`, which is
 * all `runUsesCurrentAssurance` asks.
 *
 * The last test is the control: with the freeze stamp put back, the SAME draft input is admitted. Without it a
 * refusal caused by the draft itself would read as a refusal caused by the missing freeze.
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
