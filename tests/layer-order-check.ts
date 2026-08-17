// Layer-order checker: a pure function over (file texts, registry entries) -> violations.
//
// It lives in tests/ because it has no production consumer — it is a development-discipline contract, the same
// shape as `search-corpus.test.ts` pinning registry containment. Everything here is a pure function so the
// negative fixtures in `layer-order.test.ts` can feed it synthetic file sets and prove it goes RED; an
// instrument that can only ever go green is worse than no instrument.
//
// Three checks, per docs/layering.md §二:
//   (a) no upward import edge, measured against the registry (`import type` counts — interface knowledge
//       flowing upward is a dependency);
//   (b) no cycle — any strongly connected component of size > 1 fails, whether or not its files are
//       registered (a cycle means the two files are one unit that cannot be layered);
//   (c) no unregistered file — a new file must declare its layer. There is no fourth state, and no default
//       layer: "directory default + per-file exception" and "unregistered must fail" cannot both hold.

/** Low to high. Imports may point at the same layer or lower, never higher. */
export const LAYER_ORDER = [
  "base",     // shared types / utils / registries / append-only writers — beneath every layer
  "contract", // BoundRunContract: materialised before any producer runs
  "L1",       // boundary: scan, file ledger, two-tier identity
  "L2",       // mechanism ledger
  "L3",       // facts and units — one subdirectory per producer
  "L4",       // attribution
  "L5",       // workset
  "L6",       // obligation statements
  "L7",       // investigation results
  "L8",       // freeze
  "report",   // report side: authoring, claims, the report half of auditing (outside the contract, inside this test)
  "orch"      // run.ts / cli.ts — wires the layers together, above everything
] as const;

export type LayerName = (typeof LAYER_ORDER)[number];

const LAYER_RANK: ReadonlyMap<LayerName, number> = new Map(LAYER_ORDER.map((layer, rank) => [layer, rank]));

/**
 * A registry entry is EXPLICIT — either a whole directory that is entirely one layer, or a single file in a
 * mixed directory. There is deliberately no "default layer" form: a default would silently adopt every new
 * file, which is the blind spot check (c) exists to close.
 */
export type RegistryEntry =
  | { readonly dir: string; readonly layer: LayerName }
  | { readonly file: string; readonly layer: LayerName };

export interface ImportEdge {
  /** src-relative path of the importer. */
  readonly from: string;
  /** src-relative path of the imported file. */
  readonly to: string;
}

export interface ImportGraph {
  /** Every source file, whether or not it has any edge — node count must equal file count. */
  readonly nodes: readonly string[];
  /** Deduplicated: two imports of the same module from the same file are one dependency. */
  readonly edges: readonly ImportEdge[];
  /** Specifiers that did not resolve to a known file. Non-empty means the instrument is broken, not the code. */
  readonly unresolved: readonly string[];
  /** Relative specifiers found on a comment line. Non-empty means an occurrence the extractor cannot trust. */
  readonly commentedSpecifiers: readonly string[];
}

/**
 * Every relative module specifier in one file's text.
 *
 * Two forms carry a dependency: `… from "<relative>"` (which covers `import`, `import type` and
 * `export … from`) and a dynamic `import("<relative>")`. The extractor does NOT strip comments; instead
 * `extractRelativeSpecifiers` reports occurrences that sit on a comment line, and the caller fails on them.
 * A comment stripper would be a second parser nobody verifies, and its failure mode is silent (it drops a
 * real edge). Refusing to guess is checkable.
 */
export function extractRelativeSpecifiers(text: string): { specifiers: string[]; commented: string[] } {
  const specifiers: string[] = [];
  const commented: string[] = [];
  const patterns = [/\bfrom\s*["'](\.[^"']*)["']/g, /\bimport\s*\(\s*["'](\.[^"']*)["']\s*\)/g];
  for (const line of text.split(/\r?\n/)) {
    // A line whose first non-space characters open or continue a comment cannot be trusted to be code.
    const isCommentLine = /^\s*(?:\/\/|\/\*|\*)/.test(line);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        if (isCommentLine) commented.push(match[1]!);
        else specifiers.push(match[1]!);
      }
    }
  }
  return { specifiers, commented };
}

/** Resolve `spec` written inside `fromPath` (both src-relative) to a src-relative path, without touching disk. */
function resolveSpecifier(fromPath: string, spec: string): string {
  const segments = fromPath.split("/").slice(0, -1).concat(spec.split("/"));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { out.pop(); continue; }
    out.push(segment);
  }
  return out.join("/");
}

/** Build the import graph. `files` maps src-relative path -> file text; every key becomes a node. */
export function buildImportGraph(files: ReadonlyMap<string, string>): ImportGraph {
  const nodes = [...files.keys()].sort();
  const known = new Set(nodes);
  const seen = new Set<string>();
  const edges: ImportEdge[] = [];
  const unresolved: string[] = [];
  const commentedSpecifiers: string[] = [];
  for (const from of nodes) {
    const { specifiers, commented } = extractRelativeSpecifiers(files.get(from)!);
    for (const spec of commented) commentedSpecifiers.push(`${from}: commented relative specifier ${spec}`);
    for (const spec of specifiers) {
      const to = resolveSpecifier(from, spec);
      if (!known.has(to)) { unresolved.push(`${from}: ${spec} -> ${to}`); continue; }
      const key = `${from} -> ${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to });
    }
  }
  return { nodes, edges, unresolved, commentedSpecifiers };
}

/** Tarjan. Returns every strongly connected component, largest first; callers keep the ones of size > 1. */
export function stronglyConnectedComponents(graph: ImportGraph): string[][] {
  const order = new Map(graph.nodes.map((node, i) => [node, i]));
  const adjacency: number[][] = graph.nodes.map(() => []);
  for (const edge of graph.edges) adjacency[order.get(edge.from)!]!.push(order.get(edge.to)!);
  const index = new Array<number>(graph.nodes.length).fill(-1);
  const lowLink = new Array<number>(graph.nodes.length).fill(0);
  const onStack = new Array<boolean>(graph.nodes.length).fill(false);
  const stack: number[] = [];
  const components: string[][] = [];
  let counter = 0;
  // Iterative so a deep import chain cannot blow the stack.
  for (let root = 0; root < graph.nodes.length; root++) {
    if (index[root] !== -1) continue;
    const work: { node: number; next: number }[] = [{ node: root, next: 0 }];
    index[root] = lowLink[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const neighbours = adjacency[frame.node]!;
      if (frame.next < neighbours.length) {
        const next = neighbours[frame.next++]!;
        if (index[next] === -1) {
          index[next] = lowLink[next] = counter++;
          stack.push(next);
          onStack[next] = true;
          work.push({ node: next, next: 0 });
        } else if (onStack[next]) {
          lowLink[frame.node] = Math.min(lowLink[frame.node]!, index[next]!);
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) lowLink[parent.node] = Math.min(lowLink[parent.node]!, lowLink[frame.node]!);
      if (lowLink[frame.node] === index[frame.node]) {
        const component: string[] = [];
        let popped: number;
        do {
          popped = stack.pop()!;
          onStack[popped] = false;
          component.push(graph.nodes[popped]!);
        } while (popped !== frame.node);
        components.push(component.sort());
      }
    }
  }
  return components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

export interface LayerAssignment {
  readonly layerOf: ReadonlyMap<string, LayerName>;
  /** Registry hygiene failures: shadowed directories, entries pointing nowhere, uncovered files. */
  readonly registryViolations: readonly string[];
}

/**
 * Resolve every file to a layer, and report the three registry hygiene failures:
 *  (a) a directory entry means no file entry may live under it — two authorities for one file;
 *  (b) an entry pointing at a path that does not exist — a stale entry that silently covers nothing;
 *  (c) a file no entry covers — the "no fourth state" rule.
 */
export function assignLayers(entries: readonly RegistryEntry[], filePaths: readonly string[]): LayerAssignment {
  const registryViolations: string[] = [];
  const dirEntries = entries.filter((entry): entry is { dir: string; layer: LayerName } => "dir" in entry);
  const fileEntries = entries.filter((entry): entry is { file: string; layer: LayerName } => "file" in entry);
  const files = new Set(filePaths);

  const seenDirs = new Set<string>();
  for (const entry of dirEntries) {
    if (seenDirs.has(entry.dir)) registryViolations.push(`duplicate directory entry: ${entry.dir}`);
    seenDirs.add(entry.dir);
    if (!filePaths.some((path) => inDirectory(path, entry.dir))) {
      registryViolations.push(`directory entry covers no file: ${entry.dir}`);
    }
  }
  const seenFiles = new Set<string>();
  for (const entry of fileEntries) {
    if (seenFiles.has(entry.file)) registryViolations.push(`duplicate file entry: ${entry.file}`);
    seenFiles.add(entry.file);
    if (!files.has(entry.file)) registryViolations.push(`file entry points at a missing file: ${entry.file}`);
    for (const dir of seenDirsOf(dirEntries)) {
      if (inDirectory(entry.file, dir)) {
        registryViolations.push(`file entry ${entry.file} is shadowed by directory entry ${dir}`);
      }
    }
  }

  const layerOf = new Map<string, LayerName>();
  for (const path of filePaths) {
    const fileEntry = fileEntries.find((entry) => entry.file === path);
    if (fileEntry) { layerOf.set(path, fileEntry.layer); continue; }
    const dirEntry = dirEntries.find((entry) => inDirectory(path, entry.dir));
    if (dirEntry) { layerOf.set(path, dirEntry.layer); continue; }
    registryViolations.push(`unregistered file: ${path}`);
  }
  return { layerOf, registryViolations };
}

function seenDirsOf(dirEntries: readonly { dir: string; layer: LayerName }[]): string[] {
  return dirEntries.map((entry) => entry.dir);
}

/** `dir` is a src-relative directory; `""` would mean all of src, which no entry may claim. */
function inDirectory(path: string, dir: string): boolean {
  if (dir === "") return false;
  return path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

export interface LayerAudit {
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** Instrument failures — the graph itself could not be trusted. Non-empty means fix the checker or the code. */
  readonly instrumentFailures: readonly string[];
  readonly registryViolations: readonly string[];
  /** One line per upward edge: importer (layer) -> imported (layer). */
  readonly upwardEdges: readonly string[];
  /** One line per strongly connected component of size > 1. */
  readonly cycles: readonly string[];
  readonly layerOf: ReadonlyMap<string, LayerName>;
}

/** Every violation the layer order can have, from one pure pass. `files` maps src-relative path -> text. */
export function auditLayerOrder(files: ReadonlyMap<string, string>, entries: readonly RegistryEntry[]): LayerAudit {
  const graph = buildImportGraph(files);
  const instrumentFailures = [
    ...graph.unresolved.map((line) => `unresolved import: ${line}`),
    ...graph.commentedSpecifiers,
    ...(graph.nodes.length === files.size ? [] : [`graph has ${graph.nodes.length} nodes for ${files.size} files`])
  ];
  const { layerOf, registryViolations } = assignLayers(entries, graph.nodes);
  const upwardEdges: string[] = [];
  for (const edge of graph.edges) {
    const from = layerOf.get(edge.from);
    const to = layerOf.get(edge.to);
    if (!from || !to) continue; // unregistered files are already a violation; do not double-report.
    if (LAYER_RANK.get(to)! > LAYER_RANK.get(from)!) {
      upwardEdges.push(`${edge.from} (${from}) -> ${edge.to} (${to})`);
    }
  }
  const cycles = stronglyConnectedComponents(graph)
    .filter((component) => component.length > 1)
    .map((component) => `cycle [${component.length}]: ${component.join(", ")}`);
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    instrumentFailures,
    registryViolations,
    upwardEdges: upwardEdges.sort(),
    cycles,
    layerOf
  };
}
