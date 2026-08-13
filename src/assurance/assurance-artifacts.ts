import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AnalysisScope,
  DocumentPlan,
  InvestigationPlan,
  ProviderRegistry,
  ReportRequest,
  SectionClaim,
  SectionClaimsFile,
  Snapshot,
  TraceCatalog,
  TraceRecord
} from "../core/types.ts";
import { exists, nowIso, sha256, stableJson, writeJson } from "../core/util.ts";

export function createAnalysisScope(options: {
  runId: string;
  request: ReportRequest;
  snapshot: Snapshot;
  documents: DocumentPlan[];
  providerRegistry: ProviderRegistry;
}): AnalysisScope {
  const unsigned = {
    version: 1 as const,
    runId: options.runId,
    snapshotId: options.snapshot.id,
    createdAt: nowIso(),
    target: options.snapshot.target,
    repositories: options.snapshot.roots.map((root) => ({
      name: root.name,
      path: root.path,
      gitHead: root.gitHead,
      dirty: root.dirty,
      fileCount: root.fileCount
    })),
    sourcePolicy: {
      gitAware: true as const,
      includeTracked: true as const,
      includeUntrackedNotIgnored: true as const,
      excludeIgnoredUntracked: true as const,
      scannerVersion: options.snapshot.scannerVersion,
      ignoreRulesDigest: options.snapshot.ignoreRulesDigest,
      sourceManifestDigest: options.snapshot.sourceManifestDigest
    },
    providerMode: options.request.codegraphMode ?? "auto",
    providerRegistryDigest: options.providerRegistry.digest,
    outputLanguage: options.request.language,
    requestedDocuments: options.documents.map((document) => document.id),
    budgets: options.request.budgets,
    runtimeExecution: false as const
  };
  return { ...unsigned, digest: sha256(stableJson(unsigned)) };
}

export function emptyTraceCatalog(runId: string): TraceCatalog {
  return { version: 1, runId, traces: [] };
}

export function mergeTraces(existing: TraceCatalog, updates: TraceRecord[]): TraceCatalog {
  const byId = new Map(existing.traces.map((trace) => [trace.id, trace]));
  for (const trace of updates) {
    if (!trace.id?.trim()) throw new Error("Trace update is missing id");
    if (!trace.title?.trim()) throw new Error(`Trace ${trace.id} is missing title`);
    byId.set(trace.id, {
      ...trace,
      documentIds: [...new Set(trace.documentIds ?? [])],
      steps: (trace.steps ?? []).map((step, index) => ({ ...step, index: index + 1, evidenceIds: [...new Set(step.evidenceIds ?? [])], claimIds: [...new Set(step.claimIds ?? [])] })),
      createdAt: trace.createdAt || nowIso()
    });
  }
  return { ...existing, traces: [...byId.values()] };
}

export async function collectClaims(runDir: string, documents: DocumentPlan[]): Promise<Map<string, SectionClaim>> {
  const claims = new Map<string, SectionClaim>();
  for (const document of documents) {
    for (const section of document.sections) {
      if (!await exists(section.claimsFile)) continue;
      const file = await readJsonFile<SectionClaimsFile>(section.claimsFile);
      for (const claim of file.claims) claims.set(claim.id, claim);
    }
  }
  return claims;
}

export async function writeReportCompanions(runDir: string, document: DocumentPlan, plan: InvestigationPlan, traces: TraceCatalog): Promise<void> {
  const claims: Array<SectionClaimsFile> = [];
  for (const section of document.sections) if (await exists(section.claimsFile)) claims.push(await readJsonFile<SectionClaimsFile>(section.claimsFile));
  const documentClaimIds = new Set(claims.flatMap((file) => file.claims.map((claim) => claim.id)));
  const documentTraces = traces.traces.filter((trace) => trace.documentIds.includes(document.id) || trace.steps.some((step) => (step.claimIds ?? []).some((id) => documentClaimIds.has(id))));
  const workItems = plan.items.filter((item) => item.requiredFor.includes(document.id));
  const base = join(runDir, "reports", "companions", document.id);
  await writeJson(`${base}.claims.json`, { version: 1, documentId: document.id, sections: claims });
  await writeJson(`${base}.traces.json`, { version: 1, documentId: document.id, traces: documentTraces });
  await writeJson(`${base}.coverage.json`, {
    version: 1,
    documentId: document.id,
    total: workItems.length,
    complete: workItems.filter((item) => !["pending", "in_progress"].includes(item.status)).length,
    material: workItems.filter((item) => item.material).length,
    items: workItems
  });
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
