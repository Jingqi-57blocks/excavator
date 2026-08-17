import test from "node:test";
import assert from "node:assert/strict";
import {
  auditLayerOrder, buildImportGraph, extractRelativeSpecifiers, stronglyConnectedComponents,
  type RegistryEntry
} from "./layer-order-check.ts";
import { LAYERING_REGISTRY } from "./layering-registry.ts";
import { loadSourceFiles } from "./layer-order-sources.ts";

// The layer-order gate (docs/layering.md §二) plus the negative fixtures that prove it can go RED.
//
// A checker that only ever goes green is worse than none: it certifies whatever it is pointed at. So every
// check below is exercised twice — once against the real `src/**`, once against a synthetic file set built to
// violate exactly that check. The synthetic sets go through the SAME pure functions the real audit uses.

/** A minimal well-layered set: base <- L1 <- L3, no cycle, everything registered. */
const CLEAN_FILES = new Map<string, string>([
  ["src/base/util.ts", "export const x = 1;\n"],
  ["src/snapshot/scan.ts", 'import { x } from "../base/util.ts";\nexport const scan = x;\n'],
  ["src/facts/graph.ts", 'import { scan } from "../snapshot/scan.ts";\nexport const g = scan;\n']
]);

const CLEAN_REGISTRY: readonly RegistryEntry[] = [
  { dir: "src/base", layer: "base" },
  { dir: "src/snapshot", layer: "L1" },
  { dir: "src/facts", layer: "L3" }
];

test("a well-layered synthetic tree produces no violation at all", () => {
  const audit = auditLayerOrder(CLEAN_FILES, CLEAN_REGISTRY);
  assert.deepEqual(audit.instrumentFailures, []);
  assert.deepEqual(audit.registryViolations, []);
  assert.deepEqual(audit.upwardEdges, []);
  assert.deepEqual(audit.cycles, []);
  assert.equal(audit.nodeCount, 3);
  assert.equal(audit.edgeCount, 2);
});

test("negative fixture: an upward edge is reported with both layers named", () => {
  const files = new Map(CLEAN_FILES);
  files.set("src/base/util.ts", 'import { scan } from "../snapshot/scan.ts";\nexport const x = scan;\n');
  const audit = auditLayerOrder(files, CLEAN_REGISTRY);
  assert.deepEqual(audit.upwardEdges, ["src/base/util.ts (base) -> src/snapshot/scan.ts (L1)"]);
});

test("negative fixture: an upward edge introduced only by `import type` still counts", () => {
  const files = new Map(CLEAN_FILES);
  files.set("src/base/util.ts", 'import type { Scan } from "../facts/graph.ts";\nexport type X = Scan;\n');
  const audit = auditLayerOrder(files, CLEAN_REGISTRY);
  assert.deepEqual(audit.upwardEdges, ["src/base/util.ts (base) -> src/facts/graph.ts (L3)"]);
});

test("negative fixture: a two-file cycle fails even though both files are correctly registered", () => {
  const files = new Map<string, string>([
    ["src/facts/a.ts", 'import type { B } from "./b.ts";\nexport type A = B;\n'],
    ["src/facts/b.ts", 'import type { A } from "./a.ts";\nexport type B = A | null;\n']
  ]);
  const audit = auditLayerOrder(files, [{ dir: "src/facts", layer: "L3" }]);
  assert.deepEqual(audit.upwardEdges, [], "both files are the same layer, so there is no upward edge to find");
  assert.deepEqual(audit.cycles, ["cycle [2]: src/facts/a.ts, src/facts/b.ts"]);
});

test("negative fixture: a longer cycle is reported as one component, not as N edges", () => {
  const files = new Map<string, string>([
    ["src/facts/a.ts", 'import "./b.ts";\nimport { c } from "./c.ts";\nexport const a = c;\n'],
    ["src/facts/b.ts", 'import { c } from "./c.ts";\nexport const b = c;\n'],
    ["src/facts/c.ts", 'import type { A } from "./a.ts";\nexport const c: A | null = null;\n'],
    ["src/facts/lone.ts", "export const lone = 1;\n"]
  ]);
  const components = stronglyConnectedComponents(buildImportGraph(files)).filter((c) => c.length > 1);
  assert.deepEqual(components, [["src/facts/a.ts", "src/facts/c.ts"]]);
});

test("negative fixture: an unregistered file fails — there is no default layer", () => {
  const files = new Map(CLEAN_FILES);
  files.set("src/report/authoring.ts", "export const write = 1;\n");
  const audit = auditLayerOrder(files, CLEAN_REGISTRY);
  assert.deepEqual(audit.registryViolations, ["unregistered file: src/report/authoring.ts"]);
});

test("negative fixture: a new file inside a registered directory is NOT silently adopted by a file entry", () => {
  // The directory entry legitimately covers it — that is what a whole-directory layer means. The point of this
  // fixture is the other half: a file entry may not stand in for a directory, so adding a sibling to a
  // FILE-registered directory goes red instead of inheriting its neighbour's layer.
  const files = new Map(CLEAN_FILES);
  files.set("src/mixed/known.ts", "export const known = 1;\n");
  files.set("src/mixed/added-later.ts", "export const added = 1;\n");
  const audit = auditLayerOrder(files, [...CLEAN_REGISTRY, { file: "src/mixed/known.ts", layer: "L3" }]);
  assert.deepEqual(audit.registryViolations, ["unregistered file: src/mixed/added-later.ts"]);
});

test("negative fixture: a file entry under a directory entry is a shadowed second authority", () => {
  const audit = auditLayerOrder(CLEAN_FILES, [...CLEAN_REGISTRY, { file: "src/base/util.ts", layer: "L3" }]);
  assert.deepEqual(audit.registryViolations, [
    "file entry src/base/util.ts is shadowed by directory entry src/base"
  ]);
});

test("negative fixture: an entry pointing at a path that no longer exists fails", () => {
  const audit = auditLayerOrder(CLEAN_FILES, [
    ...CLEAN_REGISTRY,
    { file: "src/report/deleted.ts", layer: "report" },
    { dir: "src/gone", layer: "L4" }
  ]);
  assert.deepEqual(audit.registryViolations, [
    "directory entry covers no file: src/gone",
    "file entry points at a missing file: src/report/deleted.ts"
  ]);
});

test("negative fixture: a duplicate entry fails rather than letting the first one win", () => {
  const audit = auditLayerOrder(CLEAN_FILES, [
    ...CLEAN_REGISTRY,
    { dir: "src/base", layer: "L8" },
    { file: "src/facts/graph.ts", layer: "L3" },
    { file: "src/facts/graph.ts", layer: "orch" }
  ]);
  assert.deepEqual(audit.registryViolations, [
    "duplicate directory entry: src/base",
    "file entry src/facts/graph.ts is shadowed by directory entry src/facts",
    "duplicate file entry: src/facts/graph.ts",
    "file entry src/facts/graph.ts is shadowed by directory entry src/facts"
  ]);
});

test("negative fixture: the instrument fails loudly on an import it cannot resolve", () => {
  const files = new Map(CLEAN_FILES);
  files.set("src/facts/graph.ts", 'import { y } from "../base/typo.ts";\nexport const g = y;\n');
  const audit = auditLayerOrder(files, CLEAN_REGISTRY);
  assert.deepEqual(audit.instrumentFailures, [
    "unresolved import: src/facts/graph.ts: ../base/typo.ts -> src/base/typo.ts"
  ]);
});

test("negative fixture: a relative specifier sitting in a comment is an instrument failure, not a guess", () => {
  // The extractor does not strip comments — a stripper is a second parser whose failure mode (dropping a real
  // edge) is silent. Instead a commented-out or merely mentioned relative import goes red and must be reworded.
  const files = new Map(CLEAN_FILES);
  files.set("src/facts/graph.ts", '// import { x } from "../base/util.ts";\nexport const g = 1;\n');
  const audit = auditLayerOrder(files, CLEAN_REGISTRY);
  assert.deepEqual(audit.instrumentFailures, [
    'src/facts/graph.ts: commented relative specifier ../base/util.ts'
  ]);
});

test("the extractor sees every dependency-carrying form and no bare-module specifier", () => {
  const { specifiers, commented } = extractRelativeSpecifiers([
    'import a from "./a.ts";',
    'import type { B } from "./b.ts";',
    'import {\n  c\n} from "./c.ts";',
    'export { d } from "./d.ts";',
    'export * from "./e.ts";',
    'export type { F } from "./f.ts";',
    'const g = await import("./g.ts");',
    'import { readFile } from "node:fs/promises";',
    'import { napi } from "@ast-grep/napi";'
  ].join("\n"));
  assert.deepEqual(specifiers, ["./a.ts", "./b.ts", "./c.ts", "./d.ts", "./e.ts", "./f.ts", "./g.ts"]);
  assert.deepEqual(commented, []);
});

test("the layer-order instrument sees every source file and resolves every relative import", async () => {
  // The instrument prior: before believing a green (or a red), the graph must provably cover all of src.
  const files = await loadSourceFiles();
  const audit = auditLayerOrder(files, LAYERING_REGISTRY);
  assert.ok(files.size > 80, `expected the whole src tree, got ${files.size} files`);
  assert.equal(audit.nodeCount, files.size, "one graph node per source file");
  assert.deepEqual(audit.instrumentFailures, []);
});

test("every source file is registered to exactly one layer, and no entry is stale", async () => {
  const files = await loadSourceFiles();
  const audit = auditLayerOrder(files, LAYERING_REGISTRY);
  assert.deepEqual(audit.registryViolations, []);
  assert.equal(audit.layerOf.size, files.size);
});
