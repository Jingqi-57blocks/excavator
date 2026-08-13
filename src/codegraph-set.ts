import type { GraphEdge, GraphFile, GraphNode } from "./types.ts";
import type { Deadline } from "./util.ts";
import { CodeGraphIndex, QueryBudget, type GraphReader, type GraphSummary, type QueryStats } from "./codegraph.ts";
import { moduleForFile, type DetectedModule } from "./module-detection.ts";

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

  searchNodes(terms: string[], limit = 120): GraphNode[] {
    const merged = this.members.flatMap((member) => member.index.searchNodes(terms, limit).map((node) => this.globalNode(member, node)));
    return sortNodes(merged).slice(0, limit);
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

function sortNodes(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) =>
    (KIND_RANK[a.kind] ?? 4) - (KIND_RANK[b.kind] ?? 4)
    || compare(a.filePath, b.filePath)
    || a.startLine - b.startLine
    || compare(a.id, b.id)
  );
}

function mergeCounts(rows: Array<readonly [string, number]>): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const [key, count] of rows) totals.set(key, (totals.get(key) ?? 0) + count);
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]));
}

function normalize(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\/+/, ""); }

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
