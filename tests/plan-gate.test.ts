import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceItem, ReportRequest, RunManifest } from "../src/base/types.ts";
import { stableJson } from "../src/base/util.ts";
import { beginDocument, freezeRun, prepareRun } from "../src/run/run.ts";
import { draftSection } from "../src/report/parallel-authoring.ts";
import { planRun, renderPlannerPacketForRun } from "../src/run/stages/plan-stage.ts";
import { assertValidatedPlanForAuthoring, PLAN_ARTIFACT_PATHS } from "../src/report/plan-gate.ts";
import { planCatalogPath, planDagPath } from "../src/report/plan-artifacts.ts";
import { reportRequestsPath } from "../src/report/report-requests-artifact.ts";
import { topicsPath } from "../src/report/topics-artifact.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, manifestOf, tempDir } from "./helpers.ts";

// The enforcer. `plan/requests.json` shipped in R1 as a record nobody read; this file is the test that the whole
// `plan/` family now has a consumer that refuses to proceed without it. Every refusal names the file, and the
// recorded plan is RE-VALIDATED rather than trusted.

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function overviewRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
}

async function frozenRun(): Promise<{ runDir: string; manifest: RunManifest; evidenceId: string }> {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  return { runDir, manifest, evidenceId: (catalog.evidence.find((item) => item.kind === "source") ?? catalog.evidence[0]!).id };
}

let frozen: Promise<{ runDir: string; manifest: RunManifest; evidenceId: string }> | null = null;
function frozenOnce(): Promise<{ runDir: string; manifest: RunManifest; evidenceId: string }> {
  return (frozen ??= frozenRun());
}

test("begin and draft refuse a frozen run with no plan, naming the file and the command", async () => {
  const { runDir, manifest, evidenceId } = await frozenRun();
  const document = manifest.documents[0]!;
  await assert.rejects(() => beginDocument(runDir, document.id),
    /plan\/topics\.json is missing from .*; authoring cannot start without a validated plan\. Run `excavator plan --run .* --fixture-plan` \(or `--proposal <file>`\) first\./);
  await assert.rejects(() => draftSection(runDir, document.id, document.sections[0]!.index, `## ${document.sections[0]!.title}\n\ntext\n`),
    /plan\/topics\.json is missing from .*authoring cannot start without a validated plan/);

  // And with the plan in place the same calls go through, on the same run.
  await planRun(runDir, { mode: "fixture" }, { kind: "record" });
  assert.equal((await beginDocument(runDir, document.id)).state, "authoring");
  const receipt = await draftSection(runDir, document.id, document.sections[0]!.index, `## ${document.sections[0]!.title}\n\n第 1 节记录当前状态。\`事实\`\n\n<details><summary>依据</summary>\n\n- ${evidenceId}\n\n</details>\n`);
  assert.equal(receipt.section, document.sections[0]!.index);
});

test("each of the four plan files is named individually when it is the one that is missing", async () => {
  const { runDir } = await frozenOnce();
  await planRun(runDir, { mode: "fixture" }, { kind: "record" });
  assert.deepEqual([...PLAN_ARTIFACT_PATHS], ["plan/requests.json", "plan/topics.json", "plan/catalog.json", "plan/dag.json"]);

  for (const path of [planDagPath(runDir), planCatalogPath(runDir), topicsPath(runDir), reportRequestsPath(runDir)]) {
    const bytes = await readFile(path, "utf8");
    await rm(path);
    const relative = path.slice(runDir.length + 1).split("/").join("/");
    await assert.rejects(async () => assertValidatedPlanForAuthoring(runDir, await manifestOf(runDir)), new RegExp(`${relative.replace(".", "\\.")} is missing from`));
    await writeFile(path, bytes);
  }
  // Restored, the gate passes again — a missing file is a refusal, never a run that has been written off.
  const result = await assertValidatedPlanForAuthoring(runDir, await manifestOf(runDir));
  assert.equal(result.report.overall.conclusion, "vacuous",
    "the sample target has no material topic, so the plan's verdict is vacuous — and vacuous opens the gate");
});

test("the gate re-validates: a plan that no longer matches its epoch, or a tampered catalog, is refused", async () => {
  const { runDir } = await frozenOnce();
  await planRun(runDir, { mode: "fixture" }, { kind: "record" });
  const recordedTopics = await readFile(topicsPath(runDir), "utf8");
  const recordedPlan = await readFile(planCatalogPath(runDir), "utf8");

  // A topics catalog that does not match the epoch it claims to project.
  const topics = JSON.parse(recordedTopics) as Record<string, unknown>;
  await writeFile(topicsPath(runDir), `${stableJson({ ...topics, snapshotId: "another-snapshot" })}\n`);
  await assert.rejects(async () => assertValidatedPlanForAuthoring(runDir, await manifestOf(runDir)),
    /is not what this run's frozen knowledge derives; the recorded Topic Catalog and the epoch disagree/);
  await writeFile(topicsPath(runDir), recordedTopics);

  // A plan catalog whose unit references a topic that is not in the catalog.
  const plan = JSON.parse(recordedPlan) as { units: Array<{ topics: Array<{ topicId: string; topicDigest: string; obligationScope: unknown }> }> };
  const withPhantom = {
    ...plan,
    units: plan.units.map((unit, index) => index === 0 ? { ...unit, topics: [{ topicId: "feature:0000000000000000", topicDigest: "0".repeat(64), obligationScope: { kind: "all" } }] } : unit)
  };
  await writeFile(planCatalogPath(runDir), `${stableJson(withPhantom)}\n`);
  await assert.rejects(async () => assertValidatedPlanForAuthoring(runDir, await manifestOf(runDir)), /is not a valid plan catalog: .*which is not in this run's topics catalog/);
  await writeFile(planCatalogPath(runDir), recordedPlan);
  assert.equal((await assertValidatedPlanForAuthoring(runDir, await manifestOf(runDir))).report.overall.conclusion, "vacuous");
});

test("the plan stage refuses a run with no recorded request set, and names it", async () => {
  const { runDir } = await frozenRun();
  const bytes = await readFile(reportRequestsPath(runDir), "utf8");
  await rm(reportRequestsPath(runDir));
  await assert.rejects(() => planRun(runDir, { mode: "fixture" }, { kind: "record" }),
    /plan\/requests\.json is missing; a plan is validated against the recorded request set, and this run has none/);
  await assert.rejects(() => renderPlannerPacketForRun(runDir, { overBudget: "refuse", byteLimit: 524_288 }),
    /plan\/requests\.json is missing; a plan is validated against the recorded request set/);
  await writeFile(reportRequestsPath(runDir), bytes);
  const result = await planRun(runDir, { mode: "fixture" }, { kind: "record" });
  assert.equal(result.report.overall.conclusion, "vacuous");
});

test("an unfrozen run cannot be planned at all: the projection refuses it by name", async () => {
  const { runDir } = await prepareRun(await overviewRequest());
  await assert.rejects(() => planRun(runDir, { mode: "fixture" }, { kind: "record" }),
    /knowledge\.json is missing from .*; a Topic Catalog cannot be projected without it/);
});

test("a proposal file that does not parse is refused by name, and the run stays plannable", async () => {
  const { runDir } = await frozenOnce();
  const workdir = await tempDir();
  const bad = join(workdir, "proposal.json");
  await writeFile(bad, stableJson({ version: "plan-proposal-v1", units: [{ kind: "chapter" }], dispositions: [], budget: {} }));
  await assert.rejects(() => planRun(runDir, { mode: "file", path: bad }, { kind: "record" }),
    /is not a valid plan proposal: .*kind "chapter" is not one of: appendix, bridge, leaf, synthesis/);
  await assert.rejects(() => planRun(runDir, { mode: "file", path: join(workdir, "absent.json") }, { kind: "record" }),
    /does not exist; a plan proposal is read from a file this command is given/);
  // Re-proposable: the refusal wrote nothing that stops the next attempt.
  assert.equal((await planRun(runDir, { mode: "fixture" }, { kind: "record" })).report.overall.conclusion, "vacuous");
});
