import type {
  AnalysisScope, DocumentPlan, ProviderRegistry, ReportRequest, Snapshot, TraceCatalog, TraceRecord
} from "../core/types.ts";
import { nowIso, sha256, stableJson } from "../core/util.ts";

/**
 * The investigation's own artifacts: the frozen analysis scope and the trace catalogue.
 *
 * They were in `assurance-artifacts.ts` beside the report companions, which made a single file both
 * investigation-side and report-side — so registering it to either layer stated something untrue.
 */

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
