import test from "node:test";
import assert from "node:assert/strict";
import { renderSchema } from "../src/schema/render.ts";
import { injectDescriptions } from "../src/schema/descriptions.ts";
import type { ColumnSchema, SchemaExtraction, TableSchema } from "../src/schema/types.ts";

function col(name: string, type: string, vocab: ColumnSchema["typeVocabulary"], extra: Partial<ColumnSchema> = {}): ColumnSchema {
  return { name, type, typeVocabulary: vocab, provenance: [{ sourceId: vocab === "go" ? "gorm" : "sql-dump", file: `${name}.src`, line: 1 }], ...extra };
}

/** A rich extraction exercising every render branch: derived name, undeclared nullability, PK/UQ,
 *  a relationship between two tables, an isolated table, an unsupported format, and a warning. */
function fixture(): SchemaExtraction {
  const leave: TableSchema = {
    name: "wcp_leave",
    columns: [
      col("id", "bigint(20)", "sql", { inPrimaryKey: true, nullable: false, autoIncrement: true }),
      col("user_id", "uint64", "go"),
      col("full_name", "string", "go", { nameDerived: true }),
      col("total", "int", "sql", { nullable: false }),
    ],
    primaryKey: ["id"],
    uniqueKeys: [{ columns: ["total"] }],
    declarations: [{ sourceId: "sql-dump", file: "d.sql", line: 1, symbol: "wcp_leave" }],
  };
  const author: TableSchema = {
    name: "wcp_author",
    columns: [col("id", "uint64", "go", { inPrimaryKey: true })],
    primaryKey: ["id"],
    uniqueKeys: [],
    declarations: [{ sourceId: "gorm", file: "author.go", line: 3, symbol: "Author" }],
  };
  const isolated: TableSchema = {
    name: "audit_log",
    columns: [col("id", "int", "sql", { inPrimaryKey: true })],
    primaryKey: ["id"],
    uniqueKeys: [],
    declarations: [{ sourceId: "sql-dump", file: "d.sql", line: 40, symbol: "audit_log" }],
  };
  return {
    target: "proj",
    gitHead: "abc123",
    sources: [
      { id: "gorm", format: "gorm", files: ["author.go"] },
      { id: "sql-dump", format: "sql-dump", files: ["d.sql"] },
    ],
    tables: [author, isolated, leave],
    relationships: [
      { kind: "belongs-to", fromTable: "wcp_leave", fromColumns: ["user_id"], toTable: "wcp_author", toColumns: ["id"], provenance: [{ sourceId: "gorm", file: "leave.go", line: 5 }] },
    ],
    unsupported: [{ format: "Prisma", reason: "Prisma schema located; this extractor has no Prisma parser.", evidence: [{ file: "prisma/schema.prisma" }] }],
    warnings: [{ kind: "table-name-unresolved", message: "TableName for X did not resolve", evidence: [{ file: "x.go", line: 9 }] }],
  };
}

test("render is byte-identical on rerun (deterministic)", () => {
  const x = fixture();
  assert.equal(renderSchema(x), renderSchema(x));
});

test("undeclared nullability renders — and never a fabricated boolean", () => {
  const md = renderSchema(fixture());
  // user_id has no declared nullability → em dash in the nullable column.
  const row = md.split("\n").find((line) => line.startsWith("| user_id "))!;
  assert.match(row, /\| user_id \| go:uint64 \| — \|/);
});

test("type carries its vocabulary except sql, which prints bare", () => {
  const md = renderSchema(fixture());
  assert.match(md, /\| user_id \| go:uint64 \|/); // go vocabulary prefixed
  assert.match(md, /\| id \| bigint\(20\) \|/); // sql prints bare
});

test("a name-derived column is marked with * and gets a footnote", () => {
  const md = renderSchema(fixture());
  assert.match(md, /\| full_name\* \|/);
  assert.match(md, /`\*` Column name derived by the source format's default naming strategy/);
});

test("PK, UQ and AI marks are reflected in the key column", () => {
  const md = renderSchema(fixture());
  assert.match(md.split("\n").find((l) => l.startsWith("| id | bigint(20)"))!, /\| PK, AI \|/);
  assert.match(md.split("\n").find((l) => l.startsWith("| total "))!, /\| UQ \|/);
});

test("erDiagram contains only tables in a declared relationship; isolated tables are listed", () => {
  const md = renderSchema(fixture());
  const mermaid = md.slice(md.indexOf("```mermaid"), md.indexOf("```", md.indexOf("```mermaid") + 3));
  assert.match(mermaid, /wcp_leave \}o--\|\| wcp_author : belongsTo/);
  assert.doesNotMatch(mermaid, /audit_log/); // isolated table is NOT in the diagram
  assert.match(md, /Tables with no declared relationship: audit_log\./);
});

test("no relationships → a note, no empty mermaid block", () => {
  const x = fixture();
  x.relationships = [];
  const md = renderSchema(x);
  assert.match(md, /No declared relationships\./);
  assert.doesNotMatch(md, /```mermaid/);
});

test("unsupported formats and warnings appendices are rendered honestly", () => {
  const md = renderSchema(fixture());
  assert.match(md, /## Unsupported formats/);
  assert.match(md, /- Prisma: .* \(prisma\/schema\.prisma\)/);
  assert.match(md, /## Warnings/);
  assert.match(md, /\[table-name-unresolved\] TableName for X did not resolve \(x\.go:9\)/);
});

test("empty appendices state the honest negative instead of omitting the section", () => {
  const x = fixture();
  x.unsupported = [];
  x.warnings = [];
  const md = renderSchema(x);
  assert.match(md, /No unsupported schema formats were located\./);
  assert.match(md, /No warnings\./);
});

test("renders one neutral (English) structural label set; localization is the authoring layer's job", () => {
  const md = renderSchema(fixture());
  assert.match(md, /# Database Design/);
  assert.match(md, /## Overview/);
  assert.match(md, /### Table index/);
  assert.match(md, /\| column \| type \| nullable \| default \| key \| source \|/);
  // No per-language template lives in the renderer; a Chinese report is the same structure with
  // AI-written descriptions injected, never a hard-coded zh label set.
  assert.doesNotMatch(md, /数据库设计|列 \| 类型/);
});

test("warnings are de-duplicated and sorted for byte-stability", () => {
  const x = fixture();
  x.warnings = [
    { kind: "b-kind", message: "second" },
    { kind: "a-kind", message: "first" },
    { kind: "b-kind", message: "second" }, // duplicate
  ];
  const md = renderSchema(x);
  const lines = md.split("\n").filter((l) => l.startsWith("- ["));
  assert.deepEqual(lines, ["- [a-kind] first", "- [b-kind] second"]);
});

test("injectDescriptions sets a matching table's description verbatim; missing tables keep the placeholder", () => {
  const x = fixture();
  injectDescriptions(x, { wcp_leave: "Leave requests submitted by employees." });
  assert.equal(x.tables.find((t) => t.name === "wcp_leave")?.description, "Leave requests submitted by employees.");
  const md = renderSchema(x);
  assert.match(md, /Leave requests submitted by employees\./);
  // A table with no provided description renders the fixed placeholder.
  assert.match(md, /### wcp_author\n\n\(no description provided\)/);
});

test("injectDescriptions rejects a key that is not an extracted table name (no hallucinated tables)", () => {
  assert.throws(() => injectDescriptions(fixture(), { not_a_table: "x" }), /unknown table "not_a_table"/);
});

test("injectDescriptions rejects a value containing a newline", () => {
  assert.throws(() => injectDescriptions(fixture(), { wcp_leave: "line one\nline two" }), /contains a newline/);
});
