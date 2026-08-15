import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Audience, ChecklistItem, DocumentPlan, EvidenceItem, FeatureFactPack, InvestigationChecklist, InvestigationPlan, InvestigationWorkItem, KnowledgeArtifact, ReportRequest, RunManifest, SearchReceipt, SectionClaim, SectionClaimsFile, TraceCatalog, TraceRecord } from "./types.ts";
import { auditAuthoringPacketConsumption, buildAuthoringPacket } from "../assurance/authoring-packet.ts";
import { buildContexts, featureCacheKey } from "../context/context.ts";
import { FACT_PACK_CATEGORIES, factPackEvidenceId } from "../context/factpack.ts";
import { SourceReader, evidenceFromWindow, sourceSearch, type SourceSearchStats } from "../snapshot/source.ts";
import { createSnapshot } from "../snapshot/snapshot.ts";
import { ASSURANCE_VERSION, assuranceGenerationAtLeast, auditChecklist, auditDetailedFeatureSection, auditEvidenceCatalog, auditEvidenceMarkerPlacement, auditReadabilityTables, auditRescuedLogicCoverage, auditSectionClaims, auditSectionEvidenceMarkers, auditTargetProblemAttribution, auditTraces, auditWorkItemClaimCoverage, auditWorkItems, checklistUpdatesToWorkItems, createInvestigationChecklist, createInvestigationPlan, hasEvidenceMarkers, mergeChecklist, mergeWorkItems, runUsesCurrentAssurance, type AuditFinding, validateClaimsInput, workItemsToChecklist } from "../assurance/assurance.ts";
import { auditComparativeClaims } from "../assurance/claim-comparison.ts";
import { auditFreezeOrder, auditFrozenKnowledge, buildKnowledge, freezePreconditions, knowledgeDigest, normalizeSupplement, recordSupplement } from "../assurance/freeze.ts";
import { atomicWrite, Deadline, ensureDir, exists, nowIso, readJson, REDACTION_VERSION, runIdTimestamp, sha256, slugify, stableJson, writeJson } from "./util.ts";
import { logicWorkItems, LOGIC_DISPOSITION_ASSURANCE_GENERATION } from "../assurance/logic-workitems.ts";
import { readObligations, BOUNDARY_DENOMINATOR_ASSURANCE_GENERATION, CROSSREPO_DENOMINATOR_ASSURANCE_GENERATION, READ_ACCOUNTABILITY_ASSURANCE_GENERATION, type RouteHandlerObligation } from "../assurance/read-obligations.ts";
import type { BoundaryFunctionsArtifact } from "../context/boundary-functions.ts";
import { scanCrossRepoLinks } from "../crossrepo/crossrepo-scan.ts";
import { featureAnchorTerms, tokenize } from "../context/context.ts";
import { buildCrossRepoArtifact, mintCrossRepoEvidence, routeHandlerObligations, type CrossRepoArtifact } from "../crossrepo/crossrepo-artifact.ts";
import { goImportAliases, parseHandlerTarget, resolveHandler } from "../crossrepo/handler-resolve.ts";
import { CodeGraphIndex } from "../codegraph/codegraph.ts";
import { auditReadAccountability, reconcileReadCoverage, type ClaimCitation } from "../assurance/read-coverage.ts";
import { auditConditionCoverage, inventoryConditions, type ClaimStatement } from "../assurance/condition-inventory.ts";
import { warmExtractors } from "../assurance/condition-extract.ts";
import { collectClaims, createAnalysisScope, emptyTraceCatalog, mergeTraces, writeReportCompanions } from "../assurance/assurance-artifacts.ts";
import { scaffoldSectionClaims } from "../assurance/claims-scaffold.ts";
import { sectionFileStem } from "../assurance/section-slug.ts";
import { appendTimeline, auditTimeline, readTimeline } from "../assurance/timeline.ts";
import { runScopeSlug } from "./run-label.ts";
import { auditPendingDrafts } from "../assurance/parallel-authoring.ts";

export const SOURCE_SEARCH_VERSION = `source-search-v4-ranking-v1-${REDACTION_VERSION}`;

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
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

/**
 * Read a frozen run's feature fact packs from disk, keyed by feature cache key. This is the single on-disk
 * source the freeze and audit expected sets derive their logic work items from, so both see identical facts.
 * A feature whose pack file is absent (older run, prepare failure) contributes nothing.
 */
async function readFrozenFactPacks(runDir: string, manifest: RunManifest): Promise<Record<string, FeatureFactPack>> {
  const factPacks: Record<string, FeatureFactPack> = {};
  for (const feature of manifest.request.features) {
    const key = featureCacheKey(feature);
    const packPath = join(runDir, "context", "features", `${key}.factpack.json`);
    if (await exists(packPath)) factPacks[key] = await readJson<FeatureFactPack>(packPath);
  }
  return factPacks;
}

/**
 * Read the frozen second obligation source. Absent means "this run has no second source" — a generation-6
 * run prepared before the artifact existed, or a prepare that produced none — and the denominator falls
 * back to the first source alone rather than failing the run for an advisory input.
 */
async function readBoundaryFunctions(runDir: string): Promise<BoundaryFunctionsArtifact | null> {
  const path = join(runDir, "context", "boundary-functions.json");
  return await exists(path) ? await readJson<BoundaryFunctionsArtifact>(path) : null;
}

/**
 * Resolve cross-repo HTTP links for a multi-module target. Returns null when the target has no module
 * databases (a single-repo run has no cross-repo edge to find), and never throws: an advisory input must
 * not be able to fail a run.
 */
async function resolveCrossRepoLinks(
  target: string,
  modules: Array<{ id: string; dir: string; path: string }> | undefined,
  snapshotId: string,
  warnings: string[],
): Promise<{ artifact: CrossRepoArtifact; evidence: EvidenceItem[] } | null> {
  if (!modules?.length) return null;
  try {
    const scan = await scanCrossRepoLinks(target, modules.map((module) => ({ id: module.id, dir: module.dir, databasePath: module.path })));
    warnings.push(...scan.warnings.slice(0, 20));
    const binding = mintCrossRepoEvidence(scan, snapshotId);
    return { artifact: buildCrossRepoArtifact(scan, snapshotId, binding), evidence: binding.evidence };
  } catch (error) {
    warnings.push(`cross-repo link resolution skipped: ${(error as Error).message}`);
    return null;
  }
}

/** Read the frozen cross-repo link artifact; absent simply means this run resolved none. */
async function readCrossRepoLinks(runDir: string): Promise<CrossRepoArtifact | null> {
  const path = join(runDir, "context", "crossrepo-links.json");
  return await exists(path) ? await readJson<CrossRepoArtifact>(path) : null;
}

/**
 * Turn resolved cross-repo links into reading obligations, attributed to the feature whose boundary holds
 * the CALL. Best effort by design: a module whose graph cannot be opened contributes nothing rather than
 * failing a freeze over an advisory input.
 */
async function routeHandlerDenominator(
  runDir: string,
  manifest: RunManifest,
  links: CrossRepoArtifact | null,
  factPacks: Record<string, FeatureFactPack>,
): Promise<RouteHandlerObligation[] | null> {
  if (!links?.links.length) return null;
  const target = manifest.request.target;
  const indexes = new Map<string, CodeGraphIndex | null>();
  const aliases = new Map<string, Map<string, string>>();
  const openIndex = (moduleId: string): CodeGraphIndex | null => {
    if (!indexes.has(moduleId)) {
      try {
        indexes.set(moduleId, new CodeGraphIndex(join(target, moduleId, ".codegraph", "codegraph.db"), 5000, new Deadline(120_000, "route handler resolution")));
      } catch {
        indexes.set(moduleId, null);
      }
    }
    return indexes.get(moduleId) ?? null;
  };

  // Import aliases are read up front, because resolution itself is synchronous: without them a Go qualifier
  // that renames its package resolves to nothing (measured: 23 registrations lost to exactly this).
  for (const link of links.links) {
    const aliasKey = `${link.to.module}/${link.to.path}`;
    if (aliases.has(aliasKey)) continue;
    try {
      aliases.set(aliasKey, goImportAliases(await readFile(join(target, aliasKey), "utf8")));
    } catch {
      aliases.set(aliasKey, new Map());
    }
  }

  const obligations: RouteHandlerObligation[] = [];
  try {
    for (const [featureKey, pack] of Object.entries(factPacks)) {
      const boundaryFiles = new Set((pack.items ?? []).map((item) => String(item.filePath ?? "")));
      obligations.push(...routeHandlerObligations(links, featureKey, boundaryFiles, (link) => {
        const targetSymbol = parseHandlerTarget(link.to.handlerExpression);
        if (!targetSymbol) return null;
        const index = openIndex(link.to.module);
        if (!index) return null;
        const aliasKey = `${link.to.module}/${link.to.path}`;
        try {
          return resolveHandler(targetSymbol, index.searchNodes([targetSymbol.name], 60), aliases.get(aliasKey));
        } catch {
          return null;
        }
      }));
    }
  } finally {
    for (const index of indexes.values()) index?.close();
  }
  return obligations.length ? obligations : null;
}

/** Each feature's anchor terms, keyed by feature cache key — the same derivation the boundary used. */
function anchorTermsFor(manifest: RunManifest): Record<string, string[]> {
  const byFeature: Record<string, string[]> = {};
  for (const feature of manifest.request.features ?? []) {
    const terms = [...new Set([feature.subject, ...(feature.aliases ?? [])].flatMap(tokenize))].filter(Boolean);
    byFeature[featureCacheKey(feature)] = featureAnchorTerms(terms);
  }
  return byFeature;
}

export async function prepareRun(request: ReportRequest): Promise<{ runDir: string; manifest: RunManifest }> {
  // prd is a feature-only audience: no prd-overview template exists. This single Core guard covers the CLI
  // overview command, the report --overview arg and request.json, so the overview branch (buildContexts →
  // renderOverviewContext, and the referencePath("overview", "prd") document build below) never sees prd.
  if (request.overviewAudiences.includes("prd")) throw new Error("prd audience is feature-only; no prd-overview template exists");
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
  // Promote every rescued logic function into a DISPOSABLE work item (the forcing function): a freshly
  // prepared run is always at the current assurance version, so these are added unconditionally here — the
  // freeze/audit expected sets re-derive them from the on-disk fact pack (version-gated) so the three agree.
  const logic = logicWorkItems([...result.prepared.featureFactPacks.values()], documents);
  plan.items.push(...logic.items);
  result.stats.warnings.push(...logic.warnings);
  const traces = emptyTraceCatalog(runId);
  // Resolved BEFORE the evidence catalog is assembled: link evidence has to be IN the catalog, or a claim
  // citing it would fail audit for citing an evidence id that does not exist. Its kind is `derived`, never
  // `source` — resolving a route is not reading it (see crossrepo-artifact.ts).
  const crossRepo = await resolveCrossRepoLinks(request.target, result.stats.codegraphModules, result.prepared.snapshot.id, result.stats.warnings);
  const evidence: EvidenceItem[] = [
    ...result.prepared.evidence,
    ...(crossRepo?.evidence ?? []),
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
  // The second obligation source is frozen at prepare beside the fact packs, for the same reason they are:
  // freeze and audit must both derive the denominator from one recorded set of facts, never recompute it.
  await writeJson(join(runDir, "context", "boundary-functions.json"), result.prepared.boundaryFunctions);
  if (crossRepo) await writeJson(join(runDir, "context", "crossrepo-links.json"), crossRepo.artifact);

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
    sections: headings.map((title, index) => {
      // Section markdown and its claims sidecar share one `NN-<slug>` stem, so a section and its claims
      // carry the same human-readable name while the zero-padded prefix keeps them numerically ordered.
      const stem = sectionFileStem(index + 1, title);
      return {
        index: index + 1,
        title,
        file: join(runDir, "sections", id, `${stem}.md`),
        claimsFile: join(runDir, "claims", id, `${stem}.json`),
        complete: false
      };
    })
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
  // Read the frozen fact packs once — the expected-plan logic items and knowledge digest both derive from them.
  const factPacks = await readFrozenFactPacks(runDir, manifest);
  // Reading accountability (generation 5+): the read-obligation denominator derives from those same frozen
  // fact packs and is FROZEN as a run artifact rather than recomputed at audit time — a later assurance
  // change must never silently move the denominator under an already-frozen run.
  const readAccountable = assuranceGenerationAtLeast(manifest, READ_ACCOUNTABILITY_ASSURANCE_GENERATION);
  // Generation 6 widens that denominator with the boundary-file enumeration. Gated on the run's own
  // generation, so a generation-5 run keeps exactly the denominator it was prepared with — and a run
  // prepared under 6 whose artifact is missing degrades to the first source alone rather than failing.
  const boundaryFunctions = readAccountable && assuranceGenerationAtLeast(manifest, BOUNDARY_DENOMINATOR_ASSURANCE_GENERATION)
    ? await readBoundaryFunctions(runDir)
    : null;
  // The cross-repo links are pinned in knowledge whenever the artifact exists — independent of the
  // obligation generation, because the digest protects the record, not the denominator.
  const crossRepoLinks = await readCrossRepoLinks(runDir);
  const routeHandlers = readAccountable && assuranceGenerationAtLeast(manifest, CROSSREPO_DENOMINATOR_ASSURANCE_GENERATION)
    ? await routeHandlerDenominator(runDir, manifest, crossRepoLinks, factPacks)
    : null;
  // The annotation uses the RUN'S OWN vocabulary, re-derived from its manifest through the same pure
  // functions prepare used — so freeze, audit and eval all label identically with no extra I/O.
  const anchorTermsByFeature = readAccountable ? anchorTermsFor(manifest) : null;
  const obligations = readAccountable ? readObligations(Object.values(factPacks) as FeatureFactPack[], plan.items, boundaryFunctions, routeHandlers, anchorTermsByFeature) : null;
  const readResidual = obligations ? reconcileReadCoverage({ obligations: obligations.obligations, evidence: evidenceCatalog.evidence }) : null;
  const expectedPlan = createInvestigationPlan(manifest.id, manifest.request, manifest.documents);
  // Gate the generative expansion on the run's assurance GENERATION, not exact-version equality: a run
  // prepared under generation 4+ already baked these items, so re-derive them regardless of any later
  // redaction/assurance bump. Older (pre-4) runs never baked them and are grandfathered.
  if (assuranceGenerationAtLeast(manifest, LOGIC_DISPOSITION_ASSURANCE_GENERATION)) expectedPlan.items.push(...logicWorkItems(Object.values(factPacks), manifest.documents).items);
  const documentIds = new Set(manifest.documents.map((document) => document.id));
  let snapshotDrift: { snapshotChanged: boolean; codegraphChanged: boolean } | null = null;
  if (manifest.snapshot) {
    const current = await createSnapshot(manifest.request.target, manifest.request.codegraphModules ?? manifest.request.codegraph, manifest.request.budgets.maxFiles);
    snapshotDrift = { snapshotChanged: current.snapshot.id !== manifest.snapshot.id, codegraphChanged: current.snapshot.codegraphDigest !== manifest.snapshot.codegraphDigest };
  }
  const findings = await freezePreconditions({ manifest, plan, expectedPlan, evidence: evidenceCatalog.evidence, evidenceById, traces, documentIds, snapshotDrift });
  // The reading gate runs at freeze because that is where a false ledger entry is cheapest to fix: the
  // author simply records the window. Claims do not exist yet, so only the read side is reconciled here.
  if (obligations && readResidual) {
    findings.push(...auditReadAccountability({ obligations: obligations.obligations, workItems: plan.items, evidenceById, report: readResidual }));
  }
  if (findings.some((finding) => finding.level === "error")) return { manifest, findings, frozen: false };
  if (obligations && readResidual) {
    await writeJson(join(runDir, "coverage", "read-obligations.json"), obligations);
    await writeJson(join(runDir, "coverage", "read-residual.json"), readResidual);
  }
  // The literal conditions inside the opened windows, computed WITHOUT claims (none exist yet). Measured
  // extraction of these was ~0 while they were only an audit-time residual, so they are put in front of the
  // author here — the packet below renders them per section — and re-reconciled with consumption at audit.
  if (readAccountable) await warmExtractors();
  const freezeConditions = readAccountable ? inventoryConditions(evidenceCatalog.evidence, []) : null;
  if (freezeConditions) await writeJson(join(runDir, "coverage", "condition-inventory.json"), freezeConditions);

  const crossFeaturePath = join(runDir, "context", "cross-feature.json");
  const crossFeature = await exists(crossFeaturePath) ? await readJson<unknown>(crossFeaturePath) : null;
  const frozenAt = nowIso();
  const knowledge = buildKnowledge({ manifest, plan, evidence: evidenceCatalog.evidence, traces, factPacks, crossFeature, frozenAt, readObligations: obligations, boundaryFunctions, crossRepoLinks });
  await writeJson(join(runDir, "knowledge.json"), knowledge);
  // Render the per-document authoring packets from the just-frozen knowledge: a deterministic, model-free
  // view organized by report section that the author reads before writing each section. Regenerable view,
  // not a ledger, so it is written after knowledge.json but before the manifest is stamped frozen.
  let authoringPackets = 0;
  for (const document of manifest.documents) {
    const markdown = buildAuthoringPacket(document, plan, evidenceById, traces, factPacks, freezeConditions ?? undefined);
    await atomicWrite(join(runDir, "context", "authoring", `${document.id}.md`), markdown);
    authoringPackets += 1;
  }
  manifest.frozenAt = frozenAt;
  manifest.knowledgeDigest = knowledgeDigest(knowledge);
  manifest.metrics.supplements = manifest.metrics.supplements ?? 0;
  manifest.updatedAt = nowIso();
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "investigation.frozen", data: { knowledgeDigest: manifest.knowledgeDigest, evidence: knowledge.evidenceIds.length, workItems: { total: plan.items.length, disposed: knowledge.completeness.disposed }, traces: knowledge.traceIds.length, authoringPackets } });
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
    let reportText: string | null = null;
    if (reportExists) {
      const text = await readFile(reportPath, "utf8");
      reportText = text;
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
    // Rescued-logic coverage advisory (document-level, warning-only): every rescued business/decision
    // function should surface somewhere in the assembled report. Self-gated on a report and logic evidence.
    if (reportText) findings.push(...auditRescuedLogicCoverage(document.id, reportText, featureFactEvidence));
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
  // The forced logic-disposition work items derive from the on-disk fact packs, version-gated exactly like
  // prepare/freeze. The plan, its checklist mirror and this audit all expand from this one list, so the three
  // expected sets never disagree (a diverging set would false-flag `unexpected non-open` or `required missing`).
  const factPacks = await readFrozenFactPacks(runDir, manifest);
  // Generation-gated (not exact-version): a run that baked these items under generation 4+ must have them
  // re-derived here even after a later assurance/redaction bump, or it would false-fail as `unexpected`.
  const expectedLogicItems = assuranceGenerationAtLeast(manifest, LOGIC_DISPOSITION_ASSURANCE_GENERATION) ? logicWorkItems(Object.values(factPacks), manifest.documents).items : [];
  // Reading accountability: reconcile against the FROZEN denominator, never a recomputed one — self-gated on
  // the artifact existing, so a legacy, unfrozen or pre-generation-5 run is untouched. The consumption side
  // (which claim cites the window) can only be evaluated here, after authoring, so the residual is rewritten
  // with it; the read side was already recorded at freeze.
  const obligationsPath = join(runDir, "coverage", "read-obligations.json");
  if (await exists(obligationsPath)) {
    const frozenObligations = await readJson<{ obligations: Parameters<typeof reconcileReadCoverage>[0]["obligations"] }>(obligationsPath);
    // The denominator is the direct input to the hard gate, so it must be the one that was frozen: an
    // edited file (dropping an obligation whose gate would fire) is a silent weakening of the gate.
    const knowledgePath = join(runDir, "knowledge.json");
    if (await exists(knowledgePath)) {
      const frozenKnowledge = await readJson<KnowledgeArtifact>(knowledgePath);
      if (frozenKnowledge.readObligationsDigest && frozenKnowledge.readObligationsDigest !== sha256(stableJson(frozenObligations))) {
        findings.push({ level: "error", document: "read-coverage", message: "coverage/read-obligations.json does not match the read-obligation digest recorded at freeze; the denominator was changed after freeze" });
      }
      // The second source is checked in BOTH directions: a changed artifact and a vanished one. The
      // denominator itself is already protected by the digest above, so this catches the subtler case —
      // the frozen numbers still reconcile while the inputs a reader would re-derive them from no longer do.
      if (frozenKnowledge.crossRepoLinksDigest) {
        const linksPath = join(runDir, "context", "crossrepo-links.json");
        if (!await exists(linksPath)) {
          findings.push({ level: "error", document: "read-coverage", message: "knowledge.json records a cross-repo links digest but context/crossrepo-links.json is gone; the resolved links cannot be re-derived" });
        } else if (frozenKnowledge.crossRepoLinksDigest !== sha256(stableJson(await readJson<unknown>(linksPath)))) {
          findings.push({ level: "error", document: "read-coverage", message: "context/crossrepo-links.json does not match the digest recorded at freeze; the resolved links were changed after freeze" });
        }
      }
      if (frozenKnowledge.boundaryFunctionsDigest) {
        const boundaryPath = join(runDir, "context", "boundary-functions.json");
        if (!await exists(boundaryPath)) {
          findings.push({ level: "error", document: "read-coverage", message: "knowledge.json records a boundary-functions digest but context/boundary-functions.json is gone; the second obligation source cannot be re-derived" });
        } else if (frozenKnowledge.boundaryFunctionsDigest !== sha256(stableJson(await readJson<unknown>(boundaryPath)))) {
          findings.push({ level: "error", document: "read-coverage", message: "context/boundary-functions.json does not match the digest recorded at freeze; the second obligation source was changed after freeze" });
        }
      }
    }
    const claimCitations: ClaimCitation[] = [...claimsByDocument.entries()].flatMap(([documentId, entries]) =>
      entries.map(({ claim }) => ({ ref: `${documentId}#${claim.id}`, evidenceIds: claim.evidenceIds ?? [] })));
    const readResidual = reconcileReadCoverage({ obligations: frozenObligations.obligations, evidence: evidenceCatalog.evidence, claims: claimCitations });
    // A scoped audit sees only its own document's claims, so persisting the residual from it would shrink
    // `consumedBy` and inflate `openedNotConsumed` — corrupting the very migration signal this report
    // exists to carry. Findings are still reported (already downgraded by runWide); only the write is
    // reserved for a full-run audit, matching "a scoped audit does not mutate the run".
    if (!singleDocument) await writeJson(join(runDir, "coverage", "read-residual.json"), readResidual);
    findings.push(...runWide(auditReadAccountability({ obligations: frozenObligations.obligations, workItems: plan.items, evidenceById, report: readResidual })));
  }
  // Extraction accountability (advisory): which literal domain conditions inside the OPENED windows no claim
  // states. Independent of the obligation denominator (it measures the next funnel segment, P(extracted|opened)),
  // generation-gated so older runs are untouched, and only persisted by a full-run audit — a scoped audit sees
  // a partial claim set and would understate consumption exactly like the read residual.
  if (assuranceGenerationAtLeast(manifest, READ_ACCOUNTABILITY_ASSURANCE_GENERATION)) {
    const claimStatements: ClaimStatement[] = [...claimsByDocument.entries()].flatMap(([documentId, entries]) =>
      entries.map(({ claim }) => ({ ref: `${documentId}#${claim.id}`, statement: claim.statement ?? "", evidenceIds: claim.evidenceIds ?? [] })));
    // Same warm-up as freeze: an unwarmed audit would re-inventory Perl through the regex path and
    // reconcile a different set of conditions than the one the author was given.
    await warmExtractors();
    const conditions = inventoryConditions(evidenceCatalog.evidence, claimStatements);
    if (!singleDocument) await writeJson(join(runDir, "coverage", "condition-inventory.json"), conditions);
    findings.push(...runWide(auditConditionCoverage(conditions)));
  }
  const expectedPlan = createInvestigationPlan(manifest.id, manifest.request, manifest.documents);
  expectedPlan.items.push(...expectedLogicItems);
  findings.push(...runWide(auditWorkItems(plan, expectedPlan, evidenceById, traceIds)));
  // Claim-attribution defects run over every scoped document (they are always errors and detectable
  // per document); completeness is certified only for documents whose sections are all checkpointed,
  // so an incomplete document contributes one targeted finding, never a per-work-item false cascade.
  const completeDocumentIds = new Set(scopedDocuments.filter((document) => document.sections.every((section) => section.complete)).map((document) => document.id));
  findings.push(...auditWorkItemClaimCoverage(plan, scopedDocuments, claimsByDocument, { coverageLevel, completeDocumentIds }));
  // Authoring-packet consumption advisory: warning-only and self-gated on the packet file existing, so an
  // unfrozen or packet-less run is untouched. It is always advisory, so a scoped audit needs no downgrade.
  findings.push(...await auditAuthoringPacketConsumption(runDir, scopedDocuments, plan, claimsByDocument));
  // Uncollected-drafts advisory: warning-only, self-gated on the `drafts/` directory existing, so a run
  // that never used the parallel `draft`/`collect` path is untouched. It flags section drafts written but
  // never recorded into the timeline by `collect` — additive, always advisory, no downgrade needed.
  findings.push(...await auditPendingDrafts(runDir));
  for (const document of incompleteDocuments) {
    const complete = document.sections.filter((section) => section.complete).length;
    findings.push({ level: coverageLevel, document: document.id, message: `document is incomplete (${complete}/${document.sections.length} sections checkpointed); work-item coverage was not evaluated` });
  }
  for (const message of await auditTimeline(runDir, manifest.id)) findings.push({ level: "error", document: "timeline", message });

  const expectedChecklist = createInvestigationChecklist(manifest.id, manifest.request);
  // The checklist mirror carries the same forced logic items (checklist.json is projected from the plan), so
  // its expected set must expand identically or auditChecklist would report them as unexpected/missing.
  expectedChecklist.items.push(...workItemsToChecklist({ version: 1, runId: manifest.id, createdAt: nowIso(), items: expectedLogicItems }).items);
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

export function normalizeSection(content: string, expectedTitle: string): string {
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

If \`context/authoring/${document.id}.md\` exists (written by freeze), read it before writing: it lists, per section, the work items, deterministic facts and frozen evidence that section must cover — cover each listed item or state explicitly why it does not apply.

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
The feature scope file carries a \`## Fact pack\` section, and the same enumeration is machine-readable in \`context/features/${key}.factpack.json\`: the categories \`entrypoints\`, \`entities\`, \`states\`, \`config-keys\`, \`jobs\`, \`external-calls\` and \`logic\` (the business and decision functions inside the boundary that the structural categories do not already name). The enumerating chapters — entry points, rules and states, data, configuration and integrations — must cover every fact pack item of the matching category: each item either appears in that chapter, or is folded into an explicitly counted group such as "N further items of kind X". Cite the category's \`FACT-*\` evidence id in the chapter that covers it. The \`logic\` items belong to the flow, decision and authorization chapters; a logic item carrying a \`signal\` (rescued into the boundary by structural analysis) must be dispositioned individually — named and placed where its behavior belongs — never folded into an aggregate count. Each rescued \`logic\` function is also a \`logic-disposition\` work item in \`workitems.json\` (id \`feature:<key>:logic:<name>@<path>:<line>\`, no pinned section): dispose it before freeze, then satisfy it with at least one visible claim that DESCRIBES THE BUSINESS BEHAVIOR and cites the deciding source window, listing the work-item id in the claim's \`workItemIds\`. The prose need not repeat the symbol name — identifiers stay in the collapsed evidence block or coverage chapter, and covering the behavior counts because the ledger binds through the cited evidence, not the name. A genuinely boundary-noise item is disposed \`not-applicable\` with a reason; one claim may batch-dispose several such n/a items by listing them all in \`workItemIds\`. When source reading contradicts a fact pack item, say so explicitly and state which reading the source supports; a fact pack category marked truncated must be reported as incomplete rather than presented as a full inventory. Silently omitting an item is a defect.
`;
}

export async function archiveCheckpoint(runDir: string, documentId: string, sectionFile: string, claimsFile: string): Promise<boolean> {
  let archived = false;
  const stamp = nowIso().replace(/[:.]/g, "-");
  // Name each archive after the file it captures, so history mirrors the `NN-<slug>` section stem (and,
  // for grandfathered `NN.md` runs, still the bare `NN`) with a per-revision stamp and content digest.
  if (await exists(sectionFile)) {
    const content = await readFile(sectionFile, "utf8");
    await atomicWrite(join(runDir, "history", documentId, `${basename(sectionFile, ".md")}-${stamp}-${sha256(content).slice(0, 8)}.md`), content);
    archived = true;
  }
  if (await exists(claimsFile)) {
    const content = await readFile(claimsFile, "utf8");
    await atomicWrite(join(runDir, "history", documentId, `${basename(claimsFile, ".json")}-${stamp}-${sha256(content).slice(0, 8)}.claims.json`), content);
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
