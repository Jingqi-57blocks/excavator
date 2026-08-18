import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphEdge, GraphNode } from "../src/base/types.ts";
import type { GraphReader, GraphRouteReference } from "../src/codegraph/codegraph.ts";
import { routeFactIdFor, routeInventory, routeObservations } from "../src/codegraph/route-inventory.ts";
import { tempDir } from "./helpers.ts";

function node(overrides: Partial<GraphNode> & Pick<GraphNode, "id" | "kind" | "name" | "filePath" | "startLine" | "endLine">): GraphNode {
  return {
    qualifiedName: overrides.name,
    language: "go",
    docstring: null,
    signature: null,
    ...overrides
  };
}

function reference(route: GraphNode, target: GraphNode, refName: string): GraphRouteReference {
  const edge: GraphEdge = {
    source: route.id,
    target: target.id,
    kind: "references",
    line: route.startLine,
    metadata: { refName, resolvedBy: "exact-match", confidence: 0.7 }
  };
  return { route, target, edge, column: 10 };
}

function reader(routes: readonly GraphNode[], references: readonly GraphRouteReference[]): GraphReader {
  const refuse = (): never => { throw new Error("route inventory fixture called an unrelated graph query"); };
  return {
    nodesByKindInFiles: (kinds: string[], files: string[]) => routes.filter((route) => kinds.includes(route.kind) && files.includes(route.filePath)),
    routeReferencesInFiles: (files: string[]) => references.filter((entry) => files.includes(entry.route.filePath)),
    metadata: refuse, files: refuse, summary: refuse, representativeNodes: refuse, routeSummary: refuse,
    searchNodes: refuse, searchNodesInFiles: refuse, expand: refuse, edgesAmong: refuse,
    unresolvedForNodeIds: refuse, stats: { queries: 0, hits: 0 }, close: () => {}
  } as unknown as GraphReader;
}

test("indexed routes trust source bindings, and every rejected or absent edge falls back visibly", async () => {
  const target = await tempDir("excavator-route-inventory-");
  const sources: Record<string, string> = {
    "routes/routes.go": [
      "package routes",
      "import (",
      "  \"fmt\"",
      "  leave \"example.test/app/handlers/leave\"",
      "  general \"example.test/app/handlers/general\"",
      ")",
      "func Register() {",
      "  r.GET(\"/demand\", leave.Demand)",
      "  r.PUT(\"/reject\", leave.Reject)",
      "  r.POST(\"/approve\", leave.Approve)",
      "  r.GET(\"/missing\", leave.Missing)",
      "  r.PUT(\"/other\", general.Reject)",
      "}"
    ].join("\n"),
    "handlers/leave/router.go": "package leave\nfunc Demand() {}\nfunc Reject() {}\nfunc Approve() {}\n",
    "handlers/general/router.go": "package general\nfunc Reject() {}\n",
    "models/leave.go": "package models\ntype Approve struct{}\n",
    "routes/checkout.js": [
      "import addCheckout, { createCheckoutSession } from '../handlers/checkout.js';",
      "import { fetchAllOrders as fetchOrders } from '../handlers/orders.js';",
      "app.post('/session', createCheckoutSession);",
      "app.post('/checkout', addCheckout);",
      "app.get('/orders', fetchOrders);"
    ].join("\n"),
    "handlers/checkout.js": "export async function createCheckoutSession() {}\nexport default async function addCheckout() {}\n",
    "handlers/orders.js": "export async function fetchAllOrders() {}\n"
  };
  for (const [path, content] of Object.entries(sources)) {
    await mkdir(join(target, path, ".."), { recursive: true });
    await writeFile(join(target, path), content);
  }

  const demandRoute = node({ id: "route-demand", kind: "route", name: "GET /demand", filePath: "routes/routes.go", startLine: 8, endLine: 8 });
  const rejectRoute = node({ id: "route-reject", kind: "route", name: "PUT /reject", filePath: "routes/routes.go", startLine: 9, endLine: 9 });
  const approveRoute = node({ id: "route-approve", kind: "route", name: "POST /approve", filePath: "routes/routes.go", startLine: 10, endLine: 10 });
  const missingRoute = node({ id: "route-missing", kind: "route", name: "GET /missing", filePath: "routes/routes.go", startLine: 11, endLine: 11 });
  const sessionRoute = node({ id: "route-session", kind: "route", name: "POST /session", filePath: "routes/checkout.js", startLine: 3, endLine: 3, language: "javascript" });
  const checkoutRoute = node({ id: "route-checkout", kind: "route", name: "POST /checkout", filePath: "routes/checkout.js", startLine: 4, endLine: 4, language: "javascript" });
  const ordersRoute = node({ id: "route-orders", kind: "route", name: "GET /orders", filePath: "routes/checkout.js", startLine: 5, endLine: 5, language: "javascript" });
  const demand = node({ id: "fn-demand", kind: "function", name: "Demand", filePath: "handlers/leave/router.go", startLine: 2, endLine: 2 });
  const wrongReject = node({ id: "fn-reject-wrong", kind: "function", name: "Reject", filePath: "handlers/general/router.go", startLine: 2, endLine: 2 });
  const approveType = node({ id: "type-approve", kind: "class", name: "Approve", filePath: "models/leave.go", startLine: 2, endLine: 2 });
  const session = node({ id: "fn-session", kind: "function", name: "createCheckoutSession", filePath: "handlers/checkout.js", startLine: 1, endLine: 1, language: "javascript" });
  const orders = node({ id: "fn-orders", kind: "function", name: "fetchAllOrders", filePath: "handlers/orders.js", startLine: 1, endLine: 1, language: "javascript" });

  const routes = [demandRoute, rejectRoute, approveRoute, missingRoute, sessionRoute, checkoutRoute, ordersRoute];
  const references = [
    reference(demandRoute, demand, "Demand"),
    reference(rejectRoute, wrongReject, "Reject"),
    reference(approveRoute, approveType, "Approve"),
    reference(sessionRoute, session, "createCheckoutSession"),
    reference(checkoutRoute, session, "addCheckout"),
    reference(ordersRoute, orders, "fetchOrders")
  ];
  const inventory = await routeInventory(reader(routes, references), Object.keys(sources), target);

  assert.equal(inventory.completeness.routesReturned, 7);
  assert.equal(inventory.completeness.handlerResolved, 3);
  assert.equal(inventory.completeness.handlerFallback, 4);
  assert.equal(inventory.completeness.byResolution.resolved, 3);
  assert.equal(inventory.completeness.byResolution["target-module-mismatch"], 1);
  assert.equal(inventory.completeness.byResolution["target-kind-not-callable"], 1,
    "an inventoried class is still not a callable handler");
  assert.equal(inventory.completeness.byResolution["target-export-mismatch"], 1);
  assert.equal(inventory.completeness.byResolution["no-reference"], 1);

  const byName = new Map(inventory.routes.map((route) => [route.name, route]));
  const verified = byName.get("GET /demand")!;
  assert.equal(verified.handlerResolved, true);
  assert.equal(verified.handlerFactId, "function:handlers/leave/router.go:2-2:Demand");
  assert.deepEqual(verified.anchor, { relativePath: "handlers/leave/router.go", startLine: 2, endLine: 2, unitKind: "function" });
  assert.equal(byName.get("GET /orders")!.handlerFactId, "function:handlers/orders.js:1-1:fetchAllOrders",
    "an aliased named import preserves the target export identity");
  for (const name of ["PUT /reject", "POST /approve", "GET /missing", "POST /checkout"]) {
    const fallback = byName.get(name)!;
    assert.equal(fallback.handlerResolved, false, name);
    assert.equal(fallback.anchor.relativePath, fallback.registrationPath, name);
    assert.equal(fallback.anchor.startLine, fallback.registrationLine, name);
    assert.equal(fallback.anchor.unitKind, null, name);
  }

  const observations = routeObservations(inventory);
  assert.equal(observations.length, routes.length);
  assert.ok(observations.every((observation) => observation.kind === "indexed-route"));
  assert.equal(observations.find((observation) => observation.detail.name === "PUT /reject")?.detail.handlerResolved, false);
  assert.equal(routeFactIdFor(demandRoute), "route:routes/routes.go:8-8:GET /demand");

  assert.deepEqual(await routeInventory(reader(routes, references), Object.keys(sources), target), inventory,
    "the same source and index rows produce byte-identical route facts");
});

test("multiple verified handler edges do not silently pick one", async () => {
  const target = await tempDir("excavator-route-multiple-");
  await writeFile(join(target, "app.js"), "function first() {}\nfunction second() {}\napp.get('/x', first, second);\n");
  const route = node({ id: "route", kind: "route", name: "GET /x", filePath: "app.js", startLine: 3, endLine: 3, language: "javascript" });
  const first = node({ id: "first", kind: "function", name: "first", filePath: "app.js", startLine: 1, endLine: 1, language: "javascript" });
  const second = node({ id: "second", kind: "function", name: "second", filePath: "app.js", startLine: 2, endLine: 2, language: "javascript" });
  const inventory = await routeInventory(reader([route], [reference(route, first, "first"), reference(route, second, "second")]), ["app.js"], target);
  assert.equal(inventory.routes[0]!.handlerResolution, "multiple-verified-references");
  assert.equal(inventory.routes[0]!.handlerResolved, false);
  assert.equal(inventory.routes[0]!.anchor.startLine, 3, "ambiguous edges fall back to the registration line");
});

test("Go handler identity follows the nearest go.mod rather than the checkout directory name", async () => {
  const target = await tempDir("excavator-route-go-module-");
  await mkdir(join(target, "review_service/handler/review"), { recursive: true });
  await writeFile(join(target, "review_service/go.mod"), "module example.test/wcp-review\n");
  await writeFile(join(target, "review_service/routes.go"), [
    "package service",
    "import review \"example.test/wcp-review/handler/review\"",
    "func Routes() { r.GET(\"/reviews\", review.List) }"
  ].join("\n"));
  await writeFile(join(target, "review_service/handler/review/router.go"), "package review\nfunc List() {}\n");
  const route = node({ id: "route", kind: "route", name: "GET /reviews", filePath: "review_service/routes.go", startLine: 3, endLine: 3 });
  const handler = node({ id: "handler", kind: "function", name: "List", filePath: "review_service/handler/review/router.go", startLine: 2, endLine: 2 });
  const withoutModuleInput = await routeInventory(reader([route], [reference(route, handler, "List")]), [
    "review_service/routes.go", "review_service/handler/review/router.go"
  ], target);
  assert.equal(withoutModuleInput.routes[0]!.handlerResolution, "target-module-mismatch",
    "a go.mod outside the counted corpus is not an invisible semantic input");
  const inventory = await routeInventory(reader([route], [reference(route, handler, "List")]), [
    "review_service/go.mod", "review_service/routes.go", "review_service/handler/review/router.go"
  ], target);
  assert.equal(inventory.routes[0]!.handlerResolution, "resolved");
  assert.equal(inventory.routes[0]!.handlerFactId, "function:review_service/handler/review/router.go:2-2:List");
});
