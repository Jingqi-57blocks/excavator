import test from "node:test";
import assert from "node:assert/strict";
import type { AuditFinding, EvidenceItem, InvestigationPlan, InvestigationWorkItem, RunManifest } from "../src/base/types.ts";
import type { ContractManifest } from "../src/contract/contract-manifest.ts";
import { buildFreezeCompleteness } from "../src/freeze/completeness.ts";
import { readWindowDemand, readWindowShortfall } from "../src/investigation/read-budget.ts";
import { auditReadAccountability, reconcileReadCoverage } from "../src/investigation/read-coverage.ts";
import type { DecisionDisposition, InvestigationResults, ReadExecutionRecord } from "../src/investigation/read-execution.ts";
import { LOGIC_WORKITEM_DIMENSION } from "../src/obligation/logic-workitems.ts";
import type { ReadObligation } from "../src/obligation/read-obligations.ts";
import type { ReadSpec } from "../src/workset/read-specs.ts";
import { tempDir } from "./helpers.ts";

// THE CLIFF THIS FILE GUARDS. One budget-truncated read used to make a run permanently unsealable: the
// closure check errored per row on `investigation/results.json`, that file is written once at prepare, and no
// runtime mutator can reach it — so no work item could ever clear the finding. Measured: a four-document wcp
// run failed freeze with 1,777 errors of which 1,687 were unclearable, and 43 of 83 archived runs sat in that
// state with none of them ever frozen. Every test here is red under the old rule and red again if the
// downgrade is widened past the one predicate it is allowed to touch.

const SERVICE = "svc/internal/handlers/leave/service.go";

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

function execution(id: string, outcome: ReadExecutionRecord["outcome"], cause?: string): ReadExecutionRecord {
  return {
    id: `EXEC-${id}`,
    readSpecId: `READ-${id}`,
    declarationId: `OBL-READ-${id}`,
    path: SERVICE,
    requestedSpan: { startLine: 1, endLine: 10 },
    observedSpan: outcome === "source" ? { startLine: 1, endLine: 10 } : null,
    outcome,
    evidenceIds: [`LEDGER-READ-${id}`],
    ...(cause ? { cause } : {})
  };
}

function disposition(id: string, status: DecisionDisposition["status"]): DecisionDisposition {
  return {
    declarationId: `OBL-DEC-${id}`,
    readSpecId: `READ-${id}`,
    executionId: `EXEC-${id}`,
    status,
    positiveKnowledge: status === "fulfilled",
    evidenceIds: [`LEDGER-READ-${id}`]
  };
}

/** A hand-built L7 record. The closure check consumes it as data, so the rows can be posed directly. */
function results(executions: ReadExecutionRecord[], dispositions: DecisionDisposition[]): InvestigationResults {
  return {
    version: "read-execution-v1",
    identity: { snapshotId: "s", filesContentManifestDigest: "f", worksetDigest: "w", obligationsDigest: "o", judgementsDigest: "j", evidencePolicy: "p" },
    judgements: [],
    executions,
    dispositions,
    residuals: [],
    summary: {
      authorized: executions.length,
      source: executions.filter((row) => row.outcome === "source").length,
      empty: 0,
      unavailable: executions.filter((row) => row.outcome === "unavailable").length,
      fulfilled: dispositions.filter((row) => row.status === "fulfilled").length,
      closedNegative: 0,
      pending: dispositions.filter((row) => row.status === "pending").length,
      residuals: 0
    }
  };
}

const DEMAND = { requiredWindows: 892, availableWindows: 60, requiredRunWindowBudget: 900 };

/** Run only the closure family, so the findings under test are not mixed with unrelated check families. */
async function closure(investigationResults: InvestigationResults | null, demand: RunManifest["metrics"]["sourceWindowDemand"] | null = DEMAND) {
  const manifest = {
    assuranceVersion: "assurance-v16-epoch-seal-redaction-v7",
    metrics: { ...(demand ? { sourceWindowDemand: demand } : {}) }
  } as unknown as RunManifest;
  const contract = { checks: [{ family: "investigation-closure", version: "v1" }], expected: [] } as unknown as ContractManifest;
  const plan: InvestigationPlan = { version: 1, runId: "run", createdAt: "2026-01-01T00:00:00.000Z", items: [] };
  const result = await buildFreezeCompleteness({
    runDir: await tempDir(), manifest, contract, plan, investigationResults, contractFindings: [], evidence: []
  });
  return {
    findings: result.findings.filter((finding) => finding.document === "investigation-closure"),
    closure: result.completeness.closure
  };
}

function levels(findings: AuditFinding[]): { errors: AuditFinding[]; warnings: AuditFinding[] } {
  return { errors: findings.filter((row) => row.level === "error"), warnings: findings.filter((row) => row.level === "warning") };
}

test("the source-window demand is layer 5's own per-spec authorization, summed — not an estimate", () => {
  const specs = [spec("READ-a", "a.ts", 1, 240), spec("READ-b", "b.ts", 1, 241), spec("READ-c", "c.ts", 10, 10)];
  assert.deepEqual(specs.map((row) => row.budget.windows), [1, 2, 1], "the per-spec figure is L5's, validated there against ceil(span / 240)");

  const short = readWindowDemand(specs, { total: 10, consumed: 8 });
  assert.equal(short.requiredWindows, 4);
  assert.equal(short.availableWindows, 2, "the ceiling minus what prepare already spent");
  assert.equal(short.deficit, 2);
  assert.equal(short.requiredRunWindowBudget, 12, "the run-level number an operator can set in one step");
  assert.match(readWindowShortfall(short) ?? "", /--max-source-windows 12/);

  // The remainder-derived advice this replaces: prepare had spent the whole ceiling, so the old message said
  // "increase --max-source-windows (e.g. 0)" — advice that cannot be followed.
  const exhausted = readWindowDemand(specs, { total: 8, consumed: 8 });
  assert.equal(exhausted.availableWindows, 0);
  assert.equal(exhausted.requiredRunWindowBudget, 12);
  assert.doesNotMatch(readWindowShortfall(exhausted) ?? "", /--max-source-windows 0\b/);

  assert.equal(readWindowShortfall(readWindowDemand(specs, { total: 40, consumed: 8 })), null,
    "no sentence when the ceiling is not binding: an advisory that is necessarily true every time trains the reader to ignore advisories");
});

test("a budget-displaced read is a recorded limitation: one advisory, no error, and the number to re-prepare with", async () => {
  const { findings, closure: sealed } = await closure(results(
    [execution("one", "budget-displaced", "source-window-budget-exceeded"), execution("two", "budget-displaced", "source-character-budget-exceeded")],
    [disposition("one", "displaced"), disposition("two", "displaced")]
  ));
  const { errors, warnings } = levels(findings);
  assert.deepEqual(errors, [], "an exhausted ceiling this run recorded itself does not invalidate the run");
  assert.equal(warnings.length, 1, "one aggregate line for the whole displaced set, not one finding per row");
  assert.match(warnings[0].message, /displaced by a recorded budget ceiling/);
  assert.match(warnings[0].message, /source-window-budget-exceeded 1/);
  assert.match(warnings[0].message, /source-character-budget-exceeded 1/);
  assert.match(warnings[0].message, /--max-source-windows 900/);
  assert.equal(sealed.readsDisplacedByBudget, 2);
  assert.equal(sealed.decisions.displaced, 2);
  assert.equal(sealed.decisions.positive + sealed.decisions.negative + sealed.decisions.pending + sealed.decisions.displaced, 2,
    "the four disposal buckets account for every decision-reading declaration");
});

test("the source failing to yield is still fatal, and is not laundered by the displacement bucket", async () => {
  const { findings } = await closure(results(
    [execution("gone", "unavailable", "source-read-enoent"), execution("escaped", "unavailable", "source-path-rejected")],
    [disposition("gone", "pending")]
  ));
  const { errors, warnings } = levels(findings);
  assert.equal(errors.length, 3, "two unreadable sources plus the undisposed decision reading");
  assert.ok(errors.some((row) => /source-reading OBL-READ-gone remains pending: source-read-enoent/.test(row.message)));
  assert.ok(errors.some((row) => /source-reading OBL-READ-escaped remains pending: source-path-rejected/.test(row.message)));
  assert.ok(errors.some((row) => /decision-reading OBL-DEC-gone remains pending/.test(row.message)));
  assert.deepEqual(warnings, [], "nothing was displaced, so nothing is advised");
});

test("a run with no source-window demand recorded says so instead of naming a number it does not have", async () => {
  const { findings } = await closure(results([execution("one", "budget-displaced", "source-window-budget-exceeded")], []), null);
  const { warnings } = levels(findings);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /recorded no source-window demand figure/);
  assert.doesNotMatch(warnings[0].message, /--max-source-windows/, "absence is stated, never rendered as a figure");
});

// 57B-449's shape, inside the record this slice writes: an empty denominator must not read like full coverage.
test("no authorized reading, all reading completed, and no results at all are three distinguishable records", async () => {
  const none = await closure(results([], []));
  assert.equal(none.closure.authorizedReads, 0);
  assert.deepEqual(levels(none.findings).errors, []);

  const complete = await closure(results([execution("one", "source")], [disposition("one", "fulfilled")]));
  assert.equal(complete.closure.authorizedReads, 1);
  assert.equal(complete.closure.decisions.positive, 1);
  assert.equal(complete.closure.readsDisplacedByBudget, 0);
  assert.deepEqual(levels(complete.findings).errors, []);

  const missing = await closure(null);
  assert.equal(missing.closure.authorizedReads, undefined, "absent means the check never saw the results — not zero reads");
  assert.equal(levels(missing.findings).errors.length, 1);
});

// The predicate the downgrade is forbidden to touch. A displaced read records a ledger row and no source
// window, so a work item disposed `found` on the strength of it is a false ledger entry — and stays an error.
test("a work item disposed found over a displaced read is still a hard error", () => {
  const obligation: ReadObligation = {
    id: `feature:feature-a:logic:Approve@${SERVICE}:362`,
    kind: "decision-function",
    featureKey: "feature-a",
    name: "Approve",
    path: SERVICE,
    startLine: 362,
    endLine: 739,
    lines: 378,
    tier: 0,
    gated: true
  };
  const ledger: EvidenceItem = {
    id: "LEDGER-READ-displaced",
    snapshotId: "s",
    kind: "ledger",
    title: `Budget-displaced authorized read: ${SERVICE}`,
    data: { recordType: "read-execution", outcome: "budget-displaced", cause: "source-window-budget-exceeded" },
    reason: "nothing was read",
    digest: "d"
  };
  const item: InvestigationWorkItem = {
    id: obligation.id,
    dimension: LOGIC_WORKITEM_DIMENSION,
    scope: "feature:feature-a",
    hypothesis: "h",
    status: "found",
    material: true,
    requiredFor: ["feature-feature-a-engineering"],
    evidenceIds: [ledger.id],
    traceIds: [],
    origin: "default"
  };
  const report = reconcileReadCoverage({ obligations: [obligation], evidence: [ledger] });
  const errors = auditReadAccountability({
    obligations: [obligation],
    workItems: [item],
    evidenceById: new Map([[ledger.id, ledger]]),
    report
  }).filter((finding) => finding.level === "error");
  assert.equal(errors.length, 1, "a limitation record is not a source window, and citing one is not reading");
  assert.match(errors[0].message, /disposed found/);
  assert.match(errors[0].message, /362-739/);
});
