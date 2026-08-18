import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LANGUAGE_REGISTRY } from "../src/base/language-registry.ts";
import { MECHANISM_IDS, MECHANISM_REGISTRY, mechanismById, type MechanismAvailabilityMap } from "../src/base/mechanism-registry.ts";
import { PARTITION_DESIGNATION, type PartitionDesignation } from "../src/base/partition-designation.ts";
import { RowSet } from "../src/base/row-set.ts";
import { stableJson } from "../src/base/util.ts";
import { loadAstGrep, type AstGrepApi } from "../src/facts/probe/condition-extract.ts";
import { extractAstSkeleton, flattenSkeleton } from "../src/facts/units/ast-partition.ts";
import { PartitionSkeletonCache } from "../src/facts/units/partition-cache.ts";
import {
  PARTITION_DEGRADE_REASONS, assembleFileCells, buildPartition, designatedBuilderGate,
  partitionContentDigest, verifyFilePartition,
  type PartitionBuildResult, type PartitionDegradeReason
} from "../src/facts/units/partition-build.ts";
import { canonicalSpan } from "../src/facts/units/unit-identity.ts";
import { buildMechanismLedger, expandMatrixRow } from "../src/mechanism/mechanism-ledger.ts";
import type { CountedRow, FileLedger } from "../src/snapshot/file-ledger.ts";
import { createSnapshot } from "../src/snapshot/snapshot.ts";
import { tempDir } from "./helpers.ts";

/**
 * The canonical partition: non-overlapping cells whose union is exactly each counted file.
 *
 * Two things are checked here that no downstream audit could catch after the fact. The partition invariants are
 * enforced at CONSTRUCTION, so the negative fixtures feed `assembleFileCells` / `verifyFilePartition` bad input
 * and watch them throw — an overlap double-counts a file in the layer-4 denominator while every conservation sum
 * inside the partition rows still balances, so a check that only ran afterwards would have nothing to compare to.
 * And every degrade reason gets a fixture: the last test in this file asserts that the reason vocabulary has no
 * member without one, because an unreachable bucket is a bucket that lies about what can happen.
 */

const AST_GREP = loadAstGrep();
/** Every reason a fixture below actually produced; the totality check at the bottom reads it. */
const EXERCISED = new Set<PartitionDegradeReason>();

function availabilityWith(overrides: Partial<MechanismAvailabilityMap> = {}): MechanismAvailabilityMap {
  const base = Object.fromEntries(MECHANISM_IDS.map((id) => [id, { status: "available" as const }])) as MechanismAvailabilityMap;
  return { ...base, ...overrides };
}

async function build(
  target: string,
  counted: readonly CountedRow[],
  designation: PartitionDesignation = PARTITION_DESIGNATION,
  cache?: PartitionSkeletonCache
): Promise<PartitionBuildResult> {
  return buildPartition({
    counted,
    target,
    languages: LANGUAGE_REGISTRY,
    designation,
    mechanisms: MECHANISM_REGISTRY,
    astGrep: AST_GREP,
    // Explicitly cacheless unless a test asks otherwise. The cache has its own test, with a real directory: a
    // helper that quietly defaulted to one would make every other assertion here depend on cache state.
    cache: cache ?? await PartitionSkeletonCache.open(null)
  });
}

/** A real snapshot, with a cache directory, because that is how `prepare` calls it. */
async function snapshot(target: string): Promise<CountedRow[]> {
  const cacheDir = await tempDir("excavator-units-cache-");
  const { ledger } = await createSnapshot(target, 100_000, { cacheDir });
  return (ledger as FileLedger).counted;
}

function recordDegrades(result: PartitionBuildResult): void {
  for (const file of result.files) if (file.degraded) EXERCISED.add(file.degraded.reason);
}

/**
 * The nesting fixture the Linear acceptance names: a class over lines 1–100, a method over 10–30, a closure over
 * 18–22. Built from an array of lines so the stated line numbers are a property of the fixture, not a comment.
 */
function nestedClassSource(): string {
  const lines = new Array<string>(100).fill("");
  lines[0] = "class Wide {";
  lines[9] = "  method() {";
  lines[17] = "    const inner = () => {";
  lines[21] = "    };";
  lines[29] = "  }";
  lines[99] = "}";
  for (let i = 0; i < lines.length; i++) if (lines[i] === "") lines[i] = `  // filler line ${i + 1}`;
  return `${lines.join("\n")}\n`;
}

/** 1-based line of a byte offset, so a span can be checked against the line numbers a human read. */
function lineOfByte(source: string, byteOffset: number): number {
  return Buffer.from(source, "utf8").subarray(0, byteOffset).toString("utf8").split("\n").length;
}

test("nested structures are all retained as reference units, and the partition is the outermost cell plus residual", async () => {
  assert.ok(AST_GREP, "the ast-grep binding is required: this is the designated builder for typescript");
  const source = nestedClassSource();
  const target = await tempDir("excavator-units-nested-");
  await writeFile(join(target, "wide.ts"), source);
  const counted = await snapshot(target);
  const result = await build(target, counted);

  const file = result.files.find((entry) => entry.relativePath === "wide.ts");
  assert.ok(file);
  assert.equal(file.degraded, null);
  assert.equal(file.size, Buffer.byteLength(source, "utf8"));

  // Three reference units, nested, none of them lost.
  assert.deepEqual(file.refUnits.map((unit) => [unit.unitKind, unit.depth]), [["class", 1], ["method", 2], ["closure", 3]]);
  for (const unit of file.refUnits) assert.equal(unit.normalization, "builder-node");
  const [klass, method, closure] = file.refUnits;
  assert.deepEqual([lineOfByte(source, klass!.span.startByte), lineOfByte(source, klass!.span.endByte)], [1, 100]);
  assert.deepEqual([lineOfByte(source, method!.span.startByte), lineOfByte(source, method!.span.endByte)], [10, 30]);
  assert.deepEqual([lineOfByte(source, closure!.span.startByte), lineOfByte(source, closure!.span.endByte)], [18, 22]);

  // The partition is the class cell plus the trailing newline as residual — the nested two are NOT cells, because
  // a class and its method in one conservation sum would overlap.
  assert.deepEqual(file.cells.map((cell) => [cell.partitionKind, cell.unitKind]), [["structure", "class"], ["residual", null]]);
  assert.equal(file.cells[0]!.span.startByte, klass!.span.startByte);
  assert.equal(file.cells[0]!.span.endByte, klass!.span.endByte);
  assert.equal(file.cells.reduce((sum, cell) => sum + (cell.span.endByte - cell.span.startByte), 0), file.size,
    "the cells' byte union is exactly the file");
  // And back to the source: the structure cell's bytes really are the class declaration.
  const bytes = Buffer.from(source, "utf8");
  assert.match(bytes.subarray(file.cells[0]!.span.startByte, file.cells[0]!.span.endByte).toString("utf8"), /^class Wide \{[\s\S]*\}$/);
  recordDegrades(result);
});

test("a single-function file is covered by leading residual, the function cell, and trailing residual", async () => {
  const source = "// header comment\nexport function only() {\n  return 1;\n}\n// trailer\n";
  const target = await tempDir("excavator-units-single-");
  await writeFile(join(target, "one.ts"), source);
  const result = await build(target, await snapshot(target));
  const file = result.files[0]!;
  assert.deepEqual(file.cells.map((cell) => cell.partitionKind), ["residual", "structure", "residual"]);
  assert.equal(file.cells[0]!.span.startByte, 0, "the union starts at byte 0");
  assert.equal(file.cells.at(-1)!.span.endByte, file.size, "and ends at the file's size");
  let cursor = 0;
  for (const cell of file.cells) {
    assert.equal(cell.span.startByte, cursor, "no gap");
    cursor = cell.span.endByte;
  }
  assert.equal(cursor, file.size);
  // `export ` sits in the leading residual: the cell is the declaration node, and the bytes in front of it are
  // still accounted for. That is what keeps the union complete without the cell claiming bytes it does not own.
  assert.equal(Buffer.from(source, "utf8").subarray(file.cells[1]!.span.startByte, file.cells[1]!.span.endByte).toString("utf8"),
    "function only() {\n  return 1;\n}");
  recordDegrades(result);
});

test("a non-ASCII file's cells tile its real byte length", async () => {
  const source = "// 中文注释 \u{1F680}\nexport class 类 {\n  方法() { return 1; }\n}\n";
  const target = await tempDir("excavator-units-utf8-");
  await writeFile(join(target, "utf8.ts"), source);
  const result = await build(target, await snapshot(target));
  const file = result.files[0]!;
  assert.equal(file.size, Buffer.byteLength(source, "utf8"));
  assert.notEqual(file.size, source.length, "the fixture must be non-ASCII or it proves nothing about the conversion");
  assert.equal(file.cells.reduce((sum, cell) => sum + (cell.span.endByte - cell.span.startByte), 0), file.size);
  const structure = file.cells.find((cell) => cell.partitionKind === "structure")!;
  assert.match(Buffer.from(source, "utf8").subarray(structure.span.startByte, structure.span.endByte).toString("utf8"), /^class 类 \{/);
  recordDegrades(result);
});

test("a language with no designated builder gets one residual cell over the whole file, with the reason recorded", async () => {
  const target = await tempDir("excavator-units-perl-");
  await mkdir(join(target, "lib"), { recursive: true });
  const perl = "package Renderer;\nsub render { return 1; }\n1;\n";
  await writeFile(join(target, "lib/Renderer.pm"), perl);
  await writeFile(join(target, "lib/__init__.py"), "");
  const counted = await snapshot(target);
  const result = await build(target, counted);

  const pm = result.files.find((file) => file.relativePath === "lib/Renderer.pm")!;
  assert.deepEqual(pm.degraded, { reason: "no-designated-builder", language: "perl" });
  assert.deepEqual(pm.builder, { kind: "file-level" });
  assert.deepEqual(pm.cells.map((cell) => cell.unitId), [`cell:residual:0-${Buffer.byteLength(perl, "utf8")}:lib/Renderer.pm`]);
  assert.deepEqual(pm.refUnits, [], "no builder means no structure, and none is invented");

  const empty = result.files.find((file) => file.relativePath === "lib/__init__.py")!;
  assert.deepEqual(empty.degraded, { reason: "no-designated-builder", language: "python" });
  assert.deepEqual(empty.cells.map((cell) => cell.unitId), ["cell:residual:0-0:lib/__init__.py"]);

  // The same gap is a number in `mechanisms.json` rather than a silence: `.pm` is `no-mechanism` for the builder.
  const ledger = buildMechanismLedger({
    counted,
    filesContentManifestDigest: "digest",
    scannerVersion: "test",
    availability: availabilityWith(),
    languages: LANGUAGE_REGISTRY,
    mechanisms: MECHANISM_REGISTRY
  });
  const row = ledger.fileMatrix.find((entry) => entry.mechanismId === "partition-ast")!;
  assert.deepEqual(row.defaults.find((entry) => entry.extension === ".pm"),
    { extension: ".pm", files: 1, cell: "no-mechanism", cause: "extension-not-declared" });
  recordDegrades(result);
});

test("a scanned extension the builder's adapter does not resolve degrades with its own reason, not the language's", async () => {
  const target = await tempDir("excavator-units-mts-");
  await writeFile(join(target, "mod.mts"), "export function f() {}\n");
  const result = await build(target, await snapshot(target));
  const file = result.files[0]!;
  // `.mts` IS typescript, so the language designates the ast builder — the gap is in the adapter's grammar table,
  // and saying `no-designated-builder` here would blame the wrong declaration.
  assert.deepEqual(file.builder, { kind: "mechanism", mechanism: "partition-ast" });
  assert.deepEqual(file.degraded, { reason: "builder-extension-not-declared", mechanism: "partition-ast", extension: ".mts" });
  assert.equal(file.cells.length, 1);
  assert.equal(file.cells[0]!.partitionKind, "residual");
  recordDegrades(result);
});

test("a file past the builder's declared size bound is one residual cell, judged before its bytes are read", async () => {
  const target = await tempDir("excavator-units-cap-");
  const big = `// ${"x".repeat(500_001)}\n`;
  await writeFile(join(target, "big.ts"), big);
  const result = await build(target, await snapshot(target));
  const file = result.files[0]!;
  assert.deepEqual(file.degraded, { reason: "size-cap", mechanism: "partition-ast", maxFileBytes: 500_000, size: Buffer.byteLength(big, "utf8") });
  assert.equal(file.cells.length, 1);
  assert.equal(file.cells[0]!.span.endByte, file.size);
  recordDegrades(result);
});

test("bytes that drifted from the ledger, or cannot be read, or are not UTF-8, each land in their own bucket", async () => {
  const target = await tempDir("excavator-units-content-");
  await writeFile(join(target, "drift.ts"), "export function before() {}\n");
  await writeFile(join(target, "gone.ts"), "export function gone() {}\n");
  await writeFile(join(target, "binary.ts"), Buffer.from([0x66, 0x6f, 0x6f, 0xff, 0x0a]));
  const counted = await snapshot(target);
  // Both mutations happen AFTER the ledger recorded these rows, which is exactly the race the buckets describe.
  await writeFile(join(target, "drift.ts"), "export function after() {}\n");
  await rm(join(target, "gone.ts"));
  const result = await build(target, counted);

  const drift = result.files.find((file) => file.relativePath === "drift.ts")!;
  assert.deepEqual(drift.degraded, { reason: "content-drift" });
  assert.equal(drift.cells.length, 1, "the residual is stated over the LEDGER's size, so the counted row stays in the denominator");
  assert.equal(drift.cells[0]!.span.endByte, drift.size);

  const gone = result.files.find((file) => file.relativePath === "gone.ts")!;
  assert.deepEqual(gone.degraded, { reason: "content-read-failed", code: "ENOENT" });

  const binary = result.files.find((file) => file.relativePath === "binary.ts")!;
  assert.equal(binary.degraded?.reason, "content-not-utf8");
  assert.deepEqual(binary.degraded, { reason: "content-not-utf8", ledgerBytes: 5, decodedBytes: 7 },
    "the decoded text is longer than the file, so a byte span over it would point somewhere else entirely");
  recordDegrades(result);
});

test("a parser that refuses the bytes degrades that file and nothing else", async () => {
  const target = await tempDir("excavator-units-parse-");
  await writeFile(join(target, "a.ts"), "export function a() {}\n");
  await writeFile(join(target, "b.ts"), "export function b() {}\n");
  const counted = await snapshot(target);
  const throwsOnA: AstGrepApi = {
    parse: (language, source) => {
      if (source.includes("function a")) throw new Error("Klingon is not supported in napi");
      return AST_GREP!.parse(language, source);
    }
  };
  const result = await buildPartition({
    counted,
    target,
    languages: LANGUAGE_REGISTRY,
    designation: PARTITION_DESIGNATION,
    mechanisms: MECHANISM_REGISTRY,
    astGrep: throwsOnA,
    cache: await PartitionSkeletonCache.open(null)
  });
  assert.deepEqual(result.files.find((file) => file.relativePath === "a.ts")!.degraded, { reason: "parse-failed", mechanism: "partition-ast" });
  assert.equal(result.files.find((file) => file.relativePath === "b.ts")!.degraded, null);
  // Both files are still completely partitioned: a parse failure costs granularity, never coverage.
  for (const file of result.files) {
    assert.equal(file.cells.reduce((sum, cell) => sum + (cell.span.endByte - cell.span.startByte), 0), file.size);
  }
  recordDegrades(result);
});

test("a row layer 1 could not classify, could not hash, or never sized lands in a visible bucket", async () => {
  const target = await tempDir("excavator-units-rows-");
  const rows: CountedRow[] = [
    {
      relativePath: "notes.xyz",
      rootName: "root",
      extension: ".xyz",
      tier1: { status: "sampled", size: 12, mtimeMs: 1, shape: "textual", sampledBytes: 12, maxLineLength: 12 },
      content: { status: "present", algorithm: "sha256", digest: "a".repeat(64) }
    },
    {
      relativePath: "unhashed.ts",
      rootName: "root",
      extension: ".ts",
      tier1: { status: "stat-only", size: 40, mtimeMs: 1, reason: "read-failed" },
      content: { status: "absent", reason: "read-failed" }
    },
    {
      relativePath: "unsized.ts",
      rootName: "root",
      extension: ".ts",
      tier1: { status: "unsampled", reason: "stat-failed" },
      content: { status: "absent", reason: "read-failed" }
    }
  ];
  const result = await build(target, rows);

  const unregistered = result.files.find((file) => file.relativePath === "notes.xyz")!;
  assert.deepEqual(unregistered.degraded, { reason: "corpus-unregistered", extension: ".xyz" });
  assert.equal(unregistered.language, null);
  assert.equal(unregistered.cells.length, 1);

  const unhashed = result.files.find((file) => file.relativePath === "unhashed.ts")!;
  assert.deepEqual(unhashed.degraded, { reason: "ledger-content-absent" },
    "the ledger holds no digest, so drift cannot be ruled out — and claiming a comparison that never happened would be the lying bucket");
  assert.equal(unhashed.cells.length, 1);

  // The one reason that yields NO cell: with no observed size there is no interval to state, and a `[0,0)` cell
  // would claim the file is empty. It appears in the completeness block instead.
  const unsized = result.files.find((file) => file.relativePath === "unsized.ts")!;
  assert.deepEqual(unsized.degraded, { reason: "size-unobserved" });
  assert.deepEqual(unsized.cells, []);
  assert.equal(result.completeness.total, 3);
  assert.equal(result.completeness.counted, 2);
  assert.equal(result.completeness.excluded, 1);
  assert.equal(result.completeness.unexplained, 0);
  assert.deepEqual(result.completeness.byDegradeReason, { "corpus-unregistered": 1, "ledger-content-absent": 1, "size-unobserved": 1 });
  recordDegrades(result);
});

test("the partition invariants are enforced at construction: overlap, out-of-range and gaps all throw", () => {
  // The positive control first, so the negatives are not passing for the wrong reason.
  const ok = assembleFileCells("a.ts", "root", [{ unitKind: "function", span: canonicalSpan(5, 20) }], 30);
  assert.deepEqual(ok.map((cell) => [cell.partitionKind, cell.span.startByte, cell.span.endByte]),
    [["residual", 0, 5], ["structure", 5, 20], ["residual", 20, 30]]);

  assert.throws(() => assembleFileCells("a.ts", "root", [
    { unitKind: "class", span: canonicalSpan(0, 20) },
    { unitKind: "function", span: canonicalSpan(10, 30) }
  ], 40), /overlaps: structure span \[10, 30\) starts before the previous cell ended at 20/);

  assert.throws(() => assembleFileCells("a.ts", "root", [{ unitKind: "function", span: canonicalSpan(0, 41) }], 40),
    /ends past size 40/);

  // The gap and duplicate checks, reached directly: `assembleFileCells` constructs the residuals, so a gap can
  // only come from a caller assembling cells itself — which is precisely what the units artifact will do.
  assert.throws(() => verifyFilePartition("a.ts", [
    { unitId: "cell:structure:0-5:a.ts", relativePath: "a.ts", rootName: "root", partitionKind: "structure", unitKind: "function", span: canonicalSpan(0, 5) },
    { unitId: "cell:residual:9-20:a.ts", relativePath: "a.ts", rootName: "root", partitionKind: "residual", unitKind: null, span: canonicalSpan(9, 20) }
  ], 20), /does not cover the file: 2 cell\(s\) span 16 of 20 bytes/);

  // Two empty cells at one offset: the byte arithmetic closes and half-open spans of width zero cannot overlap,
  // so the id check is the only thing standing between this and a denominator that counts one cell twice.
  assert.throws(() => verifyFilePartition("empty.ts", [
    { unitId: "cell:residual:0-0:empty.ts", relativePath: "empty.ts", rootName: "root", partitionKind: "residual", unitKind: null, span: canonicalSpan(0, 0) },
    { unitId: "cell:residual:0-0:empty.ts", relativePath: "empty.ts", rootName: "root", partitionKind: "residual", unitKind: null, span: canonicalSpan(0, 0) }
  ], 0), /mints 1 duplicate cell id/);
});

test("the builder gate is the only place availability enters, and it looks at the corpus before answering", async () => {
  const typescriptTarget = await tempDir("excavator-units-gate-ts-");
  await writeFile(join(typescriptTarget, "app.ts"), "export function f() {}\n");
  const perlTarget = await tempDir("excavator-units-gate-pm-");
  await writeFile(join(perlTarget, "App.pm"), "package App;\n1;\n");
  const typescriptRows = await snapshot(typescriptTarget);
  const perlRows = await snapshot(perlTarget);
  const missing = availabilityWith({ "partition-ast": { status: "unavailable", cause: "the @ast-grep/napi native binding could not be loaded" } });

  const blocked = designatedBuilderGate(typescriptRows, missing, LANGUAGE_REGISTRY, PARTITION_DESIGNATION);
  assert.ok(blocked, "a counted .ts file with no builder means the whole envelope is Unavailable, never a coarser partition");
  assert.equal(blocked.status, "unavailable");
  assert.match(blocked.cause, /partition-ast \(1 counted file\(s\)\)/);
  assert.equal(blocked.retryable, true, "a missing native binding really can be repaired");

  assert.equal(designatedBuilderGate(perlRows, missing, LANGUAGE_REGISTRY, PARTITION_DESIGNATION), null,
    "a target with no file designated to the builder is unaffected by its absence");
  assert.equal(designatedBuilderGate(typescriptRows, availabilityWith(), LANGUAGE_REGISTRY, PARTITION_DESIGNATION), null);

  // And the builder cannot be talked into degrading a file over an availability fact: with no binding it refuses.
  const cacheless = await PartitionSkeletonCache.open(null);
  await assert.rejects(() => buildPartition({
    counted: typescriptRows,
    target: typescriptTarget,
    languages: LANGUAGE_REGISTRY,
    designation: PARTITION_DESIGNATION,
    mechanisms: MECHANISM_REGISTRY,
    astGrep: null,
    cache: cacheless
  }), /builder gate \(designatedBuilderGate\) must answer Unavailable before the builder is invoked/);
});

test("no source file outside the gate reads a mechanism availability while deciding a degrade", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile("src/facts/units/partition-build.ts", "utf8");
  const availabilityUses = [...text.matchAll(/availability/gi)].length;
  const gate = text.slice(text.indexOf("export function designatedBuilderGate"), text.indexOf("export function assembleFileCells"));
  const outsideGate = availabilityUses - [...gate.matchAll(/availability/gi)].length;
  // The remaining mentions are the two doc comments that say degradation may not read it; the point is that no
  // per-file branch can, and that is checkable by the absence of the identifier from the classifier.
  const classifier = text.slice(text.indexOf("function planFor"), text.indexOf("async function resolveFile"));
  assert.equal([...classifier.matchAll(/availability/gi)].length, 0,
    "the per-file classifier may not read availability: degradation is content-determined and Unavailable is envelope-wide");
  assert.ok(outsideGate <= 6, `availability is mentioned ${outsideGate} times outside the gate; it must be prose only`);
  const observerWrites = await readFile("src/facts/units/ast-partition.ts", "utf8");
  assert.ok(!/mintUnitId|PartitionCell/.test(observerWrites),
    "the skeleton extractor may not mint cells; only the partition builder writes the denominator");
});

test("adding or removing an optional producer does not move one byte of the partition", async () => {
  const target = await tempDir("excavator-units-stable-");
  await writeFile(join(target, "app.ts"), "export class A { m() {} }\n");
  await writeFile(join(target, "script.py"), "def f():\n    return 1\n");
  const counted = await snapshot(target);

  // The two builds differ on every optional producer's availability. The partition takes no producer input at
  // all, so this cannot change it — and the assertion is what keeps that structural.
  const withIndex = designatedBuilderGate(counted, availabilityWith(), LANGUAGE_REGISTRY, PARTITION_DESIGNATION);
  const withoutIndex = designatedBuilderGate(counted, availabilityWith({
    codegraph: { status: "unavailable", cause: "no index" },
    crossrepo: { status: "unavailable", cause: "no binding" },
    "ctags-census": { status: "unavailable", cause: "no ctags" }
  }), LANGUAGE_REGISTRY, PARTITION_DESIGNATION);
  assert.equal(withIndex, null);
  assert.equal(withoutIndex, null, "an optional producer's absence is not the designated builder's absence");

  const first = await build(target, counted);
  const second = await build(target, counted);
  assert.equal(stableJson(second.partition), stableJson(first.partition));
  assert.equal(partitionContentDigest(second), partitionContentDigest(first), "and a re-run is byte-identical");

  // The SENSITIVITY CONTROL. Without it the equality above could pass because the comparison sees nothing at all:
  // retargeting one language must move the digest, and it must move the `.py` file's reason specifically.
  const retargeted: PartitionDesignation = {
    ...PARTITION_DESIGNATION,
    version: "units-partition-v2",
    byLanguage: { ...PARTITION_DESIGNATION.byLanguage, "python": { kind: "mechanism", mechanism: "partition-ast" } }
  };
  const generation2 = await build(target, counted, retargeted);
  assert.notEqual(partitionContentDigest(generation2), partitionContentDigest(first),
    "a partition schema generation change must be visible in the content identity");
  assert.deepEqual(generation2.files.find((file) => file.relativePath === "script.py")!.degraded,
    { reason: "builder-extension-not-declared", mechanism: "partition-ast", extension: ".py" });
  assert.equal(generation2.schema.designationVersion, "units-partition-v2");
  assert.notEqual(generation2.schema.designationDigest, first.schema.designationDigest);
  // The typescript file is untouched by the retarget, so its cells are identical across the two generations.
  assert.equal(stableJson(generation2.partition.filter((cell) => cell.relativePath === "app.ts")),
    stableJson(first.partition.filter((cell) => cell.relativePath === "app.ts")));
  recordDegrades(first);
});

test("the partition is a RowSet source, and the per-language census reads off the same files", async () => {
  const target = await tempDir("excavator-units-rowset-");
  await mkdir(join(target, "web"), { recursive: true });
  await writeFile(join(target, "app.ts"), "export class A { m() {} }\nexport function b() {}\n");
  await writeFile(join(target, "web/util.js"), "const f = () => 1;\n");
  await writeFile(join(target, "App.pm"), "package App;\n1;\n");
  const result = await build(target, await snapshot(target));

  const rows = RowSet.fromPartition(result.partition, {
    artifact: "facts/units.json",
    contentDigest: partitionContentDigest(result),
    producerVersion: result.schema.designationVersion,
    completeness: { capReached: false, skippedByCap: 0, droppedRoots: [] }
  });
  assert.equal(rows.unitKind, "partition-cell");
  assert.equal(rows.coverageDomain, "file");
  assert.equal(rows.size, result.partition.length);
  assert.ok(rows.has(result.partition[0]!.unitId));

  const byLanguage = new Map(result.byLanguage.map((row) => [row.language, row]));
  assert.equal(byLanguage.get("typescript")!.files, 1);
  assert.equal(byLanguage.get("typescript")!.structureCells, 2);
  assert.equal(byLanguage.get("javascript")!.structureCells, 1);
  assert.deepEqual(byLanguage.get("perl")!.degraded, { "no-designated-builder": 1 });
  assert.equal(byLanguage.get("perl")!.structureCells, 0);
  assert.equal(byLanguage.get("perl")!.residualCells, 1);
  // The census sums to the flat partition, so the readable table and the denominator cannot disagree.
  const cells = result.byLanguage.reduce((sum, row) => sum + row.structureCells + row.residualCells, 0);
  assert.equal(cells, result.partition.length);
  assert.equal(result.byLanguage.reduce((sum, row) => sum + row.refUnits, 0), result.refUnits.length);
  recordDegrades(result);
});

test("a file past the builder's declared LINE bound is one residual cell, and the size bound would not have caught it", async () => {
  const target = await tempDir("excavator-units-linecap-");
  const declared = mechanismById("partition-ast", MECHANISM_REGISTRY).maxLineLength!;
  // One line past the bound, and a file far UNDER the 500 KB size bound: that combination is the whole reason the
  // line bound exists. Measured on provital, `tiny_mce.js` is 439,601 bytes — under the size cap — and produced
  // 3,489 reference units in each of its four copies.
  const compressed = `const t=${JSON.stringify("x".repeat(declared + 100))};function f(){return t}\n`;
  await writeFile(join(target, "bundle.js"), compressed);
  await writeFile(join(target, "plain.js"), "function g() { return 1; }\n");
  const counted = await snapshot(target);
  const bundleRow = counted.find((row) => row.relativePath === "bundle.js")!;
  assert.equal(bundleRow.tier1.status, "sampled");
  assert.ok(bundleRow.tier1.status === "sampled" && bundleRow.tier1.maxLineLength > declared,
    "the fixture must really stand on the line-shape condition, per layer 1's own measurement");
  assert.ok(bundleRow.tier1.status === "sampled" && bundleRow.tier1.size < mechanismById("partition-ast", MECHANISM_REGISTRY).maxFileBytes!,
    "and it must be under the SIZE bound, or this test would pass for the wrong reason");

  const result = await build(target, counted);
  const bundle = result.files.find((file) => file.relativePath === "bundle.js")!;
  assert.deepEqual(bundle.degraded, {
    reason: "builder-line-shape-cap",
    mechanism: "partition-ast",
    maxLineLength: declared,
    observedLineLength: bundleRow.tier1.status === "sampled" ? bundleRow.tier1.maxLineLength : 0
  });
  assert.deepEqual(bundle.cells.map((cell) => [cell.partitionKind, cell.span.startByte, cell.span.endByte]), [["residual", 0, bundle.size]],
    "a refused row still gets a complete partition — one residual cell — so nothing leaves the denominator");
  assert.deepEqual(bundle.refUnits, [], "and no reference unit, which is the point of the bound");
  // The neighbouring file is untouched: the bound is per row, decided from that row's own shape.
  assert.equal(result.files.find((file) => file.relativePath === "plain.js")!.degraded, null);

  // And layer 2 says the same thing about the same row, in its own vocabulary.
  const ledger = buildMechanismLedger({
    counted,
    filesContentManifestDigest: "digest",
    scannerVersion: "scanner",
    availability: availabilityWith(),
    languages: LANGUAGE_REGISTRY,
    mechanisms: MECHANISM_REGISTRY
  });
  const row = ledger.fileMatrix.find((entry) => entry.mechanismId === "partition-ast")!;
  const verdicts = expandMatrixRow(row, new Map([[".js", ["bundle.js", "plain.js"]]]));
  assert.deepEqual(verdicts.get("bundle.js"), { cell: "no-mechanism", cause: `partition-ast-line-cap-${declared}` });
  assert.deepEqual(verdicts.get("plain.js"), { cell: "covered" });
  recordDegrades(result);
});

test("the skeleton cache changes the cost and not one byte of the answer", async () => {
  const target = await tempDir("excavator-units-cache-hit-");
  await writeFile(join(target, "a.ts"), "export class A { m() {} }\nexport function f() { return 1; }\n");
  // Byte-identical content at a second path: the cache is content-addressed, so this is the shape that could
  // collapse two files into one — and the ids below prove it does not, because they are minted per path.
  await writeFile(join(target, "twin.ts"), "export class A { m() {} }\nexport function f() { return 1; }\n");
  const counted = await snapshot(target);
  const cacheDir = await tempDir("excavator-units-skeleton-cache-");

  const cold = await build(target, counted, PARTITION_DESIGNATION, await PartitionSkeletonCache.open(cacheDir));
  assert.equal(cold.cacheStats.misses, 1, "one parse for two byte-identical files: the second is a hit within the run");
  assert.equal(cold.cacheStats.hits, 1);
  const warm = await build(target, counted, PARTITION_DESIGNATION, await PartitionSkeletonCache.open(cacheDir));
  assert.equal(warm.cacheStats.misses, 0, "the second run parses nothing");
  assert.equal(warm.cacheStats.hits, 2);
  assert.equal(stableJson(warm.partition), stableJson(cold.partition), "and the partition is byte-identical");
  assert.equal(partitionContentDigest(warm), partitionContentDigest(cold));
  assert.equal(stableJson(warm.refUnits), stableJson(cold.refUnits));

  // The two twins share one cached parse and still get different ids, because the path is in the id.
  const idsOf = (path: string): string[] => warm.partition.filter((cell) => cell.relativePath === path).map((cell) => cell.unitId);
  // Two `export ` residuals, two structure cells, one trailing newline residual.
  assert.equal(idsOf("a.ts").length, 5);
  assert.deepEqual(idsOf("a.ts").filter((id) => idsOf("twin.ts").includes(id)), []);

  // The SENSITIVITY CONTROL for the key: a cache written by a different extractor identity must not be served.
  const stale = await PartitionSkeletonCache.open(cacheDir);
  const digest = counted.find((row) => row.relativePath === "a.ts")!.content;
  assert.equal(digest.status, "present");
  assert.equal(stale.get(digest.status === "present" ? digest.digest : "", "tsx", cold.files[0]!.size!), null,
    "the same bytes under a different grammar are a different tree, and the key says so");
  recordDegrades(cold);
});

test("every degrade reason has a fixture: the vocabulary may not contain a state nothing can produce", () => {
  assert.deepEqual([...EXERCISED].sort(), [...PARTITION_DEGRADE_REASONS].sort(),
    "an unreachable reason is a bucket that lies about what can happen; a missing one is an untested branch");
});

test("the skeleton walk stops at the outermost structural node, whatever wraps it", () => {
  // `export class Foo {}` parses as an export_statement whose CHILD is the class declaration, so a literal
  // "syntax depth 1" rule would have found nothing here. Measured on the real binding.
  const skeleton = extractAstSkeleton(AST_GREP!, "TypeScript", "export default class {}\nexport abstract class A { m(): void { } }\nconst g = function () {};\nfunction* gen() {}\n");
  assert.equal(skeleton.status, "built");
  if (skeleton.status !== "built") return;
  assert.deepEqual(skeleton.topLevel.map((node) => node.unitKind), ["class", "class", "function", "function"]);
  assert.deepEqual(flattenSkeleton(skeleton.topLevel).map((node) => [node.unitKind, node.depth]),
    [["class", 1], ["class", 1], ["method", 2], ["function", 1], ["function", 1]]);
  // The `class` KEYWORD token has the same kind string as the anonymous class expression; only `isNamed()` tells
  // them apart, and without that check every class would sprout a five-byte phantom nested class.
  assert.equal(flattenSkeleton(skeleton.topLevel).filter((node) => node.unitKind === "class").length, 2);
});

test("go's declarations, methods and closures come out of the same table", () => {
  const source = "package main\n\ntype T struct { A int }\n\nfunc Top() {}\n\nfunc (t T) M() { f := func() {}; _ = f }\n";
  const skeleton = extractAstSkeleton(AST_GREP!, "go", source);
  assert.equal(skeleton.status, "built");
  if (skeleton.status !== "built") return;
  assert.deepEqual(flattenSkeleton(skeleton.topLevel).map((node) => [node.unitKind, node.depth]),
    [["function", 1], ["method", 1], ["closure", 2]]);
  assert.equal(skeleton.byteLength, Buffer.byteLength(source, "utf8"));
});
