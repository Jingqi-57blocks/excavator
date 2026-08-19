import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeArtifact } from "../src/base/types.ts";
import { appendTimeline, auditTimeline, readTimeline } from "../src/base/timeline.ts";
import { knowledgeDigest, recordSupplement, writeKnowledgeArtifact } from "../src/freeze/freeze.ts";
import { tempDir } from "./helpers.ts";

function knowledge(): KnowledgeArtifact {
  return {
    version: "knowledge-v1",
    runId: "run",
    snapshotId: "snapshot",
    frozenAt: "2026-01-01T00:00:00.000Z",
    evidenceIds: [],
    evidenceDigest: "digest",
    workitems: [],
    workitemsDigest: "digest",
    traceIds: [],
    tracesDigest: "digest",
    factPackDigests: {},
    completeness: {
      version: "knowledge-completeness-v2",
      domains: [],
      closure: {
        workItems: { positive: 0, negative: 0, pending: 0, byStatus: {} },
        decisions: { positive: 0, negative: 0, pending: 0 },
        probeResiduals: 0,
        materialFlowsWithTraces: 0,
        sourceReadsWithoutObligation: 0
      },
      checks: [],
      warnings: []
    },
    epoch: 0,
    supplements: []
  };
}

test("timeline and supplement appends share one cross-process commit door without corrupting either tail", async () => {
  const runDir = await tempDir();
  await appendTimeline(runDir, "run", { stage: "prepare", action: "run.prepared" });
  const frozen = knowledge();
  const coreDigest = knowledgeDigest(frozen);
  await writeKnowledgeArtifact(runDir, frozen);
  const epochBytes = await readFile(join(runDir, "knowledge.json"), "utf8");

  await Promise.all(Array.from({ length: 80 }, (_, index) => index % 2 === 0
    ? appendTimeline(runDir, "run", { stage: "investigation", action: "fixture", subject: String(index) })
    : recordSupplement(runDir, "search", [`E-${index}`], { reason: "fixture", workItemId: "W-1" })));

  assert.deepEqual(await auditTimeline(runDir, "run"), []);
  const timeline = await readTimeline(runDir);
  assert.equal(timeline.length, 41);
  assert.deepEqual(timeline.map((entry) => entry.sequence), Array.from({ length: 41 }, (_, index) => index + 1));
  const persisted = JSON.parse(await readFile(join(runDir, "knowledge.json"), "utf8")) as KnowledgeArtifact;
  const ledger = JSON.parse(await readFile(join(runDir, "knowledge", "supplements.json"), "utf8")) as { supplements: KnowledgeArtifact["supplements"] };
  assert.equal(ledger.supplements.length, 40);
  assert.equal(await readFile(join(runDir, "knowledge.json"), "utf8"), epochBytes, "supplements never rewrite the immutable epoch bytes");
  assert.equal(knowledgeDigest(persisted), coreDigest);
});

test("tail checkpoints remain constant-sized while timeline and supplement counts grow", async () => {
  const runDir = await tempDir();
  await appendTimeline(runDir, "run", { stage: "prepare", action: "run.prepared" });
  await writeKnowledgeArtifact(runDir, knowledge());
  const initialTimeline = await stat(join(runDir, ".writer", "timeline.checkpoint.json")).then((value) => value.size);
  const initialSupplement = await stat(join(runDir, ".writer", "supplement.checkpoint.json")).then((value) => value.size);
  for (let index = 0; index < 100; index += 1) {
    await appendTimeline(runDir, "run", { stage: "investigation", action: "fixture", subject: String(index) });
    await recordSupplement(runDir, "source", [`S-${index}`], { reason: "fixture", workItemId: "W-1" });
  }
  const finalTimeline = await stat(join(runDir, ".writer", "timeline.checkpoint.json")).then((value) => value.size);
  const finalSupplement = await stat(join(runDir, ".writer", "supplement.checkpoint.json")).then((value) => value.size);
  assert.ok(finalTimeline < initialTimeline + 64);
  assert.ok(finalSupplement < initialSupplement + 96, "the first tail digest adds 64 characters; later N adds only integer digits");
});

test("the three hot append paths cannot regress to reading or rewriting their full history", async () => {
  const evidenceSource = await readFile(join(import.meta.dirname, "..", "src", "investigation", "evidence-store.ts"), "utf8");
  const timelineSource = await readFile(join(import.meta.dirname, "..", "src", "base", "timeline.ts"), "utf8");
  const freezeSource = await readFile(join(import.meta.dirname, "..", "src", "freeze", "freeze.ts"), "utf8");
  const evidenceAppend = evidenceSource.slice(evidenceSource.indexOf("export async function appendEvidence("), evidenceSource.indexOf("export async function readEvidenceCatalog("));
  const timelineAppend = timelineSource.slice(timelineSource.indexOf("export async function appendTimeline("), timelineSource.indexOf("export async function auditTimeline("));
  const supplementAppend = freezeSource.slice(freezeSource.indexOf("export async function recordSupplement("), freezeSource.indexOf("export async function writeKnowledgeArtifact("));
  assert.doesNotMatch(evidenceAppend, /readEvidenceCatalog|readJson|readFile\(.*evidence\.json|writeJson/);
  assert.doesNotMatch(timelineAppend, /readTimeline|readFile/);
  assert.doesNotMatch(supplementAppend, /readJson|readFile|writeJson/);
});
