import { open } from "node:fs/promises";
import type { BoundaryCensus } from "./types.ts";

const SNIFF_BYTES = 8192;

/** Cap on distinct extension keys retained in an aggregated histogram; overflow folds into "…". */
export const HISTOGRAM_KEY_CAP = 50;

/**
 * Classify a file as text or binary by sniffing its first 8KB for a NUL byte (empty file → text).
 * Deterministic and cheap: it reads at most one 8KB block, never the whole file. Conservative — a
 * UTF-16 file, whose ASCII range interleaves NUL bytes, is reported binary and therefore stays out of
 * the searchable-text accounting rather than being over-counted as searchable.
 */
export async function sniffFileKind(absolutePath: string): Promise<"text" | "binary"> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absolutePath, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    for (let index = 0; index < bytesRead; index += 1) if (buffer[index] === 0) return "binary";
    return "text";
  } catch {
    // Unreadable at census time: count it as binary so it never inflates the searchable-text total.
    return "binary";
  } finally {
    await handle?.close();
  }
}

/** One file that sits inside the scan boundary but was not admitted to the searchable manifest. */
export interface CensusEntry {
  relativePath: string;
  extension: string; // lowercased extname; "" for dotfiles / extension-less names
  kind: "text" | "binary";
}

/**
 * Sort an extension→count histogram deterministically (by descending count, then key) and cap it to
 * `limit` keys, folding the remaining counts into a single "…" bucket. Shared by the persisted
 * boundary census and the per-search receipt so both aggregate the same way.
 */
export function capHistogram(histogram: Record<string, number>, limit: number): Record<string, number> {
  const sorted = Object.entries(histogram).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (sorted.length <= limit) return Object.fromEntries(sorted);
  const kept = sorted.slice(0, limit);
  const overflow = sorted.slice(limit).reduce((sum, [, count]) => sum + count, 0);
  return { ...Object.fromEntries(kept), "…": overflow };
}

/**
 * Accumulates the boundary census during a scan: files inside the fixed-exclusion boundary that the
 * whitelist did not admit (plus whitelisted files skipped for size). The aggregate is a non-identity
 * snapshot field; the per-entry detail is kept in memory for path-prefix scoping at search time.
 */
export class BoundaryCensusBuilder {
  readonly entries: CensusEntry[] = [];
  private truncated = false;

  add(entry: CensusEntry): void { this.entries.push(entry); }
  markTruncated(): void { this.truncated = true; }

  summary(): BoundaryCensus {
    const unscannedText: Record<string, number> = {};
    let unscannedBinary = 0;
    for (const entry of this.entries) {
      if (entry.kind === "binary") { unscannedBinary += 1; continue; }
      unscannedText[entry.extension] = (unscannedText[entry.extension] ?? 0) + 1;
    }
    return { unscannedText: capHistogram(unscannedText, HISTOGRAM_KEY_CAP), unscannedBinary, manifestTruncated: this.truncated };
  }
}
