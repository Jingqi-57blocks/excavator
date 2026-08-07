import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectModules, discoverModules, findModuleMarkers, moduleForFile } from "../src/module-detection.ts";
import { tempDir } from "./helpers.ts";

test("two go.mod subdirectories are detected as two separate modules", () => {
  const modules = detectModules(["service-a/go.mod", "service-b/go.mod"]);
  assert.deepEqual(modules.map((module) => module.dir), ["service-a", "service-b"]);
  assert.deepEqual(modules.map((module) => module.id), ["service-a", "service-b"]);
});

test("a package.json workspace splits into its individual packages, not the workspace root", () => {
  const modules = detectModules(["package.json", "packages/a/package.json", "packages/b/package.json"]);
  // The workspace root is an ancestor of its packages, so it is not built as its own graph; the two
  // leaf packages are the modules. Building the root would re-merge the packages into one graph.
  assert.deepEqual(modules.map((module) => module.dir), ["packages/a", "packages/b"]);
});

test("go.mod and package.json markers are recognized side by side", () => {
  const modules = detectModules(["api/go.mod", "web/package.json"]);
  assert.deepEqual(modules.map((module) => module.dir), ["api", "web"]);
});

test("a marker-less multi-directory tree is never split (the openmrs / Maven-reactor guardrail)", () => {
  // Multiple modules, real inter-module dependencies, but no go.mod / package.json. Directory-splitting
  // here would drop real cross-module edges, so detection must keep it a single graph.
  const modules = detectModules(["pom.xml", "api/pom.xml", "web/pom.xml", "common/pom.xml"]);
  assert.deepEqual(modules, []);
});

test("a single module marker keeps the single-graph behavior", () => {
  assert.deepEqual(detectModules(["package.json"]), []);
  assert.deepEqual(detectModules(["go.mod", "internal/thing.go"]), []);
});

test("moduleForFile assigns a file to its nearest-ancestor module", () => {
  const modules = detectModules(["packages/a/package.json", "packages/b/package.json"]);
  assert.equal(moduleForFile(modules, "packages/a/src/index.ts")?.dir, "packages/a");
  assert.equal(moduleForFile(modules, "packages/b/lib/client.ts")?.dir, "packages/b");
  // A file outside every module belongs to none (it falls to source, not to a graph).
  assert.equal(moduleForFile(modules, "tools/build.ts"), undefined);
});

test("a marker directory that contains another module is not built as its own graph (leaf modules only)", () => {
  const modules = detectModules(["services/api/go.mod", "services/api/vendorlib/go.mod", "services/web/go.mod"]);
  // services/api is an ancestor of services/api/vendorlib, so building it would re-merge the nested
  // module. Only the leaf modules get their own graph; services/api's own files fall to source.
  assert.deepEqual(modules.map((module) => module.dir), ["services/api/vendorlib", "services/web"]);
  assert.equal(moduleForFile(modules, "services/api/vendorlib/x.go")?.dir, "services/api/vendorlib");
  assert.equal(moduleForFile(modules, "services/web/main.go")?.dir, "services/web");
  assert.equal(moduleForFile(modules, "services/api/main.go"), undefined);
});

test("findModuleMarkers walks the tree and ignores dependency and build noise", async () => {
  const target = await tempDir();
  await mkdir(join(target, "service-a"), { recursive: true });
  await mkdir(join(target, "service-b"), { recursive: true });
  await mkdir(join(target, "node_modules", "leftpad"), { recursive: true });
  await writeFile(join(target, "service-a", "go.mod"), "module a\n");
  await writeFile(join(target, "service-b", "go.mod"), "module b\n");
  await writeFile(join(target, "node_modules", "leftpad", "package.json"), "{}\n");

  const markers = await findModuleMarkers(target);
  assert.deepEqual(markers, ["service-a/go.mod", "service-b/go.mod"]);
  const modules = await discoverModules(target);
  assert.deepEqual(modules.map((module) => module.dir), ["service-a", "service-b"]);
});

test("discoverModules leaves a marker-less multi-module workspace unsplit on disk", async () => {
  const target = await tempDir();
  for (const name of ["api", "web", "common"]) {
    await mkdir(join(target, name), { recursive: true });
    await writeFile(join(target, name, "pom.xml"), "<project/>\n");
  }
  await writeFile(join(target, "pom.xml"), "<project/>\n");
  assert.deepEqual(await discoverModules(target), []);
});
