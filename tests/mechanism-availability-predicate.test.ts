import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { collectMechanismAvailability } from "../src/run/mechanism-availability.ts";
import { perlStructuralReady, warmExtractors } from "../src/facts/probe/condition-extract.ts";

/**
 * ONE predicate for "structural Perl extraction is live", and the ledger records that one.
 *
 * The layer-2 ledger's whole claim is that its cells can be checked against reality, and the way to break that
 * silently is two predicates for one fact. The availability collector used to call `loadPerlParser()`, which
 * warms the cache inside `condition-extract-perl.ts`; extraction branches on a DIFFERENT variable, the
 * `perlParser` slot inside `condition-extract.ts`, warmed only by `warmExtractors()`. So the ledger could
 * record `condition-ast-perl: available` for a run in which every Perl window fell through to the numeric
 * regex, and nothing in the artifact would disagree.
 *
 * This file runs in its own process (node:test gives each test file one), which is what makes the first
 * assertion below possible: readiness starts false, and the collector is what turns it true. On the old code
 * the collector left it false while reporting `available`, so this test goes red there.
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

test("the ledger's Perl availability is the extraction branch's own readiness, warmed by the collector", async () => {
  assert.equal(perlStructuralReady(), false, "nothing has warmed the extractor yet in this process");
  const availability = await collectMechanismAvailability();
  const expected = perlStructuralReady() ? "available" : "unavailable";
  assert.equal(availability["condition-ast-perl"].status, expected,
    "the ledger cell and the branch that would actually run must be the same fact");
  assert.equal(availability["native-graph"].status, expected,
    "native-graph binds tree-sitter at module load, so it is not finer than the parser's readiness");
  // And the collector is what warmed it: an unwarmed process would honestly report not-ready, which is what
  // its extraction would have done.
  assert.equal(perlStructuralReady(), true, "on this machine the tree-sitter-perl binding loads, so the collector's warm succeeds");
});

test("warming twice is idempotent and does not flip the answer", async () => {
  await warmExtractors();
  const first = perlStructuralReady();
  await warmExtractors();
  assert.equal(perlStructuralReady(), first);
});

test("loadPerlParser is referenced by exactly one module in src: the one that owns the readiness accessor", async () => {
  // The pin, without which the second predicate can grow back one import at a time. `condition-extract.ts` is
  // the only module allowed to load the parser, because it is the only module that branches on it.
  //
  // Comment lines are skipped by the same rule the layer-order extractor uses (a line whose first non-space
  // characters open or continue a comment is not code): prose that EXPLAINS why the loader may not be called
  // here — which is exactly what `run/mechanism-availability.ts` now carries — must not read as a call.
  const referencing: string[] = [];
  for (const path of await sourceFiles(SOURCE_ROOT)) {
    const codeLines = (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line));
    if (codeLines.some((line) => /\bloadPerlParser\b/.test(line))) referencing.push(relative(SOURCE_ROOT, path));
  }
  assert.deepEqual(referencing.sort(), ["facts/probe/condition-extract-perl.ts", "facts/probe/condition-extract.ts"],
    "the loader is declared in one file and called from one file; a third caller is a second predicate");
});
