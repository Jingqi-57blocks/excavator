import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactResult, NotApplicable } from "../src/base/artifact-result.ts";
import { notApplicable } from "../src/base/artifact-result.ts";
import {
  coverageBasisDigest, fileCompletenessValue, FILE_COMPLETENESS_BASIS, FILE_ROOTS_BASIS, fileRootCensusValue,
  mechanismCoverageBasisName, mechanismCoverageValue
} from "../src/base/coverage-basis.ts";
import type { KnowledgeArtifact, ReportRequest } from "../src/base/types.ts";
import type { ContractManifest } from "../src/contract/contract-manifest.ts";
import { contractManifestDigest } from "../src/contract/contract-manifest.ts";
import { auditNotApplicablePremises } from "../src/freeze/completeness.ts";
import type { MechanismLedger } from "../src/mechanism/mechanism-ledger.ts";
import type { FileLedger } from "../src/snapshot/file-ledger.ts";
import type { ScopeCensusV2 } from "../src/workset/census.ts";
import { freezeRun, prepareRun } from "../src/run/run.ts";
import { writeJson } from "../src/base/util.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "./helpers.ts";

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function request(features: ReportRequest["features"]): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, workdir, codegraph, language: "en-US", detailLevel: "standard", overviewAudiences: features.length ? [] : ["engineering"], features, budgets: BUDGETS };
}

async function featureRequest(): Promise<ReportRequest> {
  return request([{ subject: "Leave management", aliases: ["leave"], audiences: ["engineering"] }]);
}

async function readContract(runDir: string): Promise<ContractManifest> {
  return JSON.parse(await readFile(join(runDir, "contract", "contract-manifest.json"), "utf8")) as ContractManifest;
}

test("freeze publishes domain/kind conjunctions and keeps positive and negative closure separate", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  await disposeAllWorkItems(runDir);
  const result = await freezeRun(runDir);
  assert.equal(result.frozen, true, JSON.stringify(result.findings, null, 2));
  const knowledge = JSON.parse(await readFile(join(runDir, "knowledge.json"), "utf8")) as KnowledgeArtifact;
  const serialized = JSON.stringify(knowledge.completeness);
  assert.doesNotMatch(serialized, /requiredItems|"disposed"/, "the old plan-only disposed\/total ratio is absent");
  assert.equal(knowledge.completeness.closure.workItems.positive, 0);
  assert.equal(knowledge.completeness.closure.workItems.negative, knowledge.workitems.length);
  assert.equal(knowledge.completeness.closure.workItems.pending, 0);
  const keys = knowledge.completeness.domains.map((row) => `${row.coverageDomain}/${row.unitKind}`);
  assert.equal(new Set(keys).size, keys.length, "each domain/kind has one conjunction row");
  for (const domain of knowledge.completeness.domains) {
    assert.ok(domain.sources.length > 0);
    assert.ok(domain.sources.every((row) => row.coverageDomain === domain.coverageDomain && row.unitKind === domain.unitKind));
  }
  assert.deepEqual(knowledge.completeness.checks.map((row) => row.family),
    ["boundary-identity", "contract-instances", "coverage-conservation", "investigation-closure", "not-applicable-premises"]);
  assert.ok(knowledge.completeness.checks.every((row) => row.status === "passed"));
});

// THE CLOSURE CHECK ONLY EVER ASKED THE FORWARD QUESTION.
//
// `auditInvestigationClosure` verifies that every AUTHORIZED read completed. Nothing asked the reverse — were
// the reads that happened authorized at all — so a run could read freely and still seal `investigation-closure:
// passed, 0 findings`. On a real wcp overview that is exactly what happened: `read-specs.json` was `built` with
// `specs: 0`, 42 source windows sat in the catalog, and the epoch sealed clean.
//
// The cause is structural, not accidental: `ReadSpec.featureKey` is a required non-empty string, so a run with
// no feature authorizes nothing BY CONSTRUCTION. Freeze therefore states the size of the gap rather than
// asserting a closure it cannot justify — a number in every sealed epoch, available to gate on later.
test("freeze counts the source reads no authorization covers instead of sealing over them", async () => {
  const { runDir } = await prepareRun(await request([]));
  await disposeAllWorkItems(runDir);
  const result = await freezeRun(runDir);
  assert.equal(result.frozen, true, JSON.stringify(result.findings, null, 2));

  const knowledge = JSON.parse(await readFile(join(runDir, "knowledge.json"), "utf8")) as KnowledgeArtifact;
  const evidence = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: Array<{ kind: string }> };
  // EVERY kind produced by reading the target, not just `source`. Counting `source` alone measured "unclaimed
  // source entries" while the field claimed to measure unauthorized reads, leaving `readme`, `manifest` and
  // `search` — all of them `SourceReader`/`sourceSearch` output — in neither bucket.
  const readDerived = evidence.evidence.filter((item) => ["source", "readme", "manifest", "search"].includes(item.kind)).length;
  const sourceOnly = evidence.evidence.filter((item) => item.kind === "source").length;

  assert.ok(sourceOnly > 0 && readDerived > sourceOnly,
    "the fixture records more than one kind of read, so a source-only count would be a visible undercount");
  assert.equal(knowledge.completeness.closure.sourceReadsWithoutObligation, readDerived,
    "an overview run authorizes no read, so every recorded read is unaccounted — and the epoch says so");

  // The check still passes — the gap is a property of the L5/L7 split, not of this run, and failing it would
  // stop every overview and feature run today. But it must not pass SILENTLY: a verdict of "passed, 0 findings"
  // printed beside a non-zero count is the artifact contradicting itself.
  const closure = knowledge.completeness.checks.find((row) => row.family === "investigation-closure");
  assert.equal(closure?.status, "passed", "the gap is stated, not converted into a freeze failure");
  assert.ok((closure?.findingCount ?? 0) > 0, "and it is not sealed as `0 findings` while the count says otherwise");
});

test("an overview-only run retains conserved file and partition domains without inventing a feature selection", async () => {
  const { runDir } = await prepareRun(await request([]));
  await disposeAllWorkItems(runDir);
  const result = await freezeRun(runDir);
  assert.equal(result.frozen, true, JSON.stringify(result.findings, null, 2));
  const knowledge = JSON.parse(await readFile(join(runDir, "knowledge.json"), "utf8")) as KnowledgeArtifact;
  const sources = knowledge.completeness.domains.flatMap((row) => row.sources);
  assert.ok(sources.some((row) => row.id === "attribution:no-feature"));
  assert.ok(!sources.some((row) => row.id.startsWith("scope:")), "no feature means no fabricated scope denominator");
  for (const source of sources) {
    const row = source.accounting;
    if ("total" in row) assert.equal(row.total, (row.counted ?? 0) + (row.excluded ?? 0) + (row.unexplained ?? 0), source.id);
    if ("seated" in row) assert.equal(row.counted, row.seated + row.zeroScore + row.displaced, source.id);
  }
});

test("freeze rejects a scope census whose row and summary no longer conserve the same denominator", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  await disposeAllWorkItems(runDir);
  const contract = await readContract(runDir);
  const path = contract.expected.find((row) => row.slotId === "workset.scope-census")!.path;
  const result = JSON.parse(await readFile(join(runDir, path), "utf8")) as ArtifactResult<ScopeCensusV2>;
  assert.equal(result.status, "built");
  const row = result.value.rows.find((entry) => entry.kind === "census");
  assert.ok(row);
  (row.coverage.totals as unknown as { unexplained: number }).unexplained += 1;
  await writeJson(join(runDir, path), result);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, false);
  assert.ok(frozen.findings.some((finding) => finding.document === "completeness" && /unbalanced|summary/.test(finding.message)), JSON.stringify(frozen.findings, null, 2));
});

test("a check family with no executor is recorded as skipped and blocks freeze", async () => {
  const { runDir } = await prepareRun(await request([]));
  await disposeAllWorkItems(runDir);
  const contract = await readContract(runDir);
  const changed: ContractManifest = { ...contract, checks: [...contract.checks, { family: "fixture-unrun-check", version: "v1" }] };
  changed.digest = contractManifestDigest(changed);
  await writeJson(join(runDir, "contract", "contract-manifest.json"), changed);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, false);
  assert.ok(frozen.findings.some((finding) => finding.document === "freeze-checklist" && /fixture-unrun-check.*skipped/.test(finding.message)), JSON.stringify(frozen.findings, null, 2));
});

test("a known check family with an unsupported version is skipped rather than mislabeled as passed", async () => {
  const { runDir } = await prepareRun(await request([]));
  await disposeAllWorkItems(runDir);
  const contract = await readContract(runDir);
  const changed: ContractManifest = {
    ...contract,
    checks: contract.checks.map((row) => row.family === "coverage-conservation" ? { ...row, version: "v999" } : row)
  };
  changed.digest = contractManifestDigest(changed);
  await writeJson(join(runDir, "contract", "contract-manifest.json"), changed);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, false);
  assert.ok(frozen.findings.some((finding) => finding.document === "freeze-checklist" && /coverage-conservation@v999.*skipped/.test(finding.message)), JSON.stringify(frozen.findings, null, 2));
});

test("a balanced scope census still fails when rows no longer cover its named denominator", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  await disposeAllWorkItems(runDir);
  const contract = await readContract(runDir);
  const path = contract.expected.find((row) => row.slotId === "workset.scope-census")!.path;
  const result = JSON.parse(await readFile(join(runDir, path), "utf8")) as ArtifactResult<ScopeCensusV2>;
  assert.equal(result.status, "built");
  const rows = result.value.rows.filter((row): row is Extract<ScopeCensusV2["rows"][number], { kind: "census" }> => row.kind === "census");
  assert.ok(rows.length > 0);
  const removed = rows[0]!;
  (result.value.rows as unknown as ScopeCensusV2["rows"]) = result.value.rows.filter((row) => row !== removed);
  const coverage = result.value.summary.coverage as unknown as { total: number; counted: number; excluded: number; unexplained: number };
  for (const key of ["total", "counted", "excluded", "unexplained"] as const) coverage[key] -= removed.coverage.totals[key];
  const selection = result.value.summary.selection as unknown as { counted: number; seated: number; zeroScore: number; displaced: number };
  for (const key of ["counted", "seated", "zeroScore", "displaced"] as const) selection[key] -= removed.selection.totals[key];
  await writeJson(join(runDir, path), result);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, false);
  assert.ok(frozen.findings.some((finding) => finding.document === "completeness" && /does not conserve its named denominator/.test(finding.message)), JSON.stringify(frozen.findings, null, 2));
});

test("a matching NotApplicable digest still fails when its file scan premise was capped", async () => {
  const { runDir } = await prepareRun(await request([]));
  const contract = await readContract(runDir);
  const filesPath = join(runDir, "ledger", "files.json");
  const files = JSON.parse(await readFile(filesPath, "utf8")) as ArtifactResult<FileLedger>;
  const mechanisms = JSON.parse(await readFile(join(runDir, "ledger", "mechanisms.json"), "utf8")) as ArtifactResult<MechanismLedger>;
  const producerPath = join(runDir, "facts", "producers", "crossrepo.json");
  const producer = JSON.parse(await readFile(producerPath, "utf8")) as ArtifactResult<unknown>;
  assert.equal(files.status, "built"); assert.equal(mechanisms.status, "built"); assert.equal(producer.status, "not-applicable");
  files.value.completeness.capReached = true;
  files.value.completeness.skippedByCap = 1;
  const coverageDigest = coverageBasisDigest([
    { reference: FILE_COMPLETENESS_BASIS, value: fileCompletenessValue(files.value.completeness) },
    { reference: FILE_ROOTS_BASIS, value: fileRootCensusValue(files.value.completeness.roots) },
    { reference: mechanismCoverageBasisName("crossrepo"), value: mechanismCoverageValue(mechanisms.value, "crossrepo") }
  ]);
  await writeJson(filesPath, files);
  await writeJson(producerPath, { ...producer, coverageDigest });
  const findings = await auditNotApplicablePremises(runDir, contract);
  assert.ok(findings.some((finding) => /capped, dropped or unread file scan/.test(finding.message)), JSON.stringify(findings, null, 2));
});

test("single-module is invalid without the layer-1 root census premise", async () => {
  const requestValue = await request([]);
  const { runDir } = await prepareRun(requestValue);
  const contract = await readContract(runDir);
  const path = join(runDir, "facts", "producers", "crossrepo.json");
  const result = JSON.parse(await readFile(path, "utf8")) as ArtifactResult<unknown>;
  assert.equal(result.status, "not-applicable");
  if (result.status !== "not-applicable") return;
  await writeJson(path, {
    ...result,
    basedOn: result.basedOn.filter((reference) => reference !== FILE_ROOTS_BASIS)
  });
  const findings = await auditNotApplicablePremises(runDir, contract);
  assert.ok(findings.some((finding) => /without file completeness, root census and resolver-coverage premises/.test(finding.message)), JSON.stringify(findings, null, 2));
});

test("not-detected is invalid when its own mechanism only covers part of the file denominator", async () => {
  const runDir = await tempDir();
  const mechanismId = "decision-probe";
  const fileCompleteness = { capReached: false, skippedByCap: 0, droppedRoots: [] as string[] };
  const mechanismLedger = {
    mechanisms: [{ id: mechanismId, availability: { status: "available", version: "fixture" }, coverageDomain: "file", unitKind: "file", version: "v1", takesMatrixRows: true }],
    fileMatrix: [{ mechanismId, defaults: [], exceptions: [], totals: { covered: 1, noMechanism: 1, mechanismUnavailable: 0 } }],
    byLanguage: []
  };
  const basedOn = [FILE_COMPLETENESS_BASIS, mechanismCoverageBasisName(mechanismId)];
  const coverageDigest = coverageBasisDigest([
    { reference: FILE_COMPLETENESS_BASIS, value: fileCompletenessValue(fileCompleteness) },
    { reference: mechanismCoverageBasisName(mechanismId), value: mechanismCoverageValue(mechanismLedger, mechanismId) }
  ]);
  const envelope: NotApplicable = notApplicable("not-detected", basedOn, coverageDigest);
  await writeJson(join(runDir, "ledger", "files.json"), { status: "built", value: { completeness: fileCompleteness, counted: [] } });
  await writeJson(join(runDir, "ledger", "mechanisms.json"), { status: "built", value: mechanismLedger });
  await writeJson(join(runDir, "facts", "producers", "probe.json"), envelope);
  const contract = { expected: [{ enforced: true, path: "facts/producers/probe.json" }] } as ContractManifest;
  const findings = await auditNotApplicablePremises(runDir, contract);
  assert.ok(findings.some((finding) => /partial mechanism coverage/.test(finding.message)), JSON.stringify(findings, null, 2));
});

test("a malformed duplicate or unsupported NotApplicable premise becomes findings, never an audit crash", async () => {
  const runDir = await tempDir();
  await writeJson(join(runDir, "facts", "producers", "probe.json"), {
    status: "not-applicable", determination: "policy-skipped",
    basedOn: [FILE_COMPLETENESS_BASIS, FILE_COMPLETENESS_BASIS], coverageDigest: "fixture"
  });
  const contract = { expected: [{ enforced: true, path: "facts/producers/probe.json" }] } as ContractManifest;
  const findings = await auditNotApplicablePremises(runDir, contract);
  assert.ok(findings.some((finding) => /unsupported NotApplicable determination/.test(finding.message)), JSON.stringify(findings, null, 2));
  assert.ok(findings.some((finding) => /same coverage basis/.test(finding.message)), JSON.stringify(findings, null, 2));
});

test("not-detected cannot use a mechanism that publishes no file-domain coverage matrix", async () => {
  const runDir = await tempDir();
  const mechanismId = "corpus-only";
  const fileCompleteness = { capReached: false, skippedByCap: 0, droppedRoots: [] as string[] };
  const mechanismLedger = {
    mechanisms: [{ id: mechanismId, availability: { status: "available", version: "fixture" }, coverageDomain: "corpus", unitKind: "corpus", version: "v1", takesMatrixRows: false }],
    fileMatrix: [], byLanguage: []
  };
  const basedOn = [FILE_COMPLETENESS_BASIS, mechanismCoverageBasisName(mechanismId)];
  const coverageDigest = coverageBasisDigest([
    { reference: FILE_COMPLETENESS_BASIS, value: fileCompletenessValue(fileCompleteness) },
    { reference: mechanismCoverageBasisName(mechanismId), value: mechanismCoverageValue(mechanismLedger, mechanismId) }
  ]);
  await writeJson(join(runDir, "ledger", "files.json"), { status: "built", value: { completeness: fileCompleteness, counted: [] } });
  await writeJson(join(runDir, "ledger", "mechanisms.json"), { status: "built", value: mechanismLedger });
  await writeJson(join(runDir, "facts", "producers", "probe.json"), notApplicable("not-detected", basedOn, coverageDigest));
  const contract = { expected: [{ enforced: true, path: "facts/producers/probe.json" }] } as ContractManifest;
  const findings = await auditNotApplicablePremises(runDir, contract);
  assert.ok(findings.some((finding) => /without a file-domain mechanism matrix/.test(finding.message)), JSON.stringify(findings, null, 2));
});
