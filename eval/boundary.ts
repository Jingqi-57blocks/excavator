// Deterministic, zero-model boundary-recall metric. The measured object is the
// FEATURE-GRAPH NODE SET (the output of the allocator), NOT claims and NOT the
// wider evidence file set: 57B-371's intervention point is the prune, so the metric
// must isolate "did the graph capture this material symbol" from downstream fallback
// search. `boundaryRecall` is a pure function of (nodes, gold); the run adapters below
// read evidence.json to produce those nodes (and, in run mode, an informational
// "covered by a source window" signal that never affects the pass/fail verdict).
//
// Path/line anchor semantics are shared with knowledge-diff via diff.ts's exported
// `pathMatches` / `parseLines`, so both tools resolve an anchor identically.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathMatches, parseLines } from "./diff.ts";
import type { BoundaryAnchor, BoundaryGold, BoundaryGoldItem } from "./boundary-gold.ts";

/** A feature-graph node reduced to what boundary matching needs. */
export interface BoundaryNode {
  filePath: string;
  name: string;
  startLine?: number;
  endLine?: number;
}

/** A source (S-*) evidence window: path + line range. Used only for the run-mode informational signal. */
export interface SourceWindow {
  path: string;
  startLine: number;
  endLine: number;
}

export interface BoundaryFound {
  id: string;
  mustFind: boolean;
  /** The node that satisfied the item. */
  via: string;
}

export interface BoundaryMiss {
  id: string;
  mustFind: boolean;
  /** Run mode only: is the miss's anchor covered by any source window (fallback could still reach it)?
   *  Informational — distinguishes "graph missed but downstream may recover" from "fully out of bounds".
   *  Never affects the exit code. Undefined in --nodes mode (no evidence.json to read windows from). */
  coveredBySourceWindow?: boolean;
}

export interface BoundarySummary {
  /** Y: total mustFind items. */
  mustFind: number;
  /** X: mustFind items found in the node set. */
  mustFindFound: number;
  mustFindMissing: number;
  optional: number;
  optionalFound: number;
  optionalMissing: number;
  /** Size of the node set the recall was measured against (for 57B-371 boundedness assertions). */
  nodeCount: number;
  /** Distinct files in the node set. */
  fileCount: number;
  /** The only gate: every mustFind item is in-bounds. */
  pass: boolean;
}

/** Which layer a recall report measured. "fg": the allocator node set (upstream, 57B-370);
 *  "factpack": the fact pack the author actually reads (context/features/*.factpack.json — the
 *  consumption layer, downstream of the FG node set). Optional so `boundaryRecall` stays a pure,
 *  layer-agnostic function; the run/fixture adapters stamp it. */
export type BoundaryLayer = "fg" | "factpack";

export interface BoundaryReport {
  target: string;
  found: BoundaryFound[];
  missing: BoundaryMiss[];
  summary: BoundarySummary;
  /** Set by the layer-aware adapters (fgReportFromRun / factPackReportFromRun); undefined for bare boundaryRecall. */
  layer?: BoundaryLayer;
}

function describeNode(node: BoundaryNode): string {
  if (node.startLine !== undefined && node.endLine !== undefined) {
    return `${node.filePath}::${node.name} [${node.startLine}-${node.endLine}]`;
  }
  return `${node.filePath}::${node.name}`;
}

/** Does a node satisfy a single anchor? path (three-form) + (name exact | lines overlap | path-only). */
function anchorMatchesNode(anchor: BoundaryAnchor, node: BoundaryNode): boolean {
  if (!pathMatches(node.filePath, anchor)) return false;
  if (anchor.name !== undefined) return node.name === anchor.name;
  const range = parseLines(anchor.lines);
  if (!range) return true; // path-only anchor: file presence suffices
  if (node.startLine === undefined || node.endLine === undefined) return false;
  return node.startLine <= range.end && node.endLine >= range.start;
}

/** First node (in order) satisfying any of the item's OR anchors, or null. */
function findNode(item: BoundaryGoldItem, nodes: BoundaryNode[]): BoundaryNode | null {
  for (const node of nodes) {
    if (item.anchors.some((anchor) => anchorMatchesNode(anchor, node))) return node;
  }
  return null;
}

/** Compare a feature-graph node set against a boundary gold. Pure: a deterministic function of its inputs. */
export function boundaryRecall(nodes: BoundaryNode[], gold: BoundaryGold): BoundaryReport {
  const found: BoundaryFound[] = [];
  const missing: BoundaryMiss[] = [];
  for (const item of gold.items) {
    const node = findNode(item, nodes);
    if (node) found.push({ id: item.id, mustFind: item.mustFind, via: describeNode(node) });
    else missing.push({ id: item.id, mustFind: item.mustFind });
  }

  const mustFindItems = gold.items.filter((item) => item.mustFind).length;
  const mustFindFound = found.filter((entry) => entry.mustFind).length;
  const mustFindMissing = missing.filter((entry) => entry.mustFind).length;
  const optional = gold.items.length - mustFindItems;
  const optionalFound = found.length - mustFindFound;
  const optionalMissing = missing.length - mustFindMissing;
  const summary: BoundarySummary = {
    mustFind: mustFindItems,
    mustFindFound,
    mustFindMissing,
    optional,
    optionalFound,
    optionalMissing,
    nodeCount: nodes.length,
    fileCount: new Set(nodes.map((node) => node.filePath)).size,
    pass: mustFindMissing === 0
  };
  return { target: gold.target, found, missing, summary };
}

/** Is any of an item's anchors covered by a source window? (path match; if the anchor has lines, ranges overlap.) */
function anchorCoveredBySource(anchor: BoundaryAnchor, windows: SourceWindow[]): boolean {
  const range = parseLines(anchor.lines);
  return windows.some((window) => {
    if (!pathMatches(window.path, anchor)) return false;
    if (!range) return true; // name-only / path-only anchor: file presence in a window suffices
    return window.startLine <= range.end && window.endLine >= range.start;
  });
}

/** Annotate each miss with `coveredBySourceWindow`. Pure given the report, gold, and windows. */
export function annotateSourceCoverage(report: BoundaryReport, gold: BoundaryGold, windows: SourceWindow[]): BoundaryReport {
  const byId = new Map(gold.items.map((item) => [item.id, item]));
  const missing = report.missing.map((miss) => {
    const item = byId.get(miss.id);
    const covered = item ? item.anchors.some((anchor) => anchorCoveredBySource(anchor, windows)) : false;
    return { ...miss, coveredBySourceWindow: covered };
  });
  return { ...report, missing };
}

/** Exit code: any mustFind miss -> 1; else 0. Errors are the CLI's responsibility (exit 2). */
export function exitCodeFor(report: BoundaryReport): number {
  return report.summary.pass ? 0 : 1;
}

// ---- run / file adapters (I/O boundary) ----

function projectNode(raw: any): BoundaryNode {
  const node: BoundaryNode = { filePath: String(raw.filePath), name: String(raw.name ?? "") };
  if (Number.isFinite(raw.startLine)) node.startLine = raw.startLine;
  if (Number.isFinite(raw.endLine)) node.endLine = raw.endLine;
  return node;
}

function nodeKey(node: BoundaryNode): string {
  return `${node.filePath}\u0000${node.name}\u0000${node.startLine ?? ""}\u0000${node.endLine ?? ""}`;
}

function dedupeNodes(raw: any[]): BoundaryNode[] {
  const out: BoundaryNode[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry.filePath !== "string") continue;
    const node = projectNode(entry);
    const key = nodeKey(node);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return out;
}

/** Is an evidence entry a feature-graph scope catalog? Shape discriminant, NOT id prefix:
 *  a graph entry whose data carries both a `nodes` and a `seeds` array. CG-* / CG-NODES-* are also
 *  `kind:"graph"` but lack this shape (whole-project sampling), and mixing them in would falsely credit
 *  the boundary with nodes the feature graph never selected. */
function isFeatureGraphEntry(entry: any): boolean {
  return entry?.kind === "graph" && Array.isArray(entry?.data?.nodes) && Array.isArray(entry?.data?.seeds);
}

function readEvidenceCatalog(runDir: string): any[] {
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) throw new Error(`run directory not found: ${runDir}`);
  const file = join(runDir, "evidence.json");
  if (!existsSync(file)) throw new Error(`evidence.json not found in ${runDir}`);
  const catalog = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(catalog) ? catalog : catalog.evidence ?? [];
}

function nodesFromCatalog(list: any[]): BoundaryNode[] {
  const raw: any[] = [];
  for (const entry of list) {
    if (isFeatureGraphEntry(entry)) raw.push(...entry.data.nodes);
  }
  return dedupeNodes(raw);
}

function sourceWindowsFromCatalog(list: any[]): SourceWindow[] {
  const windows: SourceWindow[] = [];
  for (const entry of list) {
    if (entry?.kind !== "source" || typeof entry.path !== "string") continue;
    windows.push({
      path: entry.path,
      startLine: Number.isFinite(entry.startLine) ? entry.startLine : 0,
      endLine: Number.isFinite(entry.endLine) ? entry.endLine : Number.MAX_SAFE_INTEGER
    });
  }
  return windows;
}

/** Feature-graph node set of a run (union of every FG scope catalog). The reuse interface for 57B-371:
 *  replay improved-prune output through `boundaryRecall(nodesFromRun(dir), gold)`. */
export function nodesFromRun(runDir: string): BoundaryNode[] {
  return nodesFromCatalog(readEvidenceCatalog(runDir));
}

/** Run-mode report: reads evidence.json once, computes recall, and annotates each miss with the
 *  informational `coveredBySourceWindow` signal from the same evidence snapshot. */
export function boundaryReportFromRun(runDir: string, gold: BoundaryGold): BoundaryReport {
  const list = readEvidenceCatalog(runDir);
  const report = boundaryRecall(nodesFromCatalog(list), gold);
  return annotateSourceCoverage(report, gold, sourceWindowsFromCatalog(list));
}

/** Load a projected node set from a JSON file (the `--nodes` path / a pinned fixture).
 *  Accepts `{ nodes: [...] }` or a bare array; each node keeps filePath/name/startLine/endLine. */
export function loadNodesFile(file: string): BoundaryNode[] {
  if (!existsSync(file)) throw new Error(`nodes file not found: ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : raw?.nodes;
  if (!Array.isArray(list)) throw new Error(`nodes file has no node array: ${file}`);
  return dedupeNodes(list);
}

/** The raw feature-graph evidence of a run (nodes/edges/seeds with their ids intact). The boundary
 *  projection (`nodesFromRun`) discards ids and edges; the fact-pack fixture generator needs the whole
 *  graph, so this exposes it while reusing the same `readEvidenceCatalog` + FG shape discriminant. */
export function rawFeatureGraphFromRun(runDir: string): { seeds: any[]; nodes: any[]; edges: any[] } {
  const fg = readEvidenceCatalog(runDir).find((entry) => isFeatureGraphEntry(entry));
  if (!fg) throw new Error(`no feature-graph evidence entry found in ${runDir}`);
  return { seeds: fg.data.seeds ?? [], nodes: fg.data.nodes ?? [], edges: fg.data.edges ?? [] };
}

// ---- fact-pack (consumption) layer ----
//
// The FG node set (above) is what the allocator selected; the FACT PACK is the projection of it the
// authoring model actually reads (context/features/*.factpack.json). Measuring recall against the fact
// pack — not the FG node set — is the point of 57B-372: a node the boundary fix retained in the FG can
// still be dropped by fact-pack derivation, and only the fact-pack layer sees that.

/** Map fact-pack items to boundary nodes: each item's `name` is the node name gold anchors match,
 *  `line`/`endLine` its window. Deduped like every other node source. `endLine` falls back to `line`. */
export function factPackItemsToNodes(items: any[]): BoundaryNode[] {
  return dedupeNodes(items.map((item) => ({
    filePath: item?.filePath,
    name: item?.name,
    startLine: item?.line,
    endLine: item?.endLine ?? item?.line
  })));
}

/** Fact-pack node set of a run: the union of every feature's fact-pack items. Missing features dir -> empty
 *  (a run with no fact pack legitimately claims nothing), which the recall then reports as all-missing. */
export function factPackNodesFromRun(runDir: string): BoundaryNode[] {
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) throw new Error(`run directory not found: ${runDir}`);
  const featuresDir = join(runDir, "context", "features");
  if (!existsSync(featuresDir)) return [];
  const items: any[] = [];
  for (const file of readdirSync(featuresDir).sort()) {
    if (!file.endsWith(".factpack.json")) continue;
    const pack = JSON.parse(readFileSync(join(featuresDir, file), "utf8"));
    if (Array.isArray(pack?.items)) items.push(...pack.items);
  }
  return factPackItemsToNodes(items);
}

/** FG-layer report for a run (stamps layer:"fg"): the existing source-window-annotated FG recall. */
export function fgReportFromRun(runDir: string, gold: BoundaryGold): BoundaryReport {
  return { ...boundaryReportFromRun(runDir, gold), layer: "fg" };
}

/** Fact-pack-layer report for a run (stamps layer:"factpack"). No source-window annotation: that signal
 *  answers "could downstream fallback still reach the FG miss", which is FG-specific and not meaningful
 *  once we are measuring the fact pack the author already holds. */
export function factPackReportFromRun(runDir: string, gold: BoundaryGold): BoundaryReport {
  return { ...boundaryRecall(factPackNodesFromRun(runDir), gold), layer: "factpack" };
}

/** A gold item the FG captured but the fact pack dropped (found@fg ∧ missing@factpack): the derivation
 *  defect class this metric exists to surface. Distinct from an upstream FG gap (missing at both layers). */
export interface DerivationDrop {
  id: string;
  mustFind: boolean;
  /** Where the FG held it (the node that satisfied it at the fg layer). */
  via: string;
}

/** The derivation drops between an fg report and a factpack report. Pure over the two reports. */
export function derivationDrops(fg: BoundaryReport, factpack: BoundaryReport): DerivationDrop[] {
  const droppedFromFactpack = new Set(factpack.missing.map((miss) => miss.id));
  return fg.found
    .filter((entry) => droppedFromFactpack.has(entry.id))
    .map((entry) => ({ id: entry.id, mustFind: entry.mustFind, via: entry.via }));
}

/** A cross-layer report: each requested layer's recall plus the derivation-drop view between them. */
export interface LayeredBoundaryReport {
  target: string;
  /** The layers this report was asked to measure (drives the exit-code union). */
  requested: BoundaryLayer[];
  fg?: BoundaryReport;
  factpack?: BoundaryReport;
  /** found@fg ∧ missing@factpack — only populated when both layers were measured. */
  derivationDrops: DerivationDrop[];
  /** Union gate: every requested layer has all its mustFinds. */
  pass: boolean;
}

/** Assemble a layered report. `pass` is the union: a requested layer with a mustFind miss fails the whole. */
export function buildLayeredReport(
  target: string,
  fg: BoundaryReport | undefined,
  factpack: BoundaryReport | undefined,
  requested: BoundaryLayer[]
): LayeredBoundaryReport {
  const drops = fg && factpack ? derivationDrops(fg, factpack) : [];
  const pass =
    (!requested.includes("fg") || (fg?.summary.pass ?? true)) &&
    (!requested.includes("factpack") || (factpack?.summary.pass ?? true));
  return { target, requested, fg, factpack, derivationDrops: drops, pass };
}

/** Exit code for a layered report: any requested layer missing a mustFind -> 1; else 0. */
export function layeredExitCode(report: LayeredBoundaryReport): number {
  return report.pass ? 0 : 1;
}
