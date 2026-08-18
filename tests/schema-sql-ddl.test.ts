import test from "node:test";
import assert from "node:assert/strict";
import { parseSqlColumnDef, parseTableBody, readCreateTable, splitSqlStatements } from "../src/schema/parsers/sql-ddl.ts";

/** The shared grammar, tested where it lives — both raw-DDL callers inherit whatever is asserted here. */

test("statements split at `;` outside quoted runs — a `;` inside a column comment does not end the statement", () => {
  const sql =
    "ALTER TABLE `t` ADD COLUMN `status` TINYINT(1) DEFAULT 1 comment \"1-active ; 2-inactive; 3-delete\", " +
    "ADD COLUMN `email` VARCHAR(50) DEFAULT NULL; UPDATE t SET status = 1";
  const stmts = splitSqlStatements(sql);
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /^ALTER TABLE/);
  assert.match(stmts[0], /ADD COLUMN `email`/); // the clause after the comment is still in statement 1
  assert.equal(stmts[1], "UPDATE t SET status = 1");
});

test("empty statements between and after semicolons are dropped, not emitted as blanks", () => {
  assert.deepEqual(splitSqlStatements("SELECT 1;; ;\n SELECT 2;  "), ["SELECT 1", "SELECT 2"]);
});

test("readCreateTable reads a backticked or bare name, honours IF NOT EXISTS, and walks the balanced body", () => {
  const bare = readCreateTable("CREATE TABLE IF NOT EXISTS wcp_attachment (`id` int, `size` int) ENGINE=InnoDB");
  assert.equal(bare?.name, "wcp_attachment");
  assert.equal(bare?.body, "`id` int, `size` int");

  // A paren inside a type must not close the body early.
  const quoted = readCreateTable("CREATE TABLE `t` (`ratio` float(2,2) NOT NULL, `s` enum('a','b'))");
  assert.equal(quoted?.name, "t");
  assert.equal(quoted?.body, "`ratio` float(2,2) NOT NULL, `s` enum('a','b')");
});

test("readCreateTable skips a malformed statement and keeps scanning past it", () => {
  const found = readCreateTable("CREATE TABLE 9bad ; CREATE TABLE `good` (`id` int)");
  assert.equal(found?.name, "good");
});

test("a spaced display width stays part of the type: `VARCHAR ( 255 )` is not truncated to VARCHAR", () => {
  const parsed = parseSqlColumnDef("`key` VARCHAR ( 255 ) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL");
  assert.equal(parsed?.name, "key");
  assert.equal(parsed?.column.type, "VARCHAR ( 255 )");
  assert.equal(parsed?.column.nullable, false);
});

test("a table body separates columns, PK, unique keys, foreign keys, and the unreadable rest", () => {
  const body = parseTableBody(
    "`id` int unsigned NOT NULL AUTO_INCREMENT," +
      "`user_id` bigint NOT NULL," +
      "`note` varchar(10) DEFAULT ''," +
      "PRIMARY KEY (`id`)," +
      "UNIQUE KEY `unq` (`user_id`,`note`)," +
      "KEY `ix_note` (`note`)," +
      "CONSTRAINT `fk_u` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)," +
      "9 this is not a column",
  );
  assert.deepEqual(body.columns.map((c) => c.name), ["id", "user_id", "note"]);
  assert.equal(body.columns[0].column.autoIncrement, true);
  assert.deepEqual(body.primaryKey, ["id"]);
  assert.deepEqual(body.uniqueKeys, [{ name: "unq", columns: ["user_id", "note"] }]);
  assert.deepEqual(body.foreignKeys.map((f) => [f.fromColumns, f.toTable, f.toColumns]), [[["user_id"], "users", ["id"]]]);
  // The non-unique KEY is ignored by design; the unreadable item lands in a visible bucket, never dropped.
  assert.deepEqual(body.unparsed.map((u) => u.text), ["9 this is not a column"]);
});

test("an inline PRIMARY KEY on the column definition becomes the table primary key", () => {
  // The form wcp's migrations actually write, with no table-level PRIMARY KEY clause of its own.
  const body = parseTableBody("`id` int unsigned NOT NULL PRIMARY KEY AUTO_INCREMENT,`size` int unsigned NOT NULL");
  assert.equal(body.columns[0].inlinePrimaryKey, true);
  assert.equal(body.columns[1].inlinePrimaryKey, false);
  assert.deepEqual(body.primaryKey, ["id"]);
});

test("a named non-FK CONSTRAINT is ignored rather than reported as unreadable", () => {
  const body = parseTableBody("`a` int, CONSTRAINT `chk` CHECK (`a` > 0)");
  assert.deepEqual(body.columns.map((c) => c.name), ["a"]);
  assert.deepEqual(body.unparsed, []);
  assert.deepEqual(body.foreignKeys, []);
});
