import test from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { auditTimeline, readTimeline } from "../src/base/timeline.ts";
import { exists, sha256 } from "../src/base/util.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import { unitStatus } from "../src/report/unit-status.ts";
import { plannedRun, unitDraftFor } from "./unit-fixture.ts";
import { tempDir } from "./helpers.ts";

/**
 * 57B-452, for the unit path: a run directory must be movable, and the unit machinery must be part of that.
 *
 * The section path was split in two once because `run.json` records absolute paths and something read them as
 * write instructions. The unit path cannot repeat it by construction - `unitPaths` derives everything from the
 * `runDir` it is handed and there is no recorded location to misread - but "cannot by construction" is exactly
 * the kind of claim that quietly stops being true, so it is a fixture: copy the whole workspace, draft and
 * collect against the COPY, and require the original tree to be byte-for-byte what it was.
 *
 * `tests/run-relocation.test.ts` keeps the command-by-command coverage of the section path and is not touched
 * here; this is the same fixture shape for the two unit commands that write.
 */

async function treeDigest(dir: string): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) rows.set(relative(dir, full), sha256(await readFile(full)));
    }
  };
  await walk(dir);
  return rows;
}

function changes(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, digest] of after) if (!before.has(path)) out.push(`created ${path}`);
  else if (before.get(path) !== digest) out.push(`changed ${path}`);
  for (const path of before.keys()) if (!after.has(path)) out.push(`deleted ${path}`);
  return out.sort();
}

test("relocated run: unit draft and collect keep every artifact with the ledger that records them", async () => {
  const run = await plannedRun();
  const appendixId = run.view.collectionOrder.find((unitId) => run.view.byId.get(unitId)!.kind === "appendix")!;
  const draft = await unitDraftFor(run, appendixId);

  const moved = await tempDir("excavator-unit-relocated-");
  await cp(run.workdir, moved, { recursive: true });
  const copyRunDir = join(moved, relative(run.workdir, run.runDir));

  const before = await treeDigest(run.workdir);
  const receipt = await draftUnit(copyRunDir, draft);
  assert.equal(receipt.unitId, appendixId);
  assert.equal((await collectUnits(copyRunDir)).collected.length, 1);
  assert.deepEqual(changes(before, await treeDigest(run.workdir)), [],
    "an operation on the relocated run wrote into the location run.json records, splitting the run in two");

  // Every artifact, the collect-written ledger and the timeline event are all on the copy's side.
  const copyPaths = unitPaths(copyRunDir, appendixId);
  for (const path of [copyPaths.content, copyPaths.claims, copyPaths.summary]) assert.ok(await exists(path), path);
  assert.equal(await exists(copyPaths.receipt), false, "collect consumed the receipt in the copy");
  assert.ok(await exists(join(copyRunDir, "units", "collected.json")));
  assert.deepEqual(await auditTimeline(copyRunDir, run.manifest.id), []);
  const events = await readTimeline(copyRunDir);
  assert.equal(events.filter((event) => event.action === "unit.checkpoint").length, 1);

  // And the original holds no unit artifacts at all: the read side sees an empty unit path, and says so.
  assert.equal(await exists(join(run.runDir, "units")), false);
  const original = await unitStatus(run.runDir);
  assert.deepEqual(original.census, { collected: 0, drafted: 0, unwritten: run.view.units.length });
  const copyStatus = await unitStatus(copyRunDir);
  assert.equal(copyStatus.census.collected, 1);
  assert.equal(copyStatus.runId, original.runId, "two halves of one run id - which is why the copy must stay whole");
});
