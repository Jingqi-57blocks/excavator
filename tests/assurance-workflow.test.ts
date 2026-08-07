import { auditSectionClaims, auditTargetProblemAttribution } from "../src/assurance.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import type { EvidenceItem, InvestigationPlan, ReportRequest, SectionClaim, TraceRecord } from "../src/types.ts";
import { assembleRun, auditRun, checkpointSection, prepareRun, searchSourceEvidence, updateTraces, updateWorkItems } from "../src/run.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

async function request(options: { feature?: boolean; graph?: boolean } = {}): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  let codegraph: string | undefined;
  if (options.graph) {
    codegraph = join(workdir, "codegraph.db");
    createCodeGraphFixture(codegraph);
  }
  return {
    target,
    codegraph,
    codegraphMode: options.graph ? "auto" : "off",
    language: "zh-CN",
    detailLevel: "standard",
    workdir,
    overviewAudiences: options.feature ? [] : ["product"],
    features: options.feature ? [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["product"] }] : [],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  };
}

function text(title: string, index: number, evidenceId: string): string {
  return `## ${title}\n\n第 ${index} 节记录当前状态。\`事实\`\n\n<details><summary>依据</summary>\n\n- ${evidenceId}\n\n</details>\n`;
}
function claims(index: number, evidenceId: string): SectionClaim[] {
  return [{ id: `C-${index}`, marker: "fact", statement: `第 ${index} 节记录当前状态。`, evidenceIds: [evidenceId], confidence: "high", status: "verified" }];
}
async function firstEvidence(runDir: string): Promise<string> {
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  return catalog.evidence.find((item) => item.kind === "source")?.id ?? catalog.evidence[0].id;
}
async function completeWorkItems(runDir: string): Promise<void> {
  const receipt = await searchSourceEvidence(runDir, ["__no_such_assurance_marker__"], "complete synthetic coverage", { maxResults: 5 });
  const searchId = String((receipt.evidence as EvidenceItem).id);
  const plan = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as InvestigationPlan;
  await updateWorkItems(runDir, plan.items.map((item) => ({ id: item.id, status: "searched-not-found" as const, material: false, evidenceIds: [searchId], searchScope: "all candidate source files in the immutable fixture snapshot" })));
}
async function authorAll(runDir: string, manifest: Awaited<ReturnType<typeof prepareRun>>["manifest"]): Promise<string> {
  const id = await firstEvidence(runDir);
  for (const document of manifest.documents) for (const section of document.sections) {
    await checkpointSection(runDir, document.id, section.index, text(section.title, section.index, id), claims(section.index, id));
  }
  return id;
}

test("prepare persists analysis scope, provider registry, work items, traces and a valid timeline", async () => {
  const { runDir, manifest } = await prepareRun(await request({ graph: true }));
  const scope = JSON.parse(await readFile(join(runDir, "analysis-scope.json"), "utf8"));
  const providers = JSON.parse(await readFile(join(runDir, "provider-status.json"), "utf8"));
  const workitems = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8"));
  const traces = JSON.parse(await readFile(join(runDir, "traces.json"), "utf8"));
  const timeline = (await readFile(join(runDir, "timeline.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(scope.snapshotId, manifest.snapshot?.id);
  assert.equal(scope.providerRegistryDigest, providers.digest);
  assert.ok(providers.providers.some((provider: any) => provider.id === "source" && provider.selected));
  assert.ok(providers.providers.some((provider: any) => provider.id === "codegraph" && provider.selected));
  assert.ok(workitems.items.length > 0);
  assert.deepEqual(traces.traces, []);
  assert.equal(timeline[0].action, "run.prepared");
  assert.equal(timeline[0].sequence, 1);
});

test("audit detects timeline tampering", async () => {
  const { runDir, manifest } = await prepareRun(await request());
  const id = await authorAll(runDir, manifest);
  await completeWorkItems(runDir);
  await assembleRun(runDir);
  const timelinePath = join(runDir, "timeline.jsonl");
  const lines = (await readFile(timelinePath, "utf8")).trim().split("\n");
  const first = JSON.parse(lines[0]);
  first.action = "tampered";
  lines[0] = JSON.stringify(first);
  await writeFile(timelinePath, `${lines.join("\n")}\n`);
  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((finding) => finding.document === "timeline" && /digest|start/i.test(finding.message)));
  assert.ok(id);
});

test("material feature-flow work items require a verified trace", async () => {
  const { runDir, manifest } = await prepareRun(await request({ feature: true, graph: true }));
  const evidenceId = await authorAll(runDir, manifest);
  await completeWorkItems(runDir);
  const plan = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as InvestigationPlan;
  const flow = plan.items.find((item) => item.dimension === "normal-flow");
  assert.ok(flow);
  await updateWorkItems(runDir, [{ id: flow.id, status: "found", material: true, evidenceIds: [evidenceId], traceIds: [] }]);
  await assembleRun(runDir);
  let audit = await auditRun(runDir);
  assert.ok(audit.findings.some((finding) => /material flow work item has no trace/i.test(finding.message)));

  const trace: TraceRecord = {
    id: "T-leave-normal-flow",
    title: "Leave normal flow",
    type: "business-flow",
    status: "verified",
    confidence: "high",
    documentIds: [manifest.documents[0].id],
    steps: [
      { index: 1, action: "The user enters the leave route.", evidenceIds: [evidenceId] },
      { index: 2, action: "The handler returns the current leave result.", evidenceIds: [evidenceId] }
    ],
    createdAt: new Date().toISOString()
  };
  await updateTraces(runDir, [trace]);
  await updateWorkItems(runDir, [{ id: flow.id, status: "found", material: true, evidenceIds: [evidenceId], traceIds: [trace.id] }]);
  await assembleRun(runDir);
  audit = await auditRun(runDir);
  assert.ok(!audit.findings.some((finding) => /material flow work item has no trace|missing trace/i.test(finding.message)), JSON.stringify(audit.findings, null, 2));
});

test("assemble writes claims, trace and coverage companion files", async () => {
  const { runDir, manifest } = await prepareRun(await request());
  await authorAll(runDir, manifest);
  await completeWorkItems(runDir);
  await assembleRun(runDir);
  const documentId = manifest.documents[0].id;
  for (const suffix of ["claims", "traces", "coverage"]) {
    const path = join(runDir, "reports", "companions", `${documentId}.${suffix}.json`);
    const content = JSON.parse(await readFile(path, "utf8"));
    assert.equal(content.documentId, documentId);
  }
});

test("revising a checkpoint archives the previous section and claims", async () => {
  const { runDir, manifest } = await prepareRun(await request());
  const evidenceId = await firstEvidence(runDir);
  const document = manifest.documents[0];
  const section = document.sections[0];
  await checkpointSection(runDir, document.id, section.index, text(section.title, 1, evidenceId), claims(1, evidenceId));
  await checkpointSection(runDir, document.id, section.index, text(section.title, 2, evidenceId), claims(2, evidenceId));
  const history = await readdir(join(runDir, "history", document.id));
  assert.ok(history.some((file) => file.endsWith(".md")));
  assert.ok(history.some((file) => file.endsWith(".claims.json")));
});

test("source-only provider registry records CodeGraph as unselected", async () => {
  const { runDir } = await prepareRun(await request());
  const providers = JSON.parse(await readFile(join(runDir, "provider-status.json"), "utf8"));
  const graph = providers.providers.find((provider: any) => provider.id === "codegraph");
  assert.equal(graph.selected, false);
  assert.equal(graph.available, false);
  assert.match(graph.selectionReason, /source-only/i);
});

test("audit recognizes Unicode and provider/scope evidence identifiers in section evidence blocks", async () => {
  const { runDir, manifest } = await prepareRun(await request({ feature: true, graph: true }));
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  const ids = [
    catalog.evidence.find((item) => item.id.startsWith("FG-"))?.id,
    catalog.evidence.find((item) => item.id.startsWith("SCOPE-"))?.id,
    catalog.evidence.find((item) => item.id.startsWith("PROVIDER-"))?.id
  ].filter((id): id is string => Boolean(id));
  assert.equal(ids.length, 3);
  const document = manifest.documents[0];
  const section = document.sections[0];
  const statement = "The feature boundary is recorded by the selected providers and analysis scope.";
  const body = `## ${section.title}\n\n${statement} \`Fact\`\n\n<details><summary>Evidence</summary>\n\n${ids.map((id) => `- ${id}`).join("\n")}\n\n</details>\n`;
  await checkpointSection(runDir, document.id, section.index, body, [{ id: "C-unicode-evidence", marker: "fact", statement, evidenceIds: ids, confidence: "high", status: "verified" }]);
  const audit = await auditRun(runDir);
  assert.ok(!audit.findings.some((finding) => /evidence block does not cite/i.test(finding.message)), JSON.stringify(audit.findings, null, 2));
});


// The scanner is internal; the ids it extracts surface one-for-one as "cites <id>" findings
// when the section declares no evidence, so the findings are a faithful readout of the scan.
function citedEvidenceIds(sectionText: string, knownEvidenceIds: string[] = []): string[] {
  const findings = auditSectionClaims({
    documentId: "doc",
    sectionIndex: 1,
    sectionText,
    claimsFile: { version: 2, documentId: "doc", section: 1, claims: [] },
    evidenceIds: new Set(knownEvidenceIds)
  });
  return findings
    .flatMap((finding) => finding.message.match(/cites (\S+) but no section claim declares it/)?.[1] ?? [])
    .sort();
}

test("evidence id scanner never emits ids that end on a separator", () => {
  assert.deepEqual(citedEvidenceIds("<!--E:S-d59eb3a823-->", ["S-d59eb3a823"]), ["S-d59eb3a823"]);
  assert.deepEqual(citedEvidenceIds("- S-abc--", ["S-abc"]), ["S-abc"]);
  assert.deepEqual(citedEvidenceIds("- S-abc.", ["S-abc"]), ["S-abc"]);
  assert.deepEqual(citedEvidenceIds("- S-abc:", ["S-abc"]), ["S-abc"]);
  // A separator-terminated token that matches no catalogued id is no longer reported at all,
  // which is what stops one stray marker from cascading into hundreds of false findings.
  assert.deepEqual(citedEvidenceIds("<!--E:S-d59eb3a823-->"), []);
});

test("evidence id scanner still recognizes plain and Unicode ids", () => {
  assert.deepEqual(citedEvidenceIds("- SEARCH-1a2b3c"), ["SEARCH-1a2b3c"]);
  assert.deepEqual(citedEvidenceIds("- FG-请假管理-abc12"), ["FG-请假管理-abc12"]);
  assert.deepEqual(citedEvidenceIds("依据 SEARCH-1a2b3c 与 GIT-9f0e1d。"), ["GIT-9f0e1d", "SEARCH-1a2b3c"]);
});

test("target problem sections reject analyser limitations", () => {
  const document = {
    id: "leave-product",
    kind: "feature" as const,
    audience: "product" as const,
    subject: "Leave",
    templatePath: "template.md",
    contextPath: "context.md",
    sections: []
  };
  const findings = auditTargetProblemAttribution({
    document,
    sectionIndex: 10,
    sectionText: "## Current problems\n\nCodeGraph routes cannot prove the complete handler path."
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /analysis-method information/i);
});

test("target problem sections allow target-attributable contradictions", () => {
  const document = {
    id: "leave-engineering",
    kind: "feature" as const,
    audience: "engineering" as const,
    subject: "Leave",
    templatePath: "template.md",
    contextPath: "context.md",
    sections: []
  };
  const findings = auditTargetProblemAttribution({
    document,
    sectionIndex: 11,
    sectionText: "## Current problems\n\nThe production threshold is 166 hours while the target test asserts 200 hours."
  });
  assert.equal(findings.length, 0);
});
