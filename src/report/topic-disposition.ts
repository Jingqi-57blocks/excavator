/**
 * The material-topic disposition validator: the deterministic gate a report plan cannot talk its way past.
 *
 * THE RULE. Every material topic in the catalog has exactly one disposition, and the disposition is one of six
 * words. A plan may group, reorder, collapse or omit — it may not make a material topic disappear without saying
 * which of the six happened to it, and it may not render an UNKNOWN as `not-applicable`: "we could not determine
 * it" and "it provably does not apply" are the two statements a reader most needs kept apart.
 *
 * THE DENOMINATOR COMES FROM THE CATALOG, ALWAYS. This validator reads no count, coverage claim or topic list off
 * the disposition document — a document that carries its own denominator is a document that grades itself. What it
 * accepts from the document is one row per topic id and nothing else.
 *
 * THE CONCLUSION HAS THREE STATES, NOT TWO. `complete` (a non-empty denominator, every member dispositioned),
 * `vacuous` (an EMPTY denominator, with its source written down) and `violations`. 57B-449 is why: an overview-only
 * run's read coverage had an empty obligation set and reported "every obligation has a window" — true, vacuously,
 * and indistinguishable from a real pass. A boolean `passed` here would rebuild exactly that, so there is none;
 * `summariseVerdict` forces a consumer to say which of the three it got.
 *
 * FIELD ARITY IS PER STATE, AND EVERY FIELD IS REQUIRED. `omitted-for-audience` must name the lens policy that
 * authorises the omission, and it is checked against the LIVE registry so a made-up id fails. `not-applicable` and
 * `cannot-determine` must carry a reason. The other three must carry neither — an exact arity, both directions,
 * because "a reason alongside a policy id" is how a placeholder policy id gets waved through.
 */

import { assertNever } from "../base/artifact-result.ts";
import { REPORT_POLICY_REGISTRY, type ReportPolicyRegistry } from "./report-policy-registry.ts";
import { materialityRequiresDisposition, TOPIC_FACETS, type TopicCandidate, type TopicFacet } from "./topic-candidate.ts";
import type { TopicCatalogArtifact } from "./topic-catalog.ts";

/** Sorted, so the enumeration reads the same everywhere it is printed. */
export const TOPIC_DISPOSITION_STATES = [
  "cannot-determine",
  "collapsed",
  "not-applicable",
  "omitted-for-audience",
  "primary",
  "referenced"
] as const;
export type TopicDispositionState = (typeof TOPIC_DISPOSITION_STATES)[number];

export interface TopicDisposition {
  readonly topicId: string;
  readonly state: TopicDispositionState;
  /** Required, empty unless the state is `not-applicable` or `cannot-determine`. */
  readonly reason: string;
  /** Required, empty unless the state is `omitted-for-audience`; then a registered lens policy id. */
  readonly lensPolicyId: string;
}

/**
 * One conclusion about one denominator. A union and not a record with an optional `source`: the vacuous arm has to
 * carry where its empty denominator came from, and the complete arm must have no place to put one.
 */
export type TopicDispositionVerdict =
  | { readonly conclusion: "complete"; readonly denominator: number; readonly dispositioned: number }
  | { readonly conclusion: "vacuous"; readonly denominator: 0; readonly source: string }
  | { readonly conclusion: "violations"; readonly denominator: number; readonly dispositioned: number; readonly problems: readonly string[] };

export interface TopicDispositionReport {
  readonly overall: TopicDispositionVerdict;
  /** One row per facet, in `TOPIC_FACETS` order, so a facet with no material topic is visibly vacuous. */
  readonly facets: readonly { readonly facet: TopicFacet; readonly verdict: TopicDispositionVerdict }[];
}

const DISPOSITION_FIELDS = ["lensPolicyId", "reason", "state", "topicId"] as const;

/**
 * One sentence per conclusion.
 *
 * Exhaustive with no `default` arm: this is the site that makes deleting a conclusion a typecheck failure, and it
 * is the reason `vacuous` cannot be rendered with the same words as `complete`.
 */
export function summariseVerdict(verdict: TopicDispositionVerdict): string {
  switch (verdict.conclusion) {
    case "complete":
      return `complete: all ${verdict.denominator} material topic(s) carry a disposition`;
    case "vacuous":
      return `vacuous: the material-topic denominator is empty, so nothing was checked — ${verdict.source}`;
    case "violations":
      return `violations: ${verdict.problems.length} problem(s) over ${verdict.denominator} material topic(s), ${verdict.dispositioned} dispositioned`;
  }
  return assertNever(verdict, "topic disposition conclusion");
}

/**
 * Which fields each state requires and which it must leave empty.
 *
 * Exhaustive over the six with no `default` arm: deleting one makes `state` a non-`never` at the `assertNever`
 * call and the file stops compiling. That compile error is the audit rule's only real enforcement — a `default`
 * would accept the deleted state silently and forever.
 */
export function dispositionArityProblems(disposition: TopicDisposition, registry: ReportPolicyRegistry): string[] {
  const { state, reason, lensPolicyId } = disposition;
  switch (state) {
    case "primary":
    case "referenced":
    case "collapsed":
      return [
        ...(reason.trim() === "" ? [] : [`state ${JSON.stringify(state)} carries a reason (${JSON.stringify(reason)}); only not-applicable and cannot-determine may`]),
        ...(lensPolicyId.trim() === "" ? [] : [`state ${JSON.stringify(state)} names lens policy ${JSON.stringify(lensPolicyId)}; only omitted-for-audience may`])
      ];
    case "omitted-for-audience": {
      const registered = Object.values(registry.lenses).map((entry) => entry.id);
      return [
        ...(reason.trim() === "" ? [] : [`state "omitted-for-audience" carries a reason (${JSON.stringify(reason)}); the lens policy is what authorises the omission`]),
        ...(registered.includes(lensPolicyId) ? [] : [`state "omitted-for-audience" names lens policy ${JSON.stringify(lensPolicyId)}, which is not registered (registered: ${registered.sort().join(", ")})`])
      ];
    }
    case "not-applicable":
    case "cannot-determine":
      return [
        ...(reason.trim() === "" ? [`state ${JSON.stringify(state)} carries no reason; a determination with no stated basis is a guess`] : []),
        ...(lensPolicyId.trim() === "" ? [] : [`state ${JSON.stringify(state)} names lens policy ${JSON.stringify(lensPolicyId)}; only omitted-for-audience may`])
      ];
  }
  return assertNever(state, "topic disposition state");
}

/**
 * Validate a disposition document against a catalog.
 *
 * `dispositions` is untrusted: a hand-written file, a model-derived proposal parsed by a later slice. Every shape
 * failure is a named problem rather than a throw, so one bad row does not hide the other twenty.
 */
export function validateTopicDispositions(
  catalog: TopicCatalogArtifact,
  dispositions: unknown,
  registry: ReportPolicyRegistry = REPORT_POLICY_REGISTRY
): TopicDispositionReport {
  const problems: string[] = [];
  const byTopic = new Map<string, TopicDisposition>();
  const topicsById = new Map(catalog.topics.map((topic) => [topic.topicId, topic]));
  const problemsByFacet = new Map<TopicFacet, string[]>(TOPIC_FACETS.map((facet) => [facet, []]));
  const record = (topicId: string | null, problem: string): void => {
    problems.push(problem);
    const facet = topicId === null ? undefined : topicsById.get(topicId)?.facet;
    if (facet !== undefined) problemsByFacet.get(facet)!.push(problem);
  };

  if (!Array.isArray(dispositions)) {
    problems.push(`the disposition document is ${JSON.stringify(dispositions)}, not an array of dispositions`);
  } else {
    for (const [index, row] of dispositions.entries()) {
      const parsed = parseTopicDisposition(row);
      if (parsed.disposition === null) {
        for (const problem of parsed.problems) record(null, `dispositions[${index}] ${problem}`);
        continue;
      }
      const disposition = parsed.disposition;
      const topic = topicsById.get(disposition.topicId);
      if (topic === undefined) {
        record(null, `dispositions[${index}] names topic ${JSON.stringify(disposition.topicId)}, which is not in this catalog`);
        continue;
      }
      if (byTopic.has(disposition.topicId)) {
        record(disposition.topicId, `dispositions[${index}] is a second disposition for topic ${JSON.stringify(disposition.topicId)}; a topic carries exactly one`);
        continue;
      }
      byTopic.set(disposition.topicId, disposition);
      for (const problem of dispositionArityProblems(disposition, registry)) {
        record(disposition.topicId, `dispositions[${index}] (topic ${disposition.topicId}) ${problem}`);
      }
      if (topic.unknown && disposition.state === "not-applicable") {
        record(disposition.topicId, `dispositions[${index}] renders topic ${JSON.stringify(disposition.topicId)} as not-applicable, but the topic is marked unknown; an undetermined subject may never be reported as provably inapplicable`);
      }
    }
  }

  const material = catalog.topics.filter((topic) => materialityRequiresDisposition(topic.materiality));
  for (const topic of material) {
    if (!byTopic.has(topic.topicId)) {
      record(topic.topicId, `material topic ${JSON.stringify(topic.topicId)} (${topic.canonicalKey}) carries no disposition`);
    }
  }

  return {
    overall: verdictOf(material, byTopic, problems, overallVacuousSource(catalog)),
    facets: TOPIC_FACETS.map((facet) => ({
      facet,
      verdict: verdictOf(
        material.filter((topic) => topic.facet === facet),
        byTopic,
        problemsByFacet.get(facet)!,
        facetVacuousSource(catalog, facet)
      )
    }))
  };
}

function verdictOf(
  material: readonly TopicCandidate[],
  byTopic: ReadonlyMap<string, TopicDisposition>,
  problems: readonly string[],
  vacuousSource: string
): TopicDispositionVerdict {
  const dispositioned = material.filter((topic) => byTopic.has(topic.topicId)).length;
  if (problems.length > 0) return { conclusion: "violations", denominator: material.length, dispositioned, problems: [...problems] };
  if (material.length === 0) return { conclusion: "vacuous", denominator: 0, source: vacuousSource };
  return { conclusion: "complete", denominator: material.length, dispositioned };
}

/** Where an empty catalog-wide denominator came from, in the catalog's own numbers. */
function overallVacuousSource(catalog: TopicCatalogArtifact): string {
  const { material, obligatedNonMaterial, unobligated } = catalog.materiality;
  return `this catalog holds ${catalog.topics.length} topic(s) of which ${material} are material, ${obligatedNonMaterial} obligated-non-material and ${unobligated} unobligated, over ${catalog.obligationAccounting.total} work item(s)`;
}

/**
 * Where a facet's empty denominator came from — the facet's own census row.
 *
 * An absent ledger and a facet whose topics are all unobligated are different empty denominators, and a reader
 * deciding whether to trust "no material topic here" needs to know which one it is.
 */
function facetVacuousSource(catalog: TopicCatalogArtifact, facet: TopicFacet): string {
  const census = catalog.facets.find((row) => row.facet === facet);
  if (census === undefined) return `the ${facet} facet has no census row in this catalog`;
  switch (census.outcome.state) {
    case "populated":
      return `the ${facet} facet holds ${census.outcome.topics} topic(s), none of them material (${census.materiality.obligatedNonMaterial} obligated-non-material, ${census.materiality.unobligated} unobligated)`;
    case "ledger-absent":
      return `the ${facet} facet is empty because its ledger is absent: ${census.outcome.reason}`;
    case "ledger-empty":
      return `the ${facet} facet is empty because its ledger holds no row: ${census.outcome.reason}`;
  }
  return assertNever(census.outcome, "topic facet outcome");
}

/**
 * Exported so the plan validator can hold the SAME parsed rows this validator judged — the obligation accounting
 * has to know which topic carries which state, and a second parser there would be a second copy of the six-state
 * rules. One parser, one set of rows, one place the rules live.
 */
export interface TopicDispositionParse {
  readonly disposition: TopicDisposition | null;
  readonly problems: readonly string[];
}

export function parseTopicDisposition(value: unknown): TopicDispositionParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { disposition: null, problems: [`is ${Array.isArray(value) ? "an array" : JSON.stringify(value)}, not a disposition object`] };
  }
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(DISPOSITION_FIELDS);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  if (typeof row.topicId !== "string" || row.topicId.trim() === "") problems.push(`topicId ${JSON.stringify(row.topicId)} is not a non-empty string`);
  if (typeof row.state !== "string" || !(TOPIC_DISPOSITION_STATES as readonly string[]).includes(row.state)) {
    problems.push(`state ${JSON.stringify(row.state)} is not one of: ${TOPIC_DISPOSITION_STATES.join(", ")}`);
  }
  if (typeof row.reason !== "string") problems.push(`reason ${JSON.stringify(row.reason)} is not a string; it is required and empty when the state does not use it`);
  if (typeof row.lensPolicyId !== "string") problems.push(`lensPolicyId ${JSON.stringify(row.lensPolicyId)} is not a string; it is required and empty when the state does not use it`);
  if (problems.length > 0) return { disposition: null, problems };
  return {
    disposition: {
      topicId: row.topicId as string,
      state: row.state as TopicDispositionState,
      reason: row.reason as string,
      lensPolicyId: row.lensPolicyId as string
    },
    problems: []
  };
}

/**
 * The disposition rows of one proposal, parsed once: ascending by topic id, and indexed.
 *
 * ONE SPELLING, THREE READERS. Plan validation needs the parsed rows to hand to the obligation accounting, and
 * `plan-artifacts.ts` needs the same rows to record and to RE-DERIVE the accounting on read. Two loops over the
 * same untrusted array would be two answers to "which dispositions did this plan actually state", and the recorded
 * artifact would then be checked against a set the validator never saw.
 *
 * A row that fails to parse is simply ABSENT — deliberately. From the obligation's point of view "the plan said
 * something unreadable about my topic" and "the plan said nothing" are one fact, and both are violations one level
 * up; `validateTopicDispositions` is what reports the parse failure itself. A repeated topic id keeps the FIRST
 * row, so the index is a function of the input order rather than of which loop happened to win.
 */
export interface ParsedDispositionIndex {
  /** Ascending by topic id. */
  readonly rows: readonly TopicDisposition[];
  readonly byTopic: ReadonlyMap<string, TopicDisposition>;
}

export function parsedDispositionIndex(value: unknown): ParsedDispositionIndex {
  const byTopic = new Map<string, TopicDisposition>();
  if (Array.isArray(value)) {
    for (const row of value as readonly unknown[]) {
      const parsed = parseTopicDisposition(row);
      if (parsed.disposition === null) continue;
      if (byTopic.has(parsed.disposition.topicId)) continue;
      byTopic.set(parsed.disposition.topicId, parsed.disposition);
    }
  }
  return { rows: [...byTopic.values()].sort((a, b) => a.topicId.localeCompare(b.topicId)), byTopic };
}
