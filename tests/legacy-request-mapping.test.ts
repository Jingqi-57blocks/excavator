import test from "node:test";
import assert from "node:assert/strict";
import type { Audience, DetailLevel, DocumentKind } from "../src/base/types.ts";
import { LEGACY_REQUEST_MAPPING_VERSION, mapLegacyDocumentRequest, type LegacyDocumentRequest } from "../src/report/legacy-request-mapping.ts";
import { REPORT_POLICY_VERSION } from "../src/report/report-policy-registry.ts";
import { parseReportRequestV2 } from "../src/report/report-request-v2.ts";

// The whole mapping, arm by arm. Six legal (kind, audience) pairs, one named refusal, and the two structural
// refusals a kind/featureKey mismatch has to land in. Nothing here is asserted by shape ("the audience is not
// product") — every arm's v2 row is written out in full, because the point of the slice is WHICH row each legacy
// request becomes, and a shape assertion would pass through a wrong intent.

function request(kind: DocumentKind, audience: Audience, featureKey: string | null, detailLevel: DetailLevel = "standard"): LegacyDocumentRequest {
  return { documentId: featureKey === null ? `overview-${audience}` : `feature-${featureKey}-${audience}`, kind, audience, featureKey, detailLevel, language: "zh-CN" };
}

const SHARED = { detailBudget: "standard", language: "zh-CN", policyVersion: REPORT_POLICY_VERSION } as const;

test("overview + product becomes a project-scope overview for the product manager", () => {
  assert.deepEqual(mapLegacyDocumentRequest(request("overview", "product", null)), {
    outcome: "mapped",
    request: { scope: "project", scopeIds: [], audience: "product-manager", intent: "overview", ...SHARED }
  });
});

test("overview + engineering becomes a project-scope overview for the engineer", () => {
  assert.deepEqual(mapLegacyDocumentRequest(request("overview", "engineering", null)), {
    outcome: "mapped",
    request: { scope: "project", scopeIds: [], audience: "engineer", intent: "overview", ...SHARED }
  });
});

test("overview + prd is refused BY NAME — the same verdict prepareRun's guard already gives", () => {
  const mapping = mapLegacyDocumentRequest(request("overview", "prd", null));
  assert.equal(mapping.outcome, "refused");
  assert.match(mapping.outcome === "refused" ? mapping.reason : "",
    /the prd audience is feature-only: no project-scope prd document exists/);
  // Not a default and not a fabricated row: there is no `request` on the refused arm at all.
  assert.ok(!("request" in mapping), JSON.stringify(mapping));
});

test("feature + product and feature + engineering become feature-scope deep dives for their readers", () => {
  assert.deepEqual(mapLegacyDocumentRequest(request("feature", "product", "leave-abc")), {
    outcome: "mapped",
    request: { scope: "feature", scopeIds: ["leave-abc"], audience: "product-manager", intent: "deep-dive", ...SHARED }
  });
  assert.deepEqual(mapLegacyDocumentRequest(request("feature", "engineering", "leave-abc")), {
    outcome: "mapped",
    request: { scope: "feature", scopeIds: ["leave-abc"], audience: "engineer", intent: "deep-dive", ...SHARED }
  });
});

test("feature + prd keeps the product manager as the reader and moves prd to the intent", () => {
  // This is the arm the legacy word conflated: `prd` was never a reader.
  assert.deepEqual(mapLegacyDocumentRequest(request("feature", "prd", "leave-abc")), {
    outcome: "mapped",
    request: { scope: "feature", scopeIds: ["leave-abc"], audience: "product-manager", intent: "prd", ...SHARED }
  });
});

test("the two product-manager feature documents differ only in intent, and the two overviews only in audience", () => {
  const productFeature = mapLegacyDocumentRequest(request("feature", "product", "leave-abc"));
  const prdFeature = mapLegacyDocumentRequest(request("feature", "prd", "leave-abc"));
  assert.ok(productFeature.outcome === "mapped" && prdFeature.outcome === "mapped");
  assert.deepEqual(
    Object.entries(productFeature.request).filter(([key, value]) => JSON.stringify(prdFeature.request[key as keyof typeof prdFeature.request]) !== JSON.stringify(value)).map(([key]) => key),
    ["intent"], "one reader, two document tasks — that separation is the point of v2");

  const product = mapLegacyDocumentRequest(request("overview", "product", null));
  const engineering = mapLegacyDocumentRequest(request("overview", "engineering", null));
  assert.ok(product.outcome === "mapped" && engineering.outcome === "mapped");
  assert.deepEqual(
    Object.entries(product.request).filter(([key, value]) => JSON.stringify(engineering.request[key as keyof typeof engineering.request]) !== JSON.stringify(value)).map(([key]) => key),
    ["audience"], "one boundary and one task, two readers");
});

test("detailLevel maps across by name, and nothing in the legacy vocabulary can ask for compact", () => {
  for (const [detailLevel, detailBudget] of [["standard", "standard"], ["detailed", "detailed"]] as const) {
    const mapping = mapLegacyDocumentRequest(request("overview", "product", null, detailLevel));
    assert.ok(mapping.outcome === "mapped");
    assert.equal(mapping.request.detailBudget, detailBudget);
  }
  // `compact` exists in the v2 enumeration and has no producer here. A mapping arm that reached it would be a
  // request nobody made, so the absence is asserted rather than assumed.
  const budgets = (["standard", "detailed"] as const).map((detailLevel) => {
    const mapping = mapLegacyDocumentRequest(request("feature", "prd", "leave-abc", detailLevel));
    return mapping.outcome === "mapped" ? mapping.request.detailBudget : null;
  });
  assert.deepEqual(budgets, ["standard", "detailed"]);
});

test("a kind/featureKey mismatch is refused by name in both directions — no combination falls through", () => {
  const strayKey = mapLegacyDocumentRequest({ ...request("overview", "product", null), featureKey: "leave-abc" });
  assert.equal(strayKey.outcome, "refused");
  assert.match(strayKey.outcome === "refused" ? strayKey.reason : "", /an overview document carries feature key "leave-abc"/);

  const missingKey = mapLegacyDocumentRequest({ ...request("feature", "product", "leave-abc"), featureKey: null });
  assert.equal(missingKey.outcome, "refused");
  assert.match(missingKey.outcome === "refused" ? missingKey.reason : "", /a feature document carries no feature key/);
});

test("every mapped row is a valid v2 request, and the mapping version is stated", () => {
  assert.equal(LEGACY_REQUEST_MAPPING_VERSION, "legacy-request-mapping-v1");
  const combinations: LegacyDocumentRequest[] = [];
  for (const kind of ["overview", "feature"] as const) {
    for (const audience of ["product", "engineering", "prd"] as const) {
      for (const detailLevel of ["standard", "detailed"] as const) {
        combinations.push(request(kind, audience, kind === "feature" ? "leave-abc" : null, detailLevel));
      }
    }
  }
  // Total: every one of the twelve combinations lands in a visible bucket, and the only refusals are the two
  // prd-overview ones.
  const refused = combinations.filter((combination) => mapLegacyDocumentRequest(combination).outcome === "refused");
  assert.deepEqual(refused.map((combination) => `${combination.kind}+${combination.audience}+${combination.detailLevel}`),
    ["overview+prd+standard", "overview+prd+detailed"]);
  for (const combination of combinations) {
    const mapping = mapLegacyDocumentRequest(combination);
    if (mapping.outcome === "refused") continue;
    assert.deepEqual(parseReportRequestV2(mapping.request).problems, [], JSON.stringify(combination));
  }
});
