/**
 * The audience-neutral Topic Catalog: every subject this run's frozen knowledge can support, and nothing else.
 *
 * "台账里有什么就产什么" is the whole rule. A facet is projected from ONE ledger family, one topic per row that
 * ledger already holds, and when the ledger is not there the facet says so by name. Three outcomes, never two:
 * `populated`, `ledger-absent` (the file or producer envelope is not available — quoting its own cause) and
 * `ledger-empty` (the ledger is there and holds no row for this facet). Collapsing the last two would render
 * "we have no schema producer in a run" as "this project has no data model", which is the 57B-449 failure one
 * level up: an absent denominator reading as a clean result.
 *
 * WHAT THIS FILE MAY NOT DO. It computes no new graph: relation ids are taken only from edges the ledgers already
 * record (a cross-feature relationship, a resolved cross-repo link). It re-derives no materiality, confidence or
 * completeness from anything but the low-layer ledgers — no document, no model and no planner can move them. And
 * it never merges two producers' observations of "the same" route into one topic: an indexed route and a
 * recovered route are two ledger rows, so they are two topics, each naming its own producer and factId. Inventing
 * the identity that merges them would be a graph computation wearing a de-duplication's clothes.
 */

import { assertNever, type NotApplicable, type Unavailable } from "../base/artifact-result.ts";
import type { FactKindId } from "../base/fact-kind-registry.ts";
import type { InvestigationWorkItem } from "../base/types.ts";
import type { ReadCoverageItem } from "../investigation/read-coverage.ts";
import type { ProducerFactSet } from "../facts/envelope.ts";
import { facetForFactKind } from "./fact-facet-routing.ts";
import {
  materialityRequiresDisposition,
  mintTopicCandidate,
  statusDetermination,
  TOPIC_FACETS,
  type TopicCandidate,
  type TopicFacet,
  type TopicObligationBinding
} from "./topic-candidate.ts";
import {
  type ProjectedProducer,
  type TopicCatalogSource
} from "./topic-catalog-source.ts";

export const TOPIC_CATALOG_VERSION = "topic-catalog-v1";

/** Why a facet holds no topic — or that it holds some. Every catalog carries one row per facet, always. */
export type FacetOutcome =
  | { readonly state: "populated"; readonly topics: number }
  | { readonly state: "ledger-absent"; readonly reason: string }
  | { readonly state: "ledger-empty"; readonly reason: string };

export interface FacetMaterialityCensus {
  readonly material: number;
  readonly obligatedNonMaterial: number;
  readonly unobligated: number;
}

export interface TopicFacetCensus {
  readonly facet: TopicFacet;
  readonly outcome: FacetOutcome;
  readonly materiality: FacetMaterialityCensus;
}

/**
 * The obligation conservation law: every work item in the sealed ledger is either bound by at least one topic or
 * named in `unassignedWorkItemIds`. The list is not capped — a cap on a conservation residue is a place for the
 * next silent loss to hide.
 */
export interface ObligationAccounting {
  readonly total: number;
  readonly assigned: number;
  readonly unassigned: number;
  readonly unassignedWorkItemIds: readonly string[];
}

/** Which producer facts became topics and which did not, by (producer, kind). No fact is silently dropped. */
export interface FactRoutingCensus {
  readonly mapped: number;
  readonly unmapped: readonly { readonly producer: string; readonly kind: string; readonly facts: number }[];
}

export interface TopicCatalogArtifact {
  readonly version: typeof TOPIC_CATALOG_VERSION;
  readonly runId: string;
  readonly snapshotId: string;
  readonly knowledgeEpoch: number;
  readonly knowledgeDigest: string;
  /** One row per member of `TOPIC_FACETS`, in that order. */
  readonly facets: readonly TopicFacetCensus[];
  /** Ascending by `topicId`. */
  readonly topics: readonly TopicCandidate[];
  readonly obligationAccounting: ObligationAccounting;
  readonly factRouting: FactRoutingCensus;
  readonly materiality: FacetMaterialityCensus;
}

interface FacetProjection {
  readonly topics: readonly TopicCandidate[];
  readonly outcome: FacetOutcome;
}

/** Build the catalog. Deterministic: the same run directory yields the same bytes, twice and forever. */
export function buildTopicCatalog(source: TopicCatalogSource): TopicCatalogArtifact {
  const context = buildContext(source);
  const projections = new Map<TopicFacet, FacetProjection>();
  for (const facet of TOPIC_FACETS) projections.set(facet, projectFacet(facet, context));

  const topics: TopicCandidate[] = [];
  const byId = new Map<string, TopicCandidate>();
  for (const facet of TOPIC_FACETS) {
    for (const topic of projections.get(facet)!.topics) {
      const clash = byId.get(topic.topicId);
      if (clash) {
        throw new Error(`Topics ${JSON.stringify(clash.canonicalKey)} and ${JSON.stringify(topic.canonicalKey)} both mint ${topic.topicId}; the topic identity is not distinguishing them`);
      }
      byId.set(topic.topicId, topic);
      topics.push(topic);
    }
  }
  topics.sort((a, b) => a.topicId.localeCompare(b.topicId));

  const assigned = new Set<string>();
  for (const topic of topics) for (const binding of topic.bindings) assigned.add(binding.workItemId);
  const unassignedWorkItemIds = source.workItems
    .map((item) => item.id)
    .filter((id) => !assigned.has(id))
    .sort((a, b) => a.localeCompare(b));

  return {
    version: TOPIC_CATALOG_VERSION,
    runId: source.knowledge.runId,
    snapshotId: source.knowledge.snapshotId,
    knowledgeEpoch: source.knowledge.epoch ?? 0,
    knowledgeDigest: source.knowledgeDigest,
    facets: TOPIC_FACETS.map((facet) => ({
      facet,
      outcome: projections.get(facet)!.outcome,
      materiality: censusOf(projections.get(facet)!.topics)
    })),
    topics,
    obligationAccounting: {
      total: source.workItems.length,
      assigned: assigned.size,
      unassigned: unassignedWorkItemIds.length,
      unassignedWorkItemIds
    },
    factRouting: context.factRouting,
    materiality: censusOf(topics)
  };
}

/** Material topics, in catalog order. The disposition denominator, and the only place it may come from. */
export function materialTopics(catalog: TopicCatalogArtifact): readonly TopicCandidate[] {
  return catalog.topics.filter((topic) => materialityRequiresDisposition(topic.materiality));
}

function censusOf(topics: readonly TopicCandidate[]): FacetMaterialityCensus {
  return {
    material: topics.filter((topic) => topic.materiality === "material").length,
    obligatedNonMaterial: topics.filter((topic) => topic.materiality === "obligated-non-material").length,
    unobligated: topics.filter((topic) => topic.materiality === "unobligated").length
  };
}

// --- the shared, pre-joined view every projection reads ----------------------------------------------------

interface CatalogContext {
  readonly source: TopicCatalogSource;
  /** Work items grouped by the bound-contract feature key their scope resolves to. */
  readonly workItemsByFeature: ReadonlyMap<string, readonly InvestigationWorkItem[]>;
  readonly residualById: ReadonlyMap<string, ReadCoverageItem>;
  readonly factRouting: FactRoutingCensus;
}

function buildContext(source: TopicCatalogSource): CatalogContext {
  const featureKeys = source.features.map((feature) => feature.key);
  const workItemsByFeature = new Map<string, InvestigationWorkItem[]>();
  for (const key of featureKeys) workItemsByFeature.set(key, []);
  for (const item of source.workItems) {
    const key = featureKeyOfScope(item.scope, featureKeys);
    if (key === null) continue;
    workItemsByFeature.get(key)!.push(item);
  }
  const residualById = new Map<string, ReadCoverageItem>();
  for (const item of source.residual.items) {
    if (residualById.has(item.id)) throw new Error(`coverage/read-residual.json holds two rows for ${JSON.stringify(item.id)}; the residual is keyed by obligation id`);
    residualById.set(item.id, item);
  }
  return { source, workItemsByFeature, residualById, factRouting: routeFacts(source) };
}

/**
 * Which bound feature a work-item scope belongs to.
 *
 * The ledger spells a feature scope two ways in one run — `feature:<subject>-<hash>` and `feature:<hash>` (both
 * present in the 917-item wcp baseline) — so the match accepts either against the contract's key. What it never
 * does is invent a feature: a `feature:` scope matching no bound key is a named failure, because the alternative
 * is work items belonging to a feature the report was never asked about, counted under nothing.
 */
function featureKeyOfScope(scope: string, featureKeys: readonly string[]): string | null {
  if (!scope.startsWith("feature:")) return null;
  const suffix = scope.slice("feature:".length);
  const exact = featureKeys.find((key) => key === suffix);
  if (exact !== undefined) return exact;
  const byHash = featureKeys.filter((key) => key.slice(key.lastIndexOf("-") + 1) === suffix);
  if (byHash.length === 1) return byHash[0]!;
  if (byHash.length > 1) {
    throw new Error(`Work item scope ${JSON.stringify(scope)} matches ${byHash.length} bound feature keys (${byHash.join(", ")}); the scope cannot be attributed`);
  }
  throw new Error(`Work item scope ${JSON.stringify(scope)} names no feature in contract/run-intent.json (bound keys: ${featureKeys.join(", ") || "none"})`);
}

/** Turn one work item into a binding, copying its evidence and trace ids verbatim. */
function bindingOf(item: InvestigationWorkItem): TopicObligationBinding {
  return {
    workItemId: item.id,
    dimension: item.dimension,
    status: item.status,
    material: item.material,
    evidenceIds: [...item.evidenceIds],
    traceIds: [...item.traceIds]
  };
}

/** The read-coverage reading for a set of bound work items: rows joined by obligation id, and their unread lines. */
function residualReading(context: CatalogContext, items: readonly InvestigationWorkItem[]): { residualRows: number; uncoveredLines: number } {
  let residualRows = 0;
  let uncoveredLines = 0;
  for (const item of items) {
    const row = context.residualById.get(item.id);
    if (!row) continue;
    residualRows += 1;
    uncoveredLines += row.uncoveredLines;
  }
  return { residualRows, uncoveredLines };
}

// --- fact routing -----------------------------------------------------------------------------------------

/**
 * Which facet a producer fact becomes a topic in.
 *
 * TWO closed unions have to stay covered here, so both are switched on. The producer switch keeps "a producer was
 * added to the projection list without a decision" a typecheck failure; the kind table it delegates to
 * (`fact-facet-routing.ts`) keeps "a fact KIND was registered without a decision" one too. The kind is the honest
 * key for the routing itself — the base registry binds each kind to exactly one producer and
 * `buildProducerFactSet` refuses a fact published under another producer's name — so the two switches cannot
 * disagree about a fact that is representable at all.
 */
function facetForFact(producer: ProjectedProducer, kind: FactKindId): TopicFacet | null {
  switch (producer) {
    case "codegraph":
    case "crossrepo":
    case "db-schema":
      return facetForFactKind(kind);
  }
  return assertNever(producer, "projected fact producer");
}

function routeFacts(source: TopicCatalogSource): FactRoutingCensus {
  let mapped = 0;
  const unmapped = new Map<string, number>();
  for (const [producer, envelope] of source.producers) {
    if (envelope.status !== "built") continue;
    for (const fact of envelope.value.facts) {
      if (facetForFact(producer, fact.kind) !== null) mapped += 1;
      else unmapped.set(`${producer}|${fact.kind}`, (unmapped.get(`${producer}|${fact.kind}`) ?? 0) + 1);
    }
  }
  return {
    mapped,
    unmapped: [...unmapped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, facts]) => ({ producer: key.slice(0, key.indexOf("|")), kind: key.slice(key.indexOf("|") + 1), facts }))
  };
}

/**
 * The reason a producer envelope yields no topic, in the producer's own words.
 *
 * Exhaustive over the non-built arms of the artifact envelope: a fourth producer state added upstream must be
 * given a sentence here, because a facet absence with no reason is the silent empty this whole facet census
 * exists to prevent.
 */
function envelopeAbsence(producer: ProjectedProducer, envelope: NotApplicable | Unavailable): string {
  switch (envelope.status) {
    case "unavailable":
      return `facts/producers/${producer}.json records status unavailable: ${envelope.cause}`;
    case "not-applicable":
      return `facts/producers/${producer}.json records status not-applicable: ${envelope.determination} (based on ${envelope.basedOn.join(", ")})`;
  }
  return assertNever(envelope, "producer envelope absence");
}

/** Every built fact of one producer whose kind maps to `facet`, with the envelope's absence reason otherwise. */
function factsFor(context: CatalogContext, producer: ProjectedProducer, facet: TopicFacet): { facts: readonly ProducerFactSet["facts"][number][]; absence: string | null } {
  const envelope = context.source.producers.get(producer);
  if (!envelope) throw new Error(`facts/producers/${producer}.json was not loaded; the ${facet} facet cannot be projected`);
  if (envelope.status !== "built") return { facts: [], absence: envelopeAbsence(producer, envelope) };
  return { facts: envelope.value.facts.filter((fact) => facetForFact(producer, fact.kind) === facet), absence: null };
}

// --- the projections --------------------------------------------------------------------------------------

/**
 * One projection per facet, dispatched exhaustively. No `default` arm: a new facet without a projection is a
 * typecheck failure, not a census row that is silently always empty.
 */
function projectFacet(facet: TopicFacet, context: CatalogContext): FacetProjection {
  switch (facet) {
    case "coverage":
      return projectCoverage(context);
    case "entity":
      return projectEntity(context);
    case "external-system":
      return projectExternalSystems(context);
    case "feature":
      return projectFeatures(context);
    case "route":
      return projectRoutes(context);
    case "work-item-dimension":
      return projectDimensions(context);
  }
  return assertNever(facet, "topic facet");
}

function projectFeatures(context: CatalogContext): FacetProjection {
  const { source } = context;
  if (source.features.length === 0) {
    return { topics: [], outcome: { state: "ledger-empty", reason: "contract/run-intent.json binds no feature to this run, so there is no feature topic to project" } };
  }
  const relationsByFeature = new Map<string, string[]>();
  if (source.crossFeature.state === "present") {
    for (const relationship of source.crossFeature.value.relationships) {
      const id = `cross-feature:${[relationship.featureA, relationship.featureB].sort((a, b) => a.localeCompare(b)).join("|")}`;
      for (const key of [relationship.featureA, relationship.featureB]) {
        const list = relationsByFeature.get(key);
        if (list) list.push(id);
        else relationsByFeature.set(key, [id]);
      }
    }
  }
  const topics = [...source.features]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((feature) => {
      const items = context.workItemsByFeature.get(feature.key) ?? [];
      return mintTopicCandidate({
        facet: "feature",
        kind: "feature",
        canonicalKey: `feature/${feature.key}`,
        title: feature.subject,
        source: { ledger: "contract/run-intent.json", rowId: feature.key },
        bindings: items.map(bindingOf),
        relationIds: relationsByFeature.get(feature.key) ?? [],
        ledgerUnknown: false,
        ...residualReading(context, items)
      });
    });
  return { topics, outcome: { state: "populated", topics: topics.length } };
}

/**
 * One topic per route fact, from both producers that publish one.
 *
 * A route fact carries no work-item id and no feature scope, so every route topic comes out `unobligated` BY
 * CONSTRUCTION — that count (1,434 on the wcp baseline) is a reading of how far the obligation ledger reaches,
 * not a claim that no route matters. Joining a route to a work item would need a (path, line) match against a
 * ledger that spells its rows four different ways, and a fragile join that silently misses is worse than an
 * honest zero: the miss would read as "no obligation exists".
 */
function projectRoutes(context: CatalogContext): FacetProjection {
  const topics: TopicCandidate[] = [];
  const absences: string[] = [];
  for (const producer of ["codegraph", "crossrepo"] as const) {
    const { facts, absence } = factsFor(context, producer, "route");
    if (absence !== null) {
      absences.push(absence);
      continue;
    }
    for (const fact of facts) {
      const name = fact.detail["name"];
      topics.push(mintTopicCandidate({
        facet: "route",
        kind: fact.kind,
        canonicalKey: `route/${producer}/${fact.factId}`,
        title: typeof name === "string" && name.trim() !== "" ? name : fact.factId,
        source: { ledger: `facts/producers/${producer}.json`, rowId: fact.factId },
        bindings: [],
        relationIds: [],
        ledgerUnknown: false,
        residualRows: 0,
        uncoveredLines: 0
      }));
    }
  }
  if (topics.length > 0) return { topics, outcome: { state: "populated", topics: topics.length } };
  if (absences.length > 0) return { topics, outcome: { state: "ledger-absent", reason: absences.join("; ") } };
  return { topics, outcome: { state: "ledger-empty", reason: "the codegraph and crossrepo envelopes were built and hold no route fact" } };
}

function projectEntity(context: CatalogContext): FacetProjection {
  const { facts, absence } = factsFor(context, "db-schema", "entity");
  if (absence !== null) return { topics: [], outcome: { state: "ledger-absent", reason: absence } };
  if (facts.length === 0) {
    return { topics: [], outcome: { state: "ledger-empty", reason: "facts/producers/db-schema.json was built and holds no fact, so no entity or table topic exists" } };
  }
  const topics = facts.map((fact) => {
    const name = fact.detail["name"];
    return mintTopicCandidate({
      facet: "entity",
      kind: fact.kind,
      canonicalKey: `entity/db-schema/${fact.factId}`,
      title: typeof name === "string" && name.trim() !== "" ? name : fact.factId,
      source: { ledger: "facts/producers/db-schema.json", rowId: fact.factId },
      bindings: [],
      relationIds: [],
      ledgerUnknown: false,
      residualRows: 0,
      uncoveredLines: 0
    });
  });
  return { topics, outcome: { state: "populated", topics: topics.length } };
}

/**
 * One topic per ordered module pair a resolved cross-repo link already records. The links ARE the edges — the
 * pair is a grouping of rows that exist, not a graph this file computed — and each topic carries their link ids.
 */
function projectExternalSystems(context: CatalogContext): FacetProjection {
  const links = context.source.crossRepoLinks;
  if (links.state === "absent") return { topics: [], outcome: { state: "ledger-absent", reason: links.reason } };
  const byPair = new Map<string, string[]>();
  for (const link of links.value.links) {
    const pair = `${link.from.module}->${link.to.module}`;
    const list = byPair.get(pair);
    if (list) list.push(link.id);
    else byPair.set(pair, [link.id]);
  }
  if (byPair.size === 0) {
    return { topics: [], outcome: { state: "ledger-empty", reason: "context/crossrepo-links.json records no resolved link, so no counterpart system is named" } };
  }
  const topics = [...byPair.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pair, ids]) => mintTopicCandidate({
      facet: "external-system",
      kind: "http-link",
      canonicalKey: `external-system/${pair}`,
      title: `${pair.split("->")[0]} calls ${pair.split("->")[1]} over HTTP`,
      source: { ledger: "context/crossrepo-links.json", rowId: pair },
      bindings: [],
      relationIds: ids,
      ledgerUnknown: false,
      residualRows: 0,
      uncoveredLines: 0
    }));
  return { topics, outcome: { state: "populated", topics: topics.length } };
}

/**
 * One topic per (scope, dimension) family in the work-item ledger.
 *
 * This is the facet that makes the conservation law meaningful: every work item has a scope and a dimension, so
 * every obligation lands here even when no other facet claims it. The scope stays in the key verbatim, including
 * the ledger's two spellings of a feature scope — normalising them here would merge two families into one row and
 * the merge would balance every count it was checked against.
 */
function projectDimensions(context: CatalogContext): FacetProjection {
  const groups = new Map<string, InvestigationWorkItem[]>();
  for (const item of context.source.workItems) {
    const key = `${item.scope}|${item.dimension}`;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  if (groups.size === 0) {
    return { topics: [], outcome: { state: "ledger-empty", reason: "workitems.json holds no work item, so no obligation family exists" } };
  }
  const topics = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, items]) => {
      const [scope, dimension] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      return mintTopicCandidate({
        facet: "work-item-dimension",
        kind: dimension,
        canonicalKey: `work-item-dimension/${scope}/${dimension}`,
        title: `${dimension} obligations in scope ${scope}`,
        source: { ledger: "workitems.json", rowId: key },
        bindings: items.map(bindingOf),
        relationIds: [],
        ledgerUnknown: false,
        ...residualReading(context, items)
      });
    });
  return { topics, outcome: { state: "populated", topics: topics.length } };
}

/**
 * The unknown / coverage facet: the run's own accounting of what it did not settle.
 *
 * Four sources, each a ledger that already counts these rows — the read residual by status, work-item
 * determinations other than `found`, the boundary scan's blind spots, and the cross-repo calls that resolved to
 * no route. The read residual contributes EVERY status including `covered`, because that is what makes the
 * coverage denominator visible; determinations contribute only the non-`found` ones, because every work item is
 * already a topic member through its dimension family and this facet is the unresolved subset, not a second
 * partition of the ledger.
 */
function projectCoverage(context: CatalogContext): FacetProjection {
  const { source } = context;
  const topics: TopicCandidate[] = [];

  const byStatus = new Map<string, ReadCoverageItem[]>();
  for (const row of source.residual.items) {
    const list = byStatus.get(row.status);
    if (list) list.push(row);
    else byStatus.set(row.status, [row]);
  }
  const workItemById = new Map(source.workItems.map((item) => [item.id, item]));
  for (const [status, rows] of [...byStatus.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const bound = rows.map((row) => workItemById.get(row.id)).filter((item): item is InvestigationWorkItem => item !== undefined);
    topics.push(mintTopicCandidate({
      facet: "coverage",
      kind: "read-residual",
      canonicalKey: `coverage/read-residual/${status}`,
      title: `read obligations whose spans are ${status}`,
      source: { ledger: "coverage/read-residual.json", rowId: status },
      bindings: bound.map(bindingOf),
      relationIds: [],
      ledgerUnknown: status !== "covered",
      residualRows: rows.length,
      uncoveredLines: rows.reduce((total, row) => total + row.uncoveredLines, 0)
    }));
  }

  const byDetermination = new Map<string, InvestigationWorkItem[]>();
  for (const item of source.workItems) {
    if (item.status === "found") continue;
    const list = byDetermination.get(item.status);
    if (list) list.push(item);
    else byDetermination.set(item.status, [item]);
  }
  for (const [status, items] of [...byDetermination.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    topics.push(mintTopicCandidate({
      facet: "coverage",
      kind: "work-item-status",
      canonicalKey: `coverage/determination/${status}`,
      title: `work items whose determination is ${status}`,
      source: { ledger: "workitems.json", rowId: status },
      bindings: items.map(bindingOf),
      relationIds: [],
      ledgerUnknown: statusDetermination(items[0]!.status) !== "determined",
      ...residualReading(context, items)
    }));
  }

  if (!source.boundaryFunctions.graphAvailable) {
    topics.push(mintTopicCandidate({
      facet: "coverage",
      kind: "boundary-scan",
      canonicalKey: "coverage/boundary-scan/graph-unavailable",
      title: "the read-obligation second source ran with no code graph, so no boundary function was enumerated",
      source: { ledger: "context/boundary-functions.json", rowId: "graphAvailable" },
      bindings: [],
      relationIds: [],
      ledgerUnknown: true,
      residualRows: 0,
      uncoveredLines: 0
    }));
  }
  const blindFiles = new Set<string>();
  for (const feature of source.boundaryFunctions.features) for (const path of feature.filesWithoutCandidates) blindFiles.add(path);
  for (const path of [...blindFiles].sort((a, b) => a.localeCompare(b))) {
    topics.push(mintTopicCandidate({
      facet: "coverage",
      kind: "boundary-scan-blind-file",
      canonicalKey: `coverage/boundary-scan/files-without-candidates/${path}`,
      title: `no function-shaped symbol was enumerable in ${path}`,
      source: { ledger: "context/boundary-functions.json", rowId: path },
      bindings: [],
      relationIds: [],
      ledgerUnknown: true,
      residualRows: 0,
      uncoveredLines: 0
    }));
  }

  if (source.crossRepoLinks.state === "present") {
    const artifact = source.crossRepoLinks.value;
    const calls: Array<{ resolution: string; module: string; path: string; line: number; method: string }> = [
      ...artifact.unresolved.map((row) => ({ resolution: "unresolved", module: row.module, path: row.path, line: row.line, method: row.method })),
      ...artifact.ambiguous.map((row) => ({ resolution: "ambiguous", module: row.module, path: row.path, line: row.line, method: row.method }))
    ];
    for (const call of calls.sort((a, b) => `${a.resolution}/${a.module}/${a.path}/${a.line}/${a.method}`.localeCompare(`${b.resolution}/${b.module}/${b.path}/${b.line}/${b.method}`))) {
      topics.push(mintTopicCandidate({
        facet: "coverage",
        kind: `crossrepo-call-${call.resolution}`,
        canonicalKey: `coverage/crossrepo-call/${call.resolution}/${call.module}/${call.path}:${call.line}:${call.method}`,
        title: `an outbound ${call.method} call at ${call.path}:${call.line} resolved to no route (${call.resolution})`,
        source: { ledger: "context/crossrepo-links.json", rowId: `${call.resolution}/${call.path}:${call.line}:${call.method}` },
        bindings: [],
        relationIds: [],
        ledgerUnknown: true,
        residualRows: 0,
        uncoveredLines: 0
      }));
    }
  }

  if (topics.length === 0) {
    return {
      topics,
      outcome: {
        state: "ledger-empty",
        reason: "the read residual holds no row, every work item is found, the boundary scan reports no blind spot and no cross-repo call is unresolved"
      }
    };
  }
  return { topics, outcome: { state: "populated", topics: topics.length } };
}
