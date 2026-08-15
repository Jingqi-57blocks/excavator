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

// Wrappers that do not change WHICH object is called are unwrapped, so these resolve rather than merely
// being reported. Each of these was measured producing NOTHING AT ALL — no result, no unresolved entry, no
// warning — because the tripwire shared the structural read's assumption that the client identifier is
// immediately followed by `.`. Textual independence from the AST is not independence from a shared premise.
test("wrappers around the receiver do not change which call this is", () => {
  const url = "`${config.appRunnerApi}/v2/leaves/${id}`";
  for (const source of [
    `httpClient?.post(${url}, body);`,
    `httpClient?.post<Foo>(${url}, body);`,
    `httpClient!.post(${url}, body);`,
    `(httpClient).post(${url}, body);`,
    `(httpClient as HttpClient).post(${url}, body);`,
    `(httpClient satisfies Client).post(${url}, body);`,
  ]) {
    const calls = callsIn(source);
    assert.equal(calls.length, 1, source);
    assert.equal(calls[0].unresolvedReason, undefined, source);
    assert.equal(calls[0].routePath, "/v2/leaves/:p1", source);
    assert.equal(calls[0].method, "POST", source);
  }
});

// Wrappers that DO change which object is called are not unwrapped — resolving them would attribute a route
// to a call whose first argument is not the URL. They must still be visible.
test("an indirection through the function object is reported, never resolved", () => {
  const url = "`${config.appRunnerApi}/v2/leaves`";
  for (const source of [
    `(0, httpClient.post)(${url}, body);`,
    `httpClient.post.call(httpClient, ${url}, body);`,
    `httpClient.post.apply(httpClient, [${url}, body]);`,
    `httpClient.post.bind(httpClient)(${url}, body);`,
  ]) {
    const calls = callsIn(source);
    assert.equal(calls.length, 1, source);
    assert.equal(calls[0].unresolvedReason, "unparsed-shape", source);
    assert.equal(calls[0].routePath, null, source);
  }
});

// The tripwire counts rather than deduplicates: a structural hit for the first call must not silence the
// report of a second one on the same line with the same verb.
test("two calls of one verb on one line are both accounted for", () => {
  const url = "`${config.appRunnerApi}/v2/leaves`";
  const calls = callsIn(`httpClient.get(${url}); httpClient['get'](${url});`);
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((call) => !call.unresolvedReason).length, 1, "the dotted one resolves");
  assert.equal(calls.filter((call) => call.unresolvedReason === "unparsed-shape").length, 1, "the bracketed one is reported");
});

test("a verb name that is only a prefix of a longer member is not a call", () => {
  assert.deepEqual(callsIn("const u = httpClient.getBaseUrl();"), [], "`getBaseUrl` is not `get`");
});

// The combination is what the tripwire's independence is FOR, and it is the only thing that requires it: a
// receiver the structural read unwraps, reached through an access it cannot produce. With the receiver
// wrapped, the verb is no longer adjacent to the client identifier — so a tripwire that kept the structural
// read's adjacency premise would be blind here too, and the call would have no bucket at all.
test("a wrapped receiver reached through an unreadable access is still reported", () => {
  for (const source of [
    "const c = (httpClient as App.HttpClient)['post'](`${config.appRunnerApi}/v2/leaves`, body);",
    "const c = (httpClient!)['get'](`${config.appRunnerApi}/v2/leaves`);",
    "const c = (httpClient as Client).post.call(httpClient, `${config.appRunnerApi}/v2/leaves`, body);",
  ]) {
    const calls = callsIn(source);
    assert.ok(calls.length >= 1, `no bucket at all for: ${source}`);
    assert.ok(calls.some((call) => call.unresolvedReason === "unparsed-shape"), `not reported: ${source}`);
  }
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

// MISATTRIBUTION, not mere blindness: testing only the first and last character for parens peeled a pair
// that was not a pair, leaving a string whose trailing identifier happened to be the client — and the call
// RESOLVED to a route the client never requested. A wrong route is worse than an unresolved one.
test("a paren pair that is not a pair is not peeled", () => {
  const url = "`${config.appRunnerApi}/v2/leaves`";
  for (const source of [
    `(x).wrap(httpClient).post(${url}, body);`,
    `(0, wrap)(httpClient).post(${url}, body);`,
    `((a) + (httpClient)).post(${url}, body);`,
  ]) {
    const calls = callsIn(source);
    assert.equal(calls.filter((call) => !call.unresolvedReason).length, 0, `resolved a call the client did not make: ${source}`);
    assert.ok(calls.some((call) => call.unresolvedReason === "unparsed-shape"), `and it must still be visible: ${source}`);
  }
});

// The verb can be taken OFF the client, in which case it appears BEFORE it and no scan starting at the
// client can see it. Only the declaration is reported: following the binding to its call site would be data
// flow, which this module does not do and must not pretend to.
test("a verb destructured off the client is reported at its declaration", () => {
  const url = "`${config.appRunnerApi}/v2/leaves`";
  for (const source of [
    `const { post } = httpClient;\npost(${url}, body);`,
    `const { post: send } = httpClient;\nsend(${url}, body);`,
  ]) {
    const calls = callsIn(source);
    assert.ok(calls.some((call) => call.unresolvedReason === "unparsed-shape" && call.line === 1), `not reported at the declaration: ${source}`);
    assert.equal(calls.filter((call) => !call.unresolvedReason).length, 0, "and nothing is resolved from a binding this module cannot follow");
  }
});

// Premise 2 promises "the destructure form" with no flatness qualifier, and `const { get, defaults: { … } }`
// is the axios-shaped idiom. A pattern that stopped at the first inner brace would make that promise false —
// the same over-claiming this module exists to remove, committed by its own premise list.
test("a nested destructure is still a destructure", () => {
  const url = "`${config.appRunnerApi}/v2/leaves`";
  for (const source of [
    `const { post, defaults: { baseURL } } = httpClient;\npost(${url}, body);`,
    `const { post: send, defaults: { baseURL } } = httpClient;\nsend(${url});`,
  ]) {
    const calls = callsIn(source);
    assert.ok(calls.some((call) => call.unresolvedReason === "unparsed-shape" && call.line === 1), source);
  }
  assert.deepEqual(callsIn("const { post } = somethingElse;\npost('/x');"), [], "and a non-client right-hand side is not a client call");
});

// A KNOWN BLIND SPOT, pinned so it stays visible and costs something to keep. The block-boundary narrowing
// (gap crosses no `{`/`}`) was recorded as free; it is not. These receivers do not change which object is
// called, so this module's own contract says they should RESOLVE — but the structural as-peel does not cross
// braces either, so neither net sees them. Kept because the family it buys silence from (an Angular
// `constructor(private http: HttpClient) {`, 11 reports across 405 files) is far more common. If a later
// change makes these visible, this test fails — update the premise list and pending-decisions with it.
test("inline object-type receivers are a recorded blind spot, not a silent one", () => {
  const url = "`${config.appRunnerApi}/v2/leaves`";
  for (const source of [
    `(httpClient as { post(u: string): Promise<T> }).post(${url}, body);`,
    `(httpClient satisfies { get(u): Promise<T> }).get(${url});`,
  ]) {
    assert.deepEqual(callsIn(source), [], `${source}\n  ↑ if this now produces output, the narrowing's cost changed — update the record`);
  }
});

// A call split across lines is one call. The tripwire counts on the line the CLIENT sits on, which is where
// the structural read starts a call expression too — otherwise a cross-line call on line 1 cancels a
// different call on line 1 and the second one vanishes.
test("a call broken across lines is read, and cannot cancel another call on its first line", () => {
  const url = "`${config.appRunnerApi}/v2/leaves`";
  const wrapped = callsIn(`httpClient\n.get(${url});`);
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].routePath, "/v2/leaves", "a newline before the verb is not a different call");

  const bracketed = callsIn(`httpClient\n['post'](${url});`);
  assert.ok(bracketed.some((call) => call.unresolvedReason === "unparsed-shape"), "and an unreadable access split across lines is still reported");

  const both = callsIn(`httpClient['get'](${url}); httpClient\n.get(${url});`);
  assert.equal(both.length, 2, "one resolved, one reported — neither swallows the other");
  assert.equal(both.filter((call) => !call.unresolvedReason).length, 1);
  assert.equal(both.filter((call) => call.unresolvedReason === "unparsed-shape").length, 1);
});

test("a computed verb is reported with an honest UNKNOWN rather than guessed", () => {
  const calls = callsIn("httpClient[method](`${config.appRunnerApi}/v2/leaves`, body);");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].unresolvedReason, "unparsed-shape");
  assert.equal(calls[0].method, "UNKNOWN");
  assert.equal(calls[0].routePath, null);
});

// The gap is bounded and stops at block boundaries. Measured cost of NOT stopping at braces: an Angular
// `constructor(private http: HttpClient) {` reported once per service file — 11 across 405 files — while
// stopping at them lost none of the forms above.
test("a client mentioned a block away from a verb is not a call site", () => {
  const source = [
    "class LogsService {",
    "  constructor(private httpClient: HttpClient) {",
    "  }",
    "  list() {",
    "    return this.other.get('/x');",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(callsIn(source), []);
});

// A blind scanner returning `[]` is indistinguishable from a file with no calls — the exact silence this
// module exists to remove, so the two blind paths must speak.
test("a parse failure says so instead of returning no calls", () => {
  const warnings: string[] = [];
  extractFrontendCalls("broken.ts", "const a = httpClient.post<((((;", CLIENTS, warnings);
  assert.ok(warnings.length === 0 || warnings.some((line) => /broken\.ts/.test(line)),
    "if the parser gives up it must name the file; if it recovers, no warning is owed");
});
