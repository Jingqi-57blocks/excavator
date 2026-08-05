import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { ReportRequest } from "../src/types.ts";
import { prepareRun } from "../src/run.ts";

const target = process.env.EXCAVATOR_TARGET;
if (!target) {
  console.log(JSON.stringify({ skipped: true, reason: "Set EXCAVATOR_TARGET to run the real-workspace smoke test." }, null, 2));
  process.exit(0);
}

const workdir = resolve(process.env.EXCAVATOR_WORKDIR ?? ".excavator-workspace-smoke");
const codegraph = process.env.EXCAVATOR_CODEGRAPH ? resolve(process.env.EXCAVATOR_CODEGRAPH) : undefined;
const request: ReportRequest = {
  target: resolve(target),
  codegraph,
  codegraphMode: process.env.EXCAVATOR_NO_CODEGRAPH === "true" ? "off" : "auto",
  workdir,
  language: process.env.EXCAVATOR_LANGUAGE ?? "zh-CN",
  overviewAudiences: ["product", "engineering"],
  features: [
    { subject: process.env.EXCAVATOR_FEATURE ?? "Account access", aliases: (process.env.EXCAVATOR_FEATURE_ALIASES ?? "access,permission,role").split(",").map((value) => value.trim()).filter(Boolean), audiences: ["product", "engineering"] }
  ],
  budgets: {
    prepareMs: 180_000,
    authorMs: 720_000,
    maxGraphQueries: 70,
    maxSourceWindows: 100,
    maxSourceCharacters: 280_000,
    maxFiles: 100_000,
    maxFeatureNodes: 180,
    maxExpansionDepth: 2
  }
};

const expectedDocuments = request.overviewAudiences.length + request.features.reduce((count, feature) => count + feature.audiences.length, 0);
const cold = await prepareRun(request);
assert.ok(cold.manifest.metrics.timing.totalPrepareMs <= request.budgets.prepareMs);
assert.equal(cold.manifest.documents.length, expectedDocuments);

const warm = await prepareRun(request);
assert.ok(warm.manifest.metrics.timing.totalPrepareMs <= request.budgets.prepareMs);
assert.equal(warm.manifest.metrics.graphQueries, 0);
assert.equal(warm.manifest.metrics.sourceWindows, 0);
assert.notEqual(warm.runDir, cold.runDir, "cache reuse must not overwrite a previous run directory");

console.log(JSON.stringify({
  coldRun: cold.runDir,
  warmRun: warm.runDir,
  coldMetrics: cold.manifest.metrics,
  warmMetrics: warm.manifest.metrics
}, null, 2));
