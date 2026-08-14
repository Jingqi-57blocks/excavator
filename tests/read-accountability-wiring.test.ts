import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { KnowledgeArtifact, ReportRequest, RunManifest } from "../src/core/types.ts";
import { auditRun, freezeRun, prepareRun } from "../src/core/run.ts";
import { exists, sha256, stableJson, writeJson } from "../src/core/util.ts";
import { READ_OBLIGATIONS_VERSION } from "../src/assurance/read-obligations.ts";
import { READ_COVERAGE_VERSION } from "../src/assurance/read-coverage.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "./helpers.ts";

// Wiring-level regression for reading accountability. The RULES are unit-tested in
// read-accountability.test.ts; what matters here is that freeze actually FREEZES the denominator as a run
// artifact (so a later denominator change cannot move retroactively), that its digest lands in
// knowledge-v1, and that a run prepared before this generation is untouched.

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function featureRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: [], features: [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["product"] }], budgets: BUDGETS };
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

test("freeze writes the read-obligation denominator and residual, and pins the denominator digest in knowledge", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  await disposeAllWorkItems(runDir);
  const result = await freezeRun(runDir);
  assert.equal(result.frozen, true);

  const obligationsPath = join(runDir, "coverage", "read-obligations.json");
  const residualPath = join(runDir, "coverage", "read-residual.json");
  assert.ok(await exists(obligationsPath), "the denominator is frozen as a run artifact");
  assert.ok(await exists(residualPath), "the read residual is recorded at freeze");

  const obligations = await readJsonFile<{ version: string; obligations: unknown[]; summary: Record<string, number> }>(obligationsPath);
  assert.equal(obligations.version, READ_OBLIGATIONS_VERSION);
  assert.equal(obligations.summary.total, obligations.obligations.length);
  const residual = await readJsonFile<{ version: string; summary: Record<string, number> }>(residualPath);
  assert.equal(residual.version, READ_COVERAGE_VERSION);
  assert.equal(residual.summary.counted, obligations.summary.counted, "the residual reconciles exactly the counted denominator");

  const knowledge = await readJsonFile<KnowledgeArtifact>(join(runDir, "knowledge.json"));
  assert.equal(knowledge.readObligationsDigest, sha256(stableJson(obligations)), "knowledge pins WHICH obligations this run was accountable for");
});

test("a run prepared before generation 5 is grandfathered: no denominator, no read findings, no knowledge field", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  // Restamp exactly like a run prepared before this slice; the generation gate must then skip entirely.
  const manifest = await readJsonFile<RunManifest>(join(runDir, "run.json"));
  manifest.assuranceVersion = "assurance-v4-redaction-v4";
  await writeJson(join(runDir, "run.json"), manifest);

  await disposeAllWorkItems(runDir);
  const result = await freezeRun(runDir);
  assert.equal(result.frozen, true);
  assert.deepEqual(result.findings.filter((finding) => finding.document === "read-coverage"), [], "no reading rule fires on an older run");
  assert.equal(await exists(join(runDir, "coverage", "read-obligations.json")), false);
  const knowledge = await readJsonFile<KnowledgeArtifact>(join(runDir, "knowledge.json"));
  assert.equal(knowledge.readObligationsDigest, undefined);

  const audited = await auditRun(runDir);
  assert.deepEqual(audited.findings.filter((finding) => finding.document === "read-coverage"), [], "audit is self-gated on the frozen artifact existing");
});

test("audit rejects a denominator edited after freeze (the hard gate's own input cannot be weakened silently)", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  const obligationsPath = join(runDir, "coverage", "read-obligations.json");

  const clean = await auditRun(runDir);
  assert.deepEqual(clean.findings.filter((finding) => /denominator was changed after freeze/.test(finding.message)), []);

  const artifact = await readJsonFile<{ summary: Record<string, number> }>(obligationsPath);
  artifact.summary.counted = artifact.summary.counted + 1; // any edit at all must be caught
  await writeJson(obligationsPath, artifact);

  const tampered = await auditRun(runDir);
  const errors = tampered.findings.filter((finding) => finding.document === "read-coverage" && finding.level === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /does not match the read-obligation digest recorded at freeze/);
});

test("a scoped (single-document) audit reports findings but never rewrites the residual", async () => {
  const { runDir, manifest } = await prepareRun(await featureRequest());
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  await auditRun(runDir);
  const residualPath = join(runDir, "coverage", "read-residual.json");
  const before = await readFile(residualPath, "utf8");

  // A scoped audit sees only its own document's claims; persisting from it would shrink consumedBy and
  // inflate openedNotConsumed — the migration signal must not be corrupted by a partial view.
  await auditRun(runDir, { documentId: manifest.documents[0].id });
  assert.equal(await readFile(residualPath, "utf8"), before, "a scoped audit leaves the residual untouched");
});

test("audit reconciles against the frozen denominator and rewrites the residual byte-identically", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  const frozenDenominator = await readFile(join(runDir, "coverage", "read-obligations.json"), "utf8");

  await auditRun(runDir);
  const first = await readFile(join(runDir, "coverage", "read-residual.json"), "utf8");
  await auditRun(runDir);
  const second = await readFile(join(runDir, "coverage", "read-residual.json"), "utf8");
  assert.equal(first, second, "two audits of the same run produce a byte-identical residual");
  assert.equal(
    await readFile(join(runDir, "coverage", "read-obligations.json"), "utf8"),
    frozenDenominator,
    "audit never rewrites the frozen denominator",
  );
});
