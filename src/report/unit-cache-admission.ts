/**
 * ADMISSION: turning R6a's `reusable` verdict into a decision about what may be recorded without being re-drawn,
 * and the account of what happened (R6b). Values only — no path, no run directory, no write.
 *
 * WHAT A `reusable` VERDICT IS AND IS NOT. It is a statement about IDENTITY: the packet this unit would be written
 * from is byte-for-byte the one a prior verified draft was written from. It is not permission to record anything.
 * Two further things have to be true before a prior draft may be re-entered, and they are the two this file adds:
 *
 *   1. THE BYTES ON DISK MUST STILL BE THE VERIFIED ONES. A candidate is a ledger row plus three artifacts; if the
 *      artifacts no longer digest to what the row promised, the identity was right about the INPUTS and irrelevant
 *      about the OUTPUT. That candidate is named and DOWNGRADED to a rebuild — never silently skipped, and never
 *      admitted because its inputs matched.
 *   2. THE EXISTING GATES MUST AGREE, AGAIN. Admission re-enters the bytes through `draftUnit` and `collect` with
 *      every gate unchanged (the summary agreement check, the output budget, the grounding audit, the synthesis
 *      backlink check, the promised-artifact digests). So a wrong identity cannot become a recorded unit: it can
 *      only become a named refusal. That is why this file does not need the identity to be provably complete —
 *      the audit is the backstop, and `collect-refused` is a first-class outcome here rather than a crash.
 *
 * THREE BUCKETS, AND NO FOURTH. Every planned unit is `admitted`, `fell-to-rebuild` or `skipped-new`, and the
 * conservation is asserted, because a planned unit in no bucket is a unit nobody would write and every count would
 * still add up. The read-only pass uses the INTENT vocabulary (`admit` / `rebuild` / `new`) rather than the same
 * three words, so a plan can never be read as a record of hits that happened.
 *
 * STALE RECEIPTS ARE NOT REVIVED, BY CONSTRUCTION. Admission mints a NEW receipt for the plan now in force; the
 * candidate's own receipt was deleted when it was collected. `collect`'s refusals of a foreign epoch and a
 * superseded plan are untouched and unreachable from here — there is no path in which an old receipt is forgiven.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import { compareUnitIds } from "./unit-paths.ts";
import type { UnitCacheAdmissionSource } from "./unit-provenance.ts";
import type { RetiredUnitCandidate, UnitCacheEntry, UnitCachePlan } from "./unit-cache-plan.ts";

export const UNIT_ADMISSION_VERSION = "unit-admission-v1";

/** One planned unit, as every arm below names it. */
export interface UnitRow {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
}

/**
 * Whether a candidate's artifacts on disk are still the bytes its ledger row promised.
 *
 * Closed, and `drifted` carries what disagreed. There is no "unchecked" arm: a candidate nobody verified may not be
 * re-entered, so the absence of a check would have to read as drift anyway — and then it would be a state that
 * looks like a measurement.
 */
export type CandidateVerification =
  | { readonly state: "verified" }
  | { readonly state: "drifted"; readonly problems: readonly string[] };

/** Why a ledger row of this run is, or is not, offered to the invalidation plan as a candidate. Closed. */
export type CandidateDisposition =
  | { readonly state: "offered"; readonly verification: CandidateVerification }
  | { readonly state: "excluded"; readonly cause: "other-epoch" | "collected-under-this-plan"; readonly statement: string };

/** One row of this run's unit ledger, and what the admission did with it. Every row appears, uncapped. */
export interface CandidateLedgerRow extends UnitRow {
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  readonly packetIdentityDigest: string;
  readonly disposition: CandidateDisposition;
}

/** Why a planned unit must be written again rather than admitted. Closed; each cause carries its own sentence. */
export type AdmissionRebuildCause =
  /** The invalidation plan compared the identities and they differ (its own reason statement is carried). */
  | "identity-differs"
  /** The candidate's artifacts on disk no longer digest to what its ledger row promised. */
  | "candidate-drift"
  /** `collect` refused the re-entered draft by name — the grounding audit, the backlink check or a digest check. */
  | "collect-refused"
  /** An earlier unit's refusal left a receipt on disk, so this pass stopped before deciding this unit. */
  | "halted-by-earlier-refusal";

/** What the admission INTENDS for one planned unit. Three arms, closed, decided before anything is written. */
export type UnitAdmissionIntent =
  | { readonly intent: "admit"; readonly unit: UnitRow; readonly identityDigest: string; readonly statement: string }
  | { readonly intent: "rebuild"; readonly unit: UnitRow; readonly cause: AdmissionRebuildCause; readonly statement: string }
  | { readonly intent: "new"; readonly unit: UnitRow; readonly statement: string };

/** What actually happened to one planned unit. Three arms, closed; only the executing pass produces these. */
export type UnitAdmissionOutcome =
  | {
      readonly outcome: "admitted";
      readonly unit: UnitRow;
      readonly identityDigest: string;
      /** The ledger row this admission re-entered — the same value the new record's provenance carries. */
      readonly source: UnitCacheAdmissionSource;
      readonly statement: string;
    }
  | { readonly outcome: "fell-to-rebuild"; readonly unit: UnitRow; readonly cause: AdmissionRebuildCause; readonly statement: string }
  | { readonly outcome: "skipped-new"; readonly unit: UnitRow; readonly statement: string };

export interface UnitAdmissionAccount {
  readonly plannedUnits: number;
  readonly candidateLedgerRows: number;
  readonly offeredCandidates: number;
  /**
   * The three buckets, named by what they MEAN in both passes rather than by either pass's vocabulary.
   *
   * The read-only pass reads them as "would be admitted / would be re-drawn / no candidate holds it" and the
   * executing pass as "admitted / fell to rebuild / skipped as new"; the words a reader sees come from the labels
   * the caller passes to `summariseAdmission`, so the two can never be mistaken for each other.
   */
  readonly reused: number;
  readonly rebuilt: number;
  readonly unoffered: number;
  readonly statements: readonly string[];
}

/** The read-only pass: what admission WOULD do, with nothing written. */
export interface UnitAdmissionPlan {
  readonly version: typeof UNIT_ADMISSION_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  readonly authorship: string;
  /**
   * R6a's invalidation plan, exactly as this admission was derived from it.
   *
   * Carried rather than summarised so that "the execution and the plan agree unit for unit" is CHECKABLE from
   * outside instead of being the executor's word for it: the intents below are this plan's four buckets with a
   * drifted candidate downgraded, and a reader (or a test) can hold the two lists side by side.
   */
  readonly cachePlan: UnitCachePlan;
  readonly candidateStatement: string;
  /** Every row of this run's ledger and what the admission did with it, ascending by unit id. Uncapped. */
  readonly ledgerRows: readonly CandidateLedgerRow[];
  /** One per planned unit, ascending by unit id. */
  readonly intents: readonly UnitAdmissionIntent[];
  readonly retired: readonly RetiredUnitCandidate[];
  readonly account: UnitAdmissionAccount;
}

/** The executing pass: what happened, unit by unit. */
export interface UnitAdmissionReport {
  readonly version: typeof UNIT_ADMISSION_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  readonly authorship: string;
  readonly candidateStatement: string;
  readonly ledgerRows: readonly CandidateLedgerRow[];
  /** One per planned unit, ascending by unit id. */
  readonly outcomes: readonly UnitAdmissionOutcome[];
  readonly retired: readonly RetiredUnitCandidate[];
  readonly account: UnitAdmissionAccount;
}

export interface UnitAdmissionPlanInput {
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  readonly authorship: string;
  readonly plan: UnitCachePlan;
  readonly ledgerRows: readonly CandidateLedgerRow[];
}

/**
 * Derive what admission would do, from the invalidation plan and the candidates' byte verification.
 *
 * The plan decides REUSE; this decides which flavour of "must be written again" a reader is told about, and the two
 * cannot disagree: a drifted candidate can only downgrade a `reusable` verdict, never create one.
 */
export function deriveUnitAdmissionPlan(input: UnitAdmissionPlanInput): UnitAdmissionPlan {
  const verification = new Map<string, CandidateVerification>();
  for (const row of input.ledgerRows) {
    if (row.disposition.state === "offered") verification.set(row.unitId, row.disposition.verification);
  }
  // The units this run has ALREADY collected under the plan in force. They have no candidate — there is nothing to
  // admit for a unit that is already recorded — and saying only "no candidate holds it" would read as "it still has
  // to be written", which is the opposite of the truth.
  const recorded = new Set(input.ledgerRows
    .filter((row) => row.disposition.state === "excluded" && row.disposition.cause === "collected-under-this-plan")
    .map((row) => row.unitId));
  const intents = [...input.plan.entries]
    .sort((a, b) => compareUnitIds(a.unitId, b.unitId))
    .map((entry) => intentFor(entry, verification.get(entry.unitId) ?? null, recorded.has(entry.unitId)));
  const account = accountOf({
    plannedUnits: input.plan.conservation.plannedUnits,
    ledgerRows: input.ledgerRows,
    counts: [
      intents.filter((intent) => intent.intent === "admit").length,
      intents.filter((intent) => intent.intent === "rebuild").length,
      intents.filter((intent) => intent.intent === "new").length
    ],
    labels: ["admit", "rebuild", "new"]
  });
  return {
    version: UNIT_ADMISSION_VERSION,
    runId: input.runId,
    knowledgeEpoch: input.knowledgeEpoch,
    planCatalogDigest: input.planCatalogDigest,
    authorship: input.authorship,
    cachePlan: input.plan,
    candidateStatement: input.plan.candidateStatement,
    ledgerRows: [...input.ledgerRows].sort((a, b) => compareUnitIds(a.unitId, b.unitId)),
    intents,
    retired: input.plan.retired,
    account
  };
}

/** The account of one executing pass, over the outcomes it produced. The conservation is asserted, not reported. */
export function admissionReportOf(
  plan: UnitAdmissionPlan,
  outcomes: readonly UnitAdmissionOutcome[],
  ledgerRows: readonly CandidateLedgerRow[]
): UnitAdmissionReport {
  const ordered = [...outcomes].sort((a, b) => compareUnitIds(a.unit.unitId, b.unit.unitId));
  return {
    version: UNIT_ADMISSION_VERSION,
    runId: plan.runId,
    knowledgeEpoch: plan.knowledgeEpoch,
    planCatalogDigest: plan.planCatalogDigest,
    authorship: plan.authorship,
    candidateStatement: plan.candidateStatement,
    ledgerRows: [...ledgerRows].sort((a, b) => compareUnitIds(a.unitId, b.unitId)),
    outcomes: ordered,
    retired: plan.retired,
    account: accountOf({
      plannedUnits: plan.account.plannedUnits,
      ledgerRows,
      counts: [
        ordered.filter((outcome) => outcome.outcome === "admitted").length,
        ordered.filter((outcome) => outcome.outcome === "fell-to-rebuild").length,
        ordered.filter((outcome) => outcome.outcome === "skipped-new").length
      ],
      labels: ["admitted", "fell-to-rebuild", "skipped-new"]
    })
  };
}

/**
 * The outcome of an intent nothing was attempted for — exhaustive over the three arms.
 *
 * The `admit` arm is a named throw rather than a fallback: an admit intent's outcome is decided by what `draftUnit`
 * and `collect` did, and a function that could quietly turn one into an outcome would be a second decision maker.
 */
export function outcomeOfUnattemptedIntent(intent: UnitAdmissionIntent): UnitAdmissionOutcome {
  switch (intent.intent) {
    case "admit":
      throw new Error(`Unit ${JSON.stringify(intent.unit.unitId)} is intended for admission, so its outcome is whatever draft and collect say; it cannot be reported without being attempted`);
    case "rebuild":
      return { outcome: "fell-to-rebuild", unit: intent.unit, cause: intent.cause, statement: intent.statement };
    case "new":
      return { outcome: "skipped-new", unit: intent.unit, statement: intent.statement };
  }
  return assertNever(intent, "unit admission intent");
}

/** One sentence a reader cannot mistake for a coverage claim, for either pass. */
export function summariseAdmission(account: UnitAdmissionAccount, labels: readonly [string, string, string]): string {
  return `${account.plannedUnits} planned unit(s): ${account.reused} ${labels[0]}, ${account.rebuilt} ${labels[1]}, ${account.unoffered} ${labels[2]}; ${account.offeredCandidates} of ${account.candidateLedgerRows} prior ledger row(s) offered as candidates`;
}

/**
 * The bucket of one planned unit: the invalidation plan's verdict, downgraded by drift where there was any.
 *
 * `reusable` + a drifted candidate is the ONE composition here, and its direction is fixed: a drifted candidate can
 * only take reuse away. Nothing in this function can turn a `rebuild` or a `new` into an admission.
 */
function intentFor(entry: UnitCacheEntry, verification: CandidateVerification | null, alreadyRecorded: boolean): UnitAdmissionIntent {
  const unit: UnitRow = { unitId: entry.unitId, documentId: entry.documentId, kind: entry.kind };
  switch (entry.status) {
    case "reusable": {
      if (!verification) {
        throw new Error(`Unit ${JSON.stringify(entry.unitId)} is reusable but no candidate verification was recorded for it; a draft may not be re-entered on bytes nobody checked`);
      }
      switch (verification.state) {
        case "verified":
          return {
            intent: "admit",
            unit,
            identityDigest: entry.identityDigest,
            statement: `unit ${entry.unitId} has the identity its candidate recorded (${entry.identityDigest.slice(0, 16)}) and its verified artifacts are still on disk`
          };
        case "drifted":
          return {
            intent: "rebuild",
            unit,
            cause: "candidate-drift",
            statement: `unit ${entry.unitId} has the identity its candidate recorded (${entry.identityDigest.slice(0, 16)}) but its artifacts on disk are no longer the verified ones: ${verification.problems.join("; ")}`
          };
      }
      return assertNever(verification, "candidate verification state");
    }
    case "rebuild":
      return { intent: "rebuild", unit, cause: "identity-differs", statement: entry.reason.statement };
    case "new":
      return {
        intent: "new",
        unit,
        statement: alreadyRecorded
          ? `unit ${entry.unitId} is already collected under the plan now in force, so it offers nothing to admit and needs nothing written: ${entry.reason}`
          : entry.reason
      };
  }
  return assertNever(entry, "unit cache entry status");
}

/** The account, with both equations stated and the three-bucket one asserted. */
function accountOf(input: {
  readonly plannedUnits: number;
  readonly ledgerRows: readonly CandidateLedgerRow[];
  readonly counts: readonly [number, number, number];
  readonly labels: readonly [string, string, string];
}): UnitAdmissionAccount {
  const [first, second, third] = input.counts;
  const offered = input.ledgerRows.filter((row) => row.disposition.state === "offered").length;
  if (first + second + third !== input.plannedUnits) {
    throw new Error(`The admission accounts for ${first + second + third} of ${input.plannedUnits} planned unit(s) (${first} ${input.labels[0]}, ${second} ${input.labels[1]}, ${third} ${input.labels[2]}); a planned unit in no bucket is a unit nothing would write`);
  }
  return {
    plannedUnits: input.plannedUnits,
    candidateLedgerRows: input.ledgerRows.length,
    offeredCandidates: offered,
    reused: first,
    rebuilt: second,
    unoffered: third,
    statements: [
      `planned = ${input.labels.join(" + ")}: ${input.plannedUnits} = ${first} + ${second} + ${third}`,
      `ledger rows = offered as candidates + excluded: ${input.ledgerRows.length} = ${offered} + ${input.ledgerRows.length - offered}`
    ]
  };
}

/** The ids one bucket of a cache plan holds, for a reading that compares plan and execution. */
export function cachePlanIds(plan: UnitCachePlan, status: UnitCacheEntry["status"]): readonly string[] {
  return plan.entries.filter((entry) => entry.status === status).map((entry) => entry.unitId).sort(compareUnitIds);
}
