import test from "node:test";
import assert from "node:assert/strict";
import { auditChecklist, workItemsToChecklist } from "../src/assurance/assurance.ts";
import type { ChecklistItem, EvidenceItem, InvestigationChecklist, InvestigationPlan, InvestigationWorkItem } from "../src/core/types.ts";

// 57B-354 #6a: a `not-applicable` disposition is valid with only a reason, and must not be projected
// through the strict `cannot-determine` contract (reason + settledBy + limitation evidence). Synthetic
// fixtures only — never a real target repo/route/table name.

function item(partial: Partial<ChecklistItem> & Pick<ChecklistItem, "id" | "verdict">): ChecklistItem {
  return { scope: "feature:leave", hypothesis: "synthetic hypothesis", material: false, evidenceIds: [], origin: "default", ...partial };
}

function checklist(items: ChecklistItem[]): InvestigationChecklist {
  return { version: 1, runId: "run-synth", items };
}

function workItem(partial: Partial<InvestigationWorkItem> & Pick<InvestigationWorkItem, "id" | "status">): InvestigationWorkItem {
  return { dimension: "open-investigation", scope: "feature:leave", hypothesis: "synthetic", material: false, requiredFor: [], evidenceIds: [], traceIds: [], origin: "default", ...partial };
}

const NO_EVIDENCE = new Map<string, EvidenceItem>();
const errors = (findings: ReturnType<typeof auditChecklist>) => findings.filter((finding) => finding.level === "error");

test("a not-applicable checklist item backed only by a reason passes a full-run audit", () => {
  const actual = checklist([item({ id: "feature:leave:x", verdict: "not-applicable", reason: "the flow does not exist in this scope" })]);
  const expected = checklist([item({ id: "feature:leave:x", verdict: "pending" })]);
  assert.deepEqual(errors(auditChecklist(actual, expected, NO_EVIDENCE)), []);
});

test("a not-applicable item with no reason still errors", () => {
  const actual = checklist([item({ id: "feature:leave:x", verdict: "not-applicable" })]);
  const expected = checklist([item({ id: "feature:leave:x", verdict: "pending" })]);
  assert.ok(errors(auditChecklist(actual, expected, NO_EVIDENCE)).some((finding) => /not-applicable item requires a reason/.test(finding.message)));
});

test("a cannot-determine item still keeps its strict contract (reason + settledBy + limitation evidence)", () => {
  const actual = checklist([item({ id: "feature:leave:y", verdict: "cannot-determine", reason: "the index did not resolve the handler" })]);
  const expected = checklist([item({ id: "feature:leave:y", verdict: "pending" })]);
  const found = errors(auditChecklist(actual, expected, NO_EVIDENCE));
  assert.ok(found.some((finding) => /cannot-determine item requires reason and settledBy/.test(finding.message)));
  assert.ok(found.some((finding) => /cannot-determine item has no evidence/.test(finding.message)));
});

test("workItemsToChecklist round-trips a not-applicable work item to a not-applicable verdict a full-run audit accepts", () => {
  const plan: InvestigationPlan = {
    version: 1,
    runId: "run-synth",
    createdAt: "2026-01-01T00:00:00.000Z",
    items: [workItem({ id: "feature:leave:z", status: "not-applicable", reason: "not present in scope" })]
  };
  const projected = workItemsToChecklist(plan);
  assert.equal(projected.items[0].verdict, "not-applicable");
  const expected = checklist([item({ id: "feature:leave:z", verdict: "pending" })]);
  assert.deepEqual(errors(auditChecklist(projected, expected, NO_EVIDENCE)), []);
});
