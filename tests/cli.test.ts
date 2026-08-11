import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { EvidenceItem, ReportRequest, SectionClaim } from "../src/types.ts";
import { assembleRun, checkpointSection, prepareRun, updateChecklist } from "../src/run.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

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

async function sourceEvidenceId(runDir: string): Promise<string> {
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  return catalog.evidence.find((item) => item.kind === "source")?.id ?? catalog.evidence[0].id;
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

test("audit CLI exits non-zero on errors and zero after complete assurance", async () => {
  const { runDir, manifest } = await prepareRun(await request());
  const id = await sourceEvidenceId(runDir);
  const document = manifest.documents[0];

  // Freeze-before-authoring order (assurance v3): dispose the checklist and freeze before any authoring.
  const search = await cli(["search", "--run", runDir, "--terms", "__excavator_no_such_fixture_marker__", "--reason", "complete checklist search receipt", "--max-results", "10"]);
  assert.equal(search.code, 0, search.stderr || search.stdout);
  const searchId = JSON.parse(search.stdout).evidence.id;
  const checklist = JSON.parse(await readFile(join(runDir, "checklist.json"), "utf8")) as { items: Array<{ id: string }> };
  await updateChecklist(runDir, checklist.items.map((item) => ({
    id: item.id,
    verdict: "searched-not-found" as const,
    material: false,
    evidenceIds: [searchId],
    searchScope: "all candidate source files in the immutable synthetic fixture snapshot"
  })));
  const frozen = await cli(["freeze", "--run", runDir]);
  assert.equal(frozen.code, 0, frozen.stderr || frozen.stdout);

  // Authoring the sections without claims leaves the run un-auditable: the audit CLI exits non-zero.
  for (const section of document.sections) await checkpointSection(runDir, document.id, section.index, text(section.title, id));
  await assembleRun(runDir);
  const failed = await cli(["audit", "--run", runDir]);
  assert.equal(failed.code, 1, failed.stderr || failed.stdout);

  // Re-checkpoint each section with its claims; the frozen, fully-authored run now audits clean.
  for (const section of document.sections) await checkpointSection(runDir, document.id, section.index, text(section.title, id), claims(section.index, id));
  await assembleRun(runDir);
  const passed = await cli(["audit", "--run", runDir]);
  assert.equal(passed.code, 0, passed.stderr || passed.stdout);
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

test("claims scaffold CLI emits a claims skeleton from section markdown", async () => {
  const { runDir, manifest } = await prepareRun(await request());
  const document = manifest.documents[0];
  const sectionFile = join(await tempDir(), "section.md");
  await writeFile(sectionFile, "## Overview\n\nThe system validates each incoming request before persistence.\n\n| Component | Responsibility |\n| --- | --- |\n| Authentication middleware | Rejects unauthenticated requests |\n");
  const result = await cli(["claims", "scaffold", "--run", runDir, "--document", document.id, "--section", "1", "--file", sectionFile]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout) as { documentId: string; section: number; claims: SectionClaim[] };
  assert.equal(parsed.documentId, document.id);
  assert.equal(parsed.section, 1);
  assert.ok(parsed.claims.length >= 3, result.stdout);
  for (const claim of parsed.claims) {
    assert.equal(claim.marker, "fact");
    assert.deepEqual(claim.evidenceIds, []);
  }
});

test("subcommand --help prints usage and does not execute", async () => {
  // A new-style subcommand and an existing command both resolve to their own usage.
  const scaffold = await cli(["claims", "scaffold", "--help"]);
  assert.equal(scaffold.code, 0, scaffold.stderr || scaffold.stdout);
  for (const flag of ["--run", "--document", "--section", "--file"]) assert.match(scaffold.stdout, new RegExp(flag));
  // Not executed: no error JSON is emitted for the missing required flags.
  assert.doesNotMatch(scaffold.stderr, /Missing|"error"/);

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
