import test from "node:test";
import assert from "node:assert/strict";
import { matchCall, type RouteCandidate } from "../src/crossrepo/link-match.ts";
import type { FrontendCall } from "../src/crossrepo/frontend-calls.ts";

// The matcher decides what becomes an asserted fact about the system, so its two failure directions cost
// differently: a wrong link is a false claim in a report, a missed link is a gap a reader can still see in
// the unresolved list. It is therefore built to refuse rather than to approximate.

function call(method: string, routePath: string): FrontendCall {
  return { path: "src/api/x.ts", line: 1, method, baseIdentifier: "appRunnerApi", baseKey: "appRunnerApi", routePath, expression: "" };
}

function route(module: string, method: string, path: string): RouteCandidate {
  return { module, route: { method, path, localPath: path, handlerExpression: "h", file: "handlers.go", line: 1, framework: "gin" } };
}

test("every segment literal-equal is a confirmed static link", () => {
  const outcome = matchCall(call("POST", "/v2/leaves"), [route("wcp-service-v2", "POST", "/v2/leaves")]);
  assert.equal(outcome.kind, "matched");
  if (outcome.kind !== "matched") return;
  assert.equal(outcome.link.rule, "R1");
  assert.equal(outcome.link.resolution, "static");
  assert.equal(outcome.link.confidence, "confirmed");
});

test("a frontend hole opposite a route parameter is still a confirmed static link", () => {
  const outcome = matchCall(call("GET", "/v2/leaves/:p1"), [route("wcp-service-v2", "GET", "/v2/leaves/:leave_id")]);
  assert.equal(outcome.kind, "matched");
  if (outcome.kind !== "matched") return;
  assert.equal(outcome.link.rule, "R2");
  assert.equal(outcome.link.resolution, "static");
});

// A router tries a literal segment before a parameter; that precedence is a fact of the framework.
test("a literal route wins over a parameterised one, and the win is labelled framework", () => {
  const outcome = matchCall(call("GET", "/v2/leaves/me"), [
    route("wcp-service-v2", "GET", "/v2/leaves/:leave_id"),
    route("wcp-service-v2", "GET", "/v2/leaves/me"),
  ]);
  assert.equal(outcome.kind, "matched");
  if (outcome.kind !== "matched") return;
  assert.equal(outcome.link.route.path, "/v2/leaves/me");
  assert.equal(outcome.link.rule, "R1", "the exact match is taken directly, no precedence needed");
});

// Two routes that could both absorb the same call cannot be separated from source: gin refuses to register
// such a pair at all, and express decides by registration order, which this matcher does not model.
// "Fewest parameters" is a rule of thumb that demonstrably picks wrong — `/a/:x/:y` vs `/:z/b/c` for
// `/a/b/c` — so naming both is the only honest answer.
test("two parameterised candidates are ambiguous, never decided by a rule of thumb", () => {
  const outcome = matchCall(call("GET", "/a/b/c"), [
    route("m", "GET", "/a/:x/:y"),
    route("m", "GET", "/:z/b/c"),
  ]);
  assert.equal(outcome.kind, "ambiguous");
  if (outcome.kind !== "ambiguous") return;
  assert.deepEqual(outcome.candidates.map((entry) => entry.route).sort(), ["GET /:z/b/c", "GET /a/:x/:y"]);
});

// The one precedence both routers agree on and the source does show.
test("a literal segment still beats a parameter, and that is decided as an exact match", () => {
  const outcome = matchCall(call("GET", "/v2/leaves/me"), [
    route("m", "GET", "/v2/leaves/:leave_id"),
    route("m", "GET", "/v2/leaves/me"),
  ]);
  assert.equal(outcome.kind, "matched");
  if (outcome.kind !== "matched") return;
  assert.equal(outcome.link.route.path, "/v2/leaves/me");
  assert.equal(outcome.link.rule, "R1");
});

// A weak alignment named as "the backend for this path" would be a false statement, not a lead.
test("a weak alignment with a wrong method is not reported as a method mismatch", () => {
  const outcome = matchCall(call("DELETE", "/v2/prospa/comment/:p1"), [
    route("m", "GET", "/v2/prospa/:space_id/candidate"),
  ]);
  assert.equal(outcome.kind, "unresolved");
  if (outcome.kind !== "unresolved") return;
  assert.deepEqual(outcome.nearMisses, [], "an unrelated route must not be presented as this path's backend");
});

// The measured reason this rule exists: all four real instances were semantically wrong.
test("a frontend hole against a LITERAL backend segment is a weak candidate, never a link", () => {
  const outcome = matchCall(call("GET", "/v2/projects/:p1/feeds"), [route("m", "GET", "/v2/projects/plan/feeds")]);
  assert.equal(outcome.kind, "weak", "asserting this as a link would put a false claim in a report");
  if (outcome.kind !== "weak") return;
  assert.deepEqual(outcome.candidates, [{ module: "m", route: "GET /v2/projects/plan/feeds" }]);
});

test("the same path in two modules is ambiguous, with both candidates named", () => {
  const outcome = matchCall(call("GET", "/v2/support/projects"), [
    route("wcp-service-v2", "GET", "/v2/support/projects"),
    route("wcp_review_service", "GET", "/v2/support/projects"),
  ]);
  assert.equal(outcome.kind, "ambiguous");
  if (outcome.kind !== "ambiguous") return;
  assert.deepEqual(outcome.candidates.map((entry) => entry.module), ["wcp-service-v2", "wcp_review_service"]);
});

// "The frontend calls PATCH where the backend only serves GET" is a finding about the system.
test("a path that matches but a method that does not is a near miss, not a link", () => {
  const outcome = matchCall(call("PATCH", "/v2/employee/:p1/personal-information"), [
    route("wcp-service-v2", "GET", "/v2/employee/:employee_id/personal-information"),
  ]);
  assert.equal(outcome.kind, "unresolved");
  if (outcome.kind !== "unresolved") return;
  assert.deepEqual(outcome.nearMisses, [{ module: "wcp-service-v2", route: "GET /v2/employee/:employee_id/personal-information", mismatch: "method" }]);
});

test("an ANY registration serves any method, and says the match came from the framework", () => {
  const outcome = matchCall(call("DELETE", "/v2/thing"), [route("m", "ANY", "/v2/thing")]);
  assert.equal(outcome.kind, "matched");
  if (outcome.kind !== "matched") return;
  assert.equal(outcome.link.resolution, "framework");
});

test("a wildcard route absorbs the remainder of the path", () => {
  const outcome = matchCall(call("GET", "/v2/swagger/index.html"), [route("m", "GET", "/v2/swagger/*any")]);
  assert.equal(outcome.kind, "matched");
});

test("nothing is lenient: case and trailing slash differences do not match", () => {
  assert.equal(matchCall(call("GET", "/v2/Leaves"), [route("m", "GET", "/v2/leaves")]).kind, "unresolved");
  assert.equal(matchCall(call("GET", "/v2/leaves/extra"), [route("m", "GET", "/v2/leaves")]).kind, "unresolved");
});

test("a call whose own path could not be resolved never matches anything", () => {
  const dynamic: FrontendCall = { ...call("GET", "/x"), routePath: null, unresolvedReason: "dynamic" };
  assert.equal(matchCall(dynamic, [route("m", "GET", "/x")]).kind, "unresolved");
});

test("matching is byte-stable regardless of candidate order", () => {
  const candidates = [route("b", "GET", "/v2/a/:x"), route("a", "GET", "/v2/a/:x")];
  const forward = matchCall(call("GET", "/v2/a/:p1"), candidates);
  const reversed = matchCall(call("GET", "/v2/a/:p1"), [...candidates].reverse());
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});
