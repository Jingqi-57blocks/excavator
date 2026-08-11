import type { SearchReceiptCorpus } from "./types.ts";
import { capHistogram, type CensusEntry } from "./scan-census.ts";

/** Distinct extension keys kept in a receipt's unscanned-text histogram; overflow folds into "…". */
const RECEIPT_EXTENSION_CAP = 20;

/** Per-file search accounting a `sourceSearch` reports back for corpus qualification. */
export interface SearchCorpusStats {
  searchedFiles: number;
  skippedTooLarge: number;
  unreadable: number;
}

/**
 * Assemble the corpus block recorded on a SEARCH receipt. It makes a `searched-not-found` verdict
 * honest about its reach: `searchedFiles` are the in-scope manifest files actually read, while the
 * remaining fields count the in-scope gaps a plain text search cannot see — manifest files too large
 * to read, unreadable ones, and files inside the boundary that the whitelist never admitted (text vs
 * binary, with a capped histogram of the text extensions). `inScopeUnscanned` is the boundary census
 * already filtered to the search's path prefixes.
 */
export function buildCorpusBlock(scannerVersion: string, stats: SearchCorpusStats, inScopeUnscanned: CensusEntry[]): SearchReceiptCorpus {
  const textEntries = inScopeUnscanned.filter((entry) => entry.kind === "text");
  const histogram: Record<string, number> = {};
  for (const entry of textEntries) histogram[entry.extension] = (histogram[entry.extension] ?? 0) + 1;
  return {
    scannerVersion,
    searchedFiles: stats.searchedFiles,
    skippedTooLarge: stats.skippedTooLarge,
    unreadable: stats.unreadable,
    unscannedTextInScope: textEntries.length,
    unscannedBinaryInScope: inScopeUnscanned.length - textEntries.length,
    unscannedTextExtensions: capHistogram(histogram, RECEIPT_EXTENSION_CAP)
  };
}

/**
 * Audit predicate shared by the checklist and work-item `searched-not-found` checks. Given a SEARCH
 * receipt's `data`, it reports whether the receipt is *corpus-qualified* — i.e. the search left
 * in-scope text gaps (unscanned text, too-large or unreadable files) that make a not-found verdict
 * less than exhaustive — and a human-readable summary of those gaps. Returns `null` for a receipt
 * with no corpus block (a receipt recorded before this field existed is grandfathered, never
 * qualified). Binary gaps do not qualify: a binary file would not carry the searched text as text.
 */
export function corpusQualification(data: Record<string, unknown> | undefined): { qualified: boolean; message: string } | null {
  const corpus = data?.corpus as SearchReceiptCorpus | undefined;
  if (!corpus || typeof corpus !== "object") return null;
  const textGap = Number(corpus.unscannedTextInScope ?? 0);
  const tooLarge = Number(corpus.skippedTooLarge ?? 0);
  const unreadable = Number(corpus.unreadable ?? 0);
  if (textGap <= 0 && tooLarge <= 0 && unreadable <= 0) return { qualified: false, message: "" };
  const parts: string[] = [];
  if (textGap > 0) {
    const exts = Object.entries(corpus.unscannedTextExtensions ?? {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([ext, count]) => `${ext || "<no-ext>"}×${count}`);
    parts.push(`${textGap} in-scope text files outside corpus${exts.length ? ` (${exts.join(", ")})` : ""}`);
  }
  if (tooLarge > 0) parts.push(`${tooLarge} text files skipped as too large`);
  if (unreadable > 0) parts.push(`${unreadable} unreadable candidate files`);
  return { qualified: true, message: parts.join("; ") };
}
