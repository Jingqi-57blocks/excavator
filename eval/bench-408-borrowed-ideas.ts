// Two borrowed ideas, evaluated deterministically and offline with no new dependency: Graphify's p99
// degree pre-exclusion, and Aider RepoMap's PageRank + budget ordering. Both occupy the same slot as
// `maxFeatureNodes` — they choose WHICH nodes survive the budget — so they are measured against the same
// boundary gold as the shipped prune, on the same frozen pool.
import { loadPrunePool, prunePoolToNodes } from "./prune-replay.ts";
import { boundaryRecall } from "./boundary.ts";
import { loadBoundaryGold } from "./boundary-gold.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const POOL = join(HERE, "fixtures", "wcp-leave", "prune-pool-frontend.json.gz");
const GOLD = loadBoundaryGold(join(HERE, "fixtures", "wcp-leave", "boundary-gold-frontend.json"));

const pool = loadPrunePool(POOL);
const key = (n: any): string => String(n.id ?? `${n.filePath}:${n.startLine}:${n.name}`);

function degrees(nodes: any[], edges: any[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const n of nodes) d.set(key(n), 0);
  for (const e of edges) {
    for (const side of [String(e.source), String(e.target)]) d.set(side, (d.get(side) ?? 0) + 1);
  }
  return d;
}

function report(label: string, nodes: Array<{ filePath: string; name: string; startLine?: number; endLine?: number }>) {
  const r = boundaryRecall(nodes, GOLD);
  const ui = nodes.filter((n) => n.filePath.startsWith("wcp-ui")).length;
  console.log(`${label.padEnd(34)} mustFind ${r.summary.mustFindFound}/${r.summary.mustFind}  optional ${r.summary.optionalFound}/${r.summary.optional}  nodes ${r.summary.nodeCount}  files ${r.summary.fileCount}  ui ${ui}`);
  return r;
}

// Baseline: the shipped prune on this pool.
report("A' 现役剪枝(前端池)", prunePoolToNodes(pool));

// Experiment 1 — Graphify's `--exclude-hubs`: drop the top 1% by degree from the CANDIDATE POOL before
// pruning. The idea is that a hub belongs to no feature, so letting it into the budget crowds out real
// members. Our prune排 hub by bridge-signal direction (57B-371) but has no pool-level degree pre-filter.
const deg = degrees(pool.nodes, pool.edges);
for (const pct of [99, 95]) {
  const sorted = [...deg.values()].sort((a, b) => a - b);
  const cut = sorted[Math.floor((sorted.length - 1) * (pct / 100))];
  const kept = pool.nodes.filter((n) => (deg.get(key(n)) ?? 0) <= cut);
  const keptIds = new Set(kept.map((n) => key(n)));
  const edges = pool.edges.filter((e) => keptIds.has(String(e.source)) && keptIds.has(String(e.target)));
  const seeds = pool.seeds.filter((s: any) => keptIds.has(key(s)));
  report(`E1 排除 p${pct} hub (阈值 deg>${cut})`, prunePoolToNodes({ ...pool, nodes: kept, edges, seeds }));
}

// Experiment 2 — Aider RepoMap's ordering: rank the whole pool by PageRank over the closure edges and take
// the budget's worth, instead of the shipped prune's seed-expansion + anchor scoring.
function pagerank(nodes: any[], edges: any[], damping = 0.85, iterations = 40): Map<string, number> {
  const ids = nodes.map(key);
  const index = new Map(ids.map((id, i) => [id, i]));
  const out: number[] = new Array(ids.length).fill(0);
  const incoming: Array<Array<number>> = ids.map(() => []);
  for (const e of edges) {
    const s = index.get(String(e.source)); const t = index.get(String(e.target));
    if (s === undefined || t === undefined) continue;
    out[s] += 1; incoming[t].push(s);
  }
  let rank = new Array(ids.length).fill(1 / ids.length);
  for (let it = 0; it < iterations; it += 1) {
    const next = new Array(ids.length).fill((1 - damping) / ids.length);
    for (let t = 0; t < ids.length; t += 1) {
      for (const s of incoming[t]) if (out[s] > 0) next[t] += damping * rank[s] / out[s];
    }
    rank = next;
  }
  return new Map(ids.map((id, i) => [id, rank[i]]));
}

const pr = pagerank(pool.nodes, pool.edges);
const ranked = [...pool.nodes].sort((a, b) => (pr.get(key(b)) ?? 0) - (pr.get(key(a)) ?? 0) || key(a).localeCompare(key(b)));
report("E2 PageRank top-250", ranked.slice(0, pool.maxFeatureNodes).map((n) => ({ filePath: String(n.filePath), name: String(n.name ?? ""), startLine: Number(n.startLine), endLine: Number(n.endLine) })));

// Seeded variant: seeds are pinned in, PageRank fills the rest — the honest comparison, since the shipped
// prune is seeded too and an unseeded ranker is solving a different problem.
const seedKeys = new Set(pool.seeds.map(key));
const seedNodes = pool.nodes.filter((n) => seedKeys.has(key(n)));
const rest = ranked.filter((n) => !seedKeys.has(key(n))).slice(0, Math.max(0, pool.maxFeatureNodes - seedNodes.length));
report("E2' 种子 + PageRank 补足", [...seedNodes, ...rest].map((n) => ({ filePath: String(n.filePath), name: String(n.name ?? ""), startLine: Number(n.startLine), endLine: Number(n.endLine) })));
