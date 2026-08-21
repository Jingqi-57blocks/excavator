import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Audience, DetailLevel, DocumentPlan, EvidenceItem, InvestigationChecklist, InvestigationPlan, ReportRequest, RunManifest, SectionClaim, SectionClaimsFile, TraceCatalog } from "../base/types.ts";
import { auditAuthoringPacketConsumption } from "../report/authoring-packet.ts";
import { buildContextsFromBoundary, featureCacheKey, readSourceBoundary, type ContextBuildResult, type SourceBoundary } from "../context/context.ts";

import { serializeLedgerArtifact, type FileLedger } from "../snapshot/file-ledger.ts";
import { built, unavailable, type ArtifactResult } from "../base/artifact-result.ts";
import { buildMechanismLedger, serializeMechanismLedger, type MechanismLedger } from "../mechanism/mechanism-ledger.ts";
import { LANGUAGE_REGISTRY } from "../base/language-registry.ts";
import { MECHANISM_REGISTRY, type MechanismAvailabilityMap } from "../base/mechanism-registry.ts";
import { collectMechanismAvailability } from "./mechanism-availability.ts";
import { ARTIFACT_REGISTRY } from "../base/artifact-registry.ts";
import { materializeBoundRunContract, type BoundRunContract, type PlannedDocument } from "../contract/bound-run-contract.ts";
import { deriveContractManifest, type ContractManifest } from "../contract/contract-manifest.ts";
import { auditContractInstances } from "../freeze/contract-instance-audit.ts";
import { auditChecklist, auditEvidenceCatalog, auditTraces, auditWorkItems, createInvestigationChecklist, createInvestigationPlan, workItemsToChecklist } from "../investigation/assurance.ts";
import { auditWorkItemClaimCoverage } from "../report/work-item-claim-coverage.ts";
import { ASSURANCE_VERSION, READ_EXECUTION_ASSURANCE_GENERATION, WORKSET_OBLIGATION_ASSURANCE_GENERATION, assuranceGenerationAtLeast } from "../base/assurance-version.ts";
import type { AuditFinding } from "../base/types.ts";
import { auditFreezeOrder, auditFrozenKnowledge, canonicalInvestigationResults, readCurrentKnowledge } from "../freeze/freeze.ts";
import { atomicWrite, canonicalJson, ensureDir, exists, nowIso, projectWorkspace, readJson, runIdTimestamp, sha256, stableJson, writeJson } from "../base/util.ts";
import { logicWorkItems, LOGIC_DISPOSITION_ASSURANCE_GENERATION } from "../obligation/logic-workitems.ts";
import { READ_ACCOUNTABILITY_ASSURANCE_GENERATION } from "../obligation/read-obligations.ts";
import { buildAttributionStage, unavailableAttributionStage, writeAttributionStage } from "./attribution-stage.ts";
import { seedCellsByFeature } from "../attribution/seed-identity.ts";
import { buildFactsStage, unavailableFactsStage, writeFactsStage } from "./facts-stage.ts";
import { buildWorksetStage, writeUnavailableWorksetStage, writeWorksetStage } from "./workset-stage.ts";
import { buildObligationStage, declarationWorkItems, writeObligationStage, writeUnavailableObligationStage } from "./obligation-stage.ts";
import { applyInvestigationDispositions, buildInvestigationStage, writeInvestigationStage } from "./investigation-stage.ts";
import { readWindowShortfall, recordedWindowDemand } from "../investigation/read-budget.ts";
import type { ObligationDeclarations } from "../obligation/declarations.ts";
import { overviewCensusResidual, scopeCensusResidual, type OverviewCensusV2, type ScopeCensusV2 } from "../workset/census.ts";
import { requireReadSpecs, type ReadSpecsArtifact } from "../workset/read-specs.ts";
import { auditReadAccountability, reconcileReadCoverage, type ClaimCitation } from "../investigation/read-coverage.ts";
import { auditConditionCoverage, inventoryConditions, type ClaimStatement } from "../investigation/condition-inventory.ts";
import { warmExtractors } from "../facts/probe/condition-extract.ts";
import { collectClaims } from "../report/assurance-artifacts.ts";
import { createAnalysisScope, emptyTraceCatalog } from "../investigation/investigation-artifacts.ts";
import { appendTimeline, auditTimeline } from "../base/timeline.ts";
import { runScopeSlug } from "./run-label.ts";
import { auditPendingDrafts } from "../report/parallel-authoring.ts";
import { writeReportRequests } from "../report/report-requests-artifact.ts";
import { plannedDocumentId } from "../report/legacy-request-mapping.ts";
import { makeDocumentPlan, referencePath } from "../report/authoring-plan.ts";
import { reportFileName } from "../report/section-report-name.ts";
import { sectionPaths } from "../report/section-paths.ts";
import { hasRecordedPlan, sectionCoverageApplies, sectionCoverageState, sectionCoverageVacuousStatement, unitAuthoringProgress } from "../report/section-coverage-vacuity.ts";
import { projectCacheDir, reDeriveIdentities } from "./stages/runtime-identity.ts";
import { readFrozenFactPacks, readRequiredInvestigationResults, readRequiredObligationDeclarations } from "./stages/investigation-read-model.ts";
import { resolveCrossRepoLinks } from "../crossrepo/resolve-links.ts";
import { auditEvidenceStorage, evidenceStreamDigest, readEvidenceCatalog, writeEvidenceCatalog } from "../investigation/evidence-store.ts";

// LONG-TERM, not transitional: `run.ts` is the module every command and test imports a stage function from,
// and `status` is a live command. What is open is not this line but what `runStatus` REPORTS — see that file.
export { runStatus } from "./stages/run-status-stage.ts";
export { addSourceEvidence, searchCacheVersion, searchSourceEvidence, SOURCE_SEARCH_VERSION, updateChecklist, updateTraces, updateWorkItems, type SupplementInput } from "./stages/investigation-stage.ts";
export { readingCheck } from "./stages/investigation-read-model.ts";
export { freezeRun } from "./stages/freeze-stage.ts";

/** A source window can satisfy context preparation and a later ReadSpec. Its id names bytes/path/span rather
 * than the reason it was requested, so initialization coalesces that one legitimate duplicate shape while
 * still rejecting any id collision over different evidence. */
function coalesceInitialEvidence(items: readonly EvidenceItem[]): EvidenceItem[] {
  const byId = new Map<string, EvidenceItem>();
  for (const item of items) {
    const prior = byId.get(item.id);
    if (!prior) { byId.set(item.id, item); continue; }
    const { reason: priorReason, ...priorIdentity } = prior;
    const { reason: itemReason, ...itemIdentity } = item;
    if (stableJson(priorIdentity) !== stableJson(itemIdentity)) throw new Error(`Evidence id ${item.id} was produced with conflicting content during prepare`);
    byId.set(item.id, { ...prior, reason: [...new Set([priorReason, itemReason].filter((value): value is string => Boolean(value)))].sort().join("; ") });
  }
  return [...byId.values()];
}

/**
 * The documents this request asks for, derived from the request alone.
 *
 * Computed here rather than inside the document loop because the bound contract needs the document set BEFORE
 * any producer runs, and having two places construct the same ids is how they drift apart.
 */
async function plannedDocuments(request: ReportRequest): Promise<PlannedDocument[]> {
  const planned: PlannedDocument[] = [];
  for (const audience of request.overviewAudiences) planned.push({
    id: plannedDocumentId("overview", audience, null), kind: "overview", audience, featureKey: null,
    sections: await templateSections("overview", audience)
  });
  for (const feature of request.features) {
    const key = featureCacheKey(feature);
    for (const audience of feature.audiences) planned.push({
      id: plannedDocumentId("feature", audience, key), kind: "feature", audience, featureKey: key,
      sections: await templateSections("feature", audience)
    });
  }
  return planned;
}

async function templateSections(kind: "overview" | "feature", audience: Audience): Promise<Array<{ index: number; title: string }>> {
  const templatePath = referencePath(kind, audience);
  const template = await readFile(templatePath, "utf8");
  const headings = [...template.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]!.trim());
  if (!headings.length) throw new Error(`Template has no level-two sections: ${templatePath}`);
  return headings.map((title, index) => ({ index: index + 1, title }));
}

/**
 * Record a run whose PREPARATION failed, under the layer-1 record the phase it reached actually supports.
 *
 * Before this, an unreadable target threw out of prepare and left nothing behind: no run directory, no record,
 * nothing to audit — the failure existed only in the operator's terminal. Recording it fixed that and then
 * over-reached: EVERY prepare failure was written as `Unavailable{"the source boundary could not be read"}`,
 * including a prepare-budget timeout hit halfway through the features, with the ledger sitting complete in
 * memory. That record asserted blindness the run did not have, and layer 8 amplified it into an error.
 *
 * So the envelope follows the phase. `boundary === null` means layer 1 produced nothing and the cause is the
 * one the contract allows there (an unreadable target, a failed root discovery). Otherwise the boundary WAS
 * read: the ledger is written `built`, the snapshot is recorded, and the failure lives on the manifest's error
 * and warnings where a later-stage failure belongs. `retryable` is derived from the cause rather than pinned to
 * false — an exhausted budget is the textbook retryable failure. The original error is still raised: this
 * records the failure, it does not absorb it.
 */
async function recordPrepareFailure(request: ReportRequest, contract: BoundRunContract, contractManifest: ContractManifest, cause: Error, boundary: SourceBoundary | null): Promise<void> {
  // The prepare failure is what the caller must see, so it is re-raised by the caller unchanged. A failure to
  // RECORD it is appended to that error rather than swallowed: a silent catch here hid a missing import for one
  // whole test cycle, which is precisely the shape this slice exists to remove from the scanner.
  try {
    await writePrepareFailureRecord(request, contract, contractManifest, cause, boundary);
  } catch (recordError) {
    cause.message = `${cause.message} (the failure record could not be written: ${(recordError as Error).message})`;
  }
}

async function writePrepareFailureRecord(request: ReportRequest, contract: BoundRunContract, contractManifest: ContractManifest, cause: Error, boundary: SourceBoundary | null): Promise<void> {
  const projectDir = boundary?.projectDir ?? await projectWorkspace(request.workdir, request.target);
  const requestDigest = sha256(stableJson({ overview: request.overviewAudiences, features: request.features, language: request.language })).slice(0, 8);
  const stage = boundary === null ? "unavailable" : "prepare-failed";
  const runId = `run-${runIdTimestamp()}-${runScopeSlug(request)}-${stage}-${requestDigest}-${randomUUID().slice(0, 8)}`;
  const runDir = join(projectDir, "runs", runId);
  await ensureDir(runDir);
  await writeContractArtifacts(runDir, contract, contractManifest);
  // A timeout is `ExcavatorTimeoutError` (see `Deadline`), and re-running it with a larger budget can succeed.
  const retryable = cause.name === "ExcavatorTimeoutError";
  const reason = boundary === null
    ? `the source boundary could not be read: ${cause.message}`
    : `the source boundary was read; preparation failed afterwards: ${cause.message}`;
  const ledgerResult = boundary === null ? unavailable(reason, retryable) : built(boundary.ledger);
  await atomicWrite(join(runDir, "ledger", "files.json"), serializeLedgerArtifact(ledgerResult));
  // Layer 2 follows the phase the same way layer 1 does: with no corpus there is nothing to declare mechanisms
  // over, and that is written down rather than omitted.
  await atomicWrite(join(runDir, "ledger", "mechanisms.json"), boundary === null
    ? serializeMechanismLedger(unavailable(reason, retryable))
    : (await mechanismLedgerArtifact(boundary.ledger)).serialized);
  // Layer 3 follows it too, and here the record is not optional: all eight layer-3 slots are enforced, so a
  // failed run that simply lacked them would fail the instance audit for a reason that has nothing to do with
  // why it failed. The cause is the phase's, so the eight records say what was never reached.
  await writeFactsStage(runDir, unavailableFactsStage(reason, retryable));
  // Layer 4 follows layer 3 on the failure path too, and its slot is enforced: a failed run that simply lacked
  // the attribution record would fail the instance audit for a reason unrelated to why it failed.
  await writeAttributionStage(runDir, unavailableAttributionStage(reason, retryable));
  await writeUnavailableWorksetStage(runDir, contract.runIntent.features.map((feature) => feature.key), reason, retryable);
  await writeUnavailableObligationStage(runDir, reason, retryable);
  await writeInvestigationStage(runDir, unavailable(reason, retryable));
  const now = nowIso();
  const manifest: RunManifest = {
    version: 3,
    id: runId,
    state: "failed",
    createdAt: now,
    updatedAt: now,
    request,
    snapshot: boundary?.snapshot ?? null,
    documents: [],
    evidenceDigest: sha256(stableJson([])),
    assuranceVersion: ASSURANCE_VERSION,
    metrics: {
      startedAt: now,
      finishedAt: now,
      timing: boundary?.timing ?? {},
      graphQueries: 0,
      graphQueryCacheHits: 0,
      sourceWindows: 0,
      sourceWindowCacheHits: 0,
      sourceCharacters: 0,
      sourceSearches: 0,
      sourceSearchCacheHits: 0,
      sourceFilesSearched: 0,
      filesConsidered: boundary?.files.length ?? 0,
      cache: {},
      warnings: [reason]
    },
    error: { stage: "prepare", message: cause.message, stack: cause.stack }
  };
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
}

/**
 * The layer-2 ledger for a corpus layer 1 did read.
 *
 * Availability is probed HERE, in the orchestrator, because layer 2 is forbidden from reaching up into the
 * mechanisms to ask how they are doing — it receives the observation as a contract input. A probe that throws
 * is recorded as `Unavailable`, never left as a missing file: "we never found out what could look at this
 * corpus" is a state layer 8 must be able to read. There is no third outcome and no absent artifact.
 */
async function mechanismLedgerArtifact(ledger: FileLedger): Promise<MechanismStage> {
  let availability: MechanismAvailabilityMap;
  try {
    availability = await collectMechanismAvailability();
  } catch (error) {
    // Retryable: every probe is a module load or a PATH lookup that a re-run can plausibly win. Only the PROBE
    // is caught here — a throw out of the pure builder is a defect in this engine, and recording our own bug as
    // `Unavailable` would file it under "blind spot", which is the one bucket it must never hide in.
    return stageOf(unavailable(`availability probing failed: ${(error as Error).message}`, true), null);
  }
  return stageOf(built(buildMechanismLedger({
    counted: ledger.counted,
    filesContentManifestDigest: ledger.contentManifestDigest,
    scannerVersion: ledger.scannerVersion,
    availability,
    languages: LANGUAGE_REGISTRY,
    mechanisms: MECHANISM_REGISTRY
  })), availability);
}

/**
 * Layer 2's envelope, its exact bytes, and the availability observation both it and layer 3 read.
 *
 * The three travel together because layer 3's identity contains `mechanisms.json`'s content digest, and a digest
 * computed from a second serialisation of a second build would be a digest of something no one wrote. The bytes
 * written to disk and the bytes hashed are the same string.
 */
interface MechanismStage {
  readonly artifact: ArtifactResult<MechanismLedger>;
  readonly serialized: string;
  readonly digest: string;
  /** Null only when the availability probe itself threw, in which case layer 3 has no gate input either. */
  readonly availability: MechanismAvailabilityMap | null;
}

function stageOf(artifact: ArtifactResult<MechanismLedger>, availability: MechanismAvailabilityMap | null): MechanismStage {
  const serialized = serializeMechanismLedger(artifact);
  return { artifact, serialized, digest: sha256(serialized), availability };
}

async function writeContractArtifacts(runDir: string, contract: BoundRunContract, contractManifest: ContractManifest): Promise<void> {
  await writeJson(join(runDir, "contract", "run-intent.json"), contract.runIntent);
  await writeJson(join(runDir, "contract", "requirements.json"), contract.requirements);
  await writeJson(join(runDir, "contract", "contract-manifest.json"), contractManifest);
}

export async function prepareRun(rawRequest: ReportRequest): Promise<{ runDir: string; manifest: RunManifest }> {
  // The mode is resolved ONCE, here, before anything reads it. It used to be resolved at each site, and the
  // sites disagreed: the failure-path manifest, the success-path `effectiveRequest` and the cross-repo scan
  // each wrote their own `=== true` / `Boolean(...)`, so changing the default in one left the recording paths
  // on the old one and a run whose manifest said "redacted" recorded the secret anyway. `!== false` because an
  // absent field is a caller who did not decide; everything below sees an explicit boolean and never re-applies
  // this rule.
  const request: ReportRequest = { ...rawRequest, redactSecrets: rawRequest.redactSecrets !== false };
  // prd is a feature-only audience: no prd-overview template exists. This single Core guard covers the CLI
  // overview command, the report --overview arg and request.json, so the overview branch (buildContexts →
  // renderOverviewContext, and the referencePath("overview", "prd") document build below) never sees prd.
  if (request.overviewAudiences.includes("prd")) throw new Error("prd audience is feature-only; no prd-overview template exists");
  const preparedStarted = Date.now();
  // The bound contract is materialized BEFORE any producer is called, and the expected artifact set is derived
  // from the base registry — never from what the run turns out to have produced. That ordering is the whole
  // reason "a required artifact is missing" can be a real check rather than a restatement of the results.
  const planned = await plannedDocuments(request);
  const contract = materializeBoundRunContract({
    request,
    features: request.features.map((feature) => ({ key: featureCacheKey(feature), subject: feature.subject, aliases: feature.aliases, ...(feature.profile === undefined ? {} : { profile: feature.profile }) })),
    documents: planned
  });
  const contractManifest = deriveContractManifest(ARTIFACT_REGISTRY, contract.runIntent, contract.requirements);
  // The two phases are separate CALLS, not one call with a catch that guesses how far it got. Only a failure in
  // the first one means the source boundary could not be read; a failure in the second happens with the ledger
  // already built, and recording that as an unreadable boundary is the run asserting a blindness it never had.
  let boundary: SourceBoundary;
  try {
    boundary = await readSourceBoundary(request);
  } catch (error) {
    await recordPrepareFailure(request, contract, contractManifest, error as Error, null);
    throw error;
  }
  let result: ContextBuildResult;
  try {
    result = await buildContextsFromBoundary(request, boundary);
  } catch (error) {
    await recordPrepareFailure(request, contract, contractManifest, error as Error, boundary);
    throw error;
  }
  // Resolved ONCE, here, for the same reason `redactSecrets` is resolved once at the top: the detail level reaches
  // the manifest and the recorded v2 request (it reached the author prompt too, until 57B-480 retired it), and
  // three sites each applying `?? "detailed"` is how the redaction flag came to disagree with itself.
  const detailLevel: DetailLevel = request.detailLevel ?? "detailed";
  const effectiveRequest: ReportRequest = { ...request, detailLevel, codegraph: result.stats.codegraphPath, codegraphModules: result.stats.codegraphModulePaths };
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

  // The v2 request each planned document was asked for, written under the run's `plan/` directory BEFORE the work
  // it describes: it is a function of the request alone, so a request that names one document twice has to fail
  // here rather than after minutes of scanning, and it must not leave a run.json claiming `prepared`.
  //
  // A record, not a premise — authoring still runs off the bound contract's template sections, and the cutover to
  // reading this back is a later slice. A document the mapping refuses is a hard error, the same verdict the
  // prd-overview guard at the top of prepare gives that same fact.
  await writeReportRequests(runDir, planned.map((document) => ({
    documentId: document.id,
    kind: document.kind,
    audience: document.audience,
    featureKey: document.featureKey,
    detailLevel,
    language: request.language
  })));

  // Built from the SAME planned set the contract was materialized from, so the run's documents and its
  // requirement rows can never name different documents.
  const documents: DocumentPlan[] = [];
  for (const document of planned) {
    const templatePath = referencePath(document.kind, document.audience);
    const contextPath = join(runDir, "context", `${document.id}.md`);
    await atomicWrite(contextPath, result.prepared.documentContexts.get(document.id) ?? "");
    const subject = document.featureKey === null
      ? undefined
      : request.features.find((feature) => featureCacheKey(feature) === document.featureKey)?.subject;
    documents.push(makeDocumentPlan(runDir, document, templatePath, contextPath, subject));
  }

  const providerRegistry = result.stats.providerRegistry;
  const analysisScope = createAnalysisScope({ runId, request: effectiveRequest, snapshot: result.prepared.snapshot, documents, providerRegistry });
  let plan = createInvestigationPlan(runId, effectiveRequest, documents);
  const traces = emptyTraceCatalog(runId);
  // Resolved BEFORE the evidence catalog is assembled: link evidence has to be IN the catalog, or a claim
  // citing it would fail audit for citing an evidence id that does not exist. Its kind is `derived`, never
  // `source` — resolving a route is not reading it (see crossrepo-artifact.ts).
  const crossRepo = await resolveCrossRepoLinks(request.target, result.stats.codegraphModules, result.prepared.snapshot.id, result.stats.warnings, request.redactSecrets === true);
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

  // The contract first, then the boundary ledger, then everything derived from them — the same order the
  // layering runs in, so a partially written run directory is readable from the bottom up.
  await writeContractArtifacts(runDir, contract, contractManifest);
  await atomicWrite(join(runDir, "ledger", "files.json"), serializeLedgerArtifact(built(result.ledger)));
  const mechanisms = await mechanismLedgerArtifact(result.ledger);
  await atomicWrite(join(runDir, "ledger", "mechanisms.json"), mechanisms.serialized);
  // Layer 3, from the two ledgers plus what this run resolved. It runs HERE — after layer 2, before anything
  // else derived — because its identity contains `mechanisms.json`'s digest and every producer envelope's
  // identity contains the units digest, so the order is a property of the identities, not a preference.
  const facts = mechanisms.availability === null || mechanisms.artifact.status !== "built"
    ? unavailableFactsStage(`the mechanism availability probe failed, so no designated builder could be gated: ${mechanisms.artifact.status === "unavailable" ? mechanisms.artifact.cause : "unknown"}`, true)
    : await buildFactsStage({
      target: request.target,
      ledger: result.ledger,
      mechanismsDigest: mechanisms.digest,
      mechanismLedger: mechanisms.artifact.value,
      availability: mechanisms.availability,
      codegraphPath: result.stats.codegraphPath,
      codegraphModules: result.stats.codegraphModules,
      codegraphDigest: result.stats.codegraphDigest,
      crossRepoScan: crossRepo?.scan ?? null,
      // The same project cache the boundary's content identities live under. Passed explicitly, and by a required
      // field, because the builder's cost is real: parsing wcp's 1,704 designated files takes 6.9 seconds.
      cacheDir: projectCacheDir(runDir)
    });
  await writeFactsStage(runDir, facts);
  result.stats.warnings.push(...facts.warnings);
  // Layer 4, from layer 3's in-memory result plus what each feature's selector recorded. It runs HERE — after
  // layer 3, before the fact packs are written — because the seats are joined against the layer-3 envelope's
  // membership rows and the identity carries the units digest, so the order is a property of the identities.
  const attribution = buildAttributionStage({
    units: facts.units,
    codegraph: facts.producers["codegraph"]!,
    ledger: result.ledger,
    modules: result.stats.codegraphModules?.map((module) => ({ id: module.id, dir: module.dir }))
      ?? (result.stats.codegraphPath ? [{ id: ".", dir: "" }] : []),
    mechanismsDigest: mechanisms.digest,
    selections: [...result.prepared.featureSelectionTraces].map(([featureKey, trace]) => ({ featureKey, trace })),
    identity: {
      filesContentManifestDigest: result.ledger.contentManifestDigest,
      mechanismsDigest: mechanisms.digest,
      budgets: {
        maxFeatureNodes: effectiveRequest.budgets.maxFeatureNodes,
        maxExpansionDepth: effectiveRequest.budgets.maxExpansionDepth,
        maxGraphQueries: effectiveRequest.budgets.maxGraphQueries
      },
      runIntent: { version: contract.runIntent.version, features: contract.runIntent.features }
    }
  });
  await writeAttributionStage(runDir, attribution);
  // Layer 5 consumes layer 4's seats and layer 3's written memberships, including which of those seats a query
  // seed won. That set used to be explicitly empty here, because deriving it from the feature graph at this
  // point would have been a second join — a correct objection, answered by moving the derivation into layer 4
  // rather than by keeping the set empty. `seedCellsByFeature` only reads what `attribution.json` published.
  const workset = buildWorksetStage({
    collected: result.prepared.collectedFactPacks,
    attribution: attribution.attribution,
    units: facts.units,
    producers: facts.producers,
    ledger: result.ledger,
    boundaryFunctions: result.prepared.boundaryFunctions,
    seedCellsByFeature: seedCellsByFeature(attribution.attribution, [...result.prepared.collectedFactPacks.keys()]),
    features: request.features.map((feature) => {
      const key = featureCacheKey(feature);
      return { key, subject: feature.subject, files: result.prepared.featureScopes.get(key)?.files ?? [] };
    })
  });
  await writeWorksetStage(runDir, workset);
  const obligations = buildObligationStage({
    requirements: contract.requirements,
    workset: workset.readSpecs,
    mechanisms: mechanisms.artifact,
    units: facts.units
  });
  await writeObligationStage(runDir, obligations);
  evidence.push(...workset.evidence);
  // The forcing-function denominator is now the workset's seeded/retained view. It cannot see co-located rows.
  const logic = logicWorkItems([...workset.factPacks.values()], documents);
  plan.items.push(...logic.items);
  if (obligations.status === "built") {
    plan.items.push(...declarationWorkItems(obligations.value, documents, new Set(plan.items.map((item) => item.id))));
  }
  const investigation = await buildInvestigationStage({
    target: request.target,
    snapshotId: result.prepared.snapshot.id,
    filesContentManifestDigest: result.ledger.contentManifestDigest,
    cacheDir: projectCacheDir(runDir),
    windowBudget: { total: effectiveRequest.budgets.maxSourceWindows, consumed: result.stats.sourceWindows },
    maxCharacters: Math.max(0, effectiveRequest.budgets.maxSourceCharacters - result.stats.sourceCharacters),
    redact: effectiveRequest.redactSecrets === true,
    workset: workset.readSpecs,
    obligations
  });
  // The demand is stated whether or not it was met, and the shortfall sentence only when there is one. An
  // operator who has to discover the required number by doubling the budget until prepare stops complaining
  // is being asked to search for a figure the run already knows.
  const windowShortfall = investigation.demand ? readWindowShortfall(investigation.demand) : null;
  if (windowShortfall) result.stats.warnings.push(windowShortfall);
  await writeInvestigationStage(runDir, investigation.results);
  evidence.push(...investigation.evidence);
  result.stats.sourceWindows += investigation.stats.windows;
  result.stats.sourceWindowCacheHits += investigation.stats.hits;
  result.stats.sourceCharacters += investigation.stats.characters;
  plan = applyInvestigationDispositions(plan, investigation.results, obligations);
  result.stats.warnings.push(...logic.warnings);
  const manifest: RunManifest = {
    version: 3,
    id: runId,
    state: "prepared",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    request: effectiveRequest,
    snapshot: result.prepared.snapshot,
    documents,
    // Replaced with the append-chain tail returned by `writeEvidenceCatalog` below. It is not a full-array
    // canonical digest: that O(N) normalization is intentionally deferred to freeze.
    evidenceDigest: "",
    providerRegistryDigest: providerRegistry.digest,
    analysisScopeDigest: analysisScope.digest,
    assuranceVersion: ASSURANCE_VERSION,
    codegraphDigest: result.stats.codegraphDigest,
    metrics: {
      startedAt: new Date(preparedStarted).toISOString(),
      timing: result.stats.timing,
      graphQueries: result.stats.graphQueries,
      graphQueryCacheHits: result.stats.graphQueryCacheHits,
      sourceWindows: result.stats.sourceWindows,
      sourceWindowCacheHits: result.stats.sourceWindowCacheHits,
      sourceCharacters: result.stats.sourceCharacters,
      ...(investigation.demand ? { sourceWindowDemand: recordedWindowDemand(investigation.demand) } : {}),
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
  const evidenceCatalog = await writeEvidenceCatalog(runDir, coalesceInitialEvidence(evidence), effectiveRequest.redactSecrets === true);
  manifest.evidenceDigest = evidenceCatalog.checkpoint.tailDigest;
  await writeJson(join(runDir, "provider-status.json"), providerRegistry);
  await writeJson(join(runDir, "analysis-scope.json"), analysisScope);
  await writeJson(join(runDir, "workitems.json"), plan);
  await writeJson(join(runDir, "traces.json"), traces);
  await atomicWrite(join(runDir, "context", "shared.md"), workset.crossFeatureSection
    ? `${result.prepared.sharedMarkdown}\n\n${workset.crossFeatureSection}`
    : result.prepared.sharedMarkdown);
  for (const [key, markdown] of result.prepared.featureMarkdowns) {
    const factSection = workset.featureSections.get(key);
    if (!factSection) throw new Error(`Layer 5 produced no deterministic view for feature ${JSON.stringify(key)}`);
    await atomicWrite(join(runDir, "context", "features", `${key}.md`), `${markdown}\n\n${factSection}\n`);
  }
  // The second obligation source is frozen at prepare beside the fact packs, for the same reason they are:
  // freeze and audit must both derive the denominator from one recorded set of facts, never recompute it.
  await writeJson(join(runDir, "context", "boundary-functions.json"), result.prepared.boundaryFunctions);
  if (crossRepo) await writeJson(join(runDir, "context", "crossrepo-links.json"), crossRepo.artifact);

  // Cross-feature relationships need at least two features to have any pair to relate; single-feature
  // and overview-only runs skip the artifact, matching the shared-context section's own condition.
  if (request.features.length >= 2) {
    await writeJson(join(runDir, "context", "cross-feature.json"), workset.crossFeature);
  }
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  await writeJson(join(runDir, "checklist.json"), workItemsToChecklist(plan));

  await appendTimeline(runDir, runId, { stage: "prepare", action: "run.prepared", data: { snapshotId: result.prepared.snapshot.id, documents: documents.map((document) => document.id), providerRegistryDigest: providerRegistry.digest, analysisScopeDigest: analysisScope.digest } });
  manifest.metrics.timelineEvents = 1;
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);

  return { runDir, manifest };
}

/**
 * Freeze a run: verify the investigation-side gate, then write `knowledge.json`, stamp
 * `manifest.frozenAt`/`knowledgeDigest`, append the `investigation.frozen` timeline event and initialize
 * the supplement counter. On a precondition failure nothing is written and `frozen: false` is returned
 * with the gap list; freezing an already-frozen run is refused (post-freeze change goes through supplements).
 */
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
  const evidenceCatalog = await readEvidenceCatalog(runDir);
  const evidenceIds = new Set(evidenceCatalog.evidence.map((item) => item.id));
  const evidenceById = new Map(evidenceCatalog.evidence.map((item) => [item.id, item]));
  const providerRegistry = await readJson<any>(join(runDir, "provider-status.json"));
  const analysisScope = await readJson<any>(join(runDir, "analysis-scope.json"));
  const plan = await readJson<InvestigationPlan>(join(runDir, "workitems.json"));
  const traces = await readJson<TraceCatalog>(join(runDir, "traces.json"));
  const allClaims = await collectClaims(runDir, manifest.documents);
  const claimsByDocument = new Map<string, Array<{ section: number; claim: SectionClaim }>>();
  const traceIds = new Set(traces.traces.map((trace) => trace.id));
  let auditedDeclarations: ObligationDeclarations | null = null;
  let auditedInvestigationResults: Awaited<ReturnType<typeof readRequiredInvestigationResults>> | null = null;
  // Generation 12 reads the two census laws from their ArtifactResult envelopes. File coverage and partition
  // selection are checked independently: adding their counts would mix different unit kinds.
  if (assuranceGenerationAtLeast(manifest, WORKSET_OBLIGATION_ASSURANCE_GENERATION)) {
    for (const file of (await readdir(join(runDir, "context")).catch(() => [])).filter((name: string) => name.endsWith(".scope-census.json")).sort()) {
      const result = await readJson<ArtifactResult<ScopeCensusV2>>(join(runDir, "context", file));
      if (result.status !== "built") {
        findings.push({ level: "warning", document: "read-coverage", message: `${file}: scope census ${result.status === "unavailable" ? `unavailable (${result.cause})` : `not applicable (${result.determination})`}` });
        continue;
      }
      const residual = scopeCensusResidual(result.value);
      if (!residual.balanced) findings.push({ level: "error", document: "read-coverage", message: `${file}: file-coverage or partition-selection conservation does not balance` });
      for (const row of residual.unavailable) findings.push({ level: "warning", document: "read-coverage", message: `${file}: ${row.featureKey} census-unavailable (${row.cause})` });
      if (residual.unexplained.length > 0) findings.push({ level: "warning", document: "read-coverage", message: `${file}: ${residual.unexplained.length} module x language file-coverage row(s) remain unexplained (${residual.unexplained.join(", ")})` });
    }
    const overview = await readJson<ArtifactResult<OverviewCensusV2>>(join(runDir, "context", "overview-census.json"));
    if (overview.status === "built") {
      const residual = overviewCensusResidual(overview.value);
      if (!residual.balanced) findings.push({ level: "error", document: "read-coverage", message: "overview-census.json: file coverage does not balance" });
      if (residual.unexplained.length > 0) findings.push({ level: "warning", document: "read-coverage", message: `overview-census.json: ${residual.unexplained.length} module x language row(s) remain unexplained (${residual.unexplained.join(", ")})` });
    } else {
      findings.push({ level: "warning", document: "read-coverage", message: `overview-census.json: overview census ${overview.status === "unavailable" ? `unavailable (${overview.cause})` : `not applicable (${overview.determination})`}` });
    }
    try {
      const readSpecs = await readJson<ArtifactResult<ReadSpecsArtifact>>(join(runDir, "workset", "read-specs.json"));
      if (readSpecs.status !== "built") {
        throw new Error(`artifact is ${readSpecs.status === "unavailable" ? `unavailable: ${readSpecs.cause}` : `not applicable: ${readSpecs.determination}`}`);
      }
      requireReadSpecs(readSpecs.value, "workset/read-specs.json");
    } catch (error) {
      findings.push({ level: "error", document: "contract", message: `workset/read-specs.json violates its authorization contract: ${(error as Error).message}` });
    }
    try {
      auditedDeclarations = await readRequiredObligationDeclarations(runDir);
    } catch (error) {
      findings.push({ level: "error", document: "contract", message: `obligations/declarations.json violates its declaration contract: ${(error as Error).message}` });
    }
  }
  if (assuranceGenerationAtLeast(manifest, READ_EXECUTION_ASSURANCE_GENERATION)) {
    try {
      auditedInvestigationResults = await readRequiredInvestigationResults(runDir, manifest, evidenceCatalog.evidence);
    } catch (error) {
      findings.push({ level: "error", document: "contract", message: `investigation/results.json violates its execution contract: ${(error as Error).message}` });
    }
  }
  if (manifest.evidenceDigest !== evidenceStreamDigest(evidenceCatalog.evidence)) findings.push({ level: "error", document: "evidence", message: "evidence catalog changed outside the recorded source-evidence workflow" });
  findings.push(...(await auditEvidenceStorage(runDir, evidenceCatalog.evidence, manifest.request.redactSecrets === true)).map((message) => ({ level: "error" as const, document: "evidence", message })));
  const providerUnsigned = { ...providerRegistry }; delete providerUnsigned.digest;
  if (sha256(stableJson(providerUnsigned)) !== providerRegistry.digest || manifest.providerRegistryDigest !== providerRegistry.digest) findings.push({ level: "error", document: "providers", message: "provider registry digest is invalid or changed" });
  const scopeUnsigned = { ...analysisScope }; delete scopeUnsigned.digest;
  if (sha256(stableJson(scopeUnsigned)) !== analysisScope.digest || manifest.analysisScopeDigest !== analysisScope.digest || analysisScope.snapshotId !== manifest.snapshot?.id) findings.push({ level: "error", document: "scope", message: "analysis scope digest is invalid or does not match the run" });

  findings.push(...await auditEvidenceCatalog(runDir, manifest, evidenceCatalog.evidence));
  const identities = await reDeriveIdentities(runDir, manifest);
  if (identities) {
    // A generation change is a stated LIMIT, not a finding about the target: the check could not run. Reporting
    // it as "the source changed" would be a false alarm on every archived run, and false alarms are how true
    // ones stop being read.
    if (!identities.drift.comparable) {
      findings.push({ level: "warning", document: "snapshot", message: `source drift could not be checked: this run was prepared by scanner ${identities.drift.recordedScannerVersion} and the current scanner is ${identities.drift.currentScannerVersion}, so the two snapshot identities are not comparable. Everything derived from the snapshot in this run stands as recorded; re-prepare to check it against the current scanner.` });
    } else if (identities.drift.snapshotChanged) {
      findings.push({ level: "error", document: "snapshot", message: "source snapshot changed after context preparation" });
    }
    // The CodeGraph formula is unchanged across scanner generations, so this comparison holds either way.
    if (identities.drift.codegraphChanged) findings.push({ level: "error", document: "snapshot", message: "CodeGraph identity changed after context preparation" });
  }
  findings.push(...await auditContractInstances(runDir, manifest));

  // Is the section-completeness family about anything on this run? Read once — it is a property of the run, and
  // asking per document would let N documents give N answers about one plan directory.
  const planRecorded = await hasRecordedPlan(runDir);
  const incompleteDocuments: DocumentPlan[] = [];
  for (const document of scopedDocuments) {
    const sectionCoverage = await sectionCoverageState(runDir, document, planRecorded);
    const sectionCoverageCounts = sectionCoverageApplies(sectionCoverage);
    if (!sectionCoverageCounts) {
      findings.push({ level: "warning", document: document.id, message: sectionCoverageVacuousStatement(document.id) });
      // THE QUESTION THE SUPPRESSED FAMILY ANSWERED IS STILL ASKED, from the unit ledger instead. Without this a
      // run that recorded a plan and then authored nothing — no draft, no collect, no deliverable — certified as
      // `complete`, because state 3 only catches abandonment BEFORE `plan`, and `plan` is step 1 of the unit path.
      const progress = await unitAuthoringProgress(runDir, manifest.id);
      if (progress.collected === 0) {
        findings.push({ level: coverageLevel, document: document.id, message: `this run recorded a plan and collected none of its ${progress.planned} authoring unit(s): it has authored nothing, so there is nothing to certify. Draft and collect the plan's units (\`excavator status --run <dir> --units\` lists what is left).` });
      } else if (progress.collected < progress.planned) {
        findings.push({ level: coverageLevel, document: document.id, message: `this run has collected ${progress.collected} of its ${progress.planned} planned authoring unit(s); the rest are unwritten, so its authoring is incomplete.` });
      }
      // And the family that used to ANNOUNCE its own skip must not now skip in silence: with no section claims,
      // `auditWorkItemClaimCoverage` certifies no document, and the sentence that said so went with the section
      // family. The unit path's equivalent has its own command, named here so the absence is actionable.
      findings.push({ level: "warning", document: document.id, message: "work-item coverage was not evaluated from section claims: this run has none. Material-obligation grounding for the unit path is `excavator audit --run <dir> --units`, which grades every collected unit against the obligations it owns." });
    }
    const reportPath = join(runDir, "reports", reportFileName(document));
    const reportExists = await exists(reportPath);
    if (!reportExists && !singleDocument && sectionCoverageCounts) {
      // A single-document audit runs mid-authoring, before assembly, so a missing report is expected there — and
      // so is a run whose section family is vacuous, which said so in its own sentence above.
      findings.push({ level: "error", document: document.id, message: "assembled report is missing" });
    }

    // THE SECTION AUDIT RULES ARE RETIRED (57B-481); THE ARCHIVED READ SIDE IS NOT. What used to be here was a
    // per-section loop that ran nine section-audit rules over every checkpointed section. Their subjects are
    // gone or moved: claim↔prose binding and the evidence-level markers went to the unit path with 57B-491,
    // attribution (G6) and the readability advisory (G10) were ruled retired with a named future home in R7c's
    // policy checker, and the detailed-feature fact-pack rule is G14's already-accepted reduction.
    //   WHAT RETIRED IS THE ENFORCEMENT HALF, NOT THE RULE — grep-verified when this was written, because "it
    //   went with a named future home" and "nothing says it any more" are different claims. G6's rule is written
    //   out in `skills/excavator/references/writing-rules.md` ("analysis-method information, not target problems,
    //   and MUST NOT appear in a target risk/current-problem section"); G10's glossary table is required by
    //   `product-feature.md` ("Present the glossary as a Markdown table"); the marker-placement advisory's rule is
    //   in all five templates ("do not leave a marker on its own line or behind an \"Evidence level:\" lead-in");
    //   the detailed-mode table and Mermaid requirements are in `engineering-feature.md`, sections 3 and 10 named
    //   individually. Those files are the bound contract's per-section requirement producers and R8c kept them
    //   alive on purpose, so an author is still told each rule. What no longer happens is a run being FAILED for
    //   breaking one. Commands: grep -rn "MUST NOT appear in a target risk" skills/; grep -rln "do not leave a
    //   marker on its own line" skills/excavator/references/.
    //
    // ONE OF THEM LOSES A GUARANTEE NO RULING HAD NAMED, so it is named here. `auditComparativeClaims`'s layer 2
    // — the SINGLE-SIDED EQUIVALENCE warning: a `fact` claim that asserts sameness across implementations,
    // modules, repositories or runtime parts while citing only one side, and declaring no `sides` — had exactly
    // one caller in `src/`, and it was this line. It disappears with it.
    //   WHY THE UNIT PATH DOES NOT RE-RUN IT: `unit-consistency.ts` checks side DISAGREEMENT ACROSS units (two
    //   units putting the same evidence on opposite sides of one comparison) and hands the within-unit case back
    //   to the claim-validity gate, which validates the SHAPE of `sides` and not whether a comparative sentence
    //   should have had them. So nothing on the unit path asks the question this warning asked.
    //   WHERE IT GOES IF IT COMES BACK: R7c's policy checker, with G6 and G10 — all three are prose-level rules
    //   with no chapter anchor, which is why none of them survived a mechanical port. `claim-comparison.ts`
    //   itself STAYS: its layer 1 (`assertValidClaim`'s shape validation of `sides`) is live on both sidecars.
    //
    // A SECOND DISAPPEARANCE, DOCUMENT-LEVEL RATHER THAN PER-SECTION, NAMED HERE FOR THE SAME REASON.
    // `auditRescuedLogicCoverage` — the advisory that every rescued `logic` fact-pack item be represented in the
    // assembled report, by a claim disposing its work item or by the prose naming it — was also called from this
    // function and went with the deletion (57B-481).
    //   WHAT DOES INHERIT IT, AND MORE STRONGLY: a rescued logic item is promoted to a work item
    //   (`logic-workitems.ts`), so on the unit path `auditUnitGrounding` demands a LINKED CLAIM REUSING ITS
    //   EVIDENCE — a harder requirement than "the report represents it somewhere".
    //   WHAT DOES NOT: items beyond `LOGIC_WORKITEM_CAP` are never promoted, so no obligation exists for them and
    //   the advisory was their only net. TWO OPERATOR-VISIBLE SENTENCES STILL PROMISE NETS THAT NO LONGER EXIST,
    //   and correcting them is a statement about what the product guarantees rather than a deletion, so they are
    //   named rather than edited here: `logic-workitems.ts`'s over-cap warning says the remainder is "covered only
    //   by the fact-pack advisory", and `cli.ts`'s `--detail detailed` help says it requires "minimum report
    //   density" — the density floor was `auditDetailedFeatureSection`, deleted as G14's accepted reduction.
    //
    // WHAT REPLACES IT IS A READ, NOT A RULE. `claimsByDocument` feeds RUN-LEVEL families — work-item claim
    // coverage, the condition inventory's claim statements — and those are explicitly kept running. Deleting the
    // loop without this read would leave them seeing zero claims on an archived run and reporting nothing, which
    // is the silent-empty shape this repository refuses. So the sidecars are still read; only the rules are gone.
    let sectionFilesOnDisk = 0;
    for (const section of document.sections) {
      const paths = sectionPaths(runDir, document.id, section);
      // FAIL-CLOSED INTEGRITY, KEPT ON PURPOSE. This is not one of the retired RULES — it is the archived-artifact
      // guarantee this arm promises to keep: a section the manifest calls complete must have its bytes on disk.
      // Losing it with the rules would let N deleted section files produce zero findings on an archived run.
      if (await exists(paths.file)) sectionFilesOnDisk += 1;
      else if (section.complete) findings.push({ level: "error", document: document.id, message: `checkpointed section ${section.index} file is missing` });
      if (!await exists(paths.claimsFile)) continue;
      const claimsFile = await readJson<SectionClaimsFile>(paths.claimsFile);
      claimsByDocument.set(document.id, [...(claimsByDocument.get(document.id) ?? []), ...claimsFile.claims.map((claim) => ({ section: section.index, claim }))]);
    }
    // AND THE ABSENCE IS DECLARED, never implied. A pre-cutover run has section artifacts on disk that used to be
    // audited by those rules and no longer are; saying nothing would leave its audit indistinguishable from one
    // where the rules ran and passed. The two states this must stay distinct from are stated in their own
    // sentences elsewhere: `vacuous (ledger-empty)` for a run that never had sections, and the incomplete error
    // for one that was abandoned.
    // Gated on the STATE, not on the boolean: `sectionCoverageCounts` is also true for a run that has no section
    // artifacts and no plan, where there is nothing to declare. Gating on `reportExists` (the first version of
    // this line) was worse — an archived run that checkpointed sections and never assembled would have lost the
    // rules in silence, which is the one outcome this arm forbids.
    if (sectionCoverage === "section-artifacts-present") {
      findings.push({ level: "warning", document: document.id, message: `section audit retired with its generation (57B-481): this run's ${sectionFilesOnDisk} section file(s) and its assembled report were NOT audited by the section rules. What stopped running: claim↔prose binding, evidence-level markers (both per section and over the report), target-problem attribution, the readability-table advisory, the detailed-feature fact-pack rule, rescued-logic coverage, the report's heading count and collapsed-evidence check, and the ERROR-level recommendation-language rule over the report prose. What still ran: everything else in this audit, including the fail-closed check that every section the manifest calls complete has its file on disk.` });
    }
    if (sectionCoverageCounts && !document.sections.every((section) => section.complete)) incompleteDocuments.push(document);
  }

  // A trace step cites a claim by its BARE id (`claim-3`), which is how an author writes it, so this check
  // gets the bare ids — not the document+section keys the map is now built on. Keying the map that way is
  // what makes `metrics.claims` a real total; feeding those composite keys to a check that compares against
  // bare ids would turn every legitimate trace citation into "references missing claim id".
  //
  // The honest limitation, unchanged by either shape: bare ids are not unique across sections, so this can
  // only verify that SOME section defines the id, never that the right one does. Recorded rather than
  // tightened — narrowing it needs trace steps to carry the section, which is a contract change.
  const claimIdsForTraces = new Set([...allClaims.values()].map((claim) => claim.id));
  findings.push(...auditTraces(traces, new Set(manifest.documents.map((document) => document.id)), evidenceIds, claimIdsForTraces));
  // The forced logic-disposition work items derive from the on-disk fact packs, version-gated exactly like
  // prepare/freeze. The plan, its checklist mirror and this audit all expand from this one list, so the three
  // expected sets never disagree (a diverging set would false-flag `unexpected non-open` or `required missing`).
  const factPacks = await readFrozenFactPacks(runDir, manifest);
  // Generation-gated (not exact-version): a run that baked these items under generation 4+ must have them
  // re-derived here even after a later assurance/redaction bump, or it would false-fail as `unexpected`.
  const expectedLogicItems = assuranceGenerationAtLeast(manifest, LOGIC_DISPOSITION_ASSURANCE_GENERATION) ? logicWorkItems(Object.values(factPacks), manifest.documents).items : [];
  const expectedDeclarationItems = auditedDeclarations
    ? declarationWorkItems(auditedDeclarations, manifest.documents, new Set(expectedLogicItems.map((item) => item.id)))
    : [];
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
      const frozenKnowledge = await readCurrentKnowledge(runDir, manifest).catch(() => null);
      if (frozenKnowledge) {
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
    }
    const claimCitations: ClaimCitation[] = [...claimsByDocument.entries()].flatMap(([documentId, entries]) =>
      entries.map(({ claim }) => ({ ref: `${documentId}#${claim.id}`, evidenceIds: claim.evidenceIds ?? [] })));
    // The frozen artifact says whether it was annotated; audit must not re-derive that from the labels
    // themselves, or a run whose vocabulary matched nothing would silently read like an un-annotated one.
    const wasAnnotated = Boolean((frozenObligations as { summary?: { anchor?: unknown } }).summary?.anchor);
    const readResidual = reconcileReadCoverage({ obligations: frozenObligations.obligations, evidence: evidenceCatalog.evidence, claims: claimCitations, annotated: wasAnnotated });
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
  expectedPlan.items.push(...expectedDeclarationItems.filter((item) => !expectedPlan.items.some((existing) => existing.id === item.id)));
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
  expectedChecklist.items.push(...workItemsToChecklist({ version: 1, runId: manifest.id, createdAt: nowIso(), items: expectedDeclarationItems }).items
    .filter((item) => !expectedChecklist.items.some((existing) => existing.id === item.id)));
  if (!await exists(join(runDir, "checklist.json"))) findings.push({ level: "error", document: "checklist", message: "checklist.json is missing" });
  else {
    const checklist = await readJson<InvestigationChecklist>(join(runDir, "checklist.json"));
    findings.push(...runWide(auditChecklist(checklist, expectedChecklist, evidenceById)));
  }

  // Frozen-knowledge consistency: run-level assertions, self-gated on knowledge.json existing, so an
  // unfrozen or legacy run is untouched. A scoped audit keeps them advisory like the other run-wide checks.
  const knowledgePath = join(runDir, "knowledge.json");
  if (auditedInvestigationResults && await exists(knowledgePath)) {
    const frozenKnowledge = await readCurrentKnowledge(runDir, manifest).catch(() => null);
    const resultsDigest = frozenKnowledge?.judgementDigest
      ? sha256(canonicalJson(canonicalInvestigationResults(auditedInvestigationResults)))
      : sha256(stableJson(auditedInvestigationResults));
    if (frozenKnowledge && frozenKnowledge.investigationResultsDigest !== resultsDigest) {
      findings.push(...runWide([{ level: "error" as const, document: "knowledge", message: "investigation/results.json does not match the L7 execution digest recorded at freeze" }]));
    }
  }
  findings.push(...runWide(await auditFrozenKnowledge(runDir, manifest, evidenceCatalog.evidence, plan, traces, auditedInvestigationResults ?? undefined)));
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
