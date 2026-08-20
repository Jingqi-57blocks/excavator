/**
 * The INVALIDATION PLAN: which authoring units of a plan a set of verified drafts can still answer for (R6a).
 *
 * A deterministic comparison of two identity maps, and nothing else. It takes VALUES — the candidate identities and
 * the identities of the plan now in force — never a path and never a run directory, so it can be derived over an
 * archival baseline, over a synthetic fixture, or inside the real command without three behaviours.
 *
 * FOUR BUCKETS, CLOSED, WITH THE CONSERVATION ASSERTED BOTH WAYS. Every planned unit is `reusable`, `rebuild` or
 * `new`; every candidate is `reusable`, `rebuild` or `retired`. The two equations are checked at the end and a
 * violation is a named throw, because the failure this file has to make impossible is a unit that quietly falls out
 * of both accounts — the plan would still add up and the unit would simply never be written.
 *
 * A SYNTHESIS IS NOT COMPARED UNTIL ITS CHILDREN ARE. A synthesis is written from its children's summaries, so its
 * identity can only be computed from the CANDIDATE children's verified summaries — which is a legitimate identity
 * exactly while every one of those children is itself reusable. The moment one child is rebuilt or new, the
 * summary a candidate synthesis would be measured against is stale, so the synthesis is `rebuild` and the reason
 * NAMES the child. There is no fifth state for it: "its children moved" is a rebuild, told with a reason.
 *
 * THE REASON COMES FROM THE SAME BYTES THE DIGEST DOES. A rebuild caused by a changed identity names the sections
 * of the identity view that differ (`identitySectionDifferences`), so the explanation cannot disagree with the
 * decision — a second, independently derived "why" would be a second answer.
 *
 * THE CANDIDATE SOURCE IS PART OF THE PLAN. A plan derived from an empty candidate set reads "0 prior verified
 * units" WITH the reason, not as an anomaly and never as a hit: a first run and a run whose candidates failed to
 * load must not read the same, and neither may read as "nothing to reuse, so nothing was reused" by silence.
 *
 * WHAT THIS FILE DOES NOT DO. It admits nothing. A `reusable` verdict is a statement about identity, not
 * permission to record anything: R6b's admission still goes through `draftUnit` and `collect` with every existing
 * gate — the grounding audit, the synthesis backlink check, the digest checks — so an identity that was wrong
 * cannot become a recorded unit without those gates agreeing.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import { compareUnitIds } from "./unit-paths.ts";
import { identitySectionDifferences, identityTermDifferences, type UnitIdentity } from "./unit-cache-identity.ts";

export const UNIT_CACHE_PLAN_VERSION = "unit-cache-plan-v1";

/**
 * How the identity of one planned unit was obtained. Required per unit, and checked against the unit's kind.
 *
 * `own-inputs` is a leaf, a bridge or an appendix: its packet is a function of the plan and the frozen epoch, so
 * its identity always exists. The other two arms are the synthesis case, where the identity is a function of the
 * children's verified summaries: `candidate-children-summaries` carries the identity computed FROM THE CANDIDATES,
 * usable only while every child is reusable, and `children-unavailable` says there was no such summary to compute
 * from and why.
 */
export type PlannedUnitIdentity =
  | { readonly derivation: "own-inputs"; readonly identity: UnitIdentity }
  | { readonly derivation: "candidate-children-summaries"; readonly identity: UnitIdentity; readonly childUnitIds: readonly string[] }
  | {
      readonly derivation: "children-unavailable";
      readonly unitId: string;
      readonly documentId: string;
      readonly kind: AuthoringUnitKind;
      readonly childUnitIds: readonly string[];
      readonly reason: string;
    };

/** Where the candidate set came from. Closed: either prior verified units are named, or their absence is. */
export type CandidateSource =
  | {
      readonly origin: "prior-verified-units";
      readonly runId: string;
      readonly knowledgeEpoch: number;
      readonly planCatalogDigest: string;
    }
  | { readonly origin: "no-prior-verified-units"; readonly reason: string };

/** The sentence a reading prints for the candidate set. The empty arm says "0 prior verified units" in words. */
export function describeCandidateSource(source: CandidateSource, candidates: number): string {
  switch (source.origin) {
    case "prior-verified-units":
      return `${candidates} prior verified unit(s) offered by run ${source.runId}, knowledge epoch ${source.knowledgeEpoch}, plan catalog ${source.planCatalogDigest}`;
    case "no-prior-verified-units":
      return `0 prior verified units: ${source.reason}`;
  }
  return assertNever(source, "unit cache candidate source origin");
}

/** Why a planned unit must be written again. Closed; each arm carries what it names. */
export type RebuildReason =
  | {
      readonly cause: "identity-changed";
      /**
       * The TERMS that moved: the authorship, the output contract, or this document's recorded request row.
       *
       * Kept apart from the sections because they answer different questions — "the same packet, written under
       * different terms" and "a different packet". Either list may be empty; both empty is impossible for a
       * changed digest, and `entryFor` refuses that rather than reporting an unexplained rebuild.
       */
      readonly changedTerms: readonly string[];
      readonly changedSections: readonly string[];
      readonly statement: string;
    }
  | { readonly cause: "child-not-reusable"; readonly blockingChildUnitIds: readonly string[]; readonly statement: string }
  | { readonly cause: "children-unavailable"; readonly statement: string };

export type UnitCacheEntry =
  | {
      readonly status: "reusable";
      readonly unitId: string;
      readonly documentId: string;
      readonly kind: AuthoringUnitKind;
      readonly identityDigest: string;
    }
  | {
      readonly status: "rebuild";
      readonly unitId: string;
      readonly documentId: string;
      readonly kind: AuthoringUnitKind;
      /**
       * Empty whenever there is no identity worth recording for the plan side: either it could not be computed
       * (`children-unavailable`) or it was computed from summaries a moved child has made stale
       * (`child-not-reusable`). The reason says which. A non-empty value means the two digests were compared.
       */
      readonly identityDigest: string;
      readonly candidateIdentityDigest: string;
      readonly reason: RebuildReason;
    }
  | {
      readonly status: "new";
      readonly unitId: string;
      readonly documentId: string;
      readonly kind: AuthoringUnitKind;
      /** Empty for a synthesis whose children hold no verified summary to compute an identity from. */
      readonly identityDigest: string;
      readonly reason: string;
    };

/** A candidate the plan now in force no longer holds. It is not deleted anywhere — it is accounted for. */
export interface RetiredUnitCandidate {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  readonly identityDigest: string;
}

/** The two conservation equations, as data next to the sentences they stand for. */
export interface UnitCacheConservation {
  readonly plannedUnits: number;
  readonly candidateUnits: number;
  readonly reusable: number;
  readonly rebuild: number;
  readonly new: number;
  readonly retired: number;
  readonly statements: readonly string[];
}

export interface UnitCachePlan {
  readonly version: typeof UNIT_CACHE_PLAN_VERSION;
  readonly candidateSource: CandidateSource;
  readonly candidateStatement: string;
  /** One entry per planned unit, ascending by unit id. */
  readonly entries: readonly UnitCacheEntry[];
  /** Ascending by unit id. */
  readonly retired: readonly RetiredUnitCandidate[];
  readonly conservation: UnitCacheConservation;
}

export interface UnitCachePlanInput {
  readonly planned: readonly PlannedUnitIdentity[];
  readonly candidates: readonly UnitIdentity[];
  readonly candidateSource: CandidateSource;
}

/** The unit id, document and kind of one planned unit, whichever arm carried it. */
function plannedRow(planned: PlannedUnitIdentity): { readonly unitId: string; readonly documentId: string; readonly kind: AuthoringUnitKind } {
  switch (planned.derivation) {
    case "own-inputs":
    case "candidate-children-summaries":
      return { unitId: planned.identity.unitId, documentId: planned.identity.documentId, kind: planned.identity.kind };
    case "children-unavailable":
      return { unitId: planned.unitId, documentId: planned.documentId, kind: planned.kind };
  }
  return assertNever(planned, "planned unit identity derivation");
}

/** The children one planned unit is written from: empty for every arm but the two synthesis ones. */
function plannedChildren(planned: PlannedUnitIdentity): readonly string[] {
  switch (planned.derivation) {
    case "own-inputs":
      return [];
    case "candidate-children-summaries":
    case "children-unavailable":
      return planned.childUnitIds;
  }
  return assertNever(planned, "planned unit identity derivation");
}

/**
 * A synthesis identity may not be derived from its own inputs, and no other kind may be derived from children.
 *
 * Checked rather than trusted, because this is the one place a caller could smuggle a synthesis identity past the
 * children rule: an identity handed in through `own-inputs` would be compared with no child ever being looked at,
 * which is exactly the stale-summary reuse the rule exists to stop.
 */
function assertDerivationMatchesKind(planned: PlannedUnitIdentity): void {
  const { unitId, kind } = plannedRow(planned);
  const isSynthesis = kind === "synthesis";
  const fromChildren = planned.derivation !== "own-inputs";
  if (isSynthesis === fromChildren) return;
  throw new Error(isSynthesis
    ? `Synthesis unit ${JSON.stringify(unitId)} was given an identity derived from ${JSON.stringify(planned.derivation)}; a synthesis is written from its children's verified summaries, so its identity may only be derived from the candidate children — an identity derived from its own inputs would be compared without any child being consulted`
    : `Unit ${JSON.stringify(unitId)} of kind ${JSON.stringify(kind)} was given an identity derived from ${JSON.stringify(planned.derivation)}; only a synthesis is written from child summaries`);
}

/**
 * Derive the invalidation plan. Deterministic: same values, same plan, always.
 *
 * The planned units are resolved in dependency order — a synthesis after every child it names — by repeated passes
 * over the unresolved set in ascending unit id order. A set that stops shrinking is a named throw rather than a
 * partial plan: a cycle in the plan graph is R3's business, and a cache plan that silently dropped the units it
 * could not order would report a conserving account of a subset.
 */
export function deriveUnitCachePlan(input: UnitCachePlanInput): UnitCachePlan {
  const planned = new Map<string, PlannedUnitIdentity>();
  for (const row of input.planned) {
    assertDerivationMatchesKind(row);
    const { unitId } = plannedRow(row);
    if (planned.has(unitId)) throw new Error(`The planned identity map holds unit ${JSON.stringify(unitId)} twice; a unit with two identities has none`);
    planned.set(unitId, row);
  }
  const candidates = new Map<string, UnitIdentity>();
  for (const candidate of input.candidates) {
    if (candidates.has(candidate.unitId)) throw new Error(`The candidate set holds unit ${JSON.stringify(candidate.unitId)} twice; which verified draft would be reused is then undecided`);
    candidates.set(candidate.unitId, candidate);
  }
  assertSourceMatchesCandidates(input.candidateSource, candidates.size);
  for (const row of input.planned) {
    for (const childUnitId of plannedChildren(row)) {
      if (!planned.has(childUnitId)) {
        throw new Error(`Unit ${JSON.stringify(plannedRow(row).unitId)} is written from child ${JSON.stringify(childUnitId)}, which the planned identity map does not hold; its reuse cannot be decided from children nobody accounted for`);
      }
    }
  }

  const entries = new Map<string, UnitCacheEntry>();
  let pending = [...planned.keys()].sort(compareUnitIds);
  while (pending.length > 0) {
    const ready = pending.filter((unitId) => plannedChildren(planned.get(unitId)!).every((child) => entries.has(child)));
    if (ready.length === 0) {
      throw new Error(`The invalidation plan cannot order ${pending.length} unit(s) — ${pending.join(", ")} — because each of them is written from a child that is not itself planned ahead of it; a cache plan over part of a plan would conserve over the part`);
    }
    for (const unitId of ready) {
      entries.set(unitId, entryFor(planned.get(unitId)!, candidates.get(unitId) ?? null, entries, input.candidateSource, candidates.size));
    }
    pending = pending.filter((unitId) => !entries.has(unitId));
  }

  const ordered = [...planned.keys()].sort(compareUnitIds).map((unitId) => entries.get(unitId)!);
  const retired = [...candidates.values()]
    .filter((candidate) => !planned.has(candidate.unitId))
    .sort((a, b) => compareUnitIds(a.unitId, b.unitId))
    .map((candidate) => ({ unitId: candidate.unitId, documentId: candidate.documentId, kind: candidate.kind, identityDigest: candidate.digest }));
  const counted = (status: UnitCacheEntry["status"]): number => ordered.filter((entry) => entry.status === status).length;
  const conservation: UnitCacheConservation = {
    plannedUnits: ordered.length,
    candidateUnits: candidates.size,
    reusable: counted("reusable"),
    rebuild: counted("rebuild"),
    new: counted("new"),
    retired: retired.length,
    statements: [
      `planned = reusable + rebuild + new: ${ordered.length} = ${counted("reusable")} + ${counted("rebuild")} + ${counted("new")}`,
      `candidates = reusable + rebuild + retired: ${candidates.size} = ${counted("reusable")} + ${counted("rebuild")} + ${retired.length}`
    ]
  };
  assertConservation(conservation);
  return {
    version: UNIT_CACHE_PLAN_VERSION,
    candidateSource: input.candidateSource,
    candidateStatement: describeCandidateSource(input.candidateSource, candidates.size),
    entries: ordered,
    retired,
    conservation
  };
}

/** The empty arm and an empty candidate set must agree, in both directions. */
function assertSourceMatchesCandidates(source: CandidateSource, candidates: number): void {
  switch (source.origin) {
    case "prior-verified-units":
      if (candidates === 0) {
        throw new Error(`The candidate source names prior verified units of run ${JSON.stringify(source.runId)} but the candidate set is empty; an empty set has to be declared as one, with its reason, or "nothing was reused" and "nothing was offered" become the same reading`);
      }
      return;
    case "no-prior-verified-units":
      if (candidates > 0) {
        throw new Error(`The candidate source declares no prior verified units but ${candidates} candidate(s) were handed in; the plan would report a provenance its own candidates contradict`);
      }
      if (source.reason.trim() === "") {
        throw new Error("An empty candidate set must say WHY it is empty: a first run, an absent ledger and a ledger that holds nothing for this epoch are three different facts about a run");
      }
      return;
  }
  return assertNever(source, "unit cache candidate source origin");
}

/** Both equations, asserted. A violation is a bug in this file, and it is named rather than reported as data. */
function assertConservation(conservation: UnitCacheConservation): void {
  const { plannedUnits, candidateUnits, reusable, rebuild, retired } = conservation;
  if (reusable + rebuild + conservation.new !== plannedUnits) {
    throw new Error(`The invalidation plan accounts for ${reusable + rebuild + conservation.new} of ${plannedUnits} planned unit(s) (${reusable} reusable, ${rebuild} rebuild, ${conservation.new} new); a planned unit in no bucket is a unit nothing would write`);
  }
  if (reusable + rebuild + retired !== candidateUnits) {
    throw new Error(`The invalidation plan accounts for ${reusable + rebuild + retired} of ${candidateUnits} candidate(s) (${reusable} reusable, ${rebuild} rebuild, ${retired} retired); a candidate in no bucket is a verified draft nobody decided about`);
  }
}

/** The bucket of one planned unit, given its candidate (or none) and the entries of its children. */
function entryFor(
  planned: PlannedUnitIdentity,
  candidate: UnitIdentity | null,
  decided: ReadonlyMap<string, UnitCacheEntry>,
  source: CandidateSource,
  candidateUnits: number
): UnitCacheEntry {
  const { unitId, documentId, kind } = plannedRow(planned);
  const blocking = plannedChildren(planned).filter((childUnitId) => decided.get(childUnitId)!.status !== "reusable").sort(compareUnitIds);
  if (!candidate) {
    const digest = planned.derivation === "children-unavailable" ? "" : planned.identity.digest;
    return {
      status: "new",
      unitId,
      documentId,
      kind,
      identityDigest: digest,
      reason: `no candidate holds unit ${unitId}: ${describeCandidateSource(source, candidateUnits)}`
    };
  }
  if (blocking.length > 0) {
    return {
      status: "rebuild",
      unitId,
      documentId,
      kind,
      identityDigest: "",
      candidateIdentityDigest: candidate.digest,
      reason: {
        cause: "child-not-reusable",
        blockingChildUnitIds: blocking,
        statement: `unit ${unitId} is written from ${blocking.length} child unit(s) that are not reusable (${blocking.join(", ")}), so the verified summaries its candidate identity would be measured against are stale`
      }
    };
  }
  if (planned.derivation === "children-unavailable") {
    return {
      status: "rebuild",
      unitId,
      documentId,
      kind,
      identityDigest: "",
      candidateIdentityDigest: candidate.digest,
      reason: {
        cause: "children-unavailable",
        statement: `unit ${unitId} has no identity to compare: ${planned.reason}`
      }
    };
  }
  const identity = planned.identity;
  if (identity.digest === candidate.digest) {
    return { status: "reusable", unitId, documentId, kind, identityDigest: identity.digest };
  }
  // The digest covers the view AND the terms, so the reason has to be able to name either. An authorship change or
  // a schema bump moves the digest with every section byte-identical; reporting that as "no section differs" would
  // have turned a model-family switch — and any `unit-claims-v2` — into a refusal of the whole plan.
  const changedTerms = identityTermDifferences(candidate, identity);
  const changedSections = identitySectionDifferences(candidate, identity);
  if (changedTerms.length === 0 && changedSections.length === 0) {
    throw new Error(`Unit ${JSON.stringify(unitId)} has a different identity digest from its candidate but neither a term nor a section of its identity differs; the record does not cover what the digest covers, so no rebuild reason could be given`);
  }
  const parts = [
    ...(changedTerms.length > 0 ? [`${changedTerms.length} term(s) it was written under (${changedTerms.join("; ")})`] : []),
    ...(changedSections.length > 0 ? [`${changedSections.length} section(s) of its identity view (${changedSections.join("; ")})`] : [])
  ];
  return {
    status: "rebuild",
    unitId,
    documentId,
    kind,
    identityDigest: identity.digest,
    candidateIdentityDigest: candidate.digest,
    reason: {
      cause: "identity-changed",
      changedTerms,
      changedSections,
      statement: `unit ${unitId} differs from its candidate in ${parts.join(" and ")}`
    }
  };
}
