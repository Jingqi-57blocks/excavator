import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { EvidenceItem, InvestigationPlan, ReportRequest, TraceCatalog, TraceRecord } from "../src/base/types.ts";
import { auditRun, freezeRun, prepareRun, updateTraces } from "../src/run/run.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "./helpers.ts";

// What is left of the freeze HARD gate's own test file: the FROZEN-SET reconciliation — deleting a frozen work
// item or trace after freeze must fail the audit, instead of passing as a silent deletion.
//
// The gate's other two enforcement points moved out with the section chain (57B-480), and neither disappeared:
//   - the write-side refusal (`begin` refused an unfrozen run, ①②) is now `draft --unit` / `collect --units`,
//     tested in `tests/unit-freeze-gate.test.ts`;
//   - the audit-side order gate (③④) and its scoped downgrade (⑤) are in `tests/unit-run-audit.test.ts`, which
//     covers all three of `auditFreezeOrder`'s findings plus its two silent paths — strictly more than ③④⑤ did.
// The surviving case keeps its ⑥ so the two files can still be read against each other.

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function overviewRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
}

async function readPlan(runDir: string): Promise<InvestigationPlan> {
  return JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as InvestigationPlan;
}

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

  const evidenceCatalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  const removedEvidenceId = evidenceCatalog.evidence[0]?.id;
  evidenceCatalog.evidence.splice(0, 1);
  await writeFile(join(runDir, "evidence.json"), JSON.stringify(evidenceCatalog, null, 2));

  const audit = await auditRun(runDir);
  assert.ok(
    audit.findings.some((finding) => finding.level === "error" && finding.document === "knowledge" && /frozen work item .* is no longer present/.test(finding.message)),
    JSON.stringify(audit.findings, null, 2)
  );
  assert.ok(
    audit.findings.some((finding) => finding.level === "error" && finding.document === "knowledge" && /frozen trace .* is no longer present/.test(finding.message)),
    JSON.stringify(audit.findings, null, 2)
  );
  assert.ok(
    audit.findings.some((finding) => finding.level === "error" && finding.document === "knowledge" && /frozen evidence .* is no longer present/.test(finding.message)),
    JSON.stringify(audit.findings, null, 2)
  );
  assert.ok(removedItemId && removedEvidenceId);
});
