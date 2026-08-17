/**
 * Framework-neutral data model for the deterministic DB-schema extractor.
 *
 * One shape describes schemas recovered from any source format (Go/gorm structs, Sequelize
 * migrations and models, raw SQL dumps). Recovery is text/structural only — zero model calls —
 * so every field here must be derivable from source verbatim.
 *
 * KEY INVARIANT — vocabularies do not mix.
 * A column's `type` is recorded together with the `typeVocabulary` it was written in: a Go field
 * type ("uint64", "*time.Time"), a Sequelize DataType, and an SQL type are NOT comparable and
 * must NEVER be converted into one another. Downstream code compares types only within a single
 * vocabulary. Likewise `nullable` left `undefined` means "the source never declared nullability"
 * (render it as "—"); it is never coerced to a boolean, and a `default` is never fabricated when
 * the source did not state one. The extractor reports what the source says, nothing more.
 */

/**
 * The pluggable-parser contract. It sits here, beside the schema shapes it is written in terms of, rather
 * than in `parsers/parser.ts` next to the registry: the registry imports every parser, and every parser needs
 * this contract, so declaring it there made the registry and its parsers one cyclic unit — a cycle whose
 * reverse edges are all `import type` and therefore invisible to the eye.
 */
/** What a parser produces from the files it owns. Assembly into a full `SchemaExtraction` is the caller's job. */
export interface ParserResult {
  tables: TableSchema[];
  relationships: RelationshipSchema[];
  warnings: SchemaWarning[];
}

/** Reads a file's UTF-8 contents by path. Injected so parsers stay pure and testable with in-memory fixtures. */
export type ReadFile = (path: string) => string;

/** One source format's parser. */
export interface SchemaParser {
  format: SchemaFormat;
  parse(files: string[], readFile: ReadFile): ParserResult;
}

export type SchemaFormat = "gorm" | "sequelize-migration" | "sequelize-model" | "sql-dump";

export type TypeVocabulary = "sql" | "sequelize" | "go";

export type RelationshipKind = "belongs-to" | "has-one" | "has-many" | "many-to-many";

/** A precise pointer back into source: which source, which file, which line, and (when known) the symbol. */
export interface Declaration {
  sourceId: string;
  file: string;
  line: number;
  symbol?: string;
}

/** A file/line reference used as evidence for warnings and unsupported-format notices. */
export interface FileRef {
  file: string;
  line?: number;
}

/** One logical origin of schema facts: a parser format plus the concrete files it consumed. */
export interface SchemaSource {
  id: string;
  format: SchemaFormat;
  files: string[];
}

/** A single column and everything the source declared about it (and no more). */
export interface ColumnSchema {
  name: string;
  /** The type string exactly as written, in the vocabulary named by `typeVocabulary` — never cross-converted. */
  type: string;
  typeVocabulary: TypeVocabulary;
  /** `false` when the source declared NOT NULL / `not null`; `undefined` when nullability was never declared. */
  nullable?: boolean;
  default?: string;
  autoIncrement?: boolean;
  inPrimaryKey?: boolean;
  /**
   * `true` when the column NAME was not written in source but derived by the source format's documented
   * default naming strategy (e.g. gorm snake_case of an untagged field). Left unset when the name is
   * literal in source. Keeps a derived name transparent instead of silently asserting it.
   */
  nameDerived?: boolean;
  provenance: Declaration[];
}

/** A named or anonymous unique constraint over one or more columns. */
export interface UniqueKey {
  name?: string;
  columns: string[];
}

/** A table and its columns, keys, and back-pointers to the declarations that produced it. */
export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  primaryKey: string[];
  uniqueKeys: UniqueKey[];
  declarations: Declaration[];
  description?: string;
}

/** A relationship between tables, recorded in the columns/vocabulary of its source. */
export interface RelationshipSchema {
  kind: RelationshipKind;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  joinTable?: string;
  provenance: Declaration[];
}

/** A source in a recognized family whose specific dialect/shape this extractor cannot yet parse. */
export interface UnsupportedFormat {
  format: string;
  evidence: FileRef[];
  reason: string;
}

/** A non-fatal issue: something skipped, unresolved, or malformed — always with a machine-readable `kind`. */
export interface SchemaWarning {
  kind: string;
  message: string;
  evidence?: FileRef[];
}

/** The complete framework-neutral result of a schema extraction over one target. */
/** The detected database engine/dialect, weighed from dialect/driver signals (see engine.ts). */
export interface DetectedEngine {
  name: string;
  confidence: "high" | "medium" | "low";
  evidence: FileRef[];
  alternatives: string[];
}

export interface SchemaExtraction {
  target: string;
  gitHead?: string;
  engine?: DetectedEngine;
  sources: SchemaSource[];
  tables: TableSchema[];
  relationships: RelationshipSchema[];
  unsupported: UnsupportedFormat[];
  warnings: SchemaWarning[];
}
