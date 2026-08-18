/**
 * Deterministic MySQL DDL parser (`CREATE TABLE` dumps).
 *
 * Recovers tables, columns, keys, and foreign-key relationships from raw `CREATE TABLE` statements by
 * hand-written, quote-aware character scanning — no SQL engine, no npm deps, no model calls. This is
 * the source closest to the physical schema, so its column types are recorded verbatim in the "sql"
 * vocabulary (never cross-converted — see types.ts) and it doubles as the validation oracle for the
 * other, higher-level parsers.
 *
 * The SQL reading itself lives in `sql-ddl.ts`, shared with the raw-DDL path of the sequelize-migration
 * parser so one grammar serves both. What is left here is the file-level job: walk a dump for every
 * `CREATE TABLE`, and stamp this source's provenance onto the facts the grammar returns.
 *
 * What is read from a statement body, split at top-level commas:
 *   - column definitions   `` `col` <type> [NOT NULL|NULL] [DEFAULT x] [AUTO_INCREMENT] [COMMENT '…'] ``
 *   - `PRIMARY KEY (\`a\`,\`b\`)`               → the table primary key
 *   - `UNIQUE KEY name (\`cols\`)` / `UNIQUE (…)` → a unique constraint
 *   - `CONSTRAINT … FOREIGN KEY (…) REFERENCES t (…)` / bare `FOREIGN KEY` → a belongs-to relationship
 * Non-unique `KEY`/`INDEX`/`FULLTEXT`/`SPATIAL`, `CHECK`, and trailing `ENGINE=`/`CHARSET=` clauses are
 * ignored by design. The column type string keeps its display width and modifiers verbatim
 * (`bigint(20) unsigned`); nullability is left undefined unless the source states NULL / NOT NULL, and a
 * default is recorded only when `DEFAULT` is written — nothing is fabricated.
 */

import type {
  ColumnSchema, ParserResult, ReadFile, RelationshipSchema, SchemaParser, SchemaWarning, TableSchema
} from "../types.ts";
import { LineMap } from "./source-position.ts";
import { parseTableBody, readCreateTable } from "./sql-ddl.ts";
import type { CreateTableStmt } from "./sql-ddl.ts";

const SOURCE_ID = "sql-dump";

export const sqlDumpParser: SchemaParser = {
  format: "sql-dump",
  parse(files: string[], readFile: ReadFile): ParserResult {
    const tables: TableSchema[] = [];
    const relationships: RelationshipSchema[] = [];
    const warnings: SchemaWarning[] = [];

    for (const file of [...files].sort()) {
      const content = readFile(file);
      const lines = new LineMap(content);
      for (const stmt of extractCreateTables(content)) {
        parseStatement(stmt, file, lines, tables, relationships, warnings);
      }
    }
    return { tables, relationships, warnings };
  },
};

/** Every `CREATE TABLE` in a dump file, in source order. */
function extractCreateTables(content: string): CreateTableStmt[] {
  const out: CreateTableStmt[] = [];
  let from = 0;
  let stmt: CreateTableStmt | null;
  while ((stmt = readCreateTable(content, from)) !== null) {
    out.push(stmt);
    from = stmt.end;
  }
  return out;
}

function parseStatement(
  stmt: CreateTableStmt,
  file: string,
  lines: LineMap,
  tables: TableSchema[],
  relationships: RelationshipSchema[],
  warnings: SchemaWarning[],
): void {
  const body = parseTableBody(stmt.body, stmt.bodyOffset);

  const columns: ColumnSchema[] = body.columns.map((c) => ({
    ...c.column,
    provenance: [{ sourceId: SOURCE_ID, file, line: lines.lineAt(c.offset), symbol: c.name }],
  }));
  for (const c of columns) if (body.primaryKey.includes(c.name)) c.inPrimaryKey = true;

  for (const fk of body.foreignKeys) {
    relationships.push({
      kind: "belongs-to",
      fromTable: stmt.name,
      fromColumns: fk.fromColumns,
      toTable: fk.toTable,
      toColumns: fk.toColumns,
      provenance: [{ sourceId: SOURCE_ID, file, line: lines.lineAt(fk.offset) }],
    });
  }
  for (const item of body.unparsed) {
    warnings.push({ kind: "sql-unparsed-item", message: `could not parse table item: ${truncate(item.text)}`, evidence: [{ file, line: lines.lineAt(item.offset) }] });
  }

  tables.push({
    name: stmt.name,
    columns,
    primaryKey: body.primaryKey,
    uniqueKeys: body.uniqueKeys,
    declarations: [{ sourceId: SOURCE_ID, file, line: lines.lineAt(stmt.nameOffset), symbol: stmt.name }],
  });
}

function truncate(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
}
