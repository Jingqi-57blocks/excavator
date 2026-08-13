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
