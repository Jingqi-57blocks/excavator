import { notApplicable, unavailable, type NotApplicable, type Unavailable } from "../base/artifact-result.ts";
import {
  coverageBasisDigest, fileCompletenessValue, FILE_COMPLETENESS_BASIS, mechanismCoverageBasisName
} from "../base/coverage-basis.ts";
import { sha256, stableJson } from "../base/util.ts";
import type { FactDetail, ObservedFact } from "../facts/units/membership-map.ts";
import type { DetectedEngine, SchemaExtraction, TableSchema } from "./types.ts";

/**
 * The schema extractor as a layer-3 fact producer: one fact kind, one determination tree.
 *
 * WHAT THE PRODUCER PUBLISHES. One `db-table` fact per physical table `mergeSchemas` recovered, anchored at that
 * table's highest-authority declaration. Not columns (a table's columns are the table's own detail, and 2,000
 * column topics would drown the 197 table topics they belong to) and not relationships — v1 publishes tables
 * only, and the relationship count it did NOT publish is a named row in `producerCompleteness` rather than a
 * silence.
 *
 * THE DISTINCTION THIS FILE EXISTS FOR: "no table was found" and "this target declares no table" are two
 * different statements, and only the second one is a determination. So every path out of the producer is a
 * written state with a reason:
 *
 *   - a parseable source yielded tables                      → `Built`
 *   - a parseable source yielded NO table                    → `Unavailable`, naming the formats and file counts
 *   - a schema family with no parser was located (Prisma, …) → `Unavailable`, naming the families
 *   - no source, and the premises hold                       → `NotApplicable{not-detected}`
 *   - no source, and a premise does not hold                 → `Unavailable`, naming the premise
 *
 * THE PREMISES ARE THE ONES LAYER 8 RE-CHECKS, deliberately and not approximately. `docs/layering.md` §输出法则
 * says not-detected does not hold when the scan was capped, a read failed, or the mechanism covered only part of
 * the corpus, and `src/freeze/completeness.ts` (`validateNotApplicable`) enforces exactly that. A producer that
 * applied a laxer rule would publish determinations its own freeze gate rejects, so the rule is applied HERE,
 * against the same two records the auditor re-resolves. On a mixed-language target this makes `not-detected`
 * rare — a single `.md` row is outside the db-schema mechanism's declared extensions — and that is the honest
 * outcome: nobody read that file, so nobody may say what is not in it.
 */

export const SCHEMA_FACTS_VERSION = "schema-facts-v1";

/** One discovered format, and how many of its files survived the run's own counted-file census. */
export interface SchemaSourceCensus {
  readonly format: string;
  readonly discovered: number;
  readonly parsed: number;
}

/**
 * One schema family that was located but has no parser in this engine.
 *
 * `evidence` is the number of evidence rows the fingerprinter kept, and the fingerprinter caps that at 20 per
 * format — so it is a LOWER BOUND on the located files, and every sentence built from it says "at least". A cap
 * read as a total is how a bounded count starts vouching for an unbounded one.
 */
export interface SchemaUnsupportedCensus {
  readonly format: string;
  readonly evidence: number;
}

export interface SchemaObservations {
  readonly facts: readonly ObservedFact[];
  /**
   * Tables the extraction holds with no declaration at all, so there is no source line to anchor them at. They
   * are named rather than dropped: a table that vanishes takes the reason it vanished with it.
   */
  readonly tablesWithoutDeclaration: readonly string[];
  /**
   * Declaration sites a table has BEYOND the one its fact is anchored at — the second half of a table declared
   * both as a migration and as an ORM model, commonly in another repository. The registered membership arm takes
   * one anchor cell, so those sites hold no seat; the count makes that reach visible instead of assumed.
   */
  readonly declarationsBeyondAnchor: number;
}

/**
 * One observation per recovered table, in the extraction's own (name-sorted) order.
 *
 * The anchor is `declarations[0]`, which `mergeSchemas` defines as the declaration closest to physical DDL
 * (sql-dump > sequelize-migration > sequelize-model > gorm, then first-seen). That is a choice with a reason: a
 * migration states the physical table, a model restates it, and filing the fact at the physical statement keeps
 * the anchor stable when a model is added or moved.
 */
export function schemaObservations(extraction: SchemaExtraction): SchemaObservations {
  const facts: ObservedFact[] = [];
  const tablesWithoutDeclaration: string[] = [];
  const seen = new Set<string>();
  let declarationsBeyondAnchor = 0;

  for (const table of extraction.tables) {
    if (seen.has(table.name)) {
      throw new Error(`The extraction holds table ${JSON.stringify(table.name)} twice; a merged schema groups tables by physical name, so two rows for one name would publish two facts under one id`);
    }
    seen.add(table.name);
    const anchor = table.declarations[0];
    if (anchor === undefined) {
      tablesWithoutDeclaration.push(table.name);
      continue;
    }
    declarationsBeyondAnchor += table.declarations.length - 1;
    facts.push({
      factId: `table:${table.name}`,
      kind: "db-table",
      // No unit kind is claimed. A `createTable(` call and a Go struct are not the same unit shape, and the unit
      // at the declaring line is whatever the file's own builder found there.
      anchors: [{ relativePath: anchor.file, startLine: anchor.line, endLine: null, unitKind: null }],
      detail: {
        name: table.name,
        columns: table.columns.length,
        primaryKey: table.primaryKey.length ? table.primaryKey.join(", ") : null,
        uniqueKeys: table.uniqueKeys.length,
        declarations: table.declarations.length,
        declarationFiles: distinctFiles(table),
        anchorSource: anchor.sourceId,
        anchorFile: anchor.file,
        anchorLine: anchor.line,
        anchorSymbol: anchor.symbol ?? null
      } satisfies FactDetail
    });
  }

  return { facts, tablesWithoutDeclaration: tablesWithoutDeclaration.sort(), declarationsBeyondAnchor };
}

function distinctFiles(table: TableSchema): number {
  return new Set(table.declarations.map((declaration) => declaration.file)).size;
}

export interface SchemaSourceDeterminationInput {
  /** Whether the layer-2 ledger records the `db-schema` mechanism as available this run. */
  readonly mechanismAvailable: boolean;
  /** The ledger's own cause when it is not available; `null` when it is. */
  readonly mechanismUnavailableCause: string | null;
  /** The formats with a parser, after the run's counted-file census narrowed their file sets. */
  readonly sources: readonly SchemaSourceCensus[];
  /** The families located with no parser in this engine. */
  readonly unsupported: readonly SchemaUnsupportedCensus[];
  /** Layer 1's scan completeness. A capped or partly unread scan cannot support "there is nothing here". */
  readonly ledgerCompleteness: {
    readonly capReached: boolean;
    readonly skippedByCap: number;
    readonly droppedRoots: readonly string[];
    readonly readFailures: number;
  };
  /** The `db-schema` row of layer 2's file matrix, or `null` when the ledger publishes none. */
  readonly matrixTotals: {
    readonly covered: number;
    readonly noMechanism: number;
    readonly mechanismUnavailable: number;
  } | null;
  /** The normalized layer-2 record for the `db-schema` mechanism, digested into the determination's premise. */
  readonly mechanismCoverage: unknown;
}

/**
 * Whether this run may publish schema facts, and if not, WHICH kind of not. `null` ⇒ proceed to parse.
 *
 * Order matters and each step is a different statement about the world: a mechanism that could not run is a blind
 * spot; a located-but-unparseable family is a KNOWN schema this engine cannot read (never "no schema"); and only
 * after both of those are excluded does the absence of any source become a candidate determination.
 */
export function schemaSourceDetermination(input: SchemaSourceDeterminationInput): NotApplicable | Unavailable | null {
  if (!input.mechanismAvailable) {
    return unavailable(`the db-schema mechanism is unavailable this run (${input.mechanismUnavailableCause ?? "no cause recorded"}), so no source file could be fingerprinted`, true);
  }
  if (input.unsupported.length > 0) {
    // Located, recognised by family, unparseable. Calling this "not detected" would turn a schema this engine
    // cannot read into a target that has none — the exact confusion this producer exists to keep apart.
    const located = input.unsupported.map((entry) => ({ label: entry.format, count: entry.evidence }));
    return unavailable(`schema sources were located in ${input.unsupported.length} format(s) this extractor has no parser for (at least ${census(located)} file(s)), so the target's tables are known to exist and cannot be recovered`, false);
  }
  if (input.sources.some((source) => source.parsed > 0)) return null;
  if (input.sources.length > 0) {
    // Fingerprinted, then filtered away: every file carrying a schema signature is outside this run's counted
    // census. Publishing facts about them would put anchors into an envelope whose identity names a snapshot
    // that does not contain them, and publishing none without saying so would read as "there is no schema".
    const dropped = input.sources.map((source) => ({ label: source.format, count: source.discovered }));
    return unavailable(`schema sources were fingerprinted (${census(dropped)} file(s)) but none of their files is a counted row of this run's snapshot, so their tables cannot be anchored`, false);
  }

  const { capReached, skippedByCap, droppedRoots, readFailures } = input.ledgerCompleteness;
  if (capReached || skippedByCap > 0 || droppedRoots.length > 0 || readFailures > 0) {
    return unavailable(`no schema source was fingerprinted, but layer 1's scan was incomplete (capReached ${capReached}, skippedByCap ${skippedByCap}, droppedRoots ${droppedRoots.length}, readFailures ${readFailures}), so a table may be declared in the part that was never examined`, true);
  }
  if (input.matrixTotals === null) {
    return unavailable("no schema source was fingerprinted, but layer 2 publishes no file-coverage matrix for the db-schema mechanism, so there is no record of which files it was able to read", true);
  }
  if (input.matrixTotals.noMechanism > 0 || input.matrixTotals.mechanismUnavailable > 0) {
    return unavailable(`no schema source was fingerprinted, but the db-schema mechanism covered only ${input.matrixTotals.covered} of ${input.matrixTotals.covered + input.matrixTotals.noMechanism + input.matrixTotals.mechanismUnavailable} counted file(s) (${input.matrixTotals.noMechanism} outside its declared extensions, ${input.matrixTotals.mechanismUnavailable} unavailable at runtime), so "this target declares no table" cannot be determined`, false);
  }
  return notApplicable(
    "not-detected",
    [FILE_COMPLETENESS_BASIS, mechanismCoverageBasisName("db-schema")],
    coverageBasisDigest([
      { reference: FILE_COMPLETENESS_BASIS, value: fileCompletenessValue(input.ledgerCompleteness) },
      { reference: mechanismCoverageBasisName("db-schema"), value: input.mechanismCoverage }
    ])
  );
}

/**
 * The cause for a parse that read real sources and recovered no table.
 *
 * This is the silent-empty the slice was written against: a `Built` envelope with zero facts reads downstream as
 * "the ledger is there and holds no row for this facet", which is indistinguishable from a target with no data
 * model. A parser that read 293 migrations and produced nothing is a parser failure, and it says so.
 */
export function schemaEmptyYieldCause(sources: readonly SchemaSourceCensus[], warnings: number): string {
  return `${sources.reduce((total, source) => total + source.parsed, 0)} schema source file(s) were parsed (${census(sources.map((source) => ({ label: source.format, count: source.parsed })))}) and yielded no table, with ${warnings} parser warning(s); the sources exist, so their tables are unrecovered rather than absent`;
}

/** The producer's configuration and mode, digested into its envelope identity. */
export function schemaConfigDigest(input: {
  readonly sources: readonly SchemaSourceCensus[];
  readonly engine: DetectedEngine | undefined;
  readonly extensions: readonly string[];
}): string {
  return sha256(stableJson({
    factsVersion: SCHEMA_FACTS_VERSION,
    sources: [...input.sources].sort((a, b) => a.format.localeCompare(b.format)),
    // The detected engine is an input to what the parsers make of a type string, so it belongs in the identity.
    engine: input.engine ? { name: input.engine.name, confidence: input.engine.confidence } : null,
    extensions: [...input.extensions].sort()
  }));
}

/** The producer's own completeness record: what it read, what it published, and what it did not. Scalars only. */
export function schemaCompleteness(input: {
  readonly extraction: SchemaExtraction;
  readonly observations: SchemaObservations;
  readonly sources: readonly SchemaSourceCensus[];
  readonly unsupported: readonly SchemaUnsupportedCensus[];
  readonly filesOutsideLedger: number;
}): FactDetail {
  const { extraction, observations, sources } = input;
  return {
    formats: sources.map((source) => source.format).sort().join(", "),
    filesDiscovered: sources.reduce((total, source) => total + source.discovered, 0),
    filesParsed: sources.reduce((total, source) => total + source.parsed, 0),
    // Files the fingerprinter saw that this run's layer-1 census did not count. Parsing them would put facts
    // about files outside the snapshot into a snapshot-identified envelope.
    filesOutsideLedger: input.filesOutsideLedger,
    tables: extraction.tables.length,
    tablesWithoutDeclaration: observations.tablesWithoutDeclaration.length,
    tableDeclarationsBeyondAnchor: observations.declarationsBeyondAnchor,
    // v1 publishes tables only. The relationships were recovered and are NOT facts; the count says so rather
    // than leaving "the schema producer sees no foreign key" to be inferred.
    relationshipsNotPublishedAsFacts: extraction.relationships.length,
    unsupportedFormats: input.unsupported.map((entry) => entry.format).sort().join(", "),
    // Evidence rows, not files: the fingerprinter caps evidence at 20 per format, so this is a lower bound and
    // the key says which quantity it is.
    unsupportedEvidenceRows: input.unsupported.reduce((total, entry) => total + entry.evidence, 0),
    warnings: extraction.warnings.length,
    engine: extraction.engine?.name ?? null,
    engineConfidence: extraction.engine?.confidence ?? null
  };
}

/** `format count, format count` in one stable order, so two runs over one target spell a cause identically. */
function census(entries: readonly { readonly label: string; readonly count: number }[]): string {
  return [...entries]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((entry) => `${entry.label} ${entry.count}`)
    .join(", ");
}
