/**
 * Deterministic gorm model parser (Go).
 *
 * Recovers tables, columns, keys, and relationships from Go struct definitions and their gorm struct
 * tags — by hand-written text/structural scanning only. No Go toolchain, no AST library, no model
 * calls, no npm deps. Same inputs → byte-identical output (files are read in sorted order and the
 * first declaration of any name wins).
 *
 * What makes a table: a struct with a `func (x *T) TableName() string { return <expr> }`. The physical
 * name is `<expr>` resolved as a string literal or a Go const (see go-const-resolver). A struct with
 * no `TableName()` is a value object, not a table, and is emitted only when another table embeds it.
 * An unresolved `TableName()` is reported as a warning and the struct is skipped — never guessed.
 *
 * Column vs relationship: a `gorm:"column:..."` field is a column, its `type` recorded as the Go field
 * type in the "go" vocabulary (never converted to SQL — see types.ts). A field whose gorm tag carries
 * `foreignKey`/`references`/`many2many`/`joinForeignKey`/`joinReferences` is a relationship, not a
 * column. Embedded structs are expanded in place (their own tagged fields become columns, with
 * provenance pointing at the embedded struct's own source). `gorm:"-"` is ignored.
 *
 * Naming strategy: a field with no `column:` tag is NOT dropped — gorm derives its column name as
 * snake_case of the field name (its documented default), so we do the same for exported fields (tagged
 * or fully untagged) and mark the column `nameDerived` so the derivation is transparent. An untagged
 * field whose type is another model (a slice/pointer to a known struct) is treated as an association and
 * skipped; a tag with unrecognized segments stays ambiguous and yields a malformed-tag warning, no column.
 *
 * Multi-struct / same table: this parser emits one table PER struct that declares a `TableName()`,
 * each carrying its own declarations and columns. Two structs resolving to the same physical name
 * therefore yield two `TableSchema` entries with the same `name`; canonicalizing/merging them is the
 * job of the later merge step, not this parser.
 */

import type {
  ColumnSchema, ParserResult, ReadFile, RelationshipSchema, SchemaParser, SchemaWarning, TableSchema, UniqueKey
} from "../types.ts";
import { buildConstMap, resolveConstExpr } from "./go-const-resolver.ts";
import { gormColumnName } from "./gorm-naming.ts";

// In PR1 there is a single gorm source; the assembly step assigns real SchemaSource ids later.
const SOURCE_ID = "gorm";

// gorm tag keys that take a `key:value` form and are understood (so they never read as malformed).
const KNOWN_KEYS = new Set([
  "column", "type", "default", "size", "comment", "index", "uniqueindex", "precision", "scale",
  "check", "serializer", "embeddedprefix", "foreignkey", "references", "many2many", "joinforeignkey",
  "joinreferences", "collate", "autoincrement", "->", "<-",
]);

// gorm tag flags in bare (no-colon) form that are understood.
const KNOWN_FLAGS = new Set([
  "primarykey", "primary_key", "not null", "notnull", "unique", "autoincrement", "auto_increment",
  "index", "uniqueindex", "embedded", "null", "-", "->", "<-",
]);

// gorm tag keys that mark a field as an association (relationship) rather than a column.
const ASSOCIATION_KEYS = ["foreignkey", "references", "many2many", "joinforeignkey", "joinreferences"];

interface RawField {
  line: number;
  content: string;
}

interface GoStruct {
  name: string;
  file: string;
  line: number;
  fields: RawField[];
}

interface TableNameDecl {
  expr: string;
  file: string;
  line: number;
}

interface FlatField {
  content: string;
  file: string;
  line: number;
}

interface GormTag {
  keys: Record<string, string>;
  flags: Set<string>;
  unrecognized: string[];
}

interface RelationshipCandidate {
  fieldName: string;
  fieldType: string;
  tag: GormTag;
  file: string;
  line: number;
}

/** The gorm parser: pure function of its files + injected reader. */
export const gormParser: SchemaParser = {
  format: "gorm",
  parse(files: string[], readFile: ReadFile): ParserResult {
    const warnings: SchemaWarning[] = [];
    const allStructs: GoStruct[] = [];
    const structByName = new Map<string, GoStruct>();
    const tableNameByType = new Map<string, TableNameDecl>();

    for (const file of [...files].sort()) {
      const { structs, tableNames } = parseGoFile(file, readFile(file));
      for (const s of structs) {
        allStructs.push(s);
        if (!structByName.has(s.name)) structByName.set(s.name, s);
      }
      for (const [type, decl] of tableNames) {
        if (!tableNameByType.has(type)) tableNameByType.set(type, decl);
      }
    }

    const constMap = buildConstMap(files, readFile);
    const tables: TableSchema[] = [];
    const relationships: RelationshipSchema[] = [];

    for (const struct of allStructs) {
      const decl = tableNameByType.get(struct.name);
      if (!decl) continue; // No TableName() → not a table.
      const physical = resolveTableName(decl.expr, constMap);
      if (physical === null) {
        warnings.push({
          kind: "table-name-unresolved",
          message: `TableName for ${struct.name} did not resolve to a string literal or known constant`,
          evidence: [{ file: decl.file, line: decl.line }],
        });
        continue;
      }
      const flat = flatten(struct, structByName, new Set([struct.name]), warnings);
      const built = buildTable(physical, struct, flat, structByName, warnings);
      tables.push(built.table);
      relationships.push(...built.relationships);
    }

    return { tables, relationships, warnings };
  },
};

/** Resolve a `TableName()` return expression to a physical name: string literal first, then const. */
function resolveTableName(expr: string, constMap: ReturnType<typeof buildConstMap>): string | null {
  const literal = expr.trim().match(/^"((?:[^"\\]|\\.)*)"$/);
  if (literal) return literal[1];
  const entry = resolveConstExpr(expr, constMap);
  return entry ? entry.value : null;
}

/** Extract every struct definition and TableName() method from one Go file. */
function parseGoFile(file: string, content: string): { structs: GoStruct[]; tableNames: Map<string, TableNameDecl> } {
  const lines = content.split("\n");
  const structs: GoStruct[] = [];
  const tableNames = new Map<string, TableNameDecl>();

  // Struct bodies via brace tracking (gorm tags/comments carry no braces in practice).
  let current: GoStruct | null = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (current === null) {
      const m = raw.match(/^\s*type\s+([A-Za-z_]\w*)\s+struct\s*\{/);
      if (m) {
        current = { name: m[1], file, line: i + 1, fields: [] };
        depth = braceDelta(raw);
        if (depth <= 0) {
          structs.push(current);
          current = null;
        }
      }
      continue;
    }
    const delta = braceDelta(raw);
    if (depth + delta <= 0) {
      structs.push(current);
      current = null;
      depth = 0;
      continue;
    }
    depth += delta;
    const trimmed = raw.trim();
    if (trimmed) current.fields.push({ line: i + 1, content: trimmed });
  }

  // TableName() methods (top-level funcs) in a separate scan.
  for (let i = 0; i < lines.length; i++) {
    const fm = lines[i].match(/^\s*func\s*\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*TableName\s*\(\s*\)\s*string\s*\{(.*)$/);
    if (!fm) continue;
    const type = fm[1];
    let expr = extractReturnExpr(fm[2]);
    if (expr === null) {
      for (let j = i + 1; j < lines.length && j <= i + 6; j++) {
        const rm = lines[j].match(/^\s*return\s+(.+?)\s*$/);
        if (rm) {
          expr = cleanReturnExpr(rm[1]);
          break;
        }
        if (/^\s*\}/.test(lines[j])) break;
      }
    }
    if (expr !== null && expr !== "" && !tableNames.has(type)) {
      tableNames.set(type, { expr, file, line: i + 1 });
    }
  }

  return { structs, tableNames };
}

function braceDelta(line: string): number {
  const open = (line.match(/\{/g) ?? []).length;
  const close = (line.match(/\}/g) ?? []).length;
  return open - close;
}

/** From the text after a `TableName() string {` open brace, pull the `return <expr>` if present. */
function extractReturnExpr(rest: string): string | null {
  const m = rest.match(/return\s+(.+)$/);
  return m ? cleanReturnExpr(m[1]) : null;
}

function cleanReturnExpr(s: string): string {
  return s
    .replace(/\/\/.*$/, "")
    .replace(/\}\s*$/, "")
    .trim();
}

/** Flatten a struct's fields, expanding embedded structs in place; pass non-embed fields through. */
function flatten(struct: GoStruct, structByName: Map<string, GoStruct>, visited: Set<string>, warnings: SchemaWarning[]): FlatField[] {
  const out: FlatField[] = [];
  for (const field of struct.fields) {
    const content = field.content;
    if (content.startsWith("//")) continue;
    const tagMatch = content.match(/`([^`]*)`/);
    const before = (tagMatch ? content.slice(0, tagMatch.index) : content.replace(/\/\/.*$/, "")).trim();
    const hasGorm = tagMatch ? /gorm:"/.test(tagMatch[1]) : false;
    const tokens = before.split(/\s+/).filter(Boolean);

    // A lone type with no gorm tag is an embedded struct.
    if (tokens.length === 1 && !hasGorm) {
      const embedName = tokens[0].split(".").pop() ?? tokens[0];
      if (visited.has(embedName)) continue; // cycle guard
      const target = structByName.get(embedName);
      if (!target) {
        warnings.push({
          kind: "embedded-unresolved",
          message: `embedded ${tokens[0]} unresolved, columns incomplete`,
          evidence: [{ file: struct.file, line: field.line }],
        });
        continue;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(embedName);
      out.push(...flatten(target, structByName, nextVisited, warnings));
      continue;
    }
    out.push({ content, file: struct.file, line: field.line });
  }
  return out;
}

/** Build one table's columns/keys/relationships from its flattened fields. */
function buildTable(
  physical: string,
  struct: GoStruct,
  flat: FlatField[],
  structByName: Map<string, GoStruct>,
  warnings: SchemaWarning[],
): { table: TableSchema; relationships: RelationshipSchema[] } {
  const columns: ColumnSchema[] = [];
  const primaryKey: string[] = [];
  const uniqueKeys: UniqueKey[] = [];
  const fieldToColumn = new Map<string, string>();
  const relCandidates: RelationshipCandidate[] = [];

  for (const f of flat) {
    const parsed = parseFieldLine(f.content);
    if (parsed.kind === "comment" || parsed.kind === "blank") continue;
    if (parsed.kind === "untagged") {
      // gorm keeps untagged EXPORTED fields as columns named by snake_case; unexported fields are ignored.
      if (!/^[A-Z]/.test(parsed.fieldName)) continue;
      if (isProbableAssociation(parsed.fieldType, structByName)) {
        warnings.push({ kind: "untagged-association-skipped", message: `untagged field ${parsed.fieldName} ${parsed.fieldType} looks like an association; skipped`, evidence: [{ file: f.file, line: f.line }] });
        continue;
      }
      const derivedName = gormColumnName(parsed.fieldName);
      columns.push({
        name: derivedName,
        type: parsed.fieldType,
        typeVocabulary: "go",
        nameDerived: true,
        provenance: [{ sourceId: SOURCE_ID, file: f.file, line: f.line, symbol: parsed.fieldName }],
      });
      fieldToColumn.set(parsed.fieldName, derivedName);
      continue;
    }
    // tagged
    if (parsed.gormVal === "-") continue; // explicitly ignored
    const tag = parseGormTag(parsed.gormVal);
    if (isAssociation(tag)) {
      relCandidates.push({ fieldName: parsed.fieldName, fieldType: parsed.fieldType, tag, file: f.file, line: f.line });
      continue;
    }
    // No `column:` tag → derive the name by gorm's snake_case NamingStrategy (deterministic, not a guess).
    // A tag with unrecognized segments stays ambiguous: no column, a malformed-tag warning.
    let colName = tag.keys.column;
    let nameDerived = false;
    if (colName === undefined) {
      if (tag.unrecognized.length) {
        warnings.push({ kind: "malformed-tag", message: `malformed gorm tag on ${parsed.fieldName || "field"}: ${tag.unrecognized.join("; ")}`, evidence: [{ file: f.file, line: f.line }] });
        continue;
      }
      if (!/^[A-Z]/.test(parsed.fieldName)) continue; // unexported, no explicit column → not a column
      colName = gormColumnName(parsed.fieldName);
      nameDerived = true;
    }
    const column: ColumnSchema = {
      name: colName,
      type: parsed.fieldType,
      typeVocabulary: "go",
      provenance: [{ sourceId: SOURCE_ID, file: f.file, line: f.line, symbol: parsed.fieldName }],
    };
    if (nameDerived) column.nameDerived = true;
    if (tag.flags.has("not null")) column.nullable = false; // never inferred true — undeclared stays undefined
    if (tag.keys.default !== undefined) column.default = tag.keys.default;
    if (tag.flags.has("autoincrement") || tag.flags.has("auto_increment") || tag.keys.autoincrement !== undefined) column.autoIncrement = true;
    if (tag.flags.has("primarykey") || tag.flags.has("primary_key")) {
      column.inPrimaryKey = true;
      primaryKey.push(colName);
    }
    columns.push(column);
    fieldToColumn.set(parsed.fieldName, colName);
    if (tag.flags.has("unique")) uniqueKeys.push({ columns: [colName] });
    if (tag.unrecognized.length) {
      warnings.push({
        kind: "malformed-tag",
        message: `malformed gorm tag segment(s) on ${parsed.fieldName}: ${tag.unrecognized.join("; ")}`,
        evidence: [{ file: f.file, line: f.line }],
      });
    }
  }

  // Relationships resolved after all columns are known, so foreignKey field-names map to columns.
  const relationships = relCandidates.map((rc) => buildRelationship(rc, physical, fieldToColumn));

  const table: TableSchema = {
    name: physical,
    columns,
    primaryKey,
    uniqueKeys,
    declarations: [{ sourceId: SOURCE_ID, file: struct.file, line: struct.line, symbol: struct.name }],
  };
  return { table, relationships };
}

type ParsedFieldLine =
  | { kind: "comment" }
  | { kind: "blank" }
  | { kind: "untagged"; fieldName: string; fieldType: string }
  | { kind: "tagged"; fieldName: string; fieldType: string; gormVal: string };

function parseFieldLine(content: string): ParsedFieldLine {
  if (content.startsWith("//")) return { kind: "comment" };
  const tagMatch = content.match(/`([^`]*)`/);
  const tag = tagMatch ? tagMatch[1] : "";
  const before = (tagMatch ? content.slice(0, tagMatch.index) : content.replace(/\/\/.*$/, "")).trim();
  const tokens = before.split(/\s+/).filter(Boolean);
  const gormMatch = tag.match(/gorm:"([^"]*)"/);
  if (tokens.length === 0) return { kind: "blank" };
  if (!gormMatch) {
    if (tokens.length === 1) return { kind: "blank" }; // lone type handled as embed upstream
    return { kind: "untagged", fieldName: tokens[0], fieldType: tokens.slice(1).join(" ") };
  }
  return {
    kind: "tagged",
    fieldName: tokens[0] ?? "",
    fieldType: tokens.length > 1 ? tokens.slice(1).join(" ") : "",
    gormVal: gormMatch[1].trim(),
  };
}

function parseGormTag(gormVal: string): GormTag {
  const keys: Record<string, string> = {};
  const flags = new Set<string>();
  const unrecognized: string[] = [];
  for (const seg of gormVal.split(";").map((s) => s.trim()).filter(Boolean)) {
    const ci = seg.indexOf(":");
    if (ci >= 0) {
      const key = seg.slice(0, ci).trim().toLowerCase();
      const value = seg.slice(ci + 1).trim();
      if (KNOWN_KEYS.has(key)) {
        if (!(key in keys)) keys[key] = value;
      } else {
        unrecognized.push(seg);
      }
    } else {
      const flag = seg.toLowerCase();
      if (KNOWN_FLAGS.has(flag)) flags.add(flag);
      else unrecognized.push(seg);
    }
  }
  return { keys, flags, unrecognized };
}

function isAssociation(tag: GormTag): boolean {
  return ASSOCIATION_KEYS.some((k) => tag.keys[k] !== undefined);
}

/**
 * Heuristic for an UNTAGGED field: is its Go type a reference to another model (an association), rather
 * than a scalar column? A slice of a capitalized/known type (`[]Detail`, `[]*Office`) or a value/pointer
 * to a known struct (`*Author`) is an association; `[]byte`, `*time.Time`, `string`, etc. are columns.
 */
function isProbableAssociation(fieldType: string, structByName: Map<string, GoStruct>): boolean {
  const isSlice = /\[\s*\]/.test(fieldType);
  const base = fieldType.replace(/[[\]*\s]/g, "").split(".").pop() ?? "";
  const known = structByName.has(base);
  if (isSlice) return known || /^[A-Z]/.test(base);
  return known;
}

function buildRelationship(rc: RelationshipCandidate, fromTable: string, fieldToColumn: Map<string, string>): RelationshipSchema {
  const { tag, fieldType, fieldName, file, line } = rc;
  const isSlice = /^\s*\[\]/.test(fieldType);
  const toTable = (fieldType.replace(/[[\]*]/g, "").split(".").pop() ?? "").trim();
  const many2many = tag.keys.many2many;
  const foreignKey = tag.keys.foreignkey;
  const references = tag.keys.references;

  let kind: RelationshipSchema["kind"];
  if (many2many !== undefined) kind = "many-to-many";
  else if (isSlice) kind = "has-many";
  else if (foreignKey !== undefined && fieldToColumn.has(foreignKey)) kind = "belongs-to";
  else kind = "has-one";

  // foreignKey names a Go FIELD → resolve to its column; otherwise (already a column name) keep verbatim.
  const fromColumns = foreignKey !== undefined ? [fieldToColumn.get(foreignKey) ?? foreignKey] : [];
  const toColumns = references !== undefined ? [references] : [];

  const rel: RelationshipSchema = {
    kind,
    fromTable,
    fromColumns,
    toTable,
    toColumns,
    provenance: [{ sourceId: SOURCE_ID, file, line, symbol: fieldName }],
  };
  if (many2many !== undefined) rel.joinTable = many2many;
  return rel;
}
