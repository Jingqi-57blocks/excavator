import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Audience, ChecklistItem, DocumentPlan, EvidenceItem, InvestigationChecklist, InvestigationPlan, InvestigationWorkItem, KnowledgeArtifact, ReportRequest, RunManifest, SearchReceipt, SectionClaim, SectionClaimsFile, TraceCatalog, TraceRecord } from "./types.ts";
import { buildContexts, featureCacheKey } from "./context.ts";
import { FACT_PACK_CATEGORIES, factPackEvidenceId } from "./factpack.ts";
import { SourceReader, evidenceFromWindow, sourceSearch, type SourceSearchStats } from "./source.ts";
import { createSnapshot } from "./snapshot.ts";
import { ASSURANCE_VERSION, auditChecklist, auditDetailedFeatureSection, auditEvidenceCatalog, auditEvidenceMarkerPlacement, auditReadabilityTables, auditSectionClaims, auditSectionEvidenceMarkers, auditTargetProblemAttribution, auditTraces, auditWorkItemClaimCoverage, auditWorkItems, checklistUpdatesToWorkItems, createInvestigationChecklist, createInvestigationPlan, hasEvidenceMarkers, mergeChecklist, mergeWorkItems, runUsesCurrentAssurance, type AuditFinding, validateClaimsInput, workItemsToChecklist } from "./assurance.ts";
import { auditComparativeClaims } from "./claim-comparison.ts";
import { auditFreezeOrder, auditFrozenKnowledge, buildKnowledge, freezePreconditions, knowledgeDigest, normalizeSupplement, recordSupplement } from "./freeze.ts";
import { atomicWrite, ensureDir, exists, nowIso, readJson, REDACTION_VERSION, runIdTimestamp, sha256, slugify, stableJson, writeJson } from "./util.ts";
import { collectClaims, createAnalysisScope, emptyTraceCatalog, mergeTraces, writeReportCompanions } from "./assurance-artifacts.ts";
import { scaffoldSectionClaims } from "./claims-scaffold.ts";
import { appendTimeline, auditTimeline, readTimeline } from "./timeline.ts";
import { runScopeSlug } from "./run-label.ts";

export const SOURCE_SEARCH_VERSION = `source-search-v4-ranking-v1-${REDACTION_VERSION}`;

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCES = join(PROJECT_ROOT, "skills", "excavator", "references");

/** Caches live beside `runs/` inside the per-target project directory: `<workdir>/<project>/cache`. */
function projectCacheDir(runDir: string): string {
  return resolve(runDir, "..", "..", "cache");
}

/**
 * The `FACT-*` fact-pack evidence belonging to a feature document, for enumeration reconciliation.
 * Feature documents are `feature-<featureKey>-<audience>`; each category's evidence id is derived
 * deterministically from the same key and the snapshot, so the lookup is exact. Overview documents,
 * snapshot-less or older runs (no fact-pack evidence in the catalog) resolve to an empty set.
 */
function factPackEvidenceForDocument(document: DocumentPlan, manifest: RunManifest, evidenceById: Map<string, EvidenceItem>): EvidenceItem[] {
  if (document.kind !== "feature" || !manifest.snapshot) return [];
  const feature = manifest.request.features.find((candidate) => `feature-${featureCacheKey(candidate)}-${document.audience}` === document.id);
  if (!feature) return [];
  const key = featureCacheKey(feature);
  return FACT_PACK_CATEGORIES
    .map((category) => evidenceById.get(factPackEvidenceId(key, category, manifest.snapshot!.id)))
    .filter((item): item is EvidenceItem => Boolean(item));
}

export async function prepareRun(request: ReportRequest): Promise<{ runDir: string; manifest: RunManifest }> {
  const preparedStarted = Date.now();
  const result = await buildContexts(request);
  const effectiveRequest: ReportRequest = { ...request, detailLevel: request.detailLevel ?? "detailed", codegraph: result.stats.codegraphPath, codegraphModules: result.stats.codegraphModulePaths };
  const timestamp = runIdTimestamp();
  const requestDigest = sha256(stableJson({ overview: request.overviewAudiences, features: request.features, language: request.language, detailLevel: effectiveRequest.detailLevel })).slice(0, 8);
  const runId = `run-${timestamp}-${runScopeSlug(request)}-${result.prepared.snapshot.id.slice(0, 8)}-${requestDigest}-${randomUUID().slice(0, 8)}`;
  const runDir = join(result.projectDir, "runs", runId);
  await ensureDir(runDir);
  await ensureDir(join(runDir, "context"));
  await ensureDir(join(runDir, "context", "features"));
  await ensureDir(join(runDir, "sections"));
  await ensureDir(join(runDir, "claims"));
  await ensureDir(join(runDir, "reports"));
  await ensureDir(join(runDir, "audit"));
  await ensureDir(join(runDir, "prompts"));

  const documents: DocumentPlan[] = [];
  let order = 0;
  for (const audience of request.overviewAudiences) {
    order += 1;
    const id = `overview-${audience}`;
    const templatePath = referencePath("overview", audience);
    const contextPath = join(runDir, "context", `${id}.md`);
    await atomicWrite(contextPath, result.prepared.documentContexts.get(id) ?? "");
    documents.push(await makeDocumentPlan(runDir, id, "overview", audience, templatePath, contextPath, undefined, order));
  }
  for (const feature of request.features) {
    const key = featureCacheKey(feature);
    for (const audience of feature.audiences) {
      order += 1;
      const id = `feature-${key}-${audience}`;
      const templatePath = referencePath("feature", audience);
      const contextPath = join(runDir, "context", `${id}.md`);
      await atomicWrite(contextPath, result.prepared.documentContexts.get(id) ?? "");
      documents.push(await makeDocumentPlan(runDir, id, "feature", audience, templatePath, contextPath, feature.subject, order));
    }
  }

  const providerRegistry = result.stats.providerRegistry;
  const analysisScope = createAnalysisScope({ runId, request: effectiveRequest, snapshot: result.prepared.snapshot, documents, providerRegistry });
  const plan = createInvestigationPlan(runId, effectiveRequest, documents);
  const traces = emptyTraceCatalog(runId);
  const evidence: EvidenceItem[] = [
    ...result.prepared.evidence,
    {
      id: `PROVIDER-${providerRegistry.digest.slice(0, 12)}`,
      snapshotId: result.prepared.snapshot.id,
      kind: "provider",
      title: "Project provider registry",
      data: providerRegistry,
      reason: "record the providers and capabilities selected for this run",
      digest: sha256(stableJson(providerRegistry))
    },
    {
      id: `SCOPE-${analysisScope.digest.slice(0, 12)}`,
      snapshotId: result.prepared.snapshot.id,
      kind: "scope",
      title: "Analysis scope contract",
      data: analysisScope,
      reason: "record the exact analysis boundary, requested documents and budgets",
      digest: sha256(stableJson(analysisScope))
    }
  ];

  const manifest: RunManifest = {
    version: 3,
    id: runId,
    state: "prepared",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    request: effectiveRequest,
    snapshot: result.prepared.snapshot,
    documents,
    evidenceDigest: sha256(stableJson(evidence)),
    providerRegistryDigest: providerRegistry.digest,
    analysisScopeDigest: analysisScope.digest,
    assuranceVersion: ASSURANCE_VERSION,
    metrics: {
      startedAt: new Date(preparedStarted).toISOString(),
      timing: result.stats.timing,
      graphQueries: result.stats.graphQueries,
      graphQueryCacheHits: result.stats.graphQueryCacheHits,
      sourceWindows: result.stats.sourceWindows,
      sourceWindowCacheHits: result.stats.sourceWindowCacheHits,
      sourceCharacters: result.stats.sourceCharacters,
      sourceSearches: 0,
      sourceSearchCacheHits: 0,
      sourceFilesSearched: 0,
      filesConsidered: result.stats.filesConsidered,
      timelineEvents: 0,
      claims: 0,
      traces: 0,
      workItems: { total: plan.items.length, complete: 0 },
      codegraphCoverage: result.stats.codegraphCoverage,
      cache: result.stats.cache,
      warnings: result.stats.warnings
    }
  };

  await writeJson(join(runDir, "request.json"), effectiveRequest);
  await writeJson(join(runDir, "snapshot.json"), result.prepared.snapshot);
  await writeJson(join(runDir, "evidence.json"), { evidence });
  await writeJson(join(runDir, "provider-status.json"), providerRegistry);
  await writeJson(join(runDir, "analysis-scope.json"), analysisScope);
  await writeJson(join(runDir, "workitems.json"), plan);
  await writeJson(join(runDir, "traces.json"), traces);
  await atomicWrite(join(runDir, "context", "shared.md"), result.prepared.sharedMarkdown);
  for (const [key, markdown] of result.prepared.featureMarkdowns) {
    await atomicWrite(join(runDir, "context", "features", `${key}.md`), markdown);
  }
  for (const [key, factPack] of result.prepared.featureFactPacks) {
    await writeJson(join(runDir, "context", "features", `${key}.factpack.json`), factPack);
  }
  // Cross-feature relationships need at least two features to have any pair to relate; single-feature
  // and overview-only runs skip the artifact, matching the shared-context section's own condition.
  if (request.features.length >= 2) {
    await writeJson(join(runDir, "context", "cross-feature.json"), result.prepared.crossFeature);
  }
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  await writeJson(join(runDir, "checklist.json"), workItemsToChecklist(plan));

  for (const document of documents) {
    await atomicWrite(join(runDir, "prompts", `${document.id}.md`), authorPrompt(runDir, document, effectiveRequest.language, effectiveRequest.detailLevel ?? "detailed"));
  }
  await appendTimeline(runDir, runId, { stage: "prepare", action: "run.prepared", data: { snapshotId: result.prepared.snapshot.id, documents: documents.map((document) => document.id), providerRegistryDigest: providerRegistry.digest, analysisScopeDigest: analysisScope.digest } });
  manifest.metrics.timelineEvents = 1;
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);

  return { runDir, manifest };
}

async function makeDocumentPlan(runDir: string, id: string, kind: "overview" | "feature", audience: Audience, templatePath: string, contextPath: string, subject: string | undefined, order: number): Promise<DocumentPlan> {
  const template = await readFile(templatePath, "utf8");
  const headings = [...template.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim());
  if (!headings.length) throw new Error(`Template has no level-two sections: ${templatePath}`);
  return {
    id,
    kind,
    audience,
    subject,
    templatePath,
    contextPath,
    sections: headings.map((title, index) => ({
      index: index + 1,
      title,
      file: join(runDir, "sections", id, `${String(index + 1).padStart(2, "0")}.md`),
      claimsFile: join(runDir, "claims", id, `${String(index + 1).padStart(2, "0")}.json`),
      complete: false
    }))
  };
}

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

/** The supplement flag pair a runtime mutator may carry, threaded from the CLI. */
export type SupplementInput = { reason?: string; workItemId?: string } | undefined;

function frozenGateError(command: string): Error {
  return new Error(`Run is frozen; \`${command}\` after freeze requires a supplement: pass --supplement-reason "<why the frozen knowledge is insufficient>" and --supplement-workitem <existing work item id>. Consume the frozen investigation knowledge as-is unless it is genuinely incomplete.`);
}

/**
 * The write-time freeze gate shared by the five runtime mutators. Before freeze it is a no-op (the flag
 * pair is still validated, but historical and unfrozen runs are unaffected). After freeze a mutation must
 * carry a supplement whose work item resolves in `workitems.json`; otherwise it is refused. Returns the
 * normalized supplement to record, or undefined for an ordinary pre-freeze mutation.
 */
async function enforceFreezeGate(runDir: string, manifest: RunManifest, command: string, supplement: SupplementInput): Promise<{ reason: string; workItemId: string } | undefined> {
  const normalized = normalizeSupplement(supplement?.reason, supplement?.workItemId);
  if (!manifest.frozenAt) return undefined;
  if (!normalized) throw frozenGateError(command);
  const plan = await readJson<InvestigationPlan>(join(runDir, "workitems.json"));
  if (!plan.items.some((item) => item.id === normalized.workItemId)) {
    throw new Error(`Supplement work item not found in workitems.json: ${normalized.workItemId}. Pass --supplement-workitem with an existing work item id.`);
  }
  return normalized;
}

/** Timeline `data` fields that mark a post-freeze investigation mutation as a recorded supplement. */
function supplementTimelineData(supplement: { reason: string; workItemId: string } | undefined): Record<string, unknown> {
  return supplement ? { supplement: true, supplementReason: supplement.reason, workItemId: supplement.workItemId } : {};
}

/**
 * Freeze a run: verify the investigation-side gate, then write `knowledge.json`, stamp
 * `manifest.frozenAt`/`knowledgeDigest`, append the `investigation.frozen` timeline event and initialize
 * the supplement counter. On a precondition failure nothing is written and `frozen: false` is returned
 * with the gap list; freezing an already-frozen run is refused (post-freeze change goes through supplements).
 */
export async function freezeRun(runDirInput: string): Promise<{ manifest: RunManifest; findings: AuditFinding[]; frozen: boolean; knowledge?: KnowledgeArtifact }> {
  const runDir = resolve(runDirInput);
  const runPath = join(runDir, "run.json");
  const manifest = await readJson<RunManifest>(runPath);
  if (manifest.frozenAt) throw new Error(`Run is already frozen at ${manifest.frozenAt}; re-freeze is not supported. Post-freeze changes go through the supplement channel.`);
  const evidenceCatalog = await readJson<{ evidence: EvidenceItem[] }>(join(runDir, "evidence.json"));
  const evidenceById = new Map(evidenceCatalog.evidence.map((item) => [item.id, item]));
  const plan = await readJson<InvestigationPlan>(join(runDir, "workitems.json"));
  const traces = await readJson<TraceCatalog>(join(runDir, "traces.json"));
  const expectedPlan = createInvestigationPlan(manifest.id, manifest.request, manifest.documents);
  const documentIds = new Set(manifest.documents.map((document) => document.id));
  let snapshotDrift: { snapshotChanged: boolean; codegraphChanged: boolean } | null = null;
  if (manifest.snapshot) {
    const current = await createSnapshot(manifest.request.target, manifest.request.codegraphModules ?? manifest.request.codegraph, manifest.request.budgets.maxFiles);
    snapshotDrift = { snapshotChanged: current.snapshot.id !== manifest.snapshot.id, codegraphChanged: current.snapshot.codegraphDigest !== manifest.snapshot.codegraphDigest };
  }
  const findings = await freezePreconditions({ manifest, plan, expectedPlan, evidence: evidenceCatalog.evidence, evidenceById, traces, documentIds, snapshotDrift });
  if (findings.some((finding) => finding.level === "error")) return { manifest, findings, frozen: false };

  const factPacks: Record<string, unknown> = {};
  for (const feature of manifest.request.features) {
    const key = featureCacheKey(feature);
    const packPath = join(runDir, "context", "features", `${key}.factpack.json`);
    if (await exists(packPath)) factPacks[key] = await readJson<unknown>(packPath);
  }
  const crossFeaturePath = join(runDir, "context", "cross-feature.json");
  const crossFeature = await exists(crossFeaturePath) ? await readJson<unknown>(crossFeaturePath) : null;
  const frozenAt = nowIso();
  const knowledge = buildKnowledge({ manifest, plan, evidence: evidenceCatalog.evidence, traces, factPacks, crossFeature, frozenAt });
  await writeJson(join(runDir, "knowledge.json"), knowledge);
  manifest.frozenAt = frozenAt;
  manifest.knowledgeDigest = knowledgeDigest(knowledge);
  manifest.metrics.supplements = manifest.metrics.supplements ?? 0;
  manifest.updatedAt = nowIso();
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "investigation.frozen", data: { knowledgeDigest: manifest.knowledgeDigest, evidence: knowledge.evidenceIds.length, workItems: { total: plan.items.length, disposed: knowledge.completeness.disposed }, traces: knowledge.traceIds.length } });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(runPath, manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  return { manifest, findings, frozen: true, knowledge };
}

export async function addSourceEvidence(runDirInput: string, relativePath: string, startLine: number, endLine: number, reason: string, supplement?: SupplementInput): Promise<Record<string, unknown>> {
  const runDir = resolve(runDirInput);
  const runPath = join(runDir, "run.json");
  const manifest = await readJson<RunManifest>(runPath);
  if (!manifest.snapshot) throw new Error("Run has no source snapshot");
  const supp = await enforceFreezeGate(runDir, manifest, "source", supplement);
  const remainingWindows = Math.max(0, manifest.request.budgets.maxSourceWindows - manifest.metrics.sourceWindows);
  const remainingCharacters = Math.max(0, manifest.request.budgets.maxSourceCharacters - manifest.metrics.sourceCharacters);
  const reader = new SourceReader({
    target: manifest.request.target,
    snapshotId: manifest.snapshot.id,
    cacheDir: projectCacheDir(runDir),
    maxWindows: remainingWindows,
    maxCharacters: remainingCharacters
  });
  const window = await reader.window(relativePath, startLine, endLine, reason);
  const evidencePath = join(runDir, "evidence.json");
  const catalog = await readJson<{ evidence: Array<Record<string, unknown>> }>(evidencePath);
  if (!catalog.evidence.some((item) => item.id === window.id)) catalog.evidence.push(evidenceFromWindow(window) as unknown as Record<string, unknown>);
  await writeJson(evidencePath, catalog);
  manifest.evidenceDigest = sha256(stableJson(catalog.evidence));
  manifest.metrics.sourceWindows += reader.stats.windows;
  manifest.metrics.sourceWindowCacheHits += reader.stats.hits;
  manifest.metrics.sourceCharacters += reader.stats.characters;
  manifest.updatedAt = nowIso();
  if (supp) manifest.metrics.supplements = (manifest.metrics.supplements ?? 0) + 1;
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "source.window", subject: relativePath, evidenceIds: [window.id], data: { startLine, endLine, reason, cacheHit: reader.stats.hits > 0, ...supplementTimelineData(supp) } });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(runPath, manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  if (supp) await recordSupplement(runDir, "source", [window.id], supp);
  return { evidence: evidenceFromWindow(window), cacheHit: reader.stats.hits > 0 };
}

export async function searchSourceEvidence(runDirInput: string, termsInput: string[], reason: string, options: { maxResults?: number; pathPrefixes?: string[]; regex?: boolean; caseSensitive?: boolean } = {}, supplement?: SupplementInput): Promise<Record<string, unknown>> {
  const runDir = resolve(runDirInput);
  const runPath = join(runDir, "run.json");
  const manifest = await readJson<RunManifest>(runPath);
  if (!manifest.snapshot) throw new Error("Run has no source snapshot");
  const supp = await enforceFreezeGate(runDir, manifest, "search", supplement);
  const terms = [...new Set(termsInput.map((term) => term.trim()).filter((term) => options.regex ? term.length > 0 : term.length >= 2))];
  if (!terms.length) throw new Error(options.regex ? "Regex source search requires a non-empty expression" : "Source search requires at least one term of two or more characters");
  const maxResults = Math.min(200, Math.max(1, options.maxResults ?? 50));
  const pathPrefixes = [...new Set((options.pathPrefixes ?? []).map((prefix) => prefix.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean))];
  if (pathPrefixes.some((prefix) => prefix === ".." || prefix.startsWith("../") || prefix.includes("/../"))) throw new Error("Source search path prefix escapes the target");

  const current = await createSnapshot(manifest.request.target, manifest.request.codegraphModules ?? manifest.request.codegraph, manifest.request.budgets.maxFiles);
  if (current.snapshot.id !== manifest.snapshot.id) {
    throw new Error("Source snapshot changed after context preparation");
  }
  const scopedFiles = pathPrefixes.length
    ? current.files.filter((file) => pathPrefixes.some((prefix) => file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`)))
    : current.files;
  const key = sha256(stableJson({ searchVersion: SOURCE_SEARCH_VERSION, snapshotId: manifest.snapshot.id, terms: [...terms].sort(), pathPrefixes: [...pathPrefixes].sort(), maxResults, regex: Boolean(options.regex), caseSensitive: Boolean(options.caseSensitive) }));
  const cachePath = join(projectCacheDir(runDir), "searches", manifest.snapshot.id, `${key}.json`);
  const cached = await exists(cachePath) ? await readJson<SearchReceipt>(cachePath) : null;
  let data: SearchReceipt;
  let cacheHit = false;
  if (cached && cached.searchVersion === SOURCE_SEARCH_VERSION) {
    data = cached;
    cacheHit = true;
  } else {
    const stats: SourceSearchStats = { total: 0, returned: 0, truncated: false };
    const matches = await sourceSearch(scopedFiles, terms, { maxResults, regex: options.regex, caseSensitive: options.caseSensitive }, stats);
    data = {
      searchVersion: SOURCE_SEARCH_VERSION,
      terms,
      pathPrefixes,
      candidateFiles: scopedFiles.length,
      maxResults,
      regex: Boolean(options.regex),
      caseSensitive: Boolean(options.caseSensitive),
      truncated: stats.truncated,
      ...(stats.truncated ? { atLeast: stats.total } : {}),
      matches: matches.map((match) => ({ path: match.file.relativePath, line: match.line, excerpt: match.excerpt, matchedTerms: match.matchedTerms, score: match.score }))
    };
    await writeJson(cachePath, data);
  }
  const item: EvidenceItem = {
    id: `SEARCH-${key.slice(0, 12)}`,
    snapshotId: manifest.snapshot.id,
    kind: "search",
    title: `Source search: ${terms.join(", ")}`,
    data,
    reason,
    digest: sha256(stableJson(data))
  };
  const evidencePath = join(runDir, "evidence.json");
  const catalog = await readJson<{ evidence: EvidenceItem[] }>(evidencePath);
  if (!catalog.evidence.some((evidence) => evidence.id === item.id)) catalog.evidence.push(item);
  await writeJson(evidencePath, catalog);
  manifest.evidenceDigest = sha256(stableJson(catalog.evidence));
  manifest.metrics.sourceSearches = (manifest.metrics.sourceSearches ?? 0) + (cacheHit ? 0 : 1);
  manifest.metrics.sourceSearchCacheHits = (manifest.metrics.sourceSearchCacheHits ?? 0) + (cacheHit ? 1 : 0);
  manifest.metrics.sourceFilesSearched = (manifest.metrics.sourceFilesSearched ?? 0) + (cacheHit ? 0 : scopedFiles.length);
  manifest.updatedAt = nowIso();
  if (supp) manifest.metrics.supplements = (manifest.metrics.supplements ?? 0) + 1;
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "source.search", evidenceIds: [item.id], data: { terms, pathPrefixes, maxResults, cacheHit, matchCount: Array.isArray(data.matches) ? data.matches.length : 0, reason, ...supplementTimelineData(supp) } });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(runPath, manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  if (supp) await recordSupplement(runDir, "search", [item.id], supp);
  return { evidence: item, cacheHit, ...data };
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
  const revision = await archiveCheckpoint(runDir, documentId, sectionIndex, section.file, section.claimsFile);
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

/** Downgrade error findings to warnings so a scoped audit surfaces run-wide checks without failing on them. */
function toAdvisory(findings: AuditFinding[]): AuditFinding[] {
  return findings.map((finding) => (finding.level === "error" ? { ...finding, level: "warning" } : finding));
}

/**
 * Audit a whole run, or a single document when `options.documentId` is given.
 *
 * A single-document audit is a scoped read used mid-authoring: it checks that document's
 * sections/claims and the global evidence-catalog integrity as hard errors, but it never certifies
 * the run as a whole. Checks that inherently require the full document set — plan and checklist
 * completion, and material work-item coverage — degrade to advisory (warning) findings, and the
 * scoped audit does not mutate run state, metrics, the timeline or the run-wide audit record.
 *
 * A full-run audit no longer lets one missing/incomplete document pollute the others: a document is
 * evaluated for coverage only once its sections are all checkpointed (claims live on disk
 * independent of assembly), and an incomplete document is reported as a single targeted finding
 * instead of a per-work-item cascade against every document.
 */
export async function auditRun(runDirInput: string, options: { documentId?: string } = {}): Promise<{ manifest: RunManifest; findings: AuditFinding[] }> {
  const runDir = resolve(runDirInput);
  const path = join(runDir, "run.json");
  const manifest = await readJson<RunManifest>(path);
  const singleDocument = options.documentId !== undefined;
  const scopedDocuments = singleDocument ? manifest.documents.filter((document) => document.id === options.documentId) : manifest.documents;
  if (singleDocument && !scopedDocuments.length) throw new Error(`Unknown document: ${options.documentId}`);
  // Run-wide completeness certifications cannot be asserted from a partial scope: keep them advisory.
  const runWide = singleDocument ? toAdvisory : (items: AuditFinding[]) => items;
  const coverageLevel = singleDocument ? "warning" : "error";
  const findings: AuditFinding[] = [];
  const evidenceCatalog = await readJson<{ evidence: EvidenceItem[] }>(join(runDir, "evidence.json"));
  const evidenceIds = new Set(evidenceCatalog.evidence.map((item) => item.id));
  const evidenceById = new Map(evidenceCatalog.evidence.map((item) => [item.id, item]));
  const providerRegistry = await readJson<any>(join(runDir, "provider-status.json"));
  const analysisScope = await readJson<any>(join(runDir, "analysis-scope.json"));
  const plan = await readJson<InvestigationPlan>(join(runDir, "workitems.json"));
  const traces = await readJson<TraceCatalog>(join(runDir, "traces.json"));
  const allClaims = await collectClaims(runDir, manifest.documents);
  const claimsByDocument = new Map<string, Array<{ section: number; claim: SectionClaim }>>();
  const traceIds = new Set(traces.traces.map((trace) => trace.id));
  if (manifest.evidenceDigest !== sha256(stableJson(evidenceCatalog.evidence))) findings.push({ level: "error", document: "evidence", message: "evidence catalog changed outside the recorded source-evidence workflow" });
  const providerUnsigned = { ...providerRegistry }; delete providerUnsigned.digest;
  if (sha256(stableJson(providerUnsigned)) !== providerRegistry.digest || manifest.providerRegistryDigest !== providerRegistry.digest) findings.push({ level: "error", document: "providers", message: "provider registry digest is invalid or changed" });
  const scopeUnsigned = { ...analysisScope }; delete scopeUnsigned.digest;
  if (sha256(stableJson(scopeUnsigned)) !== analysisScope.digest || manifest.analysisScopeDigest !== analysisScope.digest || analysisScope.snapshotId !== manifest.snapshot?.id) findings.push({ level: "error", document: "scope", message: "analysis scope digest is invalid or does not match the run" });

  findings.push(...await auditEvidenceCatalog(manifest, evidenceCatalog.evidence));
  if (manifest.snapshot) {
    const current = await createSnapshot(manifest.request.target, manifest.request.codegraphModules ?? manifest.request.codegraph, manifest.request.budgets.maxFiles);
    if (current.snapshot.id !== manifest.snapshot.id) findings.push({ level: "error", document: "snapshot", message: "source snapshot changed after context preparation" });
    if (current.snapshot.codegraphDigest !== manifest.snapshot.codegraphDigest) findings.push({ level: "error", document: "snapshot", message: "CodeGraph identity changed after context preparation" });
  }

  const incompleteDocuments: DocumentPlan[] = [];
  for (const document of scopedDocuments) {
    const reportPath = join(runDir, "reports", reportFileName(document));
    const reportExists = await exists(reportPath);
    if (reportExists) {
      const text = await readFile(reportPath, "utf8");
      const headings = [...text.matchAll(/^##\s+/gm)].length;
      if (headings !== document.sections.length) findings.push({ level: "error", document: document.id, message: `expected ${document.sections.length} sections, found ${headings}` });
      if (!/<details>/i.test(text)) findings.push({ level: "warning", document: document.id, message: "no collapsed evidence block was found" });
      const forbidden = [/修复建议/g, /改进建议/g, /解决方案/g, /推荐采用/g, /recommendation/gi, /should fix/gi, /we recommend/gi];
      for (const pattern of forbidden) if (pattern.test(text)) findings.push({ level: "error", document: document.id, message: `recommendation language is not allowed: ${pattern}` });
      if (!hasEvidenceMarkers(text)) findings.push({ level: "warning", document: document.id, message: "no evidence-level marker was found in the report prose" });
    } else if (!singleDocument) {
      // A single-document audit runs mid-authoring, before assembly, so a missing report is expected there.
      findings.push({ level: "error", document: document.id, message: "assembled report is missing" });
    }

    // Section claims live on disk from checkpoint, independent of assembly: read them regardless of
    // report existence so a checkpointed document is audited even when the run was never assembled.
    const featureFactEvidence = factPackEvidenceForDocument(document, manifest, evidenceById);
    for (const section of document.sections) {
      if (!await exists(section.file)) {
        // A section marked complete must have its checkpointed file on disk (fail closed); a section
        // that was never checkpointed is legitimately absent mid-authoring and is simply skipped.
        if (section.complete) findings.push({ level: "error", document: document.id, message: `checkpointed section ${section.index} file is missing` });
        continue;
      }
      const sectionText = await readFile(section.file, "utf8");
      const claimsFile = await exists(section.claimsFile) ? await readJson<SectionClaimsFile>(section.claimsFile) : null;
      if (claimsFile) claimsByDocument.set(document.id, [...(claimsByDocument.get(document.id) ?? []), ...claimsFile.claims.map((claim) => ({ section: section.index, claim }))]);
      findings.push(...auditSectionClaims({ documentId: document.id, sectionIndex: section.index, sectionText, claimsFile, evidenceIds, traceIds }));
      findings.push(...auditSectionEvidenceMarkers({ documentId: document.id, sectionIndex: section.index, sectionText, strict: runUsesCurrentAssurance(manifest) }));
      findings.push(...auditComparativeClaims({
        documentId: document.id,
        sectionIndex: section.index,
        claims: claimsFile?.claims ?? [],
        evidenceById,
        multiRoot: (manifest.snapshot?.roots?.length ?? 0) > 1,
        roots: (manifest.snapshot?.roots ?? []).map((root) => root.name)
      }));
      findings.push(...auditDetailedFeatureSection({ document, detailLevel: manifest.request.detailLevel, sectionIndex: section.index, sectionText, claimsFile, factEvidence: featureFactEvidence }));
      findings.push(...auditTargetProblemAttribution({ document, sectionIndex: section.index, sectionText }));
      findings.push(...auditReadabilityTables({ document, sectionIndex: section.index, sectionText }));
      findings.push(...auditEvidenceMarkerPlacement({ document, sectionIndex: section.index, sectionText }));
      if (/事实|推断|验证|fact|inferred|verified/i.test(sectionText) && !/<details>/i.test(sectionText)) {
        findings.push({ level: "error", document: document.id, message: `section ${section.index} contains supported claims but has no evidence block` });
      }
    }
    if (!document.sections.every((section) => section.complete)) incompleteDocuments.push(document);
  }

  findings.push(...auditTraces(traces, new Set(manifest.documents.map((document) => document.id)), evidenceIds, new Set(allClaims.keys())));
  const expectedPlan = createInvestigationPlan(manifest.id, manifest.request, manifest.documents);
  findings.push(...runWide(auditWorkItems(plan, expectedPlan, evidenceById, traceIds)));
  // Claim-attribution defects run over every scoped document (they are always errors and detectable
  // per document); completeness is certified only for documents whose sections are all checkpointed,
  // so an incomplete document contributes one targeted finding, never a per-work-item false cascade.
  const completeDocumentIds = new Set(scopedDocuments.filter((document) => document.sections.every((section) => section.complete)).map((document) => document.id));
  findings.push(...auditWorkItemClaimCoverage(plan, scopedDocuments, claimsByDocument, { coverageLevel, completeDocumentIds }));
  for (const document of incompleteDocuments) {
    const complete = document.sections.filter((section) => section.complete).length;
    findings.push({ level: coverageLevel, document: document.id, message: `document is incomplete (${complete}/${document.sections.length} sections checkpointed); work-item coverage was not evaluated` });
  }
  for (const message of await auditTimeline(runDir, manifest.id)) findings.push({ level: "error", document: "timeline", message });

  const expectedChecklist = createInvestigationChecklist(manifest.id, manifest.request);
  if (!await exists(join(runDir, "checklist.json"))) findings.push({ level: "error", document: "checklist", message: "checklist.json is missing" });
  else {
    const checklist = await readJson<InvestigationChecklist>(join(runDir, "checklist.json"));
    findings.push(...runWide(auditChecklist(checklist, expectedChecklist, evidenceById)));
  }

  // Frozen-knowledge consistency: run-level assertions, self-gated on knowledge.json existing, so an
  // unfrozen or legacy run is untouched. A scoped audit keeps them advisory like the other run-wide checks.
  findings.push(...runWide(await auditFrozenKnowledge(runDir, manifest, evidenceCatalog.evidence, plan, traces)));
  // Freeze-before-authoring order gate: a run-wide assertion (needs the whole timeline), so a scoped
  // audit downgrades it to advisory exactly like the other run-wide checks above.
  findings.push(...runWide(await auditFreezeOrder(runDir, manifest)));

  // A scoped audit reports its findings but does not certify or mutate the run.
  if (singleDocument) return { manifest, findings };

  const audit = { runId: manifest.id, createdAt: nowIso(), findings };
  await writeJson(join(runDir, "audit", "audit.json"), audit);
  if (!findings.some((item) => item.level === "error")) {
    manifest.state = "complete";
    manifest.metrics.finishedAt = nowIso();
    manifest.metrics.timing.totalMs = Date.now() - Date.parse(manifest.metrics.startedAt);
  } else manifest.state = "audited";
  manifest.updatedAt = nowIso();
  manifest.metrics.claims = allClaims.size;
  manifest.metrics.traces = traces.traces.length;
  manifest.metrics.workItems = { total: plan.items.length, complete: plan.items.filter((item) => !["pending", "in_progress"].includes(item.status)).length };
  await appendTimeline(runDir, manifest.id, { stage: "audit", action: findings.some((item) => item.level === "error") ? "audit.failed" : "audit.passed", data: { errors: findings.filter((item) => item.level === "error").length, warnings: findings.filter((item) => item.level === "warning").length } });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(path, manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  return { manifest, findings };
}

export async function updateChecklist(runDirInput: string, updates: Partial<ChecklistItem>[], supplement?: SupplementInput): Promise<InvestigationChecklist> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const supp = await enforceFreezeGate(runDir, manifest, "checklist", supplement);
  const path = join(runDir, "checklist.json");
  const existing = await readJson<InvestigationChecklist>(path);
  const merged = mergeChecklist(existing, updates);
  await writeJson(path, merged);
  const planPath = join(runDir, "workitems.json");
  const plan = mergeWorkItems(await readJson<InvestigationPlan>(planPath), checklistUpdatesToWorkItems(updates));
  await writeJson(planPath, plan);
  const ids = updates.map((item) => item.id).filter((id): id is string => Boolean(id));
  manifest.metrics.workItems = { total: plan.items.length, complete: plan.items.filter((item) => !["pending", "in_progress"].includes(item.status)).length };
  if (supp) manifest.metrics.supplements = (manifest.metrics.supplements ?? 0) + 1;
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "workitems.updated", workItemIds: ids, ...(supp ? { data: supplementTimelineData(supp) } : {}) });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  if (supp) await recordSupplement(runDir, "checklist", ids, supp);
  return merged;
}

export async function updateWorkItems(runDirInput: string, updates: Partial<InvestigationWorkItem>[], supplement?: SupplementInput): Promise<InvestigationPlan> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const supp = await enforceFreezeGate(runDir, manifest, "workitem", supplement);
  const path = join(runDir, "workitems.json");
  const plan = mergeWorkItems(await readJson<InvestigationPlan>(path), updates);
  await writeJson(path, plan);
  await writeJson(join(runDir, "checklist.json"), workItemsToChecklist(plan));
  const ids = updates.map((item) => item.id).filter((id): id is string => Boolean(id));
  manifest.metrics.workItems = { total: plan.items.length, complete: plan.items.filter((item) => !["pending", "in_progress"].includes(item.status)).length };
  if (supp) manifest.metrics.supplements = (manifest.metrics.supplements ?? 0) + 1;
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "workitems.updated", workItemIds: ids, ...(supp ? { data: supplementTimelineData(supp) } : {}) });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  if (supp) await recordSupplement(runDir, "workitem", ids, supp);
  return plan;
}

export async function updateTraces(runDirInput: string, updates: TraceRecord[], supplement?: SupplementInput): Promise<TraceCatalog> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const supp = await enforceFreezeGate(runDir, manifest, "trace", supplement);
  const path = join(runDir, "traces.json");
  const catalog = mergeTraces(await readJson<TraceCatalog>(path), updates);
  await writeJson(path, catalog);
  const ids = updates.map((trace) => trace.id);
  manifest.metrics.traces = catalog.traces.length;
  if (supp) manifest.metrics.supplements = (manifest.metrics.supplements ?? 0) + 1;
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "traces.updated", traceIds: ids, ...(supp ? { data: supplementTimelineData(supp) } : {}) });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  if (supp) await recordSupplement(runDir, "trace", ids, supp);
  return catalog;
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
    documents: manifest.documents.map((document) => ({
      id: document.id,
      complete: document.sections.filter((section) => section.complete).length,
      total: document.sections.length,
      elapsedMs: document.elapsedMs,
      next: document.sections.find((section) => !section.complete)?.index ?? null
    })),
    providers: await readJson<any>(join(runDir, "provider-status.json")),
    workItems: await readJson<InvestigationPlan>(join(runDir, "workitems.json")),
    traces: await readJson<TraceCatalog>(join(runDir, "traces.json")),
    timelineEvents: (await readTimeline(runDir)).length,
    metrics: manifest.metrics
  };
}

function referencePath(kind: "overview" | "feature", audience: Audience): string {
  return join(REFERENCES, `${audience}-${kind}.md`);
}

function normalizeSection(content: string, expectedTitle: string): string {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Section content is empty");
  if (/^##\s+/m.test(trimmed)) return `${trimmed}\n`;
  return `## ${expectedTitle}\n\n${trimmed}\n`;
}

function outputFrontMatter(document: DocumentPlan, manifest: RunManifest, body: string): string {
  const localizedTitle = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const fallbackTitle = document.kind === "overview"
    ? `${basename(manifest.request.target)} — ${document.audience} overview`
    : `${document.subject ?? "Feature"} — ${document.audience} report`;
  const title = localizedTitle || fallbackTitle;
  const navTitle = localizedTitle || (document.kind === "overview" ? `${document.audience} overview` : document.subject ?? "Feature");
  const order = manifest.documents.findIndex((item) => item.id === document.id) + 1;
  return `---\ntitle: ${yamlScalar(title)}\nnavTitle: ${yamlScalar(navTitle)}\nkind: ${document.kind}\naudience: ${document.audience}\nlanguage: ${manifest.request.language}\norder: ${order}\nrun: ${manifest.id}\nsnapshot: ${manifest.snapshot?.id ?? "unknown"}\n---`;
}

function yamlScalar(value: string): string { return JSON.stringify(value); }

function reportFileName(document: DocumentPlan): string {
  if (document.kind === "overview") return `${document.audience}-overview.md`;
  return `${slugify(document.subject ?? "feature")}-${document.audience}.md`;
}

function authorPrompt(runDir: string, document: DocumentPlan, language: string, detailLevel: "standard" | "detailed"): string {
  const templatePath = relative(runDir, document.templatePath).replaceAll("\\", "/");
  const contextPath = relative(runDir, document.contextPath).replaceAll("\\", "/");
  return `# Excavator authoring task

Write **${document.id}** in **${language}** at **${detailLevel}** detail level. All instructions and report contracts are English; translate the visible report naturally into the requested output language.

Read these inputs before writing:

- Report contract: \`${templatePath}\`
- Document instructions: \`${contextPath}\`
- Shared project context: \`context/shared.md\`
- Evidence catalog: \`evidence.json\`
- Investigation work items: \`workitems.json\`
- Compatibility checklist: \`checklist.json\`

For a feature document, the document instructions identify the reusable feature-scope file under \`context/features/\`.

Use the report contract's chapter order exactly. In section 1, begin with one localized level-one report title that identifies the audience, then write the localized level-two chapter heading. Write one section at a time and checkpoint it immediately. Every checkpoint must include a claims JSON file: every substantive sentence or table row is bound to an exact statement in the section; supported claims cite evidence IDs that also appear in that section's collapsed evidence block. Claims also list the work-item IDs they satisfy. Every material work item required for this document must be represented by at least one claim in its assigned section and must reuse that work item's evidence or trace.

When the requested detail level above is \`detailed\`, do not compress distinct rules, states, types, thresholds, entry points, records, jobs or side effects into a few summary sentences. Build the section inventory first, then enumerate every material distinct item supported by the prepared evidence. Use the contract-required tables and Mermaid diagrams. The feature context is a candidate corpus, not a finished summary.
${factPackInstructions(document, detailLevel)}
The investigation is frozen before authoring: \`evidence.json\`, \`workitems.json\`, \`traces.json\` and the prepared context are complete and are the authoring input. Consume them as they are; do not re-investigate to fill a gap. When a claim seems to lack evidence, first decide whether it is an expression problem — the evidence you need is almost always already in the catalog under a different framing. Only when the frozen knowledge is genuinely incomplete, open a supplement: re-run the relevant Excavator command with \`--supplement-reason "<why the frozen knowledge is insufficient>" --supplement-workitem <work item id>\`, which performs the operation and records the exception in the coverage ledger. Ensure each material item appears in the report.

Describe current state and current problems only. Do not provide recommendations, remediation, future architecture, migration steps, or action items. A target problem must be attributable to the target snapshot. Never place CodeGraph/Excavator limitations, unresolved graph references, source fallback, provider coverage, analysis budgets or static-review limitations in a target risk/current-problem section; put them only in the coverage chapter or an Excavator validation report.
`;
}


/**
 * Detailed feature chapters must account for the prepared fact pack item by item.
 * The pack is the enumeration floor: an item may be grouped and counted, but never dropped in silence.
 */
function factPackInstructions(document: DocumentPlan, detailLevel: "standard" | "detailed"): string {
  if (document.kind !== "feature" || detailLevel !== "detailed") return "";
  const key = document.id.replace(/^feature-/, "").replace(new RegExp(`-${document.audience}$`), "");
  return `
The feature scope file carries a \`## Fact pack\` section, and the same enumeration is machine-readable in \`context/features/${key}.factpack.json\`: the categories \`entrypoints\`, \`entities\`, \`states\`, \`config-keys\`, \`jobs\` and \`external-calls\`. The enumerating chapters — entry points, rules and states, data, configuration and integrations — must cover every fact pack item of the matching category: each item either appears in that chapter, or is folded into an explicitly counted group such as "N further items of kind X". Cite the category's \`FACT-*\` evidence id in the chapter that covers it. When source reading contradicts a fact pack item, say so explicitly and state which reading the source supports; a fact pack category marked truncated must be reported as incomplete rather than presented as a full inventory. Silently omitting an item is a defect.
`;
}

async function archiveCheckpoint(runDir: string, documentId: string, sectionIndex: number, sectionFile: string, claimsFile: string): Promise<boolean> {
  let archived = false;
  const stamp = nowIso().replace(/[:.]/g, "-");
  if (await exists(sectionFile)) {
    const content = await readFile(sectionFile, "utf8");
    await atomicWrite(join(runDir, "history", documentId, `${String(sectionIndex).padStart(2, "0")}-${stamp}-${sha256(content).slice(0, 8)}.md`), content);
    archived = true;
  }
  if (await exists(claimsFile)) {
    const content = await readFile(claimsFile, "utf8");
    await atomicWrite(join(runDir, "history", documentId, `${String(sectionIndex).padStart(2, "0")}-${stamp}-${sha256(content).slice(0, 8)}.claims.json`), content);
    archived = true;
  }
  return archived;
}

async function countClaims(runDir: string, documents: DocumentPlan[]): Promise<number> {
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
      "the model spent time generating recommendations or unsupported detail outside the report contract"
    ],
    recovery: "Inspect metrics and the prepared prompt, reduce repeated or low-value context, then resume from the first incomplete section."
  };
}
