import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { DocumentPlan, EvidenceItem, ReportRequest, RunManifest, SectionClaim } from "../src/core/types.ts";
import { auditReadabilityTables } from "../src/assurance/section-audit.ts";
import { assembleRun, auditRun, checkpointSection, freezeRun, prepareRun, searchSourceEvidence, updateChecklist } from "../src/core/run.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

// 57B-379 appends `## 13. Database design` to engineering-overview.md and adds index 13 to the advisory
// READABILITY_TABLE_SECTIONS["overview:engineering"] set. This suite pins both halves of that change:
//   (forward) a fresh engineering-overview treats §13 as an inventory/comparison chapter, and
//   (grandfather) an already-prepared 12-section engineering-overview run is byte-for-byte unaffected —
//     audit reads the manifest's baked section list, so index 13 is never reached and adds nothing.

// ---- forward: §13 is a recognized inventory chapter for the engineering overview ----

function engineeringOverviewPlan(): DocumentPlan {
  return { id: "overview-engineering", kind: "overview", audience: "engineering", templatePath: "", contextPath: "", sections: [] };
}

const DB_PROSE = "本章列出每张已声明的数据表及其字段来源。`事实`\n\n各表之间的关系依据声明的外键给出。`推断`";
const DB_PROSE_WITH_TABLE = `${DB_PROSE}\n\n| 字段 | 类型 | 可空 |\n| --- | --- | --- |\n| id | int | 否 |\n`;

test("§13 database design counts as an inventory chapter for the engineering overview: prose without a table nudges, a table satisfies it (57B-379)", () => {
  const document = engineeringOverviewPlan();
  const nudge = auditReadabilityTables({ document, sectionIndex: 13, sectionText: DB_PROSE });
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].level, "warning");
  assert.match(nudge[0].message, /section 13/);
  const satisfied = auditReadabilityTables({ document, sectionIndex: 13, sectionText: DB_PROSE_WITH_TABLE });
  assert.equal(satisfied.length, 0);
});

// ---- grandfather: a 12-section engineering-overview run is unaffected by the appended §13 ----

async function engineeringOverviewRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const db = join(workdir, "codegraph.db");
  createCodeGraphFixture(db);
  return {
    target, codegraph: db, workdir, language: "zh-CN", detailLevel: "standard",
    overviewAudiences: ["engineering"],
    features: [],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 60, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 60, maxExpansionDepth: 2 }
  };
}

function sectionText(title: string, index: number, evidenceId: string): string {
  return `## ${title}\n\n这是第 ${index} 章的当前状态说明。\`事实\`\n\n<details>\n<summary>依据</summary>\n\n- ${evidenceId}\n\n</details>\n`;
}

function sectionClaims(index: number, evidenceId: string): SectionClaim[] {
  return [{ id: `claim-${index}-fact`, marker: "fact", statement: `这是第 ${index} 章的当前状态说明。`, evidenceIds: [evidenceId] }];
}

async function firstEvidence(runDir: string): Promise<string> {
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  return catalog.evidence.find((item) => item.kind === "source")?.id ?? catalog.evidence[0].id;
}

async function dispositionChecklist(runDir: string): Promise<void> {
  const receipt = await searchSourceEvidence(runDir, ["__excavator_no_such_db_marker__"], "prove the synthetic hypothesis search completed", { maxResults: 10 });
  const searchId = String((receipt.evidence as EvidenceItem).id);
  const checklist = JSON.parse(await readFile(join(runDir, "checklist.json"), "utf8")) as { items: Array<{ id: string }> };
  await updateChecklist(runDir, checklist.items.map((item) => ({
    id: item.id,
    verdict: "searched-not-found" as const,
    material: false,
    evidenceIds: [searchId],
    searchScope: "all candidate source files in the immutable synthetic fixture snapshot"
  })));
}

test("a 12-section engineering-overview run is unaffected by the appended §13 (grandfather is structural) (57B-379)", async () => {
  const { runDir, manifest } = await prepareRun(await engineeringOverviewRequest());
  const overview = manifest.documents.find((document) => document.id === "overview-engineering");
  assert.ok(overview, "prepare should produce an engineering-overview document");
  assert.equal(overview!.sections.length, 13, "a fresh prepare bakes the appended §13 chapter");

  // Represent a run prepared before the append: drop §13 from the baked manifest so the document carries
  // the pre-append 12-section list, exactly as an on-disk run created before this slice would. Audit keys
  // on this baked list, never on the template, so this is the faithful grandfather fixture.
  const runPath = join(runDir, "run.json");
  const persisted = JSON.parse(await readFile(runPath, "utf8")) as RunManifest;
  const persistedOverview = persisted.documents.find((document) => document.id === "overview-engineering")!;
  persistedOverview.sections = persistedOverview.sections.slice(0, 12);
  await writeFile(runPath, JSON.stringify(persisted, null, 2));

  // Author only the 12 grandfathered sections and assemble a 12-heading report.
  const id = await firstEvidence(runDir);
  await dispositionChecklist(runDir);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, true, JSON.stringify(frozen.findings, null, 2));
  for (const section of persistedOverview.sections) {
    await checkpointSection(runDir, "overview-engineering", section.index, sectionText(section.title, section.index, id), sectionClaims(section.index, id));
  }
  await assembleRun(runDir);

  const audit = await auditRun(runDir);
  const auditedOverview = audit.manifest.documents.find((document) => document.id === "overview-engineering")!;
  assert.equal(auditedOverview.sections.length, 12, "the audited manifest carries the grandfathered 12-section list");
  // Heading-count path: 12 report headings against a 12-section manifest — no mismatch finding.
  assert.ok(!audit.findings.some((finding) => /expected \d+ sections, found \d+/.test(finding.message)), JSON.stringify(audit.findings, null, 2));
  // Readability path: index 13 is never reached for a 12-section manifest, so the new set entry adds nothing.
  assert.ok(!audit.findings.some((finding) => /section 13/.test(finding.message)), JSON.stringify(audit.findings, null, 2));
  // The whole 12-section run stays error-free under the new code.
  assert.equal(audit.findings.filter((finding) => finding.level === "error").length, 0, JSON.stringify(audit.findings, null, 2));
});
