import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCodeGraph } from "../src/codegraph-command.ts";
import { resolveCodeGraphDatabase } from "../src/providers.ts";
import { tempDir } from "./helpers.ts";

/** A fake CodeGraph CLI that logs each invocation's cwd + args and writes a database for its target. */
async function fakeBinary(binDir: string, log: string): Promise<string> {
  const binary = join(binDir, "fake-codegraph");
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
const dir = path.resolve(args[1]);
fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), 'fixture');
`);
  await chmod(binary, 0o755);
  return binary;
}

async function readCalls(log: string): Promise<Array<{ cwd: string; args: string[] }>> {
  return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a two-module target builds one isolated graph per module directory", async () => {
  const target = await tempDir();
  const binDir = await tempDir();
  const log = join(binDir, "calls.log");
  for (const name of ["service-a", "service-b"]) {
    await mkdir(join(target, name), { recursive: true });
    await writeFile(join(target, name, "go.mod"), `module example.com/${name}\n\ngo 1.22\n`);
    await writeFile(join(target, name, "main.go"), "package main\n");
  }
  const binary = await fakeBinary(binDir, log);

  const result = await buildCodeGraph({ target, binary });
  assert.ok("modules" in result, "a multi-module target returns per-module build results");
  assert.deepEqual(result.modules.map((module) => module.dir), ["service-a", "service-b"]);
  assert.deepEqual(result.databases, [
    join(target, "service-a", ".codegraph", "codegraph.db"),
    join(target, "service-b", ".codegraph", "codegraph.db")
  ]);

  const calls = await readCalls(log);
  const realTarget = await realpath(target);
  // Isolation: each module is indexed with `.` from inside its own directory, never rebuilt from an
  // ancestor (which would produce a single merged graph and the cross-module false edges).
  assert.deepEqual(calls.map((call) => call.args), [["init", "."], ["init", "."]]);
  assert.deepEqual(calls.map((call) => call.cwd), [join(realTarget, "service-a"), join(realTarget, "service-b")]);
});

test("a marker-less multi-directory target still builds a single graph at the root", async () => {
  const target = await tempDir();
  const binDir = await tempDir();
  const log = join(binDir, "calls.log");
  for (const name of ["api", "web", "common"]) {
    await mkdir(join(target, name), { recursive: true });
    await writeFile(join(target, name, "pom.xml"), "<project/>\n");
  }
  await writeFile(join(target, "pom.xml"), "<project/>\n");
  const binary = await fakeBinary(binDir, log);

  const result = await buildCodeGraph({ target, binary });
  assert.ok("database" in result, "a marker-less target keeps the single-graph build");
  assert.equal(result.database, join(target, ".codegraph", "codegraph.db"));
  const calls = await readCalls(log);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["init", target]);
  assert.equal(calls[0].cwd, await realpath(target));
});

test("resolution returns a per-module map once each module carries a built database", async () => {
  const target = await tempDir();
  const binDir = await tempDir();
  const log = join(binDir, "calls.log");
  for (const name of ["service-a", "service-b"]) {
    await mkdir(join(target, name), { recursive: true });
    await writeFile(join(target, name, "go.mod"), `module example.com/${name}\n\ngo 1.22\n`);
  }
  const binary = await fakeBinary(binDir, log);

  // Before building, no per-module database exists and no root database exists: unavailable.
  assert.equal((await resolveCodeGraphDatabase(target)).source, "unavailable");

  await buildCodeGraph({ target, binary });
  const resolution = await resolveCodeGraphDatabase(target);
  assert.equal(resolution.source, "auto");
  assert.equal(resolution.path, undefined, "a multi-module resolution has no single path");
  assert.deepEqual(resolution.modules?.map((module) => module.dir), ["service-a", "service-b"]);
  for (const module of resolution.modules ?? []) {
    assert.equal(module.path, join(target, module.dir, ".codegraph", "codegraph.db"));
  }
});

test("a single-module target resolves to its one root database, unchanged", async () => {
  const target = await tempDir();
  const binDir = await tempDir();
  const log = join(binDir, "calls.log");
  await writeFile(join(target, "package.json"), JSON.stringify({ name: "solo" }));
  await writeFile(join(target, "index.js"), "module.exports = 1;\n");
  const binary = await fakeBinary(binDir, log);

  const built = await buildCodeGraph({ target, binary });
  assert.ok("database" in built);
  const resolution = await resolveCodeGraphDatabase(target);
  assert.equal(resolution.source, "auto");
  assert.equal(resolution.modules, undefined, "a single module is never split");
  assert.equal(resolution.path, join(target, ".codegraph", "codegraph.db"));
});
