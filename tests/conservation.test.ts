import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { summarizeCoverage, summarizeSelection } from "../src/base/conservation.ts";
import { createSnapshot } from "../src/snapshot/snapshot.ts";
import { tempDir } from "./helpers.ts";

/**
 * The three-state law's two axes, each with one constructor.
 *
 * The compile-time half — an object literal with the right four numbers is NOT a conservation record, so no
 * layer can grow a second copy of the arithmetic — lives in `interface-laws.compile.ts`. Here: the residual is
 * derived and not accepted, an impossible partition throws, and layer 1's real ledger is minted through it.
 */

test("the coverage axis derives its residual instead of accepting one", () => {
  const balanced = summarizeCoverage({ total: 10, counted: 7, excluded: 3 });
  assert.deepEqual({ ...balanced }, { total: 10, counted: 7, excluded: 3, unexplained: 0 });
  const residual = summarizeCoverage({ total: 10, counted: 7, excluded: 2 });
  assert.equal(residual.unexplained, 1, "the honest residual is a subtraction, never an input, and never removable");
});

test("a partition that puts one candidate in two buckets is impossible, not merely unbalanced", () => {
  assert.throws(() => summarizeCoverage({ total: 5, counted: 4, excluded: 2 }), /impossible/);
  assert.throws(() => summarizeCoverage({ total: 5, counted: -1, excluded: 0 }), /non-negative integer/);
  assert.throws(() => summarizeCoverage({ total: 5.5, counted: 0, excluded: 0 }), /non-negative integer/);
});

test("the selection axis refuses an imbalance rather than publishing one", () => {
  const seated = summarizeSelection({ counted: 12, seated: 5, zeroScore: 6, displaced: 1 });
  assert.deepEqual({ ...seated }, { counted: 12, seated: 5, zeroScore: 6, displaced: 1 });
  assert.throws(() => summarizeSelection({ counted: 12, seated: 5, zeroScore: 6, displaced: 0 }), /conservation is broken/);
  // Zero-score is not an exclusion: a whole corpus that scored nothing still balances.
  assert.equal(summarizeSelection({ counted: 9, seated: 0, zeroScore: 9, displaced: 0 }).zeroScore, 9);
});

test("layer 1's ledger summary is minted through the constructor and still balances on a real scan", async () => {
  // Both buckets have to be populated for this to be worth running: a target whose every candidate is counted
  // would balance under an `excluded` term that was never computed at all.
  const target = await tempDir();
  await writeFile(join(target, "a.ts"), "export const a = 1;\n");
  await writeFile(join(target, "b.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(target, "notes.pem"), "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n");
  const { ledger } = await createSnapshot(target);
  const { total, counted, excluded, unexplained } = ledger.summary;
  assert.deepEqual({ total, counted, excluded, unexplained }, { total: 3, counted: 1, excluded: 2, unexplained: 0 });
  assert.equal(total, counted + excluded + unexplained);
  // The extra column rides alongside the four conserved terms; it is not one of them.
  assert.equal(Object.values(ledger.summary.byRule).reduce((sum, value) => sum + value, 0), excluded);
  // The brand is a TYPE, not a byte. A string-keyed brand would move `files.json`'s bytes for every target and
  // every archived run's tier2 digest with them, so the field's key set must be exactly the five it always had.
  assert.deepEqual(Object.keys(ledger.summary).sort(), ["byRule", "counted", "excluded", "total", "unexplained"]);
});
