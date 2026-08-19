import { alignHypothesis, pathSegments } from "../base/path-align.ts";
import type { EntrypointHypothesis, HypothesisOrigin } from "../base/feature-profile.ts";
import type { InventoryRoute, RouteInventory } from "../codegraph/route-inventory.ts";

/**
 * The first recall channel that does not go through vocabulary.
 *
 * Everything upstream of this file reaches code by matching words: seeds come from `LIKE %term%` over names,
 * qualified names, docstrings and paths, and a module that matches no term is never expanded — the per-module
 * floor can only rescue a module that matched and lost. Measured on wcp: with the term "leave" removed from an
 * otherwise unchanged query, three real leave handlers leave the selection entirely, and expansion does not bring
 * them back. Nothing about the ranking can fix that; the capability was simply never a candidate.
 *
 * A route hypothesis crosses that gap because a path shape is not a word. `GET /apply-prompt` locates the handler
 * whether or not the handler's name, file or docstring says "leave", and it reads the same in Go, TypeScript and
 * Perl.
 *
 * WHAT THIS IS NOT: it is not evidence, and it does not create facts. A hypothesis is an unverified assertion by
 * whoever asked for the report. It earns a candidate ADMISSION — the right to be considered — only by aligning
 * with a route some layer-3 producer already observed and recorded. It never mints a membership, never awards a
 * seat, and never touches the denominator.
 *
 * WHY IT RUNS HERE AND NOT IN A PRODUCER: hypotheses are feature vocabulary, and the layering contract forbids
 * feature vocabulary as a layer-3 input. Producers stay feature-blind; this reads what they wrote.
 *
 * WHAT `no-match` DOES AND DOES NOT MEAN — read this before reporting one. It means the pattern did not align with
 * any RECORDED route registration. It does not mean the capability is absent, and two spelling traps produce it
 * routinely:
 *
 *  - Mount prefixes are invisible here. A route registered inside a group is recorded at its group-relative path
 *    (`/apply-prompt`), so a hypothesis written as the public URL (`/v2/leaves/apply-prompt`) aligns with nothing.
 *  - Concrete values are not absorbed. `/leaves/42` does not match `/leaves/:id`, because a pattern is not a call
 *    (see `alignHypothesis` for why that rule had to differ from the crossrepo one).
 *
 * So a reader deciding whether this channel is worth having must separate "the hypotheses were wrong" from "the
 * channel found nothing" — the per-hypothesis rows carry what was asked, which is what makes that separable at all.
 */

export const ROUTE_RECALL_VERSION = "route-recall-v1";

/** One route-channel claim on one graph node. Mirrors the contribution contract the allocator already records. */
export interface RouteChannelEvidence {
  /** A route registration node, or the verified handler of one. */
  readonly nodeId: string;
  readonly rule: "exact" | "parameterised";
  readonly reason: string;
  /** The hypothesis path that matched, so a seat can be walked back to what was asked for. */
  readonly anchor: string;
  readonly propagationPath: readonly string[];
}

/**
 * What the channel did, recorded per hypothesis.
 *
 * Every hypothesis gets a row whether or not it matched. A channel that only reported its successes would make
 * "the operator asked about this route and nothing was found" indistinguishable from "the operator never asked",
 * and the second reads as an absent capability.
 */
export interface RouteHypothesisRow {
  readonly method: string | null;
  readonly pathPattern: string;
  readonly origin: HypothesisOrigin;
  readonly outcome: "matched" | "no-match";
  /** Layer-3 fact ids of every route this hypothesis aligned with, sorted. */
  readonly matchedRouteFactIds: readonly string[];
}

export type RouteRecallTraceBlock =
  | { readonly status: "ran"; readonly hypotheses: readonly RouteHypothesisRow[]; readonly admittedNodeIds: readonly string[] }
  /** Not a failure: a run with no hypotheses, or a target with no index, has nothing for this channel to do. */
  | { readonly status: "not-run"; readonly cause: "no-hypotheses" | "no-route-inventory" };

export interface RouteRecallResult {
  readonly block: RouteRecallTraceBlock;
  /** Nodes to admit as EXPANSION ROOTS. Never passed as allocator seeds — see the caller's red line. */
  readonly admissionNodeIds: readonly string[];
  readonly evidence: readonly RouteChannelEvidence[];
}

function methodMatches(hypothesis: EntrypointHypothesis, route: InventoryRoute): boolean {
  // A null hypothesis method means "any method", which is a weaker claim than naming one and is honoured as such.
  // A route whose method the parser could not read cannot be claimed to match a named method.
  if (hypothesis.method === null) return true;
  return route.method !== null && route.method.toUpperCase() === hypothesis.method;
}

/**
 * Match hypotheses against the recorded route inventory.
 *
 * Alignment is PATTERN-against-pattern (`alignHypothesis`), not call-against-route. The difference is measured,
 * not theoretical: under call semantics the one-segment literal `GET /remain-fully-paid-sick` matched 22 routes on
 * the frozen corpus — every `GET /:id`-shaped route in four modules plus a catch-all in a module with no leave
 * code at all — because a literal call segment is legitimately absorbed by a route parameter. A hypothesis is not
 * a call, and the stay-empty tripwire caught the difference.
 *
 * A hypothesis matching several routes admits all of them. This is recall, not a link assertion: there is no
 * ambiguity bucket, because being considered is cheap and being unreachable is not. The count is visible per
 * hypothesis so a reader can see a pattern that matched forty things.
 */
export function routeRecall(
  hypotheses: readonly EntrypointHypothesis[],
  inventory: RouteInventory | null
): RouteRecallResult {
  if (hypotheses.length === 0) return { block: { status: "not-run", cause: "no-hypotheses" }, admissionNodeIds: [], evidence: [] };
  if (inventory === null) return { block: { status: "not-run", cause: "no-route-inventory" }, admissionNodeIds: [], evidence: [] };

  const rows: RouteHypothesisRow[] = [];
  const evidenceByNode = new Map<string, RouteChannelEvidence>();

  for (const hypothesis of hypotheses) {
    const wanted = pathSegments(hypothesis.pathPattern);
    const matched: string[] = [];

    for (const route of inventory.routes) {
      if (route.routePath === null) continue;
      if (!methodMatches(hypothesis, route)) continue;
      const alignment = alignHypothesis(wanted, pathSegments(route.routePath));
      if (alignment === null) continue;

      matched.push(route.factId);
      const label = `${route.method ?? "ANY"} ${route.routePath}`;
      admit(evidenceByNode, {
        nodeId: route.nodeId,
        rule: alignment,
        reason: `route-match ${label}`,
        anchor: hypothesis.pathPattern,
        propagationPath: []
      });
      // Only a SOURCE-VERIFIED handler is admitted. The index's `references` edge is a candidate, not an
      // identity — measured wrong in 2 of 6 sampled leave routes, pointing at a struct and at a same-named
      // function in another module. Admitting an unverified target would put an unrelated cell one hop from a
      // seat. The route stays visible in `matchedRouteFactIds` either way, so the degrade is legible.
      if (route.handlerResolution === "resolved" && route.handlerNodeId !== null) {
        admit(evidenceByNode, {
          nodeId: route.handlerNodeId,
          rule: alignment,
          reason: `route-handler ${label}`,
          anchor: hypothesis.pathPattern,
          propagationPath: [`${route.factId}->handler`]
        });
      }
    }

    rows.push({
      method: hypothesis.method,
      pathPattern: hypothesis.pathPattern,
      origin: hypothesis.origin,
      outcome: matched.length ? "matched" : "no-match",
      matchedRouteFactIds: [...new Set(matched)].sort()
    });
  }

  const admissionNodeIds = [...evidenceByNode.keys()].sort();
  return {
    block: { status: "ran", hypotheses: rows, admittedNodeIds: admissionNodeIds },
    admissionNodeIds,
    evidence: admissionNodeIds.map((nodeId) => evidenceByNode.get(nodeId)!)
  };
}

/** First claim on a node wins, so the result does not depend on hypothesis order beyond the recorded rows. */
function admit(into: Map<string, RouteChannelEvidence>, evidence: RouteChannelEvidence): void {
  const prior = into.get(evidence.nodeId);
  // An exact alignment outranks a parameterised one for the same node; otherwise keep the first.
  if (prior === undefined || (prior.rule === "parameterised" && evidence.rule === "exact")) into.set(evidence.nodeId, evidence);
}

/**
 * The recall value for a caller that supplied no hypotheses.
 *
 * Named and exported rather than letting call sites write `{}` or make the parameter optional. A caller passing
 * this is stating "this run has nothing for the route channel", which is true of every allocator invocation that
 * predates profiles — replay tooling, ranking fixtures. The distinction it preserves is the one the trace block
 * exists for: nothing was asked, as against something was asked and not found.
 */
export const NO_ROUTE_RECALL: { readonly route: RouteRecallResult } = Object.freeze({
  route: Object.freeze({
    block: Object.freeze({ status: "not-run", cause: "no-hypotheses" }) as RouteRecallTraceBlock,
    admissionNodeIds: Object.freeze([]) as readonly string[],
    evidence: Object.freeze([]) as readonly RouteChannelEvidence[]
  })
});
