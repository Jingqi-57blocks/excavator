import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";
import { discoverSchemaFormats } from "../src/schema/discover.ts";
import { loadManifest } from "../src/schema/manifest.ts";

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/** A synthetic multi-format target: gorm (+ a sibling const file), sequelize migration, sequelize
 *  model, SQL dump, and three report-only unsupported families. */
async function multiFormatTarget(): Promise<string> {
  const root = await tempDir("excavator-discover-");
  await write(root, "model/leave.go", 'package model\n\ntype Leave struct {\n  ID uint64 `gorm:"column:id;primaryKey"`\n}\n\nfunc (l Leave) TableName() string { return TableLeave }\n');
  await write(root, "model/consts.go", 'package model\n\nconst TableLeave = "wcp_leave"\n'); // no gorm tag, same dir → still in the gorm set
  await write(root, "migrations/001.js", "module.exports = { up: async (q, S) => { await q.createTable('billing', { id: { type: S.INTEGER } }); } };\n");
  await write(root, "models/account.js", "const { DataTypes } = require('sequelize');\nmodule.exports = (s) => s.define('Account', { email: { type: DataTypes.STRING } }, { tableName: 'accounts' });\n");
  await write(root, "sql/schema.sql", "CREATE TABLE `orders` (`id` bigint(20) NOT NULL, PRIMARY KEY (`id`));\n");
  await write(root, "prisma/schema.prisma", "model User { id Int @id }\n");
  await write(root, "entity/user.entity.ts", "@Entity()\nexport class User { id: number; }\n");
  await write(root, "app/models.py", "from django.db import models\nclass Thing(models.Model):\n  pass\n");
  await write(root, "db/schema.rb", "ActiveRecord::Schema.define do\nend\n");
  return root;
}

test("discovery fingerprints each supported format by signature, with the gorm dir set included", async () => {
  const { sources } = await discoverSchemaFormats(await multiFormatTarget());
  const byFormat = new Map(sources.map((s) => [s.format, s.files]));

  assert.deepEqual([...byFormat.keys()].sort(), ["gorm", "sequelize-migration", "sequelize-model", "sql-dump"]);
  // gorm: the tagged file AND the sibling const file (same directory) are both passed to the parser.
  assert.deepEqual(byFormat.get("gorm"), ["model/consts.go", "model/leave.go"]);
  assert.deepEqual(byFormat.get("sequelize-migration"), ["migrations/001.js"]);
  assert.deepEqual(byFormat.get("sequelize-model"), ["models/account.js"]);
  assert.deepEqual(byFormat.get("sql-dump"), ["sql/schema.sql"]);
});

test("discovery reports recognized-but-unsupported families honestly (Prisma / TypeORM / Django / ActiveRecord)", async () => {
  const { unsupported } = await discoverSchemaFormats(await multiFormatTarget());
  const formats = unsupported.map((u) => u.format).sort();
  assert.deepEqual(formats, ["ActiveRecord", "Django", "Prisma", "TypeORM"]);
  const prisma = unsupported.find((u) => u.format === "Prisma")!;
  assert.equal(prisma.evidence[0].file, "prisma/schema.prisma");
});

test("the gorm set pulls in typed-string-const files from a SEPARATE constant package", async () => {
  const root = await tempDir("excavator-discover-");
  // A model whose TableName() returns a const declared in another package/dir.
  await write(root, "internal/handlers/app/app.go", 'package app\n\ntype App struct {\n  ID uint64 `gorm:"column:id"`\n}\n\nfunc (a App) TableName() string { return constant.TbApp.String() }\n');
  await write(root, "internal/constant/table.go", 'package constant\n\ntype TableName string\n\nconst (\n  TbApp TableName = "app_application"\n)\n');
  const { sources } = await discoverSchemaFormats(root);
  const gorm = sources.find((s) => s.format === "gorm")!;
  // The separate constant/table.go is included so the parser can resolve the table name.
  assert.ok(gorm.files.includes("internal/constant/table.go"), `constant file missing: ${gorm.files.join(", ")}`);
  assert.ok(gorm.files.includes("internal/handlers/app/app.go"));
});

test("typed-string-const files are NOT emitted as a gorm source when there is no gorm-tagged file", async () => {
  const root = await tempDir("excavator-discover-");
  await write(root, "internal/constant/table.go", 'package constant\n\ntype TableName string\n\nconst (\n  TbApp TableName = "app_application"\n)\n');
  const { sources } = await discoverSchemaFormats(root);
  assert.equal(sources.find((s) => s.format === "gorm"), undefined);
});

test("a directory with no gorm-tagged file contributes no gorm source", async () => {
  const root = await tempDir("excavator-discover-");
  await write(root, "util/helper.go", "package util\nfunc Helper() {}\n"); // .go but no gorm tag
  const { sources } = await discoverSchemaFormats(root);
  assert.equal(sources.find((s) => s.format === "gorm"), undefined);
});

test("a manifest replaces auto-discovery and resolves globs", async () => {
  const root = await multiFormatTarget();
  const manifestPath = join(root, "locate.json");
  await writeFile(manifestPath, JSON.stringify({ sources: [{ format: "sql-dump", include: ["sql/*.sql"] }] }), "utf8");
  const { sources, unsupported } = await loadManifest(manifestPath, root);
  // Only the manifest's sources — gorm/sequelize are NOT auto-discovered when a manifest is supplied.
  assert.deepEqual(sources.map((s) => s.format), ["sql-dump"]);
  assert.deepEqual(sources[0].files, ["sql/schema.sql"]);
  assert.deepEqual(unsupported, []);
});

test("a manifest naming a format with no parser takes the honest unsupported path, not an error", async () => {
  const root = await multiFormatTarget();
  const manifestPath = join(root, "locate.json");
  await writeFile(manifestPath, JSON.stringify({ sources: [{ format: "prisma", include: ["prisma/schema.prisma"] }] }), "utf8");
  const { sources, unsupported } = await loadManifest(manifestPath, root);
  assert.deepEqual(sources, []);
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].format, "prisma");
  assert.deepEqual(unsupported[0].evidence.map((e) => e.file), ["prisma/schema.prisma"]);
});

test("a manifest referencing a non-existent file is rejected", async () => {
  const root = await multiFormatTarget();
  const manifestPath = join(root, "locate.json");
  await writeFile(manifestPath, JSON.stringify({ sources: [{ format: "sql-dump", include: ["sql/missing.sql"] }] }), "utf8");
  await assert.rejects(() => loadManifest(manifestPath, root), /does not exist/);
});

test("a malformed manifest is rejected with a clear message", async () => {
  const root = await tempDir("excavator-discover-");
  const manifestPath = join(root, "bad.json");
  await writeFile(manifestPath, JSON.stringify({ notSources: [] }), "utf8");
  await assert.rejects(() => loadManifest(manifestPath, root), /must be an object with a "sources" array/);
});
