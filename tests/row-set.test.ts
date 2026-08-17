import test from "node:test";
import assert from "node:assert/strict";
import { RowSet } from "../src/base/row-set.ts";
import { countedRowSet, type FileLedger } from "../src/snapshot/file-ledger.ts";
import { createSnapshot } from "../src/snapshot/snapshot.ts";
import { copyFixture } from "./helpers.ts";

/**
 * The denominator law, as a type.
 *
 * `RowSet`'s constructor is private, so the compile-time half of this is in `interface-laws.compile.ts` — a
 * `@ts-expect-error` on `new RowSet(...)` and one on handing a bare `string[]` to something that wants a
 * denominator. What is checkable at runtime is the other half: the factory refuses an identity it cannot
 * account to, refuses a non-canonical row set, and carries the ledger's completeness with the rows.
 */

const IDENTITY = {
  artifact: "ledger/files.json",
  contentDigest: "a".repeat(64),
  producerVersion: "git-aware-source-boundary-v2",
  completeness: { capReached: false, skippedByCap: 0, droppedRoots: [] as string[] }
};

test("a RowSet carries its unit kind, coverage domain, ledger identity and completeness", () => {
  const rows = RowSet.fromLedgerCounted([{ relativePath: "b.ts" }, { relativePath: "a.ts" }], IDENTITY);
  assert.equal(rows.unitKind, "file");
  assert.equal(rows.coverageDomain, "file");
  assert.equal(rows.size, 2);
  assert.deepEqual(rows.rowIds, ["a.ts", "b.ts"], "canonical order, so two derivations of one denominator are one value");
  assert.equal(rows.identity.contentDigest, IDENTITY.contentDigest);
  assert.equal(rows.identity.completeness.capReached, false);
  assert.ok(rows.has("a.ts"));
  assert.ok(!rows.has("c.ts"));
});

test("a RowSet cannot be built without the ledger identity it is accountable to", () => {
  assert.throws(() => RowSet.fromLedgerCounted([], { ...IDENTITY, artifact: "  " }), /artifact/);
  assert.throws(() => RowSet.fromLedgerCounted([], { ...IDENTITY, contentDigest: "" }), /content digest/);
  assert.throws(() => RowSet.fromLedgerCounted([], { ...IDENTITY, producerVersion: "" }), /producer/);
});

test("a repeated row identity is refused rather than silently collapsing the denominator", () => {
  // Layer 1's dedupe already reclassifies a repeated target-relative path as `duplicate-path`, so a repeat
  // arriving here means the caller fed something that is not the counted bucket.
  assert.throws(() => RowSet.fromLedgerCounted([{ relativePath: "a.ts" }, { relativePath: "a.ts" }], IDENTITY), /canonical/);
});

test("the completeness the ledger recorded travels with the rows and is not aliased", () => {
  const droppedRoots = ["z", "a"];
  const rows = RowSet.fromLedgerCounted([], { ...IDENTITY, completeness: { capReached: true, skippedByCap: 7, droppedRoots } });
  assert.deepEqual(rows.identity.completeness.droppedRoots, ["a", "z"]);
  droppedRoots.push("mutated-after-the-fact");
  assert.deepEqual(rows.identity.completeness.droppedRoots, ["a", "z"], "a denominator's completeness may not change under it");
});

/**
 * The layer-3 door. Three refusals, and each one is a denominator bug that no conservation sum would catch:
 * a duplicated cell id silently collapses the denominator, two overlapping cells of one file silently double-count
 * its bytes, and an identity with a blank field is a denominator nothing can be compared against.
 */
const CELL = (unitId: string, relativePath: string, startByte: number, endByte: number) =>
  ({ unitId, relativePath, span: { startByte, endByte } });

test("a partition RowSet is counted in partition cells over the file domain", () => {
  const rows = RowSet.fromPartition([
    CELL("cell:residual:20-30:a.ts", "a.ts", 20, 30),
    CELL("cell:structure:0-20:a.ts", "a.ts", 0, 20),
    CELL("cell:residual:0-0:b.ts", "b.ts", 0, 0)
  ], { ...IDENTITY, artifact: "facts/units.json" });
  assert.equal(rows.unitKind, "partition-cell", "a cell is not a file: conservation holds per granularity");
  assert.equal(rows.coverageDomain, "file", "the partition refines the file corpus rather than being a second one");
  assert.deepEqual(rows.rowIds, ["cell:residual:0-0:b.ts", "cell:residual:20-30:a.ts", "cell:structure:0-20:a.ts"]);
  assert.equal(rows.identity.artifact, "facts/units.json");
  assert.ok(rows.has("cell:residual:0-0:b.ts"));
});

test("a repeated partition cell id is refused rather than silently collapsing the denominator", () => {
  assert.throws(() => RowSet.fromPartition([
    CELL("cell:structure:0-20:a.ts", "a.ts", 0, 20),
    CELL("cell:structure:0-20:a.ts", "a.ts", 0, 20)
  ], IDENTITY), /1 partition cell id\(s\) appear more than once/);
});

test("two cells of one file that overlap are refused: the file's bytes would be counted twice", () => {
  assert.throws(() => RowSet.fromPartition([
    CELL("cell:structure:0-20:a.ts", "a.ts", 0, 20),
    CELL("cell:structure:10-30:a.ts", "a.ts", 10, 30)
  ], IDENTITY), /may not double-count bytes: a\.ts has overlapping cells \[0, 20\) and \[10, 30\)/);
  // Adjacency is not overlap, and two files may of course share byte ranges.
  assert.equal(RowSet.fromPartition([
    CELL("cell:structure:0-20:a.ts", "a.ts", 0, 20),
    CELL("cell:residual:20-30:a.ts", "a.ts", 20, 30),
    CELL("cell:structure:0-20:b.ts", "b.ts", 0, 20)
  ], IDENTITY).size, 3);
});

test("a partition RowSet cannot be built without the identity it is accountable to", () => {
  const cells = [CELL("cell:residual:0-1:a.ts", "a.ts", 0, 1)];
  assert.throws(() => RowSet.fromPartition(cells, { ...IDENTITY, artifact: " " }), /artifact/);
  assert.throws(() => RowSet.fromPartition(cells, { ...IDENTITY, contentDigest: "" }), /content digest/);
  assert.throws(() => RowSet.fromPartition(cells, { ...IDENTITY, producerVersion: "  " }), /producer/);
});

test("the layer-1 ledger really is a RowSet source: size equals counted, and the digest is the ledger's", async () => {
  const { ledger } = await createSnapshot(await copyFixture());
  const rows = countedRowSet(ledger as FileLedger);
  assert.equal(rows.size, ledger.summary.counted, "the denominator is the counted bucket, not the candidate table");
  assert.equal(rows.identity.contentDigest, ledger.contentManifestDigest);
  assert.equal(rows.identity.producerVersion, ledger.scannerVersion);
  assert.deepEqual(rows.rowIds, ledger.counted.map((row) => row.relativePath).sort());
});
