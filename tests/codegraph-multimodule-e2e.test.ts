import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auditRun, prepareRun, searchSourceEvidence } from "../src/core/run.ts";
import type { ReportRequest } from "../src/core/types.ts";
import { createCodeGraphSchema, insertGraphFile, insertGraphNode, tempDir } from "./helpers.ts";

/**
 * A multi-module target whose per-module databases already exist on disk, so `prepare` resolves it
 * to a per-module map and stamps its snapshot identity from the module database paths. The snapshot
 * identity must round-trip: `source` and `audit` rebuild the snapshot after preparation and must
 * reproduce the exact same `codegraphDigest`, or the whole assurance chain breaks for multi-repo
 * targets. Regression guard for 57B-349 defect 1.
 */
async function multiModuleTarget(): Promise<string> {
  const target = await tempDir();
  const modules: Array<{ dir: string; file: string; symbol: string }> = [
    { dir: "service-a", file: "main.go", symbol: "CreateOrder" },
    { dir: "service-b", file: "client.go", symbol: "CreateOrder" }
  ];
  for (const module of modules) {
    const dir = join(target, module.dir);
    await mkdir(join(dir, ".codegraph"), { recursive: true });
    await writeFile(join(dir, "go.mod"), `module example.com/${module.dir}\n\ngo 1.22\n`);
    await writeFile(join(dir, module.file), `package main\n\nfunc ${module.symbol}() {}\n`);
    // A per-module database with module-relative paths — exactly what `codegraph init .` produces.
    const db = createCodeGraphSchema(join(dir, ".codegraph", "codegraph.db"));
    insertGraphFile(db, module.file, 1, "go");
    insertGraphNode(db, { id: "n1", kind: "function", name: module.symbol, filePath: module.file, startLine: 3, endLine: 3 }, "go");
    db.close();
  }
  return target;
}

function request(target: string, workdir: string): ReportRequest {
  return {
    target,
    codegraphMode: "auto",
    language: "zh-CN",
    detailLevel: "standard",
    workdir,
    overviewAudiences: ["product"],
    features: [],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  };
}

test("a multi-module run resolves per-module graphs and stamps a non-null snapshot identity", async () => {
  const target = await multiModuleTarget();
  const workdir = await tempDir();
  const { manifest } = await prepareRun(request(target, workdir));
  assert.equal(manifest.request.codegraph, undefined, "a multi-module run has no single database path");
  assert.equal(manifest.request.codegraphModules?.length, 2, "the resolved per-module database paths are persisted for reproduction");
  assert.ok(manifest.snapshot?.codegraphDigest, "the multi-module snapshot carries a CodeGraph identity");
});

test("a multi-module run's snapshot identity round-trips through source and audit", async () => {
  const target = await multiModuleTarget();
  const workdir = await tempDir();
  const { runDir } = await prepareRun(request(target, workdir));

  // `source` rebuilds the snapshot and throws if the identity does not reproduce.
  await assert.doesNotReject(
    () => searchSourceEvidence(runDir, ["CreateOrder"], "confirm the snapshot reproduces for a multi-module target", { maxResults: 5 }),
    "a multi-module source search must not see the snapshot as changed"
  );

  const audit = await auditRun(runDir);
  const snapshotFindings = audit.findings.filter((finding) => /source snapshot changed|CodeGraph identity changed/i.test(finding.message));
  assert.deepEqual(snapshotFindings, [], `the snapshot identity must reproduce, got: ${JSON.stringify(snapshotFindings)}`);
});
