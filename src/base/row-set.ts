import type { CoverageDomain, MechanismUnitKind } from "./mechanism-registry.ts";

/**
 * A denominator, and the only shape a cross-interface denominator may have.
 *
 * The denominator law (`docs/layering.md` §四) says a ratio's denominator must be derived from a STRICTLY
 * LOWER ledger artifact that records its own completeness — `files.json`, `mechanisms.json`,
 * `units.json.partition`, a fact envelope — and never from `GraphSummary["roots"]`, a candidate pool, an
 * evidence directory or a bare `string[]`. A comment cannot enforce that, so the type does: the constructor is
 * PRIVATE and the only way to obtain a `RowSet` is a static factory that demands the ledger's identity and its
 * completeness block alongside the rows. There is no path through which a hand-assembled array becomes a
 * denominator, and no path through which one is built without carrying what it is accountable to.
 *
 * Three properties travel with every set, because every one of them has already been the failure:
 *
 *  - `unitKind` and `coverageDomain`, because conservation holds PER granularity and per domain. `crossrepo`
 *    accounts for module pairs and `search` for files; adding those two numbers produces a ratio with no
 *    referent, which is why the layer-2 and layer-8 contracts both forbid a cross-domain ratio by name.
 *  - `identity`, so a consumer embeds the ledger's content digest rather than re-deriving one. Two RowSets
 *    with the same size over two different corpora are not the same denominator.
 *  - `completeness`, so "the scan was capped" travels WITH the denominator instead of being looked up later.
 *    A determination of `not-detected` rests on it, and layer 8 re-checks that premise.
 *
 * DIRECTION. This file is in the base, so it may not import a layer-1 or layer-3 type: each factory takes the
 * minimal structural shape declared here and the owning layer feeds it (`countedRowSet` in
 * `snapshot/file-ledger.ts`, and the units artifact for `fromPartition`), which is a downward import and
 * therefore legal.
 */

/**
 * The unit kinds a RowSet can be counted in: layer 2's mechanism vocabulary, plus the partition cell.
 *
 * `partition-cell` is added HERE and deliberately not to `MechanismUnitKind`. Layer 2's union is serialised into
 * every `mechanisms.json` declaration and its registry digest is that ledger's identity, so widening it for a
 * layer-3 concept would move layer 2's artifact bytes for a reason layer 2 has nothing to do with. The two
 * vocabularies overlap; they are not the same vocabulary.
 */
export type RowSetUnitKind = MechanismUnitKind | "partition-cell";

/**
 * The minimum a ledger row must expose to be counted: a stable, unique identity string.
 *
 * Structural on purpose. Layer 1's `CountedRow` satisfies it with its `relativePath` — which is the row
 * identity layer 1 declares (snapshot identity + target-relative path), NOT its content digest: 226 of
 * provital's 3005 files are byte-identical to another path, so a content-hash identity collapses 83 groups of
 * the denominator while every conservation law still balances.
 */
export interface LedgerRow {
  readonly relativePath: string;
}

/**
 * The minimum a partition cell must expose to be counted: its id, its file, and its byte interval.
 *
 * Structural, like `LedgerRow`, so the base learns nothing about the layer-3 artifact. The span is here and not
 * merely in the id because this factory checks for overlap, and re-parsing an id string to get the interval back
 * would make the check depend on the id ENCODING — a second reader of a format that has exactly one owner.
 */
export interface PartitionCellRow {
  readonly unitId: string;
  readonly relativePath: string;
  readonly span: { readonly startByte: number; readonly endByte: number };
}

/** The completeness block a ledger publishes about its own scan; carried with the rows, never looked up later. */
export interface RowSetCompleteness {
  readonly capReached: boolean;
  readonly skippedByCap: number;
  readonly droppedRoots: readonly string[];
}

/** Which ledger artifact these rows came from, and what pins them to one corpus. */
export interface RowSetIdentity {
  /** The ledger artifact's run-relative path, e.g. `ledger/files.json`. */
  readonly artifact: string;
  /** The ledger's own whole-table content digest. */
  readonly contentDigest: string;
  /** The version of the producer that wrote the ledger. */
  readonly producerVersion: string;
  readonly completeness: RowSetCompleteness;
}

export class RowSet {
  readonly unitKind: RowSetUnitKind;
  readonly coverageDomain: CoverageDomain;
  readonly identity: RowSetIdentity;
  /** Sorted, deduplicated row identities. Canonical, so two derivations of one denominator are one value. */
  readonly rowIds: readonly string[];

  /**
   * Private, and that is the whole mechanism. `new RowSet(...)` is a compile error at every call site, so the
   * factories below are the only doors and every door demands a ledger identity.
   *
   * The fields are assigned in the body rather than declared as constructor parameter properties: this repo
   * runs TypeScript through Node's type STRIPPING, which erases annotations and cannot emit the assignments a
   * parameter property implies (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at import time, not at typecheck).
   */
  private constructor(unitKind: RowSetUnitKind, coverageDomain: CoverageDomain, identity: RowSetIdentity, rowIds: readonly string[]) {
    this.unitKind = unitKind;
    this.coverageDomain = coverageDomain;
    this.identity = identity;
    this.rowIds = rowIds;
  }

  /**
   * The layer-1 factory: the counted rows of `ledger/files.json`, in the file domain, counted as files.
   *
   * Named after its source rather than parameterised by domain, because "which ledger produced these rows"
   * decides the domain and the unit kind — letting a caller state them would let a caller state them wrongly.
   */
  static fromLedgerCounted(rows: readonly LedgerRow[], identity: RowSetIdentity): RowSet {
    requireIdentity(identity);
    const rowIds = rows.map((row) => row.relativePath);
    const unique = new Set(rowIds);
    if (unique.size !== rowIds.length) {
      // Layer 1's dedupe already reclassifies a repeated target-relative path as `duplicate-path`, so a
      // repeat here means the caller fed something other than the counted bucket.
      throw new Error(`A RowSet must be canonical: ${rowIds.length - unique.size} row identity(ies) appear more than once`);
    }
    return new RowSet("file", "file", canonicalIdentity(identity), [...unique].sort());
  }

  /**
   * The layer-3 factory: the cells of `units.json.partition`, in the file domain, counted as partition cells.
   *
   * Named after its source for the same reason as `fromLedgerCounted` — "which artifact produced these rows"
   * decides the domain and the unit kind, so a caller cannot state them wrongly. The domain is `file` because a
   * cell is a byte interval of one counted file: the partition is a refinement of the file corpus, not a second
   * corpus, which is what lets a per-file completeness block travel with it.
   *
   * The three checks here are the ones this factory can perform CHEAPLY on rows it did not build. The deep
   * invariant — that the cells of each file tile it exactly, with no gap — is enforced at construction by
   * `facts/units/partition-build.ts`, and copying the whole verifier here would create the second copy §一 warns
   * about. What is re-checked is what a bug in the caller could still get past: a duplicated id, and two cells of
   * one file that overlap.
   */
  static fromPartition(cells: readonly PartitionCellRow[], identity: RowSetIdentity): RowSet {
    requireIdentity(identity);
    const rowIds = cells.map((row) => row.unitId);
    const unique = new Set(rowIds);
    if (unique.size !== rowIds.length) {
      throw new Error(`A RowSet must be canonical: ${rowIds.length - unique.size} partition cell id(s) appear more than once`);
    }
    const byPath = new Map<string, PartitionCellRow[]>();
    for (const row of cells) {
      const bucket = byPath.get(row.relativePath);
      if (bucket) bucket.push(row);
      else byPath.set(row.relativePath, [row]);
    }
    for (const [relativePath, rows] of byPath) {
      const sorted = [...rows].sort((a, b) => a.span.startByte - b.span.startByte || a.span.endByte - b.span.endByte);
      for (let i = 1; i < sorted.length; i++) {
        const previous = sorted[i - 1]!.span;
        const current = sorted[i]!.span;
        // Half-open, so `[0,5)` and `[5,9)` are adjacent rather than overlapping.
        if (current.startByte < previous.endByte) {
          throw new Error(`A partition denominator may not double-count bytes: ${relativePath} has overlapping cells [${previous.startByte}, ${previous.endByte}) and [${current.startByte}, ${current.endByte})`);
        }
      }
    }
    return new RowSet("partition-cell", "file", canonicalIdentity(identity), [...unique].sort());
  }

  get size(): number {
    return this.rowIds.length;
  }

  has(rowId: string): boolean {
    return this.rowIds.includes(rowId);
  }
}

/** Read by every factory, so "a denominator states what it is accountable to" cannot hold in one door only. */
function requireIdentity(identity: RowSetIdentity): void {
  if (!identity.artifact.trim()) throw new Error("A RowSet requires the artifact its rows came from");
  if (!identity.contentDigest.trim()) throw new Error("A RowSet requires the ledger's content digest; a denominator with no corpus identity cannot be compared to anything");
  if (!identity.producerVersion.trim()) throw new Error("A RowSet requires the version of the producer that wrote the ledger");
}

/** Sorted and copied, so a denominator's completeness cannot change under it after the fact. */
function canonicalIdentity(identity: RowSetIdentity): RowSetIdentity {
  return { ...identity, completeness: { ...identity.completeness, droppedRoots: [...identity.completeness.droppedRoots].sort() } };
}
