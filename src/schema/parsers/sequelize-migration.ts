/**
 * Deterministic Sequelize migration parser — replays the schema forward, never runs it.
 *
 * Given a set of migration files, this reads ONLY each file's `up` section and applies its operations
 * in filename order (Sequelize migration filenames are timestamp-prefixed, so lexical sort = execution
 * order). The `down` section is deliberately never parsed: it is the inverse (it is full of dropTable /
 * dropColumn), and replaying it would destroy the very state we are recovering. Cutting `down` is done
 * by extracting the `up` function body alone and scanning only inside it.
 *
 * Comments are masked out of the source BEFORE anything is scanned (see js-comment-mask.ts): Sequelize's
 * generated migration skeleton carries a commented-out `createTable('users', …)` example, and a text
 * scanner that cannot tell code from commentary reports it as a real table.
 *
 * Two op families are understood:
 *   - Structured `queryInterface` calls: createTable, addColumn, removeColumn, changeColumn, addIndex,
 *     dropTable. Column types recorded verbatim in the "sequelize" vocabulary.
 *   - A NARROW raw-SQL whitelist inside `queryInterface.sequelize.query(...)`: `CREATE TABLE [IF NOT
 *     EXISTS]`, `DROP TABLE`, `ALTER TABLE … ADD [COLUMN] / DROP [COLUMN] / MODIFY [COLUMN] / CHANGE
 *     [COLUMN]`, and table renames (`ALTER TABLE x RENAME TO y`, `RENAME TABLE x TO y`). The SQL itself is
 *     read by the shared grammar in sql-ddl.ts — the same reader the sql-dump parser uses, so a table
 *     declared in raw DDL comes out identical whichever file it was written in — and raw column types are
 *     recorded in the "sql" vocabulary. Any raw statement OUTSIDE the whitelist (UPDATE/INSERT/SET/CREATE
 *     INDEX/…) is recorded as an "unapplied raw statement" warning — never guessed at.
 *
 * A table may be built by both families at once (created in raw DDL, then extended by `addColumn`); both
 * paths write into one `TableState` per table name, so the replay result is the union, in replay order.
 *
 * Everything the extractor emits is a fact stated in source; nothing about the physical schema is
 * fabricated. Pure and deterministic: files read in sorted order through the injected `readFile`.
 */

import type {
  ColumnSchema, Declaration, ParserResult, ReadFile, RelationshipSchema, SchemaParser, SchemaWarning,
  TableSchema, UniqueKey
} from "../types.ts";
import { LineMap } from "./source-position.ts";
import { findCalls, findFunctionBody, joinedStringLiteral, parseObjectLiteral, splitArgs } from "./js-scan.ts";
import { maskJsComments } from "./js-comment-mask.ts";
import { parseSequelizeField } from "./sequelize-field.ts";
import { isCreateTable, parseSqlColumnDef, parseTableBody, readCreateTable, splitSqlStatements, splitTopLevelSql } from "./sql-ddl.ts";

const SOURCE_ID = "sequelize-migration";

/** Migration state reuses the public ColumnSchema shape directly (no vocabulary lost in translation). */
type ColState = ColumnSchema;

interface TableState {
  name: string;
  columns: Map<string, ColState>;
  order: string[];
  uniqueKeys: UniqueKey[];
  declarations: Declaration[];
}

/** The replay being accumulated: table state plus the two output channels every op may write to. */
interface Replay {
  state: Map<string, TableState>;
  relationships: RelationshipSchema[];
  warnings: SchemaWarning[];
}

/**
 * The queryInterface calls this parser applies structurally (anything else in `up` is warned about).
 * Receiver-agnostic (`.createTable(` / `.sequelize.query(`): the object is `up`'s first parameter,
 * conventionally `queryInterface` but sometimes abbreviated — the distinctive method name is what matters.
 */
const CALL_RE =
  /\.\s*(sequelize\s*\.\s*query|createTable|addColumn|removeColumn|changeColumn|addIndex|dropTable)\s*\(/g;

export const sequelizeMigrationParser: SchemaParser = {
  format: "sequelize-migration",
  parse(files: string[], readFile: ReadFile): ParserResult {
    const replay: Replay = { state: new Map(), relationships: [], warnings: [] };

    for (const file of [...files].sort()) {
      const content = readFile(file);
      // Mask comments, never strip them: the masked text has the same length, so offsets taken from it
      // still resolve against a LineMap built on the real content.
      const scannable = maskJsComments(content);
      const up = findFunctionBody(scannable, "up");
      if (!up) {
        replay.warnings.push({ kind: "migration-no-up", message: `no up() section found`, evidence: [{ file }] });
        continue;
      }
      const lines = new LineMap(content);
      for (const call of findCalls(up.body, CALL_RE, up.bodyOffset)) {
        applyCall(call, file, lines, replay);
      }
    }

    const tables: TableSchema[] = [...replay.state.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(toTableSchema);
    return { tables, relationships: replay.relationships, warnings: replay.warnings };
  },
};

function applyCall(
  call: ReturnType<typeof findCalls>[number],
  file: string,
  lines: LineMap,
  replay: Replay,
): void {
  const state = replay.state;
  const warnings = replay.warnings;
  const method = (call.groups[0] ?? "").replace(/\s+/g, "");
  const args = splitArgs(call.argsText, call.argsOffset);
  const callLine = lines.lineAt(call.matchOffset);

  if (method === "sequelize.query") {
    const sql = args.length ? joinedStringLiteral(args[0].text) : null;
    if (sql !== null) applyRawSql(sql, file, callLine, replay);
    return;
  }
  if (method === "createTable") {
    const name = args.length ? joinedStringLiteral(args[0].text) : null;
    if (name === null || args.length < 2) return;
    const table = ensureTable(state, name.trim(), { sourceId: SOURCE_ID, file, line: callLine, symbol: name.trim() });
    for (const entry of parseObjectLiteral(args[1].text, args[1].offset)) {
      const col = parseSequelizeField(entry.key, entry.valueText, entry.valueOffset, SOURCE_ID, file, lines.lineAt(entry.keyOffset), warnings);
      setColumn(table, col);
    }
    return;
  }
  if (method === "addColumn" || method === "changeColumn") {
    if (args.length < 3) return;
    const tableName = joinedStringLiteral(args[0].text);
    const colName = joinedStringLiteral(args[1].text);
    if (tableName === null || colName === null) return;
    const table = ensureTable(state, tableName.trim(), { sourceId: SOURCE_ID, file, line: callLine, symbol: tableName.trim() }, warnings, method);
    const line = lines.lineAt(args[1].offset);
    const col = parseSequelizeField(colName.trim(), args[2].text, args[2].offset, SOURCE_ID, file, line, warnings);
    if (method === "changeColumn") mergeColumn(table, col);
    else setColumn(table, col);
    return;
  }
  if (method === "removeColumn") {
    if (args.length < 2) return;
    const tableName = joinedStringLiteral(args[0].text);
    const colName = joinedStringLiteral(args[1].text);
    if (tableName === null || colName === null) return;
    const table = state.get(tableName.trim());
    if (table) removeColumn(table, colName.trim());
    return;
  }
  if (method === "addIndex") {
    if (args.length < 2) return;
    const tableName = joinedStringLiteral(args[0].text);
    if (tableName === null) return;
    const table = state.get(tableName.trim());
    if (!table) return;
    const key = parseAddIndex(call.argsText, args);
    if (key) table.uniqueKeys.push(key);
    return;
  }
  if (method === "dropTable") {
    const name = args.length ? joinedStringLiteral(args[0].text) : null;
    if (name !== null) dropTableIn(replay, name.trim());
    return;
  }
}

/** Parse `addIndex(table, fields, opts)` — returns a UniqueKey only when the index is declared unique. */
function parseAddIndex(argsText: string, args: ReturnType<typeof splitArgs>): UniqueKey | null {
  const isUnique = /\bunique\s*:\s*true\b/.test(argsText);
  if (!isUnique) return null;
  // Column list is either a bare array arg or a `fields: [...]` option.
  let columns = extractStringArray(args[1].text);
  if (columns.length === 0) {
    const fm = /\bfields\s*:\s*(\[[^\]]*\])/.exec(argsText);
    if (fm) columns = extractStringArray(fm[1]);
  }
  const nm = /\bname\s*:\s*(['"`])((?:[^'"`\\]|\\.)*)\1/.exec(argsText);
  const key: UniqueKey = { columns };
  if (nm) key.name = nm[2];
  return key;
}

function extractStringArray(text: string): string[] {
  const out: string[] = [];
  const re = /(['"`])((?:[^'"`\\]|\\.)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[2]);
  return out;
}

// --- Raw SQL whitelist -----------------------------------------------------------------------------

function applyRawSql(sql: string, file: string, line: number, replay: Replay): void {
  for (const stmt of splitSqlStatements(sql)) {
    if (!applyRawStatement(stmt, file, line, replay)) {
      replay.warnings.push({ kind: "unapplied-raw-statement", message: `raw statement not in DDL whitelist: ${truncate(stmt)}`, evidence: [{ file, line }] });
    }
  }
}

/** Apply one raw statement if it is in the whitelist; return false to signal "unapplied" (caller warns). */
function applyRawStatement(stmt: string, file: string, line: number, replay: Replay): boolean {
  if (isCreateTable(stmt)) {
    const create = readCreateTable(stmt, 0);
    if (!create) return false; // `CREATE TABLE … AS SELECT` and other bodiless forms: not understood, so warned about
    applyCreateTable(create.name, create.body, file, line, replay);
    return true;
  }
  const dropTable = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+)$/i.exec(stmt);
  if (dropTable) {
    for (const name of tableList(dropTable[1])) dropTableIn(replay, name);
    return true;
  }
  const alter = /^ALTER\s+TABLE\s+(`(?:[^`]|``)*`|[A-Za-z_][\w$]*)\s+([\s\S]+)$/i.exec(stmt);
  if (alter) {
    const tableName = unquote(alter[1]);
    for (const clause of splitTopLevelSql(alter[2])) applyAlterClause(clause.text.trim(), tableName, file, line, replay);
    return true;
  }
  const renameTable = /^RENAME\s+TABLE\s+(`(?:[^`]|``)*`|[A-Za-z_][\w$]*)\s+TO\s+(`(?:[^`]|``)*`|[A-Za-z_][\w$]*)/i.exec(stmt);
  if (renameTable) {
    renameTableIn(replay, unquote(renameTable[1]), unquote(renameTable[2]), file, line);
    return true;
  }
  return false;
}

/**
 * Apply a raw `CREATE TABLE` body onto the replayed state, through the same grammar the sql-dump parser
 * uses. Columns land in the "sql" vocabulary; the whole statement shares the `sequelize.query(...)` call's
 * line, because string concatenation has already erased any finer position. Items the grammar cannot read
 * become warnings rather than silence.
 */
function applyCreateTable(name: string, body: string, file: string, line: number, replay: Replay): void {
  const parsed = parseTableBody(body);
  const table = ensureTable(replay.state, name, { sourceId: SOURCE_ID, file, line, symbol: name });

  for (const c of parsed.columns) setColumn(table, sqlToColState(c, file, line));
  for (const columnName of parsed.primaryKey) {
    const col = table.columns.get(columnName);
    if (col) col.inPrimaryKey = true;
  }
  table.uniqueKeys.push(...parsed.uniqueKeys);
  for (const fk of parsed.foreignKeys) {
    replay.relationships.push({
      kind: "belongs-to",
      fromTable: name,
      fromColumns: fk.fromColumns,
      toTable: fk.toTable,
      toColumns: fk.toColumns,
      provenance: [{ sourceId: SOURCE_ID, file, line }],
    });
  }
  for (const item of parsed.unparsed) {
    replay.warnings.push({ kind: "sql-unparsed-item", message: `could not parse table item: ${truncate(item.text)}`, evidence: [{ file, line }] });
  }
}

function applyAlterClause(clause: string, tableName: string, file: string, line: number, replay: Replay): void {
  const state = replay.state;
  const rename = /^RENAME\s+(?:TO|AS)\s+(`(?:[^`]|``)*`|[A-Za-z_][\w$]*)/i.exec(clause);
  if (rename) {
    renameTableIn(replay, tableName, unquote(rename[1]), file, line);
    return;
  }
  const drop = /^DROP\s+(?:COLUMN\s+)?(`(?:[^`]|``)*`|[A-Za-z_][\w$]*)\s*$/i.exec(clause);
  if (drop) {
    const table = state.get(tableName);
    if (table) removeColumn(table, unquote(drop[1]));
    return;
  }
  const change = /^CHANGE\s+(?:COLUMN\s+)?(`(?:[^`]|``)*`|[A-Za-z_][\w$]*)\s+([\s\S]+)$/i.exec(clause);
  if (change) {
    const oldName = unquote(change[1]);
    const parsed = parseSqlColumnDef(change[2]);
    if (parsed) {
      const table = ensureTable(state, tableName, { sourceId: SOURCE_ID, file, line, symbol: tableName });
      renameAndSet(table, oldName, parsed.name, parsed.column, file, line);
    }
    return;
  }
  const modify = /^MODIFY\s+(?:COLUMN\s+)?([\s\S]+)$/i.exec(clause);
  if (modify) {
    const parsed = parseSqlColumnDef(modify[1]);
    if (parsed) {
      const table = ensureTable(state, tableName, { sourceId: SOURCE_ID, file, line, symbol: tableName });
      mergeColumn(table, sqlToColState(parsed, file, line));
    }
    return;
  }
  const add = /^ADD\s+(?:COLUMN\s+)?([\s\S]+)$/i.exec(clause);
  if (add) {
    // Skip ADD of an index/key/constraint — only ADD [COLUMN] <coldef> carries a column fact.
    if (/^(INDEX|KEY|CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|FULLTEXT|SPATIAL)\b/i.test(add[1].trim())) return;
    const parsed = parseSqlColumnDef(add[1]);
    if (parsed) {
      const table = ensureTable(state, tableName, { sourceId: SOURCE_ID, file, line, symbol: tableName });
      setColumn(table, sqlToColState(parsed, file, line));
    }
    return;
  }
  // Other clauses (e.g. ALTER COLUMN … SET DEFAULT, DROP INDEX) carry no column facts — ignored silently.
}

function sqlToColState(parsed: NonNullable<ReturnType<typeof parseSqlColumnDef>>, file: string, line: number): ColState {
  const c = parsed.column;
  const col: ColState = { name: c.name, type: c.type, typeVocabulary: "sql", provenance: [{ sourceId: SOURCE_ID, file, line, symbol: c.name }] };
  if (c.nullable !== undefined) col.nullable = c.nullable;
  if (c.default !== undefined) col.default = c.default;
  if (c.autoIncrement !== undefined) col.autoIncrement = c.autoIncrement;
  if (parsed.inlinePrimaryKey) col.inPrimaryKey = true;
  return col;
}

/** Split a `DROP TABLE` target list into table names (`a, \`b\`, db.c` → the identifier each item names). */
function tableList(list: string): string[] {
  const out: string[] = [];
  for (const item of list.split(",")) {
    const m = /^\s*(?:(?:`(?:[^`]|``)*`|[A-Za-z_][\w$]*)\s*\.\s*)?(`(?:[^`]|``)*`|[A-Za-z_][\w$]*)/.exec(item);
    if (m) out.push(unquote(m[1]));
  }
  return out;
}

// --- State helpers ---------------------------------------------------------------------------------

function ensureTable(
  state: Map<string, TableState>,
  name: string,
  decl: Declaration,
  warnings?: SchemaWarning[],
  op?: string,
): TableState {
  let table = state.get(name);
  if (!table) {
    table = { name, columns: new Map(), order: [], uniqueKeys: [], declarations: [] };
    state.set(name, table);
    if (warnings && op) {
      warnings.push({ kind: "migration-implied-table", message: `${op} targets ${name}, not created within this migration set`, evidence: [{ file: decl.file, line: decl.line }] });
    }
  }
  table.declarations.push(decl);
  return table;
}

function setColumn(table: TableState, col: ColState): void {
  if (!table.columns.has(col.name)) table.order.push(col.name);
  table.columns.set(col.name, col);
}

/** changeColumn/MODIFY: update the existing column's facts, preserving prior provenance; add if absent. */
function mergeColumn(table: TableState, col: ColState): void {
  const existing = table.columns.get(col.name);
  if (!existing) {
    setColumn(table, col);
    return;
  }
  existing.type = col.type;
  existing.typeVocabulary = col.typeVocabulary;
  if (col.nullable !== undefined) existing.nullable = col.nullable;
  if (col.default !== undefined) existing.default = col.default;
  if (col.autoIncrement !== undefined) existing.autoIncrement = col.autoIncrement;
  existing.provenance.push(...col.provenance);
}

function removeColumn(table: TableState, name: string): void {
  if (table.columns.delete(name)) {
    const i = table.order.indexOf(name);
    if (i >= 0) table.order.splice(i, 1);
  }
}

function renameAndSet(table: TableState, oldName: string, newName: string, spec: { type: string }, file: string, line: number): void {
  const existing = table.columns.get(oldName);
  const provenance: Declaration[] = existing ? [...existing.provenance, { sourceId: SOURCE_ID, file, line, symbol: newName }] : [{ sourceId: SOURCE_ID, file, line, symbol: newName }];
  if (existing) removeColumn(table, oldName);
  setColumn(table, { name: newName, type: spec.type, typeVocabulary: "sql", provenance });
}

/** Drop a table and, with it, the foreign keys it declared — a relationship out of a table that no longer exists. */
function dropTableIn(replay: Replay, name: string): void {
  if (!replay.state.delete(name)) return;
  for (let i = replay.relationships.length - 1; i >= 0; i--) {
    if (replay.relationships[i].fromTable === name) replay.relationships.splice(i, 1);
  }
}

function renameTableIn(replay: Replay, from: string, to: string, file: string, line: number): void {
  const table = replay.state.get(from);
  if (!table) return; // don't fabricate a table that was never created in this set
  replay.state.delete(from);
  table.name = to;
  table.declarations.push({ sourceId: SOURCE_ID, file, line, symbol: `${from} → ${to}` });
  replay.state.set(to, table);
  // Relationships name tables by string; a rename must carry both ends forward or they dangle.
  for (const rel of replay.relationships) {
    if (rel.fromTable === from) rel.fromTable = to;
    if (rel.toTable === from) rel.toTable = to;
  }
}

function toTableSchema(t: TableState): TableSchema {
  const columns = t.order.map((name) => {
    const c = t.columns.get(name)!;
    return { ...c };
  });
  const primaryKey = columns.filter((c) => c.inPrimaryKey).map((c) => c.name);
  for (const c of columns) if (primaryKey.includes(c.name)) c.inPrimaryKey = true;
  return { name: t.name, columns, primaryKey, uniqueKeys: t.uniqueKeys, declarations: t.declarations };
}

function unquote(id: string): string {
  return id.startsWith("`") ? id.slice(1, -1).replace(/``/g, "`") : id;
}

function truncate(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
}
