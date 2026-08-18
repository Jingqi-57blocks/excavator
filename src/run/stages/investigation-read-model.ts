import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EvidenceItem, FeatureFactPack, InvestigationPlan, InvestigationWorkItem, RunManifest } from "../../base/types.ts";
import { BOUNDARY_DENOMINATOR_ASSURANCE_GENERATION, CROSSREPO_DENOMINATOR_ASSURANCE_GENERATION, READ_ACCOUNTABILITY_ASSURANCE_GENERATION, RECOVERED_ROUTE_DENOMINATOR_ASSURANCE_GENERATION, readObligations, type ReadObligationsArtifact, type RouteHandlerObligation } from "../../obligation/read-obligations.ts";
import { assuranceGenerationAtLeast } from "../../base/assurance-version.ts";
import { Deadline, exists, readJson, stableJson, writeJson } from "../../base/util.ts";
import { appendTimeline } from "../../base/timeline.ts";
import { featureAnchorTerms, featureCacheKey, tokenize } from "../../context/context.ts";
import { requireFactPackV2 } from "../../workset/factpack-view.ts";
import { buildObligationDeclarations, requireObligationDeclarations, type ObligationDeclarations } from "../../obligation/declarations.ts";
import type { Requirements } from "../../contract/bound-run-contract.ts";
import { recoveredRouteObligations, routeHandlerObligations, type CrossRepoArtifact } from "../../crossrepo/crossrepo-artifact.ts";
import { goImportAliases, parseHandlerTarget, resolveHandler } from "../../crossrepo/handler-resolve.ts";
import { CodeGraphIndex } from "../../codegraph/codegraph.ts";
import { reconcileReadCoverage, type ReadCoverageReport } from "../../investigation/read-coverage.ts";
import { readingExposure, renderReadingCheck, type ReadingExposure } from "../../investigation/read-residual-exposure.ts";
import type { BoundaryFunctionsArtifact } from "../../facts/probe/boundary-functions.ts";
import type { UnitsArtifact } from "../../facts/units/units-artifact.ts";
import type { ArtifactResult } from "../../base/artifact-result.ts";
import type { ReadSpecsArtifact } from "../../workset/read-specs.ts";
import type { MechanismLedger } from "../../mechanism/mechanism-ledger.ts";
import { readEvidenceCatalog } from "../../investigation/evidence-store.ts";

export async function readFrozenFactPacks(runDir: string, manifest: RunManifest): Promise<Record<string, FeatureFactPack>> {
  const factPacks: Record<string, FeatureFactPack> = {};
  for (const feature of manifest.request.features) {
    const key = featureCacheKey(feature);
    const packPath = join(runDir, "context", "features", `${key}.factpack.json`);
    if (await exists(packPath)) {
      const value = await readJson<unknown>(packPath);
      requireFactPackV2(value, packPath);
      factPacks[key] = value;
    }
  }
  return factPacks;
}

export async function readRequiredObligationDeclarations(runDir: string): Promise<ObligationDeclarations> {
  const path = join(runDir, "obligations", "declarations.json");
  if (!await exists(path)) throw new Error(`${path} is missing`);
  const result = await readJson<ArtifactResult<ObligationDeclarations>>(path);
  if (result.status !== "built") {
    throw new Error(`${path} is ${result.status === "unavailable" ? `unavailable: ${result.cause}` : `not applicable: ${result.determination}`}`);
  }
  const requirements = await readJson<Requirements>(join(runDir, "contract", "requirements.json"));
  const workset = await readJson<ArtifactResult<ReadSpecsArtifact>>(join(runDir, "workset", "read-specs.json"));
  const mechanisms = await readJson<ArtifactResult<MechanismLedger>>(join(runDir, "ledger", "mechanisms.json"));
  const units = await readJson<ArtifactResult<UnitsArtifact>>(join(runDir, "facts", "units.json"));
  if (workset.status !== "built" || mechanisms.status !== "built" || units.status !== "built") {
    throw new Error(`${path} cannot be re-derived because one of its four declared inputs is not Built`);
  }
  requireObligationDeclarations(result.value, requirements, path);
  const expected = buildObligationDeclarations({ requirements, workset: workset.value, mechanisms: mechanisms.value, units: units.value });
  if (stableJson(expected) !== stableJson(result.value)) {
    throw new Error(`${path} is not the deterministic declaration set derived from requirements, workset, mechanisms and units`);
  }
  return result.value;
}

async function readBoundaryFunctions(runDir: string): Promise<BoundaryFunctionsArtifact | null> {
  const path = join(runDir, "context", "boundary-functions.json");
  return await exists(path) ? await readJson<BoundaryFunctionsArtifact>(path) : null;
}

export async function readCrossRepoLinks(runDir: string): Promise<CrossRepoArtifact | null> {
  const path = join(runDir, "context", "crossrepo-links.json");
  return await exists(path) ? await readJson<CrossRepoArtifact>(path) : null;
}

export interface ReadAccountability {
  obligations: ReadObligationsArtifact;
  residual: ReadCoverageReport;
  annotated: boolean;
  boundaryFunctions: BoundaryFunctionsArtifact | null;
}

export async function deriveReadAccountability(
  runDir: string,
  manifest: RunManifest,
  factPacks: Record<string, FeatureFactPack>,
  workItems: InvestigationWorkItem[],
  evidence: EvidenceItem[],
  crossRepoLinks: CrossRepoArtifact | null,
): Promise<ReadAccountability | null> {
  if (!assuranceGenerationAtLeast(manifest, READ_ACCOUNTABILITY_ASSURANCE_GENERATION)) return null;
  const boundaryFunctions = assuranceGenerationAtLeast(manifest, BOUNDARY_DENOMINATOR_ASSURANCE_GENERATION)
    ? await readBoundaryFunctions(runDir)
    : null;
  const routeHandlers = assuranceGenerationAtLeast(manifest, CROSSREPO_DENOMINATOR_ASSURANCE_GENERATION)
    ? await routeHandlerDenominator(runDir, manifest, crossRepoLinks, factPacks)
    : null;
  const anchorTermsByFeature = anchorTermsFor(manifest);
  const recoveredRoutes = assuranceGenerationAtLeast(manifest, RECOVERED_ROUTE_DENOMINATOR_ASSURANCE_GENERATION)
    ? recoveredRouteObligations(crossRepoLinks, factPacks)
    : null;
  const obligations = readObligations(Object.values(factPacks), workItems, boundaryFunctions, routeHandlers, anchorTermsByFeature, recoveredRoutes);
  const annotated = Boolean(anchorTermsByFeature);
  return { obligations, residual: reconcileReadCoverage({ obligations: obligations.obligations, evidence, annotated }), annotated, boundaryFunctions };
}

export async function readingCheck(runDirInput: string): Promise<{ frozen: boolean; report: string; exposure: ReadingExposure | null }> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const frozen = Boolean(manifest.frozenAt);
  const evidenceCatalog = await readEvidenceCatalog(runDir);
  const plan = await readJson<InvestigationPlan>(join(runDir, "workitems.json"));

  let accountability: ReadAccountability | null = null;
  let denominatorLost = false;
  if (frozen) {
    const frozenPath = join(runDir, "coverage", "read-obligations.json");
    if (await exists(frozenPath)) {
      const obligations = await readJson<ReadObligationsArtifact>(frozenPath);
      const annotated = Boolean(obligations.summary.anchor);
      accountability = { obligations, annotated, boundaryFunctions: null, residual: reconcileReadCoverage({ obligations: obligations.obligations, evidence: evidenceCatalog.evidence, annotated }) };
    } else {
      denominatorLost = assuranceGenerationAtLeast(manifest, READ_ACCOUNTABILITY_ASSURANCE_GENERATION);
    }
  } else {
    const factPacks = await readFrozenFactPacks(runDir, manifest);
    accountability = await deriveReadAccountability(runDir, manifest, factPacks, plan.items, evidenceCatalog.evidence, await readCrossRepoLinks(runDir));
  }
  if (!accountability) {
    return {
      frozen,
      exposure: null,
      report: denominatorLost
        ? "This run's frozen read-obligation denominator is missing (coverage/read-obligations.json): it cannot be read, and re-deriving one after freeze would answer from inputs this run is no longer accountable to."
        : "This run has no read-obligation denominator: it was prepared before reading accountability existed.",
    };
  }
  const exposure = readingExposure({ obligations: accountability.obligations.obligations, items: accountability.residual.items, annotated: accountability.annotated });
  await appendTimeline(runDir, manifest.id, {
    stage: "investigation",
    action: "investigation.read-check",
    data: {
      frozen,
      functions: exposure.totals.functions,
      files: exposure.totals.files,
      unreadLines: exposure.totals.unreadLines,
      unclassified: exposure.unclassified.count,
      paths: exposure.files.slice(0, 50).map((file) => file.path),
    },
  });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  return { frozen, exposure, report: renderReadingCheck(exposure, { frozen }) };
}

async function routeHandlerDenominator(
  _runDir: string,
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

function anchorTermsFor(manifest: RunManifest): Record<string, string[]> {
  const byFeature: Record<string, string[]> = {};
  for (const feature of manifest.request.features ?? []) {
    const terms = [...new Set([feature.subject, ...(feature.aliases ?? [])].flatMap(tokenize))].filter(Boolean);
    byFeature[featureCacheKey(feature)] = featureAnchorTerms(terms);
  }
  return byFeature;
}
