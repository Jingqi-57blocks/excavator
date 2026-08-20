/**
 * THE UNIT PATH'S CLAIMS AND TRACES COMPANIONS — aggregation, never folding.
 *
 * A CLAIM KEY MUST CARRY ITS UNIT. `assurance-artifacts.ts` records what happens otherwise: claim ids are unique
 * only WITHIN their writer, so keying a run's claims by id alone collapsed 472 claims across 12 sections into 81 —
 * a 5.8x undercount that sat in `metrics.claims` and in `eval compare`. Units number their claims the same way
 * (`C-<unitId>` is a fixture convention, not a rule; `parseUnitClaims` asks only for a unique id per sidecar), so
 * two units of one document may legitimately both hold `claim-1`. The key function is therefore a REQUIRED
 * parameter rather than a defaulted one: a collapse check that can only ever run against the correct keyer can only
 * ever go green, and the negative fixture hands this one a claim-id-only keyer and watches the refusal fire.
 *
 * TRACES ARE SELECTED BY EXPLICIT ID REFERENCE, NEVER BY A CLAIM-ID JOIN. `TraceStep.claimIds` is how the section
 * path finds a document's traces, and on the unit path that would be exactly the join 57B-458 measured — a step
 * naming `claim-1` cannot say WHICH unit's `claim-1` it meant, so one trace would attach to every unit that happens
 * to number a claim the same way. So a trace belongs to a document here for one of two stated reasons: the trace's
 * own `documentIds` names the document, or one of the document's unit claims cites the trace's own id in its
 * `traceIds`. Both are equality against the trace catalog's primary key, and each row records which reason(s) put
 * it there.
 *
 * `traceIds` IS READ AS UNTRUSTED, because nothing upstream checks its shape. `parseUnitClaims` ends in a cast and
 * defers per-claim rules to `assertValidClaim`, which checks `id`, `statement`, `marker` and comparison sides and
 * never this field — and a claims sidecar is model-written JSON. A `"traceIds": "T-1"` would be ITERATED, turning
 * one citation into three one-character ones and pulling any one-character catalog trace into the companion with a
 * reason nobody wrote. So the aggregator refuses that shape by name. It is not a second definition of "a valid
 * claim": it is this file declining to key a companion on the characters of a string.
 *
 * A CITED TRACE THE CATALOG DOES NOT HOLD IS A NAMED BUCKET, NOT A SILENT DROP. Claim validation does not check
 * trace-catalog membership, so a dangling citation is reachable; reporting it as "no traces" would be the silent
 * empty this repository refuses. It is listed, not thrown: a dangling citation is a content defect the cross-unit
 * checker owns, and refusing to assemble over it would make one bad citation unrecoverable without a re-draft.
 *
 * Pure: takes values, returns values, no I/O and no model.
 */

import type { SectionClaim, TraceRecord, TraceStatus, TraceType } from "../base/types.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import { compareUnitIds } from "./unit-paths.ts";

export const UNIT_CLAIMS_COMPANION_VERSION = "unit-claims-companion-v1";
export const UNIT_TRACES_COMPANION_VERSION = "unit-traces-companion-v1";

/** One unit's claims, as the aggregator receives them. */
export interface UnitClaimsSource {
  readonly unitId: string;
  readonly kind: AuthoringUnitKind;
  readonly claims: readonly SectionClaim[];
}

/** What identifies one claim inside a document. Both fields required — that is the whole point of this file. */
export interface UnitClaimIdentity {
  readonly unitId: string;
  readonly claimId: string;
}

/** One row of the claims companion: the key, who wrote it, and the claim itself. */
export interface UnitClaimRow {
  readonly key: string;
  readonly unitId: string;
  readonly claimId: string;
  readonly claim: SectionClaim;
}

export interface UnitClaimsCompanion {
  readonly version: typeof UNIT_CLAIMS_COMPANION_VERSION;
  readonly runId: string;
  readonly documentId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  /** One row per unit of the document, in the plan's order, so a unit stating no claim is a visible zero. */
  readonly units: readonly { readonly unitId: string; readonly kind: AuthoringUnitKind; readonly claims: number }[];
  /** Every claim of every unit, ascending by key. Never folded: one row per (unit, claim id). */
  readonly claims: readonly UnitClaimRow[];
}

/** What the aggregation is over. Units arrive in the plan's collection order and stay in it. */
export interface UnitClaimsAggregation {
  readonly runId: string;
  readonly documentId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  readonly units: readonly UnitClaimsSource[];
}

/** The ONE key a document's claims are companion-keyed by: the unit, then the claim. */
export function unitClaimKey(identity: UnitClaimIdentity): string {
  return `${identity.unitId}#${identity.claimId}`;
}

/**
 * The claims companion of one document.
 *
 * `keyOf` is required for the reason the file header gives. The refusal below is the collapse guard: two claims
 * landing on one key would put one row in the companion where the run holds two, and every count downstream would
 * still add up.
 */
export function aggregateUnitClaims(
  input: UnitClaimsAggregation,
  keyOf: (identity: UnitClaimIdentity) => string
): UnitClaimsCompanion {
  const rows: UnitClaimRow[] = [];
  const owners = new Map<string, UnitClaimIdentity>();
  for (const unit of input.units) {
    for (const claim of unit.claims) {
      const identity: UnitClaimIdentity = { unitId: unit.unitId, claimId: claim.id };
      const key = keyOf(identity);
      const taken = owners.get(key);
      if (taken !== undefined) {
        throw new Error(`Claim ${JSON.stringify(taken.claimId)} of unit ${JSON.stringify(taken.unitId)} and claim ${JSON.stringify(identity.claimId)} of unit ${JSON.stringify(identity.unitId)} both key to ${JSON.stringify(key)} in the claims companion of ${JSON.stringify(input.documentId)}; two claims under one key is one claim wearing two identities`);
      }
      owners.set(key, identity);
      rows.push({ key, unitId: identity.unitId, claimId: identity.claimId, claim });
    }
  }
  return {
    version: UNIT_CLAIMS_COMPANION_VERSION,
    runId: input.runId,
    documentId: input.documentId,
    knowledgeEpoch: input.knowledgeEpoch,
    planCatalogDigest: input.planCatalogDigest,
    units: input.units.map((unit) => ({ unitId: unit.unitId, kind: unit.kind, claims: unit.claims.length })),
    claims: rows.sort((a, b) => compareUnitIds(a.key, b.key))
  };
}

/** Why one trace is in this document's companion. Ascending, and never empty. */
export const TRACE_INCLUSION_REASONS = ["cited-by-unit-claim", "document-binding"] as const;
export type TraceInclusionReason = (typeof TRACE_INCLUSION_REASONS)[number];

export interface UnitTraceRow {
  readonly traceId: string;
  readonly title: string;
  readonly type: TraceType;
  readonly status: TraceStatus;
  readonly steps: number;
  /** Ascending, at least one. A row with no stated reason would be a trace nobody can explain the presence of. */
  readonly inclusion: readonly TraceInclusionReason[];
  /** Every (unit, claim) that cites this trace by id, ascending. Empty when only the binding put it here. */
  readonly citedBy: readonly UnitClaimIdentity[];
}

export interface UnitTracesCompanion {
  readonly version: typeof UNIT_TRACES_COMPANION_VERSION;
  readonly runId: string;
  readonly documentId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  /** How many traces this run's catalog holds — the denominator the rows below are a subset of. */
  readonly catalogTraces: number;
  readonly traces: readonly UnitTraceRow[];
  /**
   * Trace ids this document's unit claims cite that the run's trace catalog does not hold, ascending.
   *
   * Named rather than dropped: a citation with no trace behind it is a content defect, and reporting it as an
   * absent trace is how it would stop being visible.
   */
  readonly citedTraceIdsNotInCatalog: readonly string[];
}

export interface UnitTracesAggregation extends UnitClaimsAggregation {
  /** This run's whole trace catalog. The companion is a subset of it, never a re-derivation. */
  readonly traces: readonly TraceRecord[];
}

/** The traces companion of one document. Selection is by explicit id reference only — see the file header. */
export function aggregateUnitTraces(input: UnitTracesAggregation): UnitTracesCompanion {
  const byId = new Map(input.traces.map((trace) => [trace.id, trace]));
  const reasons = new Map<string, Set<TraceInclusionReason>>();
  const citedBy = new Map<string, UnitClaimIdentity[]>();
  const dangling = new Set<string>();

  for (const trace of input.traces) {
    if (trace.documentIds.includes(input.documentId)) reasons.set(trace.id, new Set(["document-binding"]));
  }
  for (const unit of input.units) {
    for (const claim of unit.claims) {
      for (const traceId of citedTraceIds(input.documentId, unit.unitId, claim)) {
        if (!byId.has(traceId)) {
          dangling.add(traceId);
          continue;
        }
        const set = reasons.get(traceId) ?? new Set<TraceInclusionReason>();
        set.add("cited-by-unit-claim");
        reasons.set(traceId, set);
        citedBy.set(traceId, [...(citedBy.get(traceId) ?? []), { unitId: unit.unitId, claimId: claim.id }]);
      }
    }
  }

  const rows: UnitTraceRow[] = [...reasons.entries()].map(([traceId, inclusion]) => {
    const trace = byId.get(traceId)!;
    return {
      traceId,
      title: trace.title,
      type: trace.type,
      status: trace.status,
      steps: trace.steps.length,
      inclusion: [...inclusion].sort(compareUnitIds),
      citedBy: [...(citedBy.get(traceId) ?? [])].sort((a, b) => compareUnitIds(unitClaimKey(a), unitClaimKey(b)))
    };
  });

  return {
    version: UNIT_TRACES_COMPANION_VERSION,
    runId: input.runId,
    documentId: input.documentId,
    knowledgeEpoch: input.knowledgeEpoch,
    planCatalogDigest: input.planCatalogDigest,
    catalogTraces: input.traces.length,
    traces: rows.sort((a, b) => compareUnitIds(a.traceId, b.traceId)),
    citedTraceIdsNotInCatalog: [...dangling].sort(compareUnitIds)
  };
}

/**
 * The trace ids one claim cites: shape-checked, and de-duplicated within the claim.
 *
 * De-duplicated because one claim citing a trace twice is one citation — `plan-proposal.ts` de-dupes the id lists it
 * parses, nothing does that for a claims sidecar, and two identical `citedBy` rows would say two claims cite it.
 */
function citedTraceIds(documentId: string, unitId: string, claim: SectionClaim): readonly string[] {
  const cited = claim.traceIds;
  if (cited === undefined) return [];
  if (!Array.isArray(cited) || cited.some((id) => typeof id !== "string" || id.trim() === "")) {
    throw new Error(`Claim ${JSON.stringify(claim.id)} of unit ${JSON.stringify(unitId)} in ${JSON.stringify(documentId)} records traceIds ${JSON.stringify(cited)}, which is not a list of trace ids; the traces companion keys on those ids and will not key on the characters of a string`);
  }
  return [...new Set(cited)];
}
