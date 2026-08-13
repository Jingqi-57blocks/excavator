import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { EvidenceItem, InvestigationPlan, KnowledgeArtifact, ReportRequest, RunManifest, SectionClaim, TraceRecord } from "../src/core/types.ts";
import { addSourceEvidence, assembleRun, auditRun, checkpointSection, freezeRun, prepareRun, searchSourceEvidence, updateChecklist, updateTraces, updateWorkItems } from "../src/core/run.ts";
import { knowledgeDigest } from "../src/assurance/freeze.ts";
import { exists } from "../src/core/util.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "./helpers.ts";

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function overviewRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
}

async function featureRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: [], features: [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["product"] }], budgets: BUDGETS };
}

function sectionText(title: string, index: number, evidenceId: string): string {
  return `## ${title}\n\n第 ${index} 节记录当前状态。\`事实\`\n\n<details><summary>依据</summary>\n\n- ${evidenceId}\n\n</details>\n`;
}
function sectionClaims(index: number, evidenceId: string): SectionClaim[] {
  return [{ id: `C-${index}`, marker: "fact", statement: `第 ${index} 节记录当前状态。`, evidenceIds: [evidenceId], confidence: "high", status: "verified" }];
}
async function firstEvidence(runDir: string): Promise<string> {
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  return catalog.evidence.find((item) => item.kind === "source")?.id ?? catalog.evidence[0].id;
}
async function readPlan(runDir: string): Promise<InvestigationPlan> {
  return JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as InvestigationPlan;
}
async function readKnowledge(runDir: string): Promise<KnowledgeArtifact> {
  return JSON.parse(await readFile(join(runDir, "knowledge.json"), "utf8")) as KnowledgeArtifact;
}
async function readManifest(runDir: string): Promise<RunManifest> {
  return JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
}
async function readTimeline(runDir: string): Promise<Array<{ action: string; stage: string; data?: Record<string, unknown> }>> {
  return (await readFile(join(runDir, "timeline.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}
async function authorAll(runDir: string, manifest: RunManifest, evidenceId: string): Promise<void> {
  const document = manifest.documents[0];
  for (const section of document.sections) await checkpointSection(runDir, document.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(section.index, evidenceId));
}

// --- Group 1: freeze rejection ---

test("freeze is refused while required work items are still pending; no knowledge is written and the manifest is untouched", async () => {
  const { runDir } = await prepareRun(await overviewRequest());
  const before = await readManifest(runDir);
  const result = await freezeRun(runDir);
  assert.equal(result.frozen, false);
  assert.ok(result.findings.some((finding) => finding.level === "error" && /was not completed/.test(finding.message)), JSON.stringify(result.findings, null, 2));
  assert.equal(await exists(join(runDir, "knowledge.json")), false);
  const after = await readManifest(runDir);
  assert.equal(after.frozenAt, undefined);
  assert.equal(after.knowledgeDigest, undefined);
  assert.equal(after.updatedAt, before.updatedAt, "a refused freeze must not mutate the manifest");
});

test("freeze is refused when a found material flow work item has no trace", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  const evidenceId = await firstEvidence(runDir);
  await disposeAllWorkItems(runDir);
  const flow = (await readPlan(runDir)).items.find((item) => item.dimension === "normal-flow");
  assert.ok(flow);
  await updateWorkItems(runDir, [{ id: flow.id, status: "found", material: true, evidenceIds: [evidenceId], traceIds: [] }]);
  const result = await freezeRun(runDir);
  assert.equal(result.frozen, false);
  assert.ok(result.findings.some((finding) => /material flow work item has no trace/.test(finding.message)), JSON.stringify(result.findings, null, 2));
  assert.equal(await exists(join(runDir, "knowledge.json")), false);
});

// --- Group 2: freeze success ---

test("freeze writes a knowledge-v1 record, stamps the manifest, appends a timeline event and refuses a re-freeze", async () => {
  const { runDir, manifest } = await prepareRun(await featureRequest());
  await disposeAllWorkItems(runDir);
  const result = await freezeRun(runDir);
  assert.equal(result.frozen, true, JSON.stringify(result.findings, null, 2));

  const knowledge = await readKnowledge(runDir);
  assert.equal(knowledge.version, "knowledge-v1");
  assert.equal(knowledge.runId, manifest.id);
  assert.equal(knowledge.snapshotId, manifest.snapshot?.id);
  assert.deepEqual(knowledge.evidenceIds, [...knowledge.evidenceIds].sort((a, b) => a.localeCompare(b)), "evidence ids are recorded sorted");
  assert.ok(knowledge.workitems.length > 0);
  assert.ok(knowledge.workitems.every((item) => item.status === "not-applicable"));
  assert.ok(knowledge.workitems.every((item, index) => index === 0 || knowledge.workitems[index - 1].id.localeCompare(item.id) <= 0), "work items are recorded sorted by id");
  assert.equal(knowledge.completeness.requiredItems, knowledge.completeness.disposed);
  assert.equal(knowledge.completeness.materialFlowsWithTraces, 0);
  assert.ok(Object.keys(knowledge.factPackDigests).length >= 1, "a feature run records at least one fact-pack digest");
  assert.deepEqual(knowledge.supplements, []);

  const persisted = await readManifest(runDir);
  assert.ok(persisted.frozenAt);
  assert.equal(persisted.knowledgeDigest, knowledgeDigest(knowledge), "manifest digest recomputes from the frozen core");
  assert.equal(persisted.metrics.supplements, 0, "a frozen run initializes the supplement counter");

  const frozen = (await readTimeline(runDir)).find((event) => event.action === "investigation.frozen");
  assert.ok(frozen);
  assert.equal(frozen.stage, "investigation");
  assert.equal((frozen.data as Record<string, unknown>).knowledgeDigest, persisted.knowledgeDigest);

  // Freeze renders one authoring packet per document; the frozen event records how many.
  assert.equal((frozen.data as Record<string, unknown>).authoringPackets, manifest.documents.length);
  for (const document of manifest.documents) {
    assert.equal(await exists(join(runDir, "context", "authoring", `${document.id}.md`)), true, `packet missing for ${document.id}`);
  }

  await assert.rejects(() => freezeRun(runDir), /already frozen/);
});

// --- Group 3: freeze gate and supplement accounting ---

async function frozenOverviewRun(): Promise<{ runDir: string; manifest: RunManifest; itemId: string }> {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  await disposeAllWorkItems(runDir);
  const result = await freezeRun(runDir);
  assert.equal(result.frozen, true, JSON.stringify(result.findings, null, 2));
  const itemId = (await readPlan(runDir)).items[0].id;
  return { runDir, manifest, itemId };
}

test("after freeze the five runtime mutators refuse a mutation carrying no supplement", async () => {
  const { runDir, manifest, itemId } = await frozenOverviewRun();
  const trace: TraceRecord = { id: "T-x", title: "t", type: "business-flow", status: "unavailable", confidence: "low", documentIds: [manifest.documents[0].id], steps: [], reason: "r", createdAt: new Date().toISOString() };
  await assert.rejects(() => searchSourceEvidence(runDir, ["Leave"], "reason", { maxResults: 5 }), /frozen/);
  await assert.rejects(() => addSourceEvidence(runDir, "src/server.ts", 1, 3, "reason"), /frozen/);
  await assert.rejects(() => updateWorkItems(runDir, [{ id: itemId, status: "not-applicable", reason: "x" }]), /frozen/);
  await assert.rejects(() => updateChecklist(runDir, [{ id: itemId, verdict: "not-applicable", reason: "x" }]), /frozen/);
  await assert.rejects(() => updateTraces(runDir, [trace]), /frozen/);
});

test("a post-freeze search carrying a supplement succeeds and is recorded in knowledge, metrics and the timeline alike", async () => {
  const { runDir, itemId } = await frozenOverviewRun();
  const receipt = await searchSourceEvidence(runDir, ["Leave requests"], "confirm the UI phrase", { maxResults: 10 }, { reason: "the frozen catalog does not frame the UI phrase", workItemId: itemId });
  const searchId = String((receipt.evidence as EvidenceItem).id);

  const knowledge = await readKnowledge(runDir);
  assert.equal(knowledge.supplements.length, 1);
  assert.equal(knowledge.supplements[0].command, "search");
  assert.deepEqual(knowledge.supplements[0].ids, [searchId]);
  assert.equal(knowledge.supplements[0].workItemId, itemId);
  assert.ok(knowledge.supplements[0].reason.length > 0);

  assert.equal((await readManifest(runDir)).metrics.supplements, 1);

  const last = (await readTimeline(runDir)).at(-1)!;
  assert.equal(last.action, "source.search");
  assert.equal((last.data as Record<string, unknown>).supplement, true);
  assert.equal((last.data as Record<string, unknown>).workItemId, itemId);
});

test("a post-freeze work-item update carrying a supplement is recorded the same three ways", async () => {
  const { runDir, itemId } = await frozenOverviewRun();
  await updateWorkItems(runDir, [{ id: itemId, status: "not-applicable", reason: "re-confirmed after freeze" }], { reason: "the frozen disposition was too coarse", workItemId: itemId });
  const knowledge = await readKnowledge(runDir);
  assert.equal(knowledge.supplements.length, 1);
  assert.equal(knowledge.supplements[0].command, "workitem");
  assert.deepEqual(knowledge.supplements[0].ids, [itemId]);
  assert.equal((await readManifest(runDir)).metrics.supplements, 1);
  const last = (await readTimeline(runDir)).at(-1)!;
  assert.equal(last.action, "workitems.updated");
  assert.equal((last.data as Record<string, unknown>).supplement, true);
});

test("a supplement whose work item does not resolve in the plan is refused", async () => {
  const { runDir } = await frozenOverviewRun();
  await assert.rejects(() => searchSourceEvidence(runDir, ["x"], "reason", {}, { reason: "reason", workItemId: "no-such-work-item" }), /Supplement work item not found/);
});

test("a supplement reason without a work item — and a work item without a reason — is refused", async () => {
  const { runDir, itemId } = await frozenOverviewRun();
  await assert.rejects(() => searchSourceEvidence(runDir, ["x"], "reason", {}, { reason: "only a reason" }), /both --supplement-reason and --supplement-workitem/);
  await assert.rejects(() => searchSourceEvidence(runDir, ["x"], "reason", {}, { workItemId: itemId }), /both --supplement-reason and --supplement-workitem/);
});

// --- Group 4: audit consistency ---

test("a frozen run with a recorded supplement audits without a frozen-knowledge error", async () => {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  const evidenceId = await firstEvidence(runDir);
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  await authorAll(runDir, manifest, evidenceId);
  await assembleRun(runDir);

  const clean = await auditRun(runDir);
  assert.deepEqual(clean.findings.filter((finding) => finding.level === "error"), [], JSON.stringify(clean.findings, null, 2));

  const itemId = (await readPlan(runDir)).items[0].id;
  await searchSourceEvidence(runDir, ["Leave requests"], "confirm a phrase", { maxResults: 10 }, { reason: "framing gap in the frozen catalog", workItemId: itemId });
  const after = await auditRun(runDir);
  assert.ok(!after.findings.some((finding) => finding.level === "error" && finding.document === "knowledge"), JSON.stringify(after.findings, null, 2));
});

test("changing a work item's disposition after freeze without a supplement fails audit", async () => {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  const evidenceId = await firstEvidence(runDir);
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  await authorAll(runDir, manifest, evidenceId);
  await assembleRun(runDir);

  // Bypass the mutator: rewrite workitems.json directly, so no supplement is ever recorded.
  const planPath = join(runDir, "workitems.json");
  const plan = await readPlan(runDir);
  plan.items[0].status = "found";
  plan.items[0].evidenceIds = [evidenceId];
  await writeFile(planPath, JSON.stringify(plan, null, 2));

  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((finding) => finding.level === "error" && finding.document === "knowledge" && /disposition changed after freeze without a recorded supplement/.test(finding.message)), JSON.stringify(audit.findings, null, 2));
});

test("an unfrozen current-version run fails the freeze-order gate but triggers no frozen-knowledge check; a downgraded version grandfathers it", async () => {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  const evidenceId = await firstEvidence(runDir);
  await authorAll(runDir, manifest, evidenceId);
  await disposeAllWorkItems(runDir);
  await assembleRun(runDir);

  // Current version: no knowledge.json exists, so the frozen-knowledge reconciliation stays silent — but
  // the run was authored without ever freezing, so the freeze-order gate fires as a hard error.
  const current = await auditRun(runDir);
  assert.equal(await exists(join(runDir, "knowledge.json")), false);
  assert.ok(!current.findings.some((finding) => finding.document === "knowledge"), JSON.stringify(current.findings, null, 2));
  assert.ok(
    current.findings.some((finding) => finding.level === "error" && finding.document === "freeze" && /never frozen/.test(finding.message)),
    JSON.stringify(current.findings, null, 2)
  );

  // Downgrade the stamped version to a pre-v3 literal: a run prepared before freeze became a hard
  // authoring precondition is grandfathered — neither the freeze-order gate nor the strict marker check
  // fires — so it audits clean.
  const runPath = join(runDir, "run.json");
  const persisted = JSON.parse(await readFile(runPath, "utf8")) as RunManifest;
  persisted.assuranceVersion = "assurance-v2-redaction-v4";
  await writeFile(runPath, JSON.stringify(persisted, null, 2));
  const legacy = await auditRun(runDir);
  assert.deepEqual(legacy.findings.filter((finding) => finding.level === "error"), [], JSON.stringify(legacy.findings, null, 2));
});

// --- Group 5: scoped audit downgrade ---

test("a scoped single-document audit downgrades a frozen-knowledge violation to advisory", async () => {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  const evidenceId = await firstEvidence(runDir);
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  const document = manifest.documents[0];
  await authorAll(runDir, manifest, evidenceId);

  const planPath = join(runDir, "workitems.json");
  const plan = await readPlan(runDir);
  plan.items[0].status = "found";
  plan.items[0].evidenceIds = [evidenceId];
  await writeFile(planPath, JSON.stringify(plan, null, 2));

  const scoped = await auditRun(runDir, { documentId: document.id });
  const knowledgeFindings = scoped.findings.filter((finding) => finding.document === "knowledge" && /disposition changed after freeze/.test(finding.message));
  assert.ok(knowledgeFindings.length >= 1, JSON.stringify(scoped.findings, null, 2));
  assert.ok(knowledgeFindings.every((finding) => finding.level === "warning"), "scoped run-wide findings are advisory");
});
