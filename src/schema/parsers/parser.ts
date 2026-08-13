/**
 * The pluggable-parser contract for the schema extractor.
 *
 * Each source format is one `SchemaParser` in its own file. "Pluggable" means adding a format is a
 * new file plus a single line in the `PARSERS` registry below — there is NO dynamic plugin loading,
 * no filesystem scanning for parsers, nothing to configure at runtime. A parser is a pure function
 * of its inputs: given the files it owns and a `readFile`, it returns tables, relationships, and
 * warnings. It performs no I/O of its own (the caller injects `readFile`), makes no model calls, and
 * is deterministic — identical inputs yield byte-identical output.
 */

import type { RelationshipSchema, SchemaFormat, SchemaWarning, TableSchema } from "../types.ts";

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

import { gormParser } from "./gorm.ts";
import { sequelizeMigrationParser } from "./sequelize-migration.ts";
import { sequelizeModelParser } from "./sequelize-model.ts";
import { sqlDumpParser } from "./sql-dump.ts";

/**
 * Format → parser registry. Adding a format is one import plus one entry here.
 * Every recognized SchemaFormat now has a shipped parser; assembly into a full SchemaExtraction is `merge.ts`.
 */
export const PARSERS: Record<SchemaFormat, SchemaParser> = {
  gorm: gormParser,
  "sequelize-migration": sequelizeMigrationParser,
  "sequelize-model": sequelizeModelParser,
  "sql-dump": sqlDumpParser,
};
