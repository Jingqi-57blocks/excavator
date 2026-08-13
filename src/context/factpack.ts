import type { GraphReader } from "../codegraph/codegraph.ts";
import { BRIDGE_MAX_MULTIPLICITY } from "./feature-prune.ts";
import { logicClaimKey, logicItems, type LogicFeatureGraph } from "./factpack-logic.ts";
import type { ScannedFile } from "../snapshot/snapshot.ts";
import type { SourceReader } from "../snapshot/source.ts";
import { sourceSearch } from "../snapshot/source.ts";
import type { EvidenceItem, FactPackCategory, FactPackCoverage, FactPackItem, FactPackMethod, FeatureFactPack, GraphNode } from "../core/types.ts";
import type { Deadline } from "../core/util.ts";
import { sha256, stableJson } from "../core/util.ts";

const DETAIL_LIMIT = 200;
const NAME_LIMIT = 120;
const DEFAULT_MAX_ITEMS_PER_CATEGORY = 500;
const DEFAULT_MAX_ENTITY_WINDOWS = 20;
const ENTITY_WINDOW_LINES = 60;
const ENTITY_FIELD_LINES = 12;
/** `sourceSearch` stops after this many matched lines per file; a file at the cap may hide further facts. */
const SCAN_FILE_MATCH_CAP = 20;
/** Ceiling for one kind-in-boundary graph query; reaching it is reported, never swallowed. */
const GRAPH_QUERY_LIMIT = 500;

const ENTITY_NODE_KINDS = ["class", "interface", "model"];
const ENTITY_PATH_PATTERN = /model|entity|schema|migration/i;
const ENTITY_FIELD_PATTERNS: RegExp[] = [
  /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|export\s+)?[A-Za-z_$][\w$]*\??\s*:\s*[^\s;,{]/,
  /DataTypes\./,
  /@Column/
];

interface ScanStrategy {
  patterns: string[];
  caseSensitive: boolean;
}

interface CategoryStrategy {
  category: FactPackCategory;
  /** Node kinds queried by kind across the whole boundary, not filtered out of a scored scope set. */
  graphKinds: string[] | null;
  /** Narrows the queried files before the graph is asked, so the query ceiling is spent on candidates. */
  graphPathFilter?: RegExp;
  scan: ScanStrategy | null;
  /** Config keys collapse by key name; every other category collapses by source location. */
  dedupeBy: "location" | "name";
}

const CATEGORY_STRATEGIES: CategoryStrategy[] = [
  {
    category: "entrypoints",
    graphKinds: ["route"],
    dedupeBy: "location",
    scan: {
      caseSensitive: true,
      patterns: [
        "\\b(?:app|api|server|router|route)\\.(?:get|post|put|patch|delete|options|head|all)\\s*\\(",
        "\\.Map(?:Get|Post|Put|Patch|Delete)\\s*\\(",
        "\\.HandleFunc\\s*\\(",
        "@(?:Get|Post|Put|Patch|Delete)Mapping\\b",
        "@RequestMapping\\b",
        "@(?:Get|Post|Put|Patch|Delete|Options|Head|All)\\s*\\(",
        "@\\w+\\.route\\s*\\(",
        "addEventListener\\(\\s*[\"']fetch[\"']",
        "\\.command\\s*\\(",
        "export\\s+(?:default\\s+)?(?:async\\s+)?function\\s+(?:GET|POST|PUT|PATCH|DELETE)\\b"
      ]
    }
  },
  {
    category: "entities",
    graphKinds: ENTITY_NODE_KINDS,
    graphPathFilter: ENTITY_PATH_PATTERN,
    dedupeBy: "location",
    scan: null
  },
  {
    category: "states",
    graphKinds: ["enum"],
    dedupeBy: "location",
    scan: {
      caseSensitive: true,
      patterns: [
        "\\benum\\s+[A-Za-z_]",
        "\\b(?:const|let|var|final|static|val)\\s+[\\w$]*(?:Status|State|STATUS|STATE)[\\w$]*\\s*[:=]",
        "\\b(?:type|interface|class)\\s+[A-Za-z_$][\\w$]*(?:Status|State)[\\w$]*\\b",
        "\\b(?:STATUS|STATE)_[A-Z0-9_]+\\s*[:=]",
        "\\bclass\\s+\\w+\\(\\s*[\\w., ]*Enum"
      ]
    }
  },
  {
    category: "config-keys",
    graphKinds: null,
    dedupeBy: "name",
    scan: {
      caseSensitive: true,
      patterns: [
        "process\\.env\\.[A-Za-z_][\\w]*",
        "process\\.env\\[\\s*[\"'][^\"']+[\"']",
        "os\\.environ(?:\\.get\\(|\\[)\\s*[\"'][^\"']+[\"']",
        "os\\.getenv\\(\\s*[\"'][^\"']+[\"']",
        "System\\.getenv\\(\\s*[\"'][^\"']+[\"']",
        "\\b[Gg]etenv\\(\\s*[\"'][^\"']+[\"']",
        "Deno\\.env\\.get\\(\\s*[\"'][^\"']+[\"']",
        "\\b[Cc]onfig\\.[Gg]et\\w*\\(\\s*[\"'][^\"']+[\"']",
        "\\benv\\(\\s*[\"'][^\"']+[\"']",
        "@Value\\(\\s*[\"']\\$\\{[^}]+\\}"
      ]
    }
  },
  {
    category: "jobs",
    graphKinds: null,
    dedupeBy: "location",
    scan: {
      caseSensitive: false,
      patterns: [
        "\\bsetInterval\\s*\\(",
        "@Scheduled\\b",
        "@Cron\\b",
        "\\bcron\\.schedule\\s*\\(",
        "\\bnode-cron\\b",
        "\\bnew\\s+CronJob\\b",
        "\\bscheduleJob\\s*\\(",
        "\\.schedule\\s*\\(",
        "\\bcrontab\\b",
        "\\bcron(?:_|-)?expression\\b",
        "\\b(?:cron|schedule)\\s*:\\s*[\"']"
      ]
    }
  },
  {
    category: "external-calls",
    graphKinds: null,
    dedupeBy: "location",
    scan: {
      caseSensitive: false,
      // Call sites, not vocabulary: bare `webhook`/`notification` match prose and identifier
      // lists, and a fact pack that reports documentation as an integration is worse than silence.
      patterns: [
        "\\bfetch\\s*\\(",
        "\\baxios\\b",
        "\\bhttps?\\.(?:request|get|post)\\s*\\(",
        "\\brequests\\.(?:get|post|put|delete)\\s*\\(",
        "\\bhttpclient\\b",
        "\\bsend_?mail\\w*\\s*\\(",
        "\\bnodemailer\\b",
        "\\b\\w*webhook\\w*\\s*\\(",
        "[\"'][^\"'\\s]*webhook[^\"'\\s]*[\"']",
        "\\b\\w*notif(?:y|ication)\\w*\\s*\\("
      ]
    }
  },
  // The `logic` complement, appended LAST so the claimed set already covers the six kind/scan categories
  // before it runs. It is neither graph-kind-queried nor scanned: the enumeration loop special-cases it to
  // `logicItems`, which enumerates the pruned feature-graph nodes the six categories did not claim.
  {
    category: "logic",
    graphKinds: null,
    dedupeBy: "location",
    scan: null
  }
];

/** Fixed category order, derived from the strategies so coverage rows and item sorting cannot drift apart. */
export const FACT_PACK_CATEGORIES: FactPackCategory[] = CATEGORY_STRATEGIES.map((strategy) => strategy.category);

/** Per-caller in-degree cap for logic ordering, mirroring the prune's bridge multiplicity so both agree. */
const LOGIC_INDEGREE_CAP = BRIDGE_MAX_MULTIPLICITY;
/** Inline-window row cap for the deeper logic complement; the full pack stays in factpack.json. */
const LOGIC_RENDER_ROWS = 120;
/** Kinds no kind-based category owns yet are still structural noise, not feature symbols. */
const LOGIC_STRUCTURAL_KINDS = ["import", "file"];

/** Kinds a kind-based category already claims (derived from CATEGORY_STRATEGIES graphKinds), plus import/file.
 *  Derived at runtime so a future kind-category automatically shrinks the logic complement. */
function logicExcludedKinds(): Set<string> {
  const kinds = new Set<string>(LOGIC_STRUCTURAL_KINDS);
  for (const strategy of CATEGORY_STRATEGIES) if (strategy.graphKinds) for (const kind of strategy.graphKinds) kinds.add(kind);
  return kinds;
}

/** The entrypoint kinds whose out-edges promote a target into the logic attention tier for called functions. */
function logicRouteKinds(): Set<string> {
  return new Set(CATEGORY_STRATEGIES.find((strategy) => strategy.category === "entrypoints")?.graphKinds ?? []);
}

/**
 * The `logic` complement items a feature's fact pack adds: the pruned feature-graph nodes the six
 * structural categories did not already claim. `claimedItems` is those categories' emitted items, so the
 * exact (filePath, line) each one occupies is excluded here. Exposed so the eval replay measures exactly
 * what production emits, over the same runtime-derived kind sets.
 */
export function featureLogicItems(featureGraph: LogicFeatureGraph, claimedItems: Array<{ filePath: string; line: number }>): FactPackItem[] {
  const claimedLocations = new Set(claimedItems.map((item) => logicClaimKey(item.filePath, item.line)));
  return logicItems(featureGraph, { claimedLocations, excludedKinds: logicExcludedKinds(), routeKinds: logicRouteKinds(), cap: LOGIC_INDEGREE_CAP });
}

/** Ordered key extractors for config-key names; every capture on a matched line becomes one item. */
const CONFIG_KEY_PATTERNS: RegExp[] = [
  /process\.env\.([A-Za-z_][\w]*)/g,
  /process\.env\[\s*["']([^"']+)["']/g,
  /(?:os\.environ(?:\.get\()?|os\.getenv\(|System\.getenv\(|[Gg]etenv\(|Deno\.env\.get\(|[Cc]onfig\.[Gg]et\w*\(|\benv\()\s*\[?\s*["']([^"']+)["']/g,
  /@Value\(\s*["']\$\{([^:}]+)/g
];

export interface FactPackInput {
  snapshotId: string;
  featureKey: string;
  /** The boundary: scanned files of the feature scope. Both graph and scan enumerate over exactly these. */
  files: ScannedFile[];
  graph: GraphReader | null;
  sourceReader: SourceReader;
  deadline?: Deadline;
  /** The upstream feature node cap was reached, so the boundary file set itself may be short. */
  scopeNodesCapped?: boolean;
  /** The pruned feature graph, when one was built. The `logic` category enumerates the complement of
   *  these retained nodes; absent it, `logic` is honestly empty (method `none`). */
  featureGraph?: LogicFeatureGraph;
  limits?: { maxItemsPerCategory?: number; maxEntityWindows?: number };
}

/**
 * Enumerate the six fact categories inside one feature boundary.
 *
 * The pack is an enumeration, not a sample. Graph-backed categories are asked of the index by
 * kind across the whole boundary rather than filtered out of the scored, capped feature scope,
 * so a route the scope ranking dropped is still enumerated. Source scanning fills the categories
 * the graph cannot answer. Everything a budget cuts is reported through `coverage.truncated`, a
 * coverage note and a warning; nothing is dropped silently. The boundary is the feature scope
 * only — facts outside it are not this artifact's claim.
 */
export async function buildFactPack(input: FactPackInput): Promise<FeatureFactPack> {
  const maxItems = Math.max(1, input.limits?.maxItemsPerCategory ?? DEFAULT_MAX_ITEMS_PER_CATEGORY);
  const maxEntityWindows = Math.max(0, input.limits?.maxEntityWindows ?? DEFAULT_MAX_ENTITY_WINDOWS);
  const boundaryPaths = [...new Set(input.files.map((file) => normalizePath(file.relativePath)))].sort(compareStrings);
  const items: FactPackItem[] = [];
  const coverage: FactPackCoverage[] = [];
  const warnings: string[] = [];
  let entityWindowsUsed = 0;

  for (const strategy of CATEGORY_STRATEGIES) {
    input.deadline?.check(`building the ${strategy.category} fact pack`);
    const notes: string[] = [];
    const collected: FactPackItem[] = [];

    if (input.graph && strategy.graphKinds) {
      const queried = strategy.graphPathFilter ? boundaryPaths.filter((path) => strategy.graphPathFilter!.test(path)) : boundaryPaths;
      const graphNodes = input.graph.nodesByKindInFiles(strategy.graphKinds, queried, GRAPH_QUERY_LIMIT).sort(compareNodes);
      if (graphNodes.length >= GRAPH_QUERY_LIMIT) {
        notes.push(`the graph query for ${strategy.graphKinds.join("/")} nodes returned its ${GRAPH_QUERY_LIMIT}-node ceiling across ${queried.length} boundary files`);
      }
      const wantsFieldDetail = strategy.category === "entities";
      let windowBudgetSpent = false;
      for (const node of graphNodes) {
        const item: FactPackItem = {
          category: strategy.category,
          name: clip(String(node.name || node.qualifiedName || node.id), NAME_LIMIT),
          filePath: normalizePath(String(node.filePath)),
          line: Number(node.startLine) || 1,
          endLine: Number(node.endLine) || undefined,
          detail: node.signature ? clip(collapse(String(node.signature)), DETAIL_LIMIT) : undefined,
          source: "graph"
        };
        if (wantsFieldDetail && !windowBudgetSpent && entityWindowsUsed < maxEntityWindows) {
          entityWindowsUsed += 1;
          const fields = await entityFields(input, item.filePath, item.line);
          if (fields.detail) item.detail = fields.detail;
          if (fields.error) {
            windowBudgetSpent = true;
            notes.push(`entity field windows stopped at ${item.filePath}:${item.line}: ${fields.error}`);
          }
        }
        collected.push(item);
      }
      if (wantsFieldDetail && graphNodes.length > maxEntityWindows) {
        notes.push(`entity field windows capped at ${maxEntityWindows}; ${graphNodes.length - maxEntityWindows} later entities carry only their graph signature`);
      }
      // The upstream feature-scope node cap shortens the graph node set (and the boundary derived from
      // it) that this graph-backed category enumerated over, so its enumeration may be short. Scan-only
      // categories never consult the capped node set, so the note must not truncate them (57B-354).
      if (input.scopeNodesCapped) notes.push("the feature scope node cap was reached upstream, so the graph node set this category was enumerated over may be short");
    }

    if (strategy.scan) {
      const scanned = await scanCategory(strategy, input.files, maxItems, notes);
      collected.push(...scanned);
    }

    // `logic` is the complement enumeration: every pruned feature-graph node the six kind/scan categories
    // above did not already claim. `items` already holds those six categories' retained items (logic runs
    // LAST), so their exact locations are the claim set this excludes.
    if (strategy.category === "logic" && input.featureGraph && input.featureGraph.nodes.length) {
      collected.push(...featureLogicItems(input.featureGraph, items));
    }

    const deduped = dedupe(collected, strategy.dedupeBy);
    const dropped = deduped.length - maxItems;
    if (dropped > 0) notes.push(`item cap ${maxItems} reached; ${dropped} further ${strategy.category} item${dropped === 1 ? " was" : "s were"} dropped`);
    const retained = deduped.slice(0, maxItems);
    // Every note this build records is a limit that cut the enumeration, so a note means truncated.
    const truncated = notes.length > 0;
    if (truncated) warnings.push(`Fact pack category ${strategy.category} is incomplete: ${notes.join("; ")}`);
    items.push(...retained);
    coverage.push({
      category: strategy.category,
      method: methodFor(strategy, Boolean(input.graph), Boolean(input.featureGraph?.nodes.length)),
      itemCount: retained.length,
      truncated,
      note: notes.length ? notes.join("; ") : undefined
    });
  }

  // A rescued feature-graph node whose exact location a structural category already claimed is excluded
  // from the `logic` complement, so its rescue reason would be lost. Propagate the reason onto the claiming
  // structural item's `signal` so the rescue still reaches the author (57B-372 follow-up #3). Logic items
  // already carry their own signal; only unsignaled structural items are annotated.
  if (input.featureGraph?.nodes.length) {
    const rescuedByLocation = new Map<string, string>();
    for (const node of input.featureGraph.nodes) {
      const rescued = typeof node.rescued === "string" && (node.rescued as string).length ? clip(collapse(String(node.rescued)), DETAIL_LIMIT) : undefined;
      if (rescued) rescuedByLocation.set(logicClaimKey(node.filePath, node.startLine), rescued);
    }
    if (rescuedByLocation.size) {
      for (const item of items) {
        if (item.category === "logic" || item.signal) continue;
        const reason = rescuedByLocation.get(logicClaimKey(item.filePath, item.line));
        if (reason) item.signal = reason;
      }
    }
  }

  return {
    version: "factpack-v1",
    snapshotId: input.snapshotId,
    featureKey: input.featureKey,
    items: items.sort(compareItems),
    coverage,
    warnings
  };
}

export function factPackEvidenceId(featureKey: string, category: FactPackCategory, snapshotId: string): string {
  return `FACT-${featureKey.slice(0, 10)}-${category}-${snapshotId.slice(0, 8)}`;
}

/** One derived evidence item per category, including empty categories: an empty enumeration is a fact too. */
export function factPackEvidence(pack: FeatureFactPack): EvidenceItem[] {
  return pack.coverage.map((coverage) => {
    const data = { category: coverage.category, coverage, items: pack.items.filter((item) => item.category === coverage.category) };
    return {
      id: factPackEvidenceId(pack.featureKey, coverage.category, pack.snapshotId),
      snapshotId: pack.snapshotId,
      kind: "derived" as const,
      title: `Fact pack: ${coverage.category}`,
      data,
      reason: `enumerate every ${coverage.category} fact found inside the feature boundary, with its coverage limits`,
      digest: sha256(stableJson(data))
    };
  });
}

export function renderFactPackSection(pack: FeatureFactPack, maxRowsPerCategory = 60): string {
  const rows = pack.coverage.map((coverage) => [
    coverage.category,
    coverage.method,
    String(coverage.itemCount),
    coverage.truncated ? "yes" : "no",
    factPackEvidenceId(pack.featureKey, coverage.category, pack.snapshotId),
    cell(coverage.note ?? "—")
  ].join(" | "));
  const blocks = pack.coverage.map((coverage) => {
    const categoryItems = pack.items.filter((item) => item.category === coverage.category);
    // The logic complement is deeper than the six structural categories (tier 0 + tier 1 alone can exceed
    // 40), so its inline window is wider; the machine-readable pack still carries every item.
    const rowCap = coverage.category === "logic" ? LOGIC_RENDER_ROWS : maxRowsPerCategory;
    const shown = categoryItems.slice(0, rowCap);
    const header = `### ${coverage.category} — ${coverage.itemCount} item${coverage.itemCount === 1 ? "" : "s"}, method ${coverage.method}, evidence ${factPackEvidenceId(pack.featureKey, coverage.category, pack.snapshotId)}`;
    const empty = coverage.method === "none"
      ? "No method was available for this category in this run, so it was not enumerated; absence here is not evidence of absence in the code."
      : "No item of this category was found inside the feature boundary.";
    const body = shown.length
      ? [
        "| Name | Location | Source | Detail |",
        "|---|---|---|---|",
        ...shown.map((item) => `| ${cell(item.name)} | \`${cell(item.filePath)}:${item.line}${item.endLine && item.endLine !== item.line ? `-${item.endLine}` : ""}\` | ${item.source} | ${cell(detailWithSignal(item))} |`)
      ].join("\n")
      : empty;
    const remainder = categoryItems.length > shown.length ? `\n\n其余 ${categoryItems.length - shown.length} 条见 factpack.json` : "";
    const note = coverage.truncated ? `\n\nTruncated: ${cell(coverage.note ?? "budget or cap reached")}` : "";
    return `${header}\n\n${body}${remainder}${note}`;
  });
  return `## Fact pack

Enumerated boundary facts. Every category is an enumeration of what was found inside this feature's boundary, not a sample; facts outside the boundary are out of this pack's scope. The complete machine-readable pack is \`context/features/${pack.featureKey}.factpack.json\`.

| Category | Method | Items | Truncated | Evidence | Note |
|---|---|---:|---|---|---|
${rows.map((row) => `| ${row} |`).join("\n")}

Fact pack warnings: ${pack.warnings.length ? pack.warnings.map((warning) => cell(warning)).join(" | ") : "none"}

${blocks.join("\n\n")}`;
}

async function scanCategory(strategy: CategoryStrategy, files: ScannedFile[], maxItems: number, notes: string[]): Promise<FactPackItem[]> {
  const scan = strategy.scan!;
  if (!files.length) return [];
  const matches = await sourceSearch(files, scan.patterns, { regex: true, caseSensitive: scan.caseSensitive, maxResults: maxItems });
  if (matches.length >= maxItems) notes.push(`source scan returned the maximum ${maxItems} matches`);
  const perFile = new Map<string, number>();
  for (const match of matches) perFile.set(match.file.relativePath, (perFile.get(match.file.relativePath) ?? 0) + 1);
  for (const [path, count] of [...perFile.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (count >= SCAN_FILE_MATCH_CAP) notes.push(`${path} reached the per-file scan cap (${SCAN_FILE_MATCH_CAP} matches); further matches in that file were not read`);
  }
  const items: FactPackItem[] = [];
  for (const match of matches) {
    const line = matchedLine(match.excerpt, match.line);
    const filePath = normalizePath(match.file.relativePath);
    if (strategy.category === "config-keys") {
      for (const key of configKeys(line)) {
        items.push({ category: strategy.category, name: clip(key, NAME_LIMIT), filePath, line: match.line, detail: clip(collapse(line), DETAIL_LIMIT), source: "scan" });
      }
      continue;
    }
    items.push({
      category: strategy.category,
      name: clip(scanItemName(line, scan), NAME_LIMIT),
      filePath,
      line: match.line,
      detail: clip(collapse(line), DETAIL_LIMIT),
      source: "scan"
    });
  }
  return items;
}

async function entityFields(input: FactPackInput, path: string, startLine: number): Promise<{ detail?: string; error?: string }> {
  try {
    const window = await input.sourceReader.window(path, startLine, startLine + ENTITY_WINDOW_LINES - 1, "extract the declared fields of a feature entity for the fact pack");
    const fields: string[] = [];
    for (const line of window.content.split(/\r?\n/).slice(1)) {
      if (fields.length >= ENTITY_FIELD_LINES) break;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (ENTITY_FIELD_PATTERNS.some((pattern) => pattern.test(line))) fields.push(collapse(trimmed).replace(/[;,]$/, ""));
    }
    return { detail: fields.length ? clip(fields.join("; "), DETAIL_LIMIT) : undefined };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function methodFor(strategy: CategoryStrategy, hasGraph: boolean, hasFeatureGraph: boolean): FactPackMethod {
  // `logic` is graph-derived through the pruned feature graph, not a kind query or a scan; it is honestly
  // empty (method none) when no feature graph was built, so absence there reads as "not enumerated".
  if (strategy.category === "logic") return hasFeatureGraph ? "graph" : "none";
  const graph = hasGraph && strategy.graphKinds !== null;
  if (graph && strategy.scan) return "graph+scan";
  if (graph) return "graph";
  if (strategy.scan) return "scan";
  return "none";
}

/**
 * Two hits on one line are one fact, so location collapsing is silent. A config key found in
 * several places is one key with several call sites, so name collapsing keeps the count visible.
 */
function dedupe(items: FactPackItem[], by: "location" | "name"): FactPackItem[] {
  const seen = new Map<string, FactPackItem>();
  const order: string[] = [];
  const extra = new Map<string, number>();
  for (const item of [...items].sort(compareItems)) {
    const key = by === "name" ? `${item.category}|${item.name}` : `${item.category}|${item.filePath}|${item.line}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
      order.push(key);
      continue;
    }
    extra.set(key, (extra.get(key) ?? 0) + 1);
    // A graph node carries structure a scanned line cannot; it wins the location.
    if (existing.source === "scan" && item.source === "graph") seen.set(key, item);
  }
  return order.map((key) => {
    const item = seen.get(key)!;
    const others = by === "name" ? extra.get(key) ?? 0 : 0;
    if (!others) return item;
    return { ...item, detail: clip(`${item.detail ?? ""}${item.detail ? " " : ""}(+${others} further occurrence${others === 1 ? "" : "s"})`, DETAIL_LIMIT) };
  });
}

function configKeys(line: string): string[] {
  const keys: string[] = [];
  for (const pattern of CONFIG_KEY_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      const key = match[1]?.trim();
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

function scanItemName(line: string, scan: ScanStrategy): string {
  for (const pattern of scan.patterns) {
    const expression = new RegExp(pattern, scan.caseSensitive ? "" : "i");
    const match = expression.exec(line);
    if (!match) continue;
    const token = collapse(match[0]).replace(/[\s(]+$/, "");
    const rest = line.slice(match.index + match[0].length);
    const literal = /^[\s(,]*["'`]([^"'`\n]{1,80})["'`]/.exec(rest)?.[1];
    return literal ? `${token} ${literal}` : token;
  }
  return collapse(line);
}

/** `sourceSearch` returns the matched line with one line of context on each side. */
function matchedLine(excerpt: string, line: number): string {
  const lines = excerpt.split(/\r?\n/);
  return (line === 1 ? lines[0] : lines[1]) ?? lines[0] ?? "";
}

function compareItems(a: FactPackItem, b: FactPackItem): number {
  const byCategory = FACT_PACK_CATEGORIES.indexOf(a.category) - FACT_PACK_CATEGORIES.indexOf(b.category);
  if (byCategory) return byCategory;
  // Within a category an explicit rank orders first — logic items carry the deterministic attention order
  // the enumeration assigned; the six structural categories carry no rank and fall straight to location.
  if (a.rank !== undefined && b.rank !== undefined && a.rank !== b.rank) return a.rank - b.rank;
  return compareStrings(a.filePath, b.filePath)
    || a.line - b.line
    || compareStrings(a.name, b.name)
    || compareStrings(a.source, b.source);
}

function compareNodes(a: GraphNode, b: GraphNode): number {
  return compareStrings(String(a.filePath), String(b.filePath))
    || (Number(a.startLine) || 0) - (Number(b.startLine) || 0)
    || compareStrings(String(a.name), String(b.name));
}

/** Code-unit ordering, not locale ordering: the same snapshot must produce the same bytes anywhere. */
function compareStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** A logic item's Detail cell surfaces its rescue signal so the author knows to disposition it individually. */
function detailWithSignal(item: FactPackItem): string {
  if (item.signal) return item.detail ? `${item.detail} · rescued: ${item.signal}` : `rescued: ${item.signal}`;
  return item.detail ?? "—";
}

function normalizePath(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\/+/, ""); }
function collapse(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function clip(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }
function cell(value: string): string { return collapse(value).replaceAll("|", "\\|"); }
