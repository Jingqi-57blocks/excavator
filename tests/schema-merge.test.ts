import test from "node:test";
import assert from "node:assert/strict";
import { mergeSchemas } from "../src/schema/merge.ts";
import type { MergeInput } from "../src/schema/merge.ts";
import type { ColumnSchema, RelationshipSchema, SchemaFormat, TableSchema } from "../src/schema/types.ts";
import type { ParserResult } from "../src/schema/types.ts";

function input(format: SchemaFormat, tables: TableSchema[], relationships: RelationshipSchema[] = []): MergeInput {
  const result: ParserResult = { tables, relationships, warnings: [] };
  return { source: { id: format, format, files: [`${format}.src`] }, result };
}

function c(name: string, type: string, vocab: ColumnSchema["typeVocabulary"], extra: Partial<ColumnSchema> = {}): ColumnSchema {
  return { name, type, typeVocabulary: vocab, provenance: [{ sourceId: vocab, file: `${vocab}.src`, line: 1, symbol: name }], ...extra };
}

function col(t: TableSchema, name: string): ColumnSchema | undefined {
  return t.columns.find((x) => x.name === name);
}

test("columns union by name; the type authority order sql-dump > gorm wins the rendered type, others kept in provenance", () => {
  const sql = input("sql-dump", [{
    name: "wcp_leave",
    columns: [c("id", "bigint(20)", "sql", { inPrimaryKey: true, nullable: false, autoIncrement: true }), c("user_id", "bigint(20)", "sql"), c("status", "int", "sql")],
    primaryKey: ["id"],
    uniqueKeys: [],
    declarations: [{ sourceId: "sql-dump", file: "d.sql", line: 1, symbol: "wcp_leave" }],
  }]);
  const gorm = input("gorm", [{
    name: "wcp_leave",
    columns: [c("id", "uint64", "go", { inPrimaryKey: true }), c("user_id", "uint64", "go"), c("category", "uint8", "go")],
    primaryKey: ["id"],
    uniqueKeys: [],
    declarations: [{ sourceId: "gorm", file: "leave.go", line: 1, symbol: "Leave" }],
  }]);

  const out = mergeSchemas([sql, gorm], { target: "t" });
  assert.equal(out.tables.length, 1);
  const t = out.tables[0];
  // Authoritative (sql-dump) column order first, then columns only lower-authority sources have.
  assert.deepEqual(t.columns.map((x) => x.name), ["id", "user_id", "status", "category"]);

  // sql-dump wins the rendered type; the gorm declaration is not lost — it stays in provenance.
  assert.equal(col(t, "id")?.type, "bigint(20)");
  assert.equal(col(t, "id")?.typeVocabulary, "sql");
  assert.equal(col(t, "id")?.provenance.length, 2);
  // Both sources' declarations are kept, in authority order (sql-dump before gorm).
  assert.deepEqual(col(t, "id")?.provenance.map((p) => p.sourceId), ["sql", "go"]);
  assert.equal(col(t, "id")?.inPrimaryKey, true);
  assert.deepEqual(t.primaryKey, ["id"]);

  // Every contributing declaration is preserved on the merged table.
  assert.deepEqual(t.declarations.map((d) => d.symbol), ["wcp_leave", "Leave"]);
});

test("a column present in one source but absent from another describing the same table is warned (defensibility)", () => {
  const sql = input("sql-dump", [{
    name: "t", columns: [c("id", "int", "sql"), c("status", "int", "sql")], primaryKey: [], uniqueKeys: [], declarations: [{ sourceId: "sql-dump", file: "d.sql", line: 1, symbol: "t" }],
  }]);
  const gorm = input("gorm", [{
    name: "t", columns: [c("id", "int", "go"), c("category", "int", "go")], primaryKey: [], uniqueKeys: [], declarations: [{ sourceId: "gorm", file: "t.go", line: 1, symbol: "T" }],
  }]);
  const out = mergeSchemas([sql, gorm], { target: "t" });
  const mismatches = out.warnings.filter((w) => w.kind === "column-presence-mismatch");
  // status missing from gorm; category missing from sql-dump; id present in both (no warning).
  assert.equal(mismatches.length, 2);
  assert.ok(mismatches.some((w) => /t\.status/.test(w.message)));
  assert.ok(mismatches.some((w) => /t\.category/.test(w.message)));
});

test("same-vocabulary type-family mismatch across sources is a conflict; cross-vocabulary is not", () => {
  const a = input("sql-dump", [{ name: "t", columns: [c("amount", "int", "sql"), c("id", "bigint(20)", "sql")], primaryKey: [], uniqueKeys: [], declarations: [{ sourceId: "sql-dump", file: "a.sql", line: 1, symbol: "t" }] }]);
  const b = input("sequelize-migration", [{ name: "t", columns: [c("amount", "varchar(255)", "sql"), c("id", "uint64", "go")], primaryKey: [], uniqueKeys: [], declarations: [{ sourceId: "sequelize-migration", file: "b.js", line: 1, symbol: "t" }] }]);
  const out = mergeSchemas([a, b], { target: "t" });
  const conflicts = out.warnings.filter((w) => w.kind === "type-conflict");
  // amount: int vs varchar in the SAME "sql" vocabulary → conflict. id: bigint(sql) vs uint64(go) → different vocab, no conflict.
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].message, /amount/);
  assert.match(conflicts[0].message, /int vs varchar/);
});

test("multiple structs resolving to one physical table are canonicalized into a single table (union + all declarations)", () => {
  const gorm = input("gorm", [
    { name: "wcp_leave", columns: [c("id", "uint64", "go", { inPrimaryKey: true }), c("category", "uint8", "go")], primaryKey: ["id"], uniqueKeys: [], declarations: [{ sourceId: "gorm", file: "leave.go", line: 1, symbol: "Leave" }] },
    { name: "wcp_leave", columns: [c("id", "uint64", "go"), c("name", "string", "go")], primaryKey: [], uniqueKeys: [], declarations: [{ sourceId: "gorm", file: "leave.go", line: 20, symbol: "LeaveDto" }] },
  ]);
  const out = mergeSchemas([gorm], { target: "t" });
  assert.equal(out.tables.length, 1);
  const t = out.tables[0];
  assert.deepEqual(t.columns.map((x) => x.name), ["id", "category", "name"]);
  assert.deepEqual(t.declarations.map((d) => d.symbol), ["Leave", "LeaveDto"]);
  // Same source on both structs → no presence-mismatch noise.
  assert.equal(out.warnings.filter((w) => w.kind === "column-presence-mismatch").length, 0);
});

test("relationship targets carried as Go type names resolve to physical table names; unresolvable ones warn", () => {
  const gorm = input(
    "gorm",
    [
      { name: "app_post", columns: [c("id", "uint64", "go")], primaryKey: [], uniqueKeys: [], declarations: [{ sourceId: "gorm", file: "post.go", line: 1, symbol: "Post" }] },
      { name: "app_author", columns: [c("id", "uint64", "go")], primaryKey: [], uniqueKeys: [], declarations: [{ sourceId: "gorm", file: "author.go", line: 1, symbol: "Author" }] },
    ],
    [
      { kind: "belongs-to", fromTable: "app_post", fromColumns: ["author_id"], toTable: "Author", toColumns: [], provenance: [{ sourceId: "gorm", file: "post.go", line: 3, symbol: "Author" }] },
      { kind: "has-many", fromTable: "app_post", fromColumns: [], toTable: "Ghost", toColumns: [], provenance: [{ sourceId: "gorm", file: "post.go", line: 4, symbol: "Ghosts" }] },
    ],
  );
  const out = mergeSchemas([gorm], { target: "t" });
  const resolved = out.relationships.find((r) => r.kind === "belongs-to")!;
  assert.equal(resolved.toTable, "app_author"); // Go struct name Author → physical app_author
  const kept = out.relationships.find((r) => r.kind === "has-many")!;
  assert.equal(kept.toTable, "Ghost"); // unresolved → kept verbatim
  assert.equal(out.warnings.filter((w) => w.kind === "relationship-target-unresolved").length, 1);
});

test("output is deterministic: tables sorted by name, sources listed, unsupported empty", () => {
  const a = input("gorm", [{ name: "zebra", columns: [c("id", "int", "go")], primaryKey: [], uniqueKeys: [], declarations: [] }]);
  const b = input("sql-dump", [{ name: "apple", columns: [c("id", "int", "sql")], primaryKey: [], uniqueKeys: [], declarations: [] }]);
  const out = mergeSchemas([a, b], { target: "proj", gitHead: "abc123" });
  assert.deepEqual(out.tables.map((t) => t.name), ["apple", "zebra"]);
  assert.equal(out.target, "proj");
  assert.equal(out.gitHead, "abc123");
  assert.deepEqual(out.sources.map((s) => s.format).sort(), ["gorm", "sql-dump"]);
  assert.deepEqual(out.unsupported, []);
});
