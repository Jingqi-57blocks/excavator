import test from "node:test";
import assert from "node:assert/strict";
import { FILE_ROOTS_BASIS } from "../src/base/coverage-basis.ts";
import { crossRepoDetermination, type CrossRepoModule } from "../src/crossrepo/crossrepo-facts.ts";
import type { CrossRepoScan } from "../src/crossrepo/crossrepo-scan.ts";

const COMPLETE = { capReached: false, skippedByCap: 0, droppedRoots: [] as string[], readFailures: 0 };

function roots(...names: string[]) {
  return names.map((name) => ({ name, candidateSource: "git-ls-files", candidates: 10, counted: 10, dropped: false }));
}

function modules(...ids: string[]): CrossRepoModule[] {
  return ids.map((id) => ({ id, dir: id }));
}

function determine(options: {
  roots: ReturnType<typeof roots>;
  modules?: CrossRepoModule[] | null;
  scan?: CrossRepoScan | null;
  completeness?: typeof COMPLETE;
}) {
  return crossRepoDetermination({
    ledgerRoots: options.roots,
    modules: options.modules ?? null,
    resolverAvailable: true,
    scan: options.scan ?? null,
    ledgerCompleteness: options.completeness ?? COMPLETE,
    mechanismCoverage: { fixture: "complete" }
  });
}

test("a multi-root target is never called single-module when CodeGraph is absent", () => {
  const withoutIndex = determine({ roots: roots("api", "web") });
  assert.equal(withoutIndex?.status, "unavailable");
  assert.match(withoutIndex?.status === "unavailable" ? withoutIndex.cause : "", /2 target roots.*0 indexed modules/);

  const withIndex = determine({
    roots: roots("api", "web"),
    modules: modules("api", "web"),
    scan: {} as CrossRepoScan
  });
  assert.equal(withIndex, null, "the same root census admits a real scan when the optional indexes are available");
});

test("a complete single-root target is single-module with or without optional indexes", () => {
  const withoutIndex = determine({ roots: roots(".") });
  const withIndex = determine({ roots: roots("."), modules: modules("pkg-a", "pkg-b"), scan: {} as CrossRepoScan });
  for (const result of [withoutIndex, withIndex]) {
    assert.equal(result?.status, "not-applicable");
    if (result?.status !== "not-applicable") continue;
    assert.equal(result.determination, "single-module");
    assert.ok(result.basedOn.includes(FILE_ROOTS_BASIS), "removing the new L1 premise must make the contract test red");
    assert.ok(!result.basedOn.some((reference) => reference.startsWith("request.json")), "an optional tool is not a target-shape premise");
  }
  assert.deepEqual(withoutIndex, withIndex, "optional CodeGraph presence changes no byte of the target determination");
});

test("an incomplete single-root census degrades to Unavailable", () => {
  const skipped = determine({
    roots: roots("."),
    completeness: { capReached: true, skippedByCap: 1, droppedRoots: [], readFailures: 0 }
  });
  assert.equal(skipped?.status, "unavailable");

  const droppedRoots = roots(".", "unknown");
  droppedRoots[1] = { ...droppedRoots[1]!, candidateSource: "not-examined", candidates: 0, counted: 0, dropped: true };
  const dropped = determine({
    roots: droppedRoots,
    modules: modules(".", "unknown"),
    scan: {} as CrossRepoScan,
    completeness: { capReached: true, skippedByCap: 0, droppedRoots: ["unknown"], readFailures: 0 }
  });
  assert.equal(dropped?.status, "unavailable");
  assert.match(dropped?.status === "unavailable" ? dropped.cause : "", /scan was incomplete/);
});
