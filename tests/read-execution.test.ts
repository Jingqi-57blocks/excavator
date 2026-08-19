import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { built, type ArtifactResult } from "../src/base/artifact-result.ts";
import { summarizeCoverage } from "../src/base/conservation.ts";
import type { EvidenceItem, InvestigationPlan } from "../src/base/types.ts";
import { auditWorkItems } from "../src/investigation/assurance.ts";
import {
  executeReadSpecs, requireInvestigationResults, type InvestigationResults
} from "../src/investigation/read-execution.ts";
import type { ObligationDeclarations } from "../src/obligation/declarations.ts";
import { auditRun, freezeRun, prepareRun } from "../src/run/run.ts";
import { applyInvestigationDispositions } from "../src/run/investigation-stage.ts";
import type { ReadSpec, ReadSpecsArtifact } from "../src/workset/read-specs.ts";
import { sha256, stableJson } from "../src/base/util.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "./helpers.ts";

function spec(id: string, path: string, startLine: number, endLine: number): ReadSpec {
  const requestedLines = endLine - startLine + 1;
  return {
    id,
    featureKey: "feature-a",
    path,
    span: { startLine, endLine },
    reason: `authorized test read ${id}`,
    budget: { windows: Math.ceil(requestedLines / 240), requestedLines }
  };
}

function contracts(specs: readonly ReadSpec[]): { workset: ReadSpecsArtifact; obligations: ObligationDeclarations } {
  const candidates = specs.map((row, index) => ({
    id: `CAND-${index}`,
    featureKey: row.featureKey,
    name: `decision${index}`,
    path: row.path,
    span: row.span,
    language: "typescript",
    probe: row.id === "READ-residual" ? "unavailable" as const : "decision" as const,
    readSpecId: row.id
  }));
  const workset: ReadSpecsArtifact = {
    version: "read-specs-v1",
    identity: { factPacksDigest: "facts", boundaryCandidatesDigest: "boundary", unitsContentDigest: "units" },
    specs,
    candidates,
    summary: {
      specs: specs.length,
      requestedLines: specs.reduce((sum, row) => sum + row.budget.requestedLines, 0),
      candidates: candidates.length,
      decision: candidates.filter((row) => row.probe === "decision").length,
      noDecision: 0,
      unavailable: candidates.filter((row) => row.probe === "unavailable").length
    }
  };
  const sourceDeclarations = specs.map((row) => ({
    id: `OBL-${row.id}`,
    kind: "source-reading" as const,
    readSpecId: row.id,
    featureKey: row.featureKey,
    path: row.path,
    span: row.span,
    reason: row.reason
  }));
  const decisionDeclarations = candidates.filter((row) => row.probe === "decision").map((row) => ({
    id: `OBL-DEC-${row.id}`,
    kind: "decision-reading" as const,
    candidateId: row.id,
    featureKey: row.featureKey,
    name: row.name,
    path: row.path,
    span: row.span,
    readSpecId: row.readSpecId
  }));
  const residualCandidates = candidates.filter((row) => row.probe === "unavailable");
  const obligations: ObligationDeclarations = {
    version: "obligation-declarations-v1",
    identity: { requirementsDigest: "requirements", worksetDigest: "workset", mechanismsDigest: "mechanisms", unitsContentDigest: "units" },
    declarations: [...sourceDeclarations, ...decisionDeclarations],
    residuals: residualCandidates.map((row) => ({
      id: `RESIDUAL-${row.id}`,
      kind: "probe-unavailable" as const,
      candidateId: row.id,
      featureKey: row.featureKey,
      name: row.name,
      path: row.path,
      span: row.span,
      readSpecId: row.readSpecId,
      mechanism: { id: "decision-probe" as const, language: row.language, covered: 0, noMechanism: 1, mechanismUnavailable: 0 }
    })),
    exclusions: [],
    candidateAccounting: summarizeCoverage({ total: candidates.length, counted: decisionDeclarations.length, excluded: 0 }),
    summary: {
      requirements: 0,
      sourceReadings: sourceDeclarations.length,
      decisionObligations: decisionDeclarations.length,
      residuals: residualCandidates.length,
      excludedNoDecision: 0
    }
  };
  return { workset, obligations };
}

test("L7 executes only authorized paths and records source, empty, unavailable and long-span results", async () => {
  const target = await tempDir();
  const cacheDir = join(await tempDir(), "cache");
  await mkdir(join(target, "src"), { recursive: true });
  await writeFile(join(target, "src", "ok.ts"), "const one = 1;\nconst two = 2;\n");
  await writeFile(join(target, "src", "residual.ts"), "export function undecided() { return true; }\n");
  await writeFile(join(target, "src", "long.ts"), Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n"));
  await writeFile(join(target, "src", "forbidden.ts"), "NEVER_AUTHORIZED_SENTINEL\n");
  const specs = [
    spec("READ-source", "src/ok.ts", 1, 2),
    spec("READ-empty", "src/ok.ts", 20, 20),
    spec("READ-unavailable", "src/missing.ts", 1, 1),
    spec("READ-long", "src/long.ts", 1, 500),
    spec("READ-residual", "src/residual.ts", 1, 1)
  ];
  const { workset, obligations } = contracts(specs);
  const result = await executeReadSpecs({
    target,
    snapshotId: "snapshot-a",
    filesContentManifestDigest: "files-a",
    cacheDir,
    maxWindows: 10,
    maxCharacters: 200_000,
    redact: false,
    workset,
    obligations
  });
  const bySpec = new Map(result.artifact.executions.map((row) => [row.readSpecId, row]));
  assert.equal(bySpec.get("READ-source")?.outcome, "source");
  assert.equal(bySpec.get("READ-empty")?.outcome, "empty");
  assert.equal(bySpec.get("READ-unavailable")?.outcome, "unavailable");
  assert.deepEqual(bySpec.get("READ-long")?.observedSpan, { startLine: 1, endLine: 500 });
  assert.equal(bySpec.get("READ-long")?.evidenceIds.length, 3, "500 authorized lines require three bounded windows");
  assert.equal(result.artifact.summary.authorized, specs.length);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_AUTHORIZED_SENTINEL/, "a file with no ReadSpec is never read into L7 output");

  const dispositions = new Map(result.artifact.dispositions.map((row) => [row.readSpecId, row]));
  assert.deepEqual({ status: dispositions.get("READ-source")?.status, positive: dispositions.get("READ-source")?.positiveKnowledge }, { status: "fulfilled", positive: true });
  assert.deepEqual({ status: dispositions.get("READ-empty")?.status, positive: dispositions.get("READ-empty")?.positiveKnowledge }, { status: "closed-negative", positive: false });
  assert.deepEqual({ status: dispositions.get("READ-unavailable")?.status, positive: dispositions.get("READ-unavailable")?.positiveKnowledge }, { status: "pending", positive: false });
  assert.equal(result.artifact.residuals.length, 1, "a successful source read does not erase a per-function probe residual");
  assert.equal(result.artifact.residuals[0].residualId, "RESIDUAL-CAND-4");
  requireInvestigationResults(result.artifact, workset, obligations, result.evidence);
  const [first, second] = result.artifact.dispositions;
  const detached: InvestigationResults = {
    ...result.artifact,
    dispositions: [{ ...first, readSpecId: second.readSpecId, executionId: second.executionId, evidenceIds: second.evidenceIds }, ...result.artifact.dispositions.slice(1)]
  };
  assert.throws(() => requireInvestigationResults(detached, workset, obligations, result.evidence), /detached from its ReadSpec/);

  const emptyEvidence = result.evidence.find((item) => item.id === bySpec.get("READ-empty")?.evidenceIds[0]);
  const unavailableEvidence = result.evidence.find((item) => item.id === bySpec.get("READ-unavailable")?.evidenceIds[0]);
  assert.equal(emptyEvidence?.kind, "ledger");
  assert.equal(unavailableEvidence?.kind, "ledger");
});

// This test used to assert the opposite, and it was the defect written down as a contract: it drove a read to
// fail by STARVING THE BUDGET and then required that the run never freeze. Under that rule one exhausted
// ceiling made a run permanently unsealable — no authoring packet, no knowledge epoch, ever — and across the
// workspace 43 of 83 runs sat in that state with not one of them frozen. The freeze-blocking property it meant
// to protect is a property of `unavailable` (the source would not yield), and that half is now pinned where it
// can be driven directly, in `read-budget-cliff.test.ts`, alongside this half so neither can drift alone.
test("a budget-displaced source-reading seals as a recorded limitation instead of making the run unfreezable", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  const prepared = await prepareRun({
    target, workdir, codegraph, language: "en-US", detailLevel: "standard", overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave"], audiences: ["engineering"] }],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 0, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  });
  const result = JSON.parse(await readFile(join(prepared.runDir, "investigation", "results.json"), "utf8")) as ArtifactResult<InvestigationResults>;
  assert.equal(result.status, "built");
  assert.ok(result.value.executions.some((row) => row.outcome === "budget-displaced"));
  assert.ok(!result.value.executions.some((row) => row.outcome === "unavailable"), "an exhausted ceiling is this run declining to buy a window, not the source failing to yield");
  assert.equal(result.value.summary.displaced?.executions, result.value.executions.filter((row) => row.outcome === "budget-displaced").length);
  assert.equal(result.value.dispositions.length, 0, "this fixture isolates the source-reading gate from decision dispositions");

  const demand = prepared.manifest.metrics.sourceWindowDemand;
  assert.ok(demand, "prepare records the demand whether or not the ceiling met it");
  assert.ok(demand.requiredWindows > 0);
  assert.equal(demand.availableWindows, 0, "a ceiling of zero leaves nothing to spend");
  assert.ok(demand.requiredRunWindowBudget >= demand.requiredWindows, "the number to re-prepare with covers prepare's own reads too");
  assert.ok(prepared.manifest.metrics.warnings.some((warning) => warning.includes(`--max-source-windows ${demand.requiredRunWindowBudget}`)),
    "the operator is given the number, not told to double the budget until it stops failing");

  await disposeAllWorkItems(prepared.runDir);
  const frozen = await freezeRun(prepared.runDir);
  assert.equal(frozen.frozen, true, frozen.findings.filter((finding) => finding.level === "error").map((finding) => finding.message).join(" | "));
  assert.ok(frozen.findings.some((finding) => finding.level === "warning" && /displaced by a recorded budget ceiling/.test(finding.message)));
  assert.ok(!frozen.findings.some((finding) => /source-reading .* remains pending/.test(finding.message)));
  assert.equal(frozen.knowledge?.completeness.closure.readsDisplacedByBudget, result.value.summary.displaced?.executions);
  assert.equal(frozen.knowledge?.completeness.closure.authorizedReads, result.value.executions.length);
});

test("derived model content cannot masquerade as a successful source execution", async () => {
  const target = await tempDir();
  await writeFile(join(target, "allowed.ts"), "export const allowed = true;\n");
  const specs = [spec("READ-source", "allowed.ts", 1, 1)];
  const { workset, obligations } = contracts(specs);
  const result = await executeReadSpecs({
    target, snapshotId: "snapshot", filesContentManifestDigest: "files", cacheDir: join(await tempDir(), "cache"),
    maxWindows: 2, maxCharacters: 10_000, redact: false, workset, obligations
  });
  const forged = result.evidence.map((item): EvidenceItem => item.kind === "source" ? { ...item, kind: "derived" } : item);
  assert.throws(() => requireInvestigationResults(result.artifact, workset, obligations, forged), /non-source evidence/);
  const unauthorized = result.evidence.map((item): EvidenceItem => item.kind === "source" ? { ...item, path: "forbidden.ts" } : item);
  assert.throws(() => requireInvestigationResults(result.artifact, workset, obligations, unauthorized), /outside its authorized path/);
});

test("a closed-negative L7 disposition projects to limitation evidence, not a fake SEARCH receipt", async () => {
  const target = await tempDir();
  await writeFile(join(target, "allowed.ts"), "one line\n");
  const specs = [spec("READ-empty", "allowed.ts", 20, 20)];
  const { workset, obligations } = contracts(specs);
  const result = await executeReadSpecs({
    target, snapshotId: "snapshot", filesContentManifestDigest: "files", cacheDir: join(await tempDir(), "cache"),
    maxWindows: 2, maxCharacters: 10_000, redact: false, workset, obligations
  });
  const expected: InvestigationPlan = {
    version: 1,
    runId: "run",
    createdAt: "2026-01-01T00:00:00.000Z",
    items: [{
      id: "feature:feature-a:logic:decision0@allowed.ts:20",
      dimension: "decision-function",
      scope: "feature:feature-a",
      hypothesis: "authorized decision read",
      status: "pending",
      material: true,
      requiredFor: ["feature-feature-a-engineering"],
      evidenceIds: [],
      traceIds: [],
      origin: "default"
    }]
  };
  const plan = applyInvestigationDispositions(expected, built(result.artifact), built(obligations));
  assert.equal(plan.items[0].status, "cannot-determine");
  assert.equal(plan.items[0].material, false);
  assert.deepEqual(auditWorkItems(plan, expected, new Map(result.evidence.map((item) => [item.id, item])), new Set()), []);
});

// The projection that makes a budget-starved run sealable. `cannot-determine` is not a softer `pending`: the
// work-item audit demands a reason, a `settledBy` and limitation evidence for it, and a displaced read has all
// three. `pending` demands that someone dispose it, and nothing in the run can — `investigation/results.json`
// is written once at prepare and no runtime mutator reaches it.
test("a budget-displaced L7 disposition projects to a recorded limitation the work-item gate accepts", async () => {
  const target = await tempDir();
  await writeFile(join(target, "allowed.ts"), "const first = 1;\nconst second = 2;\n");
  const specs = [spec("READ-displaced", "allowed.ts", 1, 2)];
  const { workset, obligations } = contracts(specs);
  const result = await executeReadSpecs({
    target, snapshotId: "snapshot", filesContentManifestDigest: "files", cacheDir: join(await tempDir(), "cache"),
    maxWindows: 0, maxCharacters: 10_000, redact: false, workset, obligations
  });
  assert.equal(result.artifact.executions[0].outcome, "budget-displaced");
  assert.equal(result.artifact.executions[0].cause, "source-window-budget-exceeded");
  assert.deepEqual({ status: result.artifact.dispositions[0].status, positive: result.artifact.dispositions[0].positiveKnowledge }, { status: "displaced", positive: false });
  assert.deepEqual(result.artifact.summary.displaced, { executions: 1, dispositions: 1 });
  requireInvestigationResults(result.artifact, workset, obligations, result.evidence);
  assert.equal(result.evidence.filter((item) => item.kind === "source").length, 0, "a displaced read records no source bytes");

  const expected: InvestigationPlan = {
    version: 1,
    runId: "run",
    createdAt: "2026-01-01T00:00:00.000Z",
    items: [{
      id: "feature:feature-a:logic:decision0@allowed.ts:1",
      dimension: "decision-function",
      scope: "feature:feature-a",
      hypothesis: "authorized decision read",
      status: "pending",
      material: true,
      requiredFor: ["feature-feature-a-engineering"],
      evidenceIds: [],
      traceIds: [],
      origin: "default"
    }]
  };
  const plan = applyInvestigationDispositions(expected, built(result.artifact), built(obligations));
  assert.equal(plan.items[0].status, "cannot-determine");
  assert.equal(plan.items[0].material, false);
  assert.match(plan.items[0].reason ?? "", /source-window-budget-exceeded/);
  assert.deepEqual(auditWorkItems(plan, expected, new Map(result.evidence.map((item) => [item.id, item])), new Set()), []);
});

// The anti-abuse predicate for the new bucket. Displacement means windows were NOT bought, so evidence
// covering the whole authorized span contradicts the label — without this check `budget-displaced` would be a
// way to relabel a completed read as an excused one, which is exactly the ledger-lying class the downgrade is
// not allowed to touch.
test("an execution cannot claim a budget displacement while its evidence covers the whole authorized span", async () => {
  const target = await tempDir();
  await writeFile(join(target, "allowed.ts"), "const only = 1;\n");
  const specs = [spec("READ-source", "allowed.ts", 1, 1)];
  const { workset, obligations } = contracts(specs);
  const result = await executeReadSpecs({
    target, snapshotId: "snapshot", filesContentManifestDigest: "files", cacheDir: join(await tempDir(), "cache"),
    maxWindows: 2, maxCharacters: 10_000, redact: false, workset, obligations
  });
  const [execution] = result.artifact.executions;
  const data = {
    recordType: "read-execution",
    readSpecId: execution.readSpecId,
    declarationId: execution.declarationId,
    outcome: "budget-displaced",
    path: execution.path,
    requestedSpan: execution.requestedSpan,
    cause: "source-window-budget-exceeded"
  };
  const ledger: EvidenceItem = {
    id: `LEDGER-READ-${sha256(stableJson(data)).slice(0, 16)}`,
    snapshotId: "snapshot",
    kind: "ledger",
    title: "forged displacement",
    data,
    reason: "forged displacement",
    digest: sha256(stableJson(data))
  };
  const forged: InvestigationResults = {
    ...result.artifact,
    executions: [{ ...execution, outcome: "budget-displaced", cause: "source-window-budget-exceeded", evidenceIds: [...execution.evidenceIds, ledger.id] }],
    dispositions: result.artifact.dispositions.map((row) => ({ ...row, status: "displaced" as const, positiveKnowledge: false, evidenceIds: [...row.evidenceIds, ledger.id] })),
    summary: {
      ...result.artifact.summary,
      source: 0,
      fulfilled: 0,
      displaced: { executions: 1, dispositions: result.artifact.dispositions.length }
    }
  };
  assert.throws(() => requireInvestigationResults(forged, workset, obligations, [...result.evidence, ledger]), /covers the full authorized span/);
});

test("prepare binds every execution to L5/L6, projects decision dispositions, and audit catches result rewrites", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  const prepared = await prepareRun({
    target, workdir, codegraph, language: "en-US", detailLevel: "standard", overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave"], audiences: ["engineering"] }],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  });
  const resultPath = join(prepared.runDir, "investigation", "results.json");
  const result = JSON.parse(await readFile(resultPath, "utf8")) as ArtifactResult<InvestigationResults>;
  assert.equal(result.status, "built");
  assert.ok(result.value.executions.length > 0);
  assert.equal(result.value.executions.length, result.value.summary.authorized);
  assert.equal(result.value.dispositions.length,
    result.value.summary.fulfilled + result.value.summary.closedNegative + result.value.summary.pending + (result.value.summary.displaced?.dispositions ?? 0),
    "the four disposal buckets account for every decision-reading declaration");
  const plan = JSON.parse(await readFile(join(prepared.runDir, "workitems.json"), "utf8")) as InvestigationPlan;
  for (const disposition of result.value.dispositions.filter((row) => row.status === "fulfilled")) {
    const item = plan.items.find((row) => row.settledBy === disposition.executionId);
    assert.equal(item?.status, "found");
    assert.deepEqual(item?.evidenceIds, disposition.evidenceIds);
  }
  const declarationsText = await readFile(join(prepared.runDir, "obligations", "declarations.json"), "utf8");
  assert.doesNotMatch(declarationsText, /evidence/i, "L7 evidence ids never flow backward into L6");

  const rewritten: ArtifactResult<InvestigationResults> = {
    status: "built",
    value: { ...result.value, executions: [{ ...result.value.executions[0], readSpecId: "READ-UNAUTHORIZED" }, ...result.value.executions.slice(1)] }
  };
  await writeFile(resultPath, JSON.stringify(rewritten));
  const findings = (await auditRun(prepared.runDir)).findings;
  assert.ok(findings.some((finding) => finding.level === "error" && /results\.json violates its execution contract/.test(finding.message)));
  const frozen = await freezeRun(prepared.runDir);
  assert.equal(frozen.frozen, false);
  assert.ok(frozen.findings.some((finding) => /results\.json cannot be used at freeze/.test(finding.message)));
});
