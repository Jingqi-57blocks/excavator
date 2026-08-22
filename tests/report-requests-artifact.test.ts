import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReportRequest } from "../src/base/types.ts";
import { prepareRun } from "../src/run/run.ts";
import { LEGACY_REQUEST_MAPPING_VERSION, type LegacyDocumentRequest } from "../src/report/legacy-request-mapping.ts";
import { intentPolicyFor, lensPolicyFor, policyReference, REPORT_POLICY_VERSION } from "../src/report/report-policy-registry.ts";
import {
  REPORT_REQUESTS_ARTIFACT_VERSION,
  buildReportRequestsArtifact,
  readReportRequests,
  reportRequestsPath,
  reportRequestsProblems,
  writeReportRequests,
  type ReportRequestsArtifact
} from "../src/report/report-requests-artifact.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

// `plan/requests.json` is the audit trail for "which reader, which task, which boundary, under which policy
// bytes". Two things have to hold for it to be worth anything: the bytes are a function of the request (so two
// prepares of one request agree), and reading it back refuses anything that was edited (so a digest in the file
// is evidence, not decoration).

function document(kind: "overview" | "feature", audience: "product" | "engineering" | "prd", featureKey: string | null): LegacyDocumentRequest {
  return {
    documentId: featureKey === null ? `overview-${audience}` : `feature-${featureKey}-${audience}`,
    kind, audience, featureKey, detailLevel: "standard", language: "zh-CN"
  };
}

const OVERVIEW_PRODUCT = document("overview", "product", null);
const OVERVIEW_ENGINEERING = document("overview", "engineering", null);
const FEATURE_PRD = document("feature", "prd", "leave-abc");

test("a record carries the v2 row plus the digest of the exact policy bytes it was resolved against", () => {
  const artifact = buildReportRequestsArtifact([FEATURE_PRD]);
  assert.deepEqual(artifact, {
    version: REPORT_REQUESTS_ARTIFACT_VERSION,
    requests: [{
      documentId: "feature-leave-abc-prd",
      request: {
        scope: "feature", scopeIds: ["leave-abc"], audience: "product-manager", intent: "prd",
        detailBudget: "standard", language: "zh-CN", policyVersion: REPORT_POLICY_VERSION
      },
      lensPolicy: policyReference(lensPolicyFor("product-manager")),
      intentPolicy: policyReference(intentPolicyFor("prd")),
      mappingVersion: LEGACY_REQUEST_MAPPING_VERSION
    }]
  });
});

test("rows are ordered by document id whatever order the documents arrive in", () => {
  const forward = buildReportRequestsArtifact([OVERVIEW_PRODUCT, OVERVIEW_ENGINEERING]);
  const reverse = buildReportRequestsArtifact([OVERVIEW_ENGINEERING, OVERVIEW_PRODUCT]);
  assert.deepEqual(forward, reverse, "the requests are a set keyed by document, so their order is canonical");
  assert.deepEqual(forward.requests.map((row) => row.documentId), ["overview-engineering", "overview-product"]);
});

test("a document the mapping refuses is a hard error naming the document, never an omitted row", () => {
  assert.throws(() => buildReportRequestsArtifact([document("overview", "prd", null)]),
    /Document "overview-prd" has no v2 request: the prd audience is feature-only/);
});

test("two documents with one id fail by name — a recorded request must name exactly one document", () => {
  assert.throws(() => buildReportRequestsArtifact([OVERVIEW_PRODUCT, { ...OVERVIEW_PRODUCT, audience: "engineering" }]),
    /Two planned documents share the id "overview-product"/);
});

test("write, read back, and write again: the same request set is a no-op, a different one fails by name", async () => {
  const runDir = await tempDir("excavator-requests-");
  const written = await writeReportRequests(runDir, [OVERVIEW_PRODUCT, OVERVIEW_ENGINEERING]);
  const bytes = await readFile(reportRequestsPath(runDir), "utf8");
  assert.deepEqual(await readReportRequests(runDir), written);

  await writeReportRequests(runDir, [OVERVIEW_ENGINEERING, OVERVIEW_PRODUCT]);
  assert.equal(await readFile(reportRequestsPath(runDir), "utf8"), bytes, "rewriting the same set must not move a byte");

  await assert.rejects(() => writeReportRequests(runDir, [OVERVIEW_PRODUCT]),
    /already records a different request set; report requests are written once per run/);
  assert.equal(await readFile(reportRequestsPath(runDir), "utf8"), bytes, "the refused write must leave the record alone");
});

test("a hand-edited file fails to read by name — every edit, and never a silent empty", async () => {
  const runDir = await tempDir("excavator-requests-");
  await writeReportRequests(runDir, [FEATURE_PRD]);
  const path = reportRequestsPath(runDir);
  const original = JSON.parse(await readFile(path, "utf8")) as ReportRequestsArtifact;

  const mutations: Array<[string, unknown, RegExp]> = [
    ["a truncated file", null, /could not be read as JSON/],
    ["a wrong artifact version", { ...original, version: "report-requests-v0" }, /version "report-requests-v0" is not report-requests-v1/],
    ["an extra artifact field", { ...original, topics: [] }, /has unknown field "topics"/],
    ["requests that are not an array", { ...original, requests: {} }, /requests \{\} is not an array/],
    ["an unknown audience", { ...original, requests: [{ ...original.requests[0], request: { ...original.requests[0].request, audience: "product" } }] }, /requests\[0\] request audience "product" is not one of/],
    ["a swapped lens policy", { ...original, requests: [{ ...original.requests[0], lensPolicy: policyReference(lensPolicyFor("engineer")) }] }, /requests\[0\] lensPolicy .* is not the registry's/],
    ["a hand-edited digest", { ...original, requests: [{ ...original.requests[0], intentPolicy: { ...original.requests[0].intentPolicy, digest: "0".repeat(64) } }] }, /requests\[0\] intentPolicy .* is not the registry's/],
    ["a foreign mapping version", { ...original, requests: [{ ...original.requests[0], mappingVersion: "hand-written" }] }, /requests\[0\] mappingVersion "hand-written" is not legacy-request-mapping-v1/],
    ["a foreign policy version", { ...original, requests: [{ ...original.requests[0], request: { ...original.requests[0].request, policyVersion: "report-policy-v99" } }] }, /request policyVersion "report-policy-v99" is not the registry's/],
    ["rows out of order", { ...original, requests: [{ ...original.requests[0], documentId: "zz" }, { ...original.requests[0], documentId: "aa" }] }, /does not follow "zz"; the rows must be strictly ascending/]
  ];
  for (const [name, content, expected] of mutations) {
    await writeFile(path, content === null ? "{ not json" : JSON.stringify(content, null, 2));
    await assert.rejects(() => readReportRequests(runDir), expected, name);
  }

  // And a deleted file is a missing file, not an empty request set.
  await rm(path);
  await assert.rejects(() => readReportRequests(runDir), /could not be read as JSON/);
});

test("the validator reports every problem in one pass rather than the first one it meets", () => {
  const problems = reportRequestsProblems({
    version: "wrong",
    requests: [{ documentId: "", mappingVersion: "x", request: {}, lensPolicy: {}, intentPolicy: {} }]
  });
  assert.ok(problems.length >= 4, JSON.stringify(problems));
  assert.ok(problems.some((problem) => /version "wrong"/.test(problem)));
  assert.ok(problems.some((problem) => /documentId ""/.test(problem)));
  assert.ok(problems.some((problem) => /mappingVersion "x"/.test(problem)));
  assert.ok(problems.some((problem) => /request scope undefined is not one of/.test(problem)));
  // A non-object at the top and a non-object row both land in a named bucket.
  assert.deepEqual(reportRequestsProblems([]), ["is not an artifact object"]);
  assert.deepEqual(reportRequestsProblems({ version: REPORT_REQUESTS_ARTIFACT_VERSION, requests: [7] }), ["requests[0] is not a record object"]);
});

// --- prepare writes it: the record of the run's actual request set ----------------------------------------------

async function overviewRequest(audiences: Array<"product" | "engineering">): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return {
    target, codegraph, workdir, language: "zh-CN", detailLevel: "standard",
    overviewAudiences: audiences, features: [],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  };
}

test("prepare records one row per planned document; two prepares of one request agree byte for byte", async () => {
  const first = await prepareRun(await overviewRequest(["product", "engineering"]));
  const second = await prepareRun(await overviewRequest(["product", "engineering"]));
  const firstBytes = await readFile(reportRequestsPath(first.runDir), "utf8");
  const secondBytes = await readFile(reportRequestsPath(second.runDir), "utf8");
  assert.equal(firstBytes, secondBytes, "the record is a function of the request, not of the run id or the clock");

  const artifact = await readReportRequests(first.runDir);
  assert.deepEqual(artifact.requests.map((row) => row.documentId), ["overview-engineering", "overview-product"]);
  assert.deepEqual(artifact.requests.map((row) => row.documentId).sort(), first.manifest.documents.map((doc) => doc.id).sort(),
    "every planned document has a recorded request and nothing else does");

  // The epic's R1 acceptance: one scope, two audiences, from one knowledge boundary. The two rows differ in the
  // reader and its lens — and in nothing else.
  const [engineering, product] = artifact.requests;
  assert.deepEqual(
    Object.entries(product.request).filter(([key, value]) => JSON.stringify(engineering.request[key as keyof typeof engineering.request]) !== JSON.stringify(value)).map(([key]) => key),
    ["audience"]);
  assert.deepEqual([engineering.request.audience, product.request.audience], ["engineer", "product-manager"]);
  assert.notEqual(engineering.lensPolicy.digest, product.lensPolicy.digest);
  assert.deepEqual(engineering.intentPolicy, product.intentPolicy, "one boundary, one task: the intent policy is shared");
  assert.equal(product.request.scope, "project");
  assert.deepEqual(product.request.scopeIds, []);
});

test("prepare refuses a request that names one document twice — the one behaviour this slice tightens", async () => {
  // `--overview product,product` (and `--overview both,product`) reaches prepare with two identical planned
  // documents: `csv`/`audiences` in the CLI do not deduplicate, and neither `plannedDocuments`,
  // `materializeBoundRunContract` nor `createInvestigationPlan` refuses the repeat. MEASURED on the base commit
  // (`feat-434-report-authoring-dag`, 02153ed): that command prepared "successfully" and wrote a malformed run —
  // `run.json` listed `overview-product` twice and `contract/requirements.json` carried 22 rows of which only 12
  // are distinct once the `REQ-xx` id is ignored, i.e. every document row twice.
  //
  // The recorded request set is the first place that can see it, and it refuses BY NAME instead of collapsing the
  // repeat: deduplicating here would trade one loud failure for a silent guess about what `product,product` meant.
  // This is the one behaviour change in the slice, and it is deliberate.
  const duplicated = await overviewRequest(["product", "product"]);
  await assert.rejects(() => prepareRun(duplicated), /Two planned documents share the id "overview-product"/);
});

test("an overview-only request mints no feature rows", async () => {
  // The cebreo shape: a target asked for one overview and nothing else. A row for a feature nobody requested
  // would be a request the operator never made.
  const { runDir, manifest } = await prepareRun(await overviewRequest(["product"]));
  const artifact = await readReportRequests(runDir);
  assert.deepEqual(artifact.requests.map((row) => row.documentId), ["overview-product"]);
  assert.deepEqual(manifest.request.features, []);
  assert.equal(artifact.requests[0].request.scope, "project");
  assert.ok(artifact.requests.every((row) => row.request.scopeIds.length === 0));
});
