import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceItem, InvestigationPlan, InvestigationWorkItem } from "../src/types.ts";
import type { ScannedFile } from "../src/snapshot.ts";
import { sourceSearch } from "../src/source.ts";
import { buildCorpusBlock, corpusQualification } from "../src/search-corpus-coverage.ts";
import { capHistogram, type CensusEntry } from "../src/scan-census.ts";
import { auditWorkItems } from "../src/assurance.ts";
import { tempDir } from "./helpers.ts";

test("buildCorpusBlock aggregates text vs binary and the text extension histogram", () => {
  const entries: CensusEntry[] = [
    { relativePath: "a.txt", extension: ".txt", kind: "text" },
    { relativePath: "b.txt", extension: ".txt", kind: "text" },
    { relativePath: "c.svg", extension: ".svg", kind: "text" },
    { relativePath: "d.png", extension: ".png", kind: "binary" }
  ];
  const block = buildCorpusBlock("scanner-v2", { searchedFiles: 7, skippedTooLarge: 1, unreadable: 2 }, entries);
  assert.equal(block.scannerVersion, "scanner-v2");
  assert.equal(block.searchedFiles, 7);
  assert.equal(block.skippedTooLarge, 1);
  assert.equal(block.unreadable, 2);
  assert.equal(block.unscannedTextInScope, 3);
  assert.equal(block.unscannedBinaryInScope, 1);
  assert.deepEqual(block.unscannedTextExtensions, { ".txt": 2, ".svg": 1 });
});

test("capHistogram keeps the top keys and folds overflow into a single bucket", () => {
  const histogram: Record<string, number> = {};
  for (let index = 0; index < 25; index += 1) histogram[`.e${index}`] = 25 - index;
  const capped = capHistogram(histogram, 20);
  assert.equal(Object.keys(capped).length, 21, "20 kept keys plus one overflow bucket");
  assert.ok("…" in capped);
  assert.equal(capped["…"], 5 + 4 + 3 + 2 + 1, "overflow folds the five smallest counts");
});

test("sourceSearch reports searched, too-large and unreadable in-scope counts", async () => {
  const root = await tempDir();
  await writeFile(join(root, "small.cs"), "public class A { int x; }\n");
  const small = await stat(join(root, "small.cs"));
  const files: ScannedFile[] = [
    { absolutePath: join(root, "small.cs"), relativePath: "small.cs", size: small.size, extension: ".cs", rootName: "r" },
    // Filtered out by the per-file size cap (its `size` is what the filter reads); never opened.
    { absolutePath: join(root, "big.cs"), relativePath: "big.cs", size: 600_000, extension: ".cs", rootName: "r" },
    // A textual candidate whose file does not exist: it is attempted and counts as unreadable.
    { absolutePath: join(root, "missing.cs"), relativePath: "missing.cs", size: 100, extension: ".cs", rootName: "r" }
  ];
  const stats = { total: 0, returned: 0, truncated: false };
  await sourceSearch(files, ["class"], {}, stats);
  assert.equal(stats.searchedFiles, 1);
  assert.equal(stats.skippedTooLarge, 1);
  assert.equal(stats.unreadable, 1);
});

test("corpusQualification flags in-scope text gaps and names the extensions", () => {
  const q = corpusQualification({
    matches: [],
    corpus: { scannerVersion: "v2", searchedFiles: 3, skippedTooLarge: 0, unreadable: 0, unscannedTextInScope: 12, unscannedBinaryInScope: 5, unscannedTextExtensions: { ".txt": 12 } }
  });
  assert.ok(q?.qualified);
  assert.match(q!.message, /12 in-scope text files outside corpus/);
  assert.match(q!.message, /\.txt×12/);
});

test("corpusQualification counts too-large and unreadable gaps, but not binary-only", () => {
  const tooLarge = corpusQualification({ corpus: { scannerVersion: "v2", searchedFiles: 1, skippedTooLarge: 2, unreadable: 3, unscannedTextInScope: 0, unscannedBinaryInScope: 0, unscannedTextExtensions: {} } });
  assert.ok(tooLarge?.qualified);
  assert.match(tooLarge!.message, /2 text files skipped as too large/);
  assert.match(tooLarge!.message, /3 unreadable candidate files/);

  // Binary-only outside the corpus does not make a text search unreliable → not qualified.
  const binaryOnly = corpusQualification({ corpus: { scannerVersion: "v2", searchedFiles: 4, skippedTooLarge: 0, unreadable: 0, unscannedTextInScope: 0, unscannedBinaryInScope: 9, unscannedTextExtensions: {} } });
  assert.equal(binaryOnly?.qualified, false);
});

test("corpusQualification returns null for a receipt with no corpus block (grandfathered)", () => {
  assert.equal(corpusQualification({ candidateFiles: 5, truncated: false, matches: [] }), null);
  assert.equal(corpusQualification(undefined), null);
});

function receipt(id: string, data: Record<string, unknown>): EvidenceItem {
  return { id, snapshotId: "snap", kind: "search", title: "search", data, reason: "test", digest: "d" };
}

function searchedNotFoundItem(id: string, evidenceId: string): InvestigationWorkItem {
  return { id, dimension: "generic", scope: "s", hypothesis: "h", status: "searched-not-found", material: false, requiredFor: [], evidenceIds: [evidenceId], traceIds: [], origin: "open", searchScope: "all candidate files" };
}

test("a corpus-qualified searched-not-found work item yields a warning, not an error", () => {
  const gap = receipt("SEARCH-gap", { candidateFiles: 5, truncated: false, matches: [], corpus: { scannerVersion: "v2", searchedFiles: 5, skippedTooLarge: 0, unreadable: 0, unscannedTextInScope: 12, unscannedBinaryInScope: 3, unscannedTextExtensions: { ".txt": 12 } } });
  const plan: InvestigationPlan = { version: 1, runId: "r", createdAt: "t", items: [searchedNotFoundItem("W-open-1", "SEARCH-gap")] };
  const expected: InvestigationPlan = { version: 1, runId: "r", createdAt: "t", items: [] };
  const findings = auditWorkItems(plan, expected, new Map([[gap.id, gap]]), new Set());

  const advisory = findings.filter((f) => f.message.includes("corpus-qualified for W-open-1"));
  assert.equal(advisory.length, 1, "exactly one corpus-qualification advisory");
  assert.equal(advisory[0].level, "warning", "corpus qualification is advisory, never a gate");
  assert.match(advisory[0].message, /12 in-scope text files outside corpus \(\.txt×12\)/);
  // The hard searched-not-found proof still passes (candidates>0, not truncated, no matches).
  assert.ok(!findings.some((f) => f.level === "error" && f.message.includes("W-open-1")), "no hard error for a clean, corpus-qualified receipt");
});

test("a legacy receipt with no corpus block raises no advisory", () => {
  const legacy = receipt("SEARCH-legacy", { candidateFiles: 5, truncated: false, matches: [] });
  const plan: InvestigationPlan = { version: 1, runId: "r", createdAt: "t", items: [searchedNotFoundItem("W-open-2", "SEARCH-legacy")] };
  const expected: InvestigationPlan = { version: 1, runId: "r", createdAt: "t", items: [] };
  const findings = auditWorkItems(plan, expected, new Map([[legacy.id, legacy]]), new Set());
  assert.ok(!findings.some((f) => f.message.includes("corpus-qualified")), "receipts predating the corpus block are grandfathered");
});
