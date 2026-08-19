import test from "node:test";
import assert from "node:assert/strict";
import { alignHypothesis, alignPaths, pathSegments } from "../src/base/path-align.ts";
import { normalizeFeatureProfile } from "../src/base/feature-profile.ts";
import { NO_ROUTE_RECALL, routeRecall } from "../src/attribution/route-recall.ts";
import { allocateFeatureGraphRecorded } from "../src/attribution/allocator.ts";
import { ROUTE_INVENTORY_VERSION, type InventoryRoute, type RouteInventory } from "../src/codegraph/route-inventory.ts";

// THE STRUCTURAL RECALL CHANNEL.
//
// Every assertion here protects one of two things: that a hypothesis reaches code no word could have reached, and
// that it reaches ONLY that code. The second is the harder one — a channel that admits generously looks like it is
// working right up until it has quietly replaced the selection with its own neighbourhood.

function route(overrides: Partial<InventoryRoute> = {}): InventoryRoute {
  return {
    factId: `route:mod/router.go:1-1:GET ${overrides.routePath ?? "/leaves"}`,
    nodeId: "route-node",
    handlerNodeId: "handler-node",
    name: `GET ${overrides.routePath ?? "/leaves"}`,
    method: "GET",
    routePath: "/leaves",
    registrationPath: "mod/router.go",
    registrationLine: 1,
    handlerResolved: true,
    handlerResolution: "resolved",
    handlerFactId: "function:mod/handler.go:5-9:List",
    handlerName: "List",
    handlerPath: "mod/handler.go",
    handlerStartLine: 5,
    referenceName: "List",
    anchor: { relativePath: "mod/handler.go", startLine: 5, endLine: 9, unitKind: "function" },
    ...overrides
  };
}

function inventory(routes: InventoryRoute[]): RouteInventory {
  return {
    version: ROUTE_INVENTORY_VERSION,
    routes,
    completeness: { filesQueried: 1, routeLimit: 100, referenceLimit: 100, routesTruncated: false, referencesTruncated: false, byResolution: {} }
  } as unknown as RouteInventory;
}

function hypotheses(...patterns: Array<{ method?: string | null; pathPattern: string }>): ReturnType<typeof normalizeFeatureProfile>["possibleEntrypoints"] {
  return normalizeFeatureProfile({
    // `"method" in entry` rather than `??`: an EXPLICIT null means "any method" and must survive, while an omitted
    // method is just this helper's convenience default. `??` collapsed the two and made the null case untestable.
    possibleEntrypoints: patterns.map((entry) => ({ method: "method" in entry ? entry.method : "GET", pathPattern: entry.pathPattern, origin: "user" }))
  }, "k").possibleEntrypoints;
}

// A HYPOTHESIS IS A PATTERN, NOT A REQUEST.
//
// This is the measured one. Under call semantics — where a literal segment is legitimately absorbed by a route
// parameter, because `/leaves/me` really does reach `/leaves/:id` — the single-segment literal hypothesis
// `GET /remain-fully-paid-sick` matched 22 routes on the frozen wcp corpus: every `GET /:id`-shaped route across
// four modules, plus a catch-all in a module with no leave code at all. The stay-empty tripwire caught it.
test("a literal hypothesis segment is not absorbed by a route parameter", () => {
  assert.equal(alignPaths(pathSegments("/remain-fully-paid-sick"), pathSegments("/:id")), "parameterised",
    "call semantics absorb it — correct for a call, and the reason the pattern rule has to exist");
  assert.equal(alignHypothesis(pathSegments("/remain-fully-paid-sick"), pathSegments("/:id")), null,
    "pattern semantics refuse it");
});

test("pattern alignment matches parameters to parameters and literals to literals", () => {
  const cases: Array<[string, string, "exact" | "parameterised" | null]> = [
    ["/apply-prompt", "/apply-prompt", "exact"],
    [":leave_id/approve-prompt", "/:leave_id/approve-prompt", "parameterised"],
    ["/leaves/:id", "/leaves/:leave_id", "parameterised"],
    // A parameter cannot stand in for a literal either: `/leaves/:id` does not describe `/leaves/me`.
    ["/leaves/:id", "/leaves/me", null],
    ["/leaves", "/leaves/:id", null],
    // A catch-all handles everything, so claiming it says nothing about a specific endpoint.
    ["/apply-prompt", "/*any", null]
  ];
  for (const [hypothesis, target, expected] of cases) {
    assert.equal(alignHypothesis(pathSegments(hypothesis), pathSegments(target)), expected, `${hypothesis} vs ${target}`);
  }
});

test("a method the hypothesis names must match, and a null method matches any", () => {
  const inv = inventory([route({ method: "POST", routePath: "/leaves" })]);
  const missed = routeRecall(hypotheses({ method: "GET", pathPattern: "/leaves" }), inv);
  assert.equal(missed.admissionNodeIds.length, 0, "GET does not claim a POST route");
  const any = routeRecall(hypotheses({ method: null, pathPattern: "/leaves" }), inv);
  assert.ok(any.admissionNodeIds.length > 0, "a hypothesis with no method is a weaker claim, and it is honoured");
});

// HANDLER VERIFICATION IS NOT NEGOTIABLE.
//
// CodeGraph's `references` edge is a candidate, not an identity: measured wrong in 2 of 6 sampled leave routes,
// pointing once at a struct and once at a same-named function in a different module. Admitting an unverified
// target puts an unrelated cell one hop from a seat, and nothing downstream would say why it was there.
test("only a source-verified handler is admitted; the route stays visible either way", () => {
  const rejected = routeRecall(hypotheses({ pathPattern: "/leaves" }), inventory([
    route({ handlerResolution: "reference-name-mismatch", handlerResolved: false, handlerNodeId: null })
  ]));
  assert.deepEqual([...rejected.admissionNodeIds], ["route-node"], "the route node is admitted, its unverified handler is not");
  assert.equal(rejected.block.status === "ran" && rejected.block.hypotheses[0]!.outcome, "matched",
    "and the route is still reported as matched, so the degrade is legible rather than silent");
});

test("every hypothesis gets a row whether or not it matched", () => {
  const result = routeRecall(hypotheses({ pathPattern: "/leaves" }, { pathPattern: "/nowhere" }), inventory([route()]));
  assert.equal(result.block.status, "ran");
  if (result.block.status !== "ran") return;
  assert.deepEqual(result.block.hypotheses.map((row) => row.outcome), ["matched", "no-match"],
    "a hypothesis that found nothing is recorded as such — but read the module doc before reading it as a finding "
    + "about the target: no-match means the PATTERN did not align with a recorded registration, which can equally "
    + "be a spelling problem in the hypothesis");
});

test("no hypotheses and no inventory are distinguishable written states", () => {
  const none = routeRecall([], inventory([route()]));
  assert.deepEqual(none.block, { status: "not-run", cause: "no-hypotheses" });
  const blind = routeRecall(hypotheses({ pathPattern: "/leaves" }), null);
  assert.deepEqual(blind.block, { status: "not-run", cause: "no-route-inventory" });
});

// THE SEED-IDENTITY RED LINE, WHICH PROTECTS S1.
//
// `querySeedNodeIds` is the identity source for `attribution.seedCells`, and layer 5 reads that as "the query
// named this". A node this channel recalled was named by a HYPOTHESIS. Merging the two would relabel channel
// recall as query naming, and the only symptom would be a `seeded` fact-pack row nobody asked for.
test("route-recalled nodes never become query seeds", () => {
  const nodes = [
    { id: "handler-node", kind: "function", name: "List", filePath: "mod/handler.go", startLine: 5, endLine: 9 },
    { id: "lexical-node", kind: "function", name: "leaveThing", filePath: "mod/other.go", startLine: 1, endLine: 2 }
  ];
  const seeds = [nodes[1]!];
  const recall = { route: routeRecall(hypotheses({ pathPattern: "/leaves" }), inventory([route()])) };

  const recorded = allocateFeatureGraphRecorded(nodes, [], seeds, ["leave"], 10, recall);
  assert.equal(recorded.trace.status, "ran");
  if (recorded.trace.status !== "ran") return;

  assert.deepEqual([...recorded.trace.querySeedNodeIds], ["lexical-node"],
    "only the lexically matched node was named by the query");
  assert.ok(!recorded.trace.querySeedNodeIds.includes("handler-node"), "the recalled handler is not a query seed");

  const handler = recorded.trace.pool.find((node) => node.nodeId === "handler-node");
  assert.ok(handler, "the recalled handler is in the pool");
  assert.ok(handler.contributions.some((row) => row.sourceChannel === "route"), "and it carries a route contribution");
});

test("the recall block travels in the trace, including when the channel did not run", () => {
  const nodes = [{ id: "n1", kind: "function", name: "leaveThing", filePath: "mod/a.go", startLine: 1, endLine: 2 }];
  const recorded = allocateFeatureGraphRecorded(nodes, [], nodes, ["leave"], 10, NO_ROUTE_RECALL);
  assert.equal(recorded.trace.status, "ran");
  if (recorded.trace.status !== "ran") return;
  assert.deepEqual(recorded.trace.recall.route, { status: "not-run", cause: "no-hypotheses" },
    "a channel that did not run says so in the trace; an absent block would let it stop running unnoticed");
});

// The upgrade branch has exactly one reachable shape, and the first version of this test did not have it: on a
// SINGLE route, exact and parameterised are mutually exclusive, so deleting the upgrade left the test green. It is
// reachable only when two routes share one handler node — a literal route and a parameterised one both dispatching
// to the same function — where the handler is claimed twice with different rules.
test("a handler reached by both a literal and a parameterised route records the stronger rule", () => {
  const shared = inventory([
    route({ routePath: "/leaves/:id", factId: "route:mod/router.go:1-1:GET /leaves/:id", nodeId: "route-param" }),
    route({ routePath: "/leaves/mine", factId: "route:mod/router.go:2-2:GET /leaves/mine", nodeId: "route-literal" })
  ]);
  // Order chosen adversarially: the parameterised claim on the shared handler lands first.
  const result = routeRecall(hypotheses({ pathPattern: "/leaves/:x" }, { pathPattern: "/leaves/mine" }), shared);
  const handler = result.evidence.find((row) => row.nodeId === "handler-node");
  assert.ok(handler, "both routes dispatch to the same handler node, so it is claimed twice");
  assert.equal(handler.rule, "exact", "the literal route's claim outranks the parameterised one");
});
