import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { EvidenceItem, InvestigationPlan, ReportRequest, RunManifest, SectionClaim, TraceCatalog, TraceRecord } from "../src/types.ts";
import { assembleRun, auditRun, beginDocument, checkpointSection, freezeRun, prepareRun, updateTraces } from "../src/run.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "./helpers.ts";

// The freeze-before-authoring HARD gate (assurance v3). Two enforcement points move in lock-step: `begin`
// refuses to start authoring an unfrozen current-version run, and the full audit fails a run that was
// authored without — or before — an `investigation.frozen` event. Both are version-gated, so a run stamped
// under a pre-v3 version is grandfathered. A pre-v3 literal ("assurance-v2-redaction-v4") stands in for such
// a run: it is not the current ASSURANCE_VERSION, so `runUsesCurrentAssurance` returns false for it.

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };
const LEGACY_VERSION = "assurance-v2-redaction-v4";

async function overviewRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
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
async function readManifest(runDir: string): Promise<RunManifest> {
  return JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
}
async function downgradeToLegacy(runDir: string): Promise<void> {
  const manifest = await readManifest(runDir);
  manifest.assuranceVersion = LEGACY_VERSION;
  await writeFile(join(runDir, "run.json"), JSON.stringify(manifest, null, 2));
}
async function authorEvery(runDir: string, manifest: RunManifest, evidenceId: string): Promise<void> {
  const document = manifest.documents[0];
  for (const section of document.sections) await checkpointSection(runDir, document.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(section.index, evidenceId));
}

// --- ① begin rejects an unfrozen current-version run, and admits it once frozen ---

test("begin refuses an unfrozen current-version run; dispose + freeze then admits authoring", async () => {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  const documentId = manifest.documents[0].id;
  await assert.rejects(() => beginDocument(runDir, documentId), /not frozen/);
  // The run must be untouched by the refusal: still not frozen, still not authoring.
  assert.equal((await readManifest(runDir)).frozenAt, undefined);

  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  const begun = await beginDocument(runDir, documentId);
  assert.equal(begun.state, "authoring");
});

// --- ② a downgraded pre-v3 run may begin without freezing (grandfather) ---

test("a pre-v3 run may begin authoring without freezing", async () => {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  await downgradeToLegacy(runDir);
  const begun = await beginDocument(runDir, manifest.documents[0].id);
  assert.equal(begun.state, "authoring");
});

// --- ③ authoring without freezing fails the full audit's order gate; downgrading clears it ---

test("a current-version run authored without freezing fails the audit order gate; a downgrade clears it", async () => {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  const evidenceId = await firstEvidence(runDir);
  // Bypass begin entirely: checkpoint directly, never freeze.
  await authorEvery(runDir, manifest, evidenceId);
  await disposeAllWorkItems(runDir);
  await assembleRun(runDir);

  const current = await auditRun(runDir);
  assert.ok(
    current.findings.some((finding) => finding.level === "error" && finding.document === "freeze"),
    JSON.stringify(current.findings, null, 2)
  );

  await downgradeToLegacy(runDir);
  const legacy = await auditRun(runDir);
  assert.ok(!legacy.findings.some((finding) => finding.document === "freeze"), JSON.stringify(legacy.findings, null, 2));
});

// --- ④ freeze is version-agnostic and permits a late freeze, but the audit still fails the order gate ---

test("freezing after a section is already authored succeeds yet still fails the audit order gate", async () => {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  const evidenceId = await firstEvidence(runDir);
  const document = manifest.documents[0];
  // Author section 1 before freezing — the write freeze is meant to forbid.
  await checkpointSection(runDir, document.id, 1, sectionText(document.sections[0].title, 1, evidenceId), sectionClaims(1, evidenceId));
  await disposeAllWorkItems(runDir);
  // Freeze itself is version-agnostic and permits a late freeze: it succeeds even though a section exists.
  assert.equal((await freezeRun(runDir)).frozen, true);
  for (const section of document.sections.slice(1)) await checkpointSection(runDir, document.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(section.index, evidenceId));
  await assembleRun(runDir);

  const audit = await auditRun(runDir);
  assert.ok(
    audit.findings.some((finding) => finding.level === "error" && finding.document === "freeze" && /before the investigation was frozen/.test(finding.message)),
    JSON.stringify(audit.findings, null, 2)
  );
});

// --- ⑤ a scoped single-document audit downgrades the order violation to advisory ---

test("a scoped single-document audit downgrades the freeze-order violation to a warning", async () => {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  const evidenceId = await firstEvidence(runDir);
  const document = manifest.documents[0];
  await authorEvery(runDir, manifest, evidenceId);

  const scoped = await auditRun(runDir, { documentId: document.id });
  const freezeFindings = scoped.findings.filter((finding) => finding.document === "freeze");
  assert.ok(freezeFindings.length >= 1, JSON.stringify(scoped.findings, null, 2));
  assert.ok(freezeFindings.every((finding) => finding.level === "warning"), "scoped run-wide freeze-order findings are advisory");
});

// --- ⑥ deleting a frozen work item or trace after freeze fails the audit as a silent deletion ---

test("deleting a frozen work item or trace after freeze fails the audit as a silent deletion", async () => {
  const { runDir, manifest } = await prepareRun(await overviewRequest());
  await disposeAllWorkItems(runDir);
  const trace: TraceRecord = { id: "T-symmetric", title: "t", type: "business-flow", status: "unavailable", confidence: "low", documentIds: [manifest.documents[0].id], steps: [], reason: "recorded so the frozen set carries a trace to delete", createdAt: new Date().toISOString() };
  await updateTraces(runDir, [trace]);
  assert.equal((await freezeRun(runDir)).frozen, true);

  // Bypass the mutators and delete straight from the artifacts, so no supplement is ever recorded.
  const plan = await readPlan(runDir);
  const removedItemId = plan.items[0].id;
  plan.items.splice(0, 1);
  await writeFile(join(runDir, "workitems.json"), JSON.stringify(plan, null, 2));

  const catalog = JSON.parse(await readFile(join(runDir, "traces.json"), "utf8")) as TraceCatalog;
  catalog.traces = catalog.traces.filter((item) => item.id !== trace.id);
  await writeFile(join(runDir, "traces.json"), JSON.stringify(catalog, null, 2));

  const audit = await auditRun(runDir);
  assert.ok(
    audit.findings.some((finding) => finding.level === "error" && finding.document === "knowledge" && /frozen work item .* is no longer present/.test(finding.message)),
    JSON.stringify(audit.findings, null, 2)
  );
  assert.ok(
    audit.findings.some((finding) => finding.level === "error" && finding.document === "knowledge" && /frozen trace .* is no longer present/.test(finding.message)),
    JSON.stringify(audit.findings, null, 2)
  );
  assert.ok(removedItemId);
});
