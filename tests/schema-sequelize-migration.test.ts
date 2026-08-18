import test from "node:test";
import assert from "node:assert/strict";
import { sequelizeMigrationParser } from "../src/schema/parsers/sequelize-migration.ts";
import type { ColumnSchema } from "../src/schema/types.ts";

/** Parse an ordered set of migration files given as { filename: source }. Filenames sort into replay order. */
function parse(files: Record<string, string>) {
  return sequelizeMigrationParser.parse(Object.keys(files), (p) => {
    const c = files[p];
    if (c === undefined) throw new Error(`no such fixture: ${p}`);
    return c;
  });
}

function col(columns: ColumnSchema[], name: string): ColumnSchema | undefined {
  return columns.find((c) => c.name === name);
}

test("createTable recovers columns, PK, autoIncrement, allowNull, and defaultValue in the sequelize vocabulary", () => {
  const files = {
    "20200101000000-create-leave.js": `'use strict';
module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.createTable('wcp_leave', {
      id: { allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.BIGINT },
      user_id: { type: Sequelize.BIGINT },
      title: Sequelize.STRING(50),
      createdAt: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
  },
  down: (queryInterface) => { return queryInterface.dropTable('wcp_leave'); },
};`,
  };
  const { tables, warnings } = parse(files);
  assert.equal(warnings.length, 0);
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.equal(t.name, "wcp_leave");
  assert.deepEqual(t.columns.map((c) => c.name), ["id", "user_id", "title", "createdAt"]);
  assert.equal(col(t.columns, "id")?.type, "BIGINT");
  assert.equal(col(t.columns, "id")?.typeVocabulary, "sequelize");
  assert.equal(col(t.columns, "id")?.nullable, false);
  assert.equal(col(t.columns, "id")?.autoIncrement, true);
  assert.equal(col(t.columns, "id")?.inPrimaryKey, true);
  assert.deepEqual(t.primaryKey, ["id"]);
  assert.equal(col(t.columns, "title")?.type, "STRING(50)"); // shorthand `col: Sequelize.STRING(50)`
  assert.equal(col(t.columns, "createdAt")?.default, "Sequelize.literal('CURRENT_TIMESTAMP')");
});

test("only up() is replayed — a down() full of dropTable never destroys recovered state", () => {
  const files = {
    "20200101000000-create.js": `module.exports = {
  up: (queryInterface, Sequelize) => queryInterface.createTable('t', { id: { type: Sequelize.INTEGER } }),
  down: (queryInterface, Sequelize) => {
    queryInterface.dropTable('t');
    return queryInterface.createTable('ghost', { id: { type: Sequelize.INTEGER } });
  },
};`,
  };
  const { tables } = parse(files);
  // `ghost` lives only in down() and must not appear; `t` (created in up) survives.
  assert.deepEqual(tables.map((t) => t.name), ["t"]);
});

test("addColumn / changeColumn / removeColumn apply in filename order", () => {
  const files = {
    "20200101-a-create.js": `module.exports = { up: (q, Sequelize) => q.createTable('t', { id: { type: Sequelize.INTEGER }, tmp: { type: Sequelize.STRING } }), down: (q) => q.dropTable('t') };`,
    "20200102-b-add.js": `module.exports = { up: (q, Sequelize) => q.addColumn('t', 'email', { type: Sequelize.STRING, allowNull: false }), down: (q) => q.removeColumn('t', 'email') };`,
    "20200103-c-change.js": `module.exports = { up: (q, Sequelize) => q.changeColumn('t', 'id', { type: Sequelize.BIGINT, primaryKey: true }), down: (q) => q.changeColumn('t', 'id', { type: Sequelize.INTEGER }) };`,
    "20200104-d-remove.js": `module.exports = { up: (q, Sequelize) => q.removeColumn('t', 'tmp'), down: (q, Sequelize) => q.addColumn('t', 'tmp', { type: Sequelize.STRING }) };`,
  };
  const { tables } = parse(files);
  const t = tables[0];
  assert.deepEqual(t.columns.map((c) => c.name), ["id", "email"]); // tmp removed, email added
  assert.equal(col(t.columns, "email")?.nullable, false);
  assert.equal(col(t.columns, "id")?.type, "BIGINT"); // changeColumn updated the type
  // changeColumn preserves the original createTable declaration AND appends the change declaration.
  assert.equal(col(t.columns, "id")?.provenance.length, 2);
});

test("raw-SQL DDL whitelist: ALTER ADD [COLUMN] / DROP COLUMN / MODIFY apply; types are the sql vocabulary", () => {
  const files = {
    "20200101-a.js": `module.exports = { up: (q, S) => q.createTable('wl', { id: { type: S.BIGINT }, old: { type: S.STRING } }), down: (q) => q.dropTable('wl') };`,
    "20200102-b.js": `module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.sequelize.query(
      'alter table \`wl\` ' +
        'ADD COLUMN \`deleted_at\` bigint(20) NULL, ' +
        'ADD \`spent\` double(5,2) DEFAULT 0'
    );
  },
  down: (queryInterface) => queryInterface.sequelize.query('select 1'),
};`,
    "20200103-c.js": `module.exports = { up: (q) => q.sequelize.query('ALTER TABLE wl MODIFY COLUMN old TEXT'), down: (q) => q.sequelize.query('select 1') };`,
    "20200104-d.js": `module.exports = { up: (q) => q.sequelize.query('ALTER TABLE wl DROP COLUMN spent'), down: (q) => q.sequelize.query('select 1') };`,
  };
  const { tables } = parse(files);
  const t = tables[0];
  // spent added then dropped; deleted_at added; old modified. Both `ADD COLUMN` and bare `ADD` forms work.
  assert.deepEqual(t.columns.map((c) => c.name), ["id", "old", "deleted_at"]);
  assert.equal(col(t.columns, "deleted_at")?.type, "bigint(20)");
  assert.equal(col(t.columns, "deleted_at")?.typeVocabulary, "sql"); // raw DDL types are the sql vocabulary
  assert.equal(col(t.columns, "deleted_at")?.nullable, true);
  assert.equal(col(t.columns, "old")?.type, "TEXT"); // MODIFY replaced the type
});

test("raw-SQL table rename carries the table (and its columns) forward under the new name", () => {
  const files = {
    "20200101-a.js": `module.exports = { up: (q, S) => q.createTable('users', { id: { type: S.INTEGER }, name: { type: S.STRING } }), down: (q) => q.dropTable('users') };`,
    "20200102-b.js": `module.exports = { up: (q) => q.sequelize.query('alter table users rename to wcp_user'), down: (q) => q.sequelize.query('select 1') };`,
    "20200103-c.js": `module.exports = { up: (q, S) => q.addColumn('wcp_user', 'email', { type: S.STRING }), down: (q) => q.removeColumn('wcp_user', 'email') };`,
    "20200104-d.js": `module.exports = { up: (q) => q.sequelize.query('rename table wcp_user to wcp_member'), down: (q) => q.sequelize.query('select 1') };`,
  };
  const { tables } = parse(files);
  // ALTER … RENAME TO and RENAME TABLE both apply; the original `users` name is gone.
  assert.deepEqual(tables.map((t) => t.name), ["wcp_member"]);
  assert.deepEqual(tables[0].columns.map((c) => c.name), ["id", "name", "email"]);
});

test("a raw statement outside the DDL whitelist is never guessed — it is recorded as a warning", () => {
  const files = {
    "20200101-a.js": `module.exports = { up: (q, S) => q.createTable('t', { id: { type: S.INTEGER } }), down: (q) => q.dropTable('t') };`,
    "20200102-b.js": `module.exports = { up: (q) => q.sequelize.query("UPDATE t SET id = id + 1"), down: (q) => q.sequelize.query('select 1') };`,
  };
  const { tables, warnings } = parse(files);
  assert.deepEqual(tables[0].columns.map((c) => c.name), ["id"]); // state untouched by the UPDATE
  const unapplied = warnings.filter((w) => w.kind === "unapplied-raw-statement");
  assert.equal(unapplied.length, 1);
  assert.match(unapplied[0].message, /UPDATE t SET/);
});

test("a raw CREATE TABLE becomes a real table — columns, PK, and unique keys, in the sql vocabulary", () => {
  const files = {
    "20200101-a.js": `module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.sequelize.query(
      'CREATE TABLE wcp_attachment (' +
        '\`id\` int unsigned NOT NULL PRIMARY KEY AUTO_INCREMENT,' +
        'size int unsigned NOT NULL,' +
        "\`name\` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT ''," +
        '\`key\` VARCHAR ( 255 ) NOT NULL,' +
        'UNIQUE KEY \`unq_key\` (\`key\`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;'
    );
  },
  down: (queryInterface) => queryInterface.sequelize.query('DROP TABLE wcp_attachment'),
};`,
  };
  const { tables, warnings } = parse(files);
  assert.deepEqual(tables.map((t) => t.name), ["wcp_attachment"]);
  const t = tables[0];
  assert.deepEqual(t.columns.map((c) => c.name), ["id", "size", "name", "key"]);
  assert.equal(col(t.columns, "id")?.typeVocabulary, "sql"); // raw DDL types are the sql vocabulary
  assert.equal(col(t.columns, "id")?.type, "int unsigned");
  assert.equal(col(t.columns, "id")?.autoIncrement, true);
  assert.deepEqual(t.primaryKey, ["id"]); // inline PRIMARY KEY on the column definition
  assert.equal(col(t.columns, "size")?.nullable, false); // a bare (unbackticked) column name still parses
  assert.equal(col(t.columns, "name")?.default, "");
  assert.equal(col(t.columns, "key")?.type, "VARCHAR ( 255 )"); // spaced display width kept verbatim
  assert.deepEqual(t.uniqueKeys, [{ name: "unq_key", columns: ["key"] }]);
  // The statement is applied, so it must NOT also be reported as unapplied.
  assert.deepEqual(warnings.filter((w) => w.kind === "unapplied-raw-statement"), []);
});

test("CREATE TABLE IF NOT EXISTS is recovered, and a later ALTER extends the SAME table state", () => {
  const files = {
    "20200101-a.js": `module.exports = { up: (q) => q.sequelize.query('CREATE TABLE IF NOT EXISTS \`t\` (\`id\` int NOT NULL)'), down: (q) => q.sequelize.query('select 1') };`,
    "20200102-b.js": `module.exports = { up: (q) => q.sequelize.query('ALTER TABLE \`t\` ADD COLUMN \`email\` VARCHAR(50) NULL'), down: (q) => q.sequelize.query('select 1') };`,
    "20200103-c.js": `module.exports = { up: (q, S) => q.addColumn('t', 'nickname', { type: S.STRING }), down: (q) => q.removeColumn('t', 'nickname') };`,
  };
  const { tables, warnings } = parse(files);
  // One table, not three: the raw-DDL and structured paths write into one state per table name.
  assert.deepEqual(tables.map((t) => t.name), ["t"]);
  assert.deepEqual(tables[0].columns.map((c) => c.name), ["id", "email", "nickname"]);
  // Because the CREATE was understood, the later addColumn is no longer an "implied" table.
  assert.deepEqual(warnings.filter((w) => w.kind === "migration-implied-table"), []);
});

test("a CREATE TABLE body item the grammar cannot read is warned about, never silently dropped", () => {
  const files = {
    "20200101-a.js": `module.exports = { up: (q) => q.sequelize.query('CREATE TABLE \`t\` (\`id\` int NOT NULL, 9 not a column)'), down: (q) => q.sequelize.query('select 1') };`,
  };
  const { tables, warnings } = parse(files);
  assert.deepEqual(tables[0].columns.map((c) => c.name), ["id"]);
  const unparsed = warnings.filter((w) => w.kind === "sql-unparsed-item");
  assert.equal(unparsed.length, 1);
  assert.match(unparsed[0].message, /9 not a column/);
});

test("a raw DROP TABLE in up() removes the table — a dropped table must not survive as a live one", () => {
  const files = {
    "20200101-a.js": `module.exports = { up: (q) => q.sequelize.query('CREATE TABLE \`gone\` (\`id\` int NOT NULL); CREATE TABLE \`kept\` (\`id\` int NOT NULL)'), down: (q) => q.sequelize.query('select 1') };`,
    "20200102-b.js": `module.exports = { up: (q) => q.sequelize.query('drop table IF EXISTS gone'), down: (q) => q.sequelize.query('select 1') };`,
  };
  const { tables, warnings } = parse(files);
  assert.deepEqual(tables.map((t) => t.name), ["kept"]);
  assert.deepEqual(warnings.filter((w) => w.kind === "unapplied-raw-statement"), []);
});

test("a `;` inside a column comment does not truncate the statement — every later clause still applies", () => {
  const files = {
    "20200101-a.js": `module.exports = { up: (q, S) => q.createTable('wcp_user', { id: { type: S.INTEGER } }), down: (q) => q.dropTable('wcp_user') };`,
    "20200102-b.js": `module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.sequelize.query(
      'alter table \`wcp_user\` ' +
        'ADD COLUMN \`status\` TINYINT(1) DEFAULT 1 comment "1-active ; 2-inactive; 3-delete", ' +
        'ADD COLUMN \`email\` VARCHAR(50) DEFAULT NULL, ' +
        'ADD COLUMN \`avatar\` VARCHAR(200) DEFAULT NULL'
    );
  },
  down: (queryInterface) => queryInterface.sequelize.query('select 1'),
};`,
  };
  const { tables, warnings } = parse(files);
  // The columns after the semicolon-bearing comment are the ones a naive split loses.
  assert.deepEqual(tables[0].columns.map((c) => c.name), ["id", "status", "email", "avatar"]);
  assert.equal(col(tables[0].columns, "avatar")?.type, "VARCHAR(200)");
  assert.deepEqual(warnings.filter((w) => w.kind === "unapplied-raw-statement"), []);
});

test("a commented-out createTable example never becomes a table", () => {
  // Sequelize's generated migration skeleton, verbatim in shape: the example is commentary, not schema.
  const files = {
    "20200101-a.js": `'use strict';
module.exports = {
  up: (queryInterface, Sequelize) => {
    /*
      Add altering commands here.
      Example:
      return queryInterface.createTable('users', { id: Sequelize.INTEGER });
    */
    // queryInterface.createTable('line_comment_ghost', { id: Sequelize.INTEGER });
    return queryInterface.createTable('real', {
      id: { type: Sequelize.INTEGER },
      site: { type: Sequelize.STRING, defaultValue: 'http://example.com' },
    });
  },
  down: (queryInterface) => queryInterface.dropTable('real'),
};`,
  };
  const { tables } = parse(files);
  assert.deepEqual(tables.map((t) => t.name), ["real"]);
  // The masker skips string literals BEFORE looking for comments, so a URL's `//` stays code.
  assert.deepEqual(tables[0].columns.map((c) => c.name), ["id", "site"]);
  assert.equal(col(tables[0].columns, "site")?.default, "'http://example.com'");
});

test("a FOREIGN KEY in raw CREATE TABLE becomes a relationship that follows renames and dies with the table", () => {
  const create = `module.exports = { up: (q) => q.sequelize.query('CREATE TABLE \`orders\` (\`id\` bigint NOT NULL, \`user_id\` bigint NOT NULL, CONSTRAINT \`fk_u\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`))'), down: (q) => q.sequelize.query('select 1') };`;

  const created = parse({ "20200101-a.js": create });
  assert.equal(created.relationships.length, 1);
  assert.equal(created.relationships[0].kind, "belongs-to");
  assert.equal(created.relationships[0].fromTable, "orders");
  assert.deepEqual(created.relationships[0].fromColumns, ["user_id"]);
  assert.equal(created.relationships[0].toTable, "users");

  const renamed = parse({
    "20200101-a.js": create,
    "20200102-b.js": `module.exports = { up: (q) => q.sequelize.query('rename table orders to sales'), down: (q) => q.sequelize.query('select 1') };`,
  });
  assert.equal(renamed.relationships[0].fromTable, "sales"); // carried forward, not left dangling

  const dropped = parse({
    "20200101-a.js": create,
    "20200102-b.js": `module.exports = { up: (q) => q.sequelize.query('DROP TABLE orders'), down: (q) => q.sequelize.query('select 1') };`,
  });
  assert.deepEqual(dropped.tables, []);
  assert.deepEqual(dropped.relationships, []); // a relationship out of a table that no longer exists
});

test("addIndex records a unique index as a UniqueKey and ignores a non-unique index", () => {
  const files = {
    "20200101-a.js": `module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.createTable('t', { a: { type: Sequelize.INTEGER }, b: { type: Sequelize.INTEGER } }).then(() => {
      queryInterface.addIndex('t', ['a', 'b'], { unique: true, name: 'uq_ab' });
      queryInterface.addIndex('t', ['b']);
    });
  },
  down: (q) => q.dropTable('t'),
};`,
  };
  const { tables } = parse(files);
  assert.deepEqual(tables[0].uniqueKeys, [{ name: "uq_ab", columns: ["a", "b"] }]);
});
