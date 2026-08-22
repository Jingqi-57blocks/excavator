import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { auditEvidenceCatalog, auditTraces, auditWorkItems } from "../investigation/assurance.ts";
import { EPOCH_SEAL_ASSURANCE_GENERATION, assuranceGenerationAtLeast, runUsesCurrentAssurance } from "../base/assurance-version.ts";
import type { AuditFinding, EvidenceItem, InvestigationPlan, KnowledgeArtifact, KnowledgeCompleteness, KnowledgeSupplement, RunManifest, TraceCatalog } from "../base/types.ts";
import { readTimeline } from "../base/timeline.ts";
import { atomicWrite, canonicalJson, exists, nowIso, readJson, REDACTION_VERSION, sha256, stableJson } from "../base/util.ts";
import {
  APPEND_STREAM_VERSION, appendJsonArrayValue, nextStreamDigest, readCheckpoint, withRunWriter, writeCheckpoint,
  type StreamCheckpoint
} from "../base/single-writer.ts";
import {
  auditEvidenceStorage, canonicalEvidenceDigest, EVIDENCE_BOUND_POLICY_VERSION, evidenceStreamDigest
} from "../investigation/evidence-store.ts";
import {
  CURRENT_JUDGEMENT_SEAL, judgementSeal, readJudgementSeal, type JudgementSealVersion, type RecordedJudgementSeal
} from "./judgement-seal.ts";

/**
 * "First freeze, then write." This module owns the deterministic, model-free machinery that turns a
 * completed investigation into a frozen `knowledge.json` record and later reconciles the run against
 * it. It reuses the existing assurance rules verbatim (`auditWorkItems`/`auditTraces`/
 * `auditEvidenceCatalog`) so the freeze gate and the full audit can never drift into two rule sets.
 */

/** The investigation-stage timeline actions the escape hatch must mark as a supplement once a run is frozen. */
const GATED_TIMELINE_ACTIONS = new Set(["source.search", "source.window", "workitems.updated", "traces.updated"]);

function error(document: string, message: string): AuditFinding { return { level: "error", document, message }; }

/** Digest over the frozen core: the whole artifact except its append-only `supplements` ledger. */
export function knowledgeDigest(knowledge: KnowledgeArtifact): string {
  const { supplements, ...core } = knowledge;
  return sha256(stableJson(core));
}

/**
 * The snapshot re-derivation result, computed by the caller (`createSnapshot` lives in the orchestrator).
 *
 * `comparable` is the field that had to be added. Two snapshot ids can only be compared when they were derived
 * by the same scanner generation; when the generation changed, the recorded id is not "different", it is
 * INCOMPARABLE — and reporting that as a changed source tree would false-fail every archived run at once. Which
 * side is which is named, because a message that cannot say what changed cannot be acted on.
 */
export interface SnapshotDrift {
  comparable: boolean;
  recordedScannerVersion: string;
  currentScannerVersion: string;
  snapshotChanged: boolean;
  codegraphChanged: boolean;
}

export interface FreezePreconditionInput {
  runDir: string;
  manifest: RunManifest;
  plan: InvestigationPlan;
  expectedPlan: InvestigationPlan;
  evidence: EvidenceItem[];
  evidenceById: Map<string, EvidenceItem>;
  traces: TraceCatalog;
  documentIds: Set<string>;
  snapshotDrift: SnapshotDrift | null;
  /** Contract-instance findings, computed by the caller against the run's own `contract-manifest.json`. */
  contractFindings: AuditFinding[];
}

/**
 * The investigation-side gate. Freezing is allowed only when the investigation would already pass the
 * same catalog/work-item/trace/snapshot assertions the full audit applies — so a frozen run is one that
 * was audit-clean at freeze time. Returns findings; an empty error set means the run may be frozen.
 */
export async function freezePreconditions(input: FreezePreconditionInput): Promise<AuditFinding[]> {
  const { runDir, manifest, plan, expectedPlan, evidence, evidenceById, traces, documentIds, snapshotDrift, contractFindings } = input;
  const findings: AuditFinding[] = [...contractFindings];
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const traceIds = new Set(traces.traces.map((trace) => trace.id));
  if (manifest.evidenceDigest !== evidenceStreamDigest(evidence)) findings.push(error("evidence", "evidence catalog changed outside the recorded source-evidence workflow"));
  findings.push(...(await auditEvidenceStorage(runDir, evidence, manifest.request.redactSecrets === true)).map((message) => error("evidence", message)));
  findings.push(...await auditEvidenceCatalog(runDir, manifest, evidence));
  findings.push(...auditWorkItems(plan, expectedPlan, evidenceById, traceIds));
  // Claims do not exist yet at freeze time, so no trace step can legitimately cite one: pass an empty set.
  findings.push(...auditTraces(traces, documentIds, evidenceIds, new Set<string>()));
  if (snapshotDrift && !snapshotDrift.comparable) {
    // Freezing is a claim that the run's inputs are pinned. If the identity cannot even be re-derived, that
    // claim cannot be made — so this is an error at freeze, while audit reports the same fact as a limit.
    findings.push(error("snapshot", `the source snapshot identity cannot be re-derived: this run was prepared by scanner ${snapshotDrift.recordedScannerVersion} and the current scanner is ${snapshotDrift.currentScannerVersion}. Re-prepare the run to freeze it under the current scanner.`));
  }
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
  /** The boundary-function second source, so tampering with it after freeze is detectable (57B-396). */
  boundaryFunctions?: unknown | null;
  /** The resolved cross-repo links, pinned for the same reason (57B-398). */
  crossRepoLinks?: unknown | null;
  /** The layer-2 mechanism ledger, pinned so the coverage declarations this run applied cannot be restated
   *  after the fact. Optional and absent-when-null, so archived runs need no migration. */
  mechanismsLedger?: unknown | null;
  /** Layer-7 ReadSpec executions and obligation dispositions, sealed with their evidence ids. */
  investigationResults?: unknown | null;
  /** Layer-8's domain conjunction, closure split and executed check-family ledger. */
  completeness: KnowledgeCompleteness;
  /**
   * Where each append-until-freeze stream stood at this seal: the cutoff and the tail digest. Computed by the
   * caller because the timeline is read from disk. Every epoch audit enforces the three registered streams,
   * their monotonic cutoffs and the digest at each cutoff.
   */
  appendStreams?: Array<{ id: string; frozenThroughSequence: number; tailDigest: string }>;
  /** The immutable epoch being created. Epoch 0 stays at knowledge.json for archive compatibility. */
  epoch?: number;
  /** Digest of epoch N-1. Required for every epoch after zero and forbidden on epoch zero. */
  previousEpochDigest?: string;
}

/** Normalize order-insensitive L7 result sets before sealing them. */
export function canonicalInvestigationResults(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const sorted = (key: string): unknown => {
    const rows = source[key];
    if (!Array.isArray(rows)) return rows;
    return [...rows].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  };
  return {
    ...source,
    ...(Array.isArray(source.judgements) ? { judgements: sorted("judgements") } : {}),
    ...(Array.isArray(source.executions) ? { executions: sorted("executions") } : {}),
    ...(Array.isArray(source.dispositions) ? { dispositions: sorted("dispositions") } : {}),
    ...(Array.isArray(source.residuals) ? { residuals: sorted("residuals") } : {})
  };
}

/**
 * Seal the work-item ledger and the L7 judgements — the status-only workitems digest is not a judgement
 * identity. `version` is required, not defaulted: freeze writes the current seal while audit must recompute
 * under the version the archive recorded, and a default would let either site drift into the other's job.
 * The field set per version lives in `judgement-seal.ts`.
 */
export function judgementDigest(plan: InvestigationPlan, investigationResults: unknown | null, version: JudgementSealVersion): string {
  return judgementSeal(plan.items, canonicalInvestigationResults(investigationResults), version);
}

/**
 * Reconcile a recorded seal with the current ledger under the version the record itself names, so an epoch
 * sealed by an older build is checked against the field set it actually sealed and never false-fails.
 * An unreadable label is reported rather than guessed at: recomputing under an assumed field set would yield
 * a mismatch that says nothing about whether the ledger changed.
 */
function auditSealedJudgement(seal: RecordedJudgementSeal, plan: InvestigationPlan, investigationResults: unknown): AuditFinding[] {
  if (seal.version === "unreadable") return [error("knowledge", `latest sealed judgement digest does not name a readable seal version: ${seal.value}`)];
  if (seal.value !== judgementDigest(plan, investigationResults, seal.version)) {
    return [error("knowledge", "current work-item and L7 judgements do not match the latest sealed judgement digest")];
  }
  return [];
}

/** Build the knowledge-v1 record: frozen fingerprints of the run's artifacts plus a completeness report. */
export function buildKnowledge(input: BuildKnowledgeInput): KnowledgeArtifact {
  const { manifest, plan, evidence, traces, factPacks, crossFeature, frozenAt, readObligations, boundaryFunctions, crossRepoLinks, mechanismsLedger, investigationResults, completeness, appendStreams } = input;
  const epoch = input.epoch ?? 0;
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`Invalid knowledge epoch: ${epoch}`);
  if (epoch === 0 && input.previousEpochDigest !== undefined) throw new Error("Epoch 0 cannot name a previous epoch digest");
  if (epoch > 0 && !input.previousEpochDigest) throw new Error(`Epoch ${epoch} requires the previous epoch digest`);
  const evidenceIds = evidence.map((item) => item.id).sort((a, b) => a.localeCompare(b));
  const workitems = plan.items.map((item) => ({ id: item.id, status: item.status })).sort((a, b) => a.id.localeCompare(b.id));
  const traceIds = traces.traces.map((trace) => trace.id).sort((a, b) => a.localeCompare(b));
  const canonicalTraces = { ...traces, traces: [...traces.traces].sort((a, b) => a.id.localeCompare(b.id)) };
  const canonicalResults = canonicalInvestigationResults(investigationResults);
  const factPackDigests: Record<string, string> = {};
  for (const [key, pack] of Object.entries(factPacks).sort(([a], [b]) => a.localeCompare(b))) factPackDigests[key] = sha256(stableJson(pack));
  return {
    version: "knowledge-v1",
    runId: manifest.id,
    snapshotId: manifest.snapshot?.id ?? "",
    assuranceVersion: manifest.assuranceVersion,
    frozenAt,
    evidenceIds,
    evidenceDigest: canonicalEvidenceDigest(evidence),
    workitems,
    workitemsDigest: sha256(stableJson(workitems)),
    traceIds,
    tracesDigest: sha256(canonicalJson(canonicalTraces)),
    factPackDigests,
    ...(crossFeature != null ? { crossFeatureDigest: sha256(stableJson(crossFeature)) } : {}),
    ...(readObligations != null ? { readObligationsDigest: sha256(stableJson(readObligations)) } : {}),
    ...(boundaryFunctions != null ? { boundaryFunctionsDigest: sha256(stableJson(boundaryFunctions)) } : {}),
    ...(crossRepoLinks != null ? { crossRepoLinksDigest: sha256(stableJson(crossRepoLinks)) } : {}),
    ...(mechanismsLedger != null ? { mechanismsLedgerDigest: sha256(stableJson(mechanismsLedger)) } : {}),
    ...(investigationResults != null ? { investigationResultsDigest: sha256(canonicalJson(canonicalResults)) } : {}),
    judgementDigest: judgementDigest(plan, investigationResults, CURRENT_JUDGEMENT_SEAL),
    truncationPolicy: {
      evidenceBounds: EVIDENCE_BOUND_POLICY_VERSION,
      redactionVersion: `${REDACTION_VERSION}${manifest.request.redactSecrets === true ? "-redacted" : "-plain"}`
    },
    completeness,
    epoch,
    ...(input.previousEpochDigest ? { previousEpochDigest: input.previousEpochDigest } : {}),
    ...(appendStreams ? { appendStreams } : {}),
    supplements: []
  };
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

const SUPPLEMENT_STREAM = "supplement";
const SUPPLEMENT_LEDGER = join("knowledge", "supplements.json");

/** The stable archive location of epoch 0 and the append-only locations of subsequent epochs. */
export function knowledgeEpochRelativePath(epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`Invalid knowledge epoch: ${epoch}`);
  return epoch === 0 ? "knowledge.json" : join("knowledge", "epochs", `epoch-${epoch}.json`);
}

/**
 * The run-relative path of the epoch this manifest selects.
 *
 * WHY IT IS A FUNCTION AND NOT AN EXPRESSION AT EACH READER. It is the only place `manifest.knowledgeEpoch ??
 * 0` — the legacy reading of a manifest recorded before the field existed — is written down. A reader that
 * spelled the fallback itself would own a second copy of that interpretation, and two copies of "which epoch is
 * current" drift the moment one of them is updated. Callers outside `src/freeze/` select an epoch; they never
 * map one to a path.
 */
export function currentKnowledgeRelativePath(manifest: RunManifest): string {
  return knowledgeEpochRelativePath(manifest.knowledgeEpoch ?? 0);
}

/** Read the manifest-selected epoch. Field-less manifests retain the legacy knowledge.json interpretation. */
export async function readCurrentKnowledge(runDir: string, manifest: RunManifest): Promise<KnowledgeArtifact> {
  return readJson<KnowledgeArtifact>(join(runDir, currentKnowledgeRelativePath(manifest)));
}

/** Authoring may consume only an epoch that includes every supplement committed so far. */
export async function assertCurrentKnowledgeEpochForAuthoring(runDir: string, manifest: RunManifest): Promise<void> {
  if (!runUsesCurrentAssurance(manifest)) return;
  if (!manifest.frozenAt) {
    throw new Error(`Run is not frozen; the current assurance version requires freezing the investigation before authoring. Run \`excavator freeze --run ${runDir}\` first.`);
  }
  if (manifest.knowledgeEpoch === undefined) throw new Error("The run has no current knowledge epoch; re-prepare it under the current assurance version");
  const knowledge = await readCurrentKnowledge(runDir, manifest);
  if (knowledgeDigest(knowledge) !== manifest.knowledgeDigest) throw new Error("The latest knowledge epoch does not match the run manifest; run audit before authoring");
  const sealed = appendStream(knowledge, "supplements");
  const checkpoint = await readCheckpoint(runDir, SUPPLEMENT_STREAM);
  if (!sealed || !checkpoint) throw new Error("The latest knowledge epoch has no verifiable supplement cutoff; run audit before authoring");
  if (checkpoint.sequence > sealed.frozenThroughSequence) {
    throw new Error(`Knowledge epoch ${manifest.knowledgeEpoch} has unsealed supplements; run \`excavator freeze --run ${runDir}\` again before authoring.`);
  }
  if (checkpoint.sequence !== sealed.frozenThroughSequence || checkpoint.tailDigest !== sealed.tailDigest) {
    throw new Error("The supplement stream no longer matches the latest knowledge epoch; run audit before authoring");
  }
}

interface SupplementLedger { supplements: KnowledgeSupplement[] }

async function readSupplementLedger(runDir: string, legacyKnowledge?: KnowledgeArtifact): Promise<{ ledger: SupplementLedger; path: string; modern: boolean }> {
  const modernPath = join(runDir, SUPPLEMENT_LEDGER);
  if (await exists(modernPath)) return { ledger: await readJson<SupplementLedger>(modernPath), path: modernPath, modern: true };
  const legacyPath = join(runDir, "knowledge.json");
  const knowledge = legacyKnowledge ?? await readJson<KnowledgeArtifact>(legacyPath);
  return { ledger: { supplements: knowledge.supplements ?? [] }, path: legacyPath, modern: false };
}

/** Append one supplement intent. Modern runs append to a separate ledger; archived runs keep their inline one. */
export async function recordSupplement(runDir: string, command: string, ids: string[], supplement: { reason: string; workItemId: string }): Promise<void> {
  const entry = { at: nowIso(), command, ids, reason: supplement.reason, workItemId: supplement.workItemId };
  await withRunWriter(runDir, async () => {
    const checkpoint = await readCheckpoint(runDir, SUPPLEMENT_STREAM);
    if (!checkpoint) throw new Error("Frozen knowledge has no supplement append checkpoint; re-prepare the run under the current schema");
    const modernPath = join(runDir, SUPPLEMENT_LEDGER);
    const target = await exists(modernPath) ? modernPath : join(runDir, "knowledge.json");
    const next = await appendJsonArrayValue(target, checkpoint, entry);
    await writeCheckpoint(runDir, next);
  });
}

/** Write one immutable epoch. Epoch zero also initializes the separate O(1) supplement ledger. */
export async function writeKnowledgeArtifact(runDir: string, knowledge: KnowledgeArtifact): Promise<StreamCheckpoint> {
  if (knowledge.supplements.length) throw new Error("A newly sealed knowledge artifact must start with no supplements");
  return withRunWriter(runDir, async () => {
    const epoch = knowledge.epoch ?? 0;
    const target = join(runDir, knowledgeEpochRelativePath(epoch));
    if (await exists(target)) throw new Error(`Knowledge epoch ${epoch} already exists and cannot be overwritten`);
    const existing = await readCheckpoint(runDir, SUPPLEMENT_STREAM);
    if (epoch > 0) {
      if (!existing || !await exists(join(runDir, SUPPLEMENT_LEDGER))) {
        throw new Error("A later knowledge epoch requires the existing supplement ledger and checkpoint");
      }
      await atomicWrite(target, `${canonicalJson(knowledge)}\n`);
      return existing;
    }
    if (existing || await exists(join(runDir, SUPPLEMENT_LEDGER))) {
      throw new Error("Knowledge epoch 0 cannot replace an existing supplement ledger or checkpoint");
    }
    await atomicWrite(target, `${canonicalJson(knowledge)}\n`);
    const prefix = '{"supplements":[';
    await writeJsonArrayArtifact(join(runDir, SUPPLEMENT_LEDGER), prefix);
    const checkpoint: StreamCheckpoint = {
      version: APPEND_STREAM_VERSION,
      stream: SUPPLEMENT_STREAM,
      sequence: 0,
      tailDigest: "",
      byteOffset: Buffer.byteLength(prefix)
    };
    await writeCheckpoint(runDir, checkpoint);
    return checkpoint;
  });
}

async function writeJsonArrayArtifact(path: string, prefix: string): Promise<void> {
  await atomicWrite(path, `${prefix}]}\n`);
}

function appendStream(knowledge: KnowledgeArtifact, id: string): { id: string; frozenThroughSequence: number; tailDigest: string } | undefined {
  return knowledge.appendStreams?.find((entry) => entry.id === id);
}

function supplementTail(entries: readonly KnowledgeSupplement[], count = entries.length): string {
  let tail = "";
  for (let index = 0; index < count; index += 1) tail = nextStreamDigest(tail, index + 1, entries[index]);
  return tail;
}

async function auditSupplementLedger(runDir: string, ledger: SupplementLedger, path: string): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  let checkpoint: StreamCheckpoint | null = null;
  try { checkpoint = await readCheckpoint(runDir, SUPPLEMENT_STREAM); }
  catch (cause) { return [error("knowledge", `supplement checkpoint is invalid: ${(cause as Error).message}`)]; }
  if (!checkpoint) return [error("knowledge", "supplement ledger has no append checkpoint")];
  const tail = supplementTail(ledger.supplements);
  if (checkpoint.sequence !== ledger.supplements.length) findings.push(error("knowledge", "supplement checkpoint sequence does not match the ledger"));
  if (checkpoint.tailDigest !== tail) findings.push(error("knowledge", "supplement checkpoint has an invalid tail digest"));
  const bytes = await stat(path).then((value) => value.size).catch(() => 0);
  if (checkpoint.byteOffset + Buffer.byteLength("]}\n") !== bytes) findings.push(error("knowledge", "supplement checkpoint has an invalid byte offset"));
  return findings;
}

function auditAppendStreamSeals(
  knowledge: KnowledgeArtifact,
  evidence: readonly EvidenceItem[],
  timeline: Awaited<ReturnType<typeof readTimeline>>,
  supplements: readonly KnowledgeSupplement[]
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const epoch = knowledge.epoch ?? 0;
  if (!Array.isArray(knowledge.appendStreams)) return [error("knowledge", `epoch ${epoch} has no valid append-stream seal set`)];
  const entries = knowledge.appendStreams.filter((entry) => entry && typeof entry === "object");
  const required = ["evidence.json", "timeline.jsonl", "supplements"];
  for (const id of required) {
    const matches = entries.filter((entry) => entry.id === id);
    if (matches.length !== 1) findings.push(error("knowledge", `epoch ${epoch} must seal append stream ${id} exactly once`));
  }
  for (const entry of entries) {
    if (!required.includes(entry.id)) findings.push(error("knowledge", `epoch ${epoch} seals unknown append stream ${entry.id}`));
    if (!Number.isSafeInteger(entry.frozenThroughSequence) || entry.frozenThroughSequence < 0) {
      findings.push(error("knowledge", `epoch ${epoch} has an invalid ${entry.id} cutoff`));
    }
  }
  const evidenceSeal = appendStream(knowledge, "evidence.json");
  if (evidenceSeal && evidenceSeal.frozenThroughSequence <= evidence.length) {
    const tail = canonicalEvidenceDigest(evidence.slice(0, evidenceSeal.frozenThroughSequence));
    if (tail !== evidenceSeal.tailDigest) findings.push(error("knowledge", `epoch ${epoch} evidence cutoff has an invalid tail digest`));
  } else if (evidenceSeal) findings.push(error("knowledge", `epoch ${epoch} evidence cutoff exceeds the current stream`));
  const timelineSeal = appendStream(knowledge, "timeline.jsonl");
  if (timelineSeal && timelineSeal.frozenThroughSequence <= timeline.length) {
    const tail = timelineSeal.frozenThroughSequence === 0 ? "" : timeline[timelineSeal.frozenThroughSequence - 1]?.digest ?? "";
    if (tail !== timelineSeal.tailDigest) findings.push(error("knowledge", `epoch ${epoch} timeline cutoff has an invalid tail digest`));
  } else if (timelineSeal) findings.push(error("knowledge", `epoch ${epoch} timeline cutoff exceeds the current stream`));
  const supplementSeal = appendStream(knowledge, "supplements");
  if (supplementSeal && supplementSeal.frozenThroughSequence <= supplements.length) {
    if (supplementTail(supplements, supplementSeal.frozenThroughSequence) !== supplementSeal.tailDigest) {
      findings.push(error("knowledge", `epoch ${epoch} supplement cutoff has an invalid tail digest`));
    }
  } else if (supplementSeal) findings.push(error("knowledge", `epoch ${epoch} supplement cutoff exceeds the current stream`));
  return findings;
}

/**
 * Reconcile the latest immutable epoch and, for generation 16+, every link behind it. Legacy inline-ledger
 * records retain their old interpretation; no archived run is assigned epoch semantics retroactively.
 */
export async function auditFrozenKnowledge(
  runDir: string,
  manifest: RunManifest,
  evidence: EvidenceItem[],
  plan: InvestigationPlan,
  traces: TraceCatalog,
  investigationResults?: unknown
): Promise<AuditFinding[]> {
  const epochZeroPath = join(runDir, "knowledge.json");
  if (!await exists(epochZeroPath)) {
    return assuranceGenerationAtLeast(manifest, EPOCH_SEAL_ASSURANCE_GENERATION) && manifest.frozenAt
      ? [error("knowledge", "current epoch-seal run is frozen but knowledge epoch 0 is missing")]
      : [];
  }
  const findings: AuditFinding[] = [];
  if (assuranceGenerationAtLeast(manifest, EPOCH_SEAL_ASSURANCE_GENERATION) && manifest.knowledgeEpoch === undefined) {
    findings.push(error("knowledge", "current epoch-seal run has no latest knowledge epoch in the manifest"));
  }
  const modern = manifest.knowledgeEpoch !== undefined;
  const epochs: KnowledgeArtifact[] = [];
  if (modern) {
    if (!Number.isSafeInteger(manifest.knowledgeEpoch) || manifest.knowledgeEpoch! < 0) {
      return [error("knowledge", "run manifest has an invalid latest knowledge epoch")];
    }
    for (let epoch = 0; epoch <= manifest.knowledgeEpoch!; epoch += 1) {
      const relativePath = knowledgeEpochRelativePath(epoch);
      try {
        const item = await readJson<KnowledgeArtifact>(join(runDir, relativePath));
        epochs.push(item);
      } catch (cause) {
        findings.push(error("knowledge", `knowledge epoch ${epoch} cannot be read at ${relativePath}: ${(cause as Error).message}`));
        return findings;
      }
    }
    const epochDir = join(runDir, "knowledge", "epochs");
    if (await exists(epochDir)) {
      const expected = new Set(Array.from({ length: manifest.knowledgeEpoch! }, (_, index) => `epoch-${index + 1}.json`));
      for (const name of await readdir(epochDir)) {
        if (!expected.has(name)) findings.push(error("knowledge", `unmanifested or malformed knowledge epoch file exists: knowledge/epochs/${name}`));
      }
    }
  } else {
    epochs.push(await readJson<KnowledgeArtifact>(epochZeroPath));
  }
  const knowledge = epochs.at(-1)!;
  let supplementState: Awaited<ReturnType<typeof readSupplementLedger>>;
  try { supplementState = await readSupplementLedger(runDir, modern ? undefined : knowledge); }
  catch (cause) { return [...findings, error("knowledge", `supplement ledger cannot be read: ${(cause as Error).message}`)]; }
  if (modern && !supplementState.modern) findings.push(error("knowledge", "epoch-seal run has no separate supplement ledger"));
  const supplements = supplementState.ledger.supplements;
  if (!Array.isArray(supplements)) return [...findings, error("knowledge", "supplement ledger does not contain an array")];
  for (let index = 0; index < supplements.length; index += 1) {
    const entry = supplements[index] as Partial<KnowledgeSupplement> | null;
    if (!entry || !Array.isArray(entry.ids) || typeof entry.at !== "string" || typeof entry.command !== "string"
      || typeof entry.reason !== "string" || typeof entry.workItemId !== "string") {
      findings.push(error("knowledge", `supplement ledger entry ${index + 1} is malformed`));
    }
  }
  findings.push(...await auditSupplementLedger(runDir, supplementState.ledger, supplementState.path));

  const timeline = await readTimeline(runDir);
  const freezeEvents = timeline.filter((event) => event.action === "investigation.frozen" || event.action === "investigation.refrozen");
  if (modern) {
    if (freezeEvents.length !== epochs.length) {
      findings.push(error("knowledge", `knowledge has ${epochs.length} epoch(s) but the timeline has ${freezeEvents.length} freeze event(s)`));
    }
    let previousDigest: string | undefined;
    let previousCutoffs = { evidence: -1, timeline: -1, supplements: -1 };
    for (let epoch = 0; epoch < epochs.length; epoch += 1) {
      const item = epochs[epoch];
      if (item.epoch !== epoch) findings.push(error("knowledge", `knowledge epoch file ${epoch} declares epoch ${String(item.epoch)}`));
      if (item.runId !== manifest.id || item.snapshotId !== (manifest.snapshot?.id ?? "")) {
        findings.push(error("knowledge", `knowledge epoch ${epoch} does not belong to this run and snapshot`));
      }
      if (!Array.isArray(item.supplements) || item.supplements.length !== 0) findings.push(error("knowledge", `immutable knowledge epoch ${epoch} contains invalid inline supplements`));
      if (item.assuranceVersion !== manifest.assuranceVersion) findings.push(error("knowledge", `knowledge epoch ${epoch} has a different assurance version from the run`));
      if (epoch === 0 && item.previousEpochDigest !== undefined) findings.push(error("knowledge", "knowledge epoch 0 names a previous epoch digest"));
      if (epoch > 0 && item.previousEpochDigest !== previousDigest) findings.push(error("knowledge", `knowledge epoch ${epoch} does not pin epoch ${epoch - 1}`));
      if (!item.judgementDigest) findings.push(error("knowledge", `knowledge epoch ${epoch} has no judgement digest`));
      const expectedPolicy = {
        evidenceBounds: EVIDENCE_BOUND_POLICY_VERSION,
        redactionVersion: `${REDACTION_VERSION}${manifest.request.redactSecrets === true ? "-redacted" : "-plain"}`
      };
      if (canonicalJson(item.truncationPolicy) !== canonicalJson(expectedPolicy)) findings.push(error("knowledge", `knowledge epoch ${epoch} does not pin the run's evidence-bound and redaction policy`));
      findings.push(...auditAppendStreamSeals(item, evidence, timeline, supplements));
      const evidenceCutoff = appendStream(item, "evidence.json")?.frozenThroughSequence ?? -1;
      const timelineCutoff = appendStream(item, "timeline.jsonl")?.frozenThroughSequence ?? -1;
      const supplementCutoff = appendStream(item, "supplements")?.frozenThroughSequence ?? -1;
      if (evidenceCutoff < previousCutoffs.evidence || timelineCutoff < previousCutoffs.timeline || supplementCutoff < previousCutoffs.supplements) {
        findings.push(error("knowledge", `knowledge epoch ${epoch} moves an append-stream cutoff backwards`));
      }
      const freezeEvent = freezeEvents[epoch];
      if (freezeEvent) {
        const expectedAction = epoch === 0 ? "investigation.frozen" : "investigation.refrozen";
        const data = freezeEvent.data as Record<string, unknown> | undefined;
        if (freezeEvent.action !== expectedAction) findings.push(error("knowledge", `knowledge epoch ${epoch} has timeline action ${freezeEvent.action}, expected ${expectedAction}`));
        if (data?.epoch !== epoch) findings.push(error("knowledge", `knowledge epoch ${epoch} is not named by its timeline freeze event`));
        if (data?.knowledgeDigest !== knowledgeDigest(item)) findings.push(error("knowledge", `knowledge epoch ${epoch} digest does not match its timeline freeze event`));
        if (timelineCutoff >= 0 && freezeEvent.sequence !== timelineCutoff + 1) {
          findings.push(error("knowledge", `knowledge epoch ${epoch} timeline cutoff is not immediately followed by its freeze event`));
        }
      }
      previousCutoffs = { evidence: evidenceCutoff, timeline: timelineCutoff, supplements: supplementCutoff };
      previousDigest = knowledgeDigest(item);
    }
  }
  if (knowledgeDigest(knowledge) !== manifest.knowledgeDigest) findings.push(error("knowledge", "latest frozen knowledge digest does not match the run manifest"));
  if (modern && knowledge.frozenAt !== manifest.frozenAt) findings.push(error("knowledge", "latest knowledge epoch timestamp does not match the run manifest"));
  if (knowledge.judgementDigest && investigationResults !== undefined) {
    findings.push(...auditSealedJudgement(readJudgementSeal(knowledge.judgementDigest), plan, investigationResults));
  }
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
  // Only entries after the latest epoch's cutoff authorize another mutation. Reusing a supplement consumed
  // by an earlier epoch would otherwise let the same id change indefinitely without a fresh intent record.
  const supplementCutoff = modern ? appendStream(knowledge, "supplements")?.frozenThroughSequence ?? supplements.length : 0;
  const pendingSupplements = supplements.slice(supplementCutoff);
  const supplemented = new Set(pendingSupplements.flatMap((entry) => Array.isArray(entry?.ids) ? entry.ids : []));
  if (modern && pendingSupplements.length === 0) {
    if (knowledge.evidenceDigest !== canonicalEvidenceDigest(evidence)) findings.push(error("knowledge", "current evidence set does not match the latest sealed evidence digest"));
    const currentWorkitems = plan.items.map((item) => ({ id: item.id, status: item.status })).sort((a, b) => a.id.localeCompare(b.id));
    if (knowledge.workitemsDigest !== sha256(stableJson(currentWorkitems))) findings.push(error("knowledge", "current work-item statuses do not match the latest sealed digest"));
    const currentTraces = { ...traces, traces: [...traces.traces].sort((a, b) => a.id.localeCompare(b.id)) };
    if (knowledge.tracesDigest !== sha256(canonicalJson(currentTraces))) findings.push(error("knowledge", "current traces do not match the latest sealed digest"));
  }
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
  const frozenSequence = freezeEvents.at(-1)?.sequence ?? Number.POSITIVE_INFINITY;
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
