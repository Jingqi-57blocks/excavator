import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Module-boundary detection for per-module CodeGraph building and consumption.
 *
 * A single merged graph over a multi-repo target fabricates cross-repo edges. The fix is to treat
 * each real module as its own graph. This slice recognizes only the common stacks — `go.mod`
 * directories and `package.json` (workspace roots and individual packages). The isolation axis is
 * the module marker, never the directory: a target with no recognized marker is never split, which
 * keeps marker-less multi-directory workspaces (e.g. a Maven reactor) as a single graph so real
 * inter-module edges are not dropped. Maven/`.sln` detection is deferred to a later slice.
 */

const MODULE_MARKERS = new Set(["go.mod", "package.json"]);

/** Directories that never hold a source module worth its own graph and inflate the marker walk. */
const SKIP_DIRS = new Set([
  ".git", ".codegraph", "node_modules", "vendor", "dist", "build", "out",
  "target", ".next", ".nuxt", ".venv", "__pycache__", "coverage"
]);

export interface DetectedModule {
  /** Stable id: the module's POSIX-relative directory, or "." for the target root. */
  id: string;
  /** POSIX-relative directory of the module marker; "" for the target root. */
  dir: string;
}

/**
 * Decide the module split from a list of marker file paths (POSIX, relative to the target).
 *
 * Only leaf marker directories are returned — a marker directory that is an ancestor of another
 * marker directory is not built as its own graph, so a workspace root never re-merges its packages.
 * The split is taken only when at least two leaf modules exist; otherwise `[]` is returned, meaning
 * "do not split, keep the single-graph behavior". This is the openmrs-type guardrail: no recognized
 * marker (or only one module) leaves the target as a single graph.
 */
export function detectModules(markerRelPaths: string[]): DetectedModule[] {
  const dirs = new Set<string>();
  for (const path of markerRelPaths) {
    const norm = normalize(path);
    const base = norm.slice(norm.lastIndexOf("/") + 1);
    if (!MODULE_MARKERS.has(base)) continue;
    dirs.add(norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "");
  }
  const all = [...dirs];
  const leaves = all.filter((dir) => !all.some((other) => other !== dir && isUnder(other, dir)));
  if (leaves.length < 2) return [];
  return leaves.sort().map((dir) => ({ id: dir === "" ? "." : dir, dir }));
}

/** The module that owns a file: the nearest ancestor module directory, or `undefined` if none. */
export function moduleForFile(modules: DetectedModule[], relativePath: string): DetectedModule | undefined {
  const norm = normalize(relativePath);
  let deepest: DetectedModule | undefined;
  let root: DetectedModule | undefined;
  for (const module of modules) {
    if (module.dir === "") { root = module; continue; }
    if (norm === module.dir || norm.startsWith(`${module.dir}/`)) {
      if (!deepest || module.dir.length > deepest.dir.length) deepest = module;
    }
  }
  return deepest ?? root;
}

/** Walk the target for `go.mod`/`package.json` markers, returning their POSIX-relative paths. */
export async function findModuleMarkers(targetDir: string, maxDepth = 8): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isFile() && MODULE_MARKERS.has(entry.name)) results.push(rel ? `${rel}/${entry.name}` : entry.name);
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
    }
  };
  await walk(targetDir, "", 0);
  return results.sort();
}

/** Convenience: detect the module split for a target directory by walking it for markers. */
export async function discoverModules(targetDir: string): Promise<DetectedModule[]> {
  return detectModules(await findModuleMarkers(targetDir));
}

function isUnder(child: string, parent: string): boolean {
  if (parent === "") return child !== "";
  return child !== parent && child.startsWith(`${parent}/`);
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}
