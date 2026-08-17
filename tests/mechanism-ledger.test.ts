import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createSnapshot } from "../src/snapshot/snapshot.ts";
import { sourceSearch } from "../src/snapshot/source.ts";
import type { CountedRow, FileLedger } from "../src/snapshot/file-ledger.ts";
import { probeDecision } from "../src/facts/probe/decision-probe.ts";
import { LANGUAGE_REGISTRY, type LanguageRegistry } from "../src/base/language-registry.ts";
import {
  MECHANISM_IDS, MECHANISM_REGISTRY, fileMatrixMechanisms,
  type MechanismAvailability, type MechanismAvailabilityMap, type MechanismId
} from "../src/base/mechanism-registry.ts";
import {
  buildMechanismLedger, expandMatrixRow, serializeMechanismLedger, verdictKey,
  type CellVerdict, type FileMatrixRow, type MechanismLedger
} from "../src/mechanism/mechanism-ledger.ts";
import { built } from "../src/base/artifact-result.ts";
import { tempDir } from "./helpers.ts";

/**
 * Layer 2 turns "structural probing covers seven extensions and nothing says which languages that leaves out"
 * into one number per (language x mechanism). The properties worth pinning are not the numbers themselves but
 * the three that make the numbers readable: the three cells never merge, every mechanism accounts for every
 * counted row, and the compressed form expands back to what a brute-force per-row computation would say.
 */

function availabilityMap(overrides: Partial<Record<MechanismId, MechanismAvailability>> = {}): MechanismAvailabilityMap {
  const map = Object.fromEntries(MECHANISM_IDS.map((id) => [id, { status: "available" as const }])) as MechanismAvailabilityMap;
  return { ...map, ...overrides };
}

function buildFrom(ledger: FileLedger, options: { availability?: MechanismAvailabilityMap; languages?: LanguageRegistry } = {}): MechanismLedger {
  return buildMechanismLedger({
    counted: ledger.counted,
    filesContentManifestDigest: ledger.contentManifestDigest,
    scannerVersion: ledger.scannerVersion,
    availability: options.availability ?? availabilityMap(),
    languages: options.languages ?? LANGUAGE_REGISTRY,
    mechanisms: MECHANISM_REGISTRY
  });
}

/** A layer-1 counted row, shaped exactly as `buildFileLedger` writes one. */
function countedRow(relativePath: string, extension: string, size: number): CountedRow {
  return {
    relativePath,
    rootName: "root",
    extension,
    tier1: { status: "sampled", size, mtimeMs: 0, shape: "textual", sampledBytes: size, maxLineLength: 40 },
    content: { status: "present", algorithm: "sha256", digest: "0".repeat(64) }
  };
}

function rowFor(ledger: MechanismLedger, mechanismId: string): FileMatrixRow {
  const row = ledger.fileMatrix.find((entry) => entry.mechanismId === mechanismId);
  assert.ok(row, `${mechanismId} has matrix rows`);
  return row;
}

function pathsByExtension(counted: readonly CountedRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of counted) {
    const bucket = map.get(row.extension);
    if (bucket) bucket.push(row.relativePath);
    else map.set(row.extension, [row.relativePath]);
  }
  return map;
}

/** The verdict the compressed row assigns to one path, via the published expansion. */
function cellFor(ledger: MechanismLedger, mechanismId: string, counted: readonly CountedRow[], relativePath: string): CellVerdict {
  const expanded = expandMatrixRow(rowFor(ledger, mechanismId), pathsByExtension(counted));
  const verdict = expanded.get(relativePath);
  assert.ok(verdict, `${relativePath} has a ${mechanismId} cell`);
  return verdict;
}

/**
 * A target with one file of every shape the cells depend on: Perl (native-graph yes, probe no), TypeScript
 * (both yes), a name-class row with no registered extension, an unregistered extension that layer 1 refuses,
 * and a text file above content search's own bound.
 */
async function shapeFixture(): Promise<{ target: string; ledger: FileLedger }> {
  const target = await tempDir();
  await mkdir(join(target, "lib"), { recursive: true });
  await writeFile(join(target, "lib", "Handler.pm"), "package Handler;\nsub run { my $n = 1; if ($n > 0) { return 1; } }\n1;\n");
  await writeFile(join(target, "lib", "Batch.pl"), "#!/usr/bin/perl\nmy $x = 2;\nprint $x;\n");
  await writeFile(join(target, "lib", "page.zpt"), "<html tal:content=\"here/title\">x</html>\n");
  await writeFile(join(target, "lib", "old.dtml"), "<dtml-var title>\n");
  await writeFile(join(target, "service.ts"), "export function run(n: number) { if (n > 0) return 1; return 0; }\n");
  await writeFile(join(target, "notes.md"), "# leaveBalance notes\n");
  await writeFile(join(target, "README"), "leaveBalance overview\n");
  // Three more name-class rows in the same (empty) extension group, so `no-mechanism` is that group's default
  // and README is a real compression exception — the shape wcp and provital actually have.
  await writeFile(join(target, "Makefile"), "all:\n\techo leaveBalance\n");
  await writeFile(join(target, "Dockerfile"), "FROM scratch\n");
  await writeFile(join(target, "LICENSE"), "MIT\n");
  await writeFile(join(target, "notes.xyz"), "leaveBalance in an unregistered file type\n");
  // Two ordinary .js rows plus one above the 500,000-byte bound content search declares, so the oversize row
  // is an exception inside a covered group rather than a group of its own.
  await writeFile(join(target, "small-a.js"), "// leaveBalance\nexport const a = 1;\n");
  await writeFile(join(target, "small-b.js"), "// leaveBalance\nexport const b = 2;\n");
  await writeFile(join(target, "huge.js"), `// leaveBalance\n${"x".repeat(520_000)}\n`);
  const { ledger } = await createSnapshot(target);
  return { target, ledger };
}

test("the same batch of .pm rows is covered by native-graph and uncovered by the decision probe", async () => {
  const { ledger } = await shapeFixture();
  const ledger2 = buildFrom(ledger);
  const perl = ledger.counted.filter((row) => row.extension === ".pm").map((row) => row.relativePath);
  assert.ok(perl.length > 0, "the fixture really has Perl rows");

  for (const path of perl) {
    assert.deepEqual(cellFor(ledger2, "decision-probe", ledger.counted, path), { cell: "no-mechanism", cause: "extension-not-declared" },
      "the structural probe has no Perl grammar, and that is a gap in the mechanism, not a missing tool");
    assert.deepEqual(cellFor(ledger2, "native-graph", ledger.counted, path), { cell: "covered" });
    assert.deepEqual(cellFor(ledger2, "condition-ast-perl", ledger.counted, path), { cell: "covered" },
      "the separate Perl backend does declare it, so two mechanisms disagree about the same rows");
  }
  // The declaration is checked against the real code path, not just against itself: `probeDecision` returns
  // `unavailable` for a .pm file because `AST_LANGUAGE_BY_EXTENSION` has no Perl entry.
  assert.equal(probeDecision("sub run { if (1 > 0) { return 1; } }", "lib/Handler.pm"), "unavailable");
  assert.equal(probeDecision("export function f(n: number) { if (n > 0) return 1; return 0; }", "service.ts"), "decision");

  const perlCensus = ledger2.byLanguage.filter((entry) => entry.language === "perl");
  const probe = perlCensus.find((entry) => entry.mechanismId === "decision-probe");
  assert.equal(probe?.covered, 0, "the per-language census is where a whole language's probe gap becomes one number");
  assert.equal(perlCensus.find((entry) => entry.mechanismId === "native-graph")?.covered, perl.length + 1, "plus the .pl row");
});

test("a missing ast-grep binding turns its mechanisms' cells unavailable and leaves the degraded one covered", async () => {
  const { ledger } = await shapeFixture();
  const available = buildFrom(ledger);
  // Injected through the contract input, not by stubbing a module: availability is what layer 2 is HANDED, and
  // a test that patched `loadAstGrep` would be checking a different interface than the one the ledger has.
  const blind = buildFrom(ledger, {
    availability: availabilityMap({
      "condition-ast": { status: "unavailable", cause: "the @ast-grep/napi native binding could not be loaded" },
      "decision-probe": { status: "unavailable", cause: "the @ast-grep/napi native binding could not be loaded" }
    })
  });

  for (const id of ["condition-ast", "decision-probe"]) {
    const before = rowFor(available, id);
    const after = rowFor(blind, id);
    assert.ok(before.totals.covered > 0, `${id} covers something when the binding is present`);
    assert.equal(after.totals.covered, 0, `${id} may not claim one covered cell while its binding is missing`);
    assert.equal(after.totals.mechanismUnavailable, before.totals.covered,
      `${id}: exactly the rows it could have read become mechanism-unavailable`);
    assert.equal(after.totals.noMechanism, before.totals.noMechanism,
      `${id}: a row it never declared stays no-mechanism — a missing binding does not create Perl support`);
    for (const cell of [...after.defaults, ...after.exceptions]) {
      if (cell.cell === "mechanism-unavailable") assert.match(cell.cause, /ast-grep/, "the cell names the missing dependency");
    }
  }
  // The degraded numeric extractor is a mechanism of its own, so its own cells are unaffected: this is the
  // difference between recording a fallback and recording the AST path as a success it never had.
  assert.deepEqual(rowFor(blind, "condition-regex-numeric").totals, rowFor(available, "condition-regex-numeric").totals);
  assert.ok(rowFor(blind, "condition-regex-numeric").totals.covered > 0);
  assert.equal(blind.mechanisms.find((entry) => entry.id === "condition-ast")?.availability.status, "unavailable");
});

test("an extension layer 1 refused appears in no default and no exception", async () => {
  const { ledger } = await shapeFixture();
  const excluded = ledger.excluded.find((row) => row.relativePath === "notes.xyz");
  assert.equal(excluded?.rule, "unsupported-extension", "layer 1 owns the 'is this file type in the corpus' question");
  assert.ok(!ledger.counted.some((row) => row.extension === ".xyz"));

  const ledger2 = buildFrom(ledger);
  for (const row of ledger2.fileMatrix) {
    assert.deepEqual(row.defaults.filter((entry) => entry.extension === ".xyz"), [],
      `${row.mechanismId} may not carry a group for a file type this run never counted`);
    assert.deepEqual(row.exceptions.filter((entry) => entry.relativePath === "notes.xyz"), []);
  }
  assert.deepEqual(ledger2.byLanguage.filter((entry) => entry.language === "unregistered"), [],
    "and no census row is invented for it either");
});

test("a registered language nobody adapted is counted, and every mechanism reports it as no-mechanism", () => {
  // The Linear acceptance: the registry grows an extension, no mechanism declares it, and its rows stay VISIBLE
  // as a gap rather than absent. The rows are handed in directly because the production scanner would refuse a
  // file type the production registry does not know — and layer 2's only input is a row set of this shape.
  const widened: LanguageRegistry = {
    ...LANGUAGE_REGISTRY,
    extensions: [...LANGUAGE_REGISTRY.extensions, { extension: ".brandnew", language: "brandnew", textual: true }]
  };
  const rows: CountedRow[] = [
    countedRow("service.ts", ".ts", 120),
    countedRow("thing.brandnew", ".brandnew", 80)
  ];
  const ledger = buildMechanismLedger({
    counted: rows,
    filesContentManifestDigest: "digest-for-a-widened-registry",
    scannerVersion: "test-scanner",
    availability: availabilityMap(),
    languages: widened,
    mechanisms: MECHANISM_REGISTRY
  });
  const census = ledger.byLanguage.filter((entry) => entry.language === "brandnew");
  assert.equal(census.length, fileMatrixMechanisms(MECHANISM_REGISTRY).length, "one number per mechanism for the new language");
  for (const entry of census) {
    assert.equal(entry.noMechanism, 1, `${entry.mechanismId} reports the unadapted language as a gap`);
    assert.equal(entry.covered + entry.mechanismUnavailable, 0, `${entry.mechanismId} claims nothing about it`);
  }
  for (const row of ledger.fileMatrix) {
    assert.deepEqual(expandMatrixRow(row, pathsByExtension(rows)).get("thing.brandnew"),
      { cell: "no-mechanism", cause: "extension-not-declared" },
      `${row.mechanismId}: a registered-but-unadapted extension is no-mechanism, never mechanism-unavailable`);
    assert.equal(row.totals.covered + row.totals.noMechanism + row.totals.mechanismUnavailable, 2);
  }
});

test("every mechanism accounts for every counted row, and the compressed form expands to the same cells", async () => {
  const { ledger } = await shapeFixture();
  const ledger2 = buildFrom(ledger);
  const groups = pathsByExtension(ledger.counted);
  assert.equal(ledger2.counted, ledger.summary.counted);

  for (const row of ledger2.fileMatrix) {
    const sum = row.totals.covered + row.totals.noMechanism + row.totals.mechanismUnavailable;
    assert.equal(sum, ledger2.counted, `${row.mechanismId}: covered + no-mechanism + mechanism-unavailable must be the layer-1 denominator`);
    assert.equal(row.defaults.reduce((total, entry) => total + entry.files, 0), ledger2.counted,
      `${row.mechanismId}: the extension groups must cover the whole corpus`);
    assert.deepEqual([...row.defaults].map((entry) => entry.extension).sort(), [...groups.keys()].sort());

    // The round trip: expand the folded row and compare cell by cell against a per-row tally.
    const expanded = expandMatrixRow(row, groups);
    assert.equal(expanded.size, ledger2.counted, `${row.mechanismId}: expansion covers every counted path exactly once`);
    const tally = { covered: 0, noMechanism: 0, mechanismUnavailable: 0 };
    for (const verdict of expanded.values()) {
      if (verdict.cell === "covered") tally.covered += 1;
      else if (verdict.cell === "no-mechanism") tally.noMechanism += 1;
      else tally.mechanismUnavailable += 1;
    }
    assert.deepEqual(tally, row.totals, `${row.mechanismId}: the published totals must be what the compression says`);
    // No exception may restate its group's default: the compressed form has one canonical spelling.
    for (const exception of row.exceptions) {
      const group = row.defaults.find((entry) => (groups.get(entry.extension) ?? []).includes(exception.relativePath));
      assert.ok(group, `${exception.relativePath} belongs to a declared group`);
      assert.notEqual(verdictKey(exception), verdictKey(group), `${row.mechanismId}: ${exception.relativePath} restates its default`);
    }
    // And the census is a view of the same numbers, never a second opinion.
    const census = ledger2.byLanguage.filter((entry) => entry.mechanismId === row.mechanismId);
    const summed = census.reduce((totals, entry) => ({
      covered: totals.covered + entry.covered,
      noMechanism: totals.noMechanism + entry.noMechanism,
      mechanismUnavailable: totals.mechanismUnavailable + entry.mechanismUnavailable
    }), { covered: 0, noMechanism: 0, mechanismUnavailable: 0 });
    assert.deepEqual(summed, row.totals, `${row.mechanismId}: the per-language census must add up to the matrix totals`);
  }
});

test("the search cells agree with what content search actually reaches, README and size bound included", async () => {
  const { target, ledger } = await shapeFixture();
  const ledger2 = buildFrom(ledger);
  const files = ledger.counted.map((row) => ({
    absolutePath: join(target, row.relativePath),
    relativePath: row.relativePath,
    size: row.tier1.status === "unsampled" ? 0 : row.tier1.size,
    extension: row.extension,
    rootName: ""
  }));
  // Every fixture file carries the same term, so "search reached it" and "search matched in it" coincide and
  // the comparison is against the real predicate rather than a restatement of it.
  const matched = new Set((await sourceSearch(files, ["leaveBalance"], { maxResults: 500, redact: false })).map((match) => match.file.relativePath));
  const withTerm = new Set(["notes.md", "README", "Makefile", "huge.js", "small-a.js", "small-b.js"]);

  for (const path of withTerm) {
    const verdict = cellFor(ledger2, "search", ledger.counted, path);
    assert.equal(verdict.cell === "covered", matched.has(path),
      `search ${matched.has(path) ? "reached" : "skipped"} ${path}; the ledger says ${verdict.cell}`);
  }
  assert.deepEqual(cellFor(ledger2, "search", ledger.counted, "README"), { cell: "covered" },
    "README has no registered extension and is searchable by name class");
  assert.deepEqual(cellFor(ledger2, "search", ledger.counted, "Makefile"), { cell: "no-mechanism", cause: "name-class-not-declared" },
    "Makefile is in the corpus by name too, and search does not declare that class");
  assert.deepEqual(cellFor(ledger2, "search", ledger.counted, "huge.js"), { cell: "no-mechanism", cause: "search-size-cap-500000" },
    "a text file above the declared bound is out of the mechanism's scope, not blocked by a missing tool");
  // Both are compression EXCEPTIONS, not groups of their own: the `""` group's default is the no-mechanism the
  // other three name-class rows carry, and the `.js` group's default is covered.
  const searchRow = rowFor(ledger2, "search");
  assert.equal(searchRow.defaults.find((entry) => entry.extension === "")?.cell, "no-mechanism");
  assert.equal(searchRow.defaults.find((entry) => entry.extension === ".js")?.cell, "covered");
  assert.ok(searchRow.exceptions.some((entry) => entry.relativePath === "README"), "README is a compression exception in its group");
  assert.ok(searchRow.exceptions.some((entry) => entry.relativePath === "huge.js"), "the oversize row is an exception in the .js group");
  assert.ok(searchRow.exceptions.length < ledger2.counted, "exceptions are the tail of the distribution, not the distribution");
});

test("two builds over the same rows produce identical bytes and carry no wall clock", async () => {
  const { ledger } = await shapeFixture();
  const first = serializeMechanismLedger(built(buildFrom(ledger)));
  const second = serializeMechanismLedger(built(buildFrom(ledger)));
  assert.equal(first, second, "the layer-2 ledger is byte-deterministic for one corpus on one machine");
  assert.ok(!/createdAt|frozenAt|\d{4}-\d{2}-\d{2}T/.test(first), "no field records 'now'");
  assert.ok(first.endsWith("\n"));
  const parsed = JSON.parse(first) as { status: string; value: MechanismLedger };
  assert.equal(parsed.status, "built");
  assert.equal(parsed.value.identity.filesContentManifestDigest, ledger.contentManifestDigest);
  assert.equal(parsed.value.identity.scannerVersion, ledger.scannerVersion);
  assert.equal(parsed.value.identity.languageRegistry.version, LANGUAGE_REGISTRY.version);
  assert.equal(parsed.value.identity.mechanismRegistry.version, MECHANISM_REGISTRY.version);
});

test("every registered mechanism is declared, and only file-domain ones with an extension set take rows", async () => {
  const { ledger } = await shapeFixture();
  const ledger2 = buildFrom(ledger);
  assert.deepEqual(ledger2.mechanisms.map((entry) => entry.id).sort(), [...MECHANISM_IDS].sort(),
    "a mechanism absent from the declarations is a mechanism nothing accounts for");
  assert.deepEqual(ledger2.fileMatrix.map((row) => row.mechanismId).sort(),
    fileMatrixMechanisms(MECHANISM_REGISTRY).map((entry) => entry.id).sort());
  for (const id of ["crossrepo", "ctags-census", "codegraph"]) {
    assert.ok(ledger2.mechanisms.some((entry) => entry.id === id), `${id} is declared`);
    assert.deepEqual(ledger2.fileMatrix.filter((row) => row.mechanismId === id), [],
      `${id} accounts for module pairs, a corpus or an external index; a per-file grid would be a claim it never made`);
  }
  const crossrepo = ledger2.mechanisms.find((entry) => entry.id === "crossrepo");
  assert.equal(crossrepo?.coverageDomain, "module-pair");
  assert.equal(ledger2.mechanisms.find((entry) => entry.id === "ctags-census")?.unitKind, "corpus");
  assert.equal(ledger2.mechanisms.find((entry) => entry.id === "condition-regex-numeric")?.title.includes("DEGRADED"), true,
    "the degraded mechanism says so where it is read");
});
