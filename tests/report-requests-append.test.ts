/**
 * `plan/requests.json` grows by appending, and by nothing else.
 *
 * WHAT HAS TO BE TRUE FOR THE SECOND AUDIENCE TO BE REACHABLE. Prepare writes the request set once, so before this
 * slice there was no supported way to ask for one more document inside a knowledge epoch — and that is precisely
 * the epic's headline case. The door added here is append-only, and this file is where that claim is tested from
 * both sides: what an append does (one row added, every recorded row byte for byte identical) and what it refuses
 * (a duplicate document, a changed row, a removed row, more than one row at a time).
 *
 * AND WHAT AN APPEND DELIBERATELY BREAKS. The recorded plan was validated against the request set as it was, so
 * after an append it no longer covers it. The authoring gate refuses BY NAME with the remedy, and a recorded plan
 * revision restores it. That window is the whole reason `plan --revise` and this door ship together: either half
 * alone leaves the epic's case unreachable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stableJson, writeJson } from "../src/base/util.ts";
import { plannedDocumentId, type LegacyDocumentRequest } from "../src/report/legacy-request-mapping.ts";
import { assertValidatedPlanForAuthoring } from "../src/report/plan-gate.ts";
import { appendReportRequest, appendedRequestSet, assertRequestsOnlyAppended } from "../src/report/report-requests-append.ts";
import {
  buildReportRequestsArtifact,
  readReportRequests,
  reportRequestsPath,
  type ReportRequestsArtifact
} from "../src/report/report-requests-artifact.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { manifestOf, plannedRun } from "./unit-fixture.ts";

/** The engineering overview of a run whose request set names only the product one. */
function secondAudience(language: string): LegacyDocumentRequest {
  return {
    documentId: plannedDocumentId("overview", "engineering", null),
    kind: "overview",
    audience: "engineering",
    featureKey: null,
    detailLevel: "standard",
    language
  };
}

const FIRST: LegacyDocumentRequest = {
  documentId: plannedDocumentId("overview", "product", null),
  kind: "overview", audience: "product", featureKey: null, detailLevel: "standard", language: "zh-CN"
};

// --- ① what an append does ----------------------------------------------------------------------------

test("appending one document adds exactly one row and leaves every recorded row byte for byte", async () => {
  const run = await plannedRun(["product"]);
  const before = await readReportRequests(run.runDir);
  assert.deepEqual(before.requests.map((row) => row.documentId), ["overview-product"]);

  const result = await appendReportRequest(run.runDir, secondAudience(run.manifest.request.language));
  assert.equal(result.path, reportRequestsPath(run.runDir));
  assert.equal(result.appended.documentId, "overview-engineering");
  assert.equal(result.appended.request.audience, "engineer", "the row goes through the same mapping prepare uses");
  assert.equal(result.appended.mappingVersion, before.requests[0]!.mappingVersion);

  const after = await readReportRequests(run.runDir);
  assert.deepEqual(after.requests.map((row) => row.documentId), ["overview-engineering", "overview-product"], "the rows stay ascending by document");
  assert.equal(stableJson(after.requests.find((row) => row.documentId === "overview-product")), stableJson(before.requests[0]),
    "the row that was already recorded is the same bytes");
  assert.equal(after.version, before.version);
  // And what was written is what the reader validates: the file, not the value the call returned.
  assert.equal(stableJson(after), stableJson(result.artifact));
});

test("the appended row is the row prepare would have written for the same request", async () => {
  const run = await plannedRun(["product"]);
  await appendReportRequest(run.runDir, secondAudience("zh-CN"));
  const appended = await readReportRequests(run.runDir);
  const asPrepared = buildReportRequestsArtifact([FIRST, secondAudience("zh-CN")]);
  assert.equal(stableJson(appended), stableJson(asPrepared),
    "appending is not a second way of recording a request: the bytes are prepare's own");
});

// --- ② what an append refuses -------------------------------------------------------------------------

test("a duplicate document, an edited row, a removed row and a two-row write are four named refusals", async () => {
  const run = await plannedRun(["product"]);
  const recorded = await readReportRequests(run.runDir);

  await assert.rejects(async () => appendReportRequest(run.runDir, { ...FIRST, detailLevel: "detailed" }),
    /Document "overview-product" is already in the recorded request set; a request row is appended once and never edited/);
  assert.equal(stableJson(await readReportRequests(run.runDir)), stableJson(recorded), "a refused append writes nothing");

  // The guard the write goes through, exercised directly: an edited row is not an append.
  const edited: ReportRequestsArtifact = {
    version: recorded.version,
    requests: recorded.requests.map((row) => ({ ...row, request: { ...row.request, detailBudget: "detailed" as const } }))
  };
  assert.throws(() => assertRequestsOnlyAppended(recorded, edited),
    /The recorded request for document "overview-product" would change from .* to .*; recorded request rows are immutable — a request set is only ever appended to/);
  assert.throws(() => assertRequestsOnlyAppended(recorded, { version: recorded.version, requests: [] }),
    /The recorded request for document "overview-product" is not in the set being written; recorded request rows are never removed/);
  const twoMore = buildReportRequestsArtifact([FIRST, secondAudience("zh-CN"), { ...secondAudience("zh-CN"), documentId: "overview-prd-ish", audience: "product", kind: "overview" }]);
  assert.throws(() => assertRequestsOnlyAppended(recorded, twoMore), /An append adds exactly one document, and this write adds 2/);
  assert.throws(() => assertRequestsOnlyAppended(recorded, { ...recorded, version: "report-requests-v9" }),
    /An append does not change the recorded artifact version/);
});

test("appending to a run that records no request set at all is refused, not created", async () => {
  const run = await plannedRun(["product"]);
  await writeJson(`${run.workdir}/decoy.json`, {});
  await assert.rejects(async () => appendReportRequest(`${run.workdir}/no-such-run`, secondAudience("zh-CN")),
    /is missing, so there is no recorded request set to append to. Re-prepare the run under the current version./);
});

test("a document whose kind and audience have no v2 request is refused by the same mapping prepare goes through", () => {
  const recorded = buildReportRequestsArtifact([FIRST]);
  assert.throws(() => appendedRequestSet(recorded, {
    documentId: "overview-prd", kind: "overview", audience: "prd", featureKey: null, detailLevel: "standard", language: "zh-CN"
  }), /has no v2 request: the prd audience is feature-only/);
});

// --- ③ the window an append opens, and the revision that closes it ------------------------------------

test("after an append the authoring gate refuses by name and says re-plan; the next plan revision restores it", async () => {
  const run = await plannedRun(["product"]);
  const manifest = await manifestOf(run.runDir);
  // The gate is happy before the append: the recorded plan was validated against exactly this request set.
  const before = await assertValidatedPlanForAuthoring(run.runDir, manifest);
  assert.equal(before.planCatalog.planRevision, 0);

  await appendReportRequest(run.runDir, secondAudience(run.manifest.request.language));
  await assert.rejects(async () => assertValidatedPlanForAuthoring(run.runDir, manifest),
    /records plan revision 0, validated against a request set digesting to [0-9a-f]{64}, and .*plan\/requests\.json now digests to [0-9a-f]{64}; the recorded request set changed after the plan was recorded — re-plan required/);

  const revised = await planRun(run.runDir, { mode: "fixture" }, { kind: "revise", reason: "a second audience was requested" });
  assert.equal(revised.revision.planRevision, 1);
  const after = await assertValidatedPlanForAuthoring(run.runDir, manifest);
  assert.equal(after.planCatalog.planRevision, 1);
  assert.deepEqual(after.planCatalog.documents.map((document) => document.documentId), ["overview-engineering", "overview-product"]);
});

test("an EDITED request row that keeps the document set intact is also refused by the gate", async () => {
  const run = await plannedRun(["product"]);
  const manifest = await manifestOf(run.runDir);
  // Hand-written on purpose: the append door refuses this, and what is being established here is that the GATE
  // catches it too. Without the digest comparison this shape passes every coverage check — the document set is
  // unchanged — and the plan's budget would silently be the one derived from a request nobody made.
  await writeJson(reportRequestsPath(run.runDir), buildReportRequestsArtifact([{ ...FIRST, detailLevel: "detailed", language: run.manifest.request.language }]));
  await assert.rejects(async () => assertValidatedPlanForAuthoring(run.runDir, manifest), /re-plan required/);
  const revised = await planRun(run.runDir, { mode: "fixture" }, { kind: "revise", reason: "the product overview was asked for in more detail" });
  assert.equal(revised.revision.planRevision, 1);
  const after = await assertValidatedPlanForAuthoring(run.runDir, manifest);
  assert.equal(after.requests.requests[0]!.request.detailBudget, "detailed");
  assert.match(await readFile(revised.planCatalogPath, "utf8"), /"detailBudget": "detailed"/);
});
