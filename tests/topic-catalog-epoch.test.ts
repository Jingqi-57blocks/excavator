import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunManifest } from "../src/base/types.ts";
import { canonicalJson, sha256 } from "../src/base/util.ts";
import { currentKnowledgeRelativePath, knowledgeDigest, knowledgeEpochRelativePath } from "../src/freeze/freeze.ts";
import { freezeRun, searchSourceEvidence } from "../src/run/run.ts";
import { DEFAULT_PLANNER_PACKET_BYTE_LIMIT, planRun, renderPlannerPacketForRun } from "../src/run/stages/plan-stage.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import { assertPlanEpoch, type UnitPlanView } from "../src/report/unit-plan-view.ts";
import { copyFixture, manifestOf } from "./helpers.ts";
import { frozenRun } from "./unit-fixture.ts";

/**
 * WHICH EPOCH THE TOPIC CATALOG PROJECTS.
 *
 * The projection used to open `knowledge.json` by name, which is epoch 0's archive location and nothing else. On
 * any run that had been supplemented and re-frozen, the report side therefore planned against knowledge the run
 * had already moved past — silently on the plan path, and as a named dead end on the unit path (the plan's epoch
 * and the manifest's disagreed, and `assertPlanEpoch` refused). The loader now takes the manifest and reads the
 * epoch it selects.
 *
 * THE EPOCH-1 RUN HERE IS REAL, not a hand-written record: `searchSourceEvidence` with a supplement pair and a
 * second `freezeRun` is the operation an investigator actually performs, so what is asserted is the state that
 * operation produces. The negative fixtures then damage THAT run, because a negative fixture over a synthetic
 * epoch would only prove the loader can read what this file wrote.
 */

const SEARCH_TERM = "Leave requests";

/** A frozen run taken to epoch 1 through the supported supplement loop. */
async function epochOneRun(): Promise<{ runDir: string; manifest: RunManifest }> {
  const base = await frozenRun();
  const plan = JSON.parse(await readFile(join(base.runDir, "workitems.json"), "utf8")) as { items: Array<{ id: string }> };
  await searchSourceEvidence(base.runDir, [SEARCH_TERM], "topic catalog epoch fixture", { maxResults: 5 }, {
    reason: "the sealed epoch lacks this search",
    workItemId: plan.items[0]!.id
  });
  const frozen = await freezeRun(base.runDir);
  assert.equal(frozen.frozen, true, `the fixture must re-freeze: ${frozen.findings.map((finding: { message: string }) => finding.message).join("; ")}`);
  const manifest = await manifestOf(base.runDir);
  assert.equal(manifest.knowledgeEpoch, 1, "the supplement loop must have sealed a second epoch");
  return { runDir: base.runDir, manifest };
}

test("a re-frozen run's catalog is projected from the epoch its manifest selects, and says which file that was", async () => {
  const { runDir, manifest } = await epochOneRun();
  const epochPath = join("knowledge", "epochs", "epoch-1.json");
  assert.equal(currentKnowledgeRelativePath(manifest), epochPath, "the manifest selects epoch 1's append-only location");

  const source = await loadTopicCatalogSource(runDir, manifest);
  assert.equal(source.knowledge.epoch, 1, "the projected record is the epoch the manifest selects");

  // The input contract, as data: the epoch-1 file was opened and `knowledge.json` was NOT. This is the assertion
  // the defect could never have passed — epoch 0's file is still on disk, so a loader that read it by name would
  // have produced a source that looked complete.
  assert.ok(source.readPaths.includes(epochPath), `readPaths must name the epoch actually opened: ${source.readPaths.join(", ")}`);
  assert.ok(!source.readPaths.includes("knowledge.json"), "a superseded epoch is not among this catalog's inputs");

  // The catalog's input identity is the canonical bytes of the epoch-1 record itself.
  const record = JSON.parse(await readFile(join(runDir, epochPath), "utf8")) as unknown;
  assert.equal(source.knowledgeDigest, sha256(canonicalJson(record)));
});

test("the selected epoch's file being absent is a named failure that names the epoch, not knowledge.json", async () => {
  const { runDir, manifest } = await epochOneRun();
  const epochPath = join("knowledge", "epochs", "epoch-1.json");
  await rm(join(runDir, epochPath));
  // `knowledge.json` is still there, untouched. A loader that fell back to it would project epoch 0 and report
  // nothing at all, which is precisely the silence this refusal replaces.
  assert.equal(JSON.parse(await readFile(join(runDir, "knowledge.json"), "utf8")).epoch, 0);
  await assert.rejects(() => loadTopicCatalogSource(runDir, manifest),
    /knowledge\/epochs\/epoch-1\.json is missing from .*; a Topic Catalog cannot be projected without it/);
});

test("a record found at the selected epoch's path that is not that epoch is refused by name", async () => {
  const { runDir, manifest } = await epochOneRun();
  const epochPath = join("knowledge", "epochs", "epoch-1.json");
  // Epoch 0's record, byte for byte, sitting where epoch 1's belongs. Every other check in the loader passes on
  // it — it is a properly sealed knowledge-v1 record whose digests match the ledgers on disk — so this is the
  // one check standing between "the manifest says epoch 1" and a catalog built from epoch 0's rows.
  await writeFile(join(runDir, epochPath), await readFile(join(runDir, "knowledge.json"), "utf8"));
  await assert.rejects(() => loadTopicCatalogSource(runDir, manifest),
    /carries epoch 0, which belongs at knowledge\.json, but the run manifest selects knowledge\/epochs\/epoch-1\.json/);
});

test("the model-facing planner packet and the recorded plan of a re-frozen run both state the new epoch", async () => {
  // The SILENT arm of the defect, and the reason this slice's acceptance covers two paths rather than one. The unit
  // path refused by name once the manifest passed epoch 0 (`assertPlanEpoch`), but `plan` and the planner packet
  // never consult the manifest at all: they would have handed a model an epoch-0 projection of a run that had moved
  // on, with nothing anywhere saying so, and the first red light would have come at draft time.
  const { runDir, manifest } = await epochOneRun();
  const packet = await renderPlannerPacketForRun(runDir, { overBudget: "record-limitation", byteLimit: DEFAULT_PLANNER_PACKET_BYTE_LIMIT });
  assert.match(packet.markdown, /- knowledge epoch: 1 \(digest [0-9a-f]{64}\)/);
  assert.ok(!packet.markdown.includes("knowledge epoch: 0"), "the model must not be handed a superseded epoch");

  const planned = await planRun(runDir, { mode: "fixture" });
  assert.equal(planned.artifacts.planCatalog.knowledgeEpoch, 1);
  const recorded = JSON.parse(await readFile(join(runDir, "plan", "topics.json"), "utf8")) as { knowledgeEpoch: number; knowledgeDigest: string };
  assert.equal(recorded.knowledgeDigest, (await loadTopicCatalogSource(runDir, manifest)).knowledgeDigest);
  assert.equal(recorded.knowledgeEpoch, 1);
});

test("epoch 0 and a manifest with no epoch field both still read knowledge.json", async () => {
  // The other half of the mapping, pinned here so the fix cannot be read as "later epochs only". A manifest with
  // no `knowledgeEpoch` is a run frozen before the field existed, and its knowledge is at epoch 0's location —
  // the legacy interpretation lives in `currentKnowledgeRelativePath` and nowhere else.
  const runDir = await copyFixture("topic-catalog-mini");
  const manifest = await manifestOf(runDir);
  assert.equal(manifest.knowledgeEpoch, 0);
  // The fixture's manifest agrees with its own epoch record. Asserted because that manifest was added for this
  // slice and a placeholder digest in it would sit there unnoticed until some later test put it through a gate
  // that checks one.
  assert.equal(manifest.knowledgeDigest, knowledgeDigest(JSON.parse(await readFile(join(runDir, "knowledge.json"), "utf8"))));
  assert.equal(currentKnowledgeRelativePath(manifest), "knowledge.json");
  assert.deepEqual([...(await loadTopicCatalogSource(runDir, manifest)).readPaths].filter((path) => path.startsWith("knowledge")), ["knowledge.json"]);

  const legacy: RunManifest = { ...manifest };
  delete legacy.knowledgeEpoch;
  assert.equal(currentKnowledgeRelativePath(legacy), "knowledge.json");
  assert.equal((await loadTopicCatalogSource(runDir, legacy)).knowledge.epoch, 0);
});

test("the epoch-to-path mapping is injective, which is what makes the selected-epoch check total", () => {
  // The check compares PATHS rather than numbers, so it is only as strong as the mapping being one-to-one.
  const paths = [0, 1, 2, 7, 42].map((epoch) => knowledgeEpochRelativePath(epoch));
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(paths.slice(0, 2), ["knowledge.json", join("knowledge", "epochs", "epoch-1.json")]);
  assert.throws(() => knowledgeEpochRelativePath(-1), /Invalid knowledge epoch/);
});

test("the plan-versus-manifest epoch refusal stays, even though a run can no longer reach it", () => {
  /*
   * `assertPlanEpoch` used to be the visible face of this defect: after a re-freeze the recorded plan projected
   * epoch 0 while the manifest was at epoch 1, and every unit command refused with its message. That state is now
   * unreachable through three checks in a row, which is why its through-the-run fixture is gone from
   * `tests/unit-authoring.test.ts` (9):
   *
   *   1. `assertSelectedEpoch` (above) pins the projected record to the epoch the manifest selects;
   *   2. the plan gate re-derives the topics catalog and refuses a recorded `plan/topics.json` that differs;
   *   3. `readPlanCatalog` refuses a `plan/catalog.json` whose `knowledgeEpoch` is not the topics catalog's.
   *
   * So the check is defence in depth now, not a live gate — and an unexercised throw is one nobody notices being
   * deleted. It is asserted here as the pure function it is, over a hand-made view, with no claim that a run
   * directory can produce the disagreement.
   */
  const view = (epoch: number) => ({ knowledgeEpoch: epoch }) as unknown as UnitPlanView;
  assert.throws(() => assertPlanEpoch(view(0), 1),
    /The recorded plan projects knowledge epoch 0 but the run manifest is at epoch 1; re-plan this run before authoring units/);
  assert.doesNotThrow(() => assertPlanEpoch(view(1), 1));
});
