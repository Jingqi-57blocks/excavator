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
 * DIRECTION. This file is in the base, so it may not import a layer-1 type: `fromLedgerCounted` takes the
 * minimal structural shape declared here and layer 1 feeds it (`countedRowSet` in `snapshot/file-ledger.ts`),
 * which is a downward import and therefore legal. `fromPartition`, the layer-3 factory, lands with the units
 * slice; adding it now would mean guessing the partition row shape before the artifact exists.
 */

/** The unit kinds a RowSet can be counted in — the same vocabulary layer 2 declares its mechanisms with. */
export type RowSetUnitKind = MechanismUnitKind;

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
    if (!identity.artifact.trim()) throw new Error("A RowSet requires the artifact its rows came from");
    if (!identity.contentDigest.trim()) throw new Error("A RowSet requires the ledger's content digest; a denominator with no corpus identity cannot be compared to anything");
    if (!identity.producerVersion.trim()) throw new Error("A RowSet requires the version of the producer that wrote the ledger");
    const rowIds = rows.map((row) => row.relativePath);
    const unique = new Set(rowIds);
    if (unique.size !== rowIds.length) {
      // Layer 1's dedupe already reclassifies a repeated target-relative path as `duplicate-path`, so a
      // repeat here means the caller fed something other than the counted bucket.
      throw new Error(`A RowSet must be canonical: ${rowIds.length - unique.size} row identity(ies) appear more than once`);
    }
    return new RowSet("file", "file", { ...identity, completeness: { ...identity.completeness, droppedRoots: [...identity.completeness.droppedRoots].sort() } }, [...unique].sort());
  }

  get size(): number {
    return this.rowIds.length;
  }

  has(rowId: string): boolean {
    return this.rowIds.includes(rowId);
  }
}
