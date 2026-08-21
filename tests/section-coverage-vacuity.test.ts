import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AuditFinding, EvidenceItem, ReportRequest, RunManifest } from "../src/base/types.ts";
import { auditRun, freezeRun, prepareRun } from "../src/run/run.ts";
import { sectionPaths } from "../src/report/section-paths.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, installFixturePlan, manifestOf, tempDir } from "./helpers.ts";
import { collectedRun } from "./unit-assembly-fixture.ts";

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
const declared = (findings: readonly AuditFinding[]): AuditFinding[] =>
  findings.filter((finding) => /section audit retired with its generation/.test(finding.message));

// --- arm 1: an archived run still gets audited (the whitewash guard) ------------------------------------

test("a run with section artifacts on disk is audited as before, plan or no plan", async () => {
  const { runDir, manifest } = await prepareRun(await request());
  await writeArchivedSections(runDir, manifest);

  const before = await auditRun(runDir);
  assert.deepEqual(vacuous(before.findings), [], "a run with section artifacts has a section family with a subject");
  // The absence of the retired rules is DECLARED, on a run that checkpointed sections and never assembled — the
  // shape a probe caught going silent when this was gated on the assembled report existing instead of on the
  // state. Silence here would leave this audit indistinguishable from one where the rules ran and passed.
  assert.equal(declared(before.findings).length, 1, "an archived run must be told its section rules did not run");
  assert.deepEqual(declared(before.findings).map((finding) => finding.level), ["warning"]);
  assert.ok(before.findings.some((finding) => finding.level === "error" && /assembled report is missing/.test(finding.message)),
    "a checkpointed-but-never-assembled run must still be told its report is missing");

  // And the plan does not override the artifacts. `plan --run <dir>` accepts an archived run, so if the plan were
  // asked first, one command would whitewash a half-finished archived run's completeness.
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  await installFixturePlan(runDir);
  const after = await auditRun(runDir);
  assert.deepEqual(vacuous(after.findings), [], "artifacts outrank the plan: recording one must not silence the family");
  assert.equal(declared(after.findings).length, 1, "and the declaration survives the plan being recorded");

  // FAIL-CLOSED INTEGRITY SURVIVED THE RULES. Deleting a section file the manifest still calls complete must be
  // an error: this is the archived-artifact guarantee the arm keeps, not one of the retired rules — and a
  // falsification probe found that removing it broke no test, so it is pinned here.
  const archived = await manifestOf(runDir);
  const victim = archived.documents[0]!.sections[0]!;
  await rm(sectionPaths(runDir, archived.documents[0]!.id, victim).file);
  const gutted = await auditRun(runDir);
  assert.ok(gutted.findings.some((finding) => finding.level === "error"
    && new RegExp(`checkpointed section ${victim.index} file is missing`).test(finding.message)),
    `a section the manifest calls complete must have its bytes on disk: ${JSON.stringify(gutted.findings, null, 2)}`);
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
  assert.deepEqual(declared(audited.findings), [], "a run that never had sections has no retired rules to declare");
  assert.deepEqual(vacuous(audited.findings).map((finding) => finding.level), ["warning"]);
  assert.deepEqual(sectionFamily(audited.findings), [], "no defect may be reported about a path this run never used");

  // AND IT MUST NOT CERTIFY. This run recorded a plan and then authored nothing — no draft, no collect, no
  // deliverable. Suppressing the section family removed the only sentence that said "not finished", so the
  // question is answered from the unit ledger instead; a `/code-review` probe caught this reading `complete`.
  assert.ok(audited.findings.some((finding) => finding.level === "error" && /collected none of its \d+ authoring unit\(s\)/.test(finding.message)),
    `a run that authored nothing must not read clean: ${JSON.stringify(audited.findings, null, 2)}`);
  assert.notEqual((await manifestOf(runDir)).state, "complete");

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
});

// --- arm 3: prepared and abandoned still reports incomplete (the "did nothing" guard) --------------------

test("a run with no plan and no section artifacts still reports its document incomplete", async () => {
  const { runDir } = await prepareRun(await request());
  const audited = await auditRun(runDir);
  assert.deepEqual(vacuous(audited.findings), [], "without a plan there is nothing saying this run authors units");
  assert.ok(audited.findings.some((finding) => /sections checkpointed/.test(finding.message)),
    "a run that was prepared and abandoned must not read clean");
});

// --- arm 2, the other half: a run that ACTUALLY authored its units may certify ---------------------------

/**
 * The positive control for the arm above, and the reason the "authored nothing" error is a discriminator rather
 * than a blanket refusal. Without this case, making that error unconditional would pass every other test in this
 * file — the suppression would simply have been traded for a permanent defect, and `complete` would still be out
 * of reach for every unit run, which is the state 57B-481 exists to fix.
 */
test("a unit run that collected every planned unit certifies complete, with the section family vacuous", async () => {
  const run = await collectedRun();
  const audited = await auditRun(run.runDir);

  assert.equal(vacuous(audited.findings).length, 1, "its section family still has no subject");
  assert.deepEqual(sectionFamily(audited.findings), []);
  assert.deepEqual(audited.findings.filter((finding) => finding.level === "error"), [],
    `a fully collected unit run must audit clean: ${JSON.stringify(audited.findings, null, 2)}`);
  assert.equal((await manifestOf(run.runDir)).state, "complete", "the `complete` terminal state is reachable again");
});
