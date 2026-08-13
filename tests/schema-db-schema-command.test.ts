import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tempDir } from "./helpers.ts";
import { runDbSchema } from "../src/schema/db-schema-command.ts";
import { exists } from "../src/core/util.ts";

async function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/cli.ts", ...args], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((done) => child.once("exit", done));
  return { code, stdout, stderr };
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/** A tiny multi-format target: a SQL dump plus a gorm model with a relationship. */
async function tinyTarget(): Promise<string> {
  const root = await tempDir("excavator-dbschema-");
  await write(root, "sql/schema.sql", "CREATE TABLE `orders` (`id` bigint(20) NOT NULL AUTO_INCREMENT, `total` int NOT NULL, PRIMARY KEY (`id`));\n");
  await write(root, "model/user.go", 'package model\n\ntype User struct {\n  ID uint64 `gorm:"column:id;primaryKey"`\n  Bio string\n}\n\nfunc (u User) TableName() string { return "users" }\n');
  return root;
}

test("db-schema runs end-to-end and writes database-design.md and db-schema.json", async () => {
  const target = await tinyTarget();
  const out = await tempDir("excavator-dbschema-out-");
  const result = await runDbSchema({ target, out, language: "en-US" });

  assert.ok(await exists(result.markdownPath));
  assert.ok(await exists(result.jsonPath));
  assert.equal(result.markdownPath, join(out, "database-design.md"));
  assert.equal(result.jsonPath, join(out, "db-schema.json"));

  assert.equal(result.tables, 2); // orders + users
  assert.deepEqual(result.perFormat, { gorm: 1, "sql-dump": 1 });

  const md = await readFile(result.markdownPath, "utf8");
  assert.match(md, /### orders/);
  assert.match(md, /### users/);
  assert.match(md, /bio\*/); // Bio → snake_case name-derived column

  const json = JSON.parse(await readFile(result.jsonPath, "utf8"));
  assert.equal(json.tables.length, 2);
});

test("db-schema output is byte-identical on a second run (deterministic artifacts)", async () => {
  const target = await tinyTarget();
  const outA = await tempDir("excavator-dbschema-a-");
  const outB = await tempDir("excavator-dbschema-b-");
  await runDbSchema({ target, out: outA, language: "en-US" });
  await runDbSchema({ target, out: outB, language: "en-US" });
  assert.equal(await readFile(join(outA, "database-design.md"), "utf8"), await readFile(join(outB, "database-design.md"), "utf8"));
  assert.equal(await readFile(join(outA, "db-schema.json"), "utf8"), await readFile(join(outB, "db-schema.json"), "utf8"));
});

test("db-schema rejects an unsupported --language", async () => {
  const target = await tinyTarget();
  const out = await tempDir("excavator-dbschema-out-");
  await assert.rejects(() => runDbSchema({ target, out, language: "fr-FR" }), /Unsupported --language/);
});

test("db-schema is exposed in the CLI help and its own --help entry", async () => {
  const top = await cli(["--help"]);
  assert.match(top.stdout, /db-schema/);
  const own = await cli(["db-schema", "--help"]);
  assert.equal(own.code, 0);
  assert.match(own.stdout, /Excavator db-schema/);
  assert.match(own.stdout, /--descriptions/);
});

test("db-schema CLI end-to-end prints a summary and writes both artifacts", async () => {
  const target = await tinyTarget();
  const out = await tempDir("excavator-dbschema-cli-");
  const run = await cli(["db-schema", "--target", target, "--out", out, "--language", "en-US"]);
  assert.equal(run.code, 0);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.tables, 2);
  assert.ok(await exists(join(out, "database-design.md")));
  assert.ok(await exists(join(out, "db-schema.json")));
});
