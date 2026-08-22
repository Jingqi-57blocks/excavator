/**
 * Gate 1b, per authoring unit: every MATERIAL OBLIGATION this unit OWNS must be grounded by THIS unit's own
 * claims — evaluated when the unit is completed, not when the document is.
 *
 * WHY IT RUNS AT UNIT COMPLETION. `audit --document` skips the grounding loop for a document it is told is
 * incomplete, so on the section path a mis-grounded claim was invisible until the last section
 * lands. 57B-453 measured what that window costs on a real run: the author's only inferable rule ("the window whose
 * line range covers the function") was wrong for 5 of 18 obligations, and 2 of those could not be grounded from the
 * packet at all — all of it hidden behind "work-item coverage was not evaluated". A unit is a completion boundary,
 * so this audit has a denominator the moment a unit is written, and there is no interval where an error is unseeable.
 *
 * WHAT CHANGED IN R5a, AND WHAT DID NOT. R4b made every unit ground every obligation REACHABLE through its topics,
 * and said in as many words that "exactly once per document" was a promise it could not keep. It costs: on the wcp
 * baseline each document owed the same 847 obligations 1,858 times over (847 through its feature leaf, 847 through
 * its work-item-dimension leaf, 164 through its coverage leaf). This slice narrows OWED from "reachable" to
 * "reachable AND owned by this unit" (`plan-obligation-conservation.ts` derives the owner). What it does NOT change
 * is `GROUNDING_RULES`: what one determination needs from a claim is byte for byte the section path's rule, before
 * and after. This slice moves WHO OWES, never WHAT IS OWED. Nor does it read `detailBudget`: the epic already ruled
 * that a detail budget may not carry materiality or reachability semantics, so density is not this audit's business.
 *
 * THE RULES ARE THE SECTION PATH'S, PORTED WITHOUT A CHANGE OF STRENGTH. A linked claim must exist; a `found`
 * obligation needs a linked claim reusing one of ITS evidence or trace ids; `searched-not-found` needs a linked
 * `verified` claim reusing its search receipt; `cannot-determine` / `not-applicable` need a linked `unavailable` or
 * `verified` claim. `pending` and `in_progress` get the linked-claim rule and nothing more, exactly as the section
 * path gives them — adding a rule here would be tightening a gate under cover of moving it.
 *
 * FOUR BUCKETS OVER THE REACHABLE SET, AND THE ORDER IS THE POINT.
 *   1. `ownedElsewhere` — reachable, and its single owner is another unit of this document. Counted and NAMED with
 *      that owner, never silently dropped: "not mine" is a statement about the plan, and the reader has to be able
 *      to follow it to the unit that does owe it.
 *   2. `openOriginExempt` — this unit owns it and its ledger row carries `origin: "open"` (see below).
 *   3. `grounded` / 4. `ungrounded` — this unit owns it and owes it.
 * Ownership is checked FIRST because it is the stronger statement: a unit that does not own an obligation owes
 * nothing about it whatever its origin, and putting origin first would make one document report the same exemption
 * three times.
 *
 * THE OPEN-ORIGIN BUCKET IS THE FORK R4b CLOSED. The full audit's denominator excludes `origin === "open"` work
 * items; the catalog's bindings do not carry `origin` at all, and the plan accounting counts every material
 * binding. So a hand-added open work item marked material makes those two denominators disagree in silence — and
 * `mergeWorkItems` accepts exactly that row. The fix is an EQUALITY LOOKUP IN THE SAME LEDGER: the binding's
 * `workItemId` is a verbatim copy of `workitems.json`'s own `id`, so `Map.get` either finds that row or the run is
 * broken and says so by name. It is NOT the cross-ledger id join 57B-458 measured (665 of 946 rows silently
 * unmatched because one id SEGMENT differed) — nothing here transforms an id, and a miss is fatal rather than a
 * quiet zero. Open-origin material obligations land in a named, counted bucket: exempt from the grounding
 * requirement, never silently dropped from the reading. 57B-463 is the open gap this consumption stands on:
 * `material` and `origin` are in no frozen digest, so both fields are editable after sealing; that is knowledge-side
 * and stays that issue's, and this audit reads them exactly as R4b did.
 *
 * THREE STATES, NO BOOLEAN. `complete` (a non-empty set of OWED obligations, all of them grounded), `vacuous` (an
 * empty owed set — nothing reachable, everything reachable owned elsewhere, or everything owned here exempt —
 * carrying WHERE the emptiness comes from) and `violations`. A synthesis names no topic and an appendix may name
 * only non-material ones, so `vacuous` is a normal outcome for them — and it must never render with the same words
 * as `complete`, which is the whole reason it is a separate state instead of "grounded 0 of 0". The three vacuous
 * sources are three different sentences for the same reason.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { InvestigationWorkItem, SectionClaim, WorkItemStatus } from "../base/types.ts";
import type { PlanCatalogUnit } from "./plan-artifacts.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import type { DocumentObligationOwnership, MaterialObligationTopics, ObligationOwnership } from "./plan-obligation-conservation.ts";
import { WORK_ITEM_STATUSES, type TopicObligationBinding } from "./topic-candidate.ts";

export const UNIT_GROUNDING_VERSION = "unit-grounding-v2";

/** One obligation this unit grounded, with the claims that did it. */
export interface GroundedObligation {
  readonly workItemId: string;
  readonly dimension: string;
  readonly status: WorkItemStatus;
  /** Ascending claim ids of the linked claims that satisfied the rule for this status. */
  readonly claimIds: readonly string[];
}

/** One obligation this unit could not ground, and the named reason. */
export interface UngroundedObligation {
  readonly workItemId: string;
  readonly dimension: string;
  readonly status: WorkItemStatus;
  readonly problem: string;
}

/**
 * One material obligation whose ledger row carries `origin: "open"`.
 *
 * Exempt from the grounding requirement because the full audit's denominator has always excluded it, and COUNTED
 * because the plan accounting has always included it. Being in this list is the only way those two facts can both
 * be true without one of them being silent.
 */
export interface OpenOriginObligation {
  readonly workItemId: string;
  readonly dimension: string;
  readonly status: WorkItemStatus;
}

/**
 * One material obligation this unit can reach and another unit of the same document owns.
 *
 * The owner is carried BY ID, not counted: "846 obligations are somebody else's" is unactionable, and the reader of
 * a vacuous verdict has to be able to go to the unit that does owe it. This is also the row the unit packet renders
 * as a stub, so the author sees the same fact the audit sees.
 */
export interface OwnedElsewhereObligation {
  readonly workItemId: string;
  readonly dimension: string;
  readonly status: WorkItemStatus;
  readonly ownerUnitId: string;
  readonly ownerTopicId: string;
}

/**
 * `denominator` is the GROUNDING denominator: reachable material obligations MINUS the ones owned elsewhere MINUS
 * the open-origin exempt ones. A `complete` arm whose denominator counted exemptions would print "grounds all N"
 * over obligations it never grounded, which is the kind of true-sounding sentence this codebase keeps paying for.
 */
export type UnitGroundingVerdict =
  | { readonly conclusion: "complete"; readonly denominator: number; readonly grounded: number; readonly openOriginExempt: number; readonly ownedElsewhere: number }
  | { readonly conclusion: "vacuous"; readonly denominator: 0; readonly openOriginExempt: number; readonly ownedElsewhere: number; readonly source: string }
  | {
      readonly conclusion: "violations";
      readonly denominator: number;
      readonly grounded: number;
      readonly openOriginExempt: number;
      readonly ownedElsewhere: number;
      readonly problems: readonly string[];
      /** The obligations that failed, by id, ascending — what a re-draft has to address. */
      readonly obligationIds: readonly string[];
    };

export interface UnitGroundingResult {
  readonly version: typeof UNIT_GROUNDING_VERSION;
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  /** Every material obligation reachable through this unit's topics, ascending. */
  readonly reachable: readonly string[];
  /** `reachable` minus the two exemptions, by id and ascending: what this unit's claims must ground. */
  readonly owed: readonly string[];
  readonly groundingDenominator: number;
  readonly grounded: readonly GroundedObligation[];
  readonly openOriginExempt: readonly OpenOriginObligation[];
  readonly ownedElsewhere: readonly OwnedElsewhereObligation[];
  readonly ungrounded: readonly UngroundedObligation[];
  readonly verdict: UnitGroundingVerdict;
}

export interface UnitGroundingInput {
  readonly unit: PlanCatalogUnit;
  /** The shared index — the same rows gate 1b's plan accounting reads. Never a second derivation. */
  readonly obligations: readonly MaterialObligationTopics[];
  /**
   * R5a's ownership for THIS unit's document, from the same file that derives the index above.
   *
   * Required, and checked against the unit's own `documentId`: ownership is per document, so auditing a unit
   * against another document's ownership is not a weaker check but a different one. There is no default — an empty
   * ownership row would read as "this unit owns nothing", which is every obligation owed by nobody.
   */
  readonly ownership: DocumentObligationOwnership;
  /** This run's own obligation ledger, keyed by the ids the bindings copied. Same ledger, equality lookup. */
  readonly workItems: ReadonlyMap<string, InvestigationWorkItem>;
  /** The unit's claims sidecar, as written. */
  readonly claims: readonly SectionClaim[];
}

/** Audit one unit. Pure: no path, no clock, no I/O — the caller hands over the values it read. */
export function auditUnitGrounding(input: UnitGroundingInput): UnitGroundingResult {
  const { unit, claims } = input;
  assertOwnershipIsThisDocument(unit, input.ownership);
  const unitTopicIds = new Set(unit.topics.map((topic) => topic.topicId));
  const reach = input.obligations.filter((row) => row.topicIds.some((topicId) => unitTopicIds.has(topicId)));

  const grounded: GroundedObligation[] = [];
  const openOriginExempt: OpenOriginObligation[] = [];
  const ownedElsewhere: OwnedElsewhereObligation[] = [];
  const ungrounded: UngroundedObligation[] = [];

  for (const row of reach) {
    const ledgerRow = requireLedgerRow(row, input.workItems, unit.unitId);
    const { binding } = row;
    const owner = requireOwner(input.ownership, row, unit);
    if (owner.ownerUnitId !== unit.unitId) {
      ownedElsewhere.push({
        workItemId: row.workItemId,
        dimension: row.dimension,
        status: binding.status,
        ownerUnitId: owner.ownerUnitId,
        ownerTopicId: owner.ownerTopicId
      });
      continue;
    }
    if (ledgerRow.origin === "open") {
      openOriginExempt.push({ workItemId: row.workItemId, dimension: row.dimension, status: binding.status });
      continue;
    }
    const linked = claims.filter((claim) => (claim.workItemIds ?? []).includes(row.workItemId));
    if (linked.length === 0) {
      ungrounded.push({
        workItemId: row.workItemId,
        dimension: row.dimension,
        status: binding.status,
        problem: `material obligation ${JSON.stringify(row.workItemId)} (${row.dimension}) is represented by no claim of unit ${JSON.stringify(unit.unitId)}, which owns it`
      });
      continue;
    }
    const satisfying = claimsSatisfying(binding, linked);
    if (satisfying.length === 0) {
      ungrounded.push({
        workItemId: row.workItemId,
        dimension: row.dimension,
        status: binding.status,
        problem: `material obligation ${JSON.stringify(row.workItemId)} (${row.dimension}, ${binding.status}) has no ${groundingRequirementClause(binding.status)} in unit ${JSON.stringify(unit.unitId)}, which owns it`
      });
      continue;
    }
    grounded.push({
      workItemId: row.workItemId,
      dimension: row.dimension,
      status: binding.status,
      claimIds: satisfying.map((claim) => claim.id).sort((a, b) => a.localeCompare(b))
    });
  }

  const reachable = reach.map((row) => row.workItemId);
  const owed = [...grounded.map((row) => row.workItemId), ...ungrounded.map((row) => row.workItemId)].sort((a, b) => a.localeCompare(b));
  const result: UnitGroundingResult = {
    version: UNIT_GROUNDING_VERSION,
    unitId: unit.unitId,
    documentId: unit.documentId,
    kind: unit.kind,
    reachable,
    owed,
    groundingDenominator: owed.length,
    grounded,
    openOriginExempt,
    ownedElsewhere,
    ungrounded,
    verdict: verdictOf(unit, owed.length, grounded.length, openOriginExempt.length, ownedElsewhere, ungrounded)
  };
  // The unit-level conservation law, asserted rather than trusted: every reachable obligation is in exactly one of
  // the four buckets. A residue would be an obligation this audit looked at and then forgot about.
  const summed = grounded.length + openOriginExempt.length + ownedElsewhere.length + ungrounded.length;
  if (summed !== reachable.length) {
    throw new Error(`Unit ${JSON.stringify(unit.unitId)} grounding audit does not conserve: ${grounded.length} grounded + ${openOriginExempt.length} open-origin + ${ownedElsewhere.length} owned elsewhere + ${ungrounded.length} ungrounded is not ${reachable.length} reachable material obligation(s)`);
  }
  return result;
}

/** Ownership is per document. Auditing a unit against another document's row is a bug in the caller, and named. */
function assertOwnershipIsThisDocument(unit: PlanCatalogUnit, ownership: DocumentObligationOwnership): void {
  if (ownership.documentId !== unit.documentId) {
    throw new Error(`Unit ${JSON.stringify(unit.unitId)} is written into document ${JSON.stringify(unit.documentId)} but was audited against the ownership of document ${JSON.stringify(ownership.documentId)}; ownership is derived per document, so these are two different denominators`);
  }
}

/**
 * The owner of one reachable obligation, or a named failure.
 *
 * Fatal on a miss rather than defaulted to "mine" or "somebody else's", and both defaults would be wrong in a
 * different direction: "mine" makes an unowned obligation owed by every unit that can see it, "somebody else's"
 * makes it owed by none. A reachable obligation with no owner row is a plan that never validated (validation names
 * it, and `buildPlanArtifacts` refuses to record it), so reaching this throw means an unvalidated plan got here.
 */
function requireOwner(
  ownership: DocumentObligationOwnership,
  row: MaterialObligationTopics,
  unit: PlanCatalogUnit
): ObligationOwnership {
  const owner = ownership.ownerByObligation.get(row.workItemId);
  if (!owner) {
    throw new Error(`Unit ${JSON.stringify(unit.unitId)} reaches material obligation ${JSON.stringify(row.workItemId)} (${row.dimension}), which no unit of document ${JSON.stringify(unit.documentId)} owns; an obligation nobody owes and nobody skips is the silent loss this audit exists to prevent`);
  }
  return owner;
}

/**
 * The ledger row for one obligation, or a named failure.
 *
 * Equality on the id the binding copied, in the ledger the catalog was built from. A miss means the catalog and the
 * ledger disagree about which work items exist, and the agreement check below means they cannot disagree about what
 * one work item SAYS either — which is what makes "the audit reads the ledger's own origin" a fact rather than a
 * hope. Both are fatal, and both run on every REACHABLE obligation rather than only the owned ones: a catalog that
 * disagrees with its ledger is broken whoever ends up owing the row.
 */
function requireLedgerRow(
  row: MaterialObligationTopics,
  workItems: ReadonlyMap<string, InvestigationWorkItem>,
  unitId: string
): InvestigationWorkItem {
  const ledgerRow = workItems.get(row.workItemId);
  if (!ledgerRow) {
    throw new Error(`Unit ${JSON.stringify(unitId)} reaches material obligation ${JSON.stringify(row.workItemId)}, which this run's workitems.json does not hold; the topic catalog and the obligation ledger disagree about which work items exist`);
  }
  const disagreements = bindingDisagreements(row.binding, ledgerRow);
  if (disagreements.length > 0) {
    throw new Error(`Material obligation ${JSON.stringify(row.workItemId)} is recorded differently by the topic catalog and by workitems.json: ${disagreements.join("; ")}`);
  }
  return ledgerRow;
}

/** Where a binding and its own ledger row disagree, as data. Empty on a run whose catalog projects its ledger. */
export function bindingDisagreements(binding: TopicObligationBinding, ledgerRow: InvestigationWorkItem): string[] {
  const problems: string[] = [];
  if (binding.status !== ledgerRow.status) problems.push(`the binding records status ${JSON.stringify(binding.status)}, the ledger ${JSON.stringify(ledgerRow.status)}`);
  if (binding.material !== ledgerRow.material) problems.push(`the binding records material=${binding.material}, the ledger material=${ledgerRow.material}`);
  if (binding.dimension !== ledgerRow.dimension) problems.push(`the binding records dimension ${JSON.stringify(binding.dimension)}, the ledger ${JSON.stringify(ledgerRow.dimension)}`);
  for (const [field, bound, recorded] of [["evidenceIds", binding.evidenceIds, ledgerRow.evidenceIds], ["traceIds", binding.traceIds, ledgerRow.traceIds]] as const) {
    if (bound.length !== recorded.length || bound.some((id, index) => id !== recorded[index])) {
      problems.push(`the binding records ${field} [${bound.join(", ")}], the ledger [${recorded.join(", ")}]`);
    }
  }
  return problems;
}

/**
 * The linked claims that satisfy this obligation's status rule.
 *
 * Exhaustive over `WorkItemStatus` with no `default` arm, so a new status has to be classified before this file
 * compiles rather than silently reading as grounded. `pending` and `in_progress` carry no rule beyond the linked
 * claim the caller already checked — the section path gives them none, and this port adds none.
 */
function claimsSatisfying(binding: TopicObligationBinding, linked: readonly SectionClaim[]): readonly SectionClaim[] {
  switch (binding.status) {
    case "found":
      return linked.filter((claim) =>
        (claim.evidenceIds ?? []).some((id) => binding.evidenceIds.includes(id))
        || (claim.traceIds ?? []).some((id) => binding.traceIds.includes(id)));
    case "searched-not-found":
      return linked.filter((claim) => claim.marker === "verified" && (claim.evidenceIds ?? []).some((id) => binding.evidenceIds.includes(id)));
    case "cannot-determine":
    case "not-applicable":
      return linked.filter((claim) => claim.marker === "unavailable" || claim.marker === "verified");
    case "pending":
    case "in_progress":
      return linked;
  }
  return assertNever(binding.status, "work item status");
}

/**
 * WHAT ONE STATUS NEEDS FROM A CLAIM, as one string used in two places: the violation this audit reports, and the
 * rule the unit packet prints for the author BEFORE they write. Two spellings of a rule are two rules, and the one
 * the author reads would be the one nobody enforces — which is the 57B-453 failure mode exactly (the author
 * inferred a rule from line ranges because nothing stated the real one).
 *
 * Exhaustive with no `default` arm. R5a changes WHO owes an obligation and not one word of what is owed, so every
 * clause below is byte for byte the one R4b ported from the section path.
 */
export function groundingRequirementClause(status: WorkItemStatus): string {
  switch (status) {
    case "found":
      return "linked claim that reuses one of ITS OWN evidence ids or one of ITS OWN trace ids";
    case "searched-not-found":
      return "linked claim marked `verified` that reuses one of its own evidence ids (its search receipt)";
    case "cannot-determine":
    case "not-applicable":
      return "linked claim marked `unavailable` or `verified`";
    case "pending":
    case "in_progress":
      return "linked claim";
  }
  return assertNever(status, "work item status");
}

/** The rule table, one row per status, in the pinned status order. Rendered verbatim by the unit packet. */
export const GROUNDING_RULES: readonly { readonly status: WorkItemStatus; readonly requires: string }[] =
  WORK_ITEM_STATUSES.map((status) => ({ status, requires: groundingRequirementClause(status) }));

/**
 * The three-state verdict.
 *
 * `vacuous` carries WHERE its empty denominator came from, and the three sources are three sentences: nothing
 * reachable at all (chosen by unit kind), everything reachable owned by another unit, and everything owned here
 * exempt for open origin. Merging them would print one reason over three different plans.
 */
function verdictOf(
  unit: PlanCatalogUnit,
  denominator: number,
  grounded: number,
  openOriginExempt: number,
  ownedElsewhere: readonly OwnedElsewhereObligation[],
  ungrounded: readonly UngroundedObligation[]
): UnitGroundingVerdict {
  if (ungrounded.length > 0) {
    return {
      conclusion: "violations",
      denominator,
      grounded,
      openOriginExempt,
      ownedElsewhere: ownedElsewhere.length,
      problems: ungrounded.map((row) => row.problem),
      obligationIds: ungrounded.map((row) => row.workItemId).sort((a, b) => a.localeCompare(b))
    };
  }
  if (denominator === 0) {
    return {
      conclusion: "vacuous",
      denominator: 0,
      openOriginExempt,
      ownedElsewhere: ownedElsewhere.length,
      source: vacuousSource(unit, grounded + openOriginExempt + ownedElsewhere.length, ownedElsewhere, openOriginExempt)
    };
  }
  return { conclusion: "complete", denominator, grounded, openOriginExempt, ownedElsewhere: ownedElsewhere.length };
}

function vacuousSource(
  unit: PlanCatalogUnit,
  reachable: number,
  ownedElsewhere: readonly OwnedElsewhereObligation[],
  openOriginExempt: number
): string {
  if (reachable === 0) return unreachableSource(unit);
  const owners = [...new Set(ownedElsewhere.map((row) => row.ownerUnitId))].sort((a, b) => a.localeCompare(b)).join(", ");
  if (ownedElsewhere.length === 0) {
    return `unit ${JSON.stringify(unit.unitId)} reaches ${openOriginExempt} material obligation(s) and every one of them carries origin "open" in this run's obligation ledger, which the grounding denominator has always excluded`;
  }
  if (openOriginExempt === 0) {
    return `unit ${JSON.stringify(unit.unitId)} reaches ${reachable} material obligation(s) and OWNS none of them: each one's single owner in document ${JSON.stringify(unit.documentId)} is another unit (${owners}), which is where it is grounded and where its evidence is rendered in full`;
  }
  return `unit ${JSON.stringify(unit.unitId)} reaches ${reachable} material obligation(s) and owes none: ${ownedElsewhere.length} are owned by another unit of document ${JSON.stringify(unit.documentId)} (${owners}) and ${openOriginExempt} carry origin "open" in this run's obligation ledger, which the grounding denominator has always excluded`;
}

/**
 * Why a unit reaches nothing at all, chosen by kind — exhaustive, so a fifth kind must say what an empty reachable
 * set means for it before this compiles. A synthesis reaching nothing is the design ("writes from child summaries
 * only"); a leaf reaching nothing is a plan that gave it no material topic, and those are not the same statement.
 */
function unreachableSource(unit: PlanCatalogUnit): string {
  switch (unit.kind) {
    case "synthesis":
      return `synthesis unit ${JSON.stringify(unit.unitId)} names no topic — it writes from its children's summaries — so no material obligation is reachable through it`;
    case "appendix":
      return `appendix unit ${JSON.stringify(unit.unitId)} names ${unit.topics.length} topic(s), none of which binds a material obligation`;
    case "leaf":
    case "bridge":
      return `${unit.kind} unit ${JSON.stringify(unit.unitId)} names ${unit.topics.length} topic(s), none of which binds a material obligation`;
  }
  return assertNever(unit.kind, "authoring unit kind");
}

/** One sentence a reader cannot mistake for the other two states. Exhaustive; there is no `passed` boolean. */
export function summariseUnitGrounding(result: UnitGroundingResult): string {
  const { verdict } = result;
  switch (verdict.conclusion) {
    case "complete":
      return `complete: unit ${result.unitId} grounds all ${verdict.denominator} material obligation(s) it owns (${verdict.openOriginExempt} open-origin exempt, ${verdict.ownedElsewhere} owned by another unit, ${result.reachable.length} reachable)`;
    case "vacuous":
      return `vacuous: unit ${result.unitId} owes no material obligation, so nothing was checked — ${verdict.source}`;
    case "violations":
      return `violations: unit ${result.unitId} leaves ${verdict.problems.length} of the ${verdict.denominator} material obligation(s) it owns ungrounded (${verdict.grounded} grounded, ${verdict.openOriginExempt} open-origin exempt, ${verdict.ownedElsewhere} owned by another unit)`;
  }
  return assertNever(verdict, "unit grounding conclusion");
}
