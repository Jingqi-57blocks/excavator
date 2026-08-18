import { sha256, stableJson } from "../base/util.ts";

/**
 * What the feature-graph selection DID, recorded by the selector itself.
 *
 * `docs/layering.md` §五 P15 says a mechanism with no displacement / rescue record may not be wired into the
 * allocator, and names `src/attribution/prune-module-floor.ts:51` as the first thing owing one. This is that
 * record, and the reason it lives beside the selector rather than in the artifact builder is the one thing a
 * later reconstruction cannot recover: WHICH CHANNEL seated a node. Seat, rescue, backfill and floor all end in
 * the same retained array, so a downstream reader looking at that array can count seats and can never say why
 * any of them is there — and the floor's whole purpose is to be the channel that put a node back.
 *
 * THE TRACE IS A CLOSED UNION with no optional field. A selection that never ran is not a `ran` trace with an
 * empty pool: "the run had no index" and "the pool was empty" are different facts, and a shape that can express
 * them identically is a shape that will. `channel-unavailable` therefore carries its cause, and the cause union
 * is the same two values `context.ts` already records for the scope census — no third cause is invented here.
 *
 * NOTHING IN THIS FILE READS A PARTITION. The trace is stated in the selector's own vocabulary (graph nodes,
 * scores, quotas); turning it into seats over partition cells is `attribution-artifact.ts`'s job, and keeping
 * that projection out of here is what keeps "the selector decides seats" from becoming "the selector decides
 * the denominator".
 */

export const SELECTION_TRACE_VERSION = "selection-trace-v1";

/**
 * The channels a pool node can leave the selection through. Closed, and the SAME table for both roles: the
 * channel that seated a node and the channel that lost it are one vocabulary, because a seat and a displacement
 * are the two outcomes of one budget decision and splitting them into two enums lets the two drift.
 *
 * `stage1` is the verbatim intrinsic ranking, `rescue` the Stage-2 quota, `backfill` the unspent quota returned
 * to the intrinsic ranking, `module-floor` the module-local strong-rescue add-back, and `displaced` the pool
 * node no seat was left for.
 */
export const SELECTION_CHANNELS = ["stage1", "rescue", "backfill", "module-floor", "displaced"] as const;

export type SelectionChannel = typeof SELECTION_CHANNELS[number];

/** Which budget a displaced node lost to. Closed: a displacement with no named budget is P15 again. */
export type DisplacingBudget =
  /** It was an eligible Stage-2 rescue candidate with a positive signal, and the quota ran out. */
  | "rescue-quota"
  /** It never scored a rescue signal, so only the intrinsic ranking could have seated it, and the cap ran out. */
  | "stage1-cut";

/**
 * The scoring weights, as ONE frozen table.
 *
 * They were loose `const`s in `feature-prune.ts`, which made the channel configuration unnamed and therefore
 * un-digestible: changing a weight changed every seat in every run and moved no identity anywhere. Every value
 * here is the value that constant held, unchanged — this slice moves them, it does not tune them.
 */
export interface ChannelWeights {
  readonly stage1Seed: number;
  readonly stage1DirectlyConnected: number;
  readonly stage1PathTerm: number;
  readonly stage1NameTerm: number;
  readonly stage1SignatureTerm: number;
  readonly stage1CommonPenalty: number;
  readonly stage1TestBonus: number;
  readonly nameTokenExact: number;
  readonly nameSubstring: number;
  readonly abbrevTokenExact: number;
  readonly nameSignalCap: number;
  readonly bridgePerNeighbor: number;
  readonly bridgeMaxMultiplicity: number;
  readonly schedulerBonus: number;
  readonly rescueQuotaMin: number;
  readonly rescueQuotaMax: number;
  readonly rescueQuotaFraction: number;
}

export const WEIGHTS: ChannelWeights = Object.freeze({
  // --- Stage 1: the verbatim intrinsic ranking -------------------------------------------------------------
  stage1Seed: 1000,
  stage1DirectlyConnected: 120,
  stage1PathTerm: 220,
  stage1NameTerm: 160,
  stage1SignatureTerm: 80,
  stage1CommonPenalty: -180,
  stage1TestBonus: 20,
  // --- Stage 2: the rescue signal --------------------------------------------------------------------------
  nameTokenExact: 220,
  nameSubstring: 160,
  abbrevTokenExact: 220,
  nameSignalCap: 440,
  bridgePerNeighbor: 60,
  bridgeMaxMultiplicity: 3,
  schedulerBonus: 80,
  // --- Stage 2: the quota ----------------------------------------------------------------------------------
  rescueQuotaMin: 8,
  rescueQuotaMax: 24,
  rescueQuotaFraction: 0.08
});

/**
 * The digest of the channel configuration, published in the attribution artifact's identity.
 *
 * A weight is a semantic input to every seat this engine awards. Outside the identity it is the cache false-hit
 * the contract's fifth column names: two runs over one corpus with two scoring tables would carry the same
 * identity and different seats. Changing one number here moves this digest.
 */
export function channelConfigDigest(weights: ChannelWeights): string {
  return sha256(stableJson({ version: SELECTION_TRACE_VERSION, channels: [...SELECTION_CHANNELS], weights }));
}

/** One pool node and the channel it left the selection through. Every field required; `null` is a real value. */
export interface TraceNode {
  /** The graph node id, namespaced by `CodeGraphSet` when the run has a module set. Never leaves layer 4. */
  readonly nodeId: string;
  readonly nodeKind: string;
  readonly name: string;
  readonly relativePath: string;
  /** `null` when the index reported no usable line, which is a state the projection has to be able to see. */
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly outcome: SelectionChannel;
  /** Stage-2 rescue signal total. 0 is a measured zero, not "unknown": every pool node is scored. */
  readonly score: number;
  /** The channel's own words for why. Empty for channels that state no reason (stage1, backfill). */
  readonly reason: string;
  /** Which budget lost it, and `null` for every seated node — a seat did not lose a budget. */
  readonly displacedBy: DisplacingBudget | null;
}

/**
 * What the module-local floor decided, per module, INCLUDING the decisions that added nothing.
 *
 * The no-ops are the point. A floor that only records its additions is a mechanism whose silence is
 * indistinguishable from its absence, and "the floor evaluated this module and added nothing" is exactly the
 * sentence the module-crowding bug (57B-377) needed someone to be able to read.
 */
export type FloorDecision =
  /** One module, or a namespace-free pool: the global prune already decided everything and the floor did not run. */
  | { readonly decision: "no-op-single-module"; readonly moduleCount: number }
  /** The module was pruned alone and its strong rescues compared against the global result. `added` may be empty. */
  | { readonly decision: "module-evaluated"; readonly moduleId: string; readonly added: readonly string[] };

/** The budgets the selection actually ran under. Recorded, never re-derived from the request downstream. */
export interface SelectionBudgets {
  readonly maxNodes: number;
  readonly rescueQuota: number;
}

export interface RanSelectionTrace {
  readonly status: "ran";
  /** EVERY candidate the selection considered, each with its outcome. The denominator of the channel census. */
  readonly pool: readonly TraceNode[];
  readonly seedCount: number;
  readonly budgets: SelectionBudgets;
  /** The intrinsic score of the last node inside the Stage-1 cut; `null` when Stage 1 seated nobody. */
  readonly stage1CutScore: number | null;
  readonly floorDecisions: readonly FloorDecision[];
}

export interface UnavailableSelectionTrace {
  readonly status: "channel-unavailable";
  /** The same two causes `context.ts` records for the scope census. No third cause is minted here. */
  readonly cause: "no-graph" | "empty-vocabulary";
}

export type FeatureSelectionTrace = RanSelectionTrace | UnavailableSelectionTrace;

/** The trace for a feature whose channels never ran. A function, so the cause can never be forgotten. */
export function channelUnavailable(cause: UnavailableSelectionTrace["cause"]): UnavailableSelectionTrace {
  return { status: "channel-unavailable", cause };
}
