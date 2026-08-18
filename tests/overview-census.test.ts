import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactResult } from "../src/base/artifact-result.ts";
import { stableJson } from "../src/base/util.ts";
import { countedRowSet, type FileLedger } from "../src/snapshot/file-ledger.ts";
import { buildOverviewCensus, overviewCensusResidual, OVERVIEW_CENSUS_VERSION, type OverviewCensusV2 } from "../src/workset/census.ts";
import { prepareRun } from "../src/run/run.ts";
import { copyFixture, tempDir } from "./helpers.ts";

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function prepare(): Promise<string> {
  return (await prepareRun({
    target: await copyFixture(), workdir: await tempDir(), language: "zh-CN", detailLevel: "standard",
    codegraphMode: "off", overviewAudiences: ["product"], features: [], budgets: BUDGETS
  })).runDir;
}

test("an overview-only, source-only run unconditionally writes a Built overview-census-v2", async () => {
  const runDir = await prepare();
  const result = JSON.parse(await readFile(join(runDir, "context", "overview-census.json"), "utf8")) as ArtifactResult<OverviewCensusV2>;
  assert.equal(result.status, "built");
  assert.equal(result.value.version, OVERVIEW_CENSUS_VERSION);
  assert.equal(result.value.identity.files.artifact, "ledger/files.json");
  assert.equal(result.value.identity.files.unitKind, "file");
  assert.ok(result.value.rows.length > 0);
  assert.equal(overviewCensusResidual(result.value).balanced, true);
  assert.ok(result.value.rows.every((row) => row.module && row.language && row.coverageDomain === "file" && row.unitKind === "file"));
});

test("overview regrouping preserves layer-1 counted, excluded and unexplained buckets exactly", async () => {
  const runDir = await prepare();
  const ledgerResult = JSON.parse(await readFile(join(runDir, "ledger", "files.json"), "utf8")) as ArtifactResult<FileLedger>;
  assert.equal(ledgerResult.status, "built");
  const census = buildOverviewCensus(ledgerResult.value, countedRowSet(ledgerResult.value));
  assert.deepEqual(census.summary, {
    total: ledgerResult.value.summary.total,
    counted: ledgerResult.value.summary.counted,
    excluded: ledgerResult.value.summary.excluded,
    unexplained: ledgerResult.value.summary.unexplained
  });
});

test("module x language rows and bytes are deterministic under ledger row reordering", async () => {
  const runDir = await prepare();
  const ledgerResult = JSON.parse(await readFile(join(runDir, "ledger", "files.json"), "utf8")) as ArtifactResult<FileLedger>;
  assert.equal(ledgerResult.status, "built");
  const forward = buildOverviewCensus(ledgerResult.value, countedRowSet(ledgerResult.value));
  const reversed: FileLedger = {
    ...ledgerResult.value,
    counted: [...ledgerResult.value.counted].reverse(),
    excluded: [...ledgerResult.value.excluded].reverse(),
    unexplained: [...ledgerResult.value.unexplained].reverse()
  };
  const backward = buildOverviewCensus(reversed, countedRowSet(reversed));
  assert.equal(stableJson(forward), stableJson(backward));
  assert.deepEqual(forward.rows.map((row) => `${row.module}/${row.language}`), [...forward.rows.map((row) => `${row.module}/${row.language}`)].sort());
});

test("the bounded workset view is the model input and does not point at machine census JSON", async () => {
  const runDir = await prepare();
  const view = await readFile(join(runDir, "context", "workset.md"), "utf8");
  assert.match(view, /## Overview census/);
  assert.match(view, /Source digest: `[0-9a-f]{64}`/);
  assert.doesNotMatch(view, /overview-census\.json|read-specs\.json/);
});
