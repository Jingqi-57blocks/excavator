import test from "node:test";
import assert from "node:assert/strict";
import { sqlDumpParser } from "../src/schema/parsers/sql-dump.ts";
import type { ColumnSchema } from "../src/schema/types.ts";

function parse(sql: string) {
  return sqlDumpParser.parse(["dump.sql"], () => sql);
}

function col(columns: ColumnSchema[], name: string): ColumnSchema | undefined {
  return columns.find((c) => c.name === name);
}

test("a CREATE TABLE yields columns with verbatim SQL types, nullability, defaults, auto_increment, PK", () => {
  const sql = `CREATE TABLE \`wcp_worklog\` (
  \`id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  \`project_id\` bigint(20) NOT NULL,
  \`spent\` double(5,2) DEFAULT 0.00,
  \`content\` text DEFAULT NULL,
  \`note\` varchar(32) DEFAULT '',
  \`created_at\` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`wl_un_0\` (\`project_id\`,\`id\`),
  KEY \`ix_note\` (\`note\`)
) ENGINE=InnoDB AUTO_INCREMENT=39444 DEFAULT CHARSET=utf8;`;
  const { tables, warnings } = parse(sql);
  assert.equal(warnings.length, 0);
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.equal(t.name, "wcp_worklog");
  // The non-unique KEY is ignored; only real column definitions become columns.
  assert.deepEqual(t.columns.map((c) => c.name), ["id", "project_id", "spent", "content", "note", "created_at"]);

  // Display width + `unsigned` are kept verbatim as the type string, in the "sql" vocabulary.
  assert.equal(col(t.columns, "id")?.type, "bigint(20) unsigned");
  assert.equal(col(t.columns, "id")?.typeVocabulary, "sql");
  assert.equal(col(t.columns, "id")?.nullable, false); // NOT NULL
  assert.equal(col(t.columns, "id")?.autoIncrement, true);
  assert.equal(col(t.columns, "id")?.inPrimaryKey, true);

  // DEFAULT forms: number verbatim, empty string unquoted to "", a function call verbatim.
  assert.equal(col(t.columns, "spent")?.default, "0.00");
  assert.equal(col(t.columns, "note")?.default, "");
  assert.equal(col(t.columns, "created_at")?.default, "current_timestamp()");
  // `DEFAULT NULL` does not set NOT NULL, and undeclared nullability stays undefined (never fabricated).
  assert.equal(Object.prototype.hasOwnProperty.call(col(t.columns, "content")!, "nullable"), false);

  assert.deepEqual(t.primaryKey, ["id"]);
  assert.deepEqual(t.uniqueKeys, [{ name: "wl_un_0", columns: ["project_id", "id"] }]);
});

test("multi-column PRIMARY KEY and an anonymous UNIQUE parse; provenance points at the column line", () => {
  const sql = `CREATE TABLE \`pair\` (
  \`a\` int NOT NULL,
  \`b\` int NOT NULL,
  \`c\` varchar(10) NULL,
  PRIMARY KEY (\`a\`,\`b\`),
  UNIQUE (\`c\`)
);`;
  const { tables } = parse(sql);
  const t = tables[0];
  assert.deepEqual(t.primaryKey, ["a", "b"]);
  assert.equal(col(t.columns, "a")?.inPrimaryKey, true);
  assert.equal(col(t.columns, "b")?.inPrimaryKey, true);
  assert.equal(col(t.columns, "c")?.nullable, true); // explicit NULL keyword → nullable:true
  assert.deepEqual(t.uniqueKeys, [{ columns: ["c"] }]); // anonymous unique carries no name
  assert.equal(col(t.columns, "a")?.provenance[0].line, 2);
  assert.equal(col(t.columns, "b")?.provenance[0].line, 3);
});

test("a CONSTRAINT … FOREIGN KEY becomes a belongs-to relationship; enum types keep their parenthesized value", () => {
  const sql = `CREATE TABLE \`orders\` (
  \`id\` bigint NOT NULL,
  \`user_id\` bigint NOT NULL,
  \`status\` enum('open','closed') DEFAULT 'open',
  PRIMARY KEY (\`id\`),
  CONSTRAINT \`fk_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`)
);`;
  const { tables, relationships } = parse(sql);
  assert.equal(col(tables[0].columns, "status")?.type, "enum('open','closed')");
  assert.equal(col(tables[0].columns, "status")?.default, "open");
  assert.equal(relationships.length, 1);
  const r = relationships[0];
  assert.equal(r.kind, "belongs-to");
  assert.equal(r.fromTable, "orders");
  assert.deepEqual(r.fromColumns, ["user_id"]);
  assert.equal(r.toTable, "users");
  assert.deepEqual(r.toColumns, ["id"]);
});

test("multiple CREATE TABLE statements in one dump are all recovered, deterministically", () => {
  const sql = `CREATE TABLE \`a\` (\`id\` int NOT NULL, PRIMARY KEY (\`id\`)) ENGINE=InnoDB;
CREATE TABLE \`b\` (\`id\` int NOT NULL) ENGINE=InnoDB;`;
  const { tables } = parse(sql);
  assert.deepEqual(tables.map((t) => t.name), ["a", "b"]);
});
