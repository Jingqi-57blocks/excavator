import test from "node:test";
import assert from "node:assert/strict";
import type { EvidenceItem, InvestigationPlan, KnowledgeCompleteness, RunManifest, TraceCatalog } from "../src/base/types.ts";
import { auditFrozenKnowledge, buildKnowledge, judgementDigest, knowledgeDigest } from "../src/freeze/freeze.ts";
import { canonicalJson, sha256, stableJson } from "../src/base/util.ts";
import { appendTimeline } from "../src/base/timeline.ts";
import { APPEND_STREAM_VERSION, nextStreamDigest, writeCheckpoint } from "../src/base/single-writer.ts";
import { tempDir } from "./helpers.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const completeness: KnowledgeCompleteness = {
  version: "knowledge-completeness-v3",
  domains: [],
  closure: {
    workItems: { positive: 2, negative: 0, pending: 0, byStatus: { found: 2 } },
    decisions: { positive: 2, negative: 0, pending: 0 },
    probeResiduals: 0,
    materialFlowsWithTraces: 2,
    sourceReadsWithoutObligation: 0
  },
  checks: [],
  warnings: []
};

const manifest = {
  id: "run",
  assuranceVersion: "assurance-v16-epoch-seal-redaction-v7",
  snapshot: { id: "snapshot" },
  request: { redactSecrets: false }
} as unknown as RunManifest;

function workItem(id: string) {
  return {
    id, dimension: "normal-flow", scope: id, hypothesis: id, status: "found" as const,
    material: true, requiredFor: ["overview-product"], evidenceIds: [`E-${id}`], traceIds: [`T-${id}`],
    reason: `reason-${id}`, settledBy: `agent-${id}`, searchScope: `scope-${id}`, origin: "default" as const
  };
}

function evidence(id: string): EvidenceItem {
  const data = { id };
  return { id: `E-${id}`, snapshotId: "snapshot", kind: "derived", title: id, data, reason: "fixture", digest: sha256(stableJson(data)) };
}

function trace(id: string) {
  return {
    id: `T-${id}`, title: id, type: "business-flow" as const, status: "verified" as const,
    confidence: "high" as const, documentIds: ["overview-product"], steps: [], createdAt: "2026-01-01T00:00:00.000Z"
  };
}

test("knowledge sealing is byte-deterministic under work-item, evidence, trace and L7 completion order", () => {
  const planA: InvestigationPlan = { version: 1, runId: "run", createdAt: "fixed", items: [workItem("b"), workItem("a")] };
  const evidenceA = [evidence("b"), evidence("a")];
  const tracesA: TraceCatalog = { version: 1, runId: "run", traces: [trace("b"), trace("a")] };
  const resultsA = {
    executions: [{ id: "X-b" }, { id: "X-a" }],
    dispositions: [{ declarationId: "D-b" }, { declarationId: "D-a" }],
    residuals: [{ residualId: "R-b" }, { residualId: "R-a" }],
    judgements: []
  };
  const shared = {
    manifest, factPacks: {}, crossFeature: null, frozenAt: "2026-01-01T00:00:00.000Z",
    completeness, appendStreams: [
      { id: "evidence.json", frozenThroughSequence: 2, tailDigest: "evidence-tail" },
      { id: "timeline.jsonl", frozenThroughSequence: 1, tailDigest: "timeline-tail" },
      { id: "supplements", frozenThroughSequence: 0, tailDigest: "" }
    ]
  };
  const first = buildKnowledge({ ...shared, plan: planA, evidence: evidenceA, traces: tracesA, investigationResults: resultsA });
  const expected = canonicalJson(first);
  // Exercise every independent forward/reverse completion order for the six order-insensitive collections.
  for (let mask = 0; mask < 64; mask += 1) {
    const ordered = <T>(rows: T[], bit: number): T[] => mask & (1 << bit) ? [...rows].reverse() : [...rows];
    const plan: InvestigationPlan = { ...planA, items: ordered(planA.items, 0) };
    const traces: TraceCatalog = { ...tracesA, traces: ordered(tracesA.traces, 2) };
    const results = {
      ...resultsA,
      executions: ordered(resultsA.executions, 3),
      dispositions: ordered(resultsA.dispositions, 4),
      residuals: ordered(resultsA.residuals, 5)
    };
    const actual = buildKnowledge({ ...shared, plan, evidence: ordered(evidenceA, 1), traces, investigationResults: results });
    assert.equal(canonicalJson(actual), expected, `completion-order mask ${mask}`);
  }
});

test("the judgement identity changes when a reason changes even if the status does not", () => {
  const before: InvestigationPlan = { version: 1, runId: "run", createdAt: "fixed", items: [workItem("a")] };
  const after: InvestigationPlan = { ...before, items: [{ ...before.items[0], reason: "a materially different rationale" }] };
  assert.notEqual(judgementDigest(before, null), judgementDigest(after, null));
});

test("epoch zero rejects a predecessor and later epochs require one", () => {
  const plan: InvestigationPlan = { version: 1, runId: "run", createdAt: "fixed", items: [] };
  const traces: TraceCatalog = { version: 1, runId: "run", traces: [] };
  const shared = { manifest, plan, evidence: [], traces, factPacks: {}, crossFeature: null, frozenAt: "fixed", completeness };
  assert.throws(() => buildKnowledge({ ...shared, epoch: 0, previousEpochDigest: "digest" }), /Epoch 0 cannot/);
  assert.throws(() => buildKnowledge({ ...shared, epoch: 1 }), /requires the previous epoch digest/);
});

test("a pre-epoch inline supplement ledger remains readable and auditable without migration", async () => {
  const runDir = await tempDir();
  const supplement = { at: "2026-01-02T00:00:00.000Z", command: "search", ids: ["E-later"], reason: "legacy fixture", workItemId: "W-1" };
  const legacy = {
    version: "knowledge-v1" as const,
    runId: "run",
    snapshotId: "snapshot",
    assuranceVersion: "assurance-v15-domain-completeness-redaction-v7",
    frozenAt: "2026-01-01T00:00:00.000Z",
    evidenceIds: [], evidenceDigest: "", workitems: [], workitemsDigest: "", traceIds: [], tracesDigest: "",
    factPackDigests: {}, completeness, epoch: 0, supplements: [supplement]
  };
  const encoded = `${canonicalJson(legacy)}\n`;
  await writeFile(join(runDir, "knowledge.json"), encoded);
  await writeCheckpoint(runDir, {
    version: APPEND_STREAM_VERSION,
    stream: "supplement",
    sequence: 1,
    tailDigest: nextStreamDigest("", 1, supplement),
    byteOffset: Buffer.byteLength(encoded) - Buffer.byteLength("]}\n")
  });
  await appendTimeline(runDir, "run", { stage: "investigation", action: "investigation.frozen" });
  const legacyManifest = {
    ...manifest,
    assuranceVersion: legacy.assuranceVersion,
    frozenAt: legacy.frozenAt,
    knowledgeDigest: knowledgeDigest(legacy)
  } as RunManifest;
  const plan: InvestigationPlan = { version: 1, runId: "run", createdAt: "fixed", items: [] };
  const traces: TraceCatalog = { version: 1, runId: "run", traces: [] };
  assert.deepEqual(await auditFrozenKnowledge(runDir, legacyManifest, [], plan, traces), []);
});
