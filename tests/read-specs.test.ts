import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactResult } from "../src/base/artifact-result.ts";
import { auditRun, prepareRun } from "../src/run/run.ts";
import { requireReadSpecs, type ReadSpecsArtifact } from "../src/workset/read-specs.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function prepare(): Promise<string> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return (await prepareRun({
    target, workdir, codegraph, language: "en-US", detailLevel: "standard", overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave"], audiences: ["engineering"] }], budgets: BUDGETS
  })).runDir;
}

test("ReadSpecs are pure bounded authorizations with no source body or evidence identity", async () => {
  const runDir = await prepare();
  const result = JSON.parse(await readFile(join(runDir, "workset", "read-specs.json"), "utf8")) as ArtifactResult<ReadSpecsArtifact>;
  assert.equal(result.status, "built");
  requireReadSpecs(result.value);
  assert.ok(result.value.specs.length > 0);
  assert.ok(result.value.specs.every((spec) => spec.budget.windows === 1 && spec.budget.requestedLines === spec.span.endLine - spec.span.startLine + 1));
  const serialized = JSON.stringify(result.value);
  assert.doesNotMatch(serialized, /"(?:content|sourceText|excerpt|evidenceId|evidenceIds)"/i);
  assert.ok(result.value.specs.every((spec) => Object.keys(spec).sort().join(",") === "budget,featureKey,id,path,reason,span"));
});

test("layer 5 has no reader capability and the model receives only the bounded Markdown view", async () => {
  const source = await readFile(new URL("../src/workset/read-specs.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import .*?(?:SourceReader|evidenceFromWindow|sourceSearch)/m);
  assert.doesNotMatch(source, /\breadFile\s*\(/);
  const runDir = await prepare();
  const view = await readFile(join(runDir, "context", "workset.md"), "utf8");
  assert.match(view, /## Read authorizations/);
  assert.match(view, /Declared bound:/);
  assert.doesNotMatch(view, /read-specs\.json/);
});

test("the persisted validator rejects source text and evidence ids even if a future writer adds them", async () => {
  const runDir = await prepare();
  const result = JSON.parse(await readFile(join(runDir, "workset", "read-specs.json"), "utf8")) as ArtifactResult<ReadSpecsArtifact>;
  assert.equal(result.status, "built");
  assert.throws(() => requireReadSpecs({ ...result.value, specs: [{ ...result.value.specs[0], sourceText: "secret" }] }), /forbidden source\/evidence field/);
  assert.throws(() => requireReadSpecs({ ...result.value, specs: [{ ...result.value.specs[0], evidenceId: "E-1" }] }), /forbidden source\/evidence field/);
});

test("a current successful run cannot downgrade ReadSpecs to an Unavailable envelope", async () => {
  const runDir = await prepare();
  await writeFile(join(runDir, "workset", "read-specs.json"), JSON.stringify({ status: "unavailable", cause: "tampered", retryable: false }));
  const findings = (await auditRun(runDir)).findings;
  assert.ok(findings.some((finding) => finding.level === "error" && finding.message.includes("read-specs.json violates its authorization contract")));
});
