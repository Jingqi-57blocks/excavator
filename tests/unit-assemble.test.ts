/**
 * `assemble --units` over a REAL run: the fail-closed gates, the two modes, and the two worlds not touching.
 *
 * Every premise here is built by the real commands (`tests/unit-assembly-fixture.ts` runs plan -> draft -> collect
 * through `checkpointUnit`), because the properties worth asserting are properties of a run on disk:
 *
 *   * ALL OR NOTHING. A run with one unit uncollected is refused by name; a run whose units were collected against
 *     a superseded plan gets a DIFFERENT refusal naming the plan it was collected against, because the fix is
 *     different. Both are reached here by doing the thing that causes them, not by hand-editing a ledger.
 *   * THE PROMISE IS RE-CHECKED. Deleting a collected unit's `content.md` makes assemble refuse and name the unit;
 *     re-drafting and re-collecting it makes assemble succeed again. There is no state a lost file puts the run in
 *     for good.
 *   * TWO WORLDS, NO SHARED FILE. After assembling units, nothing the section path names exists. And a run whose
 *     section plan happens to name one of the unit path's targets is refused rather than overwritten.
 *   * IDEMPOTENT DELIVERABLE. A second `write` over an unchanged run moves no assembled byte. The timeline and
 *     `run.json` do move — that is the record of having produced it, not the deliverable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, relative, resolve } from "node:path";
import type { RunManifest } from "../src/base/types.ts";
import { readTimeline } from "../src/base/timeline.ts";
import { exists, sha256 } from "../src/base/util.ts";
import { reportFileName } from "../src/report/section-report-name.ts";
import { plannedDocumentId } from "../src/report/legacy-request-mapping.ts";
import { appendReportRequest } from "../src/report/report-requests-append.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { assembleUnits, assertNotConcurrentlyModified, UNIT_ASSEMBLE_MODES } from "../src/run/stages/unit-assemble-stage.ts";
import { unitAnchorId } from "../src/report/unit-assembly.ts";
import { UNIT_COVERAGE_COMPANION_PATH, unitDocumentCompanionPaths, unitDocumentReportPath } from "../src/report/unit-assembly-paths.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import type { UnitClaimsCompanion } from "../src/report/unit-companions.ts";
import { collectedRun, redraftUnit } from "./unit-assembly-fixture.ts";
import { manifestOf, planViewOf } from "./unit-fixture.ts";
import { tempDir } from "./helpers.ts";

const DOCUMENT_ID = "overview-product";

async function reportFiles(runDir: string): Promise<string[]> {
  const root = join(runDir, "reports");
  if (!await exists(root)) return [];
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(root, full).split("\\").join("/"));
    }
  };
  await walk(root);
  return out.sort();
}

async function readRunRelative(runDir: string, path: string): Promise<string> {
  return readFile(join(runDir, ...path.split("/")), "utf8");
}

async function cli(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/cli.ts", ...args], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((done) => child.once("exit", done));
  return { code, stdout, stderr };
}

test("write assembles exactly the unit path's files, and a second write moves no assembled byte", async () => {
  const run = await collectedRun();
  const first = await assembleUnits(run.runDir, "write");
  assert.equal(first.written, true);
  const companions = unitDocumentCompanionPaths(DOCUMENT_ID);
  assert.deepEqual(await reportFiles(run.runDir), [
    `companions/${DOCUMENT_ID}.unit-claims.json`,
    `companions/${DOCUMENT_ID}.unit-traces.json`,
    "companions/unit-coverage.md",
    `${DOCUMENT_ID}.md`
  ]);
  assert.deepEqual(first.documents.map((document) => document.path), [unitDocumentReportPath(DOCUMENT_ID)]);
  assert.equal(first.coverageCompanion.path, UNIT_COVERAGE_COMPANION_PATH);

  const before = new Map<string, string>();
  for (const path of [unitDocumentReportPath(DOCUMENT_ID), companions.claims, companions.traces, UNIT_COVERAGE_COMPANION_PATH]) {
    before.set(path, sha256(await readRunRelative(run.runDir, path)));
  }
  await assembleUnits(run.runDir, "write");
  for (const [path, digest] of before) {
    assert.equal(sha256(await readRunRelative(run.runDir, path)), digest, `${path} moved on the second assemble`);
  }
  // The record of having assembled DOES move: two events, one per write, in the one chain.
  const events = (await readTimeline(run.runDir)).filter((event) => event.action === "units.assembled");
  assert.equal(events.length, 2, "each assemble is one event in the append-only account");
  assert.deepEqual(events[0]!.data!.documents, [DOCUMENT_ID]);
});

test("nothing the section path names is written, and the section state machine is untouched", async () => {
  const run = await collectedRun();
  const manifest = await manifestOf(run.runDir);
  const before = { state: manifest.state, claims: manifest.metrics.claims, sections: manifest.documents.map((document) => document.sections.map((section) => section.complete)) };
  await assembleUnits(run.runDir, "write");
  const after = await manifestOf(run.runDir);
  assert.equal(after.state, before.state, "assemble --units does not move the section state machine");
  assert.equal(after.metrics.claims, before.claims);
  assert.deepEqual(after.documents.map((document) => document.sections.map((section) => section.complete)), before.sections);
  for (const document of manifest.documents) {
    assert.equal(await exists(join(run.runDir, "reports", reportFileName(document))), false, `${reportFileName(document)} belongs to the section path`);
    assert.equal(await exists(join(run.runDir, "reports", "companions", `${document.id}.claims.json`)), false);
    assert.equal(await exists(join(run.runDir, "reports", "companions", `${document.id}.coverage.json`)), false);
  }
});

test("plan-only proves the assembly and writes nothing", async () => {
  const run = await collectedRun();
  const planned = await assembleUnits(run.runDir, "plan-only");
  assert.equal(planned.written, false);
  assert.deepEqual(await reportFiles(run.runDir), [], "plan-only may not create the deliverable");
  assert.equal((await readTimeline(run.runDir)).filter((event) => event.action === "units.assembled").length, 0);
  // Same loader, so the reading is a real statement about what `write` would produce, byte counts included.
  const written = await assembleUnits(run.runDir, "write");
  assert.deepEqual(
    written.documents.map((document) => [document.path, document.bytes, document.claimsCompanion.bytes, document.tracesCompanion.bytes]),
    planned.documents.map((document) => [document.path, document.bytes, document.claimsCompanion.bytes, document.tracesCompanion.bytes])
  );
  assert.equal(written.coverageCompanion.bytes, planned.coverageCompanion.bytes);
  assert.equal(Buffer.byteLength(await readRunRelative(run.runDir, written.documents[0]!.path), "utf8"), written.documents[0]!.bytes);
});

test("a unit that has not been collected is a named refusal, and collecting it clears it", async () => {
  // The all-or-nothing gate, reached by not finishing: the plan is recorded, nothing is drafted.
  const { plannedRun } = await import("./unit-fixture.ts");
  const run = await plannedRun();
  await assert.rejects(
    () => assembleUnits(run.runDir, "plan-only"),
    (error: Error) => {
      assert.match(error.message, /assembly is all-or-nothing per run/);
      assert.match(error.message, /unit\(s\) of this plan have not been collected/);
      for (const unitId of run.view.collectionOrder) assert.ok(error.message.includes(unitId), `${unitId} must be named`);
      return true;
    }
  );
  const collected = await collectedRun();
  await assert.doesNotReject(() => assembleUnits(collected.runDir, "plan-only"));
});

test("deleting a collected unit's content refuses by name, and re-collecting it assembles again", async () => {
  const run = await collectedRun();
  await assembleUnits(run.runDir, "write");
  const unitId = run.view.collectionOrder[0]!;
  const paths = unitPaths(run.runDir, unitId);
  await rm(paths.content);
  await assert.rejects(
    () => assembleUnits(run.runDir, "write"),
    (error: Error) => {
      assert.match(error.message, new RegExp(`The unit ledger row for ${JSON.stringify(unitId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} promises content that is not on disk`));
      assert.match(error.message, /Re-collect the unit before assembling; its ledger row is left in place\./);
      return true;
    }
  );
  // Recovery: nothing about the refusal is permanent. Re-drafting the unit puts the bytes and the row back.
  await redraftUnit(run, unitId, `## restored\n\n${unitId} restored.\n`);
  await assert.doesNotReject(() => assembleUnits(run.runDir, "write"));
  assert.ok((await readRunRelative(run.runDir, unitDocumentReportPath(DOCUMENT_ID))).includes(`${unitId} restored.`));
});

test("an edited collected unit refuses on the digest, not on absence", async () => {
  const run = await collectedRun();
  const paths = unitPaths(run.runDir, run.view.collectionOrder[0]!);
  await writeFile(paths.content, `${await readFile(paths.content, "utf8")}tampered\n`);
  await assert.rejects(() => assembleUnits(run.runDir, "plan-only"), /has content digesting to [0-9a-f]{64}, but its ledger row promises [0-9a-f]{64}/);
});

test("units collected against a superseded plan get the stale refusal, not the never-drafted one", async () => {
  const run = await collectedRun();
  const before = await assembleUnits(run.runDir, "plan-only");
  // The plan is perturbed the one supported way: a second audience is appended to the recorded request set, so the
  // revision genuinely supersedes something. `plan --revise` over an unchanged proposal is refused by name, which
  // is why this cannot be done by re-recording the same fixture plan.
  await appendReportRequest(run.runDir, { documentId: plannedDocumentId("overview", "engineering", null), kind: "overview", audience: "engineering", featureKey: null, detailLevel: "standard", language: "zh-CN" });
  await planRun(run.runDir, { mode: "fixture" }, { kind: "revise", reason: "R7b stale-plan fixture" });
  const revised = await planViewOf(run.runDir);
  assert.notEqual(revised.planCatalogDigest, before.planCatalogDigest, "the fixture must actually perturb the plan digest");
  await assert.rejects(
    () => assembleUnits(run.runDir, "plan-only"),
    (error: Error) => {
      // The revision leaves the run in BOTH states at once, and the refusal has to keep them apart: the product
      // document's units were written and are now stale; the appended engineering document's units never existed.
      // One merged sentence would send the operator to re-do work that is on disk, or to look for work that is not.
      const [missing, stale] = [
        error.message.split("unit(s) of this plan have not been collected: ")[1]!.split(";")[0]!,
        error.message.split("must be re-drafted against the recorded plan")[1]!
      ];
      assert.ok(stale.includes(revised.planCatalogDigest.slice(0, 16)), "the refusal names the plan now in force");
      assert.ok(stale.includes(before.planCatalogDigest.slice(0, 16)), "and the plan the rows were collected against");
      for (const unitId of run.view.collectionOrder) {
        assert.ok(stale.includes(unitId), `${unitId} was written and must be reported as stale, not as never drafted`);
        assert.ok(!missing.includes(unitId), `${unitId} is on disk and must not be listed as never collected`);
      }
      const appended = revised.collectionOrder.filter((unitId) => !run.view.byId.has(unitId));
      assert.ok(appended.length > 0, "the fixture must have added units, or the missing bucket proves nothing");
      for (const unitId of appended) assert.ok(missing.includes(unitId), `${unitId} is new and must be reported as never collected`);
      return true;
    }
  );
});

test("a target the section path already names is refused rather than overwritten", async () => {
  const run = await collectedRun();
  // A real request reaches this: `reportFileName` names a FEATURE document after its subject, so a feature called
  // "overview" at the product audience is `reports/overview-product.md` — the unit path's target for the product
  // overview document. Recorded here by adding that document to the manifest's section plan, which is what a
  // request naming both would have produced.
  const manifest = await manifestOf(run.runDir);
  const collided = { ...manifest.documents[0]!, id: "feature-overview-abcdef0123-product", kind: "feature" as const, subject: "overview" };
  assert.equal(reportFileName(collided), `${DOCUMENT_ID}.md`);
  manifest.documents = [...manifest.documents, collided];
  await writeFile(join(run.runDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    () => assembleUnits(run.runDir, "plan-only"),
    /Unit-path document "overview-product" would assemble into "reports\/overview-product\.md", which the section path already names for document "feature-overview-abcdef0123-product"/
  );
});

test("the assembled document's contents table matches the plan's units and every anchor it links to exists", async () => {
  const run = await collectedRun();
  await assembleUnits(run.runDir, "write");
  const markdown = await readRunRelative(run.runDir, unitDocumentReportPath(DOCUMENT_ID));
  const planned = run.view.collectionOrder.filter((unitId) => run.view.byId.get(unitId)!.documentId === DOCUMENT_ID);
  assert.ok(planned.length >= 2, `${planned.length} unit(s) is too few for a table to mean anything`);

  const rows = markdown.split("## Contents")[1]!.split("## Companions")[0]!.split("\n").filter((line) => /^\| \d+ \|/.test(line));
  assert.equal(rows.length, planned.length, `the table must have one row per planned unit:\n${markdown}`);
  for (const [index, unitId] of planned.entries()) {
    assert.ok(rows[index]!.includes(`(#${unitAnchorId(unitId)})`), `row ${index + 1} must link to ${unitId}`);
    assert.ok(markdown.includes(`<a id="${unitAnchorId(unitId)}"></a>`), `${unitId} must have an anchor`);
  }
  const emitted = new Set([...markdown.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1]!));
  for (const anchor of [...markdown.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]!)) {
    assert.ok(emitted.has(anchor), `link target #${anchor} resolves to nothing`);
  }
  // The unit prose is in the document, once per unit, and its front matter pins this run's epoch and plan.
  for (const unitId of planned) assert.equal(markdown.split(`${unitId} 记录当前状态。`).length - 1, 1, unitId);
  assert.ok(markdown.includes(`\nknowledgeEpoch: ${run.view.knowledgeEpoch}\n`));
  assert.ok(markdown.includes(`\nplanCatalogDigest: ${run.view.planCatalogDigest}\n`));
  assert.ok(markdown.includes(`\nrun: ${JSON.stringify(run.manifest.id)}\n`));
});

test("R7a's coverage account is placed beside the document, and its vacuous statements survive into it", async () => {
  const run = await collectedRun();
  await assembleUnits(run.runDir, "write");
  const coverage = await readRunRelative(run.runDir, UNIT_COVERAGE_COMPANION_PATH);
  assert.ok(coverage.startsWith("# Coverage companion (coverage-companion-v1)"));
  // The sample target mints no material obligation and no read obligation, so those denominators are EMPTY — and
  // the companion has to say `vacuous`, not "complete". That is 57B-449's rule reaching the assembled deliverable.
  assert.match(coverage, /## Material obligations: where the plan puts them\n\nvacuous \(ledger-empty\)/);
  assert.match(coverage, /## Read obligations: which have a source window\n\nvacuous \(ledger-empty\)/);
  // The two vacuous SOURCES stay distinguishable in the placed bytes.
  assert.ok(coverage.includes("`ledger-absent` (nobody can tell) and `ledger-empty` (this run genuinely"));
  assert.ok(!/\d+%/.test(coverage), "the coverage companion states no percentage");
  // And the document points at it rather than restating it.
  const markdown = await readRunRelative(run.runDir, unitDocumentReportPath(DOCUMENT_ID));
  assert.ok(markdown.includes(`coverageCompanion: ${JSON.stringify(UNIT_COVERAGE_COMPANION_PATH)}`));
  assert.ok(markdown.includes("This document states no coverage figure of its own."));
});

test("the claims companion keeps one row per (unit, claim) and names the run it belongs to", async () => {
  const run = await collectedRun();
  await assembleUnits(run.runDir, "write");
  const companion = JSON.parse(await readRunRelative(run.runDir, unitDocumentCompanionPaths(DOCUMENT_ID).claims)) as UnitClaimsCompanion;
  const planned = run.view.collectionOrder.filter((unitId) => run.view.byId.get(unitId)!.documentId === DOCUMENT_ID);
  assert.deepEqual(companion.units.map((row) => row.unitId), planned);
  assert.equal(companion.claims.length, planned.length, "the fixture writes one claim per unit");
  assert.deepEqual(companion.claims.map((row) => row.key).sort(), planned.map((unitId) => `${unitId}#C-${unitId}`).sort());
  assert.equal(companion.runId, run.manifest.id);
  assert.equal(companion.planCatalogDigest, run.view.planCatalogDigest);
});

test("a copied run assembles into the copy (57B-452), leaving the original byte-for-byte", async () => {
  const run = await collectedRun();
  const copy = join(await tempDir("excavator-assembly-copy-"), "run");
  await cp(run.runDir, copy, { recursive: true });
  const before = await treeDigest(run.runDir);
  await assembleUnits(copy, "write");
  assert.deepEqual([...(await treeDigest(run.runDir))].sort(), [...before].sort(), "the original run must not be written into");
  assert.ok(await exists(join(copy, "reports", `${DOCUMENT_ID}.md`)));
  // `prepare` already creates an empty `reports/`, so the property is "no assembled FILE landed here", not "no
  // directory exists" — an assertion on the directory would go green for the wrong reason.
  assert.deepEqual(await reportFiles(run.runDir), []);
});

test("the command takes --units as a bare flag and requires an explicit mode", async () => {
  const run = await collectedRun();
  assert.deepEqual([...UNIT_ASSEMBLE_MODES], ["plan-only", "write"]);
  const noMode = await cli(["assemble", "--run", run.runDir, "--units"]);
  assert.equal(noMode.code, 1);
  assert.match(noMode.stderr, /Missing --mode/);
  const badMode = await cli(["assemble", "--run", run.runDir, "--units", "--mode", "dry-run"]);
  assert.equal(badMode.code, 1);
  assert.match(badMode.stderr, /--mode .*dry-run.* is not one of: plan-only, write; assembling the unit path is an explicit act and there is no default mode/);
  const withId = await cli(["assemble", "--run", run.runDir, "--unit", "x", "--mode", "write"]);
  assert.equal(withId.code, 1);
  assert.match(withId.stderr, /excavator assemble takes --units \(no id\)/);
  const valued = await cli(["assemble", "--run", run.runDir, "--units", "1", "--mode", "write"]);
  assert.equal(valued.code, 1);
  assert.match(valued.stderr, /excavator assemble takes --units as a bare flag/);

  // A dropped `--units` must not silently run the SECTION assemble, which writes every section report and moves
  // `manifest.state`. Same slip class as the two `unitScoped` already refuses, one token further along.
  const sectionArm = await cli(["assemble", "--run", run.runDir, "--mode", "write"]);
  assert.equal(sectionArm.code, 1);
  assert.match(sectionArm.stderr, /excavator assemble takes --mode only together with --units/);
  assert.deepEqual(await reportFiles(run.runDir), [], "the refused section arm must not have written a report");

  const written = await cli(["assemble", "--run", run.runDir, "--units", "--mode", "write"]);
  assert.equal(written.code, 0, written.stderr);
  const reading = JSON.parse(written.stdout) as { mode: string; written: boolean; documents: readonly { documentId: string }[]; readPaths: readonly string[] };
  assert.equal(reading.mode, "write");
  assert.equal(reading.written, true);
  assert.deepEqual(reading.documents.map((document) => document.documentId), [DOCUMENT_ID]);
  // The published read set names the plan artifacts and the collected units, and never a section artifact.
  assert.ok(reading.readPaths.includes("plan/catalog.json"));
  assert.ok(reading.readPaths.includes("units/collected.json"));
  assert.ok(!reading.readPaths.some((path) => path.startsWith("sections/") || path.startsWith("prompts/")),
    `the unit path may not read the section world: ${reading.readPaths.join(", ")}`);
});

/** Every file of a tree, by digest, so "the original did not change" is a comparison and not a spot check. */
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

/** Kept honest: a manifest read here is the run's own bytes, not a cached object. */
export type { RunManifest };

test("the concurrency guard compares against a baseline taken before the load, and it fires", async () => {
  const run = await collectedRun();
  const runPath = join(run.runDir, "run.json");
  const before = (await manifestOf(run.runDir)).updatedAt;
  // The guard's own shape, made to fire: `assembleUnits` captures this baseline BEFORE `loadUnitAssembly` — which
  // re-validates the plan gate and reads every collected unit's three artifacts — so a `collect` landing during
  // that window is caught. A baseline taken after the load could only ever trip on a writer arriving between two
  // adjacent reads, which is to say never.
  await assert.doesNotReject(() => assertNotConcurrentlyModified(runPath, before));
  await assert.rejects(
    () => assertNotConcurrentlyModified(runPath, "1999-01-01T00:00:00.000Z"),
    /Run was modified concurrently during unit assemble \(run.json updatedAt changed\); rerun assemble after the concurrent command finishes\./
  );
  // And a write really does move it, so the baseline is a value that changes when the run changes.
  await assembleUnits(run.runDir, "write");
  assert.notEqual((await manifestOf(run.runDir)).updatedAt, before);
});
