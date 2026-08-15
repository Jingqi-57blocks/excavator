import test from "node:test";
import assert from "node:assert/strict";
import { discoverClients, scanCrossRepoLinks } from "../src/crossrepo/crossrepo-scan.ts";

// Client recognition is structural on purpose. Hard-coding `httpClient`/`authRequest` would make the
// resolver work on exactly one codebase and silently produce nothing on the next one — the vertical
// neutrality guardrail, and the difference between a tool and a script for this repo.

test("an axios.create export is recognised as a client without being named in advance", () => {
  const files = [{ path: "src/common/request.ts", source: "export const spaceRequest = axios.create({ baseURL: '' });" }];
  assert.deepEqual(discoverClients(files), ["spaceRequest"]);
});

test("a hand-written fetch wrapper instance is recognised too", () => {
  const files = [{ path: "src/common/http-client.ts", source: "class HttpClient {}\nexport const httpClient = new HttpClient();" }];
  assert.deepEqual(discoverClients(files), ["httpClient"]);
});

test("an unrelated export is not mistaken for a client", () => {
  const files = [{ path: "x.ts", source: "export const config = new Config();\nexport const total = axios.get('/x');" }];
  assert.deepEqual(discoverClients(files), []);
});

test("a workspace with no modules scans to an empty result rather than failing", async () => {
  const scan = await scanCrossRepoLinks("/nonexistent-workspace", []);
  assert.deepEqual(scan.links, []);
  assert.deepEqual(scan.modules, []);
  assert.equal(scan.summary.calls, 0);
  assert.equal(scan.summary.routes, 0);
});

test("a module whose database cannot be opened degrades to a warning, not an exception", async () => {
  const scan = await scanCrossRepoLinks("/nonexistent-workspace", [
    { id: "svc", dir: "svc", databasePath: "/nonexistent-workspace/svc/.codegraph/codegraph.db" },
  ]);
  assert.equal(scan.links.length, 0);
  assert.equal(scan.routeRecovery.length, 1);
  assert.equal(scan.routeRecovery[0].recovered, 0);
  assert.ok(scan.warnings.some((warning) => /route discovery skipped/.test(warning)), `expected a visible degradation, got ${JSON.stringify(scan.warnings)}`);
});
