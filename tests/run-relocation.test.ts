import test from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ReportRequest, RunManifest } from "../src/base/types.ts";
import {
  addSourceEvidence, auditRun, freezeRun, prepareRun,
  readingCheck, runStatus, searchSourceEvidence, updateChecklist, updateTraces,
  updateWorkItems
} from "../src/run/run.ts";
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
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { checkRunConsistency } from "../src/report/unit-consistency-source.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { readUnitGroundingForRun } from "../src/report/unit-grounding-reading.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import { resumeUnits, unitStatus } from "../src/report/unit-status.ts";
import { assembleUnits } from "../src/run/stages/unit-assemble-stage.ts";
import { planViewOf, unitDraftFor, type PlannedRun } from "./unit-fixture.ts";

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

/** A frozen, planned run: the unit authoring commands can all run against it. (`begin` and the section
 *  checkpoint both retired with 57B-480; nothing left here reads `documents[].startedAt`.) */
async function buildAuthoring(): Promise<Base> {
  const base = await buildInvestigating();
  assert.equal((await freezeRun(base.runDir)).frozen, true);
  await installFixturePlan(base.runDir);
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

async function filesIn(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}

// --- the investigation commands ------------------------------------------------------------------------

test("relocated run: freeze seals the copy's knowledge epoch", async () => {
  const base = await investigatingBase();
  const runDir = await onRelocatedRun(base, ["freeze"], async (dir) => {
    const result = await freezeRun(dir);
    assert.equal(result.frozen, true, result.findings.map((finding) => `${finding.level}: ${finding.message}`).join("\n"));
  });
  assert.ok(await exists(join(runDir, "knowledge.json")));
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

/**
 * The unit path's read-only checker, on a run that has been moved.
 *
 * It is the sharpest read-side fixture in this file, because the checker refuses unless the ASSEMBLED deliverable
 * on disk is the one the plan and the collected units produce. Reading either half through the recorded location
 * therefore cannot merely look fine: units read from the original with a document read from the copy would make
 * the comparison fail, and a document read from the original would not exist at all.
 */
test("relocated run: unit-consistency checks the copy's own assembled deliverable", async () => {
  const base = await authoringBase();
  const runDir = await onRelocatedRun(base, ["unit-consistency"], async (dir) => {
    for (const unitId of (await planViewOf(dir)).collectionOrder) {
      const run = { runDir: dir, workdir: base.workdir, manifest: await manifestOf(dir), evidenceId: base.evidenceId, view: await planViewOf(dir) };
      await checkpointUnit(dir, await unitDraftFor(run, unitId));
    }
    await assembleUnits(dir, "write");
    const reading = await checkRunConsistency(dir);
    assert.equal(reading.runId, (await manifestOf(dir)).id);
    assert.deepEqual(reading.result.findings, [], "the canned drafts are clean, so a finding here would be the fixture's own defect");
    assert.deepEqual(reading.repair.targets, []);
    assert.equal(reading.preconditions.length, 5);
    assert.ok(reading.readPaths.every((path) => !path.startsWith("/")), `run-relative only: ${reading.readPaths.join(", ")}`);
    assert.ok(reading.readPaths.some((path) => path.endsWith("/summary.json")), reading.readPaths.join(", "));
  });
  assert.ok(await exists(join(runDir, "units", "collected.json")));
  assert.equal(await exists(join(base.runDir, "units")), false, "no unit artifact may land in the recorded location");
});

// --- the same commands, keyed on a unit ---------------------------------------------------------------
//
// `exercised` keys on the COMMAND, and `checkpoint`, `draft`, `collect`, `assemble`, `audit`, `resume` and `status`
// each carry two arms: the section keying above, and the `--unit`/`--units` keying below. Only the section arm was
// fixtured here, so the totality check was satisfied by a command whose unit arm nobody had moved. These four
// fixtures give every surviving arm its own relocated run, on the same rule: operate on the copy, and the recorded
// location must be byte-for-byte what it was.

/** One `PlannedRun` view of the relocated copy, rebuilt per call because collecting a unit changes it. */
async function relocatedPlannedRun(base: Base, dir: string): Promise<PlannedRun> {
  return { runDir: dir, workdir: base.workdir, manifest: await manifestOf(dir), evidenceId: base.evidenceId, view: await planViewOf(dir) };
}

test("relocated run: checkpoint --unit writes the unit's three artifacts and the ledger into the copy", async () => {
  const base = await authoringBase();
  // First in collection order, so it is a childless unit: nothing has to be collected before it.
  const firstUnitId = (await planViewOf(base.runDir)).collectionOrder[0]!;
  const runDir = await onRelocatedRun(base, ["checkpoint"], async (dir) => {
    const result = await checkpointUnit(dir, await unitDraftFor(await relocatedPlannedRun(base, dir), firstUnitId));
    assert.equal(result.receipt.unitId, firstUnitId);
    assert.deepEqual(result.collected.collected.map((receipt) => receipt.unitId), [firstUnitId]);
  });

  // The content, the claims, the summary and the collect-written ledger are all on the same side.
  const paths = unitPaths(runDir, firstUnitId);
  for (const path of [paths.content, paths.claims, paths.summary]) assert.ok(await exists(path), path);
  assert.ok(await exists(join(runDir, "units", "collected.json")));
  assert.equal(await exists(paths.receipt), false, "checkpoint is draft plus collect, so the receipt is consumed in the copy");
  // And the recorded location has no unit path at all.
  assert.equal(await exists(join(base.runDir, "units")), false);
});

test("relocated run: draft --unit and collect --units keep the drafted unit with the ledger that records it", async () => {
  const base = await authoringBase();
  const firstUnitId = (await planViewOf(base.runDir)).collectionOrder[0]!;
  const runDir = await onRelocatedRun(base, ["draft", "collect"], async (dir) => {
    const receipt = await draftUnit(dir, await unitDraftFor(await relocatedPlannedRun(base, dir), firstUnitId));
    assert.equal(receipt.unitId, firstUnitId);
    // Between the two commands the receipt is the only record, and it must be in the copy: `collect` is
    // fail-closed on the artifacts the receipt promises, so it can only succeed by resolving them from --run.
    assert.ok(await exists(unitPaths(dir, firstUnitId).receipt));
    assert.deepEqual((await collectUnits(dir)).collected.map((row) => row.unitId), [firstUnitId]);
  });
  assert.equal((await unitStatus(runDir)).census.collected, 1);
  assert.equal(await exists(join(base.runDir, "units")), false);
});

test("relocated run: assemble --units writes the copy's deliverable and audit --units grades the copy's units", async () => {
  const base = await authoringBase();
  const runDir = await onRelocatedRun(base, ["assemble", "audit"], async (dir) => {
    for (const unitId of (await planViewOf(dir)).collectionOrder) {
      await checkpointUnit(dir, await unitDraftFor(await relocatedPlannedRun(base, dir), unitId));
    }
    const view = await planViewOf(dir);
    const assembled = await assembleUnits(dir, "write");
    assert.equal(assembled.written, true);
    assert.deepEqual(assembled.documents.map((document) => document.documentId).sort(),
      [...new Set(view.units.map((unit) => unit.documentId))].sort(), "every planned document of the copy is assembled");
    // The read-only grounding rerun. Its denominator comes from the plan and its numerator from the collected
    // summaries, so a reading taken through the recorded location would have neither on this run's disk.
    const reading = await readUnitGroundingForRun(dir);
    assert.equal(reading.runId, (await manifestOf(dir)).id);
    assert.deepEqual(reading.units.filter((row) => row.verdict.conclusion === "violations"), [],
      "the canned drafts ground everything they reach, so a violation here would be the fixture's own defect");
  });
  const reports = await filesIn(join(runDir, "reports"));
  assert.ok(reports.some((name) => name.endsWith(".md")), reports.join(", "));
  assert.ok(await exists(join(runDir, "units", "collected.json")));
  assert.equal(await exists(join(base.runDir, "units")), false, "no unit artifact may land in the recorded location");
});

test("relocated run: resume --units and status --units read the copy's own unit ledger", async () => {
  const base = await authoringBase();
  const planned = await planViewOf(base.runDir);
  const runDir = await onRelocatedRun(base, ["resume", "status"], async (dir) => {
    const first = planned.collectionOrder[0]!;
    await checkpointUnit(dir, await unitDraftFor(await relocatedPlannedRun(base, dir), first));
    // Both readers are the run's own ledger read back. Reading through the recorded location would find an
    // untouched run and report every unit unwritten, which is a wrong answer rather than a refusal.
    const status = await unitStatus(dir);
    assert.equal(status.census.collected, 1);
    assert.equal(status.census.unwritten, planned.units.length - 1);
    // Positively constrained: an empty result would satisfy "does not offer the collected unit" too.
    const resumed = await resumeUnits(dir);
    assert.deepEqual([...resumed.pending].sort(), planned.collectionOrder.filter((unitId) => unitId !== first).sort());
    assert.notEqual(resumed.next, first);
    assert.ok(resumed.next, "one unit collected out of two leaves a next one");
  });
  // The recorded location never learned any of it: the same two readers there see a run with nothing written.
  assert.deepEqual((await unitStatus(base.runDir)).census, { collected: 0, drafted: 0, unwritten: planned.units.length });
  assert.deepEqual([...(await resumeUnits(base.runDir)).pending].sort(), [...planned.collectionOrder].sort());
  assert.equal((await unitStatus(runDir)).census.collected, 1);
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

test("relocated run: status and reading read the copy without touching the recorded location", async () => {
  const base = await investigatingBase();
  const runId = (await manifestOf(base.runDir)).id;
  await onRelocatedRun(base, ["status", "reading"], async (dir) => {
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
