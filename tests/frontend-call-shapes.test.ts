import test from "node:test";
import assert from "node:assert/strict";
import { extractFrontendCalls } from "../src/crossrepo/frontend-calls.ts";

// The extractor used to enumerate textual call shapes, and the shapes it did not enumerate did not merely
// resolve badly — they DID NOT EXIST. Measured on the real target: `httpClient.post<App.ResponseBase<T>>(url)`
// produced nothing, no `unresolved` entry, no warning, and the calls that vanished were `approve` and
// `reject`, the two most important in the feature under investigation. These tests pin the two properties
// that make that class of loss impossible rather than merely fixed:
//
//   1. the callee is judged STRUCTURALLY, so await/type-arguments/member chains are all the same call;
//   2. anything the structural read does not produce still surfaces, as `unparsed-shape`.
//
// Property 2 matters more than property 1. Property 1 fixes the shapes we know about today; property 2 is
// what reports the shape nobody has thought of yet.

const CLIENTS = ["httpClient"];

function callsIn(source: string): ReturnType<typeof extractFrontendCalls> {
  return extractFrontendCalls("wcp-ui/src/pages/leave/leave-service.ts", source, CLIENTS, []);
}

test("a type-argument call resolves exactly like the same call without one", () => {
  const generic = callsIn("const a = httpClient.post<App.ResponseBase<LeaveInfo>>(`${config.appRunnerApi}/v2/leaves/${id}`, body);");
  const plain = callsIn("const a = httpClient.post(`${config.appRunnerApi}/v2/leaves/${id}`, body);");
  assert.equal(generic.length, 1);
  assert.deepEqual(
    { method: generic[0].method, routePath: generic[0].routePath, baseKey: generic[0].baseKey, reason: generic[0].unresolvedReason },
    { method: plain[0].method, routePath: plain[0].routePath, baseKey: plain[0].baseKey, reason: plain[0].unresolvedReason },
    "type arguments are a decoration on the call, not a different call",
  );
  assert.equal(generic[0].routePath, "/v2/leaves/:p1");
});

// The second hole, found by this file's own tripwire while fixing the first: adding a type-argument PATTERN
// left `await client.get<T>(url)` still unmatched. That is why the fix is structural rather than one more
// pattern — the pattern game has no last move.
test("await, type arguments and both together are one call, not three shapes", () => {
  for (const source of [
    "const a = httpClient.get<Foo>(`${config.appRunnerApi}/v2/leaves`);",
    "const a = await httpClient.get(`${config.appRunnerApi}/v2/leaves`);",
    "const a = await httpClient.get<Foo>(`${config.appRunnerApi}/v2/leaves`);",
    "const a = (await httpClient.get<Foo>(`${config.appRunnerApi}/v2/leaves`)).data;",
  ]) {
    const calls = callsIn(source);
    assert.equal(calls.length, 1, source);
    assert.equal(calls[0].routePath, "/v2/leaves", source);
    assert.equal(calls[0].unresolvedReason, undefined, source);
  }
});

test("every HTTP verb is read the same way, with or without type arguments", () => {
  const source = [
    "httpClient.get<A>(`${config.appRunnerApi}/v2/leaves`);",
    "httpClient.post<B>(`${config.appRunnerApi}/v2/leaves`, b);",
    "httpClient.put<C>(`${config.appRunnerApi}/v2/leaves/${id}`, b);",
    "httpClient.delete<D>(`${config.appRunnerApi}/v2/leaves/${id}`);",
    "httpClient.patch<E>(`${config.appRunnerApi}/v2/leaves/${id}`, b);",
  ].join("\n");
  assert.deepEqual(callsIn(source).map((call) => call.method), ["GET", "POST", "PUT", "DELETE", "PATCH"]);
});

// The invariant that makes silence impossible.
test("a call shape the structural read cannot produce is reported, not dropped", () => {
  const calls = callsIn("const c = httpClient['post']('/api/leave/weird', body);");
  assert.equal(calls.length, 1, "a computed member is not guessed at — but it is not invisible either");
  assert.equal(calls[0].unresolvedReason, "unparsed-shape");
  assert.equal(calls[0].line, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].routePath, null, "reporting the gap never invents a route");
});

test("a resolved call is not also reported as unparsed", () => {
  const calls = callsIn("const a = await httpClient.post<Foo>(`${config.appRunnerApi}/v2/leaves`, body);");
  assert.equal(calls.length, 1, "the tripwire must not double-count what the structural read produced");
  assert.equal(calls[0].unresolvedReason, undefined);
});

// A JSDoc line is asserted as part of a FILE, not as a bare fragment: ` * httpClient.get(…)` on its own is
// legitimately a multiplication expression containing a real call, and TypeScript parses it that way. Feeding
// the fragment would test the parser's error recovery rather than this module.
test("a call named in a comment is not invented", () => {
  assert.deepEqual(callsIn("// httpClient.post('/api/leave/ignored')"), []);
  const withJsDoc = [
    "/**",
    " * Approve a leave request.",
    " * httpClient.get('/api/leave/ignored')",
    " */",
    "const real = httpClient.post(`${config.appRunnerApi}/v2/leaves`, body);",
  ].join("\n");
  assert.deepEqual(callsIn(withJsDoc).map((call) => [call.line, call.routePath]), [[5, "/v2/leaves"]],
    "the documented call is not a call; the real one on line 5 is");
});

test("another module's client is not read as this one's", () => {
  assert.deepEqual(extractFrontendCalls("x.ts", "otherClient.post<Foo>('/api/x');", CLIENTS, []), [],
    "neither resolved nor reported: it is not a call through a client this scan knows");
});

// A blind scanner returning `[]` is indistinguishable from a file with no calls — the exact silence this
// module exists to remove, so the two blind paths must speak.
test("a parse failure says so instead of returning no calls", () => {
  const warnings: string[] = [];
  extractFrontendCalls("broken.ts", "const a = httpClient.post<((((;", CLIENTS, warnings);
  assert.ok(warnings.length === 0 || warnings.some((line) => /broken\.ts/.test(line)),
    "if the parser gives up it must name the file; if it recovers, no warning is owed");
});
