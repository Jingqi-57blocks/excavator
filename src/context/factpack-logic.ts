// The `logic` fact-pack category: the business and decision functions inside a feature boundary that
// the six kind/scan categories do not already name. It is a COMPLEMENT FULL-ENUMERATION of the pruned
// feature-graph node set — pruneFeatureGraph already made the significance decision, so membership here
// is never a score. (Top-K scoring was rejected: a real target can rank near the bottom of the boundary,
// so any cut below the full complement would drop it.) Significance is used ONLY to ORDER the items and
// choose which get an inline window; it never decides who is in.
//
// A node becomes a logic item iff:
//   1. it is a retained pruned-FG node (the only membership criterion);
//   2. its kind is not owned by a kind-based category (derived from the caller, never hardcoded) and is
//      not `import`/`file`; and
//   3. its exact (filePath, startLine) is not already claimed by an earlier category (EXACT line match,
//      never interval overlap — a function-body line a scan matched must not swallow the whole function).
//
// Pure: zero I/O, zero npm dependency, no model call. Directly unit-testable — the caller derives the
// kind sets from CATEGORY_STRATEGIES and passes them in, so a future category auto-shrinks the complement.

import type { FactPackItem } from "../core/types.ts";

const NAME_LIMIT = 120;
const DETAIL_LIMIT = 200;

/** SOH field separator for the (filePath, startLine) claim key — an escaped control char, never a literal NUL. */
export const LOGIC_LOCATION_SEP = "\u0001";

/** The retained feature graph reduced to what the complement enumeration needs. */
export interface LogicFeatureGraph {
  nodes: Array<{ id?: unknown; name?: unknown; kind?: unknown; filePath?: unknown; startLine?: unknown; endLine?: unknown; signature?: unknown; rescued?: unknown }>;
  edges: Array<{ source?: unknown; target?: unknown; kind?: unknown }>;
  seeds: Array<{ id?: unknown }>;
}

export interface LogicSelection {
  /** `logicClaimKey(filePath, startLine)` for every location an earlier category already claimed. */
  claimedLocations: Set<string>;
  /** Kinds a kind-based category already owns (derived from CATEGORY_STRATEGIES graphKinds), plus import/file. */
  excludedKinds: Set<string>;
  /** Kinds whose out-edges promote a target to attention tier 2 (the entrypoint/route kinds). */
  routeKinds: Set<string>;
  /** Per-caller in-degree multiplicity cap (mirrors pruneFeatureGraph's BRIDGE_MAX_MULTIPLICITY). */
  cap: number;
}

/** The claim key for a (filePath, startLine) pair. Callers and the rule share it so they agree byte-for-byte. */
export function logicClaimKey(filePath: unknown, line: unknown): string {
  return `${normPath(String(filePath ?? ""))}${LOGIC_LOCATION_SEP}${line}`;
}

/**
 * Enumerate the complement `logic` items of a retained feature graph. Deterministic and total-ordered:
 * the same graph and selection produce byte-identical items with byte-identical ranks.
 */
export function logicItems(graph: LogicFeatureGraph, selection: LogicSelection): FactPackItem[] {
  const seedIds = new Set(graph.seeds.map((seed) => String(seed.id ?? "")));

  // Attention tier 2: a node an entrypoint/route-kind node points at through an out-edge.
  const routeIds = new Set<string>();
  for (const node of graph.nodes) if (selection.routeKinds.has(String(node.kind ?? ""))) routeIds.add(String(node.id ?? ""));
  const routePointed = new Set<string>();
  for (const edge of graph.edges) if (routeIds.has(String(edge.source ?? ""))) routePointed.add(String(edge.target ?? ""));

  // In-boundary in-degree: distinct callers among retained nodes, each caller's multiplicity capped.
  // Every edge is already restricted to retained nodes by the prune, so all of them are in-boundary.
  const callers = new Map<string, Map<string, number>>();
  for (const edge of graph.edges) {
    const source = String(edge.source ?? "");
    const target = String(edge.target ?? "");
    if (!source || !target || source === target) continue;
    let inner = callers.get(target);
    if (!inner) { inner = new Map(); callers.set(target, inner); }
    inner.set(source, (inner.get(source) ?? 0) + 1);
  }
  const inDegree = (id: string): number => {
    const inner = callers.get(id);
    if (!inner) return 0;
    let total = 0;
    for (const count of inner.values()) total += Math.min(count, selection.cap);
    return total;
  };

  interface Ranked { node: LogicFeatureGraph["nodes"][number]; tier: number; degree: number; signal?: string; filePath: string; startLine: number; }
  const ranked: Ranked[] = [];
  for (const node of graph.nodes) {
    const kind = String(node.kind ?? "");
    if (selection.excludedKinds.has(kind) || kind === "import" || kind === "file") continue;
    const filePath = normPath(String(node.filePath ?? ""));
    const startLine = Number(node.startLine) || 0;
    if (selection.claimedLocations.has(logicClaimKey(filePath, startLine))) continue;

    const rescued = typeof node.rescued === "string" && node.rescued.length ? node.rescued : undefined;
    const id = String(node.id ?? "");
    const tier = rescued ? 0 : seedIds.has(id) ? 1 : routePointed.has(id) ? 2 : 3;
    ranked.push({ node, tier, degree: inDegree(id), signal: rescued, filePath, startLine });
  }

  // Total order: tier asc, in-degree desc, then filePath / startLine / name / id (code-unit comparison).
  ranked.sort((a, b) =>
    a.tier - b.tier
    || b.degree - a.degree
    || compareStrings(a.filePath, b.filePath)
    || a.startLine - b.startLine
    || compareStrings(String(a.node.name ?? ""), String(b.node.name ?? ""))
    || compareStrings(String(a.node.id ?? ""), String(b.node.id ?? "")));

  return ranked.map((entry, index): FactPackItem => {
    const signature = String(entry.node.signature ?? "");
    const item: FactPackItem = {
      category: "logic",
      name: clip(String(entry.node.name ?? entry.node.id ?? ""), NAME_LIMIT),
      filePath: entry.filePath,
      line: entry.startLine,
      endLine: Number(entry.node.endLine) || undefined,
      detail: signature ? clip(collapse(signature), DETAIL_LIMIT) : undefined,
      source: "graph",
      rank: index
    };
    if (entry.signal) item.signal = clip(collapse(entry.signal), DETAIL_LIMIT);
    return item;
  });
}

function compareStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function normPath(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\/+/, ""); }
function collapse(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function clip(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }
