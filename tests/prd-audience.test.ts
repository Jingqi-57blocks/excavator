import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { DocumentPlan, EvidenceItem, InvestigationPlan, InvestigationWorkItem, ReportRequest, SectionClaim } from "../src/types.ts";
import { auditWorkItemClaimCoverage } from "../src/assurance.ts";
import { assembleRun, auditRun, checkpointSection, freezeRun, prepareRun, searchSourceEvidence, updateWorkItems } from "../src/run.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

// --- 1. the ONE substantive prd relaxation: the section-link check, with a hard negative control ---

function featureDoc(audience: DocumentPlan["audience"], id: string): DocumentPlan {
  return { id, kind: "feature", audience, subject: "Leave", templatePath: "/t", contextPath: "/c", sections: [] };
}

test("the section-link check is relaxed for prd but still fires for engineering (negative control) (57B-380)", () => {
  const prdDoc = featureDoc("prd", "feature-abc-prd");
  const engDoc = featureDoc("engineering", "feature-abc-engineering");
  // One §5-pinned work item, required for both documents; non-material so no completeness finding intrudes.
  const item: InvestigationWorkItem = {
    id: "feature:abc:authorization", dimension: "authorization", scope: "feature:abc", hypothesis: "h",
    status: "found", material: false, requiredFor: [prdDoc.id, engDoc.id], evidenceIds: [], traceIds: [],
    reportSection: 5, origin: "default"
  };
  const plan: InvestigationPlan = { version: 1, runId: "run-x", createdAt: "t", items: [item] };
  // A claim placed in section 3 — the "wrong" chapter for a §5-pinned item — that cites the work item.
  const claim: SectionClaim = { id: "C-1", marker: "fact", statement: "s", evidenceIds: [], workItemIds: [item.id] };

  const prdFindings = auditWorkItemClaimCoverage(plan, [prdDoc], new Map([[prdDoc.id, [{ section: 3, claim }]]]));
  assert.ok(!prdFindings.some((finding) => /expected section/.test(finding.message)), JSON.stringify(prdFindings));

  // Negative control — the exact same scenario on an engineering document STILL errors. This proves the
  // relaxation is prd-gated and does not leak into the product/engineering paths.
  const engFindings = auditWorkItemClaimCoverage(plan, [engDoc], new Map([[engDoc.id, [{ section: 3, claim }]]]));
  assert.ok(
    engFindings.some((finding) => finding.level === "error" && /links work item .* to section 3, expected section 5/.test(finding.message)),
    JSON.stringify(engFindings)
  );
});

// --- 2. synthetic zero-model end-to-end: prepare → dispose → freeze → checkpoint → assemble → audit clean ---

async function prdRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return {
    target, codegraph, codegraphMode: "auto", language: "zh-CN", detailLevel: "standard", workdir,
    overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["prd"] }],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  };
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
async function disposeSearchedNotFound(runDir: string): Promise<void> {
  const receipt = await searchSourceEvidence(runDir, ["__no_such_assurance_marker__"], "complete synthetic coverage", { maxResults: 5 });
  const searchId = String((receipt.evidence as EvidenceItem).id);
  const plan = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as InvestigationPlan;
  await updateWorkItems(runDir, plan.items.map((item) => ({ id: item.id, status: "searched-not-found" as const, material: false, evidenceIds: [searchId], searchScope: "all candidate source files in the immutable fixture snapshot" })));
}

test("a prd feature run prepares, freezes, authors and audits with zero errors (57B-380 e2e)", async () => {
  const { runDir, manifest } = await prepareRun(await prdRequest());
  const prd = manifest.documents.find((document) => document.audience === "prd");
  assert.ok(prd, "a prd feature document was planned");
  assert.equal(prd!.sections.length, 10, "the prd-feature template's 10 chapters are derived as sections");
  assert.ok(prd!.templatePath.endsWith("prd-feature.md"));

  // Freeze-before-authoring order (assurance v3): dispose the plan and freeze, then author and assemble.
  await disposeSearchedNotFound(runDir);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, true, JSON.stringify(frozen.findings, null, 2));

  const evidenceId = await firstEvidence(runDir);
  for (const section of prd!.sections) {
    await checkpointSection(runDir, prd!.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(section.index, evidenceId));
  }
  await assembleRun(runDir);

  const audit = await auditRun(runDir);
  assert.deepEqual(audit.findings.filter((finding) => finding.level === "error"), [], JSON.stringify(audit.findings, null, 2));
  assert.equal(audit.manifest.state, "complete");

  // The assembled report carries the prd audience in its front matter.
  const report = await readFile(join(runDir, "reports", `${prd!.id.replace(/^feature-/, "").replace(/-prd$/, "")}-prd.md`), "utf8").catch(async () => {
    // reportFileName slugifies the subject; fall back to a directory scan if the slug differs.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(runDir, "reports"));
    const match = files.find((name) => name.endsWith("-prd.md"));
    return readFile(join(runDir, "reports", match!), "utf8");
  });
  assert.match(report, /audience: prd/);
});
