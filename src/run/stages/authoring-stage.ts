import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { InvestigationPlan, RunManifest, SectionClaim, SectionClaimsFile, TraceCatalog } from "../../base/types.ts";
import { runUsesCurrentAssurance } from "../../base/assurance-version.ts";
import { atomicWrite, exists, nowIso, readJson, writeJson } from "../../base/util.ts";
import { appendTimeline, readTimeline } from "../../base/timeline.ts";
import { collectClaims, writeReportCompanions } from "../../report/assurance-artifacts.ts";
import { outputFrontMatter, reportFileName } from "../../report/authoring-plan.ts";
import { archiveCheckpoint, normalizeSection } from "../../report/checkpoint.ts";
import { scaffoldSectionClaims } from "../../report/claims-scaffold.ts";
import { validateClaimsInput } from "../../report/section-audit.ts";

export async function beginDocument(runDirInput: string, documentId: string): Promise<RunManifest> {
  const runDir = resolve(runDirInput);
  const path = join(runDir, "run.json");
  const manifest = await readJson<RunManifest>(path);
  // Freeze-before-authoring hard gate: under the current assurance version an unfrozen run cannot begin
  // authoring. Older runs (prepared before this version) are grandfathered and keep the soft path.
  if (runUsesCurrentAssurance(manifest) && !manifest.frozenAt) {
    throw new Error(`Run is not frozen; the current assurance version requires freezing the investigation before authoring. Run \`excavator freeze --run ${runDir}\` first.`);
  }
  const document = manifest.documents.find((item) => item.id === documentId);
  if (!document) throw new Error(`Unknown document: ${documentId}`);
  if (!document.startedAt || document.completedAt) {
    document.startedAt = nowIso();
    document.completedAt = undefined;
    document.elapsedMs = 0;
  }
  manifest.state = "authoring";
  manifest.updatedAt = nowIso();
  await appendTimeline(runDir, manifest.id, { stage: "authoring", action: "document.begin", documentId });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(path, manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  return manifest;
}

export async function checkpointSection(runDirInput: string, documentId: string, sectionIndex: number, content: string, claims?: SectionClaim[]): Promise<RunManifest> {
  const runDir = resolve(runDirInput);
  const path = join(runDir, "run.json");
  const manifest = await readJson<RunManifest>(path);
  const document = manifest.documents.find((item) => item.id === documentId);
  if (!document) throw new Error(`Unknown document: ${documentId}`);
  const section = document.sections.find((item) => item.index === sectionIndex);
  if (!section) throw new Error(`Unknown section ${sectionIndex} for ${documentId}`);
  const revisingCompletedDocument = Boolean(document.completedAt);
  if (!document.startedAt) document.startedAt = nowIso();
  const elapsed = Date.now() - Date.parse(document.startedAt);
  const normalized = normalizeSection(content, section.title);
  const revision = await archiveCheckpoint(runDir, documentId, section.file, section.claimsFile);
  await atomicWrite(section.file, normalized);
  if (claims) await writeJson(section.claimsFile, validateClaimsInput(documentId, sectionIndex, claims));
  section.complete = true;
  manifest.state = "authoring";
  manifest.updatedAt = nowIso();
  if (!revisingCompletedDocument) {
    document.elapsedMs = elapsed;
    if (document.sections.every((item) => item.complete)) {
      document.completedAt = nowIso();
      document.elapsedMs = Date.now() - Date.parse(document.startedAt);
    }
  }
  if (manifest.documents.every((item) => item.sections.every((sectionItem) => sectionItem.complete))) manifest.state = "prepared";
  if (claims) manifest.metrics.claims = await countClaims(runDir, manifest.documents);
  // The author budget stops the next section, never this one: the work is already on disk.
  const timedOut = !revisingCompletedDocument && elapsed > manifest.request.budgets.authorMs;
  if (timedOut) {
    document.elapsedMs = elapsed;
    manifest.state = "timed-out";
    manifest.metrics.warnings.push(`${document.id} authoring exceeded ${manifest.request.budgets.authorMs}ms; section ${sectionIndex} was saved before stopping.`);
  }
  await appendTimeline(runDir, manifest.id, { stage: "authoring", action: revision ? "section.revised" : "section.checkpoint", documentId, section: sectionIndex, evidenceIds: [...new Set((claims ?? []).flatMap((claim) => claim.evidenceIds ?? []))], traceIds: [...new Set((claims ?? []).flatMap((claim) => claim.traceIds ?? []))], data: timedOut ? { revision, timedOut: true } : { revision } });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(path, manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  if (timedOut) {
    await writeJson(join(runDir, "audit", `${document.id}-timeout.json`), diagnoseTimeout(manifest, documentId, sectionIndex));
    throw new Error(`Authoring timeout for ${document.id} after saving section ${sectionIndex}: ${elapsed}ms > ${manifest.request.budgets.authorMs}ms`);
  }
  return manifest;
}

/**
 * Read-only helper: turn a section's markdown into a claims skeleton the author can fill in and pass
 * back to `checkpoint --claims`. It reuses `scaffoldSectionClaims` (and thus the audit's own
 * `substantiveSegments`), so every stub matches a substantive segment the audit will demand a claim
 * for. The run is consulted only to validate the document/section and stamp the metadata; nothing is
 * mutated and no timeline event is recorded.
 */
export async function scaffoldClaims(runDirInput: string, documentId: string, sectionIndex: number, sectionText: string): Promise<SectionClaimsFile> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const document = manifest.documents.find((item) => item.id === documentId);
  if (!document) throw new Error(`Unknown document: ${documentId}`);
  if (!document.sections.some((item) => item.index === sectionIndex)) throw new Error(`Unknown section ${sectionIndex} for ${documentId}`);
  return { version: 2, documentId, section: sectionIndex, claims: scaffoldSectionClaims(sectionText) };
}

export async function assembleRun(runDirInput: string): Promise<RunManifest> {
  const runDir = resolve(runDirInput);
  const path = join(runDir, "run.json");
  const manifest = await readJson<RunManifest>(path);
  const plan = await readJson<InvestigationPlan>(join(runDir, "workitems.json"));
  const traces = await readJson<TraceCatalog>(join(runDir, "traces.json"));
  for (const document of manifest.documents) {
    const missing: typeof document.sections = [];
    for (const section of document.sections) if (!section.complete || !await exists(section.file)) missing.push(section);
    if (missing.length) throw new Error(`Cannot assemble ${document.id}; incomplete sections: ${missing.map((item) => item.index).join(", ")}`);
    const parts = await Promise.all(document.sections.map((section) => readFile(section.file, "utf8")));
    const body = parts.join("\n\n").trim();
    const frontMatter = outputFrontMatter(document, manifest, body);
    await atomicWrite(join(runDir, "reports", reportFileName(document)), `${frontMatter}\n\n${body}\n`);
    await writeReportCompanions(runDir, document, plan, traces);
  }
  manifest.state = "assembled";
  manifest.updatedAt = nowIso();
  await appendTimeline(runDir, manifest.id, { stage: "assemble", action: "run.assembled", data: { documents: manifest.documents.map((document) => document.id) } });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(path, manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  return manifest;
}

export async function resumeRun(runDirInput: string): Promise<{ manifest: RunManifest; next: Array<{ document: string; section: number; title: string }> }> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const next = manifest.documents.flatMap((document) => document.sections.filter((section) => !section.complete).map((section) => ({ document: document.id, section: section.index, title: section.title })));
  if (manifest.state === "timed-out" || manifest.state === "failed") {
    manifest.state = next.length ? "authoring" : "assembled";
    manifest.updatedAt = nowIso();
    for (const document of manifest.documents) if (document.sections.some((section) => !section.complete)) document.startedAt = nowIso();
    await appendTimeline(runDir, manifest.id, { stage: "recovery", action: "run.resumed", data: { next } });
    manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
    await writeJson(join(runDir, "run.json"), manifest);
    await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  }
  return { manifest, next };
}

export async function runStatus(runDirInput: string): Promise<Record<string, unknown>> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  return {
    id: manifest.id,
    state: manifest.state,
    snapshot: manifest.snapshot?.id,
    // Stated on every status read, because with redaction defaulting OFF the run directory holds source
    // text verbatim, and an operator deciding whether these artifacts may leave the machine has no other
    // way to tell. A property of the run, so it is reported whether or not anyone thought to ask.
    sourceText: manifest.request.redactSecrets === true ? "redacted" : "verbatim",
    documents: manifest.documents.map((document) => ({
      id: document.id,
      complete: document.sections.filter((section) => section.complete).length,
      total: document.sections.length,
      elapsedMs: document.elapsedMs,
      next: document.sections.find((section) => !section.complete)?.index ?? null,
    })),
    providers: await readJson<unknown>(join(runDir, "provider-status.json")),
    workItems: await readJson<InvestigationPlan>(join(runDir, "workitems.json")),
    traces: await readJson<TraceCatalog>(join(runDir, "traces.json")),
    timelineEvents: (await readTimeline(runDir)).length,
    metrics: manifest.metrics,
  };
}

async function countClaims(runDir: string, documents: RunManifest["documents"]): Promise<number> {
  return (await collectClaims(runDir, documents)).size;
}

function diagnoseTimeout(manifest: RunManifest, documentId: string, sectionIndex: number): Record<string, unknown> {
  return {
    runId: manifest.id,
    documentId,
    stoppedAfterSection: sectionIndex,
    authorBudgetMs: manifest.request.budgets.authorMs,
    metrics: manifest.metrics,
    likelyCauses: [
      "context is larger than needed for the document",
      "the author repeated graph or source investigation instead of using the prepared context",
      "sections were not checkpointed as soon as they were complete",
      "the request combined too many documents without reusing shared context",
      "the model spent time generating recommendations or unsupported detail outside the report contract",
    ],
    recovery: "Inspect metrics and the prepared prompt, reduce repeated or low-value context, then resume from the first incomplete section.",
  };
}
