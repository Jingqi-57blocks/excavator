// Zero-model replay harness for the improved feature-graph prune (57B-371).
//
// Two entry points, so the gate can run with zero external inputs while the real pipeline is still
// exercised end to end before a merge:
//
//   * FIXTURE path (in `npm test`): `loadPrunePool` gunzips a frozen candidate pool — the exact
//     nodes + closure edges + seeds + anchor terms the real pipeline fed the prune — and
//     `prunePoolToNodes` runs the current allocator over it. No database, no model, no network.
//
//   * REAL-DB path (manual / pre-merge smoke, `--run` + `--module`): `buildPoolFromRun` opens the
//     actual per-module CodeGraph databases through the real `CodeGraphSet` (new ×6 expand cap +
//     `edgesAmong` closure) and reproduces the pool the production pipeline would build, so the
//     fixture is a faithful snapshot and not a synthetic stand-in. `--emit-pool` freezes it.
//
// The pool is generated once from real databases and committed as a gzipped fixture; the databases
// themselves are never in the repo, so the real-db path degrades to a skip when they are absent.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join, dirname, basename } from "node:path";
import { CodeGraphIndex } from "../src/codegraph/codegraph.ts";
import { CodeGraphSet } from "../src/codegraph/codegraph-set.ts";
import { allocateFeatureGraph } from "../src/attribution/allocator.ts";
import { Deadline } from "../src/base/util.ts";
import type { BoundaryNode } from "./boundary.ts";

/** A frozen candidate pool: everything the allocator needs, and nothing model-derived. */
export interface PrunePool {
  target: string;
  anchorTerms: string[];
  maxFeatureNodes: number;
  seeds: any[];
  nodes: any[];
  edges: any[];
}

const DEFAULT_MAX_NODES = 250;
const SIGNATURE_LIMIT = 400;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** De-dupe merged edges by (source,target,kind,line) — prune re-dedupes, so this only shrinks the
 *  frozen fixture without changing the prune result. Separator is an escape, never a literal NUL. */
function dedupeEdges(edges: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const edge of edges) {
    const key = `${String(edge.source)}\u0001${String(edge.target)}\u0001${String(edge.kind)}\u0001${edge.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

/** Shrink a graph node for the fixture: drop the (prune-irrelevant) docstring, cap the signature. */
function compactNode(node: any): any {
  return { ...node, docstring: null, signature: node.signature == null ? null : truncate(String(node.signature), SIGNATURE_LIMIT) };
}

/** Read a run's feature-graph evidence entry (the shape discriminant: data has nodes + seeds). */
function readFeatureGraph(runDir: string): { seeds: any[]; anchorTerms: string[]; target: string } {
  const file = join(runDir, "evidence.json");
  if (!existsSync(file)) throw new Error(`evidence.json not found in ${runDir}`);
  const catalog = JSON.parse(readFileSync(file, "utf8"));
  const list: any[] = Array.isArray(catalog) ? catalog : catalog.evidence ?? [];
  const fg = list.find((entry) => entry?.kind === "graph" && Array.isArray(entry?.data?.nodes) && Array.isArray(entry?.data?.seeds));
  if (!fg) throw new Error(`no feature-graph evidence entry found in ${file}`);
  return { seeds: fg.data.seeds, anchorTerms: Array.isArray(fg.data.anchorTerms) ? fg.data.anchorTerms : [], target: basename(runDir) };
}

/** Derive a per-module database entry from a `<...>/<moduleDir>/.codegraph/codegraph.db` path. */
function moduleDbEntry(dbPath: string): { module: { id: string; dir: string }; path: string } {
  const moduleDir = basename(dirname(dirname(dbPath)));
  return { module: { id: moduleDir, dir: moduleDir }, path: dbPath };
}

/** Every module-prefixed file path across the given databases — the CodeGraphSet allowed set. */
function allowedPathsFor(modules: Array<{ module: { dir: string }; path: string }>, deadline: Deadline): string[] {
  const paths: string[] = [];
  for (const entry of modules) {
    const index = new CodeGraphIndex(entry.path, 1_000_000, deadline);
    try {
      for (const file of index.files()) paths.push(entry.module.dir ? `${entry.module.dir}/${file.path}` : file.path);
    } finally {
      index.close();
    }
  }
  return paths;
}

/**
 * Reproduce the production candidate pool from real databases: the same seeds and anchor terms the
 * run recorded, expanded with the new ×6 cap and closed over its internal edges. Mirrors
 * `buildFeatureContext` in src/context/context.ts exactly (depth clamp, cap, `edgesAmong`).
 */
export function buildPoolFromRun(runDir: string, dbPaths: string[], maxNodes = DEFAULT_MAX_NODES): PrunePool {
  const { seeds, anchorTerms, target } = readFeatureGraph(runDir);
  const modules = dbPaths.map(moduleDbEntry);
  const deadline = new Deadline(600_000, "prune-replay");
  const allowed = allowedPathsFor(modules, deadline);
  const graph = new CodeGraphSet(modules, allowed, 1_000_000, deadline);
  try {
    const seedIds = seeds.map((node) => String(node.id));
    // depth 2 (the production Math.min(depth, 2) clamp) and the same Math.max(maxNodes, seeds) × 6 cap.
    const expanded = graph.expand(seedIds, 2, Math.max(maxNodes, seeds.length) * 6);
    const poolEdges = graph.edgesAmong(expanded.nodes.map((node) => node.id));
    return {
      target,
      anchorTerms,
      maxFeatureNodes: maxNodes,
      seeds: seeds.map(compactNode),
      nodes: expanded.nodes.map(compactNode),
      edges: dedupeEdges([...expanded.edges, ...poolEdges])
    };
  } finally {
    graph.close();
  }
}

/** Freeze a pool to a gzipped JSON fixture (node:zlib, no added dependency). */
export function writePrunePool(file: string, pool: PrunePool): void {
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(pool), "utf8")));
}

/** Load a gzipped pool fixture. */
export function loadPrunePool(file: string): PrunePool {
  if (!existsSync(file)) throw new Error(`prune-pool fixture not found: ${file}`);
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
}

/** Run the allocator over a frozen candidate pool, optionally overriding the node budget. */
export function prunePool(pool: PrunePool, maxNodes = pool.maxFeatureNodes): { nodes: any[]; edges: any[] } {
  return allocateFeatureGraph(pool.nodes, pool.edges, pool.seeds, anchorTermsOf(pool), maxNodes);
}

/** Project the pruned node set into boundary-recall nodes. */
export function prunePoolToNodes(pool: PrunePool, maxNodes = pool.maxFeatureNodes): BoundaryNode[] {
  return prunePool(pool, maxNodes).nodes.map((node) => ({
    filePath: String(node.filePath),
    name: String(node.name ?? ""),
    startLine: Number(node.startLine),
    endLine: Number(node.endLine)
  }));
}

function anchorTermsOf(pool: PrunePool): string[] {
  return Array.isArray(pool.anchorTerms) ? pool.anchorTerms : [];
}
