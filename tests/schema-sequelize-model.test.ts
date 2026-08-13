import test from "node:test";
import assert from "node:assert/strict";
import { sequelizeModelParser } from "../src/schema/parsers/sequelize-model.ts";
import type { ColumnSchema, RelationshipSchema } from "../src/schema/types.ts";

function parse(files: Record<string, string>) {
  return sequelizeModelParser.parse(Object.keys(files), (p) => {
    const c = files[p];
    if (c === undefined) throw new Error(`no such fixture: ${p}`);
    return c;
  });
}

function col(columns: ColumnSchema[], name: string): ColumnSchema | undefined {
  return columns.find((c) => c.name === name);
}

function rel(rels: RelationshipSchema[], kind: string, to: string): RelationshipSchema | undefined {
  return rels.find((r) => r.kind === kind && r.toTable === to);
}

test("define(name, fields, { tableName }) recovers columns and the explicit physical table name", () => {
  const files = {
    "leave.js": `'use strict';
module.exports = (sequelize, DataTypes) => {
  const leave = sequelize.define(
    'leave',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      user_id: DataTypes.BIGINT,
      comments: DataTypes.TEXT,
    },
    { tableName: 'wcp_leave', timestamps: false, underscored: true }
  );
  return leave;
};`,
  };
  const { tables, warnings } = parse(files);
  assert.equal(warnings.length, 0);
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.equal(t.name, "wcp_leave"); // physical name from the explicit tableName option, not the model name
  assert.deepEqual(t.columns.map((c) => c.name), ["id", "user_id", "comments"]);
  assert.equal(col(t.columns, "id")?.type, "BIGINT");
  assert.equal(col(t.columns, "id")?.typeVocabulary, "sequelize");
  assert.equal(col(t.columns, "id")?.inPrimaryKey, true);
  assert.equal(col(t.columns, "user_id")?.type, "BIGINT"); // shorthand `col: DataTypes.BIGINT`
  assert.deepEqual(t.declarations, [{ sourceId: "sequelize-model", file: "leave.js", line: 3, symbol: "leave" }]);
});

test("a model with no explicit tableName is skipped with a warning — the physical name is not guessed", () => {
  const files = {
    "thing.js": `module.exports = (sequelize, DataTypes) => sequelize.define('thing', { id: DataTypes.INTEGER });`,
  };
  const { tables, warnings } = parse(files);
  assert.equal(tables.length, 0);
  assert.equal(warnings.filter((w) => w.kind === "model-no-tablename").length, 1);
});

test("associate(): the four association kinds resolve models.X to physical tables via the two-pass map", () => {
  const files = {
    "office.js": `module.exports = (s, D) => s.define('office', { id: D.INTEGER }, { tableName: 'wcp_office' });`,
    "link.js": `module.exports = (s, D) => s.define('link', { id: D.INTEGER }, { tableName: 'wcp_link' });`,
    "primary.js": `module.exports = (s, D) => s.define('primary', { id: D.INTEGER }, { tableName: 'wcp_primary' });`,
    "user.js": `module.exports = (sequelize, DataTypes) => {
  const user = sequelize.define('user', { id: DataTypes.INTEGER, office: DataTypes.INTEGER }, { tableName: 'wcp_user' });
  user.associate = function(models) {
    user.belongsTo(models.office, { as: 'user_office', foreignKey: 'office', targetKey: 'id' });
    user.hasMany(models.link, { as: 'links', sourceKey: 'id', foreignKey: 'user_id' });
    user.hasOne(models.primary, { as: 'pp', sourceKey: 'id', foreignKey: 'user_id' });
  };
  return user;
};`,
  };
  const { relationships, warnings } = parse(files);
  assert.equal(warnings.length, 0);

  const bt = rel(relationships, "belongs-to", "wcp_office")!;
  assert.equal(bt.fromTable, "wcp_user");
  assert.deepEqual(bt.fromColumns, ["office"]); // belongsTo → FK on the source side
  assert.deepEqual(bt.toColumns, ["id"]); // targetKey → target side

  const hm = rel(relationships, "has-many", "wcp_link")!;
  assert.deepEqual(hm.fromColumns, ["id"]); // hasMany → sourceKey on source
  assert.deepEqual(hm.toColumns, ["user_id"]); // FK lives on the target

  const ho = rel(relationships, "has-one", "wcp_primary")!;
  assert.deepEqual(ho.toColumns, ["user_id"]);
});

test("belongsToMany resolves `through: models.X` to X's physical table name as the join table", () => {
  const files = {
    "title.js": `module.exports = (s, D) => s.define('jobTitle', { id: D.INTEGER }, { tableName: 'wcp_title' });`,
    "join.js": `module.exports = (s, D) => s.define('userTitle', { id: D.INTEGER }, { tableName: 'wcp_user_title' });`,
    "user.js": `module.exports = (sequelize, DataTypes) => {
  const user = sequelize.define('user', { id: DataTypes.INTEGER }, { tableName: 'wcp_user' });
  user.associate = function(models) {
    user.belongsToMany(models.jobTitle, { through: models.userTitle, as: 'titles', foreignKey: 'user_id', otherKey: 'title_id' });
  };
  return user;
};`,
  };
  const { relationships } = parse(files);
  const m2m = rel(relationships, "many-to-many", "wcp_title")!;
  assert.equal(m2m.fromTable, "wcp_user");
  assert.equal(m2m.joinTable, "wcp_user_title"); // through model resolved to its physical table
  assert.deepEqual(m2m.fromColumns, ["user_id"]);
  assert.deepEqual(m2m.toColumns, ["title_id"]);
});

test("an association whose target model has no known tableName keeps the model name and warns", () => {
  const files = {
    "user.js": `module.exports = (sequelize, DataTypes) => {
  const user = sequelize.define('user', { id: DataTypes.INTEGER }, { tableName: 'wcp_user' });
  user.associate = function(models) {
    user.belongsTo(models.ghost, { foreignKey: 'ghost_id' });
  };
  return user;
};`,
  };
  const { relationships, warnings } = parse(files);
  const r = relationships[0];
  assert.equal(r.toTable, "ghost"); // unresolved → kept verbatim, not fabricated
  assert.equal(warnings.filter((w) => w.kind === "model-assoc-unresolved").length, 1);
});
