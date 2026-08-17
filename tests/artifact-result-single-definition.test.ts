import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { assertNever, built, notApplicable, unavailable, type ArtifactResult } from "../src/base/artifact-result.ts";

/**
 * One failure union for the whole engine, defined in the base and consumed exhaustively.
 *
 * The alternative is what the codebase already grew: `censusUnavailable`, `channel-unavailable` and
 * `NotApplicable`-shaped reasons living inside individual producers, each with its own spelling of "this did
 * not happen". A second dialect means a consumer can branch on one and silently ignore the other, so this
 * test pins the definition site the way `search-corpus.test.ts` pins the scanned-extension corpus.
 */

const SOURCE_ROOT = resolve("src");

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

test("ArtifactResult is declared in exactly one place", async () => {
  const declarations: string[] = [];
  for (const path of await sourceFiles(SOURCE_ROOT)) {
    const text = await readFile(path, "utf8");
    if (/^\s*export\s+(?:type|interface)\s+ArtifactResult\b/m.test(text)) declarations.push(relative(SOURCE_ROOT, path));
  }
  assert.deepEqual(declarations, ["base/artifact-result.ts"],
    `ArtifactResult must have exactly one definition; found: ${declarations.join(", ")}`);
});

test("the three states are closed and exhaustively consumable", () => {
  const cases: Array<ArtifactResult<number>> = [
    built(7),
    notApplicable("not-detected", ["ledger/files.json"], "digest-abc"),
    unavailable("ast-grep bindings are missing", true)
  ];
  const seen: string[] = [];
  for (const result of cases) {
    switch (result.status) {
      case "built": seen.push(`built:${result.value}`); break;
      case "not-applicable": seen.push(`na:${result.determination}:${result.basedOn.join("|")}:${result.coverageDigest}`); break;
      case "unavailable": seen.push(`un:${result.cause}:${result.retryable}`); break;
      default: assertNever(result, "artifact result");
    }
  }
  assert.deepEqual(seen, ["built:7", "na:not-detected:ledger/files.json:digest-abc", "un:ast-grep bindings are missing:true"]);
});

test("a not-applicable determination cannot be written without the completeness it rests on", () => {
  const result = notApplicable("single-module", ["ledger/files.json", "mechanisms"], "coverage-digest");
  assert.deepEqual(result.basedOn, ["ledger/files.json", "mechanisms"]);
  assert.equal(result.coverageDigest, "coverage-digest");
  assert.throws(() => notApplicable("not-detected", [], "digest"), /basedOn/, "a determination with no stated basis is not a determination");
  assert.throws(() => notApplicable("not-detected", ["x"], ""), /coverageDigest/);
});

test("assertNever names what it was consuming when a fourth state appears", () => {
  assert.throws(() => assertNever({ status: "policy" } as never, "artifact result"), /artifact result/);
});
