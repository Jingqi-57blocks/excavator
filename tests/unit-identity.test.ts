import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAstGrep } from "../src/facts/probe/condition-extract.ts";
import { PartitionSkeletonCache } from "../src/facts/units/partition-cache.ts";
import { extractAstSkeleton, flattenSkeleton } from "../src/facts/units/ast-partition.ts";
import {
  canonicalSpan, compareSpans, lineOffsetsFromBytes, mintRefUnitId, mintUnitId, parseUnitId, spanSize, spansOverlap,
  utf8OffsetMap, PARTITION_KINDS, UNIT_KINDS
} from "../src/facts/units/unit-identity.ts";
import { buildPartition } from "../src/facts/units/partition-build.ts";
import { PARTITION_DESIGNATION } from "../src/base/partition-designation.ts";
import { LANGUAGE_REGISTRY } from "../src/base/language-registry.ts";
import { MECHANISM_REGISTRY } from "../src/base/mechanism-registry.ts";
import { createSnapshot } from "../src/snapshot/snapshot.ts";
import type { FileLedger } from "../src/snapshot/file-ledger.ts";
import { tempDir } from "./helpers.ts";

/**
 * The canonical span, and the instrument it is measured with.
 *
 * The whole design of `UnitId` rests on one fact nobody in this repository had ever checked: what unit
 * `@ast-grep/napi`'s `range().index` counts in. Its own type declares "byte offset of the position". The first
 * test below measures it, and the answer is UTF-16 CODE UNITS — so every span is converted before it becomes a
 * canonical span, and this file is where that conversion can go red.
 *
 * A test that only asserted "the span slices the right text" would pass under either answer for a pure-ASCII
 * fixture, which is why the fixture is deliberately non-ASCII and why the WRONG reading is asserted to be wrong.
 */

const ASTRAL = "\u{1F680}"; // a four-byte, two-UTF-16-unit character

test("ast-grep's range index is measured, not assumed: it counts UTF-16 code units, not UTF-8 bytes", () => {
  const api = loadAstGrep();
  assert.ok(api, "the ast-grep binding is required for this measurement; without it the span design is unverified");
  // 中文注释 is 4 characters at 3 bytes each; the rocket is 4 bytes and 2 UTF-16 units.
  const source = `// 中文注释 ${ASTRAL}\nfunction alpha() { return 1; }\n`;
  const bytes = Buffer.from(source, "utf8");
  assert.notEqual(bytes.length, source.length, "the fixture must actually be non-ASCII, or it cannot tell the two answers apart");

  const raw = api.parse("TypeScript", source).root();
  const declaration = raw.children().find((node) => node.kind() === "function_declaration");
  assert.ok(declaration, "the fixture must contain a top-level function declaration");
  const range = declaration.range();
  assert.equal(source.slice(range.start.index, range.end.index), "function alpha() { return 1; }",
    "slicing the source as UTF-16 with the reported index recovers the declaration — so the index is UTF-16 code units");
  assert.notEqual(bytes.subarray(range.start.index, range.end.index).toString("utf8"), "function alpha() { return 1; }",
    "and reading the same index as a UTF-8 byte offset does NOT: this is the failure the conversion prevents");

  // What the builder produces, after conversion: a span that indexes the FILE's bytes.
  const skeleton = extractAstSkeleton(api, "TypeScript", source);
  assert.equal(skeleton.status, "built");
  if (skeleton.status !== "built") return;
  assert.equal(skeleton.byteLength, bytes.length);
  const [node] = skeleton.topLevel;
  assert.ok(node);
  assert.equal(bytes.subarray(node.span.startByte, node.span.endByte).toString("utf8"), "function alpha() { return 1; }",
    "a canonical span is a UTF-8 byte interval of the file, so slicing the file's bytes with it must recover the declaration");
  assert.equal(node.span.startByte, source.slice(0, range.start.index).length + (bytes.length - source.length),
    "the converted offset differs from the raw index by exactly the multi-byte inflation ahead of it");
});

test("the UTF-8 offset map agrees with Node's own encoder at every index", () => {
  for (const source of ["", "abc", "中", `a中b${ASTRAL}c`, `${ASTRAL}${ASTRAL}`, "line\n中文\nend\n"]) {
    const map = utf8OffsetMap(source);
    assert.equal(map.byteLength, Buffer.byteLength(source, "utf8"), source);
    for (let index = 0; index <= source.length; index++) {
      // The index inside a surrogate pair is not a character boundary at all; the map refuses it rather than
      // answering with a plausible number.
      const insidePair = index > 0 && index < source.length
        && source.charCodeAt(index - 1) >= 0xd800 && source.charCodeAt(index - 1) <= 0xdbff
        && source.charCodeAt(index) >= 0xdc00 && source.charCodeAt(index) <= 0xdfff;
      if (insidePair) {
        assert.throws(() => map.byteOffsetOf(index), /surrogate pair/, `${JSON.stringify(source)} @ ${index}`);
        continue;
      }
      assert.equal(map.byteOffsetOf(index), Buffer.byteLength(source.slice(0, index), "utf8"), `${JSON.stringify(source)} @ ${index}`);
    }
  }
});

test("the offset map refuses an index outside the source", () => {
  const map = utf8OffsetMap("中文");
  assert.throws(() => map.byteOffsetOf(3), /outside the source/);
  assert.throws(() => map.byteOffsetOf(-1), /outside the source/);
});

test("a canonical span is a half-open byte interval, and the empty file has one", () => {
  assert.deepEqual(canonicalSpan(0, 0), { startByte: 0, endByte: 0 });
  assert.equal(spanSize(canonicalSpan(4, 9)), 5);
  assert.throws(() => canonicalSpan(9, 4), /backwards/);
  assert.throws(() => canonicalSpan(-1, 4), /non-negative integer/);
  assert.throws(() => canonicalSpan(0, 1.5), /non-negative integer/);
  // Half-open: touching end-to-start is adjacency, not overlap. The whole residual algorithm rests on this.
  assert.equal(spansOverlap(canonicalSpan(0, 5), canonicalSpan(5, 9)), false);
  assert.equal(spansOverlap(canonicalSpan(0, 6), canonicalSpan(5, 9)), true);
  assert.equal(spansOverlap(canonicalSpan(0, 0), canonicalSpan(0, 0)), false, "two empty spans cannot overlap");
  assert.ok(compareSpans(canonicalSpan(0, 5), canonicalSpan(0, 9)) < 0);
});

test("the line index counts the file's own bytes, and its answers are checked against a hand-computed table", () => {
  // Non-ASCII on purpose: a newline is one byte in UTF-8 while a multi-byte character is not, so an index built
  // from the decoded string's character offsets would be wrong here and plausible everywhere.
  const source = "const 名前 = 1;\n// 二行目 🎉\nexport function f() {}\n";
  const bytes = Buffer.from(source, "utf8");
  const offsets = lineOffsetsFromBytes(bytes);
  assert.equal(offsets.byteLength, bytes.length);
  assert.equal(offsets.lineCount, 3);
  // Recomputed from the encoder rather than from a literal, so the expectation is derived and not remembered.
  const expected = source.split("\n").slice(0, 3).map((line) => Buffer.byteLength(line, "utf8"));
  let cursor = 0;
  for (let line = 1; line <= 3; line++) {
    assert.equal(offsets.startOfLine(line), cursor, `line ${line} starts where the previous one ended`);
    cursor += expected[line - 1]! + 1;  // + the newline, which `endOfLine` includes
    assert.equal(offsets.endOfLine(line), cursor);
  }
  assert.equal(cursor, bytes.length, "the lines tile the file exactly");
  assert.equal(bytes.subarray(offsets.startOfLine(3), offsets.endOfLine(3)).toString("utf8"), "export function f() {}\n");
  assert.throws(() => offsets.startOfLine(0), /outside the file \(1\.\.3\)/);
  assert.throws(() => offsets.endOfLine(4), /outside the file \(1\.\.3\)/);

  // The two files whose line structure is easiest to get wrong.
  assert.equal(lineOffsetsFromBytes(Buffer.alloc(0)).lineCount, 1, "an empty file has one empty line");
  assert.equal(lineOffsetsFromBytes(Buffer.alloc(0)).endOfLine(1), 0);
  const trailing = lineOffsetsFromBytes(Buffer.from("a\n", "utf8"));
  assert.equal(trailing.lineCount, 1, "a trailing newline does not open a line that is not there");
  assert.equal(trailing.endOfLine(1), 2);
  const blank = lineOffsetsFromBytes(Buffer.from("a\n\nb", "utf8"));
  assert.deepEqual([blank.lineCount, blank.startOfLine(2), blank.endOfLine(2)], [3, 2, 3], "and a blank line is a line");
});

test("neither id constructor has a producer parameter, and neither id mentions one", () => {
  const span = canonicalSpan(10, 30);
  const refId = mintRefUnitId("method", span, "src/a:b.ts");
  const cellId = mintUnitId("structure", span, "src/a:b.ts");
  assert.equal(refId, "ref:method:10-30:src/a:b.ts");
  assert.equal(cellId, "cell:structure:10-30:src/a:b.ts");
  for (const producer of ["codegraph", "crossrepo", "framework", "native-graph", "db-schema", "probe", "vocabulary"]) {
    assert.ok(!refId.includes(producer) && !cellId.includes(producer), `an id may not carry ${producer}`);
  }
  // The path goes LAST and only the first three colons are separators, so a colon in a path round-trips.
  assert.deepEqual(parseUnitId(refId), { namespace: "ref", kind: "method", span, relativePath: "src/a:b.ts" });
  assert.deepEqual(parseUnitId(cellId), { namespace: "cell", kind: "structure", span, relativePath: "src/a:b.ts" });
});

test("a malformed or hand-assembled id is refused rather than half-understood", () => {
  assert.throws(() => parseUnitId("ref:method:10-30"), /expected <namespace>/);
  assert.throws(() => parseUnitId("unit:method:10-30:a.ts"), /unknown namespace/);
  assert.throws(() => parseUnitId("ref:structure:10-30:a.ts"), /is not one of class, function, method, closure/);
  assert.throws(() => parseUnitId("cell:method:10-30:a.ts"), /is not one of structure, residual/);
  assert.throws(() => parseUnitId("ref:method:10:a.ts"), /is not a byte range/);
  assert.throws(() => parseUnitId("ref:method:10-30:"), /no path component/);
  assert.throws(() => mintUnitId("residual", canonicalSpan(0, 1), " "), /target-relative path/);
  assert.throws(() => mintUnitId("residual", canonicalSpan(0, 1), "/abs/a.ts"), /target-RELATIVE/);
  assert.deepEqual([...UNIT_KINDS], ["class", "function", "method", "closure"]);
  assert.deepEqual([...PARTITION_KINDS], ["structure", "residual"]);
});

/**
 * The collision fixture, and its own instrument prior.
 *
 * The first assertion is the one that makes the rest meaningful: layer 1 must really give these files the SAME
 * tier2 digest. Without it the test could pass while the fixture never stood on the collision condition at all —
 * measured on real targets, 226 of provital's 3005 counted files are byte-identical to another path (83 groups,
 * the largest 22 empty `__init__.py` files), so this is the shape a content-addressed identity would collapse.
 */
test("two byte-identical files at two paths get the same content digest and different unit ids", async () => {
  const target = await tempDir("excavator-collision-");
  await mkdir(join(target, "a"), { recursive: true });
  await mkdir(join(target, "b"), { recursive: true });
  const twins: Array<[string, string]> = [
    ["a/same.ts", "b/same.ts"],
    ["a/empty.ts", "b/empty.ts"],
    ["a/newline.ts", "b/newline.ts"]
  ];
  await writeFile(join(target, "a/same.ts"), "export function twin() { return 1; }\n");
  await writeFile(join(target, "b/same.ts"), "export function twin() { return 1; }\n");
  await writeFile(join(target, "a/empty.ts"), "");
  await writeFile(join(target, "b/empty.ts"), "");
  await writeFile(join(target, "a/newline.ts"), "\n");
  await writeFile(join(target, "b/newline.ts"), "\n");

  const cacheDir = await tempDir("excavator-collision-cache-");
  const { ledger } = await createSnapshot(target, 100_000, { cacheDir });
  const counted = (ledger as FileLedger).counted;
  const digestOf = (path: string): string => {
    const row = counted.find((entry) => entry.relativePath === path);
    assert.ok(row, `${path} must be a counted row`);
    assert.equal(row.content.status, "present");
    return row.content.status === "present" ? row.content.digest : "";
  };
  for (const [left, right] of twins) {
    assert.equal(digestOf(left), digestOf(right),
      `${left} and ${right} must really collide on tier2, or this fixture is not standing on the collision condition`);
  }

  const built = await buildPartition({
    counted,
    target,
    languages: LANGUAGE_REGISTRY,
    designation: PARTITION_DESIGNATION,
    mechanisms: MECHANISM_REGISTRY,
    astGrep: loadAstGrep(),
    // A REAL cache, because that is the configuration that could collapse these two files into one skeleton and
    // therefore the configuration this fixture has to stand in: the cache is content-addressed, so both twins
    // share one cached parse, and the ids below must still differ.
    cache: await PartitionSkeletonCache.open(await tempDir("excavator-collision-units-cache-"))
  });
  const cellsOf = (path: string): string[] => built.partition.filter((cell) => cell.relativePath === path).map((cell) => cell.unitId);
  for (const [left, right] of twins) {
    const a = cellsOf(left);
    const b = cellsOf(right);
    assert.ok(a.length > 0 && b.length > 0, `${left} / ${right} must both be partitioned`);
    assert.deepEqual([...new Set([...a, ...b])].length, a.length + b.length,
      `${left} and ${right} are byte-identical and must still get disjoint cell ids`);
  }
  // The empty file is the extreme case: `[0,0)` for both, distinguished only by the path component.
  assert.deepEqual(cellsOf("a/empty.ts"), ["cell:residual:0-0:a/empty.ts"]);
  assert.deepEqual(cellsOf("b/empty.ts"), ["cell:residual:0-0:b/empty.ts"]);
  assert.deepEqual(cellsOf("a/newline.ts"), ["cell:residual:0-1:a/newline.ts"]);

  // And the producer-free identity means two observers of one function necessarily agree on the ref unit id:
  // there is no producer component that could make them disagree. (Merging their `observedBy` is the units
  // artifact's job, and lands with it.)
  const refIds = built.refUnits.filter((unit) => unit.relativePath === "a/same.ts").map((unit) => unit.refUnitId);
  assert.equal(refIds.length, 1);
  const skeleton = extractAstSkeleton(loadAstGrep()!, "TypeScript", "export function twin() { return 1; }\n");
  assert.equal(skeleton.status, "built");
  if (skeleton.status !== "built") return;
  const reobserved = flattenSkeleton(skeleton.topLevel).map((node) => mintRefUnitId(node.unitKind, node.span, "a/same.ts"));
  assert.deepEqual(reobserved, refIds, "a second observation of the same structure mints the same id, so it merges rather than duplicating");
});
