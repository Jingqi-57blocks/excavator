/**
 * The knowledge boundary a feature-scope request row names, checked against the run that would answer it.
 *
 * WHY THIS IS TESTED THROUGH A REAL PREPARED RUN rather than a hand-written contract: the thing under test is a
 * comparison between two artifacts the run itself produced — `contract/run-intent.json`'s bound keys and the
 * request row's `scopeIds` — and a fixture that wrote both would only prove the comparison can read what the
 * fixture wrote. So the run below is prepared through `prepareRun` with one feature requested, exactly as an
 * operator asks for one, and the key the check accepts is the key that run minted.
 *
 * WHAT THE NEGATIVE HALF PROVES. A mistyped key is refused BY NAME and `plan/requests.json` is unchanged byte for
 * byte — the door does not half-append. Before this check existed the same call produced a row with
 * `scope: feature, scopeIds: ["<typo>"]`, a plan that validated `complete`, and authoring units for a feature the
 * run never investigated.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { prepareRun } from "../src/run/run.ts";
import { plannedDocumentId, type LegacyDocumentRequest } from "../src/report/legacy-request-mapping.ts";
import { appendReportRequest } from "../src/report/report-requests-append.ts";
import { boundFeatureKeys } from "../src/report/request-append-boundary.ts";
import { reportRequestsPath } from "../src/report/report-requests-artifact.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

/** A run that asked for exactly one feature document, so the contract binds exactly one key. */
async function featureRun(): Promise<{ runDir: string; featureKey: string }> {
  const target = await copyFixture();
  const workdir = await tempDir("excavator-append-boundary-");
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  const { runDir } = await prepareRun({
    target, codegraph, workdir, language: "zh-CN", detailLevel: "standard",
    overviewAudiences: [], features: [{ subject: "Leave management", aliases: ["leave"], audiences: ["product"] }],
    budgets: {
      prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50,
      maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2
    }
  });
  const keys = await boundFeatureKeys(runDir);
  assert.equal(keys.length, 1, `the prepared run must bind exactly one feature key: ${keys.join(", ")}`);
  return { runDir, featureKey: keys[0]! };
}

function featureDocument(featureKey: string, audience: "engineering" | "prd"): LegacyDocumentRequest {
  return {
    documentId: plannedDocumentId("feature", audience, featureKey),
    kind: "feature",
    audience,
    featureKey,
    detailLevel: "standard",
    language: "zh-CN"
  };
}

test("a feature document whose key the contract binds is appended, and its row carries that boundary", async () => {
  const { runDir, featureKey } = await featureRun();
  // The prd audience is the epic's own R8 deliverable shape: a feature PRD appended to a run that already
  // investigated the feature, without re-preparing (which would throw the investigation away).
  const result = await appendReportRequest(runDir, featureDocument(featureKey, "prd"));
  assert.equal(result.appended.documentId, `feature-${featureKey}-prd`);
  assert.equal(result.appended.request.scope, "feature");
  assert.deepEqual(result.appended.request.scopeIds, [featureKey], "the row's boundary is the key that was checked");
  assert.equal(result.appended.request.intent, "prd");
  assert.deepEqual(
    result.artifact.requests.map((row) => row.documentId).sort(),
    [`feature-${featureKey}-prd`, `feature-${featureKey}-product`],
    "the recorded row survives and exactly one is added"
  );
});

test("a feature key the contract does not bind is refused by name, and nothing is written", async () => {
  const { runDir, featureKey } = await featureRun();
  const before = await readFile(reportRequestsPath(runDir), "utf8");
  await assert.rejects(async () => appendReportRequest(runDir, featureDocument("leave-managemnet-typo", "engineering")),
    new RegExp(`names feature key "leave-managemnet-typo", which contract/run-intent\\.json does not bind \\(this run investigated: ${featureKey}\\); this run has no knowledge to write that document from`));
  assert.equal(await readFile(reportRequestsPath(runDir), "utf8"), before, "a refused append leaves the recorded set byte for byte");
});

test("a run whose contract cannot be read refuses the append instead of reading as investigating nothing", async () => {
  const { runDir, featureKey } = await featureRun();
  await rm(join(runDir, "contract", "run-intent.json"));
  await assert.rejects(async () => appendReportRequest(runDir, featureDocument(featureKey, "engineering")),
    /contract\/run-intent\.json is missing from .*, so the feature keys this run investigated cannot be read/);
});
