import test from "node:test";
import assert from "node:assert/strict";
import {
  CROSSREPO_LINK_OUTCOMES, crossrepoRecall, NO_CROSSREPO_RECALL,
  type CrossrepoLinkOutcome, type PoolNodeRef
} from "../src/attribution/crossrepo-recall.ts";
import { ROUTE_INVENTORY_VERSION, type InventoryRoute, type RouteInventory } from "../src/codegraph/route-inventory.ts";
import type { CrossRepoScan } from "../src/crossrepo/crossrepo-scan.ts";

// CROSS-MODULE RECALL: A CALLER IN THE POOL VOUCHES FOR THE HANDLER IT REACHES.
//
// Two properties are protected here. That a confirmed link can carry candidate eligibility across a vocabulary
// gap — and that it carries it no further than one hop from something already in the pool. The second is what
// separates recall from replacing the selection with the whole API surface: this corpus has 383 confirmed links,
// and admitting them unconditionally would seat most of the backend for any feature at all.

const MODULES = new Map([["wcp-ui", "wcp-ui"], ["wcp-service-v2", "wcp-service-v2"]]);

type ScanLink = CrossRepoScan["links"][number];

/**
 * A confirmed link, with per-end overrides MERGED rather than replacing the end.
 *
 * The first version spread `...overrides` last, which put the partial `from`/`to` back over the merged ones and
 * dropped whatever the caller had not restated — a `{ to: { route } }` override lost `path` and `line` entirely.
 * Several tests below then passed for the wrong reason: a malformed link landed in the bucket they expected
 * because its coordinates were `undefined`, not because the rule under test had fired. Destructuring the two ends
 * out first is what makes each test's stated reason its actual reason.
 */
function link(overrides: { from?: Partial<ScanLink["from"]>; to?: Partial<ScanLink["to"]> } & Partial<Omit<ScanLink, "from" | "to">> = {}): ScanLink {
  const { from, to, ...rest } = overrides;
  return {
    from: { module: "wcp-ui", path: "src/api/leave.ts", line: 18, method: "GET", baseKey: null, expression: "api.get(...)", routePath: "/v2/leaves/me", ...from },
    to: { module: "wcp-service-v2", path: "internal/handlers/handlers.go", line: 110, route: "GET /v2/leaves/me", localPath: "/v2/leaves/me", prefixComposed: true, handlerExpression: "e.CatchError(leave.Own)", ...to },
    resolution: "static",
    confidence: "confirmed",
    rule: "R1",
    ...rest
  } as ScanLink;
}

function route(overrides: Partial<InventoryRoute> = {}): InventoryRoute {
  return {
    factId: "route:wcp-service-v2/internal/handlers/handlers.go:110-110:GET /me",
    nodeId: "route-node",
    handlerNodeId: "handler-node",
    name: "GET /me",
    method: "GET",
    routePath: "/v2/leaves/me",
    registrationPath: "wcp-service-v2/internal/handlers/handlers.go",
    registrationLine: 110,
    handlerResolved: true,
    handlerResolution: "resolved",
    handlerFactId: "function:wcp-service-v2/internal/handlers/leave/router.go:5-9:Own",
    handlerName: "Own",
    handlerPath: "wcp-service-v2/internal/handlers/leave/router.go",
    handlerStartLine: 5,
    referenceName: "Own",
    anchor: { relativePath: "wcp-service-v2/internal/handlers/leave/router.go", startLine: 5, endLine: 9, unitKind: "function" },
    ...overrides
  };
}

function inventory(routes: InventoryRoute[]): RouteInventory {
  return { version: ROUTE_INVENTORY_VERSION, routes, completeness: {} } as unknown as RouteInventory;
}

/** The caller's own file, in the pool, with a span that contains the calling line. */
const CALLER_IN_POOL: PoolNodeRef[] = [{ nodeId: "caller", relativePath: "wcp-ui/src/api/leave.ts", startLine: 10, endLine: 30 }];

/** Treat every pool node as a root, for the cases that are not about the root gate itself. */
function rootsOf(pool: readonly PoolNodeRef[]): ReadonlySet<string> {
  return new Set(pool.map((node) => node.nodeId));
}

test("a confirmed link admits the backend route and its verified handler", () => {
  const result = crossrepoRecall([link()], inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES);
  assert.equal(result.block.status, "ran");
  if (result.block.status !== "ran") return;

  assert.deepEqual([...result.admissionNodeIds].sort(), ["handler-node", "route-node"]);
  assert.equal(result.block.byOutcome.admitted, 1);

  const handler = result.evidence.find((row) => row.nodeId === "handler-node")!;
  assert.equal(handler.anchor, "wcp-ui/src/api/leave.ts:18", "the anchor names the call that vouched");
  assert.deepEqual(handler.propagationPath, ["wcp-ui/src/api/leave.ts:18->link:R1", `${route().factId}->handler`],
    "both hops are recorded, so a seat can be walked back through the link to the caller");
});

// PROBABLE IS NEVER ADMITTED — and this corpus cannot test it.
//
// Measured on the frozen wcp corpus: 383 confirmed links and ZERO probable ones. So the rule that matters most for
// precision has no real-data case at all, and a synthetic fixture is not a convenience here but the only way to
// pin it. `probable` covers framework-shaped and ANY-method matches, which the crossrepo scan already declines to
// assert as links; admitting them would launder a maybe into a candidate.
test("a probable link is counted and never admitted", () => {
  const result = crossrepoRecall([link({ confidence: "probable", resolution: "framework", rule: "R3" })], inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES);
  assert.deepEqual(result.block, { status: "not-run", cause: "no-links" },
    "with nothing confirmed there is no propagation to run — and the reason is recorded");
  assert.deepEqual([...result.admissionNodeIds], []);

  // `probable` WITH RULE R1 — the shape production actually produces and the shape the corpus cannot supply.
  // `link-match` marks an ANY-method route's exact match as R1 + probable, so a regression that hard-codes
  // "probable ⟺ R3" would pass every other test here and admit a probable R1 in production. Everything except
  // confidence is satisfied: caller inside a root span, route joinable, handler resolved.
  const probableR1 = link({ confidence: "probable", from: { path: "src/api/leave.ts", line: 20 } });
  const isolated = crossrepoRecall([probableR1], inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES);
  assert.deepEqual(isolated.block, { status: "not-run", cause: "no-links" }, "a probable R1 is still not a confirmed link");
  assert.deepEqual([...isolated.admissionNodeIds], [], "and it admits nothing despite satisfying every other condition");

  const mixed = crossrepoRecall(
    [link(), probableR1],
    inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES
  );
  assert.equal(mixed.block.status, "ran");
  if (mixed.block.status !== "ran") return;
  assert.equal(mixed.block.confirmedLinks, 1);
  assert.equal(mixed.block.probableLinks, 1, "the maybe is counted, so declining it is visible rather than silent");
  assert.equal(mixed.block.byOutcome.admitted, 1, "and only the confirmed one propagated");
});

// THE POOL GATE. Without it, one feature's selection becomes the API surface.
test("a link whose caller is not in the pool admits nothing", () => {
  const elsewhere: PoolNodeRef[] = [{ nodeId: "other", relativePath: "wcp-ui/src/api/billing.ts", startLine: 1, endLine: 100 }];
  const result = crossrepoRecall([link()], inventory([route()]), elsewhere, rootsOf(elsewhere), MODULES);
  assert.equal(result.block.status === "ran" && result.block.byOutcome["caller-not-in-pool"], 1);
  assert.deepEqual([...result.admissionNodeIds], []);
});

test("a caller inside the right file but outside every pool span does not vouch", () => {
  const narrow: PoolNodeRef[] = [{ nodeId: "caller", relativePath: "wcp-ui/src/api/leave.ts", startLine: 40, endLine: 60 }];
  const result = crossrepoRecall([link()], inventory([route()]), narrow, rootsOf(narrow), MODULES);
  assert.equal(result.block.status === "ran" && result.block.byOutcome["caller-not-in-pool"], 1,
    "line 18 is not inside 40-60; a file-level match would let any pool entry vouch for its whole file");
});

test("a pool node with no span cannot contain a call", () => {
  const spanless: PoolNodeRef[] = [{ nodeId: "caller", relativePath: "wcp-ui/src/api/leave.ts", startLine: null, endLine: null }];
  const result = crossrepoRecall([link()], inventory([route()]), spanless, rootsOf(spanless), MODULES);
  assert.equal(result.block.status === "ran" && result.block.byOutcome["caller-not-in-pool"], 1);
});

// THE ROOT GATE — the permit that "in the pool" was measured too weak to be.
//
// Pool membership rejected 72 of 383 confirmed links on the frozen corpus and admitted 252, seating an OAuth
// consent handler for a leave feature: a shared frontend API layer calls every backend, and the pool is a
// deliberately wide candidate set, so almost any frontend file satisfied it. That was a category error — candidate
// eligibility borrowed as a cross-module permit.
//
// A root carried a direct signal: a lexical seed, or a route-recall admission. That is the rescue premise itself
// — the caller has vocabulary and hands it to a backend that has none. A caller that only arrived by expansion has
// no signal to hand on, so it may not vouch.
test("a caller that entered only by expansion may not vouch", () => {
  const expandedOnly: PoolNodeRef[] = [{ nodeId: "expanded", relativePath: "wcp-ui/src/api/leave.ts", startLine: 10, endLine: 30 }];
  const result = crossrepoRecall([link()], inventory([route()]), expandedOnly, new Set<string>(), MODULES);
  assert.equal(result.block.status === "ran" && result.block.byOutcome["caller-not-root"], 1,
    "it is in the pool, so it is not `caller-not-in-pool` — it is in the pool without having earned the right to vouch");
  assert.deepEqual([...result.admissionNodeIds], []);
});

// THE MEASURED NEGATIVE ANCHOR. This exact link is real, confirmed, and correctly resolved — and it is exactly
// what must NOT propagate: an auth-service file calling an auth endpoint, for a leave feature. It stands here so
// the boundary that S2's stay-empty gate defends has a permanent, named guard.
//
// Cross-repo reachability is not feature membership. A shared API layer reaches every backend; if reachability
// could flip a stay-empty module, then in any connected system the stay-empty set is empty by definition and the
// false-positive gate fails by construction.
test("a shared auth client in the pool does not pull the auth service into a leave feature", () => {
  const authLink = link({
    from: { module: "wcp-ui", path: "src/pages/auth/auth-service.ts", line: 83, routePath: "/consent" },
    to: { module: "wcp-auth", path: "internal/handlers/handler.go", line: 39, route: "GET /consent", localPath: "/consent" }
  });
  const authRoute = route({
    factId: "route:wcp-auth/internal/handlers/handler.go:39-39:GET /consent",
    nodeId: "auth-route", handlerNodeId: "auth-handler",
    routePath: "/consent", registrationPath: "wcp-auth/internal/handlers/handler.go", registrationLine: 39
  });
  // In the pool by expansion — as it really was — but not a root: nothing about the leave query named it.
  const pool: PoolNodeRef[] = [{ nodeId: "auth-client", relativePath: "wcp-ui/src/pages/auth/auth-service.ts", startLine: 70, endLine: 120 }];
  const result = crossrepoRecall([authLink], inventory([authRoute]), pool, new Set<string>(), new Map([["wcp-ui", "wcp-ui"], ["wcp-auth", "wcp-auth"]]));

  assert.deepEqual([...result.admissionNodeIds], [], "the link is real; its relevance to this feature is not");
  assert.equal(result.block.status === "ran" && result.block.byOutcome["caller-not-root"], 1);
});

// Every admitted claim names the root that earned it, so the permit is auditable rather than asserted.
test("each admission records the innermost root that vouched for it", () => {
  const outer: PoolNodeRef = { nodeId: "outer", relativePath: "wcp-ui/src/api/leave.ts", startLine: 1, endLine: 100 };
  const inner: PoolNodeRef = { nodeId: "inner", relativePath: "wcp-ui/src/api/leave.ts", startLine: 15, endLine: 25 };
  const result = crossrepoRecall([link()], inventory([route()]), [outer, inner], new Set(["outer", "inner"]), MODULES);
  for (const evidence of result.evidence) {
    assert.equal(evidence.callerRootNodeId, "inner", "the tightest containing root is the one that earned the permit");
  }
});

// THE COORDINATE JOIN. Measured: all 383 confirmed links carry module-relative paths on both ends, so the join
// prefixes the module directory. Getting the frame wrong raises nothing — it empties the channel silently.
test("the join is by registration coordinates, not by method and path", () => {
  // Same method and path, different registration line: a fuzzy join would claim it, and several modules on this
  // corpus register the same path.
  const elsewhere = inventory([route({ registrationLine: 999 })]);
  const result = crossrepoRecall([link()], elsewhere, CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES);
  assert.equal(result.block.status === "ran" && result.block.byOutcome["route-not-indexed"], 1);
  assert.deepEqual([...result.admissionNodeIds], []);
});

test("module-relative paths are joined onto their module directory", () => {
  // The inventory records target-relative paths. A propagator that compared `internal/handlers/handlers.go`
  // against `wcp-service-v2/internal/handlers/handlers.go` would find nothing, on every single link.
  const result = crossrepoRecall([link()], inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES);
  assert.equal(result.block.status === "ran" && result.block.byOutcome.admitted, 1,
    "the frame is module-relative on both ends; a target-relative reading empties the channel and looks like a target with no cross-repo recall to gain");
});

// A CHAINED REGISTRATION PUTS SEVERAL ROUTES ON ONE LINE.
//
// `router.route("/x").get(a).post(b)` yields two inventory rows sharing coordinates and path, differing only by
// method. Taking the first by position would admit the wrong handler — the same "average over a disagreement"
// the guard below refuses. Method is the only thing that separates them.
test("a line registering several routes is disambiguated by method, never by position", () => {
  const chained = inventory([
    route({ factId: "route:mod/router.go:1-1:GET /leaves", nodeId: "get-route", handlerNodeId: "get-handler", method: "GET" }),
    route({ factId: "route:mod/router.go:1-1:POST /leaves", nodeId: "post-route", handlerNodeId: "post-handler", method: "POST" })
  ]);
  const post = crossrepoRecall([link({ from: { method: "POST" } })], chained, CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES);
  assert.deepEqual([...post.admissionNodeIds].sort(), ["post-handler", "post-route"], "the POST call reaches the POST handler");

  // A method NOTHING on that line registers is a producer disagreement, not a missing index row: rows exist at
  // those coordinates, they just do not include this one. `route-not-indexed` would be the wrong bucket — it
  // means "no row at these coordinates" — and picking whichever row came first is the failure this guards.
  assert.throws(
    () => crossrepoRecall([link({ from: { method: "DELETE" } })], chained, CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES),
    /registers 2 routes and none of them is "DELETE"/
  );
});

test("a method disagreement about one registration line is fatal, like a path disagreement", () => {
  assert.throws(
    () => crossrepoRecall([link({ from: { method: "PUT" } })], inventory([route({ method: "GET" })]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES),
    /disagree about/
  );
});

// TWO PRODUCERS, ONE REGISTRATION LINE. If they disagree, neither answer is safe to prefer.
test("a scan and inventory disagreement about one registration line is fatal", () => {
  assert.throws(
    // `localPath`, not `route`: the scan's `route` is the COMPOSED path (group prefixes applied) and the index
    // records the local one, so those two legitimately differ on every prefixed route. Comparing them was this
    // test's first version, and the frozen corpus rejected it at `handlers.go:106` — the guard was right and the
    // pair was wrong.
    () => crossrepoRecall([link({ to: { localPath: "/somewhere-else" } })], inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES),
    /disagree about/
  );
});

// An unverified handler leaves the route admitted for visibility and the handler out. Same rule as the route
// channel, and the same measured reason: the index's reference edge was wrong in 2 of 6 sampled leave routes.
test("an unresolved handler admits the route only, in its own outcome bucket", () => {
  const result = crossrepoRecall([link()], inventory([route({ handlerResolution: "target-module-mismatch", handlerResolved: false, handlerNodeId: null })]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES);
  assert.deepEqual([...result.admissionNodeIds], ["route-node"]);
  assert.equal(result.block.status === "ran" && result.block.byOutcome["handler-unresolved"], 1);
  assert.equal(result.block.status === "ran" && result.block.byOutcome.admitted, 0);
});

// EXACTLY ONE ROUND. A handler admitted by a link does not then propagate its own outgoing links.
test("propagation does not chain through a handler it just admitted", () => {
  const first = link();
  // A second link whose caller is the handler admitted by the first. Under one-round propagation its caller is
  // not in the PHASE-1 pool, so it must not fire; reaching further is a decision for the readings, not a default.
  const chained = link({
    from: { module: "wcp-service-v2", path: "internal/handlers/leave/router.go", line: 6, routePath: "/v2/other" },
    to: { module: "wcp-ui", path: "src/thing.ts", line: 3, route: "GET /v2/other" }
  });
  const result = crossrepoRecall([first, chained], inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES);
  assert.equal(result.block.status, "ran");
  if (result.block.status !== "ran") return;
  assert.equal(result.block.byOutcome["caller-not-in-pool"], 1, "the chained link's caller is not in the phase-1 pool");
  assert.deepEqual([...result.admissionNodeIds].sort(), ["handler-node", "route-node"], "and nothing beyond the first hop was admitted");
});

// EVERY CONFIRMED LINK LANDS IN EXACTLY ONE BUCKET. The constructor enforces it; this proves the enforcement is
// reachable and that the enumeration is total rather than merely summing to itself.
test("the outcome buckets account for every confirmed link", () => {
  const links = [
    link(),
    link({ from: { path: "src/api/nowhere.ts" } }),
    link({ from: { path: "src/api/leave.ts", line: 19 }, to: { line: 999 } })
  ];
  const result = crossrepoRecall(links, inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES);
  assert.equal(result.block.status, "ran");
  if (result.block.status !== "ran") return;
  const byOutcome = result.block.byOutcome;
  const total = CROSSREPO_LINK_OUTCOMES.reduce((sum, outcome: CrossrepoLinkOutcome) => sum + byOutcome[outcome], 0);
  assert.equal(total, result.block.confirmedLinks);
  assert.deepEqual(Object.keys(byOutcome).sort(), [...CROSSREPO_LINK_OUTCOMES].sort(), "no bucket is missing from the receipt");
});

test("single-module, missing scan and no links are three distinguishable written states", () => {
  assert.deepEqual(crossrepoRecall([link()], inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), new Map([["only", ""]])).block,
    { status: "not-run", cause: "single-module" });
  assert.deepEqual(crossrepoRecall(null, inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES).block,
    { status: "not-run", cause: "scan-unavailable" }, "the resolver failed: nothing was learned about this target");
  assert.deepEqual(crossrepoRecall([link()], null, CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES).block,
    { status: "not-run", cause: "no-inventory" }, "links exist but cannot be joined — not the same as having none");
  assert.deepEqual(crossrepoRecall([], inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES).block,
    { status: "not-run", cause: "no-links" });
  assert.deepEqual(crossrepoRecall([], inventory([route()]), CALLER_IN_POOL, rootsOf(CALLER_IN_POOL), MODULES).block,
    { status: "not-run", cause: "no-links" }, "the scan ran and found none — a determination about the target");
  assert.deepEqual(NO_CROSSREPO_RECALL.block, { status: "not-run", cause: "scan-unavailable" });
});

test("the result does not depend on the order the scan emitted links", () => {
  const links = [link(), link({ from: { path: "src/api/aaa.ts", line: 12 } })];
  const pool: PoolNodeRef[] = [...CALLER_IN_POOL, { nodeId: "caller2", relativePath: "wcp-ui/src/api/aaa.ts", startLine: 1, endLine: 50 }];
  const forward = crossrepoRecall(links, inventory([route()]), pool, rootsOf(pool), MODULES);
  const reversed = crossrepoRecall([...links].reverse(), inventory([route()]), pool, rootsOf(pool), MODULES);
  assert.deepEqual([...forward.admissionNodeIds], [...reversed.admissionNodeIds]);
  assert.deepEqual(forward.evidence.map((row) => row.anchor), reversed.evidence.map((row) => row.anchor));
});
