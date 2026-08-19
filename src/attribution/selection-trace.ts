import { sha256, stableJson } from "../base/util.ts";
import type { RouteRecallTraceBlock } from "./route-recall.ts";
import type { CrossrepoRecallTraceBlock } from "./crossrepo-recall.ts";

/** The allocator trace is the accountable boundary between candidate discovery and layer-4 seats. */
export const SELECTION_TRACE_VERSION = "selection-trace-v5";

/** Producer channels never share a raw score. `displaced` is the named outcome of the one seat budget. */
// `route` sits directly after `seed` because the channel order IS the decisive tie-break: when two contributions
// normalise to the same value, `indexOf` decides which one names the seat. Structural evidence — a recorded route
// aligning with a stated hypothesis — is a better answer to "why is this here" than a substring hit, so it ranks
// above every lexical-derived channel.
export const CONTRIBUTION_CHANNELS = ["seed", "route", "crossrepo", "lexical", "derived", "relation", "convention", "fallback"] as const;
export type ContributionChannel = typeof CONTRIBUTION_CHANNELS[number];
export const SELECTION_CHANNELS = [...CONTRIBUTION_CHANNELS, "displaced"] as const;
export type SelectionChannel = typeof SELECTION_CHANNELS[number];
export type DisplacingBudget = "seat-cap";

export interface ChannelWeights {
  readonly seed: number;
  readonly route: number;
  readonly crossrepo: number;
  readonly lexical: number;
  readonly derived: number;
  readonly relation: number;
  readonly convention: number;
  readonly fallback: number;
}

export const WEIGHTS: ChannelWeights = Object.freeze({
  seed: 1,
  route: 1,
  crossrepo: 1,
  lexical: 1,
  derived: 1,
  relation: 1,
  convention: 1,
  fallback: 0.25
});

export const RANK_CONSTANT = 60;

export function channelConfigDigest(weights: ChannelWeights): string {
  return sha256(stableJson({
    version: SELECTION_TRACE_VERSION,
    channels: [...CONTRIBUTION_CHANNELS],
    fusion: "weighted-reciprocal-rank",
    rankConstant: RANK_CONSTANT,
    rawScoresMayBeSummedAcrossChannels: false,
    tieBreak: ["relativePath", "name", "nodeId"],
    weights
  }));
}

/** One producer's claim on one candidate. Every field is present; only fallback may carry a null anchor. */
export interface SelectionContribution {
  readonly sourceChannel: ContributionChannel;
  readonly reason: string;
  readonly anchor: string | null;
  readonly propagationPath: readonly string[];
  /** One-based ordinal inside this channel. Raw producer strengths never leave the producer. */
  readonly rank: number;
  readonly normalizedContribution: number;
}

export interface TraceNode {
  readonly nodeId: string;
  readonly nodeKind: string;
  readonly name: string;
  readonly relativePath: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  /** The decisive contribution for a seat, or displaced when the one cap ran out. */
  readonly outcome: SelectionChannel;
  /** Weighted reciprocal-rank fusion. No raw producer score participates in this number. */
  readonly score: number;
  readonly reason: string;
  readonly contributions: readonly SelectionContribution[];
  readonly displacedBy: DisplacingBudget | null;
}

export interface SelectionBudgets { readonly maxNodes: number }

export interface SelectionFusion {
  readonly method: "weighted-reciprocal-rank";
  readonly rankConstant: number;
  readonly rawScoresSummedAcrossChannels: false;
  readonly tieBreak: readonly ["relativePath", "name", "nodeId"];
  readonly cutoffScore: number | null;
}

export interface RanSelectionTrace {
  readonly status: "ran";
  readonly pool: readonly TraceNode[];
  readonly seedCount: number;
  /**
   * The query seeds themselves, sorted and deduplicated — the nodes `searchNodes` matched, never their
   * neighbours.
   *
   * It is a recorded id set and NOT `contributions.sourceChannel === "seed"`, because those are two different
   * things: `allocator.ts` puts a query seed on the `seed` channel, and then puts every node ADJACENT to a seed
   * on the same channel with reason `seed-neighbor`. Reading the channel back as identity would silently seat a
   * node's neighbour as if the query had found it, which is the whole distinction layer 5's `seeded` relation
   * exists to make. The channel says how a candidate earned its rank; this says which candidates the query
   * actually named.
   */
  readonly querySeedNodeIds: readonly string[];
  /**
   * What each recall channel did, including when it did nothing.
   *
   * Required, not optional: a channel whose record may be absent is a channel that can quietly stop running. The
   * `not-run` arm is a written state with a cause, so "no hypotheses were given" stays distinguishable from "the
   * hypotheses found nothing" — and the second one is a finding about the target.
   */
  readonly recall: { readonly route: RouteRecallTraceBlock; readonly crossrepo: CrossrepoRecallTraceBlock };
  readonly budgets: SelectionBudgets;
  readonly fusion: SelectionFusion;
}

export interface UnavailableSelectionTrace {
  readonly status: "channel-unavailable";
  readonly cause: "no-graph" | "empty-vocabulary";
}

export type FeatureSelectionTrace = RanSelectionTrace | UnavailableSelectionTrace;

export function channelUnavailable(cause: UnavailableSelectionTrace["cause"]): UnavailableSelectionTrace {
  return { status: "channel-unavailable", cause };
}
