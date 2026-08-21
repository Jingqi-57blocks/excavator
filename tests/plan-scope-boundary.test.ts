/**
 * The knowledge boundary a recorded request names, checked at the place that mints units for it.
 *
 * WHAT WAS MEASURED BEFORE THIS EXISTED (57B-434 R6d's suspended item #7): a request row with
 * `scope: feature, scopeIds: ["this-feature-does-not-exist"]` produced a plan that validated `complete` and a
 * whole document of authoring units, because nothing downstream reads either field — `buildFixturePlan` does not,
 * and validation did not. The append door now checks the key it writes (`request-append-boundary.ts`); this is the
 * same law at the consumer, over whatever wrote `plan/requests.json`, which is a file on disk re-read at every
 * plan action.
 *
 * THE FOUR SCOPES WITH NO PRODUCER ARE TESTED TOO, and that is the point of testing them: `domain`, `flow`,
 * `component` and `change` are in the vocabulary with no way to attribute knowledge to them, so a plan over one
 * must say so rather than pass by having nothing to compare against. Whoever adds the producer adds the resolver.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { catalogFeatureKeys, scopeBoundaryProblems } from "../src/report/plan-scope-boundary.ts";
import { validatePlan } from "../src/report/plan-validation.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { REPORT_SCOPES, type ReportScope } from "../src/report/report-request-v2.ts";
import type { ReportRequestsArtifact } from "../src/report/report-requests-artifact.ts";
import type { LegacyDocumentRequest } from "../src/report/legacy-request-mapping.ts";
import { MINI_DOCUMENTS, MINI_LEAVE_FEATURE, miniRequests, miniRun } from "./plan-fixture.ts";

/** One feature document, with the boundary key as the parameter under test. */
function featureDocument(featureKey: string): LegacyDocumentRequest {
  return {
    documentId: `feature-${featureKey}-product`,
    kind: "feature", audience: "product", featureKey, detailLevel: "standard", language: "en-US"
  };
}

/** Re-scope one recorded row, so the four producer-less scopes can be reached without inventing a producer. */
function rescoped(requests: ReportRequestsArtifact, documentId: string, scope: ReportScope): ReportRequestsArtifact {
  return {
    ...requests,
    requests: requests.requests.map((record) => record.documentId === documentId
      ? { ...record, request: { ...record.request, scope, scopeIds: ["some-id"] } }
      : record)
  };
}

test("the bound feature keys a plan checks against are the catalog's own feature rows", async () => {
  const { catalog } = await miniRun();
  assert.deepEqual(catalogFeatureKeys(catalog), ["leave-1a2b3c4d5e", "promo-9f8e7d6c5b"]);
  assert.ok(catalogFeatureKeys(catalog).includes(MINI_LEAVE_FEATURE), "the requested feature is one of them");
});

test("the recorded request set of the fixture run has no boundary problem", async () => {
  const { catalog, requests } = await miniRun();
  assert.deepEqual(scopeBoundaryProblems(catalog, requests), []);
});

test("a feature document bounded to a key the run did not investigate is a named plan violation", async () => {
  const { catalog, requests: recorded, evidenceById, reach, epochCoverage } = await miniRun();
  const requests = miniRequests([...MINI_DOCUMENTS, featureDocument("leave-1a2b3c4d5f")]);
  assert.deepEqual(scopeBoundaryProblems(catalog, requests), [
    'document "feature-leave-1a2b3c4d5f-product" is bounded to feature "leave-1a2b3c4d5f", which this run did not investigate (bound features: leave-1a2b3c4d5e, promo-9f8e7d6c5b); its units would be written from knowledge the run does not hold'
  ], "one character off a bound key is a whole document with no knowledge behind it");

  // And it reaches the verdict rather than sitting in a list nobody reads: the plan over the same catalog is a
  // legal one by construction, so `violations` here is this rule and nothing else.
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const report = validatePlan({ catalog, requests, proposal, registry: REPORT_POLICY_REGISTRY, budgetTable: PLAN_BUDGET_TABLE, evidence: evidenceById, reach, epochCoverage });
  assert.equal(report.overall.conclusion, "violations");
  assert.ok(report.problems.some((problem) => /bounded to feature "leave-1a2b3c4d5f", which this run did not investigate/.test(problem)));

  // The reverse direction, on the same inputs: the recorded set validates.
  const legal = validatePlan({ catalog, requests: recorded, proposal: buildFixturePlan(catalog, recorded, PLAN_BUDGET_TABLE), registry: REPORT_POLICY_REGISTRY, budgetTable: PLAN_BUDGET_TABLE, evidence: evidenceById, reach, epochCoverage });
  assert.deepEqual(legal.problems.filter((problem) => /bounded to feature/.test(problem)), []);
});

test("a run that binds no feature says so, instead of listing an empty set of keys", async () => {
  const { catalog } = await miniRun();
  const featureless = { ...catalog, topics: catalog.topics.filter((topic) => topic.facet !== "feature") };
  assert.deepEqual(catalogFeatureKeys(featureless), []);
  assert.deepEqual(scopeBoundaryProblems(featureless, miniRequests([featureDocument(MINI_LEAVE_FEATURE)])), [
    `document "feature-${MINI_LEAVE_FEATURE}-product" is bounded to feature "${MINI_LEAVE_FEATURE}" and this run binds no feature at all, so the document has no knowledge to be written from`
  ]);
});

test("every scope in the vocabulary lands in a visible bucket, including the four with no producer", async () => {
  const { catalog, requests } = await miniRun();
  const resolvable = new Set<ReportScope>(["project", "feature"]);
  for (const scope of REPORT_SCOPES) {
    if (resolvable.has(scope)) continue;
    const problems = scopeBoundaryProblems(catalog, rescoped(requests, "overview-product", scope));
    assert.deepEqual(problems, [
      `document "overview-product" is bounded to scope ${JSON.stringify(scope)} (some-id), and the catalog projects no facet that resolves that boundary; a plan cannot bound its units to a scope nothing attributes knowledge to`
    ], `${scope} must be named, not passed over`);
  }
  // And the two that DO resolve are not swept up by the same arm.
  assert.deepEqual(scopeBoundaryProblems(catalog, requests), []);
});
