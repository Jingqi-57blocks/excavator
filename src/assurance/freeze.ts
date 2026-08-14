import { join } from "node:path";
import type { AuditFinding } from "./assurance.ts";
import { auditEvidenceCatalog, auditTraces, auditWorkItems, runUsesCurrentAssurance } from "./assurance.ts";
import type { EvidenceItem, InvestigationPlan, KnowledgeArtifact, KnowledgeCompleteness, RunManifest, TraceCatalog } from "../core/types.ts";
import { readTimeline } from "./timeline.ts";
import { exists, nowIso, readJson, sha256, stableJson, writeJson } from "../core/util.ts";

/**
 * "First freeze, then write." This module owns the deterministic, model-free machinery that turns a
 * completed investigation into a frozen `knowledge.json` record and later reconciles the run against
 * it. It reuses the existing assurance rules verbatim (`auditWorkItems`/`auditTraces`/
 * `auditEvidenceCatalog`) so the freeze gate and the full audit can never drift into two rule sets.
 */

/** The material-flow dimensions whose `found` work items require a verified trace; mirrors auditWorkItems. */
const MATERIAL_FLOW_DIMENSIONS = new Set(["normal-flow", "decision-flow", "reversal-flow", "states-and-lifecycle", "notifications-and-exports"]);

/** The investigation-stage timeline actions the escape hatch must mark as a supplement once a run is frozen. */
const GATED_TIMELINE_ACTIONS = new Set(["source.search", "source.window", "workitems.updated", "traces.updated"]);

function error(document: string, message: string): AuditFinding { return { level: "error", document, message }; }

/** Digest over the frozen core: the whole artifact except its append-only `supplements` ledger. */
export function knowledgeDigest(knowledge: KnowledgeArtifact): string {
  const { supplements, ...core } = knowledge;
  return sha256(stableJson(core));
}

export interface FreezePreconditionInput {
  manifest: RunManifest;
  plan: InvestigationPlan;
  expectedPlan: InvestigationPlan;
  evidence: EvidenceItem[];
  evidenceById: Map<string, EvidenceItem>;
  traces: TraceCatalog;
  documentIds: Set<string>;
  /** Snapshot re-derivation result computed by the caller (createSnapshot lives in the orchestrator). */
  snapshotDrift: { snapshotChanged: boolean; codegraphChanged: boolean } | null;
}

/**
 * The investigation-side gate. Freezing is allowed only when the investigation would already pass the
 * same catalog/work-item/trace/snapshot assertions the full audit applies — so a frozen run is one that
 * was audit-clean at freeze time. Returns findings; an empty error set means the run may be frozen.
 */
export async function freezePreconditions(input: FreezePreconditionInput): Promise<AuditFinding[]> {
  const { manifest, plan, expectedPlan, evidence, evidenceById, traces, documentIds, snapshotDrift } = input;
  const findings: AuditFinding[] = [];
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const traceIds = new Set(traces.traces.map((trace) => trace.id));
  if (manifest.evidenceDigest !== sha256(stableJson(evidence))) findings.push(error("evidence", "evidence catalog changed outside the recorded source-evidence workflow"));
  findings.push(...await auditEvidenceCatalog(manifest, evidence));
  findings.push(...auditWorkItems(plan, expectedPlan, evidenceById, traceIds));
  // Claims do not exist yet at freeze time, so no trace step can legitimately cite one: pass an empty set.
  findings.push(...auditTraces(traces, documentIds, evidenceIds, new Set<string>()));
  if (snapshotDrift?.snapshotChanged) findings.push(error("snapshot", "source snapshot changed after context preparation"));
  if (snapshotDrift?.codegraphChanged) findings.push(error("snapshot", "CodeGraph identity changed after context preparation"));
  return findings;
}

export interface BuildKnowledgeInput {
  manifest: RunManifest;
  plan: InvestigationPlan;
  evidence: EvidenceItem[];
  traces: TraceCatalog;
  /** Parsed fact-pack contents keyed by feature cache key; each is digested into `factPackDigests`. */
  factPacks: Record<string, unknown>;
  /** Parsed cross-feature relationships when the run produced them, else null. */
  crossFeature: unknown | null;
  frozenAt: string;
  /** The read-obligation denominator (generation 5+), digested so the frozen record pins WHICH obligations
   *  this run was accountable for — a later denominator change cannot move retroactively. Null before gen 5. */
  readObligations?: unknown | null;
}

/** Build the knowledge-v1 record: frozen fingerprints of the run's artifacts plus a completeness report. */
export function buildKnowledge(input: BuildKnowledgeInput): KnowledgeArtifact {
  const { manifest, plan, evidence, traces, factPacks, crossFeature, frozenAt, readObligations } = input;
  const evidenceIds = evidence.map((item) => item.id).sort((a, b) => a.localeCompare(b));
  const workitems = plan.items.map((item) => ({ id: item.id, status: item.status })).sort((a, b) => a.id.localeCompare(b.id));
  const traceIds = traces.traces.map((trace) => trace.id).sort((a, b) => a.localeCompare(b));
  const factPackDigests: Record<string, string> = {};
  for (const [key, pack] of Object.entries(factPacks).sort(([a], [b]) => a.localeCompare(b))) factPackDigests[key] = sha256(stableJson(pack));
  return {
    version: "knowledge-v1",
    runId: manifest.id,
    snapshotId: manifest.snapshot?.id ?? "",
    assuranceVersion: manifest.assuranceVersion,
    frozenAt,
    evidenceIds,
    evidenceDigest: manifest.evidenceDigest,
    workitems,
    workitemsDigest: sha256(stableJson(workitems)),
    traceIds,
    tracesDigest: sha256(stableJson(traces)),
    factPackDigests,
    ...(crossFeature != null ? { crossFeatureDigest: sha256(stableJson(crossFeature)) } : {}),
    ...(readObligations != null ? { readObligationsDigest: sha256(stableJson(readObligations)) } : {}),
    completeness: buildCompleteness(plan),
    supplements: []
  };
}

function buildCompleteness(plan: InvestigationPlan): KnowledgeCompleteness {
  const disposed = plan.items.filter((item) => !["pending", "in_progress"].includes(item.status));
  const byStatus: Record<string, number> = {};
  for (const item of disposed) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  const materialFlowsWithTraces = plan.items.filter((item) => item.material && item.status === "found" && MATERIAL_FLOW_DIMENSIONS.has(item.dimension) && item.traceIds.length > 0).length;
  return { requiredItems: plan.items.length, disposed: disposed.length, byStatus, materialFlowsWithTraces, warnings: [] };
}

/**
 * Validate the supplement flag pair. The two flags are mutually required: passing one without the other
 * is a usage error, so the escape hatch always carries both a reason and the work item it is charged to.
 * Returns the normalized pair, or undefined when neither flag was supplied.
 */
export function normalizeSupplement(reason?: string, workItemId?: string): { reason: string; workItemId: string } | undefined {
  const hasReason = Boolean(reason?.trim());
  const hasItem = Boolean(workItemId?.trim());
  if (hasReason !== hasItem) throw new Error("A supplement requires both --supplement-reason and --supplement-workitem; provide them together.");
  if (!hasReason) return undefined;
  return { reason: reason!.trim(), workItemId: workItemId!.trim() };
}

/** Append one supplement entry to the frozen record. Supplements are the one field freeze leaves mutable;
 *  appending never touches the frozen core, so `knowledgeDigest` stays constant. */
export async function recordSupplement(runDir: string, command: string, ids: string[], supplement: { reason: string; workItemId: string }): Promise<void> {
  const path = join(runDir, "knowledge.json");
  const knowledge = await readJson<KnowledgeArtifact>(path);
  knowledge.supplements.push({ at: nowIso(), command, ids, reason: supplement.reason, workItemId: supplement.workItemId });
  await writeJson(path, knowledge);
}

/**
 * Reconcile a run against its frozen knowledge. Self-gated: a run with no `knowledge.json` (a legacy run,
 * or one that was never frozen) is grandfathered and no check fires — so the new assurance never
 * retroactively fails historical or unfrozen runs. When the record exists, every check is an error:
 *
 *  1. the frozen core digest still matches the run manifest;
 *  2. every evidence id not present at freeze is charged to a recorded supplement;
 *  3. every work item whose disposition changed (or that appeared) after freeze is charged to a supplement;
 *  4. every trace added after freeze is charged to a supplement;
 *  5. every gated investigation timeline event after the freeze event carries the supplement marker.
 */
export async function auditFrozenKnowledge(runDir: string, manifest: RunManifest, evidence: EvidenceItem[], plan: InvestigationPlan, traces: TraceCatalog): Promise<AuditFinding[]> {
  const path = join(runDir, "knowledge.json");
  if (!await exists(path)) return [];
  const knowledge = await readJson<KnowledgeArtifact>(path);
  const findings: AuditFinding[] = [];
  if (knowledgeDigest(knowledge) !== manifest.knowledgeDigest) findings.push(error("knowledge", "frozen knowledge digest does not match the run manifest"));
  // Symmetric to the "added after freeze" checks below: the frozen set must remain a subset of the
  // current artifacts. A legitimate supplement only ever adds; a frozen evidence id, work item or trace
  // that has vanished from the run is a silent deletion of recorded knowledge, so it is always an error.
  // (A supplement can revise a disposition but cannot un-record an item, so no supplement exemption applies.)
  const currentEvidence = new Set(evidence.map((item) => item.id));
  for (const id of knowledge.evidenceIds) if (!currentEvidence.has(id)) findings.push(error("knowledge", `frozen evidence ${id} is no longer present in the run`));
  const currentWorkItems = new Set(plan.items.map((item) => item.id));
  for (const entry of knowledge.workitems) if (!currentWorkItems.has(entry.id)) findings.push(error("knowledge", `frozen work item ${entry.id} is no longer present in the run`));
  const currentTraces = new Set(traces.traces.map((trace) => trace.id));
  for (const id of knowledge.traceIds) if (!currentTraces.has(id)) findings.push(error("knowledge", `frozen trace ${id} is no longer present in the run`));
  // Any id named by any supplement is accounted for; ids are namespaced by prefix so a single set is safe.
  const supplemented = new Set(knowledge.supplements.flatMap((entry) => entry.ids));
  const frozenEvidence = new Set(knowledge.evidenceIds);
  for (const item of evidence) if (!frozenEvidence.has(item.id) && !supplemented.has(item.id)) findings.push(error("knowledge", `evidence ${item.id} was added after freeze without a recorded supplement`));
  const frozenStatus = new Map(knowledge.workitems.map((entry) => [entry.id, entry.status]));
  for (const item of plan.items) {
    const before = frozenStatus.get(item.id);
    if (before === undefined) {
      if (!supplemented.has(item.id)) findings.push(error("knowledge", `work item ${item.id} was added after freeze without a recorded supplement`));
      continue;
    }
    if (before !== item.status && !supplemented.has(item.id)) findings.push(error("knowledge", `work item ${item.id} disposition changed after freeze without a recorded supplement`));
  }
  const frozenTraces = new Set(knowledge.traceIds);
  for (const trace of traces.traces) if (!frozenTraces.has(trace.id) && !supplemented.has(trace.id)) findings.push(error("knowledge", `trace ${trace.id} was added after freeze without a recorded supplement`));
  const timeline = await readTimeline(runDir);
  const frozenSequence = timeline.find((event) => event.action === "investigation.frozen")?.sequence ?? Number.POSITIVE_INFINITY;
  for (const event of timeline) {
    if (event.sequence > frozenSequence && GATED_TIMELINE_ACTIONS.has(event.action) && (event.data as Record<string, unknown> | undefined)?.supplement !== true) {
      findings.push(error("knowledge", `timeline event ${event.sequence} (${event.action}) mutated investigation state after freeze without a supplement marker`));
    }
  }
  return findings;
}

/**
 * The freeze-before-authoring order gate — the audit-time counterpart of the `begin` hard gate. It fires
 * only for runs prepared under the current assurance version (older runs authored before freeze existed
 * are grandfathered), and only once a run actually has authoring activity: an investigation still in
 * progress, never frozen and never authored, is legitimately un-gated. When an authoring-stage event
 * exists it demands an `investigation.frozen` event that precedes it. Findings use the `"freeze"`
 * document key (distinct from the frozen-knowledge reconciliation, which uses `"knowledge"`).
 *
 *  1. authoring activity but no `investigation.frozen` event at all → error;
 *  2. the first authoring event precedes the freeze event → error (authored, then froze).
 */
export async function auditFreezeOrder(runDir: string, manifest: RunManifest): Promise<AuditFinding[]> {
  if (!runUsesCurrentAssurance(manifest)) return [];
  const timeline = await readTimeline(runDir);
  const firstAuthoring = timeline.find((event) => event.stage === "authoring");
  if (!firstAuthoring) return [];
  const frozen = timeline.find((event) => event.action === "investigation.frozen");
  if (!frozen) return [error("freeze", "run has authoring activity but was never frozen; the current assurance version requires freeze before authoring")];
  if (firstAuthoring.sequence < frozen.sequence) return [error("freeze", "run was authored before the investigation was frozen (first authoring event precedes investigation.frozen)")];
  return [];
}
