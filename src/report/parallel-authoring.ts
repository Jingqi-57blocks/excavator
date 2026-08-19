import { rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuditFinding, DocumentPlan, DraftReceipt, RunManifest, SectionClaim } from "../base/types.ts";
import { validateClaimsInput } from "./section-audit.ts";
import { collectClaims } from "./assurance-artifacts.ts";
import { archiveCheckpoint, normalizeSection } from "./checkpoint.ts";
import { appendTimeline } from "../base/timeline.ts";
import { atomicWrite, exists, listDirectories, nowIso, readJson, writeJson } from "../base/util.ts";
import { assertCurrentKnowledgeEpochForAuthoring } from "../freeze/freeze.ts";
import { sectionPaths } from "./section-paths.ts";

/**
 * Parallel section authoring: "write in parallel, account serially."
 *
 * The wall-clock cost of authoring is the model generating each section, and those generations are
 * independent once the investigation is frozen. `draft` does the parallel-safe half of a checkpoint — it
 * produces a section, its claims and its history archive, all at per-(document, section) unique paths —
 * and never touches the run's shared ledger (timeline.jsonl, run.json, metrics.json, knowledge.json). N
 * drafts run concurrently because their write sets are provably disjoint, not because a lock serializes
 * them. `collect` is the single-writer barrier that reads the receipts each draft left and records the
 * sections into the timeline and manifest one at a time, exactly as a serial checkpoint would — so the
 * append-only hash chain the audit verifies is produced by construction, never by concurrent appends.
 */

/** The commit-marker path a draft writes last; `collect` consumes it and deletes it. */
function receiptPath(runDir: string, documentId: string, sectionIndex: number): string {
  return join(runDir, "drafts", documentId, `${String(sectionIndex).padStart(2, "0")}.json`);
}

/**
 * Draft one section: the parallel-safe half of a checkpoint. Validates the document/section and the freeze
 * gate read-only, normalizes the section and validates its claims (so a bad section is rejected at draft
 * time, not deferred to collect), archives any prior checkpoint, writes the section and claims files, and
 * finally writes the receipt as the commit marker. Every write is at a path unique to this (document,
 * section) — `sections/`, `claims/`, `history/`, `drafts/` — so any number of drafts for distinct sections
 * run concurrently without coordination. Touches no shared ledger.
 */
export async function draftSection(runDirInput: string, documentId: string, sectionIndex: number, content: string, claims?: SectionClaim[]): Promise<DraftReceipt> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  await assertCurrentKnowledgeEpochForAuthoring(runDir, manifest);
  const document = manifest.documents.find((item) => item.id === documentId);
  if (!document) throw new Error(`Unknown document: ${documentId}`);
  const section = document.sections.find((item) => item.index === sectionIndex);
  if (!section) throw new Error(`Unknown section ${sectionIndex} for ${documentId}`);
  const normalized = normalizeSection(content, section.title);
  const validated = claims ? validateClaimsInput(documentId, sectionIndex, claims) : undefined;
  const paths = sectionPaths(runDir, documentId, section);
  const revision = await archiveCheckpoint(runDir, documentId, paths.file, paths.claimsFile);
  await atomicWrite(paths.file, normalized);
  if (validated) await writeJson(paths.claimsFile, validated);
  const receipt: DraftReceipt = {
    version: 1,
    runId: manifest.id,
    ...(manifest.knowledgeEpoch !== undefined ? { knowledgeEpoch: manifest.knowledgeEpoch } : {}),
    documentId,
    section: sectionIndex,
    draftedAt: nowIso(),
    revision,
    evidenceIds: [...new Set((claims ?? []).flatMap((claim) => claim.evidenceIds ?? []))],
    traceIds: [...new Set((claims ?? []).flatMap((claim) => claim.traceIds ?? []))],
    hasClaims: Boolean(validated)
  };
  await writeJson(receiptPath(runDir, documentId, sectionIndex), receipt);
  return receipt;
}

/** The pending receipts, ordered deterministically: manifest document order, then section index ascending.
 *  Only receipts matching a known (document, section) are picked up; the ordering makes the emitted timeline
 *  event sequence a pure function of the manifest, independent of draft completion order. */
async function pendingReceipts(runDir: string, manifest: RunManifest): Promise<Array<{ receipt: DraftReceipt; path: string }>> {
  const draftsDir = join(runDir, "drafts");
  if (!await exists(draftsDir)) return [];
  const pending: Array<{ receipt: DraftReceipt; path: string }> = [];
  for (const document of manifest.documents) {
    if (!await exists(join(draftsDir, document.id))) continue;
    for (const section of [...document.sections].sort((a, b) => a.index - b.index)) {
      const path = receiptPath(runDir, document.id, section.index);
      if (await exists(path)) pending.push({ receipt: await readJson<DraftReceipt>(path), path });
    }
  }
  return pending;
}

/** Weak concurrency guard: `run.json` must be exactly what this barrier last wrote (or its initial state).
 *  A concurrent `begin`/`checkpoint`/`collect` — a violation of the serial-accounting contract — moves
 *  `updatedAt`, and this stops the barrier rather than letting the two writers race. Best-effort, not a lock. */
async function assertNotConcurrentlyModified(runPath: string, expectedUpdatedAt: string): Promise<void> {
  const onDisk = await readJson<RunManifest>(runPath);
  if (onDisk.updatedAt !== expectedUpdatedAt) {
    throw new Error("Run was modified concurrently during collect (run.json updatedAt changed); rerun collect after the concurrent command finishes.");
  }
}

/**
 * Collect all pending drafts: the single-writer serial barrier. Reads receipts in deterministic order and,
 * one at a time, verifies the drafted section (and claims, when present) are on disk, marks the section
 * complete, appends its `section.checkpoint`/`section.revised` event with the *unmodified* `appendTimeline`,
 * persists the manifest and metrics, then deletes the receipt. Because every append happens in this one
 * process in order, the sequence numbers stay contiguous and the digest chain stays intact by construction.
 * The claims metric and the author-budget check run once at the end; a budget overrun marks the run
 * timed-out with a warning but keeps every collected section (the budget stops the next section, not this
 * one). With no pending receipts it is a pure no-op, so it is safe to run repeatedly.
 */
export async function collectDrafts(runDirInput: string): Promise<{ manifest: RunManifest; collected: DraftReceipt[] }> {
  const runDir = resolve(runDirInput);
  const runPath = join(runDir, "run.json");
  const metricsPath = join(runDir, "metrics.json");
  const manifest = await readJson<RunManifest>(runPath);
  await assertCurrentKnowledgeEpochForAuthoring(runDir, manifest);
  const pending = await pendingReceipts(runDir, manifest);
  if (!pending.length) return { manifest, collected: [] };

  // Documents already completed before this barrier: collecting their sections is a revision of a
  // completed document, which never re-times or re-times-out the document (mirrors checkpointSection).
  const preCompletedDocuments = new Set(manifest.documents.filter((document) => document.completedAt).map((document) => document.id));
  const collectedDocumentIds = new Set<string>();
  const collected: DraftReceipt[] = [];
  let expectedUpdatedAt = manifest.updatedAt;

  for (const { receipt, path } of pending) {
    await assertNotConcurrentlyModified(runPath, expectedUpdatedAt);
    const document = manifest.documents.find((item) => item.id === receipt.documentId);
    if (!document) throw new Error(`Draft receipt references unknown document: ${receipt.documentId}`);
    if (manifest.knowledgeEpoch !== undefined && receipt.knowledgeEpoch !== manifest.knowledgeEpoch) {
      throw new Error(`Draft receipt for ${receipt.documentId} section ${receipt.section} was written from knowledge epoch ${String(receipt.knowledgeEpoch)}; re-draft it from current epoch ${manifest.knowledgeEpoch}`);
    }
    const section = document.sections.find((item) => item.index === receipt.section);
    if (!section) throw new Error(`Draft receipt references unknown section ${receipt.section} for ${receipt.documentId}`);
    // Fail closed: a receipt is a promise that the section (and its claims) are on disk. If the drafted
    // artifacts are gone, refuse rather than record a checkpoint for a section that is not there.
    const paths = sectionPaths(runDir, document.id, section);
    if (!await exists(paths.file)) throw new Error(`Draft receipt for ${receipt.documentId} section ${receipt.section} has no section file on disk`);
    if (receipt.hasClaims && !await exists(paths.claimsFile)) throw new Error(`Draft receipt for ${receipt.documentId} section ${receipt.section} claims a sidecar that is not on disk`);

    const revisingCompletedDocument = preCompletedDocuments.has(document.id);
    if (!document.startedAt) document.startedAt = nowIso();
    const elapsed = Date.now() - Date.parse(document.startedAt);
    section.complete = true;
    manifest.state = "authoring";
    if (!revisingCompletedDocument) {
      document.elapsedMs = elapsed;
      if (document.sections.every((item) => item.complete)) {
        document.completedAt = nowIso();
        document.elapsedMs = Date.now() - Date.parse(document.startedAt);
      }
    }
    if (manifest.documents.every((item) => item.sections.every((sectionItem) => sectionItem.complete))) manifest.state = "prepared";
    await appendTimeline(runDir, manifest.id, {
      stage: "authoring",
      action: receipt.revision ? "section.revised" : "section.checkpoint",
      documentId: receipt.documentId,
      section: receipt.section,
      evidenceIds: receipt.evidenceIds,
      traceIds: receipt.traceIds,
      data: { revision: receipt.revision, draftedAt: receipt.draftedAt, collected: true }
    });
    manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
    manifest.updatedAt = nowIso();
    await writeJson(runPath, manifest);
    await writeJson(metricsPath, manifest.metrics);
    await rm(path);
    expectedUpdatedAt = manifest.updatedAt;
    collectedDocumentIds.add(document.id);
    collected.push(receipt);
  }

  await assertNotConcurrentlyModified(runPath, expectedUpdatedAt);
  // Claims total is computed once over the whole run (O(N) reads, not the per-checkpoint O(N^2) rescan).
  manifest.metrics.claims = (await collectClaims(runDir, manifest.documents)).size;
  // Author budget stops the next section, never one already on disk: an overrun marks the run timed-out
  // and warns, but the collected sections stay recorded and resume can continue from the rest.
  const timedOut = manifest.documents.filter((document) =>
    collectedDocumentIds.has(document.id) && !preCompletedDocuments.has(document.id) &&
    document.elapsedMs !== undefined && document.elapsedMs > manifest.request.budgets.authorMs);
  if (timedOut.length) {
    manifest.state = "timed-out";
    for (const document of timedOut) {
      manifest.metrics.warnings.push(`${document.id} authoring exceeded ${manifest.request.budgets.authorMs}ms; drafted sections were collected before stopping.`);
    }
  }
  manifest.updatedAt = nowIso();
  await writeJson(runPath, manifest);
  await writeJson(metricsPath, manifest.metrics);
  return { manifest, collected };
}

/**
 * Warning-only audit advisory: uncollected drafts. Self-gated on the `drafts/` directory existing, so a run
 * that never drafted is untouched. It counts receipts left on disk — section drafts written but never
 * recorded into the timeline by `collect` — and surfaces them so an author does not assemble a run whose
 * ledger silently omits drafted sections. Additive and always advisory: it introduces no error-level rule
 * and does not bump the assurance version.
 */
export async function auditPendingDrafts(runDir: string): Promise<AuditFinding[]> {
  const draftsDir = join(runDir, "drafts");
  if (!await exists(draftsDir)) return [];
  let pending = 0;
  for (const documentDir of await listDirectories(draftsDir)) {
    for (const entry of await readdir(documentDir)) if (entry.endsWith(".json")) pending += 1;
  }
  if (!pending) return [];
  return [{ level: "warning", document: "drafts", message: `${pending} section draft(s) were written but never collected; run \`excavator collect\` to record them into the timeline before assembling.` }];
}
