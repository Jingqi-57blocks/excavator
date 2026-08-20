/**
 * Gate 1b's first deterministic reading: where every MATERIAL OBLIGATION goes under a plan.
 *
 * WHY THIS EXISTS AT ALL. The full audit's material grounding check (`section-audit.ts`) uses
 * `item.requiredFor.includes(document.id)` as its denominator, and in the new world `requiredFor` is DERIVED FROM
 * THE PLAN. So a plan that marks one material topic `omitted-for-audience` can take every obligation bound to that
 * topic out of every unit's required set — and the audit then passes over a denominator the plan shrank. Measured
 * on the wcp baseline: 7 material topics carry 847 material obligations, and the two feature topics alone carry
 * 799 of them. One waiving disposition, 799 obligations gone, every downstream gate still green.
 *
 * THE TRIPWIRE, THEREFORE. When every topic an obligation binds to is waived, the obligation is listed BY ID in
 * `waivedObligations`. The list defaults to empty, it is never capped (a cap on a conservation residue is where
 * the next silent loss hides), and it carries the exit state and the topics that waived it, so the reader can see
 * WHICH plan decision removed it. Waiving is legitimate — a plan may omit for an audience — but it is never free
 * and never silent.
 *
 * THE FOUR BUCKETS ARE EXHAUSTIVE AND ORDERED, AND THE ORDER IS THE POINT.
 *   1. `inUnits`         — at least one binding topic is named by some unit. The obligation has somewhere to land.
 *   2. `undispositioned` — no unit names it and some binding topic carries no disposition at all.
 *   3. `unplaced`        — no unit names it, and a binding topic claims a PLACING disposition (primary /
 *                          referenced / collapsed) that no unit honours. The plan says "covered"; nothing writes it.
 *   4. `waived`          — no unit names it, and every binding topic's disposition is a waiving one.
 * Checked in that order because a stronger statement wins: an obligation with somewhere to land is not "waived"
 * just because a second topic waived it, and a missing disposition is a worse problem than a dishonoured one.
 * Buckets 2 and 3 are violations; bucket 4 is a counted exit. The four sum to the denominator — asserted, not
 * hoped: a residue with no bucket would be exactly the unexplained loss this file exists to make impossible.
 *
 * THE DENOMINATOR COMES FROM THE LEDGER, THROUGH THE CATALOG'S OWN BINDINGS. R2 copied each work item's
 * `material` flag and its evidence/trace ids verbatim into the binding it minted, and the catalog's conservation
 * law says every work item is bound by some topic or named in `unassignedWorkItemIds`. So the material obligation
 * set here IS `workitems.json`'s material bucket, reached by reference and never by an id join: 57B-458 measured
 * what a naive id join across two ledgers costs (665 of 946 rows silently unmatched because one id segment
 * differs), and this file performs no join at all. If the catalog leaves any obligation unassigned, that is a
 * named plan violation rather than a bucket — an obligation no topic carries is one no plan can dispose of.
 */

import { assertNever } from "../base/artifact-result.ts";
import { unitTopicIds, type ProposedUnit } from "./plan-proposal.ts";
import type { TopicCandidate } from "./topic-candidate.ts";
import type { TopicCatalogArtifact } from "./topic-catalog.ts";
import { TOPIC_DISPOSITION_STATES, type TopicDisposition, type TopicDispositionState } from "./topic-disposition.ts";

/**
 * What a disposition does to the obligations bound to its topic.
 *
 * `placing` states keep the topic in the document: `primary` owns it, `referenced` points at the owner, and
 * `collapsed` folds it into another unit's prose — in all three the obligation is still meant to be written, so a
 * placing state with no unit to write it is a violation, not an exit. The three `waiving` states take the topic
 * OUT of this document, and it is those three the epic requires to carry an obligation count.
 *
 * Exhaustive with no `default` arm: a seventh disposition state would have to be classified here before this file
 * compiles, because the alternative is a new state that silently reads as placing and stops being counted.
 */
export function dispositionEffect(state: TopicDispositionState): "placing" | "waiving" {
  switch (state) {
    case "primary":
    case "referenced":
    case "collapsed":
      return "placing";
    case "omitted-for-audience":
    case "not-applicable":
    case "cannot-determine":
      return "waiving";
  }
  return assertNever(state, "topic disposition state");
}

/** The waiving states, in `TOPIC_DISPOSITION_STATES` order, so the per-state census has a canonical row order. */
export const WAIVING_DISPOSITION_STATES: readonly TopicDispositionState[] =
  TOPIC_DISPOSITION_STATES.filter((state) => dispositionEffect(state) === "waiving");

/** One obligation that left through a waiving disposition, with the decision that took it out. */
export interface WaivedObligation {
  readonly workItemId: string;
  readonly dimension: string;
  /** The exit state: the first, in state order then topic order, of the waiving states that took it. */
  readonly state: TopicDispositionState;
  /** Every topic this obligation binds to — all of them waived, which is what put it on this list. */
  readonly topicIds: readonly string[];
}

/** One obligation a plan claims to cover but no unit writes, or that no disposition mentions at all. */
export interface UnaccountedObligation {
  readonly workItemId: string;
  readonly dimension: string;
  readonly topicIds: readonly string[];
}

export interface PlanObligationAccounting {
  /** The denominator: distinct material work items reached through the catalog's bindings. */
  readonly materialObligations: number;
  readonly inUnits: number;
  readonly waived: number;
  readonly unplaced: number;
  readonly undispositioned: number;
  /** One row per waiving state, always all of them, so a zero is visible rather than absent. */
  readonly waivedByState: readonly { readonly state: TopicDispositionState; readonly obligations: number }[];
  /** THE TRIPWIRE. Empty by default; ascending by work item id; never capped. */
  readonly waivedObligations: readonly WaivedObligation[];
  readonly unplacedObligations: readonly UnaccountedObligation[];
  readonly undispositionedObligations: readonly UnaccountedObligation[];
  /** Material topics that carry material obligations and are named by no unit — the plan-side view of the same fact. */
  readonly unplacedTopicIds: readonly string[];
}

/**
 * Account for every material obligation under one plan.
 *
 * `dispositions` is the ALREADY PARSED map; a row that failed to parse is simply absent, which lands its topics'
 * obligations in `undispositioned` — the same bucket as a row nobody wrote. That is deliberate: from the
 * obligation's point of view "the plan said something unreadable about my topic" and "the plan said nothing" are
 * one fact, and both are violations.
 */
export function accountPlanObligations(
  catalog: TopicCatalogArtifact,
  units: readonly ProposedUnit[],
  dispositions: ReadonlyMap<string, TopicDisposition>
): PlanObligationAccounting {
  const unitTopics = new Set<string>();
  for (const unit of units) for (const topicId of unitTopicIds(unit)) unitTopics.add(topicId);

  // One pass over the catalog's bindings: which topics carry each material obligation, and its dimension.
  const topicsByObligation = new Map<string, { dimension: string; topicIds: string[] }>();
  for (const topic of catalog.topics) {
    for (const binding of topic.bindings) {
      if (!binding.material) continue;
      const entry = topicsByObligation.get(binding.workItemId);
      if (entry) entry.topicIds.push(topic.topicId);
      else topicsByObligation.set(binding.workItemId, { dimension: binding.dimension, topicIds: [topic.topicId] });
    }
  }

  const inUnits: string[] = [];
  const waivedObligations: WaivedObligation[] = [];
  const unplacedObligations: UnaccountedObligation[] = [];
  const undispositionedObligations: UnaccountedObligation[] = [];
  const unplacedTopicIds = new Set<string>();

  for (const [workItemId, { dimension, topicIds }] of [...topicsByObligation.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sortedTopicIds = [...topicIds].sort((a, b) => a.localeCompare(b));
    if (sortedTopicIds.some((topicId) => unitTopics.has(topicId))) {
      inUnits.push(workItemId);
      continue;
    }
    const missing = sortedTopicIds.filter((topicId) => !dispositions.has(topicId));
    if (missing.length > 0) {
      undispositionedObligations.push({ workItemId, dimension, topicIds: sortedTopicIds });
      for (const topicId of missing) unplacedTopicIds.add(topicId);
      continue;
    }
    const placing = sortedTopicIds.filter((topicId) => dispositionEffect(dispositions.get(topicId)!.state) === "placing");
    if (placing.length > 0) {
      unplacedObligations.push({ workItemId, dimension, topicIds: sortedTopicIds });
      for (const topicId of placing) unplacedTopicIds.add(topicId);
      continue;
    }
    // Every binding topic is waived. The exit state is the first in (state order, topic order) — deterministic,
    // and it is what makes the per-state census sum exactly to the waived count instead of double counting an
    // obligation two topics waived under two different states.
    const exits = sortedTopicIds
      .map((topicId) => ({ topicId, state: dispositions.get(topicId)!.state }))
      .sort((a, b) => TOPIC_DISPOSITION_STATES.indexOf(a.state) - TOPIC_DISPOSITION_STATES.indexOf(b.state) || a.topicId.localeCompare(b.topicId));
    waivedObligations.push({ workItemId, dimension, state: exits[0]!.state, topicIds: sortedTopicIds });
  }

  const accounting: PlanObligationAccounting = {
    materialObligations: topicsByObligation.size,
    inUnits: inUnits.length,
    waived: waivedObligations.length,
    unplaced: unplacedObligations.length,
    undispositioned: undispositionedObligations.length,
    waivedByState: WAIVING_DISPOSITION_STATES.map((state) => ({
      state,
      obligations: waivedObligations.filter((row) => row.state === state).length
    })),
    waivedObligations,
    unplacedObligations,
    undispositionedObligations,
    unplacedTopicIds: [...unplacedTopicIds].sort((a, b) => a.localeCompare(b))
  };

  // The conservation law, asserted rather than documented. Every material obligation is in exactly one of the
  // four buckets; a residue would mean this function grew a fifth, silent state.
  const summed = accounting.inUnits + accounting.waived + accounting.unplaced + accounting.undispositioned;
  if (summed !== accounting.materialObligations) {
    throw new Error(`Plan obligation accounting does not conserve: ${accounting.inUnits} in units + ${accounting.waived} waived + ${accounting.unplaced} unplaced + ${accounting.undispositioned} undispositioned is not ${accounting.materialObligations} material obligation(s)`);
  }
  const byState = accounting.waivedByState.reduce((total, row) => total + row.obligations, 0);
  if (byState !== accounting.waived) {
    throw new Error(`The per-state waiving census counts ${byState} obligation(s) but ${accounting.waived} left through a waiving disposition`);
  }
  return accounting;
}

/**
 * The violations in an accounting, as named problems. A waived obligation is NOT one of them — it left by a
 * counted exit, which is the whole difference between a plan that omits and a plan that loses.
 */
export function obligationAccountingProblems(accounting: PlanObligationAccounting): string[] {
  const problems: string[] = [];
  for (const row of accounting.undispositionedObligations) {
    problems.push(`material obligation ${JSON.stringify(row.workItemId)} (${row.dimension}) is in no unit and its topic(s) ${row.topicIds.join(", ")} carry no readable disposition; the plan neither writes it nor accounts for it`);
  }
  for (const row of accounting.unplacedObligations) {
    problems.push(`material obligation ${JSON.stringify(row.workItemId)} (${row.dimension}) is claimed by a placing disposition on topic(s) ${row.topicIds.join(", ")} but no unit names any of them; the plan says it is covered and nothing writes it`);
  }
  return problems;
}

/** One sentence a reader cannot mistake for a coverage claim about obligations. */
export function summariseObligationAccounting(accounting: PlanObligationAccounting): string {
  const byState = accounting.waivedByState.map((row) => `${row.state}=${row.obligations}`).join(", ");
  return `${accounting.materialObligations} material obligation(s): ${accounting.inUnits} in units, ${accounting.waived} waived (${byState}), ${accounting.unplaced} claimed but unplaced, ${accounting.undispositioned} undispositioned`;
}

/** Material topics that carry at least one material obligation. The bridge between the 1a and 1b denominators. */
export function materialTopicsCarryingObligations(catalog: TopicCatalogArtifact): readonly TopicCandidate[] {
  return catalog.topics.filter((topic) => topic.bindings.some((binding) => binding.material));
}
