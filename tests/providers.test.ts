import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildContexts } from "../src/context/context.ts";
import { buildCodeGraph, codeGraphStatus } from "../src/codegraph/codegraph-command.ts";
import type { ReportRequest } from "../src/core/types.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

function request(target: string, workdir: string, overrides: Partial<ReportRequest> = {}): ReportRequest {
  return {
    target,
    language: "en-US",
    workdir,
    overviewAudiences: ["product"],
    features: [],
    codegraphMode: "auto",
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 30, maxSourceWindows: 30, maxSourceCharacters: 80_000, maxFiles: 10_000, maxFeatureNodes: 60, maxExpansionDepth: 2 },
    ...overrides
  };
}

test("auto mode discovers a target-local CodeGraph database without an explicit path", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const graphDir = join(target, ".codegraph");
  await mkdir(graphDir);
  createCodeGraphFixture(join(graphDir, "codegraph.db"));
  const result = await buildContexts(request(target, workdir));
  assert.equal(result.stats.codegraphSource, "auto");
  assert.equal(result.stats.codegraphPath, join(target, ".codegraph", "codegraph.db"));
  assert.ok(result.stats.graphQueries > 0);
});

test("off mode ignores an available target-local CodeGraph database", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const graphDir = join(target, ".codegraph");
  await mkdir(graphDir);
  createCodeGraphFixture(join(graphDir, "codegraph.db"));
  const result = await buildContexts(request(target, workdir, { codegraphMode: "off" }));
  assert.equal(result.stats.codegraphSource, "disabled");
  assert.equal(result.stats.codegraphPath, undefined);
  assert.equal(result.stats.graphQueries, 0);
  assert.ok(result.stats.warnings.some((warning) => /disabled/i.test(warning)));
});

test("codegraph build invokes an already-installed CLI and does not install it", async () => {
  const target = await copyFixture();
  const binDir = await tempDir();
  const binary = join(binDir, "fake-codegraph");
  const log = join(binDir, "calls.log");
  await writeFile(binary, `#!/usr/bin/env node\nconst fs=require('fs'); const path=require('path'); const args=process.argv.slice(2); fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(args)); const target=args[1]; fs.mkdirSync(path.join(target,'.codegraph'),{recursive:true}); fs.writeFileSync(path.join(target,'.codegraph','codegraph.db'),'fixture');\n`);
  await chmod(binary, 0o755);
  const result = await buildCodeGraph({ target, binary, quiet: true });
  assert.equal(result.database, join(target, ".codegraph", "codegraph.db"));
  // `init` indexes by default and rejects --quiet, so neither flag may be passed to it.
  assert.deepEqual(JSON.parse(await readFile(log, "utf8")), ["init", target]);

  // The target is initialized now, so a refresh rebuilds through `index`, which accepts --quiet.
  await buildCodeGraph({ target, binary, quiet: true });
  assert.deepEqual(JSON.parse(await readFile(log, "utf8")), ["index", target, "--quiet"]);

  await buildCodeGraph({ target, binary });
  assert.deepEqual(JSON.parse(await readFile(log, "utf8")), ["index", target]);

  await buildCodeGraph({ target, binary, force: true, quiet: true });
  assert.deepEqual(JSON.parse(await readFile(log, "utf8")), ["index", target, "--force", "--quiet"]);
});

test("codegraph status reports missing CLI and official installation choices without installing", async () => {
  const target = await copyFixture();
  const status = await codeGraphStatus(target, join(target, "missing-codegraph"));
  assert.equal(status.installed, false);
  assert.equal(status.database.exists, false);
  assert.match(status.install.npm, /@colbymchenry\/codegraph/);
  await assert.rejects(() => buildCodeGraph({ target, binary: join(target, "missing-codegraph") }), /Install it separately/);
});
