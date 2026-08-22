/**
 * Gate 1b's first deterministic reading: where every MATERIAL OBLIGATION goes under a plan.
 *
 * WHY THIS EXISTS AT ALL. The full audit's material grounding check uses
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
 *
 * IT ALSO OWNS OWNERSHIP (R5a), FOR THE SAME REASON. "Which unit owes this obligation" is the same question as
 * "where does this obligation go", asked one level down, and answering it anywhere else would be a second index
 * over the same bindings — two indexes are two denominators, which is the one thing the epic forbids outright. So
 * the ownership derivation below reads `materialObligationTopics`, the index this file already exports, and the
 * three consumers (plan validation's ownership reading, the unit packet's full/stub split, the per-unit grounding
 * audit) all read the rows it returns. None of them recompute anything.
 */

import { assertNever } from "../base/artifact-result.ts";
import { scopeIncludes, type ScopedTopicReference } from "./obligation-scope.ts";
import { unitTopicIds, unitTopics, type AuthoringUnitKind, type ProposedUnit } from "./plan-proposal.ts";
import type { TopicFacet, TopicObligationBinding } from "./topic-candidate.ts";
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

/**
 * One material obligation, the topics that carry it, and the binding the catalog copied from the ledger.
 *
 * THE INDEX IS THE SHARED DERIVATION, and that is the whole reason it is exported. Gate 1b's plan-side reading
 * (below) and R4b's per-unit grounding audit both need "which topics carry THIS obligation", and two spellings of
 * that question are two denominators — the exact fork the epic forbids. So the one pass over the catalog's
 * bindings lives here, and both callers read the same rows.
 *
 * `binding` is carried whole rather than reduced to a dimension: the audit needs the obligation's status and its
 * own evidence/trace ids, and they are already in the row the catalog copied verbatim. Two topics binding one work
 * item copy the SAME ledger row, so the first-seen binding is not a choice between disagreeing values.
 */
export interface MaterialObligationTopics {
  readonly workItemId: string;
  readonly dimension: string;
  /** Ascending; every topic whose bindings include this obligation. */
  readonly topicIds: readonly string[];
  readonly binding: TopicObligationBinding;
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
 * The one pass over the catalog's bindings: every material obligation, its topics and its binding.
 *
 * Ascending by work item id, topics ascending inside each row, so two callers reading it see one order. It joins
 * NOTHING: an obligation is reached because a binding names it, which is the reference R2 preserved, and 57B-458 is
 * what the alternative costs (a naive id join across two ledgers silently dropped 665 of 946 rows).
 */
export function materialObligationTopics(catalog: TopicCatalogArtifact): readonly MaterialObligationTopics[] {
  const byObligation = new Map<string, { binding: TopicObligationBinding; topicIds: string[] }>();
  for (const topic of catalog.topics) {
    for (const binding of topic.bindings) {
      if (!binding.material) continue;
      const entry = byObligation.get(binding.workItemId);
      if (entry) entry.topicIds.push(topic.topicId);
      else byObligation.set(binding.workItemId, { binding, topicIds: [topic.topicId] });
    }
  }
  return [...byObligation.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([workItemId, entry]) => ({
      workItemId,
      dimension: entry.binding.dimension,
      topicIds: [...entry.topicIds].sort((a, b) => a.localeCompare(b)),
      binding: entry.binding
    }));
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

  const index = materialObligationTopics(catalog);

  const inUnits: string[] = [];
  const waivedObligations: WaivedObligation[] = [];
  const unplacedObligations: UnaccountedObligation[] = [];
  const undispositionedObligations: UnaccountedObligation[] = [];
  const unplacedTopicIds = new Set<string>();

  for (const { workItemId, dimension, topicIds: sortedTopicIds } of index) {
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
    materialObligations: index.length,
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

/**
 * ============================ R5a/R5b: THE OWNER OF ONE MATERIAL OBLIGATION ============================
 *
 * WHAT R4b DELIBERATELY DID NOT CLAIM, AND WHY IT COSTS. The per-unit grounding audit made every unit ground every
 * material obligation reachable through ITS topics, and said in as many words that "disposed of exactly once per
 * document" was a promise it could not keep. Measured on the wcp baseline, that is not a theoretical gap: each of
 * the four documents owes the SAME 847 obligations three times over — 847 through its feature leaf, 847 through
 * its work-item-dimension leaf and 164 through its coverage leaf, 1,858 owed instances against 847 distinct
 * obligations, all 847 of them owed by more than one unit. Every one of those instances renders its evidence in
 * full into a second and third packet, which is why the four packets of one document measured 4,243,714 bytes
 * against a 3,145,728-byte document budget: SPLITTING DOES NOT CHANGE A SUM, ONLY DEDUPLICATION DOES.
 *
 * OWNERSHIP IS OBLIGATION-GRANULAR, NOT TOPIC-GRANULAR. The epic sketched "topic primary ownership", and on this
 * baseline that would change nothing: no topic lands in two units of one document (`fixture-plan.ts` gives each
 * facet its own leaf). The duplication is CROSS-FACET and it is at obligation granularity — one work item binds a
 * feature topic AND a work-item-dimension topic AND a coverage topic, and those three topics live in three
 * different units. So the thing that carries weight is the owner of an OBLIGATION.
 *
 * THE RULE, in full: within one document, an obligation's owner topic is the first — by the pinned facet priority
 * below, then by ascending topic id — of its binding topics that some OWNING unit of that document names AND holds
 * INSIDE THAT UNIT'S OBLIGATION SCOPE; its owner unit is that unit. Ownership is PER DOCUMENT and never across
 * documents: `requiredFor` has always been multi-document, each document answers for itself, and a cross-document
 * owner would mean three of four documents silently stop grounding what they were asked to write.
 *
 * THE SCOPE CLAUSE IS R5b's ONLY CHANGE HERE, AND IT IS WHY DIVISION IS SAFE. A topic too large for one unit is
 * divided across several by obligation scope; each part owns exactly the obligations its scope holds. Two owning
 * units may therefore name ONE topic — which R5a refused outright — and what replaces that refusal is strictly
 * stronger: `obligation-scope.ts` requires the scopes of a topic's owning units to partition its bindings EXACTLY,
 * so a missed id and a doubly-covered id are both named violations rather than at-most-one being checked. When two
 * owning units do hold one obligation (a plan that broke the partition), the owner picked here is the lowest unit
 * id — deterministic, so the reading is stable while the partition violation is what a reader is told to fix.
 *
 * OWNING VS REFERENCING IS DECIDED BY KIND, ONCE. A `leaf` writes a topic dossier and an `appendix` writes the
 * deterministic tail: both OWN what they name. A `bridge` explains a relation between topics another unit owns —
 * it names them to point at them, so it REFERENCES. A `synthesis` names no topic at all by construction, so it is
 * neither, and saying so is not a fourth state but the honest third: `topic-free`. Exhaustive with no `default`,
 * so a fifth kind must declare its role before this file compiles.
 *
 * WHY THE PRIORITY IS PINNED RATHER THAN COMPUTED. A "largest topic wins" or "first unit wins" rule makes the
 * owner a function of the plan's shape, so a planner could move an obligation's owner by reordering units — and
 * the audit's denominator would move with it. A pinned facet order makes the owner a function of the KNOWLEDGE
 * (which facets bind this obligation), which is the only input a plan may not rewrite. Feature first because a
 * feature topic is the subject a reader came for; coverage last because a coverage topic is a statement about the
 * run, not about the obligation.
 */

/**
 * The facet priority that picks an owner topic. Pinned, exported, and checked against `TOPIC_FACETS` in both
 * directions: `satisfies` refuses a member that is not a facet, and `_everyFacetPrioritised` stops compiling if
 * `TOPIC_FACETS` gains one this list omits. `tests/plan-ownership.test.ts` asserts it is a permutation, which is
 * what catches a duplicated member that both type checks accept.
 */
export const OWNERSHIP_FACET_PRIORITY = [
  "feature", "route", "entity", "external-system", "work-item-dimension", "coverage"
] as const satisfies readonly TopicFacet[];

type EveryFacetPrioritised = Exclude<TopicFacet, (typeof OWNERSHIP_FACET_PRIORITY)[number]> extends never ? true : never;
const _everyFacetPrioritised: EveryFacetPrioritised = true;
void _everyFacetPrioritised;

/** What naming a topic means for a unit of this kind. `topic-free` is a synthesis: it names none, by construction. */
export type UnitTopicRole = "owning" | "referencing" | "topic-free";

/**
 * The role of one unit kind. Exhaustive with no `default` arm.
 *
 * The alternative — an optional flag on the proposal — is the remembered-flag failure this codebase has paid for:
 * a fifth kind would default to something, and whichever it defaulted to would be wrong in silence.
 */
export function unitTopicRole(kind: AuthoringUnitKind): UnitTopicRole {
  switch (kind) {
    case "leaf":
    case "appendix":
      return "owning";
    case "bridge":
      return "referencing";
    case "synthesis":
      return "topic-free";
  }
  return assertNever(kind, "authoring unit kind");
}

/** The only thing ownership needs from a unit. Built by the two adapters below, never hand-assembled by a caller. */
export interface OwnershipUnit {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  /** The topic references, each with its required obligation scope. */
  readonly topics: readonly ScopedTopicReference[];
}

/** One material obligation's single owner in one document. */
export interface ObligationOwnership {
  readonly workItemId: string;
  readonly dimension: string;
  readonly documentId: string;
  readonly ownerTopicId: string;
  readonly ownerTopicFacet: TopicFacet;
  readonly ownerUnitId: string;
  /** Every unit of this document that reaches it through one of its topics, ascending. One of them is the owner. */
  readonly reachedByUnitIds: readonly string[];
}

/**
 * One obligation a document reaches and no unit of it owns.
 *
 * Two ways to get here, and both are plan violations rather than buckets: a topic named ONLY by referencing
 * (bridge) units — a bridge points at topics it does not own, so nothing in the document grounds the obligation —
 * or a topic whose owning units all scope the obligation out, which is the partition law's `missing` case seen from
 * the obligation's side. `ownershipProblems` names it; an obligation nobody owes and nobody skips is the silent
 * loss this whole file exists to make impossible.
 */
export interface UnownedObligation {
  readonly workItemId: string;
  readonly dimension: string;
  readonly documentId: string;
  readonly reachedByUnitIds: readonly string[];
}

/** How many obligations one unit of a document owns. Every unit gets a row, so a zero is visible, not absent. */
export interface UnitOwnedCount {
  readonly unitId: string;
  readonly kind: AuthoringUnitKind;
  readonly role: UnitTopicRole;
  readonly owned: number;
}

export interface DocumentObligationOwnership {
  readonly documentId: string;
  /** Material obligations some unit of this document reaches. The denominator ownership answers for. */
  readonly reachedObligations: number;
  /** One row per reached-and-owned obligation, ascending by work item id. */
  readonly obligations: readonly ObligationOwnership[];
  /** The same rows keyed by work item id — the lookup the audit and the packet both do, computed once. */
  readonly ownerByObligation: ReadonlyMap<string, ObligationOwnership>;
  /** One row per unit of this document, ascending. */
  readonly ownedByUnit: readonly UnitOwnedCount[];
  /** Reached and owned by nobody. Never capped. */
  readonly unowned: readonly UnownedObligation[];
}

export interface ObligationOwnershipIndex {
  /** One row per document that has at least one unit, ascending by document id. */
  readonly documents: readonly DocumentObligationOwnership[];
  readonly byDocument: ReadonlyMap<string, DocumentObligationOwnership>;
}

/** A proposal's units, as ownership sees them. */
export function ownershipUnitsOfProposal(units: readonly ProposedUnit[]): readonly OwnershipUnit[] {
  return units.map((unit) => ({ unitId: unit.unitId, documentId: unit.documentId, kind: unit.kind, topics: unitTopics(unit) }));
}

/**
 * Derive ownership for every document of one plan, from the catalog's own bindings.
 *
 * The obligation index is taken from `materialObligationTopics` HERE rather than accepted as a parameter, so there
 * is no call site that can pass a different set: the derivation and the denominator are the same pass over the same
 * catalog, by construction rather than by agreement.
 *
 * A topic id the catalog does not hold is SKIPPED rather than fatal, because plan validation already names it as a
 * reference problem and returns its problems as data — throwing here would replace a list of named problems with a
 * crash on the first one.
 */
export function deriveObligationOwnership(
  catalog: TopicCatalogArtifact,
  units: readonly OwnershipUnit[]
): ObligationOwnershipIndex {
  const facetOf = new Map(catalog.topics.map((topic) => [topic.topicId, topic.facet]));
  const index = materialObligationTopics(catalog);
  const ascending = (a: string, b: string): number => a.localeCompare(b);
  const documents: DocumentObligationOwnership[] = [];

  for (const documentId of [...new Set(units.map((unit) => unit.documentId))].sort(ascending)) {
    const documentUnits = units.filter((unit) => unit.documentId === documentId).sort((a, b) => ascending(a.unitId, b.unitId));
    // Reach is scope-INDEPENDENT: a unit reaches an obligation because it names a topic that binds it, which is the
    // same set the grounding audit calls `reachable`. Scope decides who OWNS it, not who can see it — a scoped unit
    // still renders every obligation of its topics, as a full row or as a stub naming the carrier.
    const reachedBy = new Map<string, string[]>();
    const owningScopes = new Map<string, { readonly unitId: string; readonly scope: ScopedTopicReference }[]>();
    for (const unit of documentUnits) {
      const owning = unitTopicRole(unit.kind) === "owning";
      for (const reference of unit.topics) {
        if (!facetOf.has(reference.topicId)) continue;
        push(reachedBy, reference.topicId, unit.unitId);
        if (!owning) continue;
        const list = owningScopes.get(reference.topicId);
        if (list) list.push({ unitId: unit.unitId, scope: reference });
        else owningScopes.set(reference.topicId, [{ unitId: unit.unitId, scope: reference }]);
      }
    }

    const obligations: ObligationOwnership[] = [];
    const unowned: UnownedObligation[] = [];
    const ownedCount = new Map<string, number>();
    let reachedObligations = 0;
    for (const row of index) {
      const reaching = new Set<string>();
      for (const topicId of row.topicIds) for (const unitId of reachedBy.get(topicId) ?? []) reaching.add(unitId);
      if (reaching.size === 0) continue;
      reachedObligations += 1;
      const reachedByUnitIds = [...reaching].sort(ascending);
      // WHO HOLDS THIS OBLIGATION, per topic, in ONE pass. A topic an owning unit names but scopes OUT does not
      // qualify: the part whose scope holds it is the one that renders it, and if no part does then nothing in this
      // document renders it and it is named as unowned rather than pinned on a unit that would skip it. The single
      // pass matters — deciding the owner topic and the owner unit with two separate scope filters is how the two
      // drift, and a drift here is an obligation stubbed by its holder and skipped by its owner.
      const holders = new Map<string, readonly string[]>();
      for (const topicId of row.topicIds) {
        const holding = (owningScopes.get(topicId) ?? [])
          .filter((entry) => scopeIncludes(entry.scope.obligationScope, row.workItemId))
          .map((entry) => entry.unitId)
          .sort(ascending);
        if (holding.length > 0) holders.set(topicId, holding);
      }
      if (holders.size === 0) {
        unowned.push({ workItemId: row.workItemId, dimension: row.dimension, documentId, reachedByUnitIds });
        continue;
      }
      const ownerTopicId = [...holders.keys()].sort((a, b) => facetPriorityOf(facetOf, a) - facetPriorityOf(facetOf, b) || ascending(a, b))[0]!;
      const ownerUnitId = holders.get(ownerTopicId)![0]!;
      obligations.push({
        workItemId: row.workItemId,
        dimension: row.dimension,
        documentId,
        ownerTopicId,
        ownerTopicFacet: facetOf.get(ownerTopicId)!,
        ownerUnitId,
        reachedByUnitIds
      });
      ownedCount.set(ownerUnitId, (ownedCount.get(ownerUnitId) ?? 0) + 1);
    }

    const row: DocumentObligationOwnership = {
      documentId,
      reachedObligations,
      obligations,
      ownerByObligation: new Map(obligations.map((entry) => [entry.workItemId, entry])),
      ownedByUnit: documentUnits.map((unit) => ({
        unitId: unit.unitId,
        kind: unit.kind,
        role: unitTopicRole(unit.kind),
        owned: ownedCount.get(unit.unitId) ?? 0
      })),
      unowned
    };
    // The per-document conservation law, asserted rather than documented: every reached obligation is owned by
    // exactly one unit or listed as owned by none, and the per-unit counts add up to the owned set. A residue here
    // would be an obligation this derivation looked at and then forgot, which is the whole failure mode.
    const owned = row.ownedByUnit.reduce((total, entry) => total + entry.owned, 0);
    if (owned !== row.obligations.length || owned + row.unowned.length !== reachedObligations) {
      throw new Error(`Ownership of document ${JSON.stringify(documentId)} does not conserve: ${owned} obligation(s) owned across its units + ${row.unowned.length} owned by none is not the ${reachedObligations} material obligation(s) its units reach (${row.obligations.length} owner row(s))`);
    }
    documents.push(row);
  }

  return { documents, byDocument: new Map(documents.map((entry) => [entry.documentId, entry])) };
}

function push(into: Map<string, string[]>, key: string, value: string): void {
  const list = into.get(key);
  if (list) list.push(value);
  else into.set(key, [value]);
}

/** The pinned rank of a topic's facet. A topic with no facet cannot be reached: `facetOf` gated every insertion. */
function facetPriorityOf(facetOf: ReadonlyMap<string, TopicFacet>, topicId: string): number {
  const facet = facetOf.get(topicId);
  if (facet === undefined) throw new Error(`Topic ${JSON.stringify(topicId)} was offered as an owner without a facet; ownership ranks owners by facet, so a topic outside the catalog cannot be one`);
  const rank = OWNERSHIP_FACET_PRIORITY.indexOf(facet);
  if (rank < 0) throw new Error(`Facet ${JSON.stringify(facet)} has no rank in OWNERSHIP_FACET_PRIORITY; every facet must be ranked before it can carry an owner topic`);
  return rank;
}

/**
 * The ownership row for one document, or a named refusal.
 *
 * Required rather than optional, and refused rather than defaulted, because the empty ownership of a document that
 * has none would read as "this unit owns nothing" — every obligation silently owed by nobody.
 */
export function documentOwnership(index: ObligationOwnershipIndex, documentId: string): DocumentObligationOwnership {
  const row = index.byDocument.get(documentId);
  if (!row) {
    throw new Error(`This plan's ownership derivation has no row for document ${JSON.stringify(documentId)}; it holds ${index.documents.length} document(s): ${index.documents.map((entry) => entry.documentId).join(", ") || "none"}`);
  }
  return row;
}

/**
 * The ownership violations of one plan, as named problems.
 *
 * One of them, and it is not a state: an obligation a document reaches and no unit of it owns. The other R5a
 * violation — two owning units naming one topic — is now the stronger partition law in `obligation-scope.ts`, which
 * plan validation reports beside these: "at most one owner per topic" could not express a legal division, while
 * "the owning units' scopes partition the topic exactly" catches both a double cover and a missed id.
 */
export function ownershipProblems(index: ObligationOwnershipIndex): string[] {
  const problems: string[] = [];
  for (const document of index.documents) {
    for (const row of document.unowned) {
      problems.push(`material obligation ${JSON.stringify(row.workItemId)} (${row.dimension}) of document ${JSON.stringify(row.documentId)} is reached by unit(s) ${row.reachedByUnitIds.join(", ")} and owned by none of them; either every unit reaching it only REFERENCES its topics (a bridge explains a relation and grounds nothing) or every owning unit scopes it out, and in both cases no unit of this document grounds this obligation`);
    }
  }
  return problems;
}

/** One sentence per document a reader cannot mistake for a coverage claim. */
export function summariseObligationOwnership(document: DocumentObligationOwnership): string {
  const perUnit = document.ownedByUnit.map((row) => `${row.unitId}=${row.owned}`).join(", ") || "(no unit)";
  return `document ${document.documentId}: ${document.reachedObligations} material obligation(s) reachable, ${document.obligations.length} with an owner, ${document.unowned.length} owned by none; owned per unit: ${perUnit}`;
}
