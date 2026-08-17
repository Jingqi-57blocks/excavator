import { createHash } from "node:crypto";
import type { ArtifactResult } from "../base/artifact-result.ts";
import { summarizeCoverage, type CoverageConservation } from "../base/conservation.ts";
import { RowSet } from "../base/row-set.ts";
import { stableJson } from "../base/util.ts";
import { ContentIdentityCache, type ContentStat, type RowShape } from "./content-identity.ts";

/**
 * Layer 1's artifact: the file ledger.
 *
 * The candidate set is every file root discovery produced that a directory-level ignore rule did not prune,
 * and each candidate lands in EXACTLY ONE bucket — counted, excluded under a named rule, or unexplained. Before
 * this, `scanRoot` dropped candidates through five bare `continue`s and `scanWorkspace` could drop a whole root
 * through a bare `break`, and none of it was recorded anywhere: "we forgot to register `.ejs`" and "the cap cut
 * the scan in half" were both invisible at the layer that owns every downstream denominator.
 *
 * Three decisions in the row shape are load-bearing:
 *
 *  - ROW IDENTITY is (snapshot identity, normalized target-relative path). The tier2 content digest is a
 *    mandatory ATTRIBUTE of a row, never its identity: measured on the scanner's own corpus, 226 of provital's
 *    3005 files are byte-identical to another path (83 groups, the largest 22 empty `__init__.py` files), so a
 *    content-hash identity would silently collapse the denominator while every conservation law still balanced.
 *    The composition is declared in the artifact so no consumer re-assembles the tuple from parts.
 *  - EXCLUSIONS split by mechanism, not by guesswork. Directory-level workspace machinery (`.git`,
 *    `.codegraph`, `node_modules`) is pruned before candidacy and produces no rows — that list is already
 *    covered by `ignoreRulesDigest`, and it is also the structural precondition for "adding an index does not
 *    change one byte of this ledger". File-level exclusions (`.pem`, `.env`, `.DS_Store`) DO produce rows, so a
 *    tracked private key is visible rather than absent.
 *  - `unsupported-extension` gets ONE rule and a shape column, not a second taxonomy. Grouping by extension
 *    with the row shape aggregated means `.ejs 14 (textual)` and `.png 533 (binary)` are two readable lines;
 *    inventing a second "what counts as source" classification here would put that judgement in two places.
 */

export const FILE_LEDGER_VERSION = "files-ledger-v1";

/**
 * Why a candidate is not counted. Every value corresponds to one former silent `continue`:
 * `cap-reached` and `duplicate-path` to the selection rules, the rest to the filters in the scan loop.
 */
export type ExcludeRule =
  | "unsupported-extension"
  | "sensitive-file"
  | "os-artifact"
  | "path-escape"
  | "irregular-file"
  | "symlink"
  | "oversize"
  | "stat-failed"
  | "cap-reached"
  | "duplicate-path";

export const EXCLUDE_RULES: ExcludeRule[] = [
  "cap-reached", "duplicate-path", "irregular-file", "os-artifact", "oversize",
  "path-escape", "sensitive-file", "stat-failed", "symlink", "unsupported-extension"
];

/**
 * The tier1 shape of a row. Three states, each with a written reason — a candidate whose bytes could not be
 * sampled says so rather than reporting a shape it never observed.
 */
export type Tier1Shape =
  | { status: "sampled"; size: number; mtimeMs: number; shape: RowShape; sampledBytes: number; maxLineLength: number }
  /**
   * Stat succeeded and the bytes were NOT read. Three causes, and the distinction matters to a reader:
   * `cap-reached` (the candidate was already refused), `sensitive` (reading it is the thing we refuse to do —
   * see `SENSITIVE_FILES`), and `read-failed` (the read was attempted and lost the race with a change).
   */
  | { status: "stat-only"; size: number; mtimeMs: number; reason: "cap-reached" | "sensitive" | "read-failed" }
  /** No stat and no bytes: the path escaped the root, is not a regular file, or `lstat` failed. */
  | { status: "unsampled"; reason: "path-escape" | "irregular-file" | "symlink" | "stat-failed" };

/**
 * A row's tier2 content identity. The absent reasons are a CLOSED pair and they are not interchangeable:
 * `excluded` is policy (an excluded row's bytes are deliberately never hashed) and `read-failed` is a defect in
 * the observation (a counted row lost the race between `lstat` and `readFile`). Counted rows may only carry
 * `read-failed` and excluded rows only `excluded`; `resolveIdentity` is the single place that mints either, so
 * the pairing is structural rather than remembered. Before this split, a counted row whose read failed borrowed
 * the `excluded` shell and the ledger read as "we chose not to hash it" — the bucket said the opposite of what
 * happened, and the audit had nothing to catch.
 */
export type ContentIdentityRecord =
  | { status: "present"; algorithm: "sha256"; digest: string }
  | { status: "absent"; reason: "excluded" | "read-failed" };

export interface CountedRow {
  relativePath: string;
  rootName: string;
  extension: string;
  tier1: Tier1Shape;
  content: ContentIdentityRecord;
}

export interface ExcludedRow extends CountedRow {
  rule: ExcludeRule;
}

/** One (rule x extension) group with the row shapes aggregated; `mixed` when the rows disagree. */
export interface LedgerGroupRow {
  rule: ExcludeRule;
  extension: string;
  count: number;
  shape: RowShape | "mixed" | "unsampled";
}

export interface LedgerRootRecord {
  name: string;
  /** `not-examined` is a root the cap dropped: it was discovered, and then never looked at. */
  candidateSource: "git-ls-files" | "filesystem-walk" | "not-examined";
  candidates: number;
  counted: number;
  /** True when the file cap ran out before this root was scanned at all. */
  dropped: boolean;
}

export interface LedgerCompleteness {
  maxFiles: number;
  /** Whether the cap changed the outcome: it refused a candidate, or a whole root was never examined. */
  capReached: boolean;
  /** Candidates that passed every filter and were refused only for lack of room. */
  skippedByCap: number;
  /** Roots the cap dropped entirely, by name. Their files are not in ANY bucket because they were never seen. */
  droppedRoots: string[];
  roots: LedgerRootRecord[];
}

export interface FileLedger {
  version: typeof FILE_LEDGER_VERSION;
  scannerVersion: string;
  target: string;
  /** The row identity contract, stated in the artifact so no consumer re-derives it. */
  rowIdentity: { components: string[]; contentDigestIsAttribute: true };
  /**
   * The coverage axis of the three-state law, minted by the one constructor that can produce it
   * (`summarizeCoverage`) plus this artifact's own extra column. The four numbers are byte-identical to the
   * four this field always held; what changed is that they can no longer be written by hand here.
   */
  summary: CoverageConservation & { byRule: Record<string, number> };
  completeness: LedgerCompleteness;
  counted: CountedRow[];
  excluded: ExcludedRow[];
  excludedGroups: LedgerGroupRow[];
  /** The honest residual: a candidate in no bucket. Constructively empty, and never removable. */
  unexplained: CountedRow[];
  /** tier1 whole-table digest: (path, size, mtime) over the counted rows. Advisory on mismatch. */
  sourceManifestDigest: string;
  /** tier2 whole-table digest: the content identity the snapshot id anchors on. An error on mismatch. */
  contentManifestDigest: string;
}

/** A candidate as the scan loop classified it, before its bytes were looked at. */
export interface LedgerDraftRow {
  relativePath: string;
  absolutePath: string;
  rootName: string;
  extension: string;
  /** Null when the candidate is counted. */
  rule: ExcludeRule | null;
  /** Null when `lstat` produced nothing. `ctimeMs` is carried for the content cache key only — it is never
   *  written into the ledger, because a chmod would then move the artifact's bytes without any content change. */
  stat: ContentStat | null;
  /** Why no sample can be taken; null when the bytes are readable. */
  unsampled: "path-escape" | "irregular-file" | "symlink" | "stat-failed" | null;
}

/**
 * The accumulator the scan loop writes into. It owns exactly one invariant: `total` counts every candidate
 * once, and every candidate is pushed into exactly one bucket, so `unexplained` is a subtraction that can only
 * be non-zero if this class is wrong.
 */
export class FileLedgerDraft {
  readonly rows: LedgerDraftRow[] = [];
  readonly roots: LedgerRootRecord[] = [];
  private total = 0;
  private capRefusals = 0;
  private readonly dropped: string[] = [];

  candidate(row: LedgerDraftRow): void {
    this.total += 1;
    this.rows.push(row);
    if (row.rule === "cap-reached") this.capRefusals += 1;
  }

  root(record: LedgerRootRecord): void {
    this.roots.push(record);
    if (record.dropped) this.dropped.push(record.name);
  }

  /** Reclassify a candidate the target-relative dedupe dropped; the winner keeps `rule: null`. */
  deduplicate(): void {
    const lastCountedIndex = new Map<string, number>();
    this.rows.forEach((row, index) => { if (row.rule === null) lastCountedIndex.set(row.relativePath, index); });
    this.rows.forEach((row, index) => {
      if (row.rule === null && lastCountedIndex.get(row.relativePath) !== index) row.rule = "duplicate-path";
    });
  }

  counts(): { total: number; skippedByCap: number; droppedRoots: string[] } {
    return { total: this.total, skippedByCap: this.capRefusals, droppedRoots: [...this.dropped].sort() };
  }
}

/**
 * Resolve every row's identity tiers and assemble the ledger. Counted rows get tier1 and tier2; excluded rows
 * get tier1 only and record their content as `absent{excluded}` — reading the bytes of an excluded candidate
 * to hash them would be work no consumer can use. For a `sensitive-file` row nothing is read AT ALL, not even
 * the tier1 sample: that rule's whole purpose is not doing work on a private key or a live `.env`.
 */
export async function buildFileLedger(input: {
  draft: FileLedgerDraft;
  target: string;
  scannerVersion: string;
  maxFiles: number;
  cacheDir?: string;
}): Promise<FileLedger> {
  const { draft, target, scannerVersion, maxFiles } = input;
  draft.deduplicate();
  const cache = await ContentIdentityCache.open(input.cacheDir);
  const counted: CountedRow[] = [];
  const excluded: ExcludedRow[] = [];
  for (const row of draft.rows) {
    // ONE pass per row: the digest needs every byte and the shape is read from the first 8 KiB of the same
    // read. Resolving them separately doubled the I/O on every counted file of every cold scan.
    const { tier1, content } = await resolveIdentity(row, cache);
    if (row.rule === null) {
      counted.push({ relativePath: row.relativePath, rootName: row.rootName, extension: row.extension, tier1, content });
      continue;
    }
    excluded.push({ relativePath: row.relativePath, rootName: row.rootName, extension: row.extension, rule: row.rule, tier1, content });
  }
  await cache.flush();

  counted.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  excluded.sort((a, b) => a.rule.localeCompare(b.rule) || a.relativePath.localeCompare(b.relativePath));
  const { total, skippedByCap, droppedRoots } = draft.counts();
  const byRule: Record<string, number> = {};
  for (const rule of EXCLUDE_RULES) {
    const count = excluded.filter((row) => row.rule === rule).length;
    if (count > 0) byRule[rule] = count;
  }
  const ledger: FileLedger = {
    version: FILE_LEDGER_VERSION,
    scannerVersion,
    target,
    rowIdentity: { components: ["snapshot-identity", "target-relative-path"], contentDigestIsAttribute: true },
    // `Object.assign` rather than a spread so the intersection — and with it the brand — survives: a spread of
    // a branded record produces a plain object type, and the point of the brand is that it cannot be dropped.
    summary: Object.assign(summarizeCoverage({ total, counted: counted.length, excluded: excluded.length }), { byRule }),
    completeness: {
      maxFiles,
      capReached: skippedByCap > 0 || droppedRoots.length > 0,
      skippedByCap,
      droppedRoots,
      roots: draft.roots
    },
    counted,
    excluded,
    excludedGroups: groupExcluded(excluded),
    unexplained: [],
    sourceManifestDigest: tier1ManifestDigest(counted),
    contentManifestDigest: ""
  };
  ledger.contentManifestDigest = ledgerContentIdentity(ledger);
  return ledger;
}

/**
 * Both identity tiers of one row, from one read, and the ONLY place a `ContentIdentityRecord` is minted — which
 * is what keeps "counted rows carry `read-failed`, excluded rows carry `excluded`" a property of the code rather
 * than of whoever writes the next call site. The tier2 digest is requested only for counted rows.
 */
async function resolveIdentity(row: LedgerDraftRow, cache: ContentIdentityCache): Promise<{ tier1: Tier1Shape; content: ContentIdentityRecord }> {
  const excludedContent: ContentIdentityRecord = { status: "absent", reason: "excluded" };
  if (row.unsampled !== null) return { tier1: { status: "unsampled", reason: row.unsampled }, content: excludedContent };
  if (row.stat === null) return { tier1: { status: "unsampled", reason: "stat-failed" }, content: excludedContent };
  const { size, mtimeMs } = row.stat;
  // The cap already refused this candidate; reading 8 KiB of every file beyond a small cap would turn the cap
  // itself into the expensive path, which is the opposite of what a cap is for.
  if (row.rule === "cap-reached") return { tier1: { status: "stat-only", size, mtimeMs, reason: "cap-reached" }, content: excludedContent };
  // A sensitive file is stat-only BY POLICY. The rule exists because reading these bytes is the thing we refuse
  // to do, and an 8 KiB shape sample read exactly the leading bytes of a private key and published a
  // `maxLineLength` derived from them. Nothing about the row now comes from its content.
  if (row.rule === "sensitive-file") return { tier1: { status: "stat-only", size, mtimeMs, reason: "sensitive" }, content: excludedContent };
  try {
    const identity = await cache.resolve(row.absolutePath, row.stat, row.rule === null);
    // An excluded row never asked for a digest, so its absence is policy. A counted row did ask, so a null
    // digest is a failure to obtain the content — `read-failed`, not `excluded`. There is no third reading.
    const content: ContentIdentityRecord = row.rule !== null
      ? excludedContent
      : identity.digest !== null
        ? { status: "present", algorithm: "sha256", digest: identity.digest }
        : { status: "absent", reason: "read-failed" };
    return {
      tier1: { status: "sampled", size, mtimeMs, shape: identity.shape, sampledBytes: identity.sampledBytes, maxLineLength: identity.maxLineLength },
      content
    };
  } catch {
    // The file changed or became unreadable between `lstat` and the read. Stat succeeded, so this is stat-only
    // rather than unsampled — and a COUNTED row records `read-failed`, never `excluded`: the contract makes the
    // content digest a mandatory attribute of a counted row, so its absence is a finding at layer 8, not a
    // policy decision this layer took.
    return {
      tier1: { status: "stat-only", size, mtimeMs, reason: "read-failed" },
      content: row.rule === null ? { status: "absent", reason: "read-failed" } : excludedContent
    };
  }
}

function groupExcluded(excluded: ExcludedRow[]): LedgerGroupRow[] {
  const groups = new Map<string, { rule: ExcludeRule; extension: string; count: number; shapes: Set<string> }>();
  for (const row of excluded) {
    const key = `${row.rule}\0${row.extension}`;
    const group = groups.get(key) ?? { rule: row.rule, extension: row.extension, count: 0, shapes: new Set<string>() };
    group.count += 1;
    group.shapes.add(row.tier1.status === "sampled" ? row.tier1.shape : "unsampled");
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      rule: group.rule,
      extension: group.extension,
      count: group.count,
      shape: (group.shapes.size === 1 ? [...group.shapes][0] : "mixed") as LedgerGroupRow["shape"]
    }))
    .sort((a, b) => a.rule.localeCompare(b.rule) || a.extension.localeCompare(b.extension));
}

/** The tier1 whole-table digest, byte-for-byte the formula the snapshot used before tier2 existed. */
function tier1ManifestDigest(counted: CountedRow[]): string {
  const hash = createHash("sha256");
  for (const row of counted) {
    if (row.tier1.status !== "sampled") continue;
    hash.update(row.relativePath).update("\0").update(String(row.tier1.size)).update("\0").update(String(row.tier1.mtimeMs)).update("\n");
  }
  return hash.digest("hex");
}

/** The tier2 whole-table digest: what the snapshot identity anchors on, re-derivable from the rows alone. */
export function ledgerContentIdentity(ledger: FileLedger): string {
  const hash = createHash("sha256");
  for (const row of ledger.counted) {
    hash.update(row.relativePath).update("\0").update(row.content.status === "present" ? row.content.digest : "absent").update("\n");
  }
  return hash.digest("hex");
}

/**
 * This ledger's counted rows as a denominator.
 *
 * The denominator law names `files.json` as a legal RowSet source, and this is that door — the only one, so a
 * consumer downstream cannot assemble a `string[]` of paths and call it a denominator. The direction is the
 * point: the base declares the shape and the factory, layer 1 feeds it here, and the base never learns what a
 * `CountedRow` is. The ledger's content digest and completeness block travel with the rows, so a consumer
 * embeds what this denominator is accountable to instead of looking it up later (or not at all).
 */
export function countedRowSet(ledger: FileLedger): RowSet {
  return RowSet.fromLedgerCounted(ledger.counted, {
    artifact: "ledger/files.json",
    contentDigest: ledger.contentManifestDigest,
    producerVersion: ledger.scannerVersion,
    completeness: {
      capReached: ledger.completeness.capReached,
      skippedByCap: ledger.completeness.skippedByCap,
      droppedRoots: ledger.completeness.droppedRoots
    }
  });
}

/**
 * The ledger's canonical bytes: stable key order, stable row order, and no wall-clock field anywhere — two
 * scans of an unchanged tree must produce the same bytes, which is only checkable if nothing records "now".
 */
export function serializeLedgerArtifact(result: ArtifactResult<FileLedger>): string {
  return `${stableJson(result)}\n`;
}
