/**
 * The deterministic semantic division of an over-budget authoring unit — the epic's "never truncate" clause, as a
 * plan-to-plan refinement.
 *
 * IT HAS EXACTLY TWO EXITS, AND THAT IS THE WHOLE DESIGN. Either the over-budget units are DIVIDED — their
 * obligations redistributed across more units, every id kept — or the refinement FAILS BY NAME, pointing at the
 * unit, its measured bytes and the obligation ids (with their evidence ids) it could not divide further. There is
 * no third exit: nothing here drops a topic, caps a list, clips a record or narrows a scope without another unit
 * picking the remainder up. `obligation-scope.ts` states that as a law the validator enforces — the scopes of one
 * topic's owning units must partition its bindings EXACTLY — so a division that lost a row would be a named
 * violation rather than a plan that quietly fit.
 *
 * THE LADDER, CORRECTED AGAINST THE REAL CATALOG. The epic sketched "topic group, facet, flow/state branch,
 * entity/integration cluster, then buckets by stable topic id". Two of those rungs do not exist here: the catalog
 * has six facets and no flow/state or entity-cluster structure (a flow is a binding DIMENSION, not a topic), and
 * "buckets by topic id" does not terminate — one wcp feature topic renders ~1 MB against a 786,432-byte allowance,
 * so a per-topic bucket is still over. The rungs that do exist, in order:
 *
 *   1. `facet`    — a unit naming topics of more than one facet becomes one unit per facet.
 *   2. `topic`    — a unit naming more than one topic becomes one unit per topic.
 *   3. `dimension` — inside ONE topic, the obligations are grouped along binding-DIMENSION boundaries, each
 *                    dimension kept whole, into as many cost-balanced groups as the overrun requires.
 *   4. `items`    — inside one topic (and, after rung 3, one dimension family), the obligations are packed into
 *                    cost-balanced buckets by ascending work item id.
 *
 * Each rung is tried in order and the first one that yields two or more parts wins; the parts then go back through
 * the whole ladder on the next iteration, so a part still over budget descends further. The floor is ONE obligation:
 * a unit holding a single obligation that still does not fit cannot be divided, and that is the named failure.
 *
 * IT MEASURES THE WHOLE CANDIDATE PLAN EVERY ITERATION, on purpose. A packet's bytes depend on the plan it belongs
 * to — the header prints the plan catalog digest, the parent and child ids, the document's appendix units — so a
 * bucket sized against a provisional plan could be a byte over in the final one. Re-measuring the complete
 * candidate after each round of divisions removes that class of error entirely: the loop exits only when every unit
 * of the plan it is about to return is inside its own bound, measured by the renderer the author will read from.
 * Termination is not a hope either: each iteration strictly increases the unit count, and the unit count is bounded
 * above by one unit per (topic, obligation) pair, so the bound below is arithmetic rather than a magic cap.
 *
 * IT IS DETERMINISTIC. Facets, topics, dimensions and work item ids are all walked in ascending order; the packing
 * is greedy against measured weights with no randomness and no tie-breaking by insertion order; and the part ids
 * are derived from the CONTENT of each part (its facet, topic, first dimension, or the digest of its id list)
 * rather than from a position, so re-running the refinement over the same catalog produces the same bytes.
 */

import { canonicalJson, sha256 } from "../base/util.ts";
import { assertNever } from "../base/artifact-result.ts";
import type { EvidenceItem } from "../base/types.ts";
import { FULL_OBLIGATION_SCOPE, scopeIncludes, type ObligationScope } from "./obligation-scope.ts";
import {
  costBytes,
  measurePlanPackets,
  unitOverBudgetProblem,
  type PlanPacketMeasurement,
  type UnitPacketCostRow,
  type UnitPacketMeasureInputs
} from "./plan-packet-measure.ts";
import { unitChildIds, type PlanProposal, type ProposedTopicUnit, type ProposedUnit, type ProposedUnitTopic } from "./plan-proposal.ts";
import { validatePlan, type PlanValidationInput, type PlanValidationReport } from "./plan-validation.ts";
import type { TopicCandidate, TopicObligationBinding } from "./topic-candidate.ts";

/** The four rungs, in the order they are tried. A fifth would have to be given a position and an id component. */
export const SPLIT_LEVELS = ["facet", "topic", "dimension", "items"] as const;
export type SplitLevel = (typeof SPLIT_LEVELS)[number];

/** The one-character id component each rung contributes. Distinct by construction; asserted in test. */
const LEVEL_COMPONENT: Readonly<Record<SplitLevel, string>> = { facet: "f", topic: "t", dimension: "d", items: "w" };

/** One division that happened, for a reading or a PR table. Never a reason a row went missing. */
export interface PlanUnitDivision {
  readonly unitId: string;
  readonly level: SplitLevel;
  readonly measuredBytes: number;
  readonly byteLimit: number;
  /** The ids of the units that replaced it, ascending. Always two or more. */
  readonly partUnitIds: readonly string[];
}

/**
 * The refinement's two exits.
 *
 * `refined` carries a proposal every unit of which fits its own bound, measured; `indivisible` carries the named
 * problems and NO proposal, so a caller cannot accidentally proceed with a half-divided plan.
 */
export type PlanRefinement =
  | {
      readonly state: "refined";
      readonly proposal: PlanProposal;
      /** Measurement passes taken. 1 means the plan already fitted and nothing was divided. */
      readonly iterations: number;
      readonly divisions: readonly PlanUnitDivision[];
      readonly measurement: PlanPacketMeasurement;
    }
  | { readonly state: "indivisible"; readonly problems: readonly string[] };

/**
 * Refine one proposal until every unit fits its document's per-unit input budget, or fail by name.
 *
 * The measurement of the INCOMING proposal is required rather than re-taken, because the caller has already taken
 * it: `validatePlan` measures as part of concluding, and a second measurement of the same plan would be a second
 * chance for the two to disagree.
 */
export function refinePlanForBudget(
  inputs: UnitPacketMeasureInputs,
  proposal: PlanProposal,
  measurement: PlanPacketMeasurement
): PlanRefinement {
  const topicsById = new Map(inputs.catalog.topics.map((topic) => [topic.topicId, topic]));
  const weights = bindingWeights(inputs.catalog.topics, inputs.evidence);
  const divisions: PlanUnitDivision[] = [];
  let current = proposal;
  let currentMeasurement = measurement;
  // The arithmetic bound: the finest possible plan is one unit per (topic, obligation) pair plus one unit per
  // topic that binds nothing, and every iteration adds at least one unit. A loop that reached this bound would be
  // a bug in the ladder, and it is reported as a named failure rather than spun on forever.
  const maxIterations = 2 + inputs.catalog.topics.reduce((total, topic) => total + Math.max(1, topic.bindings.length), 0);
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const over = currentMeasurement.units.filter((row) => row.overBy > 0);
    if (over.length === 0) {
      return { state: "refined", proposal: current, iterations: iteration, divisions, measurement: currentMeasurement };
    }
    const problems: string[] = [];
    const replacements = new Map<string, readonly ProposedUnit[]>();
    for (const row of over) {
      const unit = current.units.find((entry) => entry.unitId === row.unitId)!;
      if (unit.kind === "synthesis") {
        problems.push(unitOverBudgetProblem(row));
        continue;
      }
      if (!current.units.some((entry) => unitChildIds(entry).includes(unit.unitId))) {
        problems.push(`${unitOverBudgetProblem(row)}. It cannot be divided: no unit of document ${JSON.stringify(unit.documentId)} names it as a child, so it is the document's only root, and dividing a root would leave the document with several. A splitter divides obligations; it does not invent a synthesis to hang the parts off. Re-propose this document with a synthesis over its parts.`);
        continue;
      }
      const division = divideUnit(unit, row, { topicsById, weights });
      if (division === null) {
        problems.push(indivisibleProblem(unit, row, topicsById));
        continue;
      }
      replacements.set(unit.unitId, division.parts);
      divisions.push({
        unitId: unit.unitId,
        level: division.level,
        measuredBytes: costBytes(row.cost),
        byteLimit: row.byteLimit,
        partUnitIds: division.parts.map((part) => part.unitId).sort((a, b) => a.localeCompare(b))
      });
    }
    if (problems.length > 0) return { state: "indivisible", problems };
    current = applyReplacements(current, replacements);
    currentMeasurement = measurePlanPackets(inputs, current);
  }
  return {
    state: "indivisible",
    problems: [`the budget refinement did not converge in ${maxIterations} measurement pass(es), which is one more than the number of (topic, obligation) pairs this catalog holds; every pass divides at least one unit, so reaching this bound means the division ladder stopped reducing and the plan must be re-proposed`]
  };
}

/**
 * What one obligation costs, as a weight for the packing.
 *
 * The obligation's own row plus the canonical bytes of every evidence record it binds — the two things the packet
 * renders for it. A record two obligations share is counted for BOTH, which OVER-estimates a bucket that holds
 * them together; over-estimating is the safe direction (it makes buckets smaller), and the true measurement of the
 * candidate plan is what decides whether a bucket actually fits.
 */
function bindingWeights(
  topics: readonly TopicCandidate[],
  evidence: ReadonlyMap<string, EvidenceItem>
): ReadonlyMap<string, number> {
  const evidenceBytes = new Map<string, number>();
  const bytesOf = (id: string): number => {
    const cached = evidenceBytes.get(id);
    if (cached !== undefined) return cached;
    const item = evidence.get(id);
    const bytes = item === undefined ? 0 : Buffer.byteLength(canonicalJson(item), "utf8");
    evidenceBytes.set(id, bytes);
    return bytes;
  };
  const weights = new Map<string, number>();
  for (const topic of topics) {
    for (const binding of topic.bindings) {
      const key = weightKey(topic.topicId, binding.workItemId);
      let bytes = Buffer.byteLength(canonicalJson(binding), "utf8");
      for (const id of binding.evidenceIds) bytes += bytesOf(id);
      weights.set(key, bytes);
    }
  }
  return weights;
}

function weightKey(topicId: string, workItemId: string): string {
  return `${topicId} ${workItemId}`;
}

interface DivisionContext {
  readonly topicsById: ReadonlyMap<string, TopicCandidate>;
  readonly weights: ReadonlyMap<string, number>;
}

/**
 * Divide one over-budget topic-bearing unit, or return `null` when it holds nothing left to divide.
 *
 * The rungs are tried in `SPLIT_LEVELS` order and the first that yields two or more parts wins. Returning `null` is
 * NOT a quiet failure: the caller turns it into the named problem, with the remaining obligation ids and their
 * evidence ids in it.
 */
function divideUnit(
  unit: ProposedTopicUnit,
  row: UnitPacketCostRow,
  context: DivisionContext
): { readonly level: SplitLevel; readonly parts: readonly ProposedUnit[] } | null {
  for (const level of SPLIT_LEVELS) {
    const parts = divideAt(level, unit, row, context);
    if (parts !== null && parts.length > 1) return { level, parts };
  }
  return null;
}

/** Exhaustive over the four rungs, with no `default`: a fifth must say how it divides before this compiles. */
function divideAt(
  level: SplitLevel,
  unit: ProposedTopicUnit,
  row: UnitPacketCostRow,
  context: DivisionContext
): readonly ProposedUnit[] | null {
  switch (level) {
    case "facet":
      return divideByFacet(unit, context);
    case "topic":
      return divideByTopic(unit, context);
    case "dimension":
      return divideByDimension(unit, row, context);
    case "items":
      return divideByWorkItem(unit, row, context);
  }
  return assertNever(level, "plan unit split level");
}

function divideByFacet(unit: ProposedTopicUnit, context: DivisionContext): readonly ProposedUnit[] | null {
  const byFacet = new Map<string, ProposedUnitTopic[]>();
  for (const reference of unit.topics) {
    const topic = context.topicsById.get(reference.topicId);
    if (!topic) return null;
    const list = byFacet.get(topic.facet);
    if (list) list.push(reference);
    else byFacet.set(topic.facet, [reference]);
  }
  if (byFacet.size < 2) return null;
  return [...byFacet.keys()].sort((a, b) => a.localeCompare(b)).map((facet) =>
    partOf(unit, "facet", facet, `facet ${facet}`, byFacet.get(facet)!));
}

function divideByTopic(unit: ProposedTopicUnit, context: DivisionContext): readonly ProposedUnit[] | null {
  if (unit.topics.length < 2) return null;
  return [...unit.topics]
    .sort((a, b) => a.topicId.localeCompare(b.topicId))
    .map((reference) => {
      const topic = context.topicsById.get(reference.topicId);
      if (!topic) throw new Error(`Unit ${JSON.stringify(unit.unitId)} names topic ${JSON.stringify(reference.topicId)}, which this catalog does not hold; a plan is validated for that before it is divided`);
      return partOf(unit, "topic", topicComponent(reference.topicId), `topic ${reference.topicId}`, [reference]);
    });
}

/**
 * Rung 3: group ONE topic's in-scope obligations along dimension boundaries, keeping each dimension whole.
 *
 * A dimension is the vocabulary the obligation was minted under (`decision-function`, `logic-disposition`, a flow,
 * a lifecycle), which is what makes this rung SEMANTIC rather than arithmetic: a unit that writes one dimension of
 * one feature is a unit with a subject. The group count is the overrun's own arithmetic — the number of buckets the
 * measured bytes need — capped by how many dimensions there are, and a single dimension that is still too large
 * falls through to rung 4 on the next pass.
 */
function divideByDimension(unit: ProposedTopicUnit, row: UnitPacketCostRow, context: DivisionContext): readonly ProposedUnit[] | null {
  const single = singleTopic(unit, context);
  if (single === null) return null;
  const { reference, bindings } = single;
  const byDimension = new Map<string, TopicObligationBinding[]>();
  for (const binding of bindings) {
    const list = byDimension.get(binding.dimension);
    if (list) list.push(binding);
    else byDimension.set(binding.dimension, [binding]);
  }
  if (byDimension.size < 2) return null;
  const dimensions = [...byDimension.keys()].sort((a, b) => a.localeCompare(b));
  const weightOfDimension = dimensions.map((dimension) =>
    byDimension.get(dimension)!.reduce((total, binding) => total + weightOf(context, reference.topicId, binding.workItemId), 0));
  const groups = packByWeight(dimensions, weightOfDimension, bucketCount(row, dimensions.length));
  if (groups.length < 2) return null;
  return groups.map((group) => partOf(
    unit,
    "dimension",
    group[0]!,
    `dimension(s) ${group.join(", ")} of topic ${reference.topicId}`,
    [{ topicId: reference.topicId, obligationScope: explicitScope(group.flatMap((dimension) => byDimension.get(dimension)!.map((binding) => binding.workItemId))) }]
  ));
}

/** Rung 4: the floor above a single obligation — cost-balanced buckets of work item ids, ascending. */
function divideByWorkItem(unit: ProposedTopicUnit, row: UnitPacketCostRow, context: DivisionContext): readonly ProposedUnit[] | null {
  const single = singleTopic(unit, context);
  if (single === null) return null;
  const { reference, bindings } = single;
  if (bindings.length < 2) return null;
  const ids = bindings.map((binding) => binding.workItemId).sort((a, b) => a.localeCompare(b));
  const weights = ids.map((workItemId) => weightOf(context, reference.topicId, workItemId));
  const buckets = packByWeight(ids, weights, bucketCount(row, ids.length));
  if (buckets.length < 2) return null;
  return buckets.map((bucket) => partOf(
    unit,
    "items",
    sha256(canonicalJson(bucket)).slice(0, 12),
    `${bucket.length} obligation(s) of topic ${reference.topicId}`,
    [{ topicId: reference.topicId, obligationScope: explicitScope(bucket) }]
  ));
}

/** The one topic and its in-scope bindings, or `null` when this unit is not down to one topic yet. */
function singleTopic(
  unit: ProposedTopicUnit,
  context: DivisionContext
): { readonly reference: ProposedUnitTopic; readonly bindings: readonly TopicObligationBinding[] } | null {
  if (unit.topics.length !== 1) return null;
  const reference = unit.topics[0]!;
  const topic = context.topicsById.get(reference.topicId);
  if (!topic) return null;
  return { reference, bindings: topic.bindings.filter((binding) => scopeIncludes(reference.obligationScope, binding.workItemId)) };
}

function weightOf(context: DivisionContext, topicId: string, workItemId: string): number {
  return context.weights.get(weightKey(topicId, workItemId)) ?? 0;
}

/**
 * How many parts an overrun needs: the measured bytes divided by the bound, never fewer than two.
 *
 * Two is the floor because a rung that produced one part would not be a division at all. It is deliberately NOT
 * inflated to account for the per-part header: the next measurement pass sees the real bytes and divides again if a
 * part is still over, which is exact where a fudge factor would be a guess.
 */
function bucketCount(row: UnitPacketCostRow, available: number): number {
  const needed = Math.max(2, Math.ceil(costBytes(row.cost) / row.byteLimit));
  return Math.min(needed, available);
}

/**
 * Greedy cost-balanced packing into exactly `parts` non-empty buckets, in the items' own (ascending) order.
 *
 * A bucket closes when it has reached its share of the REMAINING weight, or when the items left exactly match the
 * buckets left — the second condition is what guarantees every bucket is non-empty, so a division never emits a
 * unit scoped to nothing.
 */
export function packByWeight<T>(items: readonly T[], weights: readonly number[], parts: number): readonly T[][] {
  if (items.length !== weights.length) throw new Error(`Cost-balanced packing was given ${items.length} item(s) and ${weights.length} weight(s); one weight per item, always`);
  if (parts < 1) throw new Error(`Cost-balanced packing was asked for ${parts} bucket(s); a division makes at least one`);
  if (items.length < parts) throw new Error(`Cost-balanced packing was asked for ${parts} bucket(s) from ${items.length} item(s); a bucket scoped to nothing is what this refuses to produce`);
  const out: T[][] = [];
  let current: T[] = [];
  let accumulated = 0;
  let remainingWeight = weights.reduce((total, weight) => total + weight, 0);
  let remainingBuckets = parts;
  for (const [index, item] of items.entries()) {
    current.push(item);
    accumulated += weights[index]!;
    const itemsLeft = items.length - index - 1;
    const bucketsLeft = remainingBuckets - 1;
    if (bucketsLeft <= 0) continue;
    if (accumulated >= remainingWeight / remainingBuckets || itemsLeft === bucketsLeft) {
      out.push(current);
      current = [];
      remainingWeight -= accumulated;
      accumulated = 0;
      remainingBuckets -= 1;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** An explicit scope over one bucket of ids: ascending, de-duplicated, non-empty — the parser's own contract. */
function explicitScope(workItemIds: readonly string[]): ObligationScope {
  const ids = [...new Set(workItemIds)].sort((a, b) => a.localeCompare(b));
  if (ids.length === 0) throw new Error("A division produced a scope over no obligation; a unit scoped to nothing has nothing to write, and this is the check that says so instead of emitting one");
  return { kind: "work-items", workItemIds: ids };
}

/** The 16 hex characters of a topic id (`facet:hex16`), for an id component that is short and stable. */
function topicComponent(topicId: string): string {
  const colon = topicId.lastIndexOf(":");
  return colon < 0 ? topicId : topicId.slice(colon + 1);
}

/**
 * One part of a division: the parent's identity with this rung's component set, and the parent's topics narrowed.
 *
 * THE ID IS DERIVED FROM CONTENT AT EVERY RUNG, and a rung REPLACES its own component rather than appending one.
 * That is what keeps a part id stable when it is divided again: a bucket re-divided at the same rung gets a new
 * digest in the same slot instead of a chain that grows past the unit-id length cap. The components are emitted in
 * `SPLIT_LEVELS` order, so one part has one id whatever order the rungs fired in.
 */
function partOf(
  unit: ProposedTopicUnit,
  level: SplitLevel,
  component: string,
  description: string,
  topics: readonly ProposedUnitTopic[]
): ProposedTopicUnit {
  const identity = withComponent(parseUnitIdentity(unit.unitId), level, component);
  return {
    kind: unit.kind,
    unitId: renderUnitId(identity),
    documentId: unit.documentId,
    title: `${baseTitle(unit.title)} — part: ${description}`,
    topics: [...topics].sort((a, b) => a.topicId.localeCompare(b.topicId))
  };
}

/** A unit id, as the division components see it: a root plus at most one component per rung. */
interface UnitIdentity {
  readonly root: string;
  readonly components: ReadonlyMap<SplitLevel, string>;
}

const COMPONENT_PATTERN = /^([a-z])-(.+)$/;

/**
 * Split a unit id into its root and its division components.
 *
 * An id whose `#` segments do not all parse as components is treated as one opaque ROOT — a planner is free to put
 * a `#` in a unit id, and misreading one as a division component would make two different units collide on the id
 * this function rebuilds. Refusing to guess is the safe direction: appending is always correct.
 */
export function parseUnitIdentity(unitId: string): UnitIdentity {
  const segments = unitId.split("#");
  if (segments.length === 1) return { root: unitId, components: new Map() };
  const byLevel = new Map<SplitLevel, string>();
  for (const segment of segments.slice(1)) {
    const match = COMPONENT_PATTERN.exec(segment);
    const level = match === null ? undefined : SPLIT_LEVELS.find((candidate) => LEVEL_COMPONENT[candidate] === match[1]);
    if (level === undefined || byLevel.has(level)) return { root: unitId, components: new Map() };
    byLevel.set(level, match![2]!);
  }
  return { root: segments[0]!, components: byLevel };
}

function withComponent(identity: UnitIdentity, level: SplitLevel, component: string): UnitIdentity {
  const components = new Map(identity.components);
  components.set(level, component);
  return { root: identity.root, components };
}

export function renderUnitId(identity: UnitIdentity): string {
  const suffix = SPLIT_LEVELS
    .filter((level) => identity.components.has(level))
    .map((level) => `#${LEVEL_COMPONENT[level]}-${identity.components.get(level)!}`)
    .join("");
  return `${identity.root}${suffix}`;
}

const TITLE_PART_MARKER = " — part: ";

/** The title without any previous part description, so a re-divided part is described once rather than twice. */
function baseTitle(title: string): string {
  const marker = title.indexOf(TITLE_PART_MARKER);
  return marker < 0 ? title : title.slice(0, marker);
}

/**
 * The named failure for a unit the ladder cannot divide.
 *
 * It names the obligation ids left in scope AND their evidence ids, because that is what a reader needs to see why
 * one obligation is this expensive — on a real corpus the answer is usually a single very large captured record.
 * Nothing is capped and nothing is summarised away.
 */
function indivisibleProblem(
  unit: ProposedTopicUnit,
  row: UnitPacketCostRow,
  topicsById: ReadonlyMap<string, TopicCandidate>
): string {
  const remaining: string[] = [];
  for (const reference of unit.topics) {
    const topic = topicsById.get(reference.topicId);
    if (!topic) continue;
    for (const binding of topic.bindings) {
      if (!scopeIncludes(reference.obligationScope, binding.workItemId)) continue;
      remaining.push(`${binding.workItemId} (${binding.dimension}, evidence: ${binding.evidenceIds.join(" ") || "none"})`);
    }
  }
  const what = remaining.length === 0
    ? `it holds no obligation in scope at all (${unit.topics.length} topic(s)), so there is nothing left to divide`
    : `the only obligation(s) left in its scope are ${remaining.join("; ")}`;
  return `${unitOverBudgetProblem(row)}. THE PLAN FAILS HERE RATHER THAN TRUNCATING: ${what}. A single obligation that does not fit is a real finding — raise the detail budget's per-unit allowance deliberately, or reduce what the run captured for that obligation upstream. Nothing in this pipeline shortens a packet.`;
}

/**
 * Replace divided units with their parts, and re-point the syntheses that named them.
 *
 * The parts inherit the divided unit's place in the graph exactly: every parent that named it now names all of its
 * parts. Nothing else about the plan moves — same documents, same dispositions, same budget echo.
 */
function applyReplacements(proposal: PlanProposal, replacements: ReadonlyMap<string, readonly ProposedUnit[]>): PlanProposal {
  const units: ProposedUnit[] = [];
  for (const unit of proposal.units) {
    const parts = replacements.get(unit.unitId);
    if (parts) {
      units.push(...parts);
      continue;
    }
    if (unit.kind !== "synthesis") {
      units.push(unit);
      continue;
    }
    const children = new Set<string>();
    for (const childUnitId of unit.childUnitIds) {
      const replaced = replacements.get(childUnitId);
      if (replaced) for (const part of replaced) children.add(part.unitId);
      else children.add(childUnitId);
    }
    units.push({ ...unit, childUnitIds: [...children].sort((a, b) => a.localeCompare(b)) });
  }
  const byId = new Set<string>();
  for (const unit of units) {
    if (byId.has(unit.unitId)) {
      throw new Error(`The division produced two units with the id ${JSON.stringify(unit.unitId)}; a part id is derived from its own content, so a collision means two parts hold the same obligations`);
    }
    byId.add(unit.unitId);
  }
  return { ...proposal, units: units.sort((a, b) => a.unitId.localeCompare(b.unitId)) };
}

/** The unsplit scope, for a generator that names a whole topic. Re-exported so no caller spells the arm inline. */
export const WHOLE_TOPIC_SCOPE = FULL_OBLIGATION_SCOPE;

/**
 * The ONE door from a proposal to a recordable plan: validate, divide what does not fit, validate the result.
 *
 * Every producer goes through it — the fixture generator and a model's proposal alike — so "the division happens
 * before validation, on the same inputs, and the divided plan passes the same gate" is a fact about the pipeline
 * rather than a convention each caller remembers. Two exits, and the rejected one carries the FIRST report so the
 * caller can name what was wrong rather than reporting that something was.
 *
 * The division is attempted only when the first validation actually MEASURED the packets and found a unit over its
 * bound. If the measurement could not be taken, the plan has other problems, and dividing a plan whose references
 * or scopes are broken would be rearranging a plan nobody can render.
 */
export type BudgetRefinedPlan =
  | {
      readonly state: "planned";
      readonly proposal: PlanProposal;
      readonly report: PlanValidationReport;
      readonly divisions: readonly PlanUnitDivision[];
      /** Measurement passes the refinement took. 1 means the proposal already fitted. */
      readonly iterations: number;
    }
  | { readonly state: "rejected"; readonly problems: readonly string[]; readonly report: PlanValidationReport };

export function planThroughBudgetRefinement(input: PlanValidationInput): BudgetRefinedPlan {
  const first = validatePlan(input);
  if (first.packets.state !== "measured" || first.packets.measurement.overBudgetUnitIds.length === 0) {
    return first.overall.conclusion === "violations"
      ? { state: "rejected", problems: first.overall.problems, report: first }
      : { state: "planned", proposal: input.proposal, report: first, divisions: [], iterations: 1 };
  }
  const measureInputs: UnitPacketMeasureInputs = {
    catalog: input.catalog,
    requests: input.requests,
    registry: input.registry,
    budgetTable: input.budgetTable,
    evidence: input.evidence,
    reach: input.reach
  };
  const refinement = refinePlanForBudget(measureInputs, input.proposal, first.packets.measurement);
  switch (refinement.state) {
    case "indivisible":
      return { state: "rejected", problems: refinement.problems, report: first };
    case "refined": {
      // The divided plan goes through the SAME validator, not a lighter check: the division changed the unit set,
      // so ownership, the partition law and the per-unit bytes all have to be re-established rather than assumed.
      const report = validatePlan({ ...input, proposal: refinement.proposal });
      if (report.overall.conclusion === "violations") {
        return { state: "rejected", problems: report.overall.problems, report };
      }
      return { state: "planned", proposal: refinement.proposal, report, divisions: refinement.divisions, iterations: refinement.iterations };
    }
  }
  return assertNever(refinement, "plan budget refinement state");
}
