import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";
import type { ReportRequest, SectionClaim } from "../src/base/types.ts";
import { prepareRun } from "../src/run/run.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";
import { claimFor, materialisedRun, unitDraftWithClaims } from "./unit-grounding-fixture.ts";

async function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/cli.ts", ...args], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((done) => child.once("exit", done));
  return { code, stdout, stderr };
}

async function request(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return {
    target,
    codegraph,
    workdir,
    language: "en-US",
    overviewAudiences: ["product"],
    features: [],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 30, maxSourceWindows: 30, maxSourceCharacters: 80_000, maxFiles: 10_000, maxFeatureNodes: 60, maxExpansionDepth: 2 }
  };
}

function text(title: string, evidenceId: string): string {
  return `## ${title}\n\nThis section describes the current implementation. \`fact\`\n\n**What this means** It establishes context for the following sections. \`inferred\`\n\n<details>\n<summary>Evidence</summary>\n\n- ${evidenceId}\n\n</details>\n`;
}

function claims(index: number, evidenceId: string): SectionClaim[] {
  return [
    { id: `claim-${index}-fact`, marker: "fact", statement: "This section describes the current implementation.", evidenceIds: [evidenceId] },
    { id: `claim-${index}-meaning`, marker: "inferred", statement: "It establishes context for the following sections.", evidenceIds: [evidenceId] }
  ];
}

test("the audience parser accepts prd but the overview command rejects it (feature-only)", async () => {
  // prd is a valid audience the parser accepts; the Core guard rejects it only for overviews. Reaching the
  // "feature-only" guard (not an "Invalid audience" parse error) proves both: prd parsed, overview refused.
  const target = resolve("tests/fixtures/sample-target");
  const result = await cli(["overview", "--target", target, "--audience", "prd", "--no-codegraph"]);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /feature-only/);
  assert.doesNotMatch(result.stderr, /Invalid audience/);
});

test("search CLI records a reusable source-search receipt", async () => {
  const { runDir } = await prepareRun(await request());
  const first = await cli(["search", "--run", runDir, "--terms", "Leave requests", "--reason", "locate UI text", "--max-results", "10"]);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const parsed = JSON.parse(first.stdout);
  assert.match(parsed.evidence.id, /^SEARCH-/);
  assert.equal(parsed.cacheHit, false);
  const second = await cli(["search", "--run", runDir, "--terms", "Leave requests", "--reason", "locate UI text", "--max-results", "10"]);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.equal(JSON.parse(second.stdout).cacheHit, true);
});

/**
 * `audit`'s exit code, on the unit keying.
 *
 * The section keying's version of this is the first test in this file. The unit arm reaches the same contract by a
 * different door: `collect` refuses a unit whose claims leave a material obligation ungrounded, and the refused
 * draft's artifacts stay on disk — so `audit --units` is exactly the command an operator runs next to see why, and
 * its exit code has to say so without anyone parsing the reading. The corrected draft then collects and the same
 * command exits 0, which is what makes the first half a statement about the verdict rather than about the command.
 */
test("audit --units exits non-zero on a violating written unit and zero once the corrected draft is collected", async () => {
  const materialised = await materialisedRun();
  const unitId = materialised.view.collectionOrder.find((id) => id.endsWith("::leaf::work-item-dimension"));
  assert.ok(unitId, "the materialised run must have a work-item-dimension leaf");

  // The wrong draft: both obligations linked, neither grounded the way its determination requires.
  const wrong: SectionClaim[] = [
    claimFor("C-found", materialised.foundWorkItemId, { evidenceIds: [] }),
    claimFor("C-unresolved", materialised.unresolvedWorkItemId, { marker: "fact" })
  ];
  await draftUnit(materialised.runDir, await unitDraftWithClaims(materialised, unitId, wrong));
  await assert.rejects(() => collectUnits(materialised.runDir), /cannot be collected: violations:/);

  const failed = await cli(["audit", "--run", materialised.runDir, "--units"]);
  assert.equal(failed.code, 1, failed.stderr || failed.stdout);
  const failedReading = JSON.parse(failed.stdout) as { units: Array<{ unitId: string; verdict: { conclusion: string } }> };
  assert.equal(failedReading.units.find((row) => row.unitId === unitId)?.verdict.conclusion, "violations");

  // The corrected draft, through the same two commands: collect records it and the exit code goes back to 0.
  const right: SectionClaim[] = [
    claimFor("C-found", materialised.foundWorkItemId, { evidenceIds: [materialised.foundEvidenceId] }),
    claimFor("C-unresolved", materialised.unresolvedWorkItemId, { marker: "unavailable" })
  ];
  await draftUnit(materialised.runDir, await unitDraftWithClaims(materialised, unitId, right));
  assert.deepEqual((await collectUnits(materialised.runDir)).collected.map((receipt) => receipt.unitId), [unitId]);
  const passed = await cli(["audit", "--run", materialised.runDir, "--units"]);
  assert.equal(passed.code, 0, passed.stderr || passed.stdout);
  // The POSITIVE conclusion, not "anything but violations": a regression that dropped the corrected unit from
  // the reading altogether would leave an absent row and an exit code of 0, and a `notEqual` would pass on it.
  const passedReading = JSON.parse(passed.stdout) as { units: Array<{ unitId: string; verdict: { conclusion: string } }> };
  assert.equal(passedReading.units.find((row) => row.unitId === unitId)?.verdict.conclusion, "complete");
});

/**
 * The retired section arms, as REFUSALS rather than silent fallthroughs.
 *
 * Every one of these invocations used to write: `begin` moved `manifest.state` and stamped `startedAt`,
 * `checkpoint`/`draft` wrote a section and its claims, `collect`/`assemble` rewrote the manifest. So the property
 * under test is not the wording — it is that the command line an operator still has in shell history now changes
 * nothing on disk. A future edit that restored any arm, or that made `--units` optional again, would write here,
 * and `run.json` is the witness those arms all touched.
 */
test("the retired section arms are named refusals that write nothing", async () => {
  const { runDir, manifest } = await prepareRun(await request());
  const runJsonPath = join(runDir, "run.json");
  const before = await readFile(runJsonPath, "utf8");
  const documentId = manifest.documents[0].id;
  // A REAL file, not a missing path: with a missing `--file` every arm would fail on the read no matter what the
  // dispatch did, and the "writes nothing" half of this test would be satisfied for the wrong reason.
  const sectionFile = join(await tempDir(), "section.md");
  await writeFile(sectionFile, `## ${manifest.documents[0].sections[0].title}\n\nThe system records each incoming request. \`fact\`\n`);

  // Retired outright: the command is gone from dispatch, so it cannot be reached by any flag combination.
  for (const gone of [["begin", "--run", runDir, "--document", documentId], ["claims", "scaffold", "--run", runDir]]) {
    const result = await cli(gone);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`Unknown command: ${gone[0]}`));
  }

  // The section KEYING is retired on the two per-unit writers: the refusal names the keying, not just the flag,
  // because an operator repeating an old command needs to be told the keying went away.
  for (const command of ["checkpoint", "draft"]) {
    const keyed = await cli([command, "--run", runDir, "--document", documentId, "--section", "1", "--file", sectionFile]);
    assert.equal(keyed.code, 1, keyed.stdout);
    assert.match(keyed.stderr, new RegExp(`excavator ${command} no longer takes --document <id> --section <n>`));
    // And with no keying at all it still names the flag it needs, rather than the one that went away.
    const bare = await cli([command, "--run", runDir, "--file", sectionFile]);
    assert.equal(bare.code, 1, bare.stdout);
    assert.match(bare.stderr, new RegExp(`excavator ${command} requires --unit <id>`));
  }

  // The run-wide arms: `--units` is required because there is no second arm to fall back to.
  for (const command of ["collect", "resume", "assemble"]) {
    const bare = await cli([command, "--run", runDir]);
    assert.equal(bare.code, 1, bare.stdout);
    assert.match(bare.stderr, new RegExp(`excavator ${command} requires --units`));
  }

  // Nothing was written by any of the seven refusals.
  assert.equal(await readFile(runJsonPath, "utf8"), before, "a refused command rewrote run.json");
  assert.deepEqual(await readdir(join(runDir, "sections", documentId)).catch(() => []), [], "a refused command wrote a section");
  assert.deepEqual(await readdir(join(runDir, "reports")), [], "a refused command wrote a report");
});

test("subcommand --help prints usage and does not execute", async () => {
  // A subcommand resolves to its own usage page rather than falling back to the bare command's.
  const build = await cli(["codegraph", "build", "--help"]);
  assert.equal(build.code, 0, build.stderr || build.stdout);
  assert.match(build.stdout, /^Excavator codegraph build$/m);
  assert.match(build.stdout, /--target/);
  assert.doesNotMatch(build.stderr, /Missing|"error"/);

  // -h short flag and no execution: a required flag is absent but no "Missing" error is raised.
  const audit = await cli(["audit", "-h"]);
  assert.equal(audit.code, 0, audit.stderr || audit.stdout);
  assert.match(audit.stdout, /--run/);
  assert.doesNotMatch(audit.stderr, /Missing|"error"/);
  assert.doesNotMatch(audit.stdout, /Missing/);
});

test("a flag value equal to -h does not trigger help interception", async () => {
  const { runDir } = await prepareRun(await request());
  // "-h" here is the VALUE of --query, not a help flag: the search must actually run.
  const result = await cli(["search", "--run", runDir, "--query", "-h", "--reason", "value not help", "--max-results", "5"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.evidence.id, /^SEARCH-/);
});

test("regex search query preserves commas inside quantifiers", async () => {
  const { runDir } = await prepareRun(await request());
  const result = await cli(["search", "--run", runDir, "--query", "Leave.{0,20}requests", "--regex", "--case-sensitive", "--reason", "locate exact UI text", "--max-results", "10"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.terms, ["Leave.{0,20}requests"]);
  assert.ok(parsed.matches.some((match: { path: string }) => match.path.endsWith("LeavePanel.vue")));
});

/**
 * The unit keying is an explicit switch, so the two ways of getting it wrong are refusals rather than silent
 * fallbacks: the retired section flags carried along beside `--unit`, and `--unit <id>` on a command that is
 * run-wide. A missing letter must not quietly run something else instead.
 */
test("the unit switch is explicit: the retired section flags, and --unit on a run-wide command, are refused", async () => {
  const { runDir } = await prepareRun(await request());
  for (const command of ["draft", "checkpoint"]) {
    const both = await cli([command, "--run", runDir, "--unit", "u::1", "--document", "overview-product", "--section", "1", "--file", "x.md"]);
    assert.equal(both.code, 1);
    assert.match(both.stderr, new RegExp(`excavator ${command} no longer takes --document <id> --section <n>`));
  }
  for (const command of ["collect", "status", "resume"]) {
    const slipped = await cli([command, "--run", runDir, "--unit", "u::1"]);
    assert.equal(slipped.code, 1);
    assert.match(slipped.stderr, new RegExp(`excavator ${command} takes --units \\(no id\\): it is run-wide over every planned unit`));
    // `parseArgs` swallows the next token as a flag's value, so `--units 1` must be refused rather than read as
    // absent - otherwise one stray token silently runs the section barrier instead.
    const valued = await cli([command, "--run", runDir, "--units", "1"]);
    assert.equal(valued.code, 1);
    assert.match(valued.stderr, new RegExp(`excavator ${command} takes --units as a bare flag`));
    assert.match(valued.stderr, /is not a value it accepts/);
  }
  // And with neither flag, the section path runs exactly as it did.
  const sections = await cli(["status", "--run", runDir]);
  assert.equal(sections.code, 0);
  assert.match(sections.stdout, /"documents"/);
});
