import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactResult } from "../src/base/artifact-result.ts";
import type { AttributionArtifact } from "../src/attribution/attribution-artifact.ts";
import { stableJson } from "../src/base/util.ts";
import { unitsRowSet, type UnitsArtifact } from "../src/facts/units/units-artifact.ts";
import { countedRowSet, type FileLedger } from "../src/snapshot/file-ledger.ts";
import {
  buildScopeCensus, scopeCensusResidual, unavailableScopeCensus,
  SCOPE_CENSUS_VERSION, type ScopeCensusV2
} from "../src/workset/census.ts";
import { auditRun, prepareRun } from "../src/run/run.ts";
import { copyFixture, tempDir } from "./helpers.ts";

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function prepare(): Promise<string> {
  const { runDir } = await prepareRun({
    target: await copyFixture(), workdir: await tempDir(), language: "en-US", detailLevel: "standard",
    codegraphMode: "off", overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave"], audiences: ["product"] }],
    budgets: BUDGETS
  });
  return runDir;
}

async function artifacts(runDir: string): Promise<{
  ledger: FileLedger; units: UnitsArtifact; attribution: AttributionArtifact; census: ScopeCensusV2; file: string;
}> {
  const ledger = JSON.parse(await readFile(join(runDir, "ledger", "files.json"), "utf8")) as ArtifactResult<FileLedger>;
  const units = JSON.parse(await readFile(join(runDir, "facts", "units.json"), "utf8")) as ArtifactResult<UnitsArtifact>;
  const attribution = JSON.parse(await readFile(join(runDir, "attribution", "attribution.json"), "utf8")) as ArtifactResult<AttributionArtifact>;
  assert.equal(ledger.status, "built");
  assert.equal(units.status, "built");
  assert.equal(attribution.status, "built");
  const file = (await readdir(join(runDir, "context"))).find((name) => name.endsWith(".scope-census.json"))!;
  const result = JSON.parse(await readFile(join(runDir, "context", file), "utf8")) as ArtifactResult<ScopeCensusV2>;
  assert.equal(result.status, "built");
  return { ledger: ledger.value, units: units.value, attribution: attribution.value, census: result.value, file };
}

test("prepare writes scope-census-v2 from the two legal RowSets and keeps both laws separate", async () => {
  const { census } = await artifacts(await prepare());
  assert.equal(census.version, SCOPE_CENSUS_VERSION);
  assert.equal(census.identity.files.artifact, "ledger/files.json");
  assert.equal(census.identity.files.unitKind, "file");
  assert.equal(census.identity.partition?.artifact, "facts/units.json");
  assert.equal(census.identity.partition?.unitKind, "partition-cell");
  assert.ok(census.rows.length > 0);
  for (const row of census.rows) {
    assert.equal(row.kind, "census");
    if (row.kind !== "census") continue;
    assert.equal(row.coverage.unitKind, "file");
    assert.equal(row.selection.unitKind, "partition-cell");
  }
  assert.equal(scopeCensusResidual(census).balanced, true);
  assert.equal(census.summary.coverage.total, census.summary.coverage.counted + census.summary.coverage.excluded + census.summary.coverage.unexplained);
  assert.equal(census.summary.selection?.counted, (census.summary.selection?.seated ?? 0) + (census.summary.selection?.zeroScore ?? 0) + (census.summary.selection?.displaced ?? 0));
});

test("a bare array cannot cross either census denominator door", () => {
  assert.throws(() => buildScopeCensus({ files: [] as never } as never), /must be a RowSet.*bare arrays and refUnits are forbidden/);
});

test("refUnits cannot masquerade as the partition denominator", async () => {
  const value = await artifacts(await prepare());
  assert.throws(() => buildScopeCensus({
    featureKey: value.census.featureKey,
    files: countedRowSet(value.ledger),
    ledger: value.ledger,
    partition: value.units.refUnits as never,
    units: value.units,
    attribution: value.attribution,
    attributionDigest: value.census.identity.attributionDigest!
  }), /must be a RowSet.*bare arrays and refUnits are forbidden/);
});

test("an attribution fixture that drops selection rows fails instead of publishing a balanced-looking census", async () => {
  const value = await artifacts(await prepare());
  const selection = value.attribution.selections.find((row) => row.featureKey === value.census.featureKey);
  assert.ok(selection && selection.zeroScore.length > 0);
  const attribution: AttributionArtifact = {
    ...value.attribution,
    selections: value.attribution.selections.map((row) => row.featureKey === value.census.featureKey ? { ...row, zeroScore: [] } : row)
  };
  assert.throws(() => buildScopeCensus({
    featureKey: value.census.featureKey,
    files: countedRowSet(value.ledger),
    ledger: value.ledger,
    partition: unitsRowSet(value.units),
    units: value.units,
    attribution,
    attributionDigest: value.census.identity.attributionDigest!
  }), /Selection conservation is broken/);
});

test("one feature failure is a named census-unavailable row inside Built-compatible data", async () => {
  const { ledger, census } = await artifacts(await prepare());
  const residual = unavailableScopeCensus(census.featureKey, countedRowSet(ledger), "partition builder unavailable", true);
  assert.equal(residual.version, "scope-census-v2");
  assert.deepEqual(residual.rows, [{ kind: "census-unavailable", featureKey: census.featureKey, cause: "partition builder unavailable", retryable: true }]);
  assert.equal(residual.summary.selection, null);
  assert.equal(residual.summary.coverage.total, ledger.summary.counted, "a local failure remains residual over the legal file denominator rather than shrinking it to zero");
  assert.equal(residual.summary.coverage.unexplained, ledger.summary.counted);
  assert.equal(scopeCensusResidual(residual).unavailable.length, 1);
});

test("the artifact and bounded model view are deterministic, and audit exposes unexplained file coverage", async () => {
  const runDir = await prepare();
  const first = await artifacts(runDir);
  const rebuilt = buildScopeCensus({
    featureKey: first.census.featureKey,
    files: countedRowSet(first.ledger),
    ledger: first.ledger,
    partition: unitsRowSet(first.units),
    units: first.units,
    attribution: first.attribution,
    attributionDigest: first.census.identity.attributionDigest!
  });
  assert.equal(stableJson(rebuilt), stableJson(first.census));
  const view = await readFile(join(runDir, "context", "workset.md"), "utf8");
  assert.match(view, /Source digest: `[0-9a-f]{64}`/);
  assert.match(view, /Declared bound:/);
  assert.match(view, /File coverage: \d+=\d+\+\d+\+\d+\. Partition selection: \d+=\d+\+\d+\+\d+\./,
    "scope totals remain visible even when earlier ReadSpec rows consume the detail-row budget");
  const findings = (await auditRun(runDir)).findings.filter((finding) => finding.message.includes(first.file));
  assert.ok(findings.every((finding) => finding.level === "warning"));
});
