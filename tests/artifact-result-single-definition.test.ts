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

/** The base's own definition site: the one declaration allowed to spell all three states. */
const DEFINITION_SITE = "base/artifact-result.ts";

/**
 * Every top-level declaration in one file's text, as (name, body) pairs.
 *
 * A segment starts at each line whose first character is not whitespace, because every top-level declaration in
 * this repository starts in column 1 and every member of one is indented — including the `| { … }` arms of a
 * union and the doc comments between them. That is deliberately not a parser: a comment stripper or a real TS
 * parse would be a second implementation of a question this check asks about one line shape, and its failure
 * mode (dropping a declaration) is silent, which is the failure mode that matters here.
 */
function topLevelDeclarations(text: string): Array<{ name: string; body: string }> {
  const declarations: Array<{ name: string; body: string }> = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      if (current) declarations.push({ name: current.name, body: current.lines.join("\n") });
      const opener = /^(?:export\s+)?(?:declare\s+)?(type|interface)\s+(\w+)/.exec(line);
      current = opener ? { name: opener[2]!, lines: [line] } : null;
      continue;
    }
    current?.lines.push(line);
  }
  if (current) declarations.push({ name: current.name, body: current.lines.join("\n") });
  return declarations;
}

/**
 * Declarations that spell a SECOND top-level failure envelope: one type that carries `status: "unavailable"`
 * next to `status: "built"` or `status: "not-applicable"`.
 *
 * That combination is the signature of a competing dialect, and only of that. `MechanismAvailability` pairs
 * `available` with `unavailable` and is not a top-level envelope at all — it is a per-run observation that
 * layer 2 records inside a `Built` artifact — so it must not be caught, and the assertion below proves it is not.
 *
 * KNOWN BOUNDARY, stated rather than papered over: a dialect that picks different literals (`census-unavailable`
 * keyed off `reason` rather than `status`, which is the shape `context.ts` grew) walks straight past this scan.
 * This is the cheap first line; the second is structural and cannot be evaded — every consumer of the real
 * envelope switches over three cases and ends in `assertNever`, so a producer that returns a fourth shape does
 * not compile at its consumer. See the `@ts-expect-error` fixture in `tests/interface-laws.compile.ts`.
 */
function competingFailureEnvelopes(text: string): string[] {
  const unavailable = /status\s*\??\s*:\s*"unavailable"/;
  const topState = /status\s*\??\s*:\s*"(?:built|not-applicable)"/;
  return topLevelDeclarations(text)
    .filter((declaration) => unavailable.test(declaration.body) && topState.test(declaration.body))
    .map((declaration) => declaration.name);
}

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
  assert.deepEqual(declarations, [DEFINITION_SITE],
    `ArtifactResult must have exactly one definition; found: ${declarations.join(", ")}`);
});

test("no source file outside the base declares a competing failure envelope", async () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const path of await sourceFiles(SOURCE_ROOT)) {
    const relativePath = relative(SOURCE_ROOT, path);
    if (relativePath === DEFINITION_SITE) continue;
    scanned += 1;
    for (const name of competingFailureEnvelopes(await readFile(path, "utf8"))) offenders.push(`${relativePath}: ${name}`);
  }
  assert.ok(scanned > 80, `the scan must cover the whole tree; it saw ${scanned} files`);
  assert.deepEqual(offenders, [],
    `a second spelling of "this did not happen" lets a consumer branch on one envelope and silently ignore the other: ${offenders.join(", ")}`);
});

test("the shape scan really fires on a censusUnavailable-style dialect", async () => {
  // The live proof, because a scan that cannot go red certifies whatever it is pointed at. This is the exact
  // shape `src/context/context.ts` would have grown had its "no census could be built" reason been given a
  // status-tagged envelope of its own instead of being folded into the one in the base.
  const dialect = [
    "export type CensusResult =",
    '  | { status: "built"; census: ScopeCensus }',
    "  /** Which cause, when no census could be built. */",
    '  | { status: "census-unavailable"; reason: "no-graph" | "empty-vocabulary" }',
    '  | { status: "unavailable"; cause: string };',
    "",
    "export interface Unrelated { id: string }"
  ].join("\n");
  assert.deepEqual(competingFailureEnvelopes(dialect), ["CensusResult"]);

  // And it must NOT fire on the per-run availability observation, which pairs available with unavailable and is
  // a value INSIDE a Built artifact rather than an envelope competing with it.
  const availability = await readFile(join(SOURCE_ROOT, "base", "mechanism-registry.ts"), "utf8");
  assert.ok(/export type MechanismAvailability =/.test(availability), "the fixture points at the real declaration");
  assert.deepEqual(competingFailureEnvelopes(availability), []);

  // The segmenter is what makes both answers trustworthy: two neighbouring declarations are two declarations,
  // so `built` in one and `unavailable` in the next is not a hit.
  const neighbours = [
    'export interface Ok { status: "built"; value: number }',
    'export interface Missing { status: "unavailable"; cause: string }'
  ].join("\n");
  assert.deepEqual(competingFailureEnvelopes(neighbours), []);
  assert.deepEqual(topLevelDeclarations(neighbours).map((declaration) => declaration.name), ["Ok", "Missing"]);
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
