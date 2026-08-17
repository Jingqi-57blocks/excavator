import type { GraphEdge, GraphFile, GraphNode } from "../base/types.ts";
import type { Deadline } from "../base/util.ts";
import { CodeGraphIndex, QueryBudget, type GraphReader, type GraphSummary, type QueryStats } from "./codegraph.ts";
import { moduleForFile, type DetectedModule } from "../snapshot/module-detection.ts";

/**
 * A graph provider over per-module CodeGraph databases.
 *
 * Each module opens its own database and is restricted to the files it owns (nearest-ancestor
 * assignment). Because every relationship query joins each module's own `allowed_files`, an edge
 * can only ever connect two files inside the same module — cross-module relationships never travel
 * through the graph, they fall to source. This holds even if a database was built over a wider tree
 * than its module: the per-module `allowed_files` partition clips it back to the module boundary.
 *
 * Each module's database stores paths relative to its own directory (the build runs inside the
 * module). This wrapper translates between target-relative paths (what callers use) and
 * module-relative paths (what a database stores), and namespaces node ids by module so ids from
 * different databases never collide.
 */

/** NUL separates a module id from a database-local node id; it never appears in a CodeGraph id.
 *  Exported as the single source of module identity: the prune module-floor (57B-377) groups nodes
 *  by the prefix before this separator, and must not hand-write the byte itself. */
export const ID_SEPARATOR = "\u0000";

const KIND_RANK: Record<string, number> = { route: 0, component: 1, function: 2, method: 3 };

/**
 * Seats reserved per module that matched anything.
 *
 * Two, not one: a single seed rarely survives the downstream prune, and the prune's own module floor
 * (57B-377) only protects modules already IN the pool — it cannot rescue a module that never got a seed.
 * Two, not more: the floor is a guarantee against silence, and every seat it takes is one the global
 * ranking does not get to decide.
 */
const FLOOR_SEATS_PER_MODULE = 2;

interface ModuleDatabase {
  module: DetectedModule;
  path: string;
}

interface Member {
  module: DetectedModule;
  index: CodeGraphIndex;
}

export class CodeGraphSet implements GraphReader {
  private readonly members: Member[];
  private readonly budget: QueryBudget;

  constructor(modules: ModuleDatabase[], allowedRelativePaths: Iterable<string>, budget: number, deadline: Deadline) {
    this.budget = new QueryBudget(budget);
    const moduleList = modules.map((entry) => entry.module);
    const owned = new Map<string, string[]>();
    for (const relative of allowedRelativePaths) {
      const owner = moduleForFile(moduleList, relative);
      if (!owner) continue;
      const list = owned.get(owner.id) ?? [];
      list.push(toLocal(owner.dir, relative));
      owned.set(owner.id, list);
    }
    this.members = modules.map(({ module, path }) => ({
      module,
      index: new CodeGraphIndex(path, this.budget, deadline, owned.get(module.id) ?? [])
    }));
  }

  get stats(): QueryStats { return { queries: this.budget.queries, hits: this.budget.hits }; }

  close(): void { for (const member of this.members) member.index.close(); }

  metadata(): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const member of this.members) Object.assign(merged, member.index.metadata());
    return merged;
  }

  files(): GraphFile[] {
    return this.members
      .flatMap((member) => member.index.files().map((file) => ({ ...file, path: toGlobal(member.module.dir, file.path) })))
      .sort((a, b) => compare(a.path, b.path));
  }

  summary(): GraphSummary {
    const parts = this.members.map((member) => ({ dir: member.module.dir, summary: member.index.summary() }));
    const total = (pick: (summary: GraphSummary) => number): number => parts.reduce((sum, part) => sum + pick(part.summary), 0);
    return {
      fileCount: total((summary) => summary.fileCount),
      nodeCount: total((summary) => summary.nodeCount),
      edgeCount: total((summary) => summary.edgeCount),
      unresolvedCount: total((summary) => summary.unresolvedCount),
      languages: mergeCounts(parts.flatMap((part) => part.summary.languages.map((row) => [row.language, row.files] as const))).map(([language, files]) => ({ language, files })),
      nodeKinds: mergeCounts(parts.flatMap((part) => part.summary.nodeKinds.map((row) => [row.kind, row.count] as const))).map(([kind, count]) => ({ kind, count })),
      edgeKinds: mergeCounts(parts.flatMap((part) => part.summary.edgeKinds.map((row) => [row.kind, row.count] as const))).map(([kind, count]) => ({ kind, count })),
      roots: parts
        .flatMap((part) => part.summary.roots.map((row) => ({ root: toGlobal(part.dir, row.root), files: row.files, nodes: row.nodes })))
        .sort((a, b) => b.files - a.files || compare(a.root, b.root))
    };
  }

  representativeNodes(limit = 80): GraphNode[] {
    return roundRobin(this.members.map((member) => member.index.representativeNodes(limit).map((node) => this.globalNode(member, node))), limit);
  }

  routeSummary(limit = 80): GraphNode[] {
    return roundRobin(this.members.map((member) => member.index.routeSummary(limit).map((node) => this.globalNode(member, node))), limit);
  }

  /**
   * Seeds for the feature scope, with a FLOOR so a module cannot be silently zeroed.
   *
   * The old form merged every member's hits and took the global top `limit`. That is a single competition
   * across modules, and a module can lose it outright: simulated on the five-module real target with the
   * leave vocabulary, `wcp-auth` and `wcp_review_service` each won ZERO seats — and a module with no seed is
   * then skipped entirely by `expand` (`if (!seeds?.length) continue`), so nothing downstream can recover it.
   * A whole repository contributing nothing is the failure that function-level read obligations cannot even
   * express, because a module outside the boundary lands in no bucket at all.
   *
   * So a module that matched anything is guaranteed a couple of seats, and the rest of the budget is decided
   * by the same global order as before. Nx does the equivalent structurally — `normalizeProjectNodes` makes
   * every project a node before any edge is considered — while Turborepo's `globalDependencies` only reaches
   * the task hash and never the package selection, which is exactly the shape of the bug being fixed here.
   *
   * The OUTPUT stays globally sorted: the floor changes which nodes are included, never their order, so a
   * scope whose modules all placed anyway is byte-identical to before.
   */
  searchNodes(terms: string[], limit = 120): GraphNode[] {
    const perModule = this.members
      .map((member) => sortNodes(member.index.searchNodes(terms, limit).map((node) => this.globalNode(member, node))))
      .filter((hits) => hits.length > 0);
    if (!perModule.length) return [];

    // Strongest module first, so when the floor cannot seat everyone the seats go by the same order the
    // global competition would have used. `compareNodes` is total, so this is deterministic.
    const ordered = [...perModule].sort((a, b) => compareNodes(a[0], b[0]));

    // The floor may never take more than half the budget: it exists to prevent silence, not to replace
    // ranking. When modules outnumber the seats it can spend, the remainder simply competes globally — and
    // when they outnumber `limit` itself, one seat each is all there is, which is still defined behaviour
    // rather than an empty module.
    const floorBudget = Math.max(1, Math.floor(limit / 2));
    const taken = new Set<string>();
    const floor: GraphNode[] = [];
    for (let seat = 0; seat < FLOOR_SEATS_PER_MODULE && floor.length < floorBudget; seat += 1) {
      for (const hits of ordered) {
        if (floor.length >= floorBudget) break;
        const node = hits[seat];
        if (!node || taken.has(node.id)) continue;
        floor.push(node);
        taken.add(node.id);
      }
    }

    const contested = sortNodes(perModule.flat()).filter((node) => !taken.has(node.id));
    return sortNodes([...floor, ...contested.slice(0, Math.max(0, limit - floor.length))]);
  }

  searchNodesInFiles(terms: string[], filePaths: string[], limit = 120): GraphNode[] {
    const grouped = this.groupFiles(filePaths);
    const merged: GraphNode[] = [];
    for (const member of this.members) {
      const local = grouped.get(member.module.id);
      if (local?.length) merged.push(...member.index.searchNodesInFiles(terms, local, limit).map((node) => this.globalNode(member, node)));
    }
    return sortNodes(merged).slice(0, limit);
  }

  nodesByKindInFiles(kinds: string[], filePaths: string[], limit = 500): GraphNode[] {
    const grouped = this.groupFiles(filePaths);
    const merged: GraphNode[] = [];
    for (const member of this.members) {
      const local = grouped.get(member.module.id);
      if (local?.length) merged.push(...member.index.nodesByKindInFiles(kinds, local, limit).map((node) => this.globalNode(member, node)));
    }
    return merged
      .sort((a, b) => compare(a.filePath, b.filePath) || a.startLine - b.startLine || compare(a.name, b.name))
      .slice(0, limit);
  }

  expand(seedIds: string[], depth: number, maxNodes: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const byModule = this.groupIds(seedIds);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const member of this.members) {
      const seeds = byModule.get(member.module.id);
      if (!seeds?.length) continue;
      const expanded = member.index.expand(seeds, depth, maxNodes);
      nodes.push(...expanded.nodes.map((node) => this.globalNode(member, node)));
      edges.push(...expanded.edges.map((edge) => this.globalEdge(member, edge)));
    }
    return { nodes, edges };
  }

  edgesAmong(nodeIds: string[]): GraphEdge[] {
    const byModule = this.groupIds(nodeIds);
    const edges: GraphEdge[] = [];
    for (const member of this.members) {
      const ids = byModule.get(member.module.id);
      if (!ids?.length) continue;
      edges.push(...member.index.edgesAmong(ids).map((edge) => this.globalEdge(member, edge)));
    }
    return edges;
  }

  unresolvedForNodeIds(nodeIds: string[], limit = 200): Array<Record<string, unknown>> {
    const byModule = this.groupIds(nodeIds);
    const rows: Array<Record<string, unknown>> = [];
    for (const member of this.members) {
      const ids = byModule.get(member.module.id);
      if (!ids?.length) continue;
      for (const row of member.index.unresolvedForNodeIds(ids, limit)) {
        rows.push({
          ...row,
          from_node_id: namespaceId(member.module.id, String(row.from_node_id)),
          file_path: toGlobal(member.module.dir, String(row.file_path))
        });
      }
    }
    return rows.slice(0, limit);
  }

  private globalNode(member: Member, node: GraphNode): GraphNode {
    return { ...node, id: namespaceId(member.module.id, node.id), filePath: toGlobal(member.module.dir, node.filePath) };
  }

  private globalEdge(member: Member, edge: GraphEdge): GraphEdge {
    return { ...edge, source: namespaceId(member.module.id, edge.source), target: namespaceId(member.module.id, edge.target) };
  }

  private groupFiles(filePaths: string[]): Map<string, string[]> {
    const moduleList = this.members.map((member) => member.module);
    const grouped = new Map<string, string[]>();
    for (const path of filePaths) {
      const owner = moduleForFile(moduleList, path);
      if (!owner) continue;
      const list = grouped.get(owner.id) ?? [];
      list.push(toLocal(owner.dir, path));
      grouped.set(owner.id, list);
    }
    return grouped;
  }

  private groupIds(nodeIds: string[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const nodeId of nodeIds) {
      const split = splitId(nodeId);
      if (!split) continue;
      const list = grouped.get(split.moduleId) ?? [];
      list.push(split.id);
      grouped.set(split.moduleId, list);
    }
    return grouped;
  }
}

function namespaceId(moduleId: string, id: string): string { return `${moduleId}${ID_SEPARATOR}${id}`; }

function splitId(value: string): { moduleId: string; id: string } | null {
  const index = value.indexOf(ID_SEPARATOR);
  if (index < 0) return null;
  return { moduleId: value.slice(0, index), id: value.slice(index + 1) };
}

function toLocal(dir: string, relativePath: string): string {
  const norm = normalize(relativePath);
  if (!dir) return norm;
  if (norm === dir) return "";
  return norm.startsWith(`${dir}/`) ? norm.slice(dir.length + 1) : norm;
}

function toGlobal(dir: string, localPath: string): string {
  const norm = normalize(localPath);
  if (!dir) return norm;
  return norm ? `${dir}/${norm}` : dir;
}

function roundRobin(lists: GraphNode[][], limit: number): GraphNode[] {
  const result: GraphNode[] = [];
  for (let round = 0; result.length < limit; round += 1) {
    let added = false;
    for (const list of lists) {
      const node = list[round];
      if (!node) continue;
      result.push(node);
      added = true;
      if (result.length >= limit) break;
    }
    if (!added) break;
  }
  return result;
}

/** The total order over nodes: kind rank, then path, then position, then id. Total, so sorting is stable. */
function compareNodes(a: GraphNode, b: GraphNode): number {
  return (KIND_RANK[a.kind] ?? 4) - (KIND_RANK[b.kind] ?? 4)
    || compare(a.filePath, b.filePath)
    || a.startLine - b.startLine
    || compare(a.id, b.id);
}

function sortNodes(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort(compareNodes);
}

function mergeCounts(rows: Array<readonly [string, number]>): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const [key, count] of rows) totals.set(key, (totals.get(key) ?? 0) + count);
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]));
}

function normalize(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\/+/, ""); }

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
