/**
 * Byte-stable Markdown + Mermaid renderer for a SchemaExtraction.
 *
 * Deterministic by construction: tables arrive already sorted by name and columns already in
 * authoritative order from `merge.ts`; every other list rendered here (sources, relationships,
 * isolated tables, unsupported formats, warnings) is sorted before printing, and NOTHING wall-clock
 * (no timestamp) enters the output. Rendering the same extraction twice yields byte-identical text.
 *
 * Zero model calls, zero npm deps. This renders the LANGUAGE-NEUTRAL structure (headings, column
 * headers, engine/scale/index, legend) in one fixed English set — the recovered facts are language
 * neutral anyway (identifiers, type strings, PK/UQ/FK marks). Localizing the NARRATIVE — the per-table
 * business descriptions and any target-language prose — is the authoring layer's job (an AI writing
 * from `db-schema.json`), never a hard-coded per-language template here. Adding a language costs no
 * code: descriptions arrive already written in the target language via injection.
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

// One neutral (English) label set. Language-dependent NARRATIVE (per-table descriptions, localized
// prose) is supplied by the authoring layer, not branched here — so any language works with no code.
const LABELS: Labels = {
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

/** Render a full `database-design.md` document. Byte-identical on rerun for the same extraction. */
export function renderSchema(extraction: SchemaExtraction): string {
  const l = LABELS;
  const out: string[] = [];

  out.push(`# ${l.title}`, "");
  out.push(`- ${l.target}: ${extraction.target}`);
  if (extraction.gitHead) out.push(`- ${l.gitHead}: ${extraction.gitHead}`);
  out.push(`- Database engine: ${engineLine(extraction.engine)}`);

  const sources = extraction.sources.slice().sort((a, b) => cmp(a.format, b.format));
  out.push(`- ${l.sources}:`);
  if (sources.length) {
    for (const source of sources) out.push(`  - ${source.format}: ${l.fileWord(source.files.length)}`);
  } else {
    out.push(`  - ${l.noSources}`);
  }
  const formatList = sources.map((s) => s.format).join(", ") || DASH;
  out.push(`- ${l.coverage(extraction.tables.length, formatList)}`, "");

  out.push(...overviewSection(extraction));

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

/** One-line engine summary for the header: name + confidence + first evidence + weaker alternatives. */
function engineLine(engine: SchemaExtraction["engine"]): string {
  if (!engine) return "could not be determined from source";
  const first = engine.evidence[0];
  const ref = first ? `${first.file}${first.line ? `:${first.line}` : ""}` : "";
  const evText = ref ? ` (per ${ref})` : "";
  const alt = engine.alternatives.length ? `; also seen: ${engine.alternatives.join(" / ")}` : "";
  return `${engine.name} (${engine.confidence})${evText}${alt}`;
}

/** The at-a-glance Overview section: scale, type-vocabulary note, warning summary, legend, table index. */
function overviewSection(extraction: SchemaExtraction): string[] {
  const out: string[] = [];
  const tables = extraction.tables.length;
  const columns = extraction.tables.reduce((n, table) => n + table.columns.length, 0);
  const rels = extraction.relationships.length;
  const isolated = isolatedTables(extraction).length;

  out.push("## Overview", "");
  out.push(`- Scale: ${tables} tables · ${columns} columns · ${rels} relationships (FK) · ${isolated} tables with no declared relationship`);
  out.push("- Type labels: a `go:` / `sequelize:` prefix marks the source type vocabulary (vocabularies are not comparable); `sql` is a physical type, printed bare");
  out.push(`- Cross-source disagreements: ${warningSummary(extraction.warnings)}`);
  out.push("- Legend: PK primary key · UQ unique · AI auto-increment · FK foreign key · `*` column name derived by a naming strategy · `—` not declared in source");
  out.push("- Generation: deterministic extraction (zero-model, read-only source); all column facts come from source, per-table descriptions are injected by an authoring step");
  out.push("");

  out.push("### Table index", "");
  out.push(tables ? extraction.tables.map((table) => `\`${table.name}\``).join(" · ") : "(no tables)");
  out.push("");
  return out;
}

/** Total warning count + top kinds, pointing at the Warnings appendix. */
function warningSummary(warnings: SchemaWarning[]): string {
  if (!warnings.length) return "none";
  const byKind = new Map<string, number>();
  for (const warning of warnings) byKind.set(warning.kind, (byKind.get(warning.kind) ?? 0) + 1);
  const top = [...byKind.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 6);
  return `${warnings.length} (${top.map(([kind, n]) => `${kind} ${n}`).join(", ")}), see Warnings below`;
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
