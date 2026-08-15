import test from "node:test";
import assert from "node:assert/strict";
import { extractFrontendCalls, normaliseTemplatePath, resolveBaseBindings } from "../src/crossrepo/frontend-calls.ts";

// Every binding form below is copied verbatim from the real target, because the failure this module exists
// to avoid is precisely a plausible-looking form that nobody writes. Measured there: 0 of 412 call sites
// use a plain string literal, and attributing bases by identifier name globally would misplace 17% of them.

const CLIENTS = ["httpClient", "authRequest"];

test("a plain destructure binds each identifier to its own config key", () => {
  const source = "const {\n  appRunnerApi \n} = config;";
  assert.deepEqual(resolveBaseBindings(source), [{ identifier: "appRunnerApi", configKey: "appRunnerApi", suffix: "", form: "destructure" }]);
});

// clientApi.ts: this file's `mainApi` is NOT the config's `mainApi`.
test("a renamed destructure binds the LOCAL name to the ORIGINAL key", () => {
  const source = "const {\n  appRunnerApi,\n  clientMainApi: mainApi\n} = config;";
  const bindings = resolveBaseBindings(source);
  assert.deepEqual(bindings.find((binding) => binding.identifier === "mainApi"), { identifier: "mainApi", configKey: "clientMainApi", suffix: "", form: "renamed" });
});

// performanceReviewApi.ts: same identifier as other files, different key, plus a derived base with a path.
test("an alias and a derived base are distinguished, and the derived one keeps its path segment", () => {
  const source = "const mainApi = config.performanceReviewMainApi;\nconst mainApiV2 = `${config.performanceReviewMainApi}/v2`;";
  const bindings = resolveBaseBindings(source);
  assert.deepEqual(bindings, [
    { identifier: "mainApi", configKey: "performanceReviewMainApi", suffix: "", form: "alias" },
    { identifier: "mainApiV2", configKey: "performanceReviewMainApi", suffix: "/v2", form: "derived" },
  ]);
});

test("the derived base's own segment is prepended to every route it serves", () => {
  const source = [
    "const mainApiV2 = `${config.performanceReviewMainApi}/v2`;",
    "export const list = () => httpClient.get(`${mainApiV2}/reviews`);",
  ].join("\n");
  const [call] = extractFrontendCalls("performanceReviewApi.ts", source, CLIENTS);
  assert.equal(call.baseKey, "performanceReviewMainApi");
  assert.equal(call.routePath, "/v2/reviews", "dropping the derived segment would point this call at the wrong route");
});

// common-service.ts: no local binding at all — 15 of the first 191 call sites take this form.
test("a config member inlined in the template needs no binding and is still fully resolved", () => {
  const source = "export const offices = () => httpClient.get(`${config.appRunnerApi}/v2/support/offices`);";
  const [call] = extractFrontendCalls("common-service.ts", source, CLIENTS);
  assert.equal(call.baseKey, "appRunnerApi");
  assert.equal(call.routePath, "/v2/support/offices");
  assert.equal(call.unresolvedReason, undefined);
});

test("the same identifier in two files resolves to two different keys", () => {
  const client = extractFrontendCalls("clientApi.ts", "const { clientMainApi: mainApi } = config;\nconst f = () => httpClient.get(`${mainApi}/x`);", CLIENTS);
  const review = extractFrontendCalls("performanceReviewApi.ts", "const mainApi = config.performanceReviewMainApi;\nconst f = () => httpClient.get(`${mainApi}/x`);", CLIENTS);
  assert.equal(client[0].baseKey, "clientMainApi");
  assert.equal(review[0].baseKey, "performanceReviewMainApi");
});

test("template holes become positional parameters and the query string is dropped", () => {
  const source = [
    "const { appRunnerApi } = config;",
    "export const thumb = (fileId: string) => httpClient.get(`${appRunnerApi}/v2/support/attachment/${fileId}/thumbnail`);",
    "export const projects = (status: number) => httpClient.get(`${appRunnerApi}/v2/projects/me?status=${status}`);",
  ].join("\n");
  const calls = extractFrontendCalls("common-service.ts", source, CLIENTS);
  assert.deepEqual(calls.map((call) => call.routePath), ["/v2/support/attachment/:p1/thumbnail", "/v2/projects/me"]);
});

test("a hole inside a segment cannot be matched positionally and is reported dynamic, not approximated", () => {
  assert.equal(normaliseTemplatePath("/leave-${type}s/list"), null);
  assert.equal(normaliseTemplatePath("/v2/leaves/${id}"), "/v2/leaves/:p1");
});

test("an unbound identifier is unresolved with a reason, never guessed", () => {
  const [call] = extractFrontendCalls("x.ts", "const f = () => httpClient.get(`${mysteryBase}/v2/thing`);", CLIENTS);
  assert.equal(call.routePath, null);
  assert.equal(call.unresolvedReason, "unknown-base");
  assert.equal(call.baseIdentifier, "mysteryBase", "the caller can still see what could not be resolved");
});

test("the method is recorded per call and extraction is byte-stable", () => {
  const source = [
    "const { appRunnerApi } = config;",
    "export const a = () => httpClient.post(`${appRunnerApi}/v2/leaves`, body);",
    "export const b = () => httpClient.delete(`${appRunnerApi}/v2/leaves/${id}`);",
  ].join("\n");
  const calls = extractFrontendCalls("leaveApi.ts", source, CLIENTS);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.routePath}`), ["POST /v2/leaves", "DELETE /v2/leaves/:p1"]);
  assert.equal(JSON.stringify(calls), JSON.stringify(extractFrontendCalls("leaveApi.ts", source, CLIENTS)));
});
