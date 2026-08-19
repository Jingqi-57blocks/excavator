import type { CrossRepoScan } from "../crossrepo/crossrepo-scan.ts";
import type { InventoryRoute, RouteInventory } from "../codegraph/route-inventory.ts";

/**
 * Cross-module recall: a caller already in the pool vouches for the handler it reaches.
 *
 * This is the hardest form of the lexical ceiling. Two repositories that serve one capability need not share a
 * single word — a Vue component calling `/v2/leaves/me/simple` and a Go handler registered at
 * `internal/handlers/handlers.go:110` have nothing in common lexically, and the source fallback searches with the
 * same terms that already failed. Measured on wcp: with the full vocabulary the frontend seats 4 cells, and the
 * backend's seats come entirely from the backend's own words. The confirmed link between the two — 383 of them on
 * this corpus, already resolved and already persisted — never participated in recall at all.
 *
 * The propagation is deliberately narrow, and each narrowing is a measured decision rather than caution:
 *
 *  - ONLY `confirmed` links. `probable` covers framework-shaped and ANY-method matches, which the crossrepo scan
 *    already declines to assert as links; admitting them here would launder a maybe into a candidate.
 *  - ONLY when the caller sits inside an EXPANSION ROOT — a node that carried a direct signal, either a lexical
 *    seed or a route-recall admission. "In the pool" was the first rule and it was measured worthless: the pool is
 *    a deliberately wide candidate set, so on wcp it rejected 72 of 383 links and admitted 252, seating an OAuth
 *    consent handler for a leave feature because a shared frontend API layer calls every backend. That was a
 *    category error — pool membership is low-precision candidate eligibility, borrowed as a high-consequence
 *    cross-module permit. The root set is the rescue premise itself: vocabulary is carried BY the calling site and
 *    handed to a backend that has none. A caller that only arrived by expansion carries no signal to hand on.
 *  - EXACTLY ONE round. A handler admitted here does not then propagate its own outgoing links; reaching further
 *    is a decision for the readings, not a default.
 *
 * WHAT IT IS NOT: not evidence, not a fact, and not a membership. A link earns a node the right to be CONSIDERED.
 */

export const CROSSREPO_RECALL_VERSION = "crossrepo-recall-v1";

/** Why one confirmed link did or did not admit anything. Closed: every confirmed link lands in exactly one. */
export type CrossrepoLinkOutcome =
  | "admitted"
  | "caller-not-in-pool"
  /** In the pool, but only via expansion — it carries no signal of its own, so it may not vouch. */
  | "caller-not-root"
  | "route-not-indexed"
  | "handler-unresolved";

export const CROSSREPO_LINK_OUTCOMES = ["admitted", "caller-not-in-pool", "caller-not-root", "handler-unresolved", "route-not-indexed"] as const;

export interface CrossrepoChannelEvidence {
  /** A backend route registration node, or its source-verified handler. */
  readonly nodeId: string;
  readonly rule: "R1" | "R2";
  readonly reason: string;
  /** The calling site that vouched, so a seat can be walked back to the call that reached it. */
  readonly anchor: string;
  /** The signal-carrying node that vouched, so the permit is auditable back to what earned it. */
  readonly callerRootNodeId: string;
  readonly propagationPath: readonly string[];
}

/** The pool as this channel needs to see it: identity plus the span that decides whether a call sits inside it. */
export interface PoolNodeRef {
  readonly nodeId: string;
  readonly relativePath: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

export type CrossrepoRecallTraceBlock =
  | {
      readonly status: "ran";
      readonly confirmedLinks: number;
      /** Counted and never admitted, so "we saw a maybe and declined it" is a recorded state. */
      readonly probableLinks: number;
      readonly byOutcome: Readonly<Record<CrossrepoLinkOutcome, number>>;
      readonly admittedNodeIds: readonly string[];
    }
  | {
      readonly status: "not-run";
      /**
       * `scan-unavailable` — the resolver could not run or threw; nothing was learned about this target.
       * `no-links`        — the scan ran and found none; that IS a determination about the target.
       * `no-inventory`    — the scan produced links but the route inventory is absent, so they cannot be joined.
       *
       * Collapsing the first into the second was the defect this list now prevents: a failed resolver published
       * "there are no cross-repo links here", which the next slice reads as "no cross-repo recall to gain".
       */
      readonly cause: "single-module" | "scan-unavailable" | "no-inventory" | "no-links";
    };

export interface CrossrepoRecallResult {
  readonly block: CrossrepoRecallTraceBlock;
  readonly admissionNodeIds: readonly string[];
  readonly evidence: readonly CrossrepoChannelEvidence[];
}

type ScanLink = CrossRepoScan["links"][number];

/**
 * Join a module-relative path onto its module directory.
 *
 * MEASURED, not assumed: on the frozen wcp corpus all 383 confirmed links carry module-relative paths on BOTH
 * ends — `src/api/account-service.ts` under `wcp-ui`, `internal/handlers/handlers.go` under `wcp-service-v2` —
 * and zero are target-relative. Getting this frame wrong does not raise an error; it drops every link into a
 * visible not-found bucket, and a reader would take the resulting silence as "this target has no cross-repo
 * recall to gain", which is the exact wrong conclusion for the slice after this one to draw.
 */
function targetRelative(moduleDirs: ReadonlyMap<string, string>, moduleId: string, modulePath: string): string | null {
  const dir = moduleDirs.get(moduleId);
  if (dir === undefined) return null;
  return dir.length ? `${dir}/${modulePath}` : modulePath;
}

/** Every pool node whose span contains this line. A node with no span contains nothing — treating it as covering
 *  its whole file would let one span-less entry vouch for everything in it. */
function containing(pool: readonly PoolNodeRef[], path: string, line: number): PoolNodeRef[] {
  return pool.filter((node) =>
    node.relativePath === path && node.startLine !== null && node.endLine !== null
    && line >= node.startLine && line <= node.endLine);
}

/**
 * Find the inventory row that recorded this link's backend route.
 *
 * BY COORDINATES, never by method and path. Two producers describe this route: the crossrepo scan recovered it
 * from source, and the index enumerated it. Matching on method+path would let the recovered route claim a
 * DIFFERENT registration that happens to serve the same path — and on this corpus several modules register the
 * same path — whereas a registration line identifies exactly one. If the coordinates agree and the method or path
 * does not, the two producers disagree about what is registered at that line, which is not a state to average
 * over: the caller throws rather than picking a side.
 */
function joinRoute(inventory: RouteInventory, registrationPath: string, registrationLine: number, localPath: string, method: string): InventoryRoute | null {
  const rows = inventory.routes.filter((route) => route.registrationPath === registrationPath && route.registrationLine === registrationLine);
  if (rows.length === 0) return null;
  // One line can register several routes: `router.route("/x").get(a).post(b)` produces two inventory rows sharing
  // coordinates and path, differing only by method. Taking the first would admit the wrong handler — precisely the
  // "average over a disagreement" this function refuses elsewhere. Method disambiguates; nothing else can.
  const row = rows.length === 1 ? rows[0]! : rows.find((candidate) => candidate.method !== null && candidate.method.toUpperCase() === method.toUpperCase());
  if (row === undefined) {
    throw new Error(`${registrationPath}:${registrationLine} registers ${rows.length} routes and none of them is ${JSON.stringify(method)}; a chained registration must be disambiguated by method rather than by position`);
  }
  // Compared against the scan's LOCAL path, not its composed one. The two producers describe the same route at
  // different levels of composition: the scan recovers `/v2/leaves/me` by walking group and mount prefixes, while
  // the index records `/me` — the path as literally written at the registration line. Measured the hard way, by
  // this very check firing on `handlers.go:106`. Comparing the composed path against the indexed one reports a
  // disagreement on every prefixed route in the corpus, which is not a disagreement at all.
  // Method as well as path. The comment used to promise both and the code checked only one — the same
  // one-dimension-short comparison as the composed-versus-local path mistake this guard was written for.
  if (row.method !== null && row.method.toUpperCase() !== method.toUpperCase()) {
    throw new Error(`the crossrepo scan and the route inventory disagree about ${registrationPath}:${registrationLine}: the scan recorded method ${JSON.stringify(method)} and the index ${JSON.stringify(row.method)}; two producers naming one registration line differently is not a state to average over`);
  }
  if (row.routePath !== null && row.routePath !== localPath) {
    throw new Error(`the crossrepo scan and the route inventory disagree about ${registrationPath}:${registrationLine}: the scan recorded the registration as ${JSON.stringify(localPath)} and the index as ${JSON.stringify(row.routePath)}; two producers naming one registration line differently is not a state to average over`);
  }
  return row;
}

/**
 * Propagate candidate eligibility across confirmed links.
 *
 * Deterministic: links are processed in a total order over their own coordinates, and the first claim on a node
 * wins, so the result does not depend on the scan's emission order.
 */
export function crossrepoRecall(
  /** `null` means the resolver failed or did not run — DISTINCT from an empty array, which is a real finding. */
  links: readonly ScanLink[] | null,
  inventory: RouteInventory | null,
  phase1Pool: readonly PoolNodeRef[],
  /**
   * The expansion roots: nodes that carried a direct signal (a lexical seed, or a route-recall admission).
   *
   * Only these may vouch. Not seats — at propagation time there are none, because the pool is allocated once
   * after both phases; and seats depend on budget competition, which would make recall move with a budget knob.
   * The root set is the pre-allocation form of the same idea and is budget-independent.
   */
  rootNodeIds: ReadonlySet<string>,
  moduleDirs: ReadonlyMap<string, string>
): CrossrepoRecallResult {
  if (moduleDirs.size < 2) return notRun("single-module");
  if (links === null) return notRun("scan-unavailable");
  if (inventory === null) return notRun("no-inventory");
  if (links.length === 0) return notRun("no-links");

  const confirmed = links.filter((link) => link.confidence === "confirmed");
  const probableLinks = links.length - confirmed.length;
  if (confirmed.length === 0) return notRun("no-links");

  const ordered = [...confirmed].sort((a, b) =>
    a.from.path.localeCompare(b.from.path) || a.from.line - b.from.line
    || a.to.module.localeCompare(b.to.module) || a.to.route.localeCompare(b.to.route));

  const byOutcome: Record<CrossrepoLinkOutcome, number> = { admitted: 0, "caller-not-in-pool": 0, "caller-not-root": 0, "handler-unresolved": 0, "route-not-indexed": 0 };
  const evidenceByNode = new Map<string, CrossrepoChannelEvidence>();

  for (const link of ordered) {
    // R3 is framework-shaped and `link-match` guarantees it is always `probable`, so a confirmed R3 means the
    // producer contradicted itself. Thrown rather than filed under a bucket whose name would be a lie — the same
    // house rule `joinRoute` follows for a producer disagreement.
    if (link.rule === "R3") {
      throw new Error(`a confirmed link carries rule R3 (${link.from.path}:${link.from.line}); link-match guarantees R3 is always probable, so this link contradicts its own producer`);
    }
    const rule = link.rule;

    const callerPath = targetRelative(moduleDirs, link.from.module, link.from.path);
    if (callerPath === null) {
      throw new Error(`link ${link.from.path}:${link.from.line} names module ${JSON.stringify(link.from.module)}, which is not in the module inventory; filing it under a caller bucket would report a resolver problem as a property of the caller`);
    }
    const holders = containing(phase1Pool, callerPath, link.from.line);
    if (holders.length === 0) { byOutcome["caller-not-in-pool"] += 1; continue; }

    // The innermost containing root, so the permit names the tightest signal that earned it.
    const roots = holders.filter((node) => rootNodeIds.has(node.nodeId))
      .sort((a, b) => (a.endLine! - a.startLine!) - (b.endLine! - b.startLine!) || a.nodeId.localeCompare(b.nodeId));
    const callerRoot = roots[0];
    if (callerRoot === undefined) { byOutcome["caller-not-root"] += 1; continue; }

    const routePath = targetRelative(moduleDirs, link.to.module, link.to.path);
    const row = routePath === null ? null : joinRoute(inventory, routePath, link.to.line, link.to.localPath, link.from.method);
    if (row === null) { byOutcome["route-not-indexed"] += 1; continue; }

    const anchor = `${callerPath}:${link.from.line}`;
    const label = `${row.method ?? "ANY"} ${row.routePath ?? link.to.route}`;
    claim(evidenceByNode, {
      nodeId: row.nodeId,
      rule,
      reason: `crossrepo-link ${label}`,
      anchor,
      callerRootNodeId: callerRoot.nodeId,
      propagationPath: [`${anchor}->link:${rule}`]
    });

    if (row.handlerResolution === "resolved" && row.handlerNodeId !== null) {
      claim(evidenceByNode, {
        nodeId: row.handlerNodeId,
        rule,
        reason: `crossrepo-handler ${label}`,
        anchor,
        callerRootNodeId: callerRoot.nodeId,
        propagationPath: [`${anchor}->link:${rule}`, `${row.factId}->handler`]
      });
      byOutcome.admitted += 1;
    } else {
      // The route is admitted for visibility; its handler is not, because the index's reference edge was not
      // confirmed against source. Recorded as its own outcome so the degrade is countable rather than invisible.
      byOutcome["handler-unresolved"] += 1;
    }
  }

  const total = Object.values(byOutcome).reduce((sum, count) => sum + count, 0);
  if (total !== confirmed.length) {
    throw new Error(`crossrepo recall accounted for ${total} of ${confirmed.length} confirmed links; every link must land in exactly one outcome or the receipt is describing a different set than it processed`);
  }

  const admissionNodeIds = [...evidenceByNode.keys()].sort();
  return {
    block: { status: "ran", confirmedLinks: confirmed.length, probableLinks, byOutcome: { ...byOutcome }, admittedNodeIds: admissionNodeIds },
    admissionNodeIds,
    evidence: admissionNodeIds.map((nodeId) => evidenceByNode.get(nodeId)!)
  };
}

function notRun(cause: Extract<CrossrepoRecallTraceBlock, { status: "not-run" }>["cause"]): CrossrepoRecallResult {
  return { block: { status: "not-run", cause }, admissionNodeIds: [], evidence: [] };
}

/** R1 (a literal path match) outranks R2 for the same node; otherwise the first claim stands. */
function claim(into: Map<string, CrossrepoChannelEvidence>, evidence: CrossrepoChannelEvidence): void {
  const prior = into.get(evidence.nodeId);
  if (prior === undefined || (prior.rule === "R2" && evidence.rule === "R1")) into.set(evidence.nodeId, evidence);
}

/** The recall value for a caller with no cross-repo scan — a single-module target, or a run before this channel. */
export const NO_CROSSREPO_RECALL: CrossrepoRecallResult = Object.freeze({
  block: Object.freeze({ status: "not-run", cause: "scan-unavailable" }) as CrossrepoRecallTraceBlock,
  admissionNodeIds: Object.freeze([]) as readonly string[],
  evidence: Object.freeze([]) as readonly CrossrepoChannelEvidence[]
});
