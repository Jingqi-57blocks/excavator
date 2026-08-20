import test from "node:test";
import assert from "node:assert/strict";
import type {
  EvidenceItem, InvestigationPlan, InvestigationWorkItem, KnowledgeCompleteness, RunManifest, TraceCatalog
} from "../src/base/types.ts";
import { auditFrozenKnowledge, buildKnowledge, judgementDigest, knowledgeDigest, writeKnowledgeArtifact } from "../src/freeze/freeze.ts";
import { CURRENT_JUDGEMENT_SEAL, readJudgementSeal } from "../src/freeze/judgement-seal.ts";
import { canonicalEvidenceDigest } from "../src/investigation/evidence-store.ts";
import { appendTimeline } from "../src/base/timeline.ts";
import { sha256, stableJson } from "../src/base/util.ts";
import { tempDir } from "./helpers.ts";

/**
 * The audit denominator's definition fields must be inside the freeze seal. The grounding audit counts
 * `material && requiredFor.includes(document) && origin !== "open"` (`auditWorkItemClaimCoverage`) and
 * exempts an item from the material-flow trace rule by `dimension` (`auditWorkItems`); none of the four is
 * covered by `workitemsDigest`, which is `{ id, status }`. Each test below edits one of them on an already
 * sealed run and requires the freeze verification to say so.
 */

const SEAL_MISMATCH = "current work-item and L7 judgements do not match the latest sealed judgement digest";
const FROZEN_AT = "2026-01-01T00:00:00.000Z";

const completeness: KnowledgeCompleteness = {
  version: "knowledge-completeness-v4",
  domains: [],
  closure: {
    workItems: { positive: 2, negative: 0, pending: 0, byStatus: { found: 2 } },
    decisions: { positive: 1, negative: 0, pending: 0, displaced: 0 },
    probeResiduals: 0,
    materialFlowsWithTraces: 2,
    sourceReadsWithoutObligation: 0
  },
  checks: [],
  warnings: []
};

const baseManifest = {
  id: "run",
  assuranceVersion: "assurance-v16-epoch-seal-redaction-v7",
  snapshot: { id: "snapshot" },
  request: { redactSecrets: false }
} as unknown as RunManifest;

const results = {
  executions: [{ id: "X-a" }],
  dispositions: [{ declarationId: "D-a" }],
  residuals: [],
  judgements: []
};

function workItem(id: string): InvestigationWorkItem {
  return {
    id, dimension: "normal-flow", scope: `feature:${id}`, hypothesis: id, status: "found",
    material: true, requiredFor: ["overview-engineering", "overview-product"],
    evidenceIds: [`E-${id}`], traceIds: [`T-${id}`],
    reason: `reason-${id}`, settledBy: `agent-${id}`, searchScope: `scope-${id}`, origin: "default"
  };
}

function evidenceFor(id: string): EvidenceItem {
  const data = { id };
  return { id: `E-${id}`, snapshotId: "snapshot", kind: "derived", title: id, data, reason: "fixture", digest: sha256(stableJson(data)) };
}

function traceFor(id: string) {
  return {
    id: `T-${id}`, title: id, type: "business-flow" as const, status: "verified" as const,
    confidence: "high" as const, documentIds: ["overview-product"], steps: [], createdAt: FROZEN_AT
  };
}

/**
 * Seal one epoch-0 run through the production freeze path (`buildKnowledge` + `writeKnowledgeArtifact`) and
 * hand back everything `auditFrozenKnowledge` needs. `sealedJudgement` overrides the recorded digest so a
 * run sealed by an older or an unknown build can be audited exactly as it would be read off disk.
 */
async function frozenRun(items: InvestigationWorkItem[], sealedJudgement?: string) {
  const runDir = await tempDir();
  const plan: InvestigationPlan = { version: 1, runId: "run", createdAt: "fixed", items };
  const evidence = items.map((item) => evidenceFor(item.id));
  const traces: TraceCatalog = { version: 1, runId: "run", traces: items.map((item) => traceFor(item.id)) };
  const built = buildKnowledge({
    manifest: baseManifest, plan, evidence, traces, factPacks: {}, crossFeature: null,
    frozenAt: FROZEN_AT, completeness, investigationResults: results,
    appendStreams: [
      { id: "evidence.json", frozenThroughSequence: evidence.length, tailDigest: canonicalEvidenceDigest(evidence) },
      { id: "timeline.jsonl", frozenThroughSequence: 0, tailDigest: "" },
      { id: "supplements", frozenThroughSequence: 0, tailDigest: "" }
    ]
  });
  const knowledge = sealedJudgement === undefined ? built : { ...built, judgementDigest: sealedJudgement };
  await appendTimeline(runDir, "run", {
    stage: "investigation", action: "investigation.frozen", data: { epoch: 0, knowledgeDigest: knowledgeDigest(knowledge) }
  });
  await writeKnowledgeArtifact(runDir, knowledge);
  const manifest = {
    ...baseManifest, frozenAt: FROZEN_AT, knowledgeEpoch: 0, knowledgeDigest: knowledgeDigest(knowledge)
  } as RunManifest;
  return { runDir, manifest, evidence, traces, plan, knowledge };
}

const sealMismatch = [{ level: "error", document: "knowledge", message: SEAL_MISMATCH }];

test("a sealed run whose ledger was not touched audits clean", async () => {
  const { runDir, manifest, evidence, traces, plan } = await frozenRun([workItem("a"), workItem("b")]);
  assert.deepEqual(await auditFrozenKnowledge(runDir, manifest, evidence, plan, traces, results), []);
});

// Editing the plan handed to the audit is exactly editing `workitems.json`: that argument IS the current
// ledger. Each case asserts the mismatch is the ONLY finding, which also pins that `workitemsDigest` stayed
// green — the status-only digest cannot see any of these fields, so the judgement seal is the whole defence.
const denominatorEdits: Array<[string, (item: InvestigationWorkItem) => InvestigationWorkItem]> = [
  ["material flipped to false shrinks the gate-1b denominator", (item) => ({ ...item, material: false })],
  ["origin flipped to open exempts the item from the denominator", (item) => ({ ...item, origin: "open" })],
  ["requiredFor dropping a document removes the item from that document's denominator",
    (item) => ({ ...item, requiredFor: item.requiredFor.filter((id) => id !== "overview-engineering") })],
  ["dimension moved off the flow list exempts the item from the trace rule",
    (item) => ({ ...item, dimension: "quality-and-tests" })]
];

for (const [label, edit] of denominatorEdits) {
  test(`freeze verification rejects a post-freeze edit: ${label}`, async () => {
    const { runDir, manifest, evidence, traces, plan } = await frozenRun([workItem("a"), workItem("b")]);
    const edited: InvestigationPlan = { ...plan, items: [edit(plan.items[0]), plan.items[1]] };
    assert.deepEqual(await auditFrozenKnowledge(runDir, manifest, evidence, edited, traces, results), sealMismatch);
  });
}

/**
 * The tripwire for the defect class itself. The fixture is typed `Required<InvestigationWorkItem>`, so a
 * field added to the interface fails to compile until it is listed here — and the loop then proves the new
 * field is sealed. That is what keeps this fix from being re-opened by the next field, which is how
 * `material` and `origin` escaped a digest that enumerated seven fields by hand.
 */
test("every field of a work item is inside the current seal", () => {
  const complete: Required<InvestigationWorkItem> = {
    id: "W-1", dimension: "normal-flow", scope: "feature:leave", hypothesis: "leave can be requested",
    status: "found", material: true, requiredFor: ["overview-product"], evidenceIds: ["E-1"], traceIds: ["T-1"],
    reportSection: 3, searchScope: "src/**", reason: "grounded in the handler", settledBy: "agent",
    origin: "default", startedAt: FROZEN_AT, completedAt: FROZEN_AT, supersedes: "W-0"
  };
  const plan: InvestigationPlan = { version: 1, runId: "run", createdAt: "fixed", items: [complete] };
  const sealed = judgementDigest(plan, results, CURRENT_JUDGEMENT_SEAL);
  const bumped = (value: unknown): unknown => {
    if (typeof value === "boolean") return !value;
    if (typeof value === "number") return value + 1;
    if (Array.isArray(value)) return [...value, "sentinel"];
    return `${String(value)}-sentinel`;
  };
  const fields = complete as unknown as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    const mutated = { ...fields, [key]: bumped(fields[key]) } as unknown as InvestigationWorkItem;
    const digest = judgementDigest({ ...plan, items: [mutated] }, results, CURRENT_JUDGEMENT_SEAL);
    assert.notEqual(digest, sealed, `changing ${key} left the seal unchanged`);
  }
});

test("the seal version travels in the digest value and inside the hashed payload", () => {
  const plan: InvestigationPlan = { version: 1, runId: "run", createdAt: "fixed", items: [workItem("a")] };
  const current = judgementDigest(plan, results, CURRENT_JUDGEMENT_SEAL);
  const legacy = judgementDigest(plan, results, "judgement-seal-v1");
  assert.ok(current.startsWith(`${CURRENT_JUDGEMENT_SEAL}:`), "a current seal names its version");
  assert.match(legacy, /^[0-9a-f]{64}$/, "v1 predates the label and stays a bare digest");
  // Relabelling cannot promote a v1 digest: the version is hashed into the payload, not just prefixed.
  assert.notEqual(current, `${CURRENT_JUDGEMENT_SEAL}:${legacy}`);
  assert.deepEqual(readJudgementSeal(legacy), { version: "judgement-seal-v1", value: legacy });
  assert.deepEqual(readJudgementSeal(current), { version: CURRENT_JUDGEMENT_SEAL, value: current });
});

test("a seal label this build cannot compute is reported, never recomputed under a guessed field set", async () => {
  for (const recorded of [`judgement-seal-v99:${"0".repeat(64)}`, `judgement-seal-v1:${"0".repeat(64)}`, "not-a-digest"]) {
    assert.equal(readJudgementSeal(recorded).version, "unreadable", recorded);
    const { runDir, manifest, evidence, traces, plan } = await frozenRun([workItem("a")], recorded);
    assert.deepEqual(await auditFrozenKnowledge(runDir, manifest, evidence, plan, traces, results),
      [{ level: "error", document: "knowledge", message: `latest sealed judgement digest does not name a readable seal version: ${recorded}` }]);
  }
});

/**
 * Generation policy: an archived epoch is audited against the contract it recorded, with no migration. What
 * must not happen is this fix making such a run unauditable — recomputing a v1 digest under the wider field
 * set would report every archive as tampered. The blind spot v1 shipped with is pinned deliberately: closing
 * it retroactively is exactly the false-failure this asserts against.
 */
test("an epoch sealed under v1 stays auditable, and v1's own coverage still bites", async () => {
  const plan: InvestigationPlan = { version: 1, runId: "run", createdAt: "fixed", items: [workItem("a")] };
  const legacySeal = judgementDigest(plan, results, "judgement-seal-v1");
  const { runDir, manifest, evidence, traces, knowledge } = await frozenRun(plan.items, legacySeal);
  assert.equal(knowledge.judgementDigest, legacySeal);
  assert.deepEqual(await auditFrozenKnowledge(runDir, manifest, evidence, plan, traces, results), []);

  const reworded: InvestigationPlan = { ...plan, items: [{ ...plan.items[0], reason: "a different rationale" }] };
  assert.deepEqual(await auditFrozenKnowledge(runDir, manifest, evidence, reworded, traces, results), sealMismatch);

  const shrunk: InvestigationPlan = { ...plan, items: [{ ...plan.items[0], material: false }] };
  assert.deepEqual(await auditFrozenKnowledge(runDir, manifest, evidence, shrunk, traces, results), [],
    "a v1 epoch keeps v1's field set; re-reading it under v2 would false-fail every archive");
});
