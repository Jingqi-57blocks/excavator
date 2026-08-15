import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Audience, EvidenceItem, FeatureFactPack, FeatureRequest, PreparedContext, ProviderRegistry, ReportRequest, Snapshot } from "../core/types.ts";
import { CodeGraphIndex, type GraphReader } from "../codegraph/codegraph.ts";
import { CodeGraphSet } from "../codegraph/codegraph-set.ts";
import { pruneFeatureGraphWithModuleFloor } from "./prune-module-floor.ts";
import { createSnapshot, isLikelySource, type ScannedFile } from "../snapshot/snapshot.ts";
import { SourceReader, evidenceFromWindow, manifestSummary, selectProjectDocuments, sourceSearch } from "../snapshot/source.ts";
import { Deadline, ensureDir, exists, projectWorkspace, readJson, sha256, slugify, stableJson, truncate, writeJson } from "../core/util.ts";
import { createProviderRegistry, resolveCodeGraphDatabase } from "../snapshot/providers.ts";
import { buildFactPack, factPackEvidence, renderFactPackSection } from "./factpack.ts";
import { BOUNDARY_FUNCTIONS_VERSION, BOUNDARY_FUNCTION_KINDS, enumerateBoundaryFunctions, type BoundaryFunctionsArtifact, type FeatureBoundaryFunctions } from "./boundary-functions.ts";
import { computeCrossFeatureRelationships, renderCrossFeatureSection } from "./cross-feature.ts";
import { legacyWorkspaceWarning } from "../snapshot/workspace-residue.ts";

// v20: CachedFeature carries the boundary-function enumeration (57B-396). v19 introduced it; v20 adds the
// `truncated` flag and per-feature warnings to that record, and a v19 hit would serve them as `undefined`
// — a truncated enumeration that claims it was complete. Any change to a cached shape bumps this (57B-375).
const BUILDER_VERSION = "excavator-context-v20-boundary-truncation";

interface CachedShared {
  snapshotId: string;
  evidence: EvidenceItem[];
  markdown: string;
  graphFilePaths: string[];
  metrics: { coverage?: { indexed: number; eligible: number; ratio: number }; warnings: string[] };
}

interface CachedFeature {
  snapshotId: string;
  key: string;
  subject: string;
  aliases: string[];
  nodes: Array<Record<string, unknown>>;
  files: string[];
  evidence: EvidenceItem[];
  markdown: string;
  factPack: FeatureFactPack;
  /** Second source for the read-obligation denominator; absent on a source-only run (57B-396). */
  boundaryFunctions?: FeatureBoundaryFunctions;
  warnings: string[];
}

export interface ContextBuildResult {
  prepared: PreparedContext;
  projectDir: string;
  stats: {
    graphQueries: number;
    graphQueryCacheHits: number;
    sourceWindows: number;
    sourceWindowCacheHits: number;
    sourceCharacters: number;
    filesConsidered: number;
    codegraphCoverage?: { indexed: number; eligible: number; ratio: number };
    codegraphPath?: string;
    codegraphModulePaths?: string[];
    codegraphSource: "explicit" | "auto" | "disabled" | "unavailable";
    providerRegistry: ProviderRegistry;
    cache: Record<string, "hit" | "miss" | "unused">;
    warnings: string[];
    timing: Record<string, number>;
  };
}

export async function buildContexts(request: ReportRequest): Promise<ContextBuildResult> {
  const deadline = new Deadline(request.budgets.prepareMs, "Context preparation");
  const timing: Record<string, number> = {};
  const t0 = Date.now();
  const codegraphResolution = await resolveCodeGraphDatabase(request.target, request.codegraph, request.codegraphMode ?? "auto");
  const moduleDatabases = codegraphResolution.modules;
  const effectiveCodegraph = codegraphResolution.path;
  const { snapshot, files } = await createSnapshot(request.target, moduleDatabases ? moduleDatabases.map((module) => module.path) : effectiveCodegraph, request.budgets.maxFiles);
  timing.snapshotMs = Date.now() - t0;
  deadline.check("creating source snapshot");

  const projectDir = await projectWorkspace(request.workdir, request.target);
  const legacyResidue = await legacyWorkspaceWarning(request.workdir, request.target, projectDir);
  const cacheRoot = join(projectDir, "cache");
  await ensureDir(cacheRoot);
  const sourceReader = new SourceReader({
    target: request.target,
    snapshotId: snapshot.id,
    cacheDir: cacheRoot,
    maxWindows: request.budgets.maxSourceWindows,
    maxCharacters: request.budgets.maxSourceCharacters
  });

  let graph: GraphReader | null = null;
  let codegraphOpenError: string | undefined;
  const warnings: string[] = [];
  if (legacyResidue) warnings.push(legacyResidue);
  const allowedPaths = files.map((file) => file.relativePath);
  if (moduleDatabases) {
    try { graph = new CodeGraphSet(moduleDatabases.map((module) => ({ module: { id: module.id, dir: module.dir }, path: module.path })), allowedPaths, request.budgets.maxGraphQueries, deadline); }
    catch (error) { codegraphOpenError = (error as Error).message; warnings.push(`CodeGraph could not be opened; source fallback is active: ${codegraphOpenError}`); }
  } else if (effectiveCodegraph && await exists(effectiveCodegraph)) {
    try { graph = new CodeGraphIndex(effectiveCodegraph, request.budgets.maxGraphQueries, deadline, allowedPaths); }
    catch (error) { codegraphOpenError = (error as Error).message; warnings.push(`CodeGraph could not be opened; source fallback is active: ${codegraphOpenError}`); }
  } else {
    warnings.push(codegraphResolution.source === "disabled"
      ? "CodeGraph is disabled; source analysis is active for the full target."
      : "No CodeGraph database is available; source analysis is active for the full target.");
  }
  if (codegraphResolution.source === "auto") warnings.push(moduleDatabases
    ? `Using ${moduleDatabases.length} auto-detected per-module CodeGraph databases; cross-module relationships fall to source.`
    : `Using auto-detected CodeGraph database: ${effectiveCodegraph}`);
  if (request.codegraph && codegraphResolution.source === "unavailable") warnings.push(`The requested CodeGraph database is unavailable: ${request.codegraph}`);

  const cache: Record<string, "hit" | "miss" | "unused"> = { shared: "miss" };
  const sharedCachePath = join(cacheRoot, "contexts", snapshot.id, `${BUILDER_VERSION}-shared.json`);
  let shared: CachedShared;
  if (await exists(sharedCachePath)) {
    shared = await readJson<CachedShared>(sharedCachePath);
    cache.shared = "hit";
    warnings.push(...shared.metrics.warnings);
  } else {
    const started = Date.now();
    shared = await buildSharedContext(snapshot, files, graph, sourceReader, deadline);
    timing.sharedContextMs = Date.now() - started;
    await writeJson(sharedCachePath, shared);
    warnings.push(...shared.metrics.warnings);
  }

  const providerRegistry = await createProviderRegistry({ snapshot, codegraphResolution, codegraphSelected: Boolean(graph), codegraphOpenError });

  const allEvidence = [...shared.evidence];
  const documentContexts = new Map<string, string>();
  const featureScopes = new Map<string, { nodes: any[]; files: string[]; evidenceIds: string[] }>();
  const featureMarkdowns = new Map<string, string>();
  const featureFactPacks = new Map<string, FeatureFactPack>();
  const boundaryFeatures: FeatureBoundaryFunctions[] = [];

  for (const audience of request.overviewAudiences) {
    const id = `overview-${audience}`;
    documentContexts.set(id, renderOverviewContext(audience, request.language));
  }

  for (const feature of request.features) {
    deadline.check(`preparing feature ${feature.subject}`);
    const key = featureCacheKey(feature);
    const cachePath = join(cacheRoot, "features", snapshot.id, `${BUILDER_VERSION}-${key}.json`);
    let cached: CachedFeature;
    if (await exists(cachePath)) {
      cached = await readJson<CachedFeature>(cachePath);
      cache[`feature:${key}`] = "hit";
    } else {
      cache[`feature:${key}`] = "miss";
      const started = Date.now();
      cached = await buildFeatureContext(snapshot, files, feature, graph, new Set(shared.graphFilePaths), sourceReader, deadline, request.budgets.maxFeatureNodes, request.budgets.maxExpansionDepth);
      timing[`feature:${key}Ms`] = Date.now() - started;
      await writeJson(cachePath, cached);
    }
    warnings.push(...(cached.warnings ?? []));
    allEvidence.push(...cached.evidence.filter((item) => !allEvidence.some((existing) => existing.id === item.id)));
    featureScopes.set(key, { nodes: cached.nodes as any[], files: cached.files, evidenceIds: cached.evidence.map((item) => item.id) });
    if (cached.boundaryFunctions) boundaryFeatures.push(cached.boundaryFunctions);
    featureMarkdowns.set(key, cached.markdown);
    featureFactPacks.set(key, cached.factPack);
    for (const audience of feature.audiences) {
      const id = `feature-${key}-${audience}`;
      documentContexts.set(id, renderFeatureContext(audience, request.language, feature.subject, key));
    }
  }

  // `graphAvailable` is recorded rather than inferred from an empty list: "source-only run" and "graph that
  // found nothing" are different facts, and a reader of the denominator must be able to tell them apart.
  const boundaryFunctions: BoundaryFunctionsArtifact = {
    version: BOUNDARY_FUNCTIONS_VERSION,
    snapshotId: snapshot.id,
    graphAvailable: Boolean(graph),
    enumeratedKinds: [...BOUNDARY_FUNCTION_KINDS],
    features: boundaryFeatures,
    // Rolled up from the features rather than left empty: a reader of this artifact must be able to see
    // its own degradation without cross-referencing the run manifest.
    warnings: boundaryFeatures.flatMap((feature) => feature.warnings),
  };

  graph?.close();
  const sourceStats = sourceReader.stats;

  // Cross-feature relationships are computed after every feature is prepared, so they cannot live in
  // the per-snapshot shared-context cache (which is feature-independent). The section is appended to
  // this run's shared markdown only when the run carries at least two features; single-feature and
  // overview-only runs have no pair to relate and skip both the section and the artifact.
  const crossFeature = computeCrossFeatureRelationships(
    request.features.map((feature) => {
      const key = featureCacheKey(feature);
      return { key, subject: feature.subject, files: featureScopes.get(key)?.files ?? [], factPack: featureFactPacks.get(key)! };
    }).filter((entry) => entry.factPack)
  );
  const sharedMarkdown = request.features.length >= 2
    ? `${shared.markdown}\n\n${renderCrossFeatureSection(crossFeature)}`
    : shared.markdown;

  timing.totalPrepareMs = Date.now() - t0;
  return {
    prepared: { snapshot, evidence: dedupeEvidence(allEvidence), sharedMarkdown, documentContexts, featureMarkdowns, featureFactPacks, featureScopes, crossFeature, boundaryFunctions },
    projectDir,
    stats: {
      graphQueries: graph?.stats.queries ?? 0,
      graphQueryCacheHits: graph?.stats.hits ?? 0,
      sourceWindows: sourceStats.windows,
      sourceWindowCacheHits: sourceStats.hits,
      sourceCharacters: sourceStats.characters,
      filesConsidered: files.length,
      codegraphCoverage: shared.metrics.coverage,
      codegraphPath: effectiveCodegraph,
      codegraphModulePaths: moduleDatabases?.map((module) => module.path),
      codegraphSource: codegraphResolution.source,
      providerRegistry,
      cache,
      warnings: [...new Set(warnings)],
      timing
    }
  };
}

async function buildSharedContext(snapshot: Snapshot, files: ScannedFile[], graph: GraphReader | null, sourceReader: SourceReader, deadline: Deadline): Promise<CachedShared> {
  const evidence: EvidenceItem[] = [];
  const warnings: string[] = [];
  let graphPaths = new Set<string>();
  let coverage: { indexed: number; eligible: number; ratio: number } | undefined;
  let graphSummary: unknown = null;
  let representativeNodes: unknown[] = [];
  let routes: unknown[] = [];

  evidence.push({
    id: `GIT-${snapshot.id}`,
    snapshotId: snapshot.id,
    kind: "git",
    title: "Source snapshot",
    data: { roots: snapshot.roots, snapshotId: snapshot.id },
    reason: "record the immutable source boundary used by the report",
    digest: sha256(stableJson({ roots: snapshot.roots, snapshotId: snapshot.id }))
  });

  if (graph) {
    const metadata = graph.metadata();
    const graphFiles = graph.files();
    graphPaths = new Set(graphFiles.map((file) => file.path.replace(/^\.\//, "")));
    const eligibleFiles = files.filter(isLikelySource);
    const eligible = eligibleFiles.length;
    const indexed = eligibleFiles.filter((file) => graphPaths.has(file.relativePath)).length;
    coverage = { indexed, eligible, ratio: eligible ? indexed / eligible : 1 };
    graphSummary = graph.summary();
    representativeNodes = graph.representativeNodes(60);
    routes = graph.routeSummary(60);
    const graphErrors = graphFiles.filter((file) => file.errors.length).slice(0, 50);
    if (graphErrors.length) warnings.push(`${graphErrors.length} CodeGraph file records include extraction errors in the sampled set; source fallback remains enabled.`);
    if (coverage.ratio < 0.98) warnings.push(`CodeGraph indexed ${indexed}/${eligible} eligible source files; unindexed files are read through source fallback when relevant.`);
    evidence.push({ id: `CG-${snapshot.id}`, snapshotId: snapshot.id, kind: "graph", title: "CodeGraph census", data: { metadata, summary: graphSummary, coverage, graphErrors }, reason: "navigate the project without scanning every source file", digest: sha256(stableJson({ metadata, summary: graphSummary, coverage, graphErrors })) });
    evidence.push({ id: `CG-NODES-${snapshot.id}`, snapshotId: snapshot.id, kind: "graph", title: "Representative CodeGraph nodes", data: representativeNodes, reason: "identify likely entry points, components and implementation centers", digest: sha256(stableJson(representativeNodes)) });
    evidence.push({ id: `CG-ROUTES-${snapshot.id}`, snapshotId: snapshot.id, kind: "graph", title: "Route candidates", data: routes, reason: "identify user and system entry points; source confirmation is required for incomplete route semantics", digest: sha256(stableJson(routes)) });
  } else {
    coverage = { indexed: 0, eligible: files.filter(isLikelySource).length, ratio: 0 };
  }

  const projectDocs = selectProjectDocuments(files, 14);
  const docSummaries: Array<Record<string, unknown>> = [];
  for (const file of projectDocs) {
    deadline.check("reading project documents");
    try {
      const window = await sourceReader.wholeFile(file.relativePath, /^README/i.test(basename(file.relativePath)) ? "read the project's own description" : "identify runtime, dependencies and repository role", 18_000);
      const kind = /^README/i.test(basename(file.relativePath)) ? "readme" : "manifest";
      const item = evidenceFromWindow(window, kind);
      item.title = file.relativePath;
      evidence.push(item);
      docSummaries.push({ path: file.relativePath, root: file.rootName, kind, summary: kind === "manifest" ? manifestSummary(file.relativePath, window.content) : truncate(window.content, 2_000) });
    } catch (error) {
      warnings.push(`Could not read ${file.relativePath}: ${(error as Error).message}`);
    }
  }

  if (graph) {
    const routeNodes = routes as Array<{ filePath: string; startLine: number; endLine: number; id: string; name: string }>;
    const merged = mergeWindows(routeNodes.slice(0, 8).map((node) => ({ path: node.filePath, start: Math.max(1, node.startLine - 4), end: node.endLine + 12, reason: `confirm route candidate ${node.name}` })));
    for (const windowSpec of merged) {
      try { evidence.push(evidenceFromWindow(await sourceReader.window(windowSpec.path, windowSpec.start, windowSpec.end, windowSpec.reason))); }
      catch (error) { warnings.push(`Route source fallback failed for ${windowSpec.path}: ${(error as Error).message}`); break; }
    }
  }

  const unindexed = files.filter((file) => isLikelySource(file) && !graphPaths.has(file.relativePath));
  if (unindexed.length) {
    const matches = await sourceSearch(unindexed, ["router", "route", "controller", "handler", "schedule", "cron", "permission", "role", "migration", "schema"], { maxResults: 24 });
    const specs = mergeWindows(matches.map((match) => ({
      path: match.file.relativePath,
      start: Math.max(1, match.line - 8),
      end: match.line + 20,
      reason: "source fallback for a source file not represented by CodeGraph"
    })));
    for (const spec of specs.slice(0, 5)) {
      try { evidence.push(evidenceFromWindow(await sourceReader.window(spec.path, spec.start, spec.end, spec.reason))); }
      catch (error) { warnings.push(`Shared context route fallback truncated: ${(error as Error).message}`); break; }
    }
  }

  const markdown = renderSharedMarkdown(snapshot, graphSummary, coverage, docSummaries, representativeNodes, routes, evidence, warnings);
  return { snapshotId: snapshot.id, evidence: dedupeEvidence(evidence), markdown, graphFilePaths: [...graphPaths], metrics: { coverage, warnings } };
}

async function buildFeatureContext(snapshot: Snapshot, files: ScannedFile[], feature: FeatureRequest, graph: GraphReader | null, graphPaths: Set<string>, sourceReader: SourceReader, deadline: Deadline, maxNodes: number, depth: number): Promise<CachedFeature> {
  const terms = [...new Set([feature.subject, ...feature.aliases].flatMap(tokenize))].filter(Boolean);
  const evidence: EvidenceItem[] = [];
  const warnings: string[] = [];
  const truncated = (stage: string, error: unknown): void => {
    warnings.push(`Feature "${feature.subject}" evidence truncated at ${stage}: ${(error as Error).message}`);
  };
  let nodes: any[] = [];
  let edges: any[] = [];
  let seeds: any[] = [];
  let unresolved: any[] = [];

  if (graph && terms.length) {
    const anchorTerms = featureAnchorTerms(terms);
    const actionTerms = terms.filter((term) => !anchorTerms.includes(term));
    const primarySeeds = graph.searchNodes(anchorTerms, Math.min(120, maxNodes));
    const anchoredFiles = [...new Set(primarySeeds.map((node) => node.filePath))];
    const actionSeeds = actionTerms.length ? graph.searchNodesInFiles(actionTerms, anchoredFiles, Math.min(60, maxNodes)) : [];
    seeds = dedupeNodes([...primarySeeds, ...actionSeeds]);
    // Candidate pool: expand cap ×6 so depth-2 neighbourhoods are not starved (a per-module cap of
    // maxNodes let level-0 exhaust before the depth-2 ring was ever visited). Then close the pool
    // over its own internal edges so hop2↔hop2 relationships (which layered BFS never captures) are
    // present for the prune's structural-rescue bridge signal and the retained edge set.
    const expanded = graph.expand(seeds.map((node) => node.id), Math.min(depth, 2), Math.max(maxNodes, seeds.length) * 6);
    const poolEdges = graph.edgesAmong(expanded.nodes.map((node) => node.id));
    const pruned = pruneFeatureGraphWithModuleFloor(expanded.nodes, [...expanded.edges, ...poolEdges], seeds, anchorTerms, maxNodes);
    nodes = pruned.nodes;
    edges = pruned.edges;
    unresolved = graph.unresolvedForNodeIds(nodes.map((node) => node.id), 150);
    evidence.push({ id: `FG-${featureCacheKey(feature)}-${snapshot.id}`, snapshotId: snapshot.id, kind: "graph", title: `CodeGraph scope for ${feature.subject}`, data: { terms, anchorTerms, actionTerms, seeds, nodes, edges, unresolved }, reason: "locate the feature from specific anchors before applying generic action vocabulary", digest: sha256(stableJson({ terms, anchorTerms, actionTerms, seeds, nodes, edges, unresolved })) });
  }

  const graphFiles = [...new Set(nodes.map((node) => String(node.filePath)))];
  const balancedNodes = balancedFeatureNodes(nodes, terms, 36);
  const sourceSpecs = mergeWindows(balancedNodes.map((node) => ({
    path: String(node.filePath),
    start: Math.max(1, Number(node.startLine) - 10),
    end: Number(node.endLine) + 24,
    reason: `verify ${feature.subject} ${featureCategory(node).id} semantics beyond the graph index`
  })));
  for (const spec of sourceSpecs.slice(0, 18)) {
    deadline.check(`reading balanced feature source for ${feature.subject}`);
    try { evidence.push(evidenceFromWindow(await sourceReader.window(spec.path, spec.start, spec.end, spec.reason))); }
    catch (error) { truncated("balanced graph windows", error); break; }
  }

  const needBroadFallback = !graph || nodes.length < 5 || unresolved.length > Math.max(5, nodes.length / 3);
  const searchResults = await sourceSearch(files, terms, { graphPaths, onlyUnindexed: !needBroadFallback, maxResults: 80 });
  const fallbackReason = needBroadFallback
    ? "feature source fallback because graph coverage was insufficient"
    : "feature source fallback for an unindexed file";
  const fallbackSpecs = mergeWindows(searchResults.map((match) => ({
    path: match.file.relativePath,
    start: Math.max(1, match.line - 10),
    end: match.line + 28,
    reason: fallbackReason
  })));
  for (const spec of fallbackSpecs.slice(0, needBroadFallback ? 10 : 5)) {
    try { evidence.push(evidenceFromWindow(await sourceReader.window(spec.path, spec.start, spec.end, spec.reason))); }
    catch (error) { truncated("search fallback windows", error); break; }
  }

  const graphFileSet = new Set(graphFiles);
  const scopeCandidates = files.filter((file) => graphFileSet.has(file.relativePath) || terms.some((term) => file.relativePath.toLowerCase().includes(term.toLowerCase())));
  const semanticSpecs: Array<{ path: string; start: number; end: number; reason: string }> = [];
  for (const category of FEATURE_AUTHORING_CATEGORIES.filter((item) => item.searchTerms.length)) {
    const matches = await sourceSearch(scopeCandidates.length ? scopeCandidates : files, category.searchTerms, { maxResults: 16 });
    for (const match of matches.slice(0, 2)) semanticSpecs.push({
      path: match.file.relativePath,
      start: Math.max(1, match.line - 12),
      end: match.line + 34,
      reason: `build the ${category.id} fact inventory for ${feature.subject}`
    });
  }
  for (const spec of mergeWindows(semanticSpecs).slice(0, 14)) {
    try { evidence.push(evidenceFromWindow(await sourceReader.window(spec.path, spec.start, spec.end, spec.reason))); }
    catch (error) { truncated("semantic category windows", error); break; }
  }

  const scopeFiles = [...new Set([...graphFiles, ...evidence.map((item) => item.path).filter(Boolean) as string[]])].sort();
  const key = featureCacheKey(feature);
  const boundary = new Set(scopeFiles);
  const factPack = await buildFactPack({
    snapshotId: snapshot.id,
    featureKey: key,
    files: files.filter((file) => boundary.has(file.relativePath)),
    graph,
    sourceReader,
    deadline,
    scopeNodesCapped: nodes.length >= maxNodes,
    // The pruned feature graph is right here: the logic category enumerates the business/decision nodes
    // its retained set holds that the six structural categories did not already claim.
    featureGraph: { nodes, edges, seeds }
  });
  evidence.push(...factPackEvidence(factPack));
  // The second obligation source (57B-396). The fact pack above enumerates what the prune RETAINED; this
  // enumerates every decision-bearing function in the same boundary FILES, which is where the retained
  // set's recall ceiling shows up as unread rules.
  const absoluteByPath = new Map(files.map((file) => [file.relativePath, file.absolutePath]));
  const boundaryFunctions = await enumerateBoundaryFunctions(graph, {
    featureKey: key,
    files: scopeFiles,
    absolutePathFor: (path) => absoluteByPath.get(path),
  }, warnings);
  const inventory = buildFeatureInventory(nodes, scopeFiles);
  const markdown = renderFeatureMarkdown(feature, terms, nodes, edges, unresolved, scopeFiles, evidence, needBroadFallback, inventory, warnings, factPack);
  return { snapshotId: snapshot.id, key, subject: feature.subject, aliases: feature.aliases, nodes, files: scopeFiles, evidence: dedupeEvidence(evidence), markdown, factPack, boundaryFunctions, warnings: [...warnings, ...factPack.warnings] };
}

function renderSharedMarkdown(snapshot: Snapshot, graphSummary: unknown, coverage: { indexed: number; eligible: number; ratio: number }, docs: Array<Record<string, unknown>>, representativeNodes: any[], routes: any[], evidence: EvidenceItem[], warnings: string[]): string {
  const compactNodes = representativeNodes.map((node) => ({ id: node.id, kind: node.kind, name: node.name, file: node.filePath, lines: `${node.startLine}-${node.endLine}`, signature: node.signature ? truncate(String(node.signature), 180) : null }));
  const compactRoutes = routes.map((node) => ({ id: node.id, name: node.name, file: node.filePath, line: node.startLine }));
  const sourceEvidence = evidence.filter((item) => item.content).map((item) => ({ id: item.id, title: item.title, reason: item.reason, excerpt: truncate(item.content ?? "", 1_800) }));
  return `# Shared project context

## Snapshot

\`\`\`json
${stableJson({ id: snapshot.id, roots: snapshot.roots, scannerVersion: snapshot.scannerVersion, ignoreRulesDigest: snapshot.ignoreRulesDigest, sourceManifestDigest: snapshot.sourceManifestDigest, codegraphDigest: snapshot.codegraphDigest })}
\`\`\`

## Coverage

- CodeGraph source coverage: ${(coverage.ratio * 100).toFixed(1)}% (${coverage.indexed}/${coverage.eligible}).
- CodeGraph is a navigation index. Source excerpts remain authoritative for semantics.
- Files absent from CodeGraph, extraction errors, unresolved relationships and ambiguous findings trigger source fallback.

## Repository documents and manifests

\`\`\`json
${stableJson(docs)}
\`\`\`

## CodeGraph census

\`\`\`json
${stableJson(graphSummary)}
\`\`\`

## Balanced representative nodes

\`\`\`json
${stableJson(compactNodes)}
\`\`\`

## Balanced route candidates

\`\`\`json
${stableJson(compactRoutes)}
\`\`\`

## Selected source evidence

${sourceEvidence.map((item) => `### ${item.id} — ${item.title}\n\nReason: ${item.reason}\n\n\`\`\`text\n${item.excerpt}\n\`\`\``).join("\n\n")}

## Evidence catalog

${evidence.map((item) => `- **${item.id}** — ${item.title}; ${item.reason}`).join("\n")}

## Warnings and limits

${warnings.length ? warnings.map((warning) => `- ${warning}`).join("\n") : "- No preparation warning was recorded."}
`;
}

function renderOverviewContext(audience: Audience, language: string): string {
  // Unreachable for the "prd" audience: prepareRun guards overviewAudiences against prd before buildContexts
  // ever calls this, so prd never falls into the non-product (engineering) branch below.
  const role = audience === "product"
    ? "Write for product managers, business owners and operations leads. Explain business meaning and current behavior. Keep implementation identifiers inside evidence blocks."
    : "Write for developers and technical leads. Explain repository responsibilities, technology stacks, runtime entry points, communication, persistence, files, integrations, configuration and current technical risks.";
  return `# Document instructions

- Document: project overview
- Audience: ${audience}
- Output language: ${language}
- Read the shared project context once from \`context/shared.md\`.
- When two or more features are prepared, the shared context ends with a "Cross-feature relationships" section and the same data is in \`context/cross-feature.json\`; use it for the cross-feature relationship matrix. It is deterministic prepared context, not an audited claim.
- Read the evidence catalog from \`evidence.json\` only when a cited item needs full detail.
- Describe the current source snapshot only. State observed problems, but do not recommend fixes or future architecture.
- Inference from code is allowed when marked and grounded.
- Additional source must be recorded through the Excavator source command before use.

${role}
`;
}

function renderFeatureContext(audience: Audience, language: string, subject: string, key: string): string {
  const role = audience === "product"
    ? "Explain what people can do, roles, flow, rules, lifecycle, data, side effects and current problems without exposing implementation detail in the reading flow."
    : audience === "prd"
    ? "Specify the current behavior as a PRD: rules with formulas & boundary values, permission matrix, precise frontend interaction (colors / verbatim tooltip text / empty-slot symbols / AM-PM time slots), verbatim notification templates, acceptance checklist; NO background chapter; prefer tables/lists."
    : "Explain feature boundaries, entry points, call paths, repositories, technical stack, data models, storage, authorization, configuration, failure paths, tests and change reachability.";
  return `# Document instructions

- Document: feature report
- Subject: ${subject}
- Audience: ${audience}
- Output language: ${language}
- Reuse \`context/shared.md\`; do not reread or rebuild project-wide context.
- Read the feature scope once from \`context/features/${key}.md\`.
- Read \`evidence.json\` only for full evidence details.
- Describe current state and current problems only. Do not recommend fixes.
- Inference from code is allowed when marked and grounded.

${role}
`;
}

function renderFeatureMarkdown(feature: FeatureRequest, terms: string[], nodes: any[], edges: any[], unresolved: any[], files: string[], evidence: EvidenceItem[], broadFallback: boolean, inventory: FeatureInventoryEntry[], truncations: string[], factPack: FeatureFactPack): string {
  const compactNodes = nodes.slice(0, 100).map((node) => ({ id: node.id, kind: node.kind, name: node.name, file: node.filePath, lines: `${node.startLine}-${node.endLine}`, signature: node.signature ? truncate(String(node.signature), 180) : null }));
  const compactEdges = edges.slice(0, 160).map((edge) => ({ source: edge.source, target: edge.target, kind: edge.kind, line: edge.line, refName: edge.metadata?.refName, confidence: edge.metadata?.confidence }));
  const edgeKinds = Object.entries(edges.reduce((acc: Record<string, number>, edge: any) => { acc[edge.kind] = (acc[edge.kind] ?? 0) + 1; return acc; }, {})).sort((a, b) => Number(b[1]) - Number(a[1]));
  const compactUnresolved = unresolved.slice(0, 60).map((item) => ({ from: item.from_node_id, name: item.reference_name, kind: item.reference_kind, file: item.file_path, line: item.line, status: item.status }));
  const sourceEvidence = evidence.filter((item) => item.content).map((item) => ({ id: item.id, title: item.title, reason: item.reason, excerpt: truncate(item.content ?? "", 1_800) }));
  return `# Feature scope: ${feature.subject}

## Search vocabulary

${terms.map((term) => `- ${term}`).join("\n")}

## Boundary

- Candidate graph nodes: ${nodes.length}.
- Related graph edges: ${edges.length}.
- Files in the working boundary: ${files.length}.
- Unresolved graph references: ${unresolved.length}.
- Broad source fallback used: ${broadFallback ? "yes" : "no"}.
- Evidence truncation: ${truncations.length ? truncations.join(" | ") : "none"}

## Authoring inventory

This inventory is a coverage map, not a source of truth by itself. Complete every material category with source-backed claims; do not replace the category with one summary sentence.

| Report section | Category | Candidate nodes | Candidate files | Representative paths |
|---:|---|---:|---:|---|
${inventory.map((item) => `| ${item.section} | ${item.label} | ${item.nodeCount} | ${item.fileCount} | ${item.examples.map((value) => `\`${value}\``).join("<br>") || "—"} |`).join("\n")}

${renderFactPackSection(factPack)}

## Files

${files.map((file) => `- ${file}`).join("\n")}

## Node summary

\`\`\`json
${stableJson(compactNodes)}
\`\`\`

## Relationship summary

Edge kinds: ${edgeKinds.map(([kind, count]) => `${kind}=${count}`).join(", ")}.

\`\`\`json
${stableJson(compactEdges)}
\`\`\`

## Unresolved references

\`\`\`json
${stableJson(compactUnresolved)}
\`\`\`

## Selected source evidence

${sourceEvidence.map((item) => `### ${item.id} — ${item.title}\n\nReason: ${item.reason}\n\n\`\`\`text\n${item.excerpt}\n\`\`\``).join("\n\n")}

## Evidence IDs

${evidence.map((item) => `- ${item.id}: ${item.title}`).join("\n")}
`;
}


interface FeatureAuthoringCategory {
  id: string;
  label: string;
  section: number;
  patterns: RegExp[];
  searchTerms: string[];
}

interface FeatureInventoryEntry {
  id: string;
  label: string;
  section: number;
  nodeCount: number;
  fileCount: number;
  examples: string[];
}

const FEATURE_AUTHORING_CATEGORIES: FeatureAuthoringCategory[] = [
  { id: "boundary", label: "Boundary and repositories", section: 1, patterns: [/module|package|feature|domain|README/i], searchTerms: [] },
  { id: "entrypoints", label: "UI, API and automated entry points", section: 2, patterns: [/route|router|handler|controller|endpoint|page|form|component|command|callback/i], searchTerms: ["route", "router", "handler", "controller", "page", "form", "schedule"] },
  { id: "flows", label: "Normal, decision and reversal flows", section: 3, patterns: [/service|usecase|workflow|process|create|submit|approve|reject|cancel|withdraw|rollback/i], searchTerms: ["create", "submit", "approve", "reject", "cancel", "withdraw", "rollback"] },
  { id: "rules", label: "Types, states, calculations and validation", section: 4, patterns: [/constant|enum|status|type|rule|valid|policy|calculate|threshold|limit|balance|hour|date/i], searchTerms: ["status", "type", "required", "validate", "limit", "threshold", "balance", "hours"] },
  { id: "authorization", label: "Authentication, authorization and data scope", section: 5, patterns: [/auth|permission|role|middleware|guard|scope|access/i], searchTerms: ["permission", "authorize", "role", "middleware", "current user", "user_id"] },
  { id: "data", label: "Entities, fields and persistence", section: 6, patterns: [/model|entity|repository|schema|migration|table|dto|store|persist|database/i], searchTerms: ["model", "table", "transaction", "insert", "update", "delete", "select"] },
  { id: "side-effects", label: "Files, messages, notifications and integrations", section: 7, patterns: [/mail|email|notification|export|file|upload|download|storage|s3|client|integration|webhook/i], searchTerms: ["email", "mail", "notification", "export", "upload", "download", "storage"] },
  { id: "failures", label: "Errors, transactions and partial success", section: 8, patterns: [/error|exception|retry|recover|transaction|rollback|concurr|lock|async/i], searchTerms: ["error", "transaction", "rollback", "retry", "async", "lock"] },
  { id: "configuration", label: "Configuration, switches and background work", section: 9, patterns: [/config|env|flag|switch|cron|schedule|job|worker|startup|timeout/i], searchTerms: ["config", "env", "cron", "schedule", "job", "timeout"] },
  { id: "dependencies", label: "Dependencies and connected change scope", section: 10, patterns: [/client|adapter|bridge|provider|dependency|caller|callee|shared/i], searchTerms: ["client", "provider", "bridge", "adapter"] },
  { id: "tests-docs", label: "Tests, documentation and unfinished behavior", section: 11, patterns: [/test|spec|fixture|mock|README|swagger|openapi|TODO|deprecated|temporary/i], searchTerms: ["TODO", "deprecated", "test", "spec", "swagger", "openapi"] },
  { id: "coverage", label: "Coverage and unresolved questions", section: 12, patterns: [/unresolved|unknown|coverage/i], searchTerms: [] }
];

function featureCategory(value: any): FeatureAuthoringCategory {
  const path = String(value?.filePath ?? value?.relativePath ?? "").replaceAll("\\", "/");
  const name = String(value?.name ?? "");
  const kind = String(value?.kind ?? "");
  const signature = String(value?.signature ?? "");
  const text = `${path} ${name} ${kind} ${signature}`;
  const pick = (id: string) => FEATURE_AUTHORING_CATEGORIES.find((category) => category.id === id)!;
  if (/(^|\/)(tests?|__tests__|fixtures?|mocks?)(\/|$)|\.(test|spec)\.|README|swagger|openapi|TODO|deprecated|temporary/i.test(text)) return pick("tests-docs");
  if (/config|\.env|cron|schedule|job|worker|startup|timeout/i.test(text)) return pick("configuration");
  if (/auth|permission|role|middleware|guard|access|scope/i.test(text)) return pick("authorization");
  if (/error|exception|retry|recover|transaction|rollback|concurr|lock|async/i.test(text)) return pick("failures");
  if (/mail|email|notification|export|upload|download|storage|s3|webhook|integration/i.test(text)) return pick("side-effects");
  if (/model|entity|repository|schema|migration|table|dto|persist|database/i.test(text)) return pick("data");
  if (/constant|enum|status|type|rule|valid|policy|calculate|threshold|limit|balance|hour|date/i.test(text)) return pick("rules");
  if (kind === "route" || kind === "component" || /(^|\/)(router|routes?|controllers?|pages?)(\.|\/)|Handler$|Controller$|Page$|Form$/i.test(text)) return pick("entrypoints");
  if (/service|usecase|workflow|process|create|submit|approve|reject|cancel|withdraw/i.test(text)) return pick("flows");
  if (/client|adapter|bridge|provider|dependency|caller|callee|shared/i.test(text)) return pick("dependencies");
  return pick("boundary");
}

const GENERIC_FEATURE_ACTION_TERMS = new Set([
  "approval", "approve", "approved", "reject", "rejected", "withdraw", "withdrawal", "cancel", "cancellation",
  "create", "update", "delete", "list", "detail", "manage", "management", "process", "workflow",
  "审批", "批准", "拒绝", "撤销", "取消", "创建", "更新", "删除", "管理", "流程"
]);

function featureAnchorTerms(terms: string[]): string[] {
  const anchors = terms.filter((term) => !GENERIC_FEATURE_ACTION_TERMS.has(term.toLowerCase()));
  return anchors.length ? anchors : terms;
}

function dedupeNodes(nodes: any[]): any[] {
  const seen = new Set<string>();
  return nodes.filter((node) => { const id = String(node.id); if (seen.has(id)) return false; seen.add(id); return true; });
}

function balancedFeatureNodes(nodes: any[], terms: string[], limit: number): any[] {
  const buckets = new Map<string, any[]>();
  for (const node of nodes) {
    const category = featureCategory(node);
    const bucket = buckets.get(category.id) ?? [];
    bucket.push(node);
    buckets.set(category.id, bucket);
  }
  const score = (node: any): number => {
    const text = [node?.filePath, node?.name, node?.signature].filter(Boolean).join(" ").toLowerCase();
    return terms.reduce((total, term) => total + (text.includes(term.toLowerCase()) ? 10 : 0), 0) + (/test|spec/i.test(text) ? -2 : 0);
  };
  for (const bucket of buckets.values()) bucket.sort((a, b) => score(b) - score(a));
  const result: any[] = [];
  let round = 0;
  while (result.length < limit) {
    let added = false;
    for (const category of FEATURE_AUTHORING_CATEGORIES) {
      const node = buckets.get(category.id)?.[round];
      if (!node) continue;
      result.push(node);
      added = true;
      if (result.length >= limit) break;
    }
    if (!added) break;
    round += 1;
  }
  return result;
}

function buildFeatureInventory(nodes: any[], files: string[]): FeatureInventoryEntry[] {
  return FEATURE_AUTHORING_CATEGORIES.map((category) => {
    const categoryNodes = nodes.filter((node) => featureCategory(node).id === category.id);
    const categoryFiles = files.filter((file) => category.patterns.some((pattern) => pattern.test(file)));
    const examples = [...new Set([...categoryNodes.map((node) => String(node.filePath)), ...categoryFiles])].filter(Boolean).slice(0, 4);
    return { id: category.id, label: category.label, section: category.section, nodeCount: categoryNodes.length, fileCount: categoryFiles.length, examples };
  });
}

export function featureCacheKey(feature: FeatureRequest): string {
  return `${slugify(feature.subject)}-${sha256(stableJson({ subject: feature.subject.toLowerCase(), aliases: [...feature.aliases].sort() })).slice(0, 10)}`;
}

function tokenize(value: string): string[] {
  const stop = new Set(["management", "module", "system", "service", "feature", "time", "off", "data", "process", "report", "管理", "模块", "系统", "功能", "流程", "报告"]);
  const lower = value.toLowerCase().trim();
  const words = lower.match(/[\p{Letter}\p{Number}_-]{2,}/gu) ?? [];
  const meaningful = words.filter((word) => !stop.has(word));
  if (lower.includes(" ") && lower.length >= 4) meaningful.unshift(lower);
  return [...new Set(meaningful)];
}

function mergeWindows(specs: Array<{ path: string; start: number; end: number; reason: string }>): Array<{ path: string; start: number; end: number; reason: string }> {
  const byPath = new Map<string, Array<{ start: number; end: number; reason: string }>>();
  for (const spec of specs) {
    if (!spec.path) continue;
    const list = byPath.get(spec.path) ?? [];
    list.push({ start: spec.start, end: spec.end, reason: spec.reason });
    byPath.set(spec.path, list);
  }
  const merged: Array<{ path: string; start: number; end: number; reason: string }> = [];
  for (const [path, ranges] of byPath) {
    ranges.sort((a, b) => a.start - b.start);
    let current = ranges[0];
    for (const next of ranges.slice(1)) {
      if (next.start <= current.end + 8) current = { start: current.start, end: Math.max(current.end, next.end), reason: mergeReasons(current.reason, next.reason) };
      else { merged.push({ path, ...current }); current = next; }
    }
    if (current) merged.push({ path, ...current });
  }
  return merged.sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start);
}

function mergeReasons(left: string, right: string): string {
  return [...new Set([...left.split("; "), ...right.split("; ")].filter(Boolean))].join("; ");
}

function dedupeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
}
