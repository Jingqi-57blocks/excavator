import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Audience, ReportRequest } from "../src/base/types.ts";
import { auditRun, prepareRun } from "../src/run/run.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

async function request(options: { feature?: boolean; graph?: boolean } = {}): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  let codegraph: string | undefined;
  if (options.graph) {
    codegraph = join(workdir, "codegraph.db");
    createCodeGraphFixture(codegraph);
  }
  return {
    target,
    codegraph,
    codegraphMode: options.graph ? "auto" : "off",
    language: "zh-CN",
    detailLevel: "standard",
    workdir,
    overviewAudiences: options.feature ? [] : ["product"],
    features: options.feature ? [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["product"] }] : [],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  };
}

test("prepare persists analysis scope, provider registry, work items, traces and a valid timeline", async () => {
  const { runDir, manifest } = await prepareRun(await request({ graph: true }));
  const scope = JSON.parse(await readFile(join(runDir, "analysis-scope.json"), "utf8"));
  const providers = JSON.parse(await readFile(join(runDir, "provider-status.json"), "utf8"));
  const workitems = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8"));
  const traces = JSON.parse(await readFile(join(runDir, "traces.json"), "utf8"));
  const timeline = (await readFile(join(runDir, "timeline.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(scope.snapshotId, manifest.snapshot?.id);
  assert.equal(scope.providerRegistryDigest, providers.digest);
  assert.ok(providers.providers.some((provider: any) => provider.id === "source" && provider.selected));
  assert.ok(providers.providers.some((provider: any) => provider.id === "codegraph" && provider.selected));
  assert.ok(workitems.items.length > 0);
  assert.deepEqual(traces.traces, []);
  assert.equal(timeline[0].action, "run.prepared");
  assert.equal(timeline[0].sequence, 1);
});

test("source-only provider registry records CodeGraph as unselected", async () => {
  const { runDir } = await prepareRun(await request());
  const providers = JSON.parse(await readFile(join(runDir, "provider-status.json"), "utf8"));
  const graph = providers.providers.find((provider: any) => provider.id === "codegraph");
  assert.equal(graph.selected, false);
  assert.equal(graph.available, false);
  assert.match(graph.selectionReason, /source-only/i);
});

// --- 57B-338: audit scoping (single-document mode) and partial-set robustness ---

async function multiFeatureRequest(features: Array<{ subject: string; aliases: string[] }>): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  return {
    target,
    codegraph: undefined,
    codegraphMode: "off",
    language: "zh-CN",
    detailLevel: "standard",
    workdir,
    overviewAudiences: [],
    features: features.map((feature) => ({ subject: feature.subject, aliases: feature.aliases, audiences: ["product"] as Audience[] })),
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  };
}

// Author section 1 with an extra claim that binds a material work item, so the document genuinely covers it.

test("single-document audit rejects an unknown document id", async () => {
  const { runDir } = await prepareRun(await multiFeatureRequest([{ subject: "Leave management", aliases: ["leave"] }]));
  await assert.rejects(() => auditRun(runDir, { documentId: "no-such-document" }), /Unknown document/);
});

