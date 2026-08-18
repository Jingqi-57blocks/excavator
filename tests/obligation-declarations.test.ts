import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactResult } from "../src/base/artifact-result.ts";
import type { Requirements } from "../src/contract/bound-run-contract.ts";
import type { UnitsArtifact } from "../src/facts/units/units-artifact.ts";
import type { MechanismLedger } from "../src/mechanism/mechanism-ledger.ts";
import { buildObligationDeclarations, requireObligationDeclarations, type ObligationDeclarations } from "../src/obligation/declarations.ts";
import { auditRun, freezeRun, prepareRun } from "../src/run/run.ts";
import type { ReadSpecsArtifact } from "../src/workset/read-specs.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function prepare(): Promise<string> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return (await prepareRun({
    target, workdir, codegraph, language: "en-US", detailLevel: "standard", overviewAudiences: ["product"],
    features: [{ subject: "Leave management", aliases: ["leave"], audiences: ["engineering"] }], budgets: BUDGETS
  })).runDir;
}

async function inputs(runDir: string): Promise<{ requirements: Requirements; workset: ReadSpecsArtifact; mechanisms: MechanismLedger; units: UnitsArtifact }> {
  const requirements = JSON.parse(await readFile(join(runDir, "contract", "requirements.json"), "utf8")) as Requirements;
  const workset = JSON.parse(await readFile(join(runDir, "workset", "read-specs.json"), "utf8")) as ArtifactResult<ReadSpecsArtifact>;
  const mechanisms = JSON.parse(await readFile(join(runDir, "ledger", "mechanisms.json"), "utf8")) as ArtifactResult<MechanismLedger>;
  const units = JSON.parse(await readFile(join(runDir, "facts", "units.json"), "utf8")) as ArtifactResult<UnitsArtifact>;
  assert.equal(workset.status, "built");
  assert.equal(mechanisms.status, "built");
  assert.equal(units.status, "built");
  return { requirements, workset: workset.value, mechanisms: mechanisms.value, units: units.value };
}

test("layer 6 declares every template/run requirement exactly once and carries no evidence fields", async () => {
  const runDir = await prepare();
  const args = await inputs(runDir);
  const result = JSON.parse(await readFile(join(runDir, "obligations", "declarations.json"), "utf8")) as ArtifactResult<ObligationDeclarations>;
  assert.equal(result.status, "built");
  requireObligationDeclarations(result.value, args.requirements);
  const declaredRequirements = result.value.declarations.filter((row) => row.kind === "knowledge-requirement");
  const declaredReadings = result.value.declarations.filter((row) => row.kind === "source-reading");
  assert.equal(declaredRequirements.length, args.requirements.rows.length);
  assert.equal(declaredReadings.length, args.workset.specs.length, "every L5 authorization is declared before L7 can execute it");
  assert.deepEqual(declaredReadings.map((row) => row.readSpecId).sort(), args.workset.specs.map((row) => row.id).sort());
  assert.ok(declaredRequirements.some((row) => row.scope === "run" && row.documentId === null));
  assert.ok(declaredRequirements.some((row) => row.sectionIndex !== null));
  assert.doesNotMatch(JSON.stringify(result.value), /evidence/i);
});

test("decision, no-decision and probe-unavailable candidates are exclusive conserved buckets", async () => {
  const args = await inputs(await prepare());
  const spec = args.workset.specs[0];
  assert.ok(spec, "the fixture supplies at least one ReadSpec");
  const first = {
    id: "CAND-synthetic-unavailable", featureKey: spec.featureKey, name: "syntheticDecision",
    path: spec.path, span: spec.span, language: "typescript", probe: "unavailable" as const, readSpecId: spec.id
  };
  const candidates = [...args.workset.candidates, first];
  const workset: ReadSpecsArtifact = {
    ...args.workset,
    candidates,
    summary: {
      ...args.workset.summary,
      candidates: candidates.length,
      decision: candidates.filter((row) => row.probe === "decision").length,
      noDecision: candidates.filter((row) => row.probe === "no-decision").length,
      unavailable: candidates.filter((row) => row.probe === "unavailable").length
    }
  };
  const artifact = buildObligationDeclarations({ ...args, workset });
  assert.ok(artifact.residuals.some((row) => row.candidateId === first.id && row.kind === "probe-unavailable"));
  assert.equal(artifact.candidateAccounting.total, artifact.candidateAccounting.counted + artifact.candidateAccounting.excluded + artifact.candidateAccounting.unexplained);
  assert.equal(artifact.candidateAccounting.unexplained, artifact.residuals.length);
});

test("Python and Java probe gaps remain two named per-function residuals", async () => {
  const args = await inputs(await prepare());
  const spec = args.workset.specs[0];
  assert.ok(spec, "the fixture supplies at least one ReadSpec");
  const unavailable = (["python", "java"] as const).map((language, index) => ({
    id: `CAND-${language}-unavailable`,
    featureKey: spec.featureKey,
    name: `${language}Decision`,
    path: `${language}/Decision.${language === "python" ? "py" : "java"}`,
    span: { startLine: index + 1, endLine: index + 1 },
    language,
    probe: "unavailable" as const,
    readSpecId: spec.id
  }));
  const candidates = [...args.workset.candidates, ...unavailable];
  const workset: ReadSpecsArtifact = {
    ...args.workset,
    candidates,
    summary: {
      ...args.workset.summary,
      candidates: candidates.length,
      decision: candidates.filter((row) => row.probe === "decision").length,
      noDecision: candidates.filter((row) => row.probe === "no-decision").length,
      unavailable: candidates.filter((row) => row.probe === "unavailable").length
    }
  };
  const artifact = buildObligationDeclarations({ ...args, workset });
  for (const candidate of unavailable) {
    assert.ok(artifact.residuals.some((row) => row.candidateId === candidate.id && row.mechanism.language === candidate.language));
  }
  assert.equal(new Set(artifact.residuals.map((row) => row.candidateId)).size, artifact.residuals.length);
});

test("the L6 implementation imports only requirements, workset, mechanisms and units as domain inputs", async () => {
  const source = await readFile(new URL("../src/obligation/declarations.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /templatePath|Audience|DocumentPlan|InvestigationWorkItem|EvidenceItem|evidence\.json|SourceReader|workItemId/);
  assert.match(source, /readonly requirements: Requirements/);
  assert.match(source, /readonly workset: ReadSpecsArtifact/);
  assert.match(source, /readonly mechanisms: MechanismLedger/);
  assert.match(source, /readonly units: UnitsArtifact/);
});

test("a current run cannot replace its declaration set with an Unavailable envelope and continue", async () => {
  const runDir = await prepare();
  await writeFile(join(runDir, "obligations", "declarations.json"), JSON.stringify({ status: "unavailable", cause: "tampered", retryable: false }));
  const findings = (await auditRun(runDir)).findings;
  assert.ok(findings.some((finding) => finding.level === "error" && finding.message.includes("declarations.json violates its declaration contract")));
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, false);
  assert.ok(frozen.findings.some((finding) => /declarations\.json.*unavailable: tampered/.test(finding.message)));
});

test("audit re-derives declarations from all four inputs instead of accepting an internally valid rewrite", async () => {
  const runDir = await prepare();
  const path = join(runDir, "obligations", "declarations.json");
  const result = JSON.parse(await readFile(path, "utf8")) as ArtifactResult<ObligationDeclarations>;
  assert.equal(result.status, "built");
  const victim = result.value.declarations.find((row) => row.kind === "knowledge-requirement");
  assert.ok(victim && victim.kind === "knowledge-requirement");
  const rewritten: ObligationDeclarations = {
    ...result.value,
    declarations: result.value.declarations.map((row) => row.id === victim.id ? { ...victim, statement: `${victim.statement} (rewritten)` } : row)
  };
  requireObligationDeclarations(rewritten, (await inputs(runDir)).requirements);
  await writeFile(path, JSON.stringify({ status: "built", value: rewritten }));
  const findings = (await auditRun(runDir)).findings;
  assert.ok(findings.some((finding) => finding.level === "error" && finding.message.includes("not the deterministic declaration set")));
});
