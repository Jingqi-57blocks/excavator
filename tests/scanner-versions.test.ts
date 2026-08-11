import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CURRENT_SCANNER_VERSION, SCANNER_VERSION_V1, SCANNER_VERSION_V2, resolveScannerVersion } from "../src/scanner-versions.ts";
import { createSnapshot, scanFiles } from "../src/snapshot.ts";
import { tempDir } from "./helpers.ts";

// The frozen v1 boundary. This literal must never change: audit re-derives any v1 snapshot's identity
// from exactly this set, so drifting it would silently alter every historical v1 snapshot's id.
const V1_FROZEN = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".go", ".py", ".java", ".kt", ".kts", ".rb", ".php",
  ".cs", ".fs", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".swift", ".scala", ".vue", ".svelte", ".sql",
  ".yaml", ".yml", ".json", ".toml", ".xml", ".html", ".css", ".scss", ".md", ".sh", ".proto", ".graphql", ".gql", ".tf", ".hcl", ".astro"
];

test("v1 frozen extension set is pinned exactly", () => {
  assert.deepEqual([...resolveScannerVersion(SCANNER_VERSION_V1)].sort(), [...V1_FROZEN].sort());
  assert.equal(resolveScannerVersion(SCANNER_VERSION_V1).size, 44);
});

test("v2 is a strict monotone superset of v1", () => {
  const v1 = resolveScannerVersion(SCANNER_VERSION_V1);
  const v2 = resolveScannerVersion(SCANNER_VERSION_V2);
  for (const extension of v1) assert.ok(v2.has(extension), `v2 dropped a v1 extension: ${extension}`);
  assert.ok(v2.size > v1.size, "v2 must add extensions");
  assert.equal(v2.size, 70, "v2 = 44 (v1) + 26 new");
  // The current version is v2 and both markup and build classes are covered by class, not by vendor.
  assert.equal(CURRENT_SCANNER_VERSION, SCANNER_VERSION_V2);
  for (const extension of [".xaml", ".feature", ".csproj", ".plist", ".props", ".txt"]) assert.ok(v2.has(extension), `v2 must scan ${extension}`);
});

test("an unknown scanner version throws deterministically", () => {
  assert.throws(() => resolveScannerVersion("git-aware-source-boundary-v999"), /Unknown scanner version/);
});

test("a v2-only file is scanned under v2, excluded under v1, and each version is idempotent", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "app.ts"), "export const x = 1;\n");
  await writeFile(join(dir, "src", "View.xaml"), "<Label x:Class=\"App.View\"/>\n");
  await writeFile(join(dir, "src", "Login.feature"), "Feature: Login\nScenario: sign in\n");

  const v1Files = (await scanFiles(dir, 100_000, SCANNER_VERSION_V1)).map((file) => file.relativePath).sort();
  const v2Files = (await scanFiles(dir, 100_000, SCANNER_VERSION_V2)).map((file) => file.relativePath).sort();
  assert.deepEqual(v1Files, ["src/app.ts"], "v1 scans only the .ts");
  assert.deepEqual(v2Files, ["src/Login.feature", "src/View.xaml", "src/app.ts"].sort(), "v2 scans .ts, .xaml and .feature");

  const v1a = await createSnapshot(dir, undefined, 100_000, SCANNER_VERSION_V1);
  const v1b = await createSnapshot(dir, undefined, 100_000, SCANNER_VERSION_V1);
  const v2a = await createSnapshot(dir, undefined, 100_000, SCANNER_VERSION_V2);
  const v2b = await createSnapshot(dir, undefined, 100_000, SCANNER_VERSION_V2);
  assert.equal(v1a.snapshot.id, v1b.snapshot.id, "v1 re-derivation is idempotent");
  assert.equal(v2a.snapshot.id, v2b.snapshot.id, "v2 re-derivation is idempotent");
  assert.notEqual(v1a.snapshot.id, v2a.snapshot.id, "different versions produce different snapshot identities");
});
