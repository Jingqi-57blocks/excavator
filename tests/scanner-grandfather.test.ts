import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReportRequest, RunManifest, SearchReceiptCorpus } from "../src/types.ts";
import { auditRun, prepareRun, searchSourceEvidence } from "../src/run.ts";
import { createSnapshot } from "../src/snapshot.ts";
import { SCANNER_VERSION_V1 } from "../src/scanner-versions.ts";
import { tempDir } from "./helpers.ts";

// A target that separates the two boundaries: a .ts (scanned by both v1 and v2) and a .xaml (scanned
// only by v2). So v1 and v2 produce genuinely different manifests — and different snapshot identities.
async function targetWithMixedBoundary(): Promise<string> {
  const target = await tempDir();
  await mkdir(join(target, "src"), { recursive: true });
  await writeFile(join(target, "src", "app.ts"), "export const app = 1;\n");
  await writeFile(join(target, "src", "MainPage.xaml"), "<ContentPage x:Class=\"App.MainPage\"/>\n");
  return target;
}

function request(target: string, workdir: string): ReportRequest {
  return {
    target, workdir, language: "zh-CN", detailLevel: "standard",
    overviewAudiences: ["engineering"],
    features: [],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 20, maxSourceWindows: 20, maxSourceCharacters: 60_000, maxFiles: 10_000, maxFeatureNodes: 20, maxExpansionDepth: 2 }
  };
}

/** Rewrite a prepared run so its recorded snapshot is the one an older (v1) scanner would have made. */
async function stampV1Snapshot(runDir: string, target: string, maxFiles: number): Promise<{ v1Id: string; v2DefaultId: string }> {
  const runPath = join(runDir, "run.json");
  const manifest = JSON.parse(await readFile(runPath, "utf8")) as RunManifest;
  const v1 = await createSnapshot(target, undefined, maxFiles, SCANNER_VERSION_V1);
  const v2Default = await createSnapshot(target, undefined, maxFiles); // what current code would derive
  manifest.snapshot = v1.snapshot;
  await writeFile(runPath, JSON.stringify(manifest, null, 2));
  await writeFile(join(runDir, "snapshot.json"), JSON.stringify(v1.snapshot, null, 2));
  return { v1Id: v1.snapshot.id, v2DefaultId: v2Default.snapshot.id };
}

test("audit re-derives a v1 run under v1 semantics and does not report a snapshot change", async () => {
  const target = await targetWithMixedBoundary();
  const workdir = await tempDir();
  const { runDir } = await prepareRun(request(target, workdir));
  const { v1Id, v2DefaultId } = await stampV1Snapshot(runDir, target, 10_000);

  // Sanity: current code, using the current default (v2), would derive a *different* id — so the only
  // thing saving the audit from a false "snapshot changed" is re-deriving under the recorded version.
  assert.notEqual(v1Id, v2DefaultId, "the mixed-boundary target must have distinct v1 and v2 identities");

  const { findings } = await auditRun(runDir);
  assert.ok(!findings.some((f) => f.message.includes("source snapshot changed")), "a v1 run must not be reported as changed under a widened current boundary");
  assert.ok(!findings.some((f) => f.message.includes("could not be re-derived")), "the recorded v1 version must resolve");
});

test("audit still catches genuine source drift under the recorded v1 semantics", async () => {
  const target = await targetWithMixedBoundary();
  const workdir = await tempDir();
  const { runDir } = await prepareRun(request(target, workdir));
  await stampV1Snapshot(runDir, target, 10_000);

  // Add a file the v1 boundary *does* scan, changing the v1 manifest after the snapshot was recorded.
  await writeFile(join(target, "src", "extra.ts"), "export const extra = 2;\n");
  const { findings } = await auditRun(runDir);
  assert.ok(findings.some((f) => f.level === "error" && f.message.includes("source snapshot changed")), "real drift under v1 semantics must still be caught");
});

test("search re-derives a v1 run's corpus under the recorded v1 semantics", async () => {
  const target = await targetWithMixedBoundary();
  const workdir = await tempDir();
  const { runDir } = await prepareRun(request(target, workdir));
  await stampV1Snapshot(runDir, target, 10_000);

  // The search path must rebuild the corpus under the run's *recorded* scanner version, not the current
  // default. Under v1 the .xaml is outside the corpus, so the receipt's corpus block must report it as
  // unscanned text and carry the v1 version. Reverting the recorded-version argument on the search path
  // would otherwise regress silently — the audit tests never exercise the search path.
  const receipt = await searchSourceEvidence(runDir, ["ContentPage"], "s0b: v1 search grandfather", {});
  const corpus = receipt.corpus as SearchReceiptCorpus;
  assert.equal(corpus.scannerVersion, SCANNER_VERSION_V1);
  assert.deepEqual(corpus.unscannedTextExtensions, { ".xaml": 1 });
});
