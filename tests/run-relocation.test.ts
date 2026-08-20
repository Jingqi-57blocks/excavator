import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ReportRequest, RunManifest, SectionClaim } from "../src/base/types.ts";
import {
  addSourceEvidence, assembleRun, auditRun, beginDocument, checkpointSection, freezeRun, prepareRun,
  readingCheck, resumeRun, runStatus, scaffoldClaims, searchSourceEvidence, updateChecklist, updateTraces,
  updateWorkItems
} from "../src/run/run.ts";
import { collectDrafts, draftSection } from "../src/report/parallel-authoring.ts";
import { sectionPaths } from "../src/report/section-paths.ts";
import { exists, sha256 } from "../src/base/util.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, installFixturePlan, tempDir } from "./helpers.ts";
import { planRun, renderPlannerPacketForRun } from "../src/run/stages/plan-stage.ts";
import { loadRunUnitIdentities, rowUnitId } from "../src/report/unit-cache-identity-source.ts";
import { loadCoverageStateFacts } from "../src/report/coverage-companion-source.ts";
import { renderCoverageCompanion } from "../src/report/coverage-companion.ts";
import { planUnitAdmission } from "../src/report/unit-cache-admission-run.ts";
import { planCatalogDigest } from "../src/report/plan-artifacts.ts";
import { planRevisionArchive } from "../src/report/plan-revision.ts";
import { appendReportRequest } from "../src/report/report-requests-append.ts";
import { readReportRequests } from "../src/report/report-requests-artifact.ts";
import { plannedDocumentId } from "../src/report/legacy-request-mapping.ts";

/**
 * 57B-452 — a run directory must be movable.
 *
 * `run.json` records the absolute path of every section and claims file. Reading those records as WRITE
 * INSTRUCTIONS split a copied run in two: the ledger (`timeline.jsonl`, `run.json`, `metrics.json`) follows
 * `--run`, so it landed in the copy, while the section markdown and its claims landed back in the original.
 * Both halves stayed internally consistent — the copy's manifest said "complete" with nothing beside it, the
 * original grew a file no ledger mentioned — so auditing either side alone reported nothing. It happened
 * once for real and came within one command of writing a claim into a committed `frozen-not-authored`
 * baseline, which the mode's bidirectional check would then have rejected forever.
 *
 * The fixture is the negative one the issue asks for, generalised so it cannot be satisfied command by
 * command: copy the whole workspace, run an operation against the COPY, and require the recorded location to
 * be byte-for-byte what it was. Any write to the old location — section, claims, history archive, receipt,
 * report, ledger — shows up as a named created/changed/deleted path. The read side is covered by the same
 * fixture from the other direction: the recorded location holds no section files at all, so a command that
 * reads through the recorded path sees an empty run and says so.
 *
 * `exercised` makes the coverage total. Every `--run`-taking command parsed out of `src/cli.ts` must have
 * been exercised by the time the last test runs, so a new run-scoped command cannot be added without either
 * a relocation test or a deliberate edit to this file. Fixing only the two commands the bug was found in
 * would have moved the silent split to the next command instead of removing it.
 */

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

/** Commands exercised against a relocated run, filled in as the tests run and checked for totality last. */
const exercised = new Set<string>();

interface Base {
  /** The workspace root the run was prepared under: the location `run.json` records absolute paths into. */
  workdir: string;
  runDir: string;
  documentId: string;
  evidenceId: string;
}

async function request(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir("excavator-base-");
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
}

async function manifestOf(runDir: string): Promise<RunManifest> {
  return JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
}

/** A prepared run with every work item disposed: freeze and the investigation commands can all still run. */
async function buildInvestigating(): Promise<Base> {
  const input = await request();
  const { runDir, manifest } = await prepareRun(input);
  await disposeAllWorkItems(runDir);
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: Array<{ id: string; kind: string }> };
  return {
    workdir: input.workdir,
    runDir,
    documentId: manifest.documents[0]!.id,
    evidenceId: (catalog.evidence.find((item) => item.kind === "source") ?? catalog.evidence[0]!).id
  };
}

/** A frozen run with its document begun: the authoring commands can all still run. */
async function buildAuthoring(): Promise<Base> {
  const base = await buildInvestigating();
  assert.equal((await freezeRun(base.runDir)).frozen, true);
  await installFixturePlan(base.runDir);
  await beginDocument(base.runDir, base.documentId);
  return base;
}

let investigating: Promise<Base> | null = null;
let authoring: Promise<Base> | null = null;
function investigatingBase(): Promise<Base> { return (investigating ??= buildInvestigating()); }
function authoringBase(): Promise<Base> { return (authoring ??= buildAuthoring()); }

/** Copy the whole workspace elsewhere and return the copy's run directory — a `cp -R` relocation. */
async function relocate(base: Base): Promise<string> {
  const moved = await tempDir("excavator-relocated-");
  await cp(base.workdir, moved, { recursive: true });
  return join(moved, relative(base.workdir, base.runDir));
}

async function treeDigest(dir: string): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) rows.set(relative(dir, full), sha256(await readFile(full)));
    }
  };
  await walk(dir);
  return rows;
}

function changes(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, digest] of after) if (!before.has(path)) out.push(`created ${path}`);
  else if (before.get(path) !== digest) out.push(`changed ${path}`);
  for (const path of before.keys()) if (!after.has(path)) out.push(`deleted ${path}`);
  return out.sort();
}

/**
 * Run `operate` against a relocated copy of `base` and require the recorded location to be untouched.
 * Returns the copy's run directory so the caller can assert the artifacts landed there instead.
 */
async function onRelocatedRun(base: Base, commands: string[], operate: (runDir: string) => Promise<void>): Promise<string> {
  const runDir = await relocate(base);
  const before = await treeDigest(base.workdir);
  await operate(runDir);
  assert.deepEqual(changes(before, await treeDigest(base.workdir)), [],
    "an operation on the relocated run wrote into the location run.json records, splitting the run in two");
  for (const command of commands) exercised.add(command);
  return runDir;
}

function sectionText(title: string, index: number, evidenceId: string): string {
  return `## ${title}\n\n第 ${index} 节记录当前状态。\`事实\`\n\n<details><summary>依据</summary>\n\n- ${evidenceId}\n\n</details>\n`;
}

function sectionClaims(documentId: string, index: number, evidenceId: string): SectionClaim[] {
  return [{ id: `C-${documentId}-${index}`, marker: "fact", statement: `第 ${index} 节记录当前状态。`, evidenceIds: [evidenceId], confidence: "high", status: "verified" }];
}

async function filesIn(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}

// --- the authoring commands: where the split was found -------------------------------------------------

test("relocated run: checkpoint writes the section and its claims into the copy, not the recorded location", async () => {
  const base = await authoringBase();
  const document = (await manifestOf(base.runDir)).documents[0]!;
  const section = document.sections[0]!;
  const runDir = await onRelocatedRun(base, ["checkpoint"], async (dir) => {
    await checkpointSection(dir, base.documentId, section.index, sectionText(section.title, section.index, base.evidenceId), sectionClaims(base.documentId, section.index, base.evidenceId));
  });

  // The artifacts and the ledger that claims them are on the same side.
  assert.deepEqual(await filesIn(join(runDir, "sections", base.documentId)), [basename(section.file)]);
  assert.deepEqual(await filesIn(join(runDir, "claims", base.documentId)), [basename(section.claimsFile)]);
  assert.equal((await manifestOf(runDir)).documents[0]!.sections[0]!.complete, true);
  assert.equal((await manifestOf(runDir)).metrics.claims, 1);
  // And the recorded location still has no section at all.
  assert.deepEqual(await filesIn(join(base.runDir, "sections", base.documentId)), []);
});

test("relocated run: checkpoint archives the revision it replaces into the copy's history", async () => {
  const base = await authoringBase();
  const section = (await manifestOf(base.runDir)).documents[0]!.sections[0]!;
  const runDir = await onRelocatedRun(base, ["checkpoint"], async (dir) => {
    await checkpointSection(dir, base.documentId, section.index, sectionText(section.title, section.index, base.evidenceId), sectionClaims(base.documentId, section.index, base.evidenceId));
    await checkpointSection(dir, base.documentId, section.index, `${sectionText(section.title, section.index, base.evidenceId)}\n修订。\n`, sectionClaims(base.documentId, section.index, base.evidenceId));
  });
  // A revision archive proves the second checkpoint SAW the first one: reading through the recorded path
  // would have found no prior section in the copy and archived nothing.
  assert.equal((await filesIn(join(runDir, "history", base.documentId))).length, 2);
});

test("relocated run: begin records the document start in the copy", async () => {
  const base = await authoringBase();
  const runDir = await onRelocatedRun(base, ["begin"], async (dir) => { await beginDocument(dir, base.documentId); });
  assert.ok((await manifestOf(runDir)).documents[0]!.startedAt);
});

test("relocated run: draft and collect keep the drafted section with the ledger that records it", async () => {
  const base = await authoringBase();
  const section = (await manifestOf(base.runDir)).documents[0]!.sections[0]!;
  const runDir = await onRelocatedRun(base, ["draft", "collect"], async (dir) => {
    const receipt = await draftSection(dir, base.documentId, section.index, sectionText(section.title, section.index, base.evidenceId), sectionClaims(base.documentId, section.index, base.evidenceId));
    assert.equal(receipt.hasClaims, true);
    assert.deepEqual(await filesIn(join(dir, "sections", base.documentId)), [basename(section.file)]);
    // `collect` is fail-closed: it refuses a receipt whose section is not on disk, so it can only succeed
    // if it looks for the section under `--run` rather than under the path the manifest records.
    assert.equal((await collectDrafts(dir)).collected.length, 1);
  });
  assert.equal((await manifestOf(runDir)).documents[0]!.sections[0]!.complete, true);
  assert.deepEqual(await filesIn(join(base.runDir, "sections", base.documentId)), []);
});

test("relocated run: assemble and audit read the copy's own sections", async () => {
  const base = await authoringBase();
  const document = (await manifestOf(base.runDir)).documents[0]!;
  const runDir = await onRelocatedRun(base, ["assemble", "audit"], async (dir) => {
    for (const section of document.sections) {
      await checkpointSection(dir, base.documentId, section.index, sectionText(section.title, section.index, base.evidenceId), sectionClaims(base.documentId, section.index, base.evidenceId));
    }
    await assembleRun(dir);
    const { findings } = await auditRun(dir);
    // The recorded location holds no sections, so reading through it would report every one as missing.
    assert.deepEqual(findings.filter((finding) => /section .* file is missing/.test(finding.message)), []);
  });
  const reports = await filesIn(join(runDir, "reports"));
  assert.ok(reports.some((name) => name.endsWith(".md")), reports.join(", "));
  // The assembled report is the concatenation of the copy's sections, so it must carry all of them.
  const report = await readFile(join(runDir, "reports", reports.find((name) => name.endsWith(".md"))!), "utf8");
  assert.equal([...report.matchAll(/^##\s+/gm)].length, document.sections.length);
});

/**
 * The read side on its own. Every other fixture here writes first, and under the pre-fix behaviour the write
 * put the artifacts back at the recorded location — where the readers then happened to find them, so the
 * reads looked fine. Placing the sections in the copy BY HAND, with no command involved, is the only way to
 * ask the readers the real question: given a run that has been moved, do they read the run they were given?
 *
 * It gets its OWN base rather than the shared one, and that is not tidiness. Measured: on the shared base
 * this test passed against the pre-fix code, because an earlier fixture's checkpoint had (through the very
 * bug under test) written all ten sections into the recorded location, so the readers found them there. A
 * fixture that the defect itself repairs is not a fixture.
 */
test("relocated run: assemble, audit and the claims total read the copy's own sections, not the recorded location", async () => {
  const base = await buildAuthoring();
  const runDir = await relocate(base);
  const documentId = base.documentId;
  const manifest = await manifestOf(runDir);
  await mkdir(join(runDir, "sections", documentId), { recursive: true });
  await mkdir(join(runDir, "claims", documentId), { recursive: true });
  for (const section of manifest.documents[0]!.sections) {
    await writeFile(join(runDir, "sections", documentId, basename(section.file)), sectionText(section.title, section.index, base.evidenceId));
    await writeFile(join(runDir, "claims", documentId, basename(section.claimsFile)), `${JSON.stringify({ version: 2, documentId, section: section.index, claims: sectionClaims(documentId, section.index, base.evidenceId) }, null, 2)}\n`);
    section.complete = true;
  }
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sections = manifest.documents[0]!.sections;

  const before = await treeDigest(base.workdir);
  const { findings } = await auditRun(runDir);
  assert.deepEqual(findings.filter((finding) => /section .* file is missing/.test(finding.message)), [],
    "audit read the sections through the path run.json records instead of through --run");
  await assembleRun(runDir);
  // `writeReportCompanions` and the `metrics.claims` total both walk the claims sidecars; a re-checkpoint of
  // one section recomputes the total, which can only reach the full count if all of them resolve under --run.
  await checkpointSection(runDir, documentId, 1, sectionText(sections[0]!.title, 1, base.evidenceId), sectionClaims(documentId, 1, base.evidenceId));
  assert.equal((await manifestOf(runDir)).metrics.claims, sections.length);
  const companion = JSON.parse(await readFile(join(runDir, "reports", "companions", `${documentId}.claims.json`), "utf8")) as { sections: unknown[] };
  assert.equal(companion.sections.length, sections.length);
  assert.deepEqual(changes(before, await treeDigest(base.workdir)), [],
    "an operation on the relocated run wrote into the location run.json records, splitting the run in two");
  for (const command of ["assemble", "audit", "checkpoint"]) exercised.add(command);
});

test("relocated run: resume rewrites the copy's manifest", async () => {
  const base = await authoringBase();
  const runDir = await onRelocatedRun(base, ["resume"], async (dir) => {
    const manifest = await manifestOf(dir);
    manifest.state = "failed";
    await writeFile(join(dir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const { next } = await resumeRun(dir);
    assert.ok(next.length > 0);
  });
  assert.equal((await manifestOf(runDir)).state, "authoring");
});

// --- the investigation commands ------------------------------------------------------------------------

test("relocated run: freeze seals the copy's knowledge epoch", async () => {
  const base = await investigatingBase();
  const runDir = await onRelocatedRun(base, ["freeze"], async (dir) => {
    const result = await freezeRun(dir);
    assert.equal(result.frozen, true, result.findings.map((finding) => `${finding.level}: ${finding.message}`).join("\n"));
  });
  assert.ok(await exists(join(runDir, "knowledge.json")));
  assert.ok((await filesIn(join(runDir, "context", "authoring"))).length > 0);
  assert.equal(await exists(join(base.runDir, "knowledge.json")), false);
});

test("relocated run: plan, request-append, plan-packet, unit-cache-identity, unit-cache-admit and coverage-companion read and write the copy's plan directory", async () => {
  const base = await investigatingBase();
  const runDir = await onRelocatedRun(base, ["plan", "request-append", "plan-packet", "unit-cache-identity", "unit-cache-admit", "coverage-companion"], async (dir) => {
    assert.equal((await freezeRun(dir)).frozen, true);
    const packet = await renderPlannerPacketForRun(dir, { overBudget: "refuse", byteLimit: 524_288 });
    assert.ok(packet.markdown.includes("# Planner packet"));
    const result = await planRun(dir, { mode: "fixture" }, { kind: "record" });
    assert.equal(result.runDir, dir);
    // R6a's identity reading is read-only, and it reads the COPY's plan: an identity computed from the recorded
    // location would be the identity of a plan this run no longer holds.
    const identities = await loadRunUnitIdentities(dir, { kind: "model-free", generator: "relocation-fixture" });
    assert.deepEqual(identities.rows.map(rowUnitId).sort(), result.artifacts.planCatalog.units.map((unit) => unit.unitId).sort());
    // R6b's admission decides from the COPY's plan and the COPY's unit ledger. Read-only mode is what belongs here:
    // the writing half of an admission is `draft` and `collect`, each with its own relocation fixture above.
    const admission = await planUnitAdmission(dir, { kind: "model-free", generator: "relocation-fixture" });
    assert.deepEqual(admission.intents.map((intent) => intent.unit.unitId).sort(), result.artifacts.planCatalog.units.map((unit) => unit.unitId).sort());
    assert.equal(admission.planCatalogDigest, planCatalogDigest(result.artifacts.planCatalog));
    assert.match(admission.candidateStatement, /^0 prior verified units: this run's unit ledger records no collected unit at all/);
    // R7a's coverage companion is read-only and reads the COPY's ledgers: every path it publishes is run-relative,
    // so a companion computed from the recorded location would be a coverage statement about another directory.
    const companion = await loadCoverageStateFacts(dir);
    assert.equal(companion.facts.runId, result.artifacts.planCatalog.runId);
    assert.ok(companion.readPaths.every((path) => !path.startsWith("/")), `run-relative only: ${companion.readPaths.join(", ")}`);
    assert.ok(companion.readPaths.includes("plan/catalog.json"), companion.readPaths.join(", "));
    assert.ok(renderCoverageCompanion(companion.facts).startsWith("# Coverage companion"));
    // The append door and the revision that follows it: both resolve `plan/requests.json` and `plan/revisions/`
    // from --run, so an appended row and an archived revision land in the COPY.
    const appended = await appendReportRequest(dir, {
      documentId: plannedDocumentId("overview", "engineering", null),
      kind: "overview", audience: "engineering", featureKey: null, detailLevel: "standard", language: "zh-CN"
    });
    assert.equal(appended.path, join(dir, "plan", "requests.json"));
    const revised = await planRun(dir, { mode: "fixture" }, { kind: "revise", reason: "the relocation fixture appended a second audience" });
    assert.equal(revised.revision.planRevision, 1);
    assert.equal(revised.revision.previousPlanCatalogDigest, planCatalogDigest(result.artifacts.planCatalog));
    assert.deepEqual(revised.revision.archive, planRevisionArchive(dir, 0, 0));
  });
  for (const relative of [
    "plan/topics.json", "plan/catalog.json", "plan/dag.json", "plan/requests.json",
    "plan/revisions/epoch-0/revision-0/catalog.json", "plan/revisions/epoch-0/revision-0/dag.json"
  ]) {
    assert.ok(await exists(join(runDir, relative)), `${relative} must land in the copy`);
    if (relative === "plan/requests.json") continue; // prepare wrote it before the copy; what matters is where the append landed
    assert.equal(await exists(join(base.runDir, relative)), false, `${relative} must not land in the recorded location`);
  }
  assert.equal((await readReportRequests(runDir)).requests.length, 2, "the appended row is in the copy");
  assert.equal((await readReportRequests(base.runDir)).requests.length, 1, "and not in the recorded location");
});

test("relocated run: source and search append evidence to the copy", async () => {
  const base = await investigatingBase();
  const runDir = await onRelocatedRun(base, ["source", "search"], async (dir) => {
    await addSourceEvidence(dir, "src/server.ts", 1, 3, "relocation fixture");
    await searchSourceEvidence(dir, ["leave"], "relocation fixture", {});
  });
  const before = (await manifestOf(base.runDir)).metrics;
  const after = (await manifestOf(runDir)).metrics;
  assert.equal(after.sourceWindows, before.sourceWindows + 1);
  assert.equal(after.sourceSearches, before.sourceSearches + 1);
});

test("relocated run: checklist, workitem and trace update the copy's ledger", async () => {
  const base = await investigatingBase();
  const plan = JSON.parse(await readFile(join(base.runDir, "workitems.json"), "utf8")) as { items: Array<{ id: string }> };
  const itemId = plan.items[0]!.id;
  const runDir = await onRelocatedRun(base, ["checklist", "workitem", "trace"], async (dir) => {
    await updateChecklist(dir, [{ id: itemId, verdict: "not-applicable", material: false, reason: "relocation fixture" }]);
    await updateWorkItems(dir, [{ id: itemId, status: "not-applicable", material: false, reason: "relocation fixture" }]);
    await updateTraces(dir, [{
      id: "T-relocation", title: "relocation fixture", type: "business-flow", status: "verified",
      confidence: "high", documentIds: [base.documentId], steps: [], createdAt: new Date().toISOString()
    }]);
  });
  const traces = JSON.parse(await readFile(join(runDir, "traces.json"), "utf8")) as { traces: Array<{ id: string }> };
  assert.ok(traces.traces.some((trace) => trace.id === "T-relocation"));
});

// --- the read-only run-scoped commands ------------------------------------------------------------------

test("relocated run: claims, status and reading read the copy without touching the recorded location", async () => {
  const base = await investigatingBase();
  const runId = (await manifestOf(base.runDir)).id;
  await onRelocatedRun(base, ["claims", "status", "reading"], async (dir) => {
    const scaffold = await scaffoldClaims(dir, base.documentId, 1, "## 一\n\n一句实质陈述。\n");
    assert.equal(scaffold.documentId, base.documentId);
    assert.equal((await runStatus(dir) as { id: string }).id, runId);
    assert.ok((await readingCheck(dir)).report.length > 0);
  });
});

// --- archived runs: the record keeps working exactly as it did ------------------------------------------

test("a run that has not moved resolves to the very paths its manifest records", async () => {
  const base = await investigatingBase();
  const manifest = await manifestOf(base.runDir);
  for (const document of manifest.documents) {
    for (const section of document.sections) {
      const resolved = sectionPaths(base.runDir, document.id, section);
      assert.equal(resolved.file, section.file);
      assert.equal(resolved.claimsFile, section.claimsFile);
    }
  }
});

// The stem is content, not location: taking it as recorded is what keeps an archived run whose sections are
// named `NN.md` — the scheme before `NN-<slug>` — resolving to the files that are actually on its disk.
test("a grandfathered NN stem still resolves, relocated or not", () => {
  const recorded = { file: "/old/runs/R/sections/overview-product/01.md", claimsFile: "/old/runs/R/claims/overview-product/01.json" };
  assert.deepEqual(sectionPaths("/new/runs/R", "overview-product", recorded), {
    file: "/new/runs/R/sections/overview-product/01.md",
    claimsFile: "/new/runs/R/claims/overview-product/01.json"
  });
  assert.deepEqual(sectionPaths("/old/runs/R", "overview-product", recorded), recorded);
});

test("a recorded value that names no file is refused rather than rebased outside the run", () => {
  assert.throws(() => sectionPaths("/new/runs/R", "overview-product", { file: "/old/runs/R/sections/overview-product/..", claimsFile: "x.json" }), /records no section file name/);
  assert.throws(() => sectionPaths("/new/runs/R", "overview-product", { file: "x.md", claimsFile: "" }), /records no claims file name/);
});

// --- totality: no run-scoped command may go uncovered ---------------------------------------------------

/** The `--run`-taking commands, read out of the CLI's own switch so the list cannot silently fall behind. */
function runScopedCommands(cli: string): string[] {
  const labels = [...cli.matchAll(/^\s*case "([a-z-]+)":/gm)];
  const commands = new Set<string>();
  for (const [index, label] of labels.entries()) {
    const body = cli.slice(label.index!, labels[index + 1]?.index ?? cli.length);
    if (body.includes('.run, "--run"')) commands.add(label[1]!);
  }
  return [...commands].sort();
}

test("relocated run: every run-scoped CLI command is covered by a relocation fixture", async () => {
  const declared = runScopedCommands(await readFile(resolve("src/cli.ts"), "utf8"));
  assert.ok(declared.length >= 16, `expected the CLI to expose the known run-scoped commands, parsed: ${declared.join(", ")}`);
  assert.deepEqual([...exercised].sort(), declared,
    "a run-scoped command has no relocation fixture; every command that resolves a path inside the run must resolve it from --run");
});
