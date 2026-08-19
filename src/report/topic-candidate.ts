/**
 * TopicCandidate — one addressable subject of a report, derived from a frozen knowledge epoch and nothing else.
 *
 * IDENTITY IS CONTENT. `topicId` is derived from the facet plus a canonical key, and from nothing volatile: no
 * run id, no timestamp, no position in an array. Two runs over the same code therefore address the same topic by
 * the same id, which is what lets a later slice cache a written unit against it. The key that produced the id is
 * carried in the row (`canonicalKey`), so an id is auditable without re-running the generator — and so a reader
 * can see the key includes the PATH. A key that named only a symbol would collapse two same-named functions in
 * two files onto one topic, and the collapse would pass every conservation check because the merged row is still
 * one row.
 *
 * OBLIGATION GRANULARITY IS THE POINT. `bindings` is a list of work items, each carrying ITS OWN evidence and
 * trace ids exactly as `workitems.json` records them. It is deliberately NOT a topic-level bag of ids: 57B-453
 * measured what a flattened id set costs downstream — 60.1% of one document's material work items had no evidence
 * of theirs in the packet, and nothing could tell which id belonged to which obligation. A consumer holding only
 * `plan/topics.json` must be able to answer "which evidence grounds THIS obligation", so the ids stay attached to
 * the work item and are copied verbatim, in the ledger's own order, never sorted or de-duplicated here.
 *
 * NO SOURCE TEXT. An evidence id and a work item's dimension/status are the whole of what crosses into a topic.
 * Excerpt bytes never do, so the catalog cannot become a second, unversioned copy of the source.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { WorkItemStatus } from "../base/types.ts";
import { canonicalJson, sha256 } from "../base/util.ts";

export const TOPIC_CANDIDATE_VERSION = "topic-candidate-v1";

/**
 * The projection families a catalog is built from — one per knowledge-side ledger family, sorted so the census
 * has a canonical row order. A facet is not a topic kind: `kind` below carries the LEDGER'S own word for the
 * row (`indexed-route`, `decision-function`, a residual status), while the facet says which ledger family
 * answered. Every facet appears in the census of every catalog, populated or named-empty; that is the only way
 * "this project has no data-model topics" and "no run-scoped schema ledger exists" stay different statements.
 */
export const TOPIC_FACETS = ["coverage", "entity", "external-system", "feature", "route", "work-item-dimension"] as const;
export type TopicFacet = (typeof TOPIC_FACETS)[number];

/**
 * The three buckets, exhaustive over every topic.
 *
 * `unobligated` means exactly one thing: NO work item in this run's ledger binds to this topic. It is a statement
 * about the obligation ledger's reach, not a claim that the subject does not matter — 57B-453 turned up the shape
 * (a decisive behaviour with no obligation naming it) and the whole point is that it stays countable instead of
 * dissolving into "not material". Read it together with the facet: a route fact carries no work-item id and no
 * feature scope, so route topics are unobligated by construction, and their count says how far the obligation
 * ledger does NOT reach.
 */
export const TOPIC_MATERIALITIES = ["material", "obligated-non-material", "unobligated"] as const;
export type TopicMateriality = (typeof TOPIC_MATERIALITIES)[number];

/** How settled the topic's obligations are. `unbound` is its own member so "nobody looked" cannot read as "clean". */
export const TOPIC_CONFIDENCES = ["grounded", "qualified", "unbound", "unsettled"] as const;
export type TopicConfidence = (typeof TOPIC_CONFIDENCES)[number];

/** One work item's determination, as three states a caller can branch on without reading a status word. */
export type StatusDetermination = "determined" | "undetermined" | "open";

/**
 * The work-item statuses, at runtime, so a reader can reject an unknown status word instead of handing it to the
 * exhaustive switch below and getting a crash where a named problem belongs.
 *
 * Pinned to the base union in BOTH directions: `satisfies` refuses a member that is not a status, and the
 * `_everyStatusListed` line stops compiling if the base union gains one this list omits. A second hand-kept list
 * of an enum is otherwise exactly the silent drift this codebase keeps paying for.
 */
export const WORK_ITEM_STATUSES = [
  "cannot-determine", "found", "in_progress", "not-applicable", "pending", "searched-not-found"
] as const satisfies readonly WorkItemStatus[];

type EveryStatusListed = Exclude<WorkItemStatus, (typeof WORK_ITEM_STATUSES)[number]> extends never ? true : never;
const _everyStatusListed: EveryStatusListed = true;
void _everyStatusListed;

export interface TopicObligationBinding {
  readonly workItemId: string;
  /** The work item's dimension, verbatim: the vocabulary the obligation was minted under. */
  readonly dimension: string;
  readonly status: WorkItemStatus;
  readonly material: boolean;
  /** Verbatim from `workitems.json`, order preserved — a consumer must be able to compare byte for byte. */
  readonly evidenceIds: readonly string[];
  readonly traceIds: readonly string[];
}

/**
 * Counts, not a label. `residualRows` is the denominator of the read-coverage statement about this topic, and it
 * is reported even when it is zero: a topic with no read obligation is not a topic that was fully read, and
 * 57B-449 is what a missing denominator costs (an empty obligation set reported "every obligation has a window").
 */
export interface TopicCompletenessReading {
  readonly boundWorkItems: number;
  readonly settledWorkItems: number;
  readonly residualRows: number;
  readonly uncoveredLines: number;
}

/** Which ledger row this topic came from. Both required: a topic with no provenance is a topic nobody can check. */
export interface TopicSource {
  /** Run-relative path of the ledger, e.g. `facts/producers/codegraph.json`. */
  readonly ledger: string;
  /** The row's own id in that ledger. */
  readonly rowId: string;
}

export interface TopicCandidate {
  readonly topicId: string;
  readonly facet: TopicFacet;
  readonly kind: string;
  /** What `topicId` is derived from. Readable, and it always carries whatever distinguishes this row. */
  readonly canonicalKey: string;
  readonly title: string;
  readonly source: TopicSource;
  /** Ascending by `workItemId`; a work item binds at most once to one topic. */
  readonly bindings: readonly TopicObligationBinding[];
  readonly materiality: TopicMateriality;
  readonly confidence: TopicConfidence;
  readonly completeness: TopicCompletenessReading;
  /** True when something about this topic is undetermined. A planner may never render an unknown as not-applicable. */
  readonly unknown: boolean;
  /** Relation ids taken from edges the ledgers already record. Never a newly computed edge. */
  readonly relationIds: readonly string[];
  /** sha256 over the canonical serialisation of every other field. */
  readonly digest: string;
}

export interface MintTopicInput {
  readonly facet: TopicFacet;
  readonly kind: string;
  readonly canonicalKey: string;
  readonly title: string;
  readonly source: TopicSource;
  readonly bindings: readonly TopicObligationBinding[];
  readonly relationIds: readonly string[];
  /**
   * Whether the LEDGER row itself is an unknown (an unread residual span, a scan with no graph), independent of
   * its work items. Required rather than defaulted: a topic minted from an unknown row without saying so is the
   * exact silent state the disposition rule against `not-applicable` exists to stop.
   */
  readonly ledgerUnknown: boolean;
  readonly residualRows: number;
  readonly uncoveredLines: number;
}

/**
 * The id, derived from facet + canonical key and nothing else.
 *
 * Truncated to 16 hex characters — 64 bits over a catalog of thousands of topics, with the full key carried in
 * the row so a collision would be visible as two rows claiming one id (the catalog builder refuses that).
 */
export function topicIdOf(facet: TopicFacet, canonicalKey: string): string {
  if (!canonicalKey.trim()) throw new Error(`A ${facet} topic cannot be minted from an empty canonical key`);
  return `${facet}:${sha256(canonicalJson([facet, canonicalKey])).slice(0, 16)}`;
}

/**
 * How settled one work item is.
 *
 * Exhaustive over `WorkItemStatus` with no `default` arm: a new status in the base union must be classified here
 * before this file compiles, because the alternative is a status that silently reads as determined.
 */
export function statusDetermination(status: WorkItemStatus): StatusDetermination {
  switch (status) {
    case "found":
    case "searched-not-found":
    case "not-applicable":
      return "determined";
    case "cannot-determine":
      return "undetermined";
    case "pending":
    case "in_progress":
      return "open";
  }
  return assertNever(status, "work item status");
}

/** The three-bucket verdict, derived from the bound work items and from nothing a document could assert. */
export function materialityOf(bindings: readonly TopicObligationBinding[]): TopicMateriality {
  if (bindings.length === 0) return "unobligated";
  return bindings.some((binding) => binding.material) ? "material" : "obligated-non-material";
}

/** Confidence, derived from the bound work items' statuses only. */
export function confidenceOf(bindings: readonly TopicObligationBinding[]): TopicConfidence {
  if (bindings.length === 0) return "unbound";
  const determinations = bindings.map((binding) => statusDetermination(binding.status));
  if (determinations.some((determination) => determination === "open" || determination === "undetermined")) return "unsettled";
  return bindings.every((binding) => binding.status === "found") ? "grounded" : "qualified";
}

/**
 * Which buckets owe a disposition.
 *
 * Exhaustive with no `default`: dropping an arm is a typecheck failure rather than a bucket that quietly stops
 * being audited. Only `material` owes one — but the other two are still counted in the catalog, so "nothing was
 * omitted" and "nothing was material" cannot be told apart by their silence.
 */
export function materialityRequiresDisposition(materiality: TopicMateriality): boolean {
  switch (materiality) {
    case "material":
      return true;
    case "obligated-non-material":
    case "unobligated":
      return false;
  }
  return assertNever(materiality, "topic materiality");
}

/** Assemble one topic: derive identity, the three buckets, confidence, the unknown mark and the digest. */
export function mintTopicCandidate(input: MintTopicInput): TopicCandidate {
  const seen = new Set<string>();
  for (const binding of input.bindings) {
    if (seen.has(binding.workItemId)) {
      throw new Error(`Topic ${JSON.stringify(input.canonicalKey)} binds work item ${JSON.stringify(binding.workItemId)} twice`);
    }
    seen.add(binding.workItemId);
  }
  const bindings = [...input.bindings].sort((a, b) => a.workItemId.localeCompare(b.workItemId));
  const undetermined = bindings.some((binding) => statusDetermination(binding.status) !== "determined");
  const withoutDigest = {
    topicId: topicIdOf(input.facet, input.canonicalKey),
    facet: input.facet,
    kind: input.kind,
    canonicalKey: input.canonicalKey,
    title: input.title,
    source: input.source,
    bindings,
    materiality: materialityOf(bindings),
    confidence: confidenceOf(bindings),
    completeness: {
      boundWorkItems: bindings.length,
      settledWorkItems: bindings.filter((binding) => statusDetermination(binding.status) !== "open").length,
      residualRows: input.residualRows,
      uncoveredLines: input.uncoveredLines
    },
    unknown: input.ledgerUnknown || undetermined,
    relationIds: [...new Set(input.relationIds)].sort((a, b) => a.localeCompare(b))
  } satisfies Omit<TopicCandidate, "digest">;
  return { ...withoutDigest, digest: topicCandidateDigest(withoutDigest) };
}

/** The topic's content digest: canonical bytes of every field except the digest itself. */
export function topicCandidateDigest(topic: Omit<TopicCandidate, "digest">): string {
  return sha256(canonicalJson(topic));
}
