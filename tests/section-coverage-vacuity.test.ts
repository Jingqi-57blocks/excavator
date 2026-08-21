import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AuditFinding, EvidenceItem, ReportRequest, RunManifest } from "../src/base/types.ts";
import { auditRun, freezeRun, prepareRun } from "../src/run/run.ts";
import { sectionPaths } from "../src/report/section-paths.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, installFixturePlan, manifestOf, tempDir } from "./helpers.ts";

/**
 * The three states of `auditRun`'s SECTION completeness family, and the two guards that make the middle one safe.
 *
 * 57B-480 left every unit-path run reporting two defects about a path it never used ("assembled report is
 * missing", "document is incomplete (0/N sections checkpointed)"), which put `manifest.state = "complete"` out of
 * reach. The discriminator answers "is that family about anything on this run?" — and the reason it needs its own
 * test file is that a discriminator with three outcomes is exactly the shape where only the interesting one gets
 * tested: proving the vacuous arm fires proves nothing about the two arms that must NOT fire.
 *
 * Each case below is one arm, and the two guards are the arms either side of the middle:
 *   - an ARCHIVED run (section artifacts on disk) must still be audited — deleting the discriminator's first
 *     branch whitewashes a half-finished archived run, and this file is what goes red when that happens;
 *   - a run that was prepared and then ABANDONED must still report incomplete — "nothing was written" is not
 *     the same fact as "nothing was supposed to be written", and only the plan tells them apart.
 */

const BUDGETS = { prepareMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function request(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
}

async function firstEvidence(runDir: string): Promise<string> {
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  return (catalog.evidence.find((item) => item.kind === "source") ?? catalog.evidence[0]!).id;
}

/** Write the section markdown and claims sidecar a PRE-CUTOVER run would have on disk, by hand. */
async function writeArchivedSections(runDir: string, manifest: RunManifest): Promise<void> {
  const evidenceId = await firstEvidence(runDir);
  const document = manifest.documents[0]!;
  await mkdir(join(runDir, "sections", document.id), { recursive: true });
  await mkdir(join(runDir, "claims", document.id), { recursive: true });
  for (const section of document.sections) {
    const paths = sectionPaths(runDir, document.id, section);
    await writeFile(paths.file, `## ${section.title}\n\n第 ${section.index} 节记录当前状态。\`事实\`\n\n<details><summary>依据</summary>\n\n- ${evidenceId}\n\n</details>\n`);
    await writeFile(paths.claimsFile, `${JSON.stringify({ version: 2, documentId: document.id, section: section.index, claims: [{ id: `C-${section.index}`, marker: "fact", statement: `第 ${section.index} 节记录当前状态。`, evidenceIds: [evidenceId], confidence: "high", status: "verified" }] }, null, 2)}\n`);
    section.complete = true;
  }
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

const sectionFamily = (findings: readonly AuditFinding[]): AuditFinding[] =>
  findings.filter((finding) => /assembled report is missing|sections checkpointed/.test(finding.message));
const vacuous = (findings: readonly AuditFinding[]): AuditFinding[] =>
  findings.filter((finding) => /^vacuous \(ledger-empty\)/.test(finding.message));

// --- arm 1: an archived run still gets audited (the whitewash guard) ------------------------------------

test("a run with section artifacts on disk is audited as before, plan or no plan", async () => {
  const { runDir, manifest } = await prepareRun(await request());
  await writeArchivedSections(runDir, manifest);

  const before = await auditRun(runDir);
  assert.deepEqual(vacuous(before.findings), [], "a run with section artifacts has a section family with a subject");
  assert.ok(before.findings.some((finding) => finding.level === "error" && /assembled report is missing/.test(finding.message)),
    "a checkpointed-but-never-assembled run must still be told its report is missing");

  // And the plan does not override the artifacts. `plan --run <dir>` accepts an archived run, so if the plan were
  // asked first, one command would whitewash a half-finished archived run's completeness.
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  await installFixturePlan(runDir);
  const after = await auditRun(runDir);
  assert.deepEqual(vacuous(after.findings), [], "artifacts outrank the plan: recording one must not silence the family");
  assert.ok(after.findings.some((finding) => finding.level === "error" && /assembled report is missing/.test(finding.message)));
});

// --- arm 2: a planned run with no section artifacts is vacuous, and the run level still runs -------------

test("a planned run with no section artifacts states its vacuity, and run-level checks are untouched", async () => {
  const { runDir } = await prepareRun(await request());
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  await installFixturePlan(runDir);

  const audited = await auditRun(runDir);
  assert.equal(vacuous(audited.findings).length, 1, "the vacuity is STATED, not silent");
  assert.deepEqual(vacuous(audited.findings).map((finding) => finding.level), ["warning"]);
  assert.deepEqual(sectionFamily(audited.findings), [], "no defect may be reported about a path this run never used");
  assert.deepEqual(audited.findings.filter((finding) => finding.level === "error"), [],
    `a clean unit-path run must audit clean: ${JSON.stringify(audited.findings, null, 2)}`);
  assert.equal((await manifestOf(runDir)).state, "complete", "the `complete` terminal state is reachable again");

  // SEPARATION, on the same run: vacuous is scoped to the section family and does not swallow the run level.
  // Corrupting the evidence catalog is a run-level defect; it must still be reported.
  const catalogPath = join(runDir, "evidence.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { evidence: Array<{ title?: string }> };
  catalog.evidence[0]!.title = `${catalog.evidence[0]!.title ?? ""} — tampered`;
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  const tampered = await auditRun(runDir);
  assert.equal(vacuous(tampered.findings).length, 1, "the section family is still vacuous");
  assert.ok(tampered.findings.some((finding) => finding.level === "error" && finding.document === "evidence"),
    "a run-level defect must still be reported on a run whose section family is vacuous");
  assert.equal((await manifestOf(runDir)).state, "audited", "and the run no longer certifies as complete");
});

// --- arm 3: prepared and abandoned still reports incomplete (the "did nothing" guard) --------------------

test("a run with no plan and no section artifacts still reports its document incomplete", async () => {
  const { runDir } = await prepareRun(await request());
  const audited = await auditRun(runDir);
  assert.deepEqual(vacuous(audited.findings), [], "without a plan there is nothing saying this run authors units");
  assert.ok(audited.findings.some((finding) => /sections checkpointed/.test(finding.message)),
    "a run that was prepared and abandoned must not read clean");
});
