import test from "node:test";
import assert from "node:assert/strict";
import {
  DETAIL_BUDGETS,
  REPORT_AUDIENCES,
  REPORT_INTENTS,
  REPORT_SCOPES,
  parseReportRequestV2,
  type ReportRequestV2
} from "../src/report/report-request-v2.ts";

// The v2 model is a RECORD format before it is a premise: every row in `report/requests.json` is parsed back
// through `parseReportRequestV2`, so what this file pins is which rows the parser refuses. A parser that accepted
// a row with an unknown intent, or a project request carrying feature ids, would let a hand-edited artifact read
// as a request nobody made.

const VALID: ReportRequestV2 = {
  scope: "feature", scopeIds: ["leave-abc"], audience: "product-manager", intent: "prd",
  detailBudget: "standard", language: "zh-CN", policyVersion: "report-policy-v1"
};

test("the four dimensions are separate enumerations, and none of them is a subset of another", () => {
  // The whole point of v2: `product` was a reader, `prd` a document task, `overview` a boundary. They now live in
  // three lists, and the only name they share is `overview`/`prd` as INTENTS, not audiences.
  assert.deepEqual([...REPORT_SCOPES], ["project", "domain", "feature", "flow", "component", "change"]);
  assert.deepEqual([...REPORT_AUDIENCES], ["product-manager", "engineer", "architect", "sre", "qa", "security", "executive"]);
  assert.deepEqual([...REPORT_INTENTS], ["overview", "deep-dive", "onboarding", "reference", "prd", "audit", "decision-support", "change-impact"]);
  assert.deepEqual([...DETAIL_BUDGETS], ["compact", "standard", "detailed"]);
  for (const audience of REPORT_AUDIENCES) assert.ok(!(REPORT_INTENTS as readonly string[]).includes(audience), `${audience} is a reader, not a document task`);
});

test("a well-formed row parses to itself", () => {
  const parsed = parseReportRequestV2(VALID);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.request, VALID);
});

test("every dimension is checked against its enumeration by name", () => {
  for (const [field, value] of [["scope", "repository"], ["audience", "product"], ["intent", "engineering"], ["detailBudget", "verbose"]] as const) {
    const parsed = parseReportRequestV2({ ...VALID, [field]: value });
    assert.equal(parsed.request, null);
    assert.ok(parsed.problems.some((problem) => problem.startsWith(`${field} "${value}" is not one of`)), `${field}: ${JSON.stringify(parsed.problems)}`);
  }
});

test("a missing field is a named problem, never a default", () => {
  for (const field of ["scope", "scopeIds", "audience", "intent", "detailBudget", "language", "policyVersion"] as const) {
    const row: Record<string, unknown> = { ...VALID };
    delete row[field];
    const parsed = parseReportRequestV2(row);
    assert.equal(parsed.request, null, `${field} must not be optional`);
    assert.ok(parsed.problems.some((problem) => problem.startsWith(field)), `${field}: ${JSON.stringify(parsed.problems)}`);
  }
});

test("an extra field is named rather than ignored — the row would have been written by something else", () => {
  const parsed = parseReportRequestV2({ ...VALID, topicIds: ["T-1"] });
  assert.equal(parsed.request, null);
  assert.deepEqual(parsed.problems, ['has unknown field "topicIds"']);
});

test("project scope carries no scopeIds, and every other scope must carry at least one", () => {
  const project = parseReportRequestV2({ ...VALID, scope: "project", scopeIds: [] });
  assert.deepEqual(project.problems, []);

  const overreach = parseReportRequestV2({ ...VALID, scope: "project", scopeIds: ["leave-abc"] });
  assert.equal(overreach.request, null);
  assert.match(overreach.problems.join(" "), /scope "project" names 1 scopeIds/);

  for (const scope of ["domain", "feature", "flow", "component", "change"] as const) {
    const empty = parseReportRequestV2({ ...VALID, scope, scopeIds: [] });
    assert.equal(empty.request, null, scope);
    assert.match(empty.problems.join(" "), new RegExp(`scope "${scope}" names no scopeIds`));
  }
});

test("scopeIds must be sorted and deduplicated so one boundary cannot have two byte forms", () => {
  for (const ids of [["b", "a"], ["a", "a"]]) {
    const parsed = parseReportRequestV2({ ...VALID, scope: "domain", scopeIds: ids });
    assert.equal(parsed.request, null, JSON.stringify(ids));
    assert.match(parsed.problems.join(" "), /is not sorted and deduplicated/);
  }
  assert.deepEqual(parseReportRequestV2({ ...VALID, scope: "domain", scopeIds: ["a", "b"] }).problems, []);
});

test("a non-object, an array and an empty language all fail by name instead of parsing to a hole", () => {
  assert.match(parseReportRequestV2(null).problems.join(" "), /is null, not a request object/);
  assert.match(parseReportRequestV2([VALID]).problems.join(" "), /is an array, not a request object/);
  assert.match(parseReportRequestV2({ ...VALID, language: "  " }).problems.join(" "), /language "  " is not a non-empty string/);
  assert.match(parseReportRequestV2({ ...VALID, scopeIds: ["ok", ""] }).problems.join(" "), /is not an array of non-empty strings/);
});
