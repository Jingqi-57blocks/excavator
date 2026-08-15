import test from "node:test";
import assert from "node:assert/strict";
import { readObligations, type RouteHandlerObligation } from "../src/assurance/read-obligations.ts";
import { routeHandlerObligations } from "../src/crossrepo/crossrepo-artifact.ts";
import type { CrossRepoArtifact } from "../src/crossrepo/crossrepo-artifact.ts";
import type { FeatureFactPack } from "../src/core/types.ts";

// A backend handler normally lives in a different repository, so no boundary can reach it and no
// denominator can hold it — the frontend calls it and nothing accounts for reading it. That gap is what
// this third source closes, and the tests below pin the two ways it could close it dishonestly: by
// double-counting handlers the earlier sources already had, or by attributing a handler to a feature that
// never calls it.

function factPack(files: string[]): FeatureFactPack {
  return {
    version: "factpack-v1",
    snapshotId: "s",
    featureKey: "leave",
    items: files.map((filePath, index) => ({ category: "logic", name: `f${index}`, filePath, line: 10, endLine: 40 })) as never,
    coverage: [],
    warnings: [],
  };
}

function handler(overrides: Partial<RouteHandlerObligation> = {}): RouteHandlerObligation {
  return { featureKey: "leave", name: "Creation", path: "wcp-service-v2/internal/handlers/leave/router.go", startLine: 30, endLine: 37, route: "POST /v2/leaves", ...overrides };
}

test("a handler no earlier source enumerated becomes an obligation of its own kind", () => {
  const result = readObligations([factPack(["wcp-ui/src/api/leaveApi.ts"])], [], null, [handler()]);
  const route = result.obligations.filter((obligation) => obligation.kind === "route-handler");
  assert.equal(route.length, 1);
  assert.equal(route[0].name, "Creation");
  assert.equal(route[0].tier, 2);
  assert.equal(route[0].gated, false, "gating stays rescued-only");
  assert.equal(result.summary.routeSource?.added, 1);
});

test("a handler an earlier source already had is counted as duplicate, never twice", () => {
  const packs = [factPack(["wcp-service-v2/internal/handlers/leave/router.go"])];
  // The fact pack item above is at line 10; the handler is a different span in the same file.
  const same = handler({ startLine: 10 });
  const result = readObligations(packs, [], null, [same]);
  assert.equal(result.summary.routeSource?.duplicate, 1);
  assert.equal(result.summary.routeSource?.added, 0);
  assert.equal(result.obligations.filter((obligation) => obligation.kind === "route-handler").length, 0);
});

test("with no handlers supplied the output is byte-identical to the two-source denominator", () => {
  const packs = [factPack(["a.ts"])];
  const before = readObligations(packs, [], null);
  assert.equal(JSON.stringify(readObligations(packs, [], null, [])), JSON.stringify(before));
  assert.equal(JSON.stringify(readObligations(packs, [], null, null)), JSON.stringify(before));
  assert.equal(before.summary.routeSource, undefined, "the block is absent, not empty");
});

// Attribution runs from the CALL side: the backend file is in another repo and would never be in scope.
function artifact(fromPath: string): CrossRepoArtifact {
  return {
    version: "crossrepo-links-v1",
    snapshotId: "s",
    modules: [],
    clients: [],
    links: [{
      id: "xrl:1",
      kind: "http-route",
      from: { module: "wcp-ui", path: fromPath, line: 5, method: "POST", baseKey: "api", expression: "", routePath: "/v2/leaves" },
      to: { module: "wcp-service-v2", path: "internal/handlers/handlers.go", line: 98, route: "POST /v2/leaves", localPath: "", prefixComposed: true, handlerExpression: "e.CatchError(leave.Creation)" },
      resolution: "static",
      confidence: "confirmed",
      rule: "R1",
      evidenceIds: ["XR-a", "XR-b"],
    }],
    unresolved: [], ambiguous: [], candidates: [], routeRecovery: [],
    summary: { calls: 1, static: 1, framework: 0, unresolved: 0, ambiguous: 0, weak: 0, routes: 1 },
    warnings: [],
  } as unknown as CrossRepoArtifact;
}

const RESOLVE = () => ({ name: "Creation", path: "internal/handlers/leave/router.go", startLine: 30, endLine: 37 });

test("a handler is attributed to the feature whose boundary holds the CALL", () => {
  const inScope = routeHandlerObligations(artifact("src/api/leaveApi.ts"), "leave", new Set(["src/api/leaveApi.ts"]), RESOLVE);
  assert.deepEqual(inScope.map((entry) => `${entry.path}:${entry.startLine}`), ["wcp-service-v2/internal/handlers/leave/router.go:30"]);

  const outOfScope = routeHandlerObligations(artifact("src/api/other.ts"), "leave", new Set(["src/api/leaveApi.ts"]), RESOLVE);
  assert.deepEqual(outOfScope, [], "a call this feature never makes contributes no obligation to it");
});

test("a handler whose span could not be resolved contributes nothing", () => {
  const result = routeHandlerObligations(artifact("src/api/leaveApi.ts"), "leave", new Set(["src/api/leaveApi.ts"]), () => null);
  assert.deepEqual(result, [], "a registration line is one line long and would be excluded anyway");
});
