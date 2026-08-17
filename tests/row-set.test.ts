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

test("the layer-1 ledger really is a RowSet source: size equals counted, and the digest is the ledger's", async () => {
  const { ledger } = await createSnapshot(await copyFixture());
  const rows = countedRowSet(ledger as FileLedger);
  assert.equal(rows.size, ledger.summary.counted, "the denominator is the counted bucket, not the candidate table");
  assert.equal(rows.identity.contentDigest, ledger.contentManifestDigest);
  assert.equal(rows.identity.producerVersion, ledger.scannerVersion);
  assert.deepEqual(rows.rowIds, ledger.counted.map((row) => row.relativePath).sort());
});
