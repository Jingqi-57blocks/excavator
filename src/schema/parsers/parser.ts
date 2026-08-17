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

import type { SchemaFormat, SchemaParser } from "../types.ts";

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
