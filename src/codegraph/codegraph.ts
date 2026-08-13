import { DatabaseSync } from "node:sqlite";
import type { GraphEdge, GraphFile, GraphNode } from "../core/types.ts";
import { Deadline, sha256, stableJson } from "../core/util.ts";

export interface QueryStats {
  queries: number;
  hits: number;
}

export interface GraphSummary {
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  unresolvedCount: number;
  languages: Array<{ language: string; files: number }>;
  nodeKinds: Array<{ kind: string; count: number }>;
  edgeKinds: Array<{ kind: string; count: number }>;
  roots: Array<{ root: string; files: number; nodes: number }>;
}

/**
 * The read surface every graph provider exposes. `CodeGraphIndex` is the single-database provider;
 * `CodeGraphSet` fans the same surface across per-module databases. Consumers depend on this
 * interface so single-module and multi-module targets share one code path.
 */
export interface GraphReader {
  metadata(): Record<string, string>;
  files(): GraphFile[];
  summary(): GraphSummary;
  representativeNodes(limit?: number): GraphNode[];
  routeSummary(limit?: number): GraphNode[];
  searchNodes(terms: string[], limit?: number): GraphNode[];
  searchNodesInFiles(terms: string[], filePaths: string[], limit?: number): GraphNode[];
  nodesByKindInFiles(kinds: string[], filePaths: string[], limit?: number): GraphNode[];
  expand(seedIds: string[], depth: number, maxNodes: number): { nodes: GraphNode[]; edges: GraphEdge[] };
  edgesAmong(nodeIds: string[]): GraphEdge[];
  unresolvedForNodeIds(nodeIds: string[], limit?: number): Array<Record<string, unknown>>;
  readonly stats: QueryStats;
  close(): void;
}

/**
 * A query budget shared by one or more `CodeGraphIndex` instances. A multi-module target opens one
 * index per module but must not multiply the caller's `--max-graph-queries` ceiling, so the whole
 * set draws from a single counter.
 */
export class QueryBudget {
  readonly max: number;
  queries = 0;
  hits = 0;

  constructor(max: number) { this.max = max; }

  recordHit(): void { this.hits += 1; }

  spend(): void {
    if (this.queries >= this.max) throw new Error(`CodeGraph query budget exceeded (${this.max}); increase --max-graph-queries (e.g. ${this.max * 2})`);
    this.queries += 1;
  }
}

export class CodeGraphIndex implements GraphReader {
  readonly path: string;
  private readonly budget: QueryBudget;
  private readonly deadline: Deadline;
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, unknown[]>();

  constructor(path: string, budget: number | QueryBudget, deadline: Deadline, allowedPaths?: Iterable<string>) {
    this.path = path;
    this.budget = typeof budget === "number" ? new QueryBudget(budget) : budget;
    this.deadline = deadline;
    this.db = new DatabaseSync(path, { readOnly: true });
    this.db.exec("CREATE TEMP TABLE allowed_files(path TEXT PRIMARY KEY)");
    if (allowedPaths == null) {
      this.db.exec("INSERT OR IGNORE INTO allowed_files(path) SELECT path FROM files");
    } else {
      const insert = this.db.prepare("INSERT OR IGNORE INTO allowed_files(path) VALUES (?)");
      for (const value of allowedPaths) insert.run(normalizePath(String(value)));
    }
  }

  close(): void { this.db.close(); }

  get stats(): QueryStats { return { queries: this.budget.queries, hits: this.budget.hits }; }

  private query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    this.deadline.check("querying CodeGraph");
    const key = sha256(`${sql}\n${stableJson(params)}`);
    const cached = this.cache.get(key);
    if (cached) {
      this.budget.recordHit();
      return cached as T[];
    }
    this.budget.spend();
    const rows = this.db.prepare(sql).all(...params) as T[];
    this.cache.set(key, rows);
    return rows;
  }

  metadata(): Record<string, string> {
    return Object.fromEntries(this.query<{ key: string; value: string }>("SELECT key, value FROM project_metadata ORDER BY key").map((row) => [row.key, row.value]));
  }

  files(): GraphFile[] {
    return this.query<Record<string, unknown>>("SELECT f.path, f.language, f.size, f.node_count, f.errors FROM files f JOIN allowed_files a ON a.path = f.path ORDER BY f.path").map((row) => ({
      path: String(row.path),
      language: String(row.language),
      size: Number(row.size),
      nodeCount: Number(row.node_count ?? 0),
      errors: parseJsonArray(row.errors)
    }));
  }

  summary(): {
    fileCount: number;
    nodeCount: number;
    edgeCount: number;
    unresolvedCount: number;
    languages: Array<{ language: string; files: number }>;
    nodeKinds: Array<{ kind: string; count: number }>;
    edgeKinds: Array<{ kind: string; count: number }>;
    roots: Array<{ root: string; files: number; nodes: number }>;
  } {
    const counts = this.query<Record<string, unknown>>(`
      SELECT
        (SELECT COUNT(*) FROM files f JOIN allowed_files a ON a.path = f.path) AS file_count,
        (SELECT COUNT(*) FROM nodes n JOIN allowed_files a ON a.path = n.file_path) AS node_count,
        (SELECT COUNT(*) FROM edges e
          JOIN nodes s ON s.id = e.source JOIN allowed_files sa ON sa.path = s.file_path
          JOIN nodes t ON t.id = e.target JOIN allowed_files ta ON ta.path = t.file_path) AS edge_count,
        (SELECT COUNT(*) FROM unresolved_refs u JOIN allowed_files a ON a.path = u.file_path WHERE u.status != 'resolved') AS unresolved_count
    `)[0];
    return {
      fileCount: Number(counts.file_count),
      nodeCount: Number(counts.node_count),
      edgeCount: Number(counts.edge_count),
      unresolvedCount: Number(counts.unresolved_count),
      languages: this.query<Record<string, unknown>>("SELECT f.language, COUNT(*) AS files FROM files f JOIN allowed_files a ON a.path = f.path GROUP BY f.language ORDER BY files DESC").map((r) => ({ language: String(r.language), files: Number(r.files) })),
      nodeKinds: this.query<Record<string, unknown>>("SELECT n.kind, COUNT(*) AS count FROM nodes n JOIN allowed_files a ON a.path = n.file_path GROUP BY n.kind ORDER BY count DESC").map((r) => ({ kind: String(r.kind), count: Number(r.count) })),
      edgeKinds: this.query<Record<string, unknown>>(`
        SELECT e.kind, COUNT(*) AS count FROM edges e
        JOIN nodes s ON s.id = e.source JOIN allowed_files sa ON sa.path = s.file_path
        JOIN nodes t ON t.id = e.target JOIN allowed_files ta ON ta.path = t.file_path
        GROUP BY e.kind ORDER BY count DESC
      `).map((r) => ({ kind: String(r.kind), count: Number(r.count) })),
      roots: this.query<Record<string, unknown>>(`
        WITH fr AS (
          SELECT CASE WHEN instr(f.path, '/') > 0 THEN substr(f.path, 1, instr(f.path, '/') - 1) ELSE '.' END AS root, COUNT(*) AS files
          FROM files f JOIN allowed_files a ON a.path = f.path GROUP BY root
        ), nr AS (
          SELECT CASE WHEN instr(n.file_path, '/') > 0 THEN substr(n.file_path, 1, instr(n.file_path, '/') - 1) ELSE '.' END AS root, COUNT(*) AS nodes
          FROM nodes n JOIN allowed_files a ON a.path = n.file_path GROUP BY root
        )
        SELECT fr.root, fr.files, COALESCE(nr.nodes, 0) AS nodes FROM fr LEFT JOIN nr USING(root) ORDER BY fr.files DESC
      `).map((r) => ({ root: String(r.root), files: Number(r.files), nodes: Number(r.nodes) }))
    };
  }

  representativeNodes(limit = 80): GraphNode[] {
    const rows = this.query<Record<string, unknown>>(`
      WITH candidates AS (
        SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, docstring, signature, is_exported,
          CASE WHEN instr(file_path, '/') > 0 THEN substr(file_path, 1, instr(file_path, '/') - 1) ELSE '.' END AS root,
          ROW_NUMBER() OVER (
            PARTITION BY CASE WHEN instr(file_path, '/') > 0 THEN substr(file_path, 1, instr(file_path, '/') - 1) ELSE '.' END, kind
            ORDER BY is_exported DESC, (end_line - start_line) DESC, file_path, start_line
          ) AS rn
        FROM nodes
        WHERE EXISTS (SELECT 1 FROM allowed_files a WHERE a.path = nodes.file_path)
          AND kind IN ('route','function','method','class','interface','struct','component','module')
      )
      SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, docstring, signature
      FROM candidates
      WHERE rn <= 4
      ORDER BY root, kind, file_path, start_line
      LIMIT ?
    `, [limit]);
    return rows.map(toNode);
  }


  searchNodes(terms: string[], limit = 120): GraphNode[] {
    const clean = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
    if (!clean.length) return [];
    const conditions = clean.flatMap(() => ["lower(name) LIKE ?", "lower(qualified_name) LIKE ?", "lower(COALESCE(docstring,'')) LIKE ?", "lower(file_path) LIKE ?"]);
    const params = clean.flatMap((term) => Array(4).fill(`%${term.toLowerCase()}%`));
    const rows = this.query<Record<string, unknown>>(`
      SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, docstring, signature
      FROM nodes
      WHERE EXISTS (SELECT 1 FROM allowed_files a WHERE a.path = nodes.file_path)
        AND (${conditions.join(" OR ")})
      ORDER BY
        CASE kind WHEN 'route' THEN 0 WHEN 'component' THEN 1 WHEN 'function' THEN 2 WHEN 'method' THEN 3 ELSE 4 END,
        is_exported DESC,
        file_path,
        start_line
      LIMIT ?
    `, [...params, limit]);
    return rows.map(toNode);
  }


  searchNodesInFiles(terms: string[], filePaths: string[], limit = 120): GraphNode[] {
    const clean = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
    const files = [...new Set(filePaths.map(normalizePath).filter(Boolean))];
    if (!clean.length || !files.length) return [];
    const results: GraphNode[] = [];
    for (let offset = 0; offset < files.length && results.length < limit; offset += 300) {
      const batch = files.slice(offset, offset + 300);
      const termConditions = clean.flatMap(() => ["lower(name) LIKE ?", "lower(qualified_name) LIKE ?", "lower(COALESCE(docstring,'')) LIKE ?", "lower(COALESCE(signature,'')) LIKE ?"]);
      const termParams = clean.flatMap((term) => Array(4).fill(`%${term.toLowerCase()}%`));
      const filePlaceholders = batch.map(() => "?").join(",");
      const rows = this.query<Record<string, unknown>>(`
        SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, docstring, signature
        FROM nodes
        WHERE file_path IN (${filePlaceholders})
          AND EXISTS (SELECT 1 FROM allowed_files a WHERE a.path = nodes.file_path)
          AND (${termConditions.join(" OR ")})
        ORDER BY CASE kind WHEN 'route' THEN 0 WHEN 'component' THEN 1 WHEN 'function' THEN 2 WHEN 'method' THEN 3 ELSE 4 END,
          file_path, start_line
        LIMIT ?
      `, [...batch, ...termParams, limit - results.length]);
      results.push(...rows.map(toNode));
    }
    return results.slice(0, limit);
  }

  /**
   * Every node of the given kinds inside the given files — an enumeration, not a search.
   * Callers that must not miss a route or an entity ask by kind over a known boundary instead
   * of filtering a scored, capped scope set. Kinds and paths are sorted so repeated calls hit
   * the query cache, and the row order is stable for byte-identical artifacts.
   */
  nodesByKindInFiles(kinds: string[], filePaths: string[], limit = 500): GraphNode[] {
    const cleanKinds = [...new Set(kinds.map((kind) => kind.trim()).filter(Boolean))].sort();
    const files = [...new Set(filePaths.map(normalizePath).filter(Boolean))].sort();
    if (!cleanKinds.length || !files.length || limit <= 0) return [];
    const kindPlaceholders = cleanKinds.map(() => "?").join(",");
    const results: GraphNode[] = [];
    for (let offset = 0; offset < files.length && results.length < limit; offset += 300) {
      const batch = files.slice(offset, offset + 300);
      const filePlaceholders = batch.map(() => "?").join(",");
      const rows = this.query<Record<string, unknown>>(`
        SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, docstring, signature
        FROM nodes
        WHERE kind IN (${kindPlaceholders})
          AND file_path IN (${filePlaceholders})
          AND EXISTS (SELECT 1 FROM allowed_files a WHERE a.path = nodes.file_path)
        ORDER BY file_path, start_line, name
        LIMIT ?
      `, [...cleanKinds, ...batch, limit - results.length]);
      results.push(...rows.map(toNode));
    }
    return results.slice(0, limit);
  }

  expand(seedIds: string[], depth: number, maxNodes: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const seen = new Set(seedIds);
    let frontier = [...seedIds];
    const edges: GraphEdge[] = [];
    for (let level = 0; level < depth && frontier.length && seen.size < maxNodes; level += 1) {
      const placeholders = frontier.map(() => "?").join(",");
      const edgeRows = this.query<Record<string, unknown>>(`
        SELECT source, target, kind, line, metadata
        FROM edges
        WHERE (source IN (${placeholders}) OR target IN (${placeholders}))
          AND EXISTS (SELECT 1 FROM nodes sn JOIN allowed_files sa ON sa.path = sn.file_path WHERE sn.id = edges.source)
          AND EXISTS (SELECT 1 FROM nodes tn JOIN allowed_files ta ON ta.path = tn.file_path WHERE tn.id = edges.target)
          AND kind IN ('calls','references','instantiates','implements','extends')
        ORDER BY kind, source, target
        LIMIT ?
      `, [...frontier, ...frontier, Math.max(maxNodes * 8, 500)]);
      const next: string[] = [];
      for (const row of edgeRows) {
        const edge = toEdge(row);
        edges.push(edge);
        for (const id of [edge.source, edge.target]) {
          if (!seen.has(id) && seen.size < maxNodes) { seen.add(id); next.push(id); }
        }
      }
      frontier = next;
    }
    if (!seen.size) return { nodes: [], edges };
    const ids = [...seen];
    const nodes: GraphNode[] = [];
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400);
      const placeholders = batch.map(() => "?").join(",");
      nodes.push(...this.query<Record<string, unknown>>(`
        SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, docstring, signature
        FROM nodes WHERE id IN (${placeholders}) AND EXISTS (SELECT 1 FROM allowed_files a WHERE a.path = nodes.file_path) ORDER BY file_path, start_line
      `, batch).map(toNode));
    }
    return { nodes, edges };
  }

  /**
   * Every relationship edge whose BOTH endpoints lie inside the given node set — the "edges among
   * pool" closure that BFS misses (a level expansion never captures an edge between two same-level
   * nodes). Reuses expand's allowed_files join so no edge crosses the module boundary, and the same
   * five relationship kinds. Source ids are chunked well under SQLite's 999-parameter limit; targets
   * are filtered to the pool in memory. A running total cap bounds the result, and if the query
   * budget is already spent the closure is skipped gracefully (it is an enrichment, never essential).
   */
  edgesAmong(nodeIds: string[]): GraphEdge[] {
    const pool = new Set(nodeIds.map(String));
    if (pool.size === 0) return [];
    const ids = [...pool].sort();
    const totalLimit = Math.max(pool.size * 8, 2000);
    const seen = new Set<string>();
    const edges: GraphEdge[] = [];
    for (let offset = 0; offset < ids.length && edges.length < totalLimit; offset += 900) {
      if (this.budget.queries >= this.budget.max) break; // budget spent: skip the rest gracefully
      const chunk = ids.slice(offset, offset + 900);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.query<Record<string, unknown>>(`
        SELECT e.source, e.target, e.kind, e.line, e.metadata
        FROM edges e
        JOIN nodes sn ON sn.id = e.source JOIN allowed_files sa ON sa.path = sn.file_path
        JOIN nodes tn ON tn.id = e.target JOIN allowed_files ta ON ta.path = tn.file_path
        WHERE e.source IN (${placeholders})
          AND e.kind IN ('calls','references','instantiates','implements','extends')
        ORDER BY e.kind, e.source, e.target
        LIMIT ?
      `, [...chunk, totalLimit]);
      for (const row of rows) {
        if (!pool.has(String(row.target))) continue; // both endpoints must be in the pool
        const key = `${String(row.source)}\u0001${String(row.target)}\u0001${String(row.kind)}\u0001${row.line ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(toEdge(row));
        if (edges.length >= totalLimit) break;
      }
    }
    return edges;
  }

  routeSummary(limit = 80): GraphNode[] {
    return this.query<Record<string, unknown>>(`
      WITH ranked AS (
        SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, docstring, signature,
          CASE WHEN instr(file_path, '/') > 0 THEN substr(file_path, 1, instr(file_path, '/') - 1) ELSE '.' END AS root,
          ROW_NUMBER() OVER (
            PARTITION BY CASE WHEN instr(file_path, '/') > 0 THEN substr(file_path, 1, instr(file_path, '/') - 1) ELSE '.' END
            ORDER BY file_path, start_line
          ) AS rn
        FROM nodes WHERE kind = 'route' AND EXISTS (SELECT 1 FROM allowed_files a WHERE a.path = nodes.file_path)
      )
      SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, docstring, signature
      FROM ranked WHERE rn <= 20 ORDER BY root, file_path, start_line LIMIT ?
    `, [limit]).map(toNode);
  }


  unresolvedForNodeIds(nodeIds: string[], limit = 200): Array<Record<string, unknown>> {
    if (!nodeIds.length) return [];
    const placeholders = nodeIds.map(() => "?").join(",");
    return this.query<Record<string, unknown>>(`
      SELECT from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, status
      FROM unresolved_refs WHERE from_node_id IN (${placeholders}) AND EXISTS (SELECT 1 FROM allowed_files a WHERE a.path = unresolved_refs.file_path) ORDER BY file_path, line LIMIT ?
    `, [...nodeIds, limit]);
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

function toNode(row: Record<string, unknown>): GraphNode {
  return {
    id: String(row.id), kind: String(row.kind), name: String(row.name), qualifiedName: String(row.qualified_name),
    filePath: String(row.file_path), language: String(row.language), startLine: Number(row.start_line), endLine: Number(row.end_line),
    docstring: row.docstring == null ? null : String(row.docstring), signature: row.signature == null ? null : String(row.signature)
  };
}

function toEdge(row: Record<string, unknown>): GraphEdge {
  return { source: String(row.source), target: String(row.target), kind: String(row.kind), line: row.line == null ? null : Number(row.line), metadata: parseJsonObject(row.metadata) };
}

function normalizePath(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/"); }
