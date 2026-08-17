/**
 * Deterministic MySQL DDL parser (`CREATE TABLE` dumps).
 *
 * Recovers tables, columns, keys, and foreign-key relationships from raw `CREATE TABLE` statements by
 * hand-written, quote-aware character scanning — no SQL engine, no npm deps, no model calls. This is
 * the source closest to the physical schema, so its column types are recorded verbatim in the "sql"
 * vocabulary (never cross-converted — see types.ts) and it doubles as the validation oracle for the
 * other, higher-level parsers.
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
 *
 * The column/type reader (`parseSqlColumnDef`) and the top-level splitter (`splitTopLevelSql`) are
 * exported so the raw-DDL whitelist in the sequelize-migration parser reuses one SQL grammar, not two.
 */

import type {
  ColumnSchema, ParserResult, ReadFile, RelationshipSchema, SchemaParser, SchemaWarning, TableSchema, UniqueKey
} from "../types.ts";
import { LineMap } from "./source-position.ts";

const SOURCE_ID = "sql-dump";

/** A column parsed from DDL, without provenance (the caller stamps source/file/line). */
export interface SqlColumn {
  name: string;
  type: string;
  typeVocabulary: "sql";
  nullable?: boolean;
  default?: string;
  autoIncrement?: boolean;
}

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

interface CreateTableStmt {
  name: string;
  nameOffset: number;
  body: string;
  bodyOffset: number;
}

/** Advance past a quoted run that starts at `s[i]` (`'`, `"`, or backtick); returns the index after the close. */
export function skipSqlString(s: string, i: number, quote: string): number {
  i++;
  while (i < s.length) {
    const c = s[i];
    // Backtick identifiers use doubling to escape; string literals also accept backslash escapes.
    if (c === "\\" && quote !== "`") {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (s[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

/** Locate every `CREATE TABLE` and return its name plus the balanced-paren body, by offset. */
function extractCreateTables(content: string): CreateTableStmt[] {
  const out: CreateTableStmt[] = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    let i = m.index + m[0].length;
    const nameOffset = i;
    let name: string;
    if (content[i] === "`") {
      const end = skipSqlString(content, i, "`");
      name = content.slice(i + 1, end - 1).replace(/``/g, "`");
      i = end;
    } else {
      const nm = /^[A-Za-z_][\w$]*/.exec(content.slice(i));
      if (!nm) continue;
      name = nm[0];
      i += nm[0].length;
    }
    while (i < content.length && content[i] !== "(" && content[i] !== ";") i++;
    if (content[i] !== "(") continue;
    const bodyOffset = i + 1;
    let depth = 0;
    let j = i;
    for (; j < content.length; j++) {
      const c = content[j];
      if (c === "'" || c === '"' || c === "`") {
        j = skipSqlString(content, j, c) - 1;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ name, nameOffset, body: content.slice(bodyOffset, j), bodyOffset });
    re.lastIndex = j;
  }
  return out;
}

/** A body segment with the file offset of its first character (for line resolution). */
interface Segment {
  text: string;
  offset: number;
}

/** Split at commas that sit at paren-depth 0 and outside any quoted run. Offsets are relative to `base`. */
export function splitTopLevelSql(body: string, base = 0): Segment[] {
  const out: Segment[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipSqlString(body, i, c);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push({ text: body.slice(start, i), offset: base + start });
      start = i + 1;
    }
    i++;
  }
  out.push({ text: body.slice(start), offset: base + start });
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
  const columns: ColumnSchema[] = [];
  const primaryKey: string[] = [];
  const uniqueKeys: UniqueKey[] = [];

  for (const seg of splitTopLevelSql(stmt.body, stmt.bodyOffset)) {
    const leadingWs = seg.text.length - seg.text.trimStart().length;
    const text = seg.text.trim();
    if (text === "") continue;
    const line = lines.lineAt(seg.offset + leadingWs);
    const kw = text.toUpperCase();

    if (kw.startsWith("PRIMARY KEY")) {
      primaryKey.push(...backtickList(text));
      continue;
    }
    if (kw.startsWith("UNIQUE")) {
      uniqueKeys.push(parseUniqueKey(text));
      continue;
    }
    if (kw.startsWith("KEY ") || kw.startsWith("INDEX ") || kw.startsWith("FULLTEXT") || kw.startsWith("SPATIAL") || kw.startsWith("CHECK")) {
      continue; // non-unique index / check — intentionally ignored
    }
    if (kw.startsWith("CONSTRAINT") || kw.startsWith("FOREIGN KEY")) {
      const rel = parseForeignKey(text, stmt.name, { sourceId: SOURCE_ID, file, line });
      if (rel) relationships.push(rel);
      continue; // non-FK constraints (unique/check named) carry no column facts here
    }

    const parsed = parseSqlColumnDef(text);
    if (!parsed) {
      warnings.push({ kind: "sql-unparsed-item", message: `could not parse table item: ${truncate(text)}`, evidence: [{ file, line }] });
      continue;
    }
    const column: ColumnSchema = { ...parsed.column, provenance: [{ sourceId: SOURCE_ID, file, line, symbol: parsed.name }] };
    columns.push(column);
    if (parsed.inlinePrimaryKey && !primaryKey.includes(parsed.name)) primaryKey.push(parsed.name);
    if (parsed.inlineUnique) uniqueKeys.push({ columns: [parsed.name] });
  }

  for (const c of columns) if (primaryKey.includes(c.name)) c.inPrimaryKey = true;

  tables.push({
    name: stmt.name,
    columns,
    primaryKey,
    uniqueKeys,
    declarations: [{ sourceId: SOURCE_ID, file, line: lines.lineAt(stmt.nameOffset), symbol: stmt.name }],
  });
}

/** Parse one column definition. Returns null only when no name/type can be read (never guesses). */
export function parseSqlColumnDef(
  text: string,
): { name: string; column: SqlColumn; inlinePrimaryKey: boolean; inlineUnique: boolean } | null {
  const trimmed = text.trim();
  const name = readName(trimmed);
  if (name === null) return null;
  const afterName = trimmed.slice(name.consumed).trimStart();
  const typeInfo = readType(afterName);
  if (typeInfo === null) return null;
  const attrs = afterName.slice(typeInfo.consumed);

  const column: SqlColumn = { name: name.value, type: typeInfo.type, typeVocabulary: "sql" };

  const def = extractDefault(attrs);
  if (def !== null) column.default = def.value;

  // Blank quoted runs (comments, default strings) before scanning for the NULL keyword to avoid false hits.
  const cleaned = blankQuoted(def === null ? attrs : attrs.slice(0, def.start) + " ".repeat(def.raw.length) + attrs.slice(def.end));
  if (/\bNOT\s+NULL\b/i.test(cleaned)) column.nullable = false;
  else if (/\bNULL\b/i.test(cleaned)) column.nullable = true;
  if (/\bAUTO_INCREMENT\b/i.test(cleaned)) column.autoIncrement = true;

  return {
    name: name.value,
    column,
    inlinePrimaryKey: /\bPRIMARY\s+KEY\b/i.test(cleaned),
    inlineUnique: /\bUNIQUE\b/i.test(cleaned),
  };
}

/** Read a leading backtick-quoted or bare identifier. */
function readName(s: string): { value: string; consumed: number } | null {
  if (s[0] === "`") {
    const end = skipSqlString(s, 0, "`");
    return { value: s.slice(1, end - 1).replace(/``/g, "`"), consumed: end };
  }
  const m = /^[A-Za-z_][\w$]*/.exec(s);
  return m ? { value: m[0], consumed: m[0].length } : null;
}

/** Read a type verbatim: `<word>` + optional `(...)` + trailing modifiers (`unsigned`/`signed`/`zerofill`). */
function readType(s: string): { type: string; consumed: number } | null {
  const wm = /^[A-Za-z_]\w*/.exec(s);
  if (!wm) return null;
  let i = wm[0].length;
  if (s[i] === "(") {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === "'" || c === '"' || c === "`") {
        j = skipSqlString(s, j, c) - 1;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    i = j;
  }
  let mod = /^\s+(unsigned|signed|zerofill)\b/i.exec(s.slice(i));
  while (mod) {
    i += mod[0].length;
    mod = /^\s+(unsigned|signed|zerofill)\b/i.exec(s.slice(i));
  }
  return { type: s.slice(0, i).trim(), consumed: i };
}

/** Extract the `DEFAULT` value (string literals unquoted; functions/keywords verbatim), or null if none. */
function extractDefault(attrs: string): { value: string; start: number; end: number; raw: string } | null {
  const m = /\bDEFAULT\b/i.exec(attrs);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < attrs.length && /\s/.test(attrs[i])) i++;
  const valueStart = i;
  const q = attrs[i];
  if (q === "'" || q === '"') {
    const end = skipSqlString(attrs, i, q);
    const inner = attrs.slice(i + 1, end - 1).replace(new RegExp(q + q, "g"), q);
    return { value: inner, start: m.index, end, raw: attrs.slice(m.index, end) };
  }
  if (attrs[i] === "(") {
    let depth = 0;
    let j = i;
    for (; j < attrs.length; j++) {
      const c = attrs[j];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    return { value: attrs.slice(valueStart, j).trim(), start: m.index, end: j, raw: attrs.slice(m.index, j) };
  }
  const tm = /^[^\s,]+/.exec(attrs.slice(i));
  if (!tm) return null;
  let j = i + tm[0].length;
  if (attrs[j] === "(") {
    // function call default such as current_timestamp()
    let depth = 0;
    for (; j < attrs.length; j++) {
      const c = attrs[j];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
  }
  return { value: attrs.slice(valueStart, j).trim(), start: m.index, end: j, raw: attrs.slice(m.index, j) };
}

/** Replace quoted runs with equal-length spaces so keyword scans never match text inside strings. */
function blankQuoted(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === "`") {
      const end = skipSqlString(s, i, c);
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** All backtick-quoted identifiers inside the first parenthesized group of `text`. */
function backtickList(text: string): string[] {
  const open = text.indexOf("(");
  if (open < 0) return [];
  const inner = text.slice(open + 1, text.lastIndexOf(")"));
  const out: string[] = [];
  const re = /`((?:[^`]|``)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) out.push(m[1].replace(/``/g, "`"));
  if (out.length === 0) {
    // Bare (unquoted) column list fallback.
    for (const part of inner.split(",")) {
      const t = part.trim().replace(/\s.*$/, "");
      if (t) out.push(t);
    }
  }
  return out;
}

function parseUniqueKey(text: string): UniqueKey {
  const columns = backtickList(text);
  // Optional name sits between the UNIQUE [KEY|INDEX] keywords and the column list.
  const nameMatch = /^UNIQUE\s+(?:KEY|INDEX)?\s*`((?:[^`]|``)*)`\s*\(/i.exec(text) ?? /^UNIQUE\s+(?:KEY|INDEX)\s+([A-Za-z_]\w*)\s*\(/i.exec(text);
  const key: UniqueKey = { columns };
  if (nameMatch) key.name = nameMatch[1].replace(/``/g, "`");
  return key;
}

/** Parse `[CONSTRAINT name] FOREIGN KEY (cols) REFERENCES t (cols)` into a belongs-to relationship. */
function parseForeignKey(text: string, fromTable: string, decl: { sourceId: string; file: string; line: number }): RelationshipSchema | null {
  const fk = /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(`(?:[^`]|``)*`|[A-Za-z_]\w*)\s*\(([^)]*)\)/i.exec(text);
  if (!fk) return null;
  const fromColumns = idsFrom(fk[1]);
  const toTable = fk[2].startsWith("`") ? fk[2].slice(1, -1).replace(/``/g, "`") : fk[2];
  const toColumns = idsFrom(fk[3]);
  return {
    kind: "belongs-to",
    fromTable,
    fromColumns,
    toTable,
    toColumns,
    provenance: [{ sourceId: decl.sourceId, file: decl.file, line: decl.line }],
  };
}

function idsFrom(list: string): string[] {
  const out: string[] = [];
  const re = /`((?:[^`]|``)*)`|([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(list)) !== null) out.push((m[1] ?? m[2]).replace(/``/g, "`"));
  return out;
}

function truncate(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
}
