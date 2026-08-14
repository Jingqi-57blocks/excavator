/**
 * Byte-stable Markdown + Mermaid renderer for a SchemaExtraction.
 *
 * Deterministic by construction: tables arrive already sorted by name and columns already in
 * authoritative order from `merge.ts`; every other list rendered here (sources, relationships,
 * isolated tables, unsupported formats, warnings) is sorted before printing, and NOTHING wall-clock
 * (no timestamp) enters the output. Rendering the same extraction twice yields byte-identical text.
 *
 * Zero model calls, zero npm deps. Two fixed label sets (`en-US` default, `zh-CN`) localize the
 * headings and column headers only — never the recovered facts, which are printed verbatim.
 *
 * Honesty rules mirrored from the data model: an undeclared nullability renders `—` (never a
 * fabricated boolean); a column whose NAME was derived by a naming strategy gets a trailing `*` and a
 * footnote; a column's `type` carries its vocabulary (`go:uint64`, `sequelize:STRING`) except SQL,
 * whose types are already physical and print bare. The ER diagram shows only tables that participate
 * in at least one declared relationship; isolated tables are listed by name so nothing is hidden.
 */

import type {
  ColumnSchema,
  RelationshipSchema,
  SchemaExtraction,
  SchemaWarning,
  TableSchema,
  UnsupportedFormat,
} from "./types.ts";

export interface RenderOptions {
  /** "en-US" (default) or "zh-CN". The caller validates the tag; anything else is treated as English. */
  language?: string;
}

const DASH = "—";

interface Labels {
  title: string;
  target: string;
  gitHead: string;
  sources: string;
  fileWord: (n: number) => string;
  coverage: (tables: number, formats: string) => string;
  noSources: string;
  tablesHeading: string;
  declaredIn: string;
  colColumn: string;
  colType: string;
  colNullable: string;
  colDefault: string;
  colKey: string;
  colSource: string;
  yes: string;
  no: string;
  noDescription: string;
  nameDerivedFootnote: string;
  relationshipsHeading: string;
  noRelationships: string;
  isolatedNote: string;
  unsupportedHeading: string;
  noUnsupported: string;
  warningsHeading: string;
  noWarnings: string;
}

function labelsFor(language: string | undefined): Labels {
  if ((language ?? "").toLowerCase().startsWith("zh")) {
    return {
      title: "数据库设计",
      target: "目标",
      gitHead: "Git HEAD",
      sources: "来源",
      fileWord: (n) => `${n} 个文件`,
      coverage: (tables, formats) => `覆盖：从 ${formats} 恢复 ${tables} 张表`,
      noSources: "未发现任何可解析的 schema 来源。",
      tablesHeading: "表",
      declaredIn: "声明于",
      colColumn: "列",
      colType: "类型",
      colNullable: "可空",
      colDefault: "默认值",
      colKey: "键",
      colSource: "来源",
      yes: "是",
      no: "否",
      noDescription: "（暂无描述）",
      nameDerivedFootnote: "`*` 列名由源格式的默认命名策略推导（源码中并未逐字书写）。",
      relationshipsHeading: "关系",
      noRelationships: "未声明任何关系。",
      isolatedNote: "无已声明关系的表",
      unsupportedHeading: "不支持的格式",
      noUnsupported: "未发现不支持的 schema 格式。",
      warningsHeading: "警告",
      noWarnings: "无警告。",
    };
  }
  return {
    title: "Database Design",
    target: "Target",
    gitHead: "Git HEAD",
    sources: "Sources",
    fileWord: (n) => `${n} file${n === 1 ? "" : "s"}`,
    coverage: (tables, formats) => `Coverage: ${tables} table${tables === 1 ? "" : "s"} recovered from ${formats}`,
    noSources: "No parseable schema sources were discovered.",
    tablesHeading: "Tables",
    declaredIn: "Declared in",
    colColumn: "column",
    colType: "type",
    colNullable: "nullable",
    colDefault: "default",
    colKey: "key",
    colSource: "source",
    yes: "yes",
    no: "no",
    noDescription: "(no description provided)",
    nameDerivedFootnote: "`*` Column name derived by the source format's default naming strategy (not written verbatim in source).",
    relationshipsHeading: "Relationships",
    noRelationships: "No declared relationships.",
    isolatedNote: "Tables with no declared relationship",
    unsupportedHeading: "Unsupported formats",
    noUnsupported: "No unsupported schema formats were located.",
    warningsHeading: "Warnings",
    noWarnings: "No warnings.",
  };
}

/** Render a full `database-design.md` document. Byte-identical on rerun for the same extraction. */
export function renderSchema(extraction: SchemaExtraction, options: RenderOptions = {}): string {
  const l = labelsFor(options.language);
  const out: string[] = [];

  out.push(`# ${l.title}`, "");
  out.push(`- ${l.target}: ${extraction.target}`);
  if (extraction.gitHead) out.push(`- ${l.gitHead}: ${extraction.gitHead}`);

  const sources = extraction.sources.slice().sort((a, b) => cmp(a.format, b.format));
  out.push(`- ${l.sources}:`);
  if (sources.length) {
    for (const source of sources) out.push(`  - ${source.format}: ${l.fileWord(source.files.length)}`);
  } else {
    out.push(`  - ${l.noSources}`);
  }
  const formatList = sources.map((s) => s.format).join(", ") || DASH;
  out.push(`- ${l.coverage(extraction.tables.length, formatList)}`, "");

  // Tables
  out.push(`## ${l.tablesHeading}`, "");
  let anyDerived = false;
  for (const table of extraction.tables) {
    out.push(`### ${table.name}`, "");
    out.push(table.description && table.description.trim() ? table.description : l.noDescription, "");
    out.push("<details>", `<summary>${l.declaredIn}</summary>`, "");
    for (const ref of declarationRefs(table)) out.push(`- ${ref}`);
    out.push("", "</details>", "");
    const uniqueCols = uniqueColumnSet(table);
    out.push(`| ${l.colColumn} | ${l.colType} | ${l.colNullable} | ${l.colDefault} | ${l.colKey} | ${l.colSource} |`);
    out.push("| --- | --- | --- | --- | --- | --- |");
    for (const column of table.columns) {
      if (column.nameDerived) anyDerived = true;
      out.push(renderColumnRow(column, uniqueCols, l));
    }
    out.push("");
  }
  if (!extraction.tables.length) out.push(`_${l.noSources}_`, "");
  if (anyDerived) out.push(l.nameDerivedFootnote, "");

  // Relationships + ER diagram
  out.push(`## ${l.relationshipsHeading}`, "");
  const relationships = extraction.relationships;
  if (relationships.length) {
    for (const rel of relationships) out.push(`- ${relationshipLine(rel)}`);
    out.push("");
    out.push("```mermaid", ...erDiagram(relationships), "```", "");
  } else {
    out.push(l.noRelationships, "");
  }
  const isolated = isolatedTables(extraction);
  if (isolated.length) out.push(`_${l.isolatedNote}: ${isolated.join(", ")}._`, "");

  // Unsupported formats
  out.push(`## ${l.unsupportedHeading}`, "");
  if (extraction.unsupported.length) {
    for (const item of sortUnsupported(extraction.unsupported)) out.push(`- ${unsupportedLine(item)}`);
    out.push("");
  } else {
    out.push(l.noUnsupported, "");
  }

  // Warnings
  out.push(`## ${l.warningsHeading}`, "");
  const warnings = sortWarnings(extraction.warnings);
  if (warnings.length) {
    for (const warning of warnings) out.push(`- ${warningLine(warning)}`);
    out.push("");
  } else {
    out.push(l.noWarnings, "");
  }

  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

function renderColumnRow(column: ColumnSchema, uniqueCols: Set<string>, l: Labels): string {
  const name = column.nameDerived ? `${column.name}*` : column.name;
  const nullable = column.nullable === undefined ? DASH : column.nullable ? l.yes : l.no;
  const def = column.default === undefined ? DASH : escapeCell(column.default);
  return `| ${escapeCell(name)} | ${escapeCell(renderType(column))} | ${nullable} | ${def} | ${keyMarks(column, uniqueCols)} | ${sourceMarks(column)} |`;
}

/** Type carries its vocabulary except SQL, whose types are already physical and print bare. */
function renderType(column: ColumnSchema): string {
  return column.typeVocabulary === "sql" ? column.type : `${column.typeVocabulary}:${column.type}`;
}

function keyMarks(column: ColumnSchema, uniqueCols: Set<string>): string {
  const marks: string[] = [];
  if (column.inPrimaryKey) marks.push("PK");
  if (uniqueCols.has(column.name)) marks.push("UQ");
  if (column.autoIncrement) marks.push("AI");
  return marks.length ? marks.join(", ") : DASH;
}

function sourceMarks(column: ColumnSchema): string {
  const ids = [...new Set(column.provenance.map((p) => p.sourceId))].sort(cmp);
  return ids.length ? ids.join(", ") : DASH;
}

function uniqueColumnSet(table: TableSchema): Set<string> {
  const set = new Set<string>();
  for (const key of table.uniqueKeys) for (const col of key.columns) set.add(col);
  return set;
}

/** Deduplicated, sorted `file:line` declaration sites for one table (DASH when none). */
function declarationRefs(table: TableSchema): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const decl of table.declarations) {
    const ref = `${decl.file}:${decl.line}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  refs.sort(cmp);
  return refs.length ? refs : [DASH];
}

function relationshipLine(rel: RelationshipSchema): string {
  const cols = rel.fromColumns.length || rel.toColumns.length
    ? ` on (${rel.fromColumns.join(", ") || DASH} → ${rel.toColumns.join(", ") || DASH})`
    : "";
  const via = rel.joinTable ? ` via ${rel.joinTable}` : "";
  return `${rel.fromTable} —${rel.kind}→ ${rel.toTable}${cols}${via}`;
}

const CARDINALITY: Record<RelationshipSchema["kind"], string> = {
  "belongs-to": "}o--||",
  "has-one": "||--o|",
  "has-many": "||--o{",
  "many-to-many": "}o--o{",
};

const KIND_LABEL: Record<RelationshipSchema["kind"], string> = {
  "belongs-to": "belongsTo",
  "has-one": "hasOne",
  "has-many": "hasMany",
  "many-to-many": "manyToMany",
};

/** One Mermaid erDiagram containing only tables that participate in a declared relationship. */
function erDiagram(relationships: RelationshipSchema[]): string[] {
  const lines = ["erDiagram"];
  for (const rel of relationships) {
    lines.push(`  ${entity(rel.fromTable)} ${CARDINALITY[rel.kind]} ${entity(rel.toTable)} : ${KIND_LABEL[rel.kind]}`);
  }
  return lines;
}

/** A Mermaid entity name: bare when it is a clean identifier, else quoted. */
function entity(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, "'")}"`;
}

function isolatedTables(extraction: SchemaExtraction): string[] {
  const participants = new Set<string>();
  for (const rel of extraction.relationships) {
    participants.add(rel.fromTable);
    participants.add(rel.toTable);
  }
  return extraction.tables.map((t) => t.name).filter((name) => !participants.has(name)).sort(cmp);
}

function unsupportedLine(item: UnsupportedFormat): string {
  const files = item.evidence.map((e) => (e.line ? `${e.file}:${e.line}` : e.file));
  const suffix = files.length ? ` (${files.join(", ")})` : "";
  return `${item.format}: ${item.reason}${suffix}`;
}

function sortUnsupported(items: UnsupportedFormat[]): UnsupportedFormat[] {
  return items.slice().sort((a, b) => cmp(a.format, b.format));
}

function warningLine(warning: SchemaWarning): string {
  const files = (warning.evidence ?? []).map((e) => (e.line ? `${e.file}:${e.line}` : e.file));
  const suffix = files.length ? ` (${dedupeSorted(files).join(", ")})` : "";
  return `[${warning.kind}] ${warning.message}${suffix}`;
}

/** De-duplicate identical warnings and sort by kind, then message, then evidence — byte-stable. */
function sortWarnings(warnings: SchemaWarning[]): SchemaWarning[] {
  const seen = new Set<string>();
  const out: SchemaWarning[] = [];
  for (const warning of warnings) {
    const key = warningLine(warning);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(warning);
  }
  return out.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.message, b.message) || cmp(warningLine(a), warningLine(b)));
}

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort(cmp);
}

/** Escape a Markdown table cell: pipes break columns; newlines would break the row. */
function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
