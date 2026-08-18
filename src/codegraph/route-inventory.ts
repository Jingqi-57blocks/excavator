import { readFile } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";
import type { GraphNode } from "../base/types.ts";
import type { FactDetail, FactAnchor, ObservedFact } from "../facts/units/membership-map.ts";
import type { GraphReader, GraphRouteReference } from "./codegraph.ts";
import { inventoryFactIdFor, inventoryUnitKind } from "./function-inventory.ts";

/**
 * Corpus-wide route facts, with handler edges admitted only after the source binding agrees with the target.
 *
 * CodeGraph's `references` edge is a candidate, not an identity. Measured on the two real targets before this
 * rule was written: 35/390 WCP edges and 6/272 Angels Pizza edges pointed at a non-callable node, the wrong Go
 * package, the wrong imported module, or the wrong export inside the right module. The index's `resolvedBy`
 * label did not separate those failures. The source qualifier/import is therefore the authority for the edge;
 * a rejected or absent edge leaves the route visible at its registration line with `handlerResolved: false`.
 */

export const ROUTE_INVENTORY_VERSION = "route-inventory-v1";
export const ROUTE_INVENTORY_LIMIT = 50_000;
export const ROUTE_REFERENCE_LIMIT = 50_000;

export type RouteHandlerResolution =
  | "resolved"
  | "multiple-verified-references"
  | "no-reference"
  | "reference-name-mismatch"
  | "source-binding-not-found"
  | "source-unreadable"
  | "target-export-mismatch"
  | "target-kind-not-callable"
  | "target-module-mismatch"
  | "unsupported-language";

export const ROUTE_HANDLER_RESOLUTIONS = [
  "multiple-verified-references",
  "no-reference",
  "reference-name-mismatch",
  "resolved",
  "source-binding-not-found",
  "source-unreadable",
  "target-export-mismatch",
  "target-kind-not-callable",
  "target-module-mismatch",
  "unsupported-language"
] as const satisfies readonly RouteHandlerResolution[];

export interface InventoryRoute {
  readonly factId: string;
  readonly name: string;
  readonly method: string | null;
  readonly routePath: string | null;
  readonly registrationPath: string;
  readonly registrationLine: number;
  readonly handlerResolved: boolean;
  readonly handlerResolution: RouteHandlerResolution;
  readonly handlerFactId: string | null;
  readonly handlerName: string | null;
  readonly handlerPath: string | null;
  readonly handlerStartLine: number | null;
  readonly referenceName: string | null;
  readonly anchor: FactAnchor;
}

export interface RouteInventory {
  readonly version: typeof ROUTE_INVENTORY_VERSION;
  readonly routes: readonly InventoryRoute[];
  readonly completeness: {
    readonly filesQueried: number;
    readonly routeLimit: number;
    readonly routesReturned: number;
    readonly routesTruncated: boolean;
    readonly referenceLimit: number;
    readonly referencesReturned: number;
    readonly referencesTruncated: boolean;
    readonly handlerResolved: number;
    readonly handlerFallback: number;
    readonly byResolution: Readonly<Record<RouteHandlerResolution, number>>;
  };
}

interface VerifiedReference {
  readonly reference: GraphRouteReference;
  readonly handlerFactId: string;
  readonly unitKind: NonNullable<ReturnType<typeof inventoryUnitKind>>;
  readonly referenceName: string;
}

type ReferenceVerdict =
  | { readonly status: "verified"; readonly value: VerifiedReference }
  | { readonly status: "rejected"; readonly reason: Exclude<RouteHandlerResolution, "resolved" | "multiple-verified-references" | "no-reference"> };

/** Enumerate every indexed route in the counted corpus and attach only source-verified handler identities. */
export async function routeInventory(
  reader: GraphReader,
  relativePaths: readonly string[],
  target: string,
  limits: { readonly routes?: number; readonly references?: number } = {}
): Promise<RouteInventory> {
  const counted = [...new Set(relativePaths.map(normalizePath))].sort(compare);
  const routeLimit = Math.max(1, limits.routes ?? ROUTE_INVENTORY_LIMIT);
  const referenceLimit = Math.max(1, limits.references ?? ROUTE_REFERENCE_LIMIT);
  const routeNodes = reader.nodesByKindInFiles(["route"], counted, routeLimit).sort(compareNodes);
  const references = reader.routeReferencesInFiles(counted, referenceLimit);
  const byRoute = new Map<string, GraphRouteReference[]>();
  for (const reference of references) {
    const list = byRoute.get(reference.route.id) ?? [];
    list.push(reference);
    byRoute.set(reference.route.id, list);
  }

  const sources = new SourceFiles(target, counted);
  const routes: InventoryRoute[] = [];
  const used = new Map<string, number>();
  const byResolution = emptyResolutionCounts();
  for (const node of routeNodes) {
    const candidates = byRoute.get(node.id) ?? [];
    const verdicts = await Promise.all(candidates.map((candidate) => verifyReference(candidate, sources)));
    const verified = verdicts.filter((verdict): verdict is Extract<ReferenceVerdict, { status: "verified" }> => verdict.status === "verified");
    const resolution: RouteHandlerResolution = candidates.length === 0 ? "no-reference"
      : verified.length > 1 ? "multiple-verified-references"
      : verified.length === 1 ? "resolved"
      : firstRejected(verdicts);
    byResolution[resolution] += 1;
    const handler = resolution === "resolved" ? verified[0]!.value : null;
    const parsed = parseRouteName(node.name);
    const base = routeFactIdFor(node) ?? `route:${normalizePath(node.filePath)}:${node.startLine}-${node.endLine}:${node.name}`;
    const seen = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    routes.push({
      factId: seen === 1 ? base : `${base}#${seen}`,
      name: node.name,
      method: parsed.method,
      routePath: parsed.path,
      registrationPath: normalizePath(node.filePath),
      registrationLine: node.startLine,
      handlerResolved: handler !== null,
      handlerResolution: resolution,
      handlerFactId: handler?.handlerFactId ?? null,
      handlerName: handler?.reference.target.name ?? null,
      handlerPath: handler ? normalizePath(handler.reference.target.filePath) : null,
      handlerStartLine: handler?.reference.target.startLine ?? null,
      referenceName: handler?.referenceName ?? candidateReferenceName(candidates),
      anchor: handler === null
        ? { relativePath: normalizePath(node.filePath), startLine: node.startLine, endLine: null, unitKind: null }
        : {
            relativePath: normalizePath(handler.reference.target.filePath),
            startLine: handler.reference.target.startLine,
            endLine: handler.reference.target.endLine,
            unitKind: handler.unitKind
          }
    });
  }

  return {
    version: ROUTE_INVENTORY_VERSION,
    routes: routes.sort((a, b) => a.factId.localeCompare(b.factId)),
    completeness: {
      filesQueried: counted.length,
      routeLimit,
      routesReturned: routeNodes.length,
      routesTruncated: routeNodes.length >= routeLimit,
      referenceLimit,
      referencesReturned: references.length,
      referencesTruncated: references.length >= referenceLimit,
      handlerResolved: byResolution.resolved,
      handlerFallback: routes.length - byResolution.resolved,
      byResolution
    }
  };
}

/** The stable base id used both by the producer and the feature fact-pack collector. */
export function routeFactIdFor(node: Pick<GraphNode, "kind" | "filePath" | "startLine" | "endLine" | "name">): string | null {
  if (node.kind !== "route" || !usableLines(node)) return null;
  return `route:${normalizePath(node.filePath)}:${node.startLine}-${node.endLine}:${node.name}`;
}

export function routeObservations(inventory: RouteInventory): ObservedFact[] {
  return inventory.routes.map((route) => ({
    factId: route.factId,
    kind: "indexed-route" as const,
    anchors: [route.anchor],
    detail: {
      name: route.name,
      method: route.method,
      routePath: route.routePath,
      registrationPath: route.registrationPath,
      registrationLine: route.registrationLine,
      handlerResolved: route.handlerResolved,
      handlerResolution: route.handlerResolution,
      handlerFactId: route.handlerFactId,
      handlerName: route.handlerName,
      handlerPath: route.handlerPath,
      handlerStartLine: route.handlerStartLine,
      referenceName: route.referenceName
    } satisfies FactDetail
  }));
}

async function verifyReference(reference: GraphRouteReference, sources: SourceFiles): Promise<ReferenceVerdict> {
  const unitKind = inventoryUnitKind(reference.target.kind);
  if (unitKind !== "function" && unitKind !== "method") {
    return { status: "rejected", reason: "target-kind-not-callable" };
  }
  const handlerFactId = inventoryFactIdFor(reference.target);
  if (handlerFactId === null) return { status: "rejected", reason: "target-kind-not-callable" };
  const referenceName = stringMetadata(reference, "refName");
  if (referenceName === null) return { status: "rejected", reason: "source-binding-not-found" };
  const routePath = normalizePath(reference.route.filePath);
  const targetPath = normalizePath(reference.target.filePath);
  if (routePath === targetPath) {
    return referenceName === reference.target.name
      ? { status: "verified", value: { reference, handlerFactId, unitKind, referenceName } }
      : { status: "rejected", reason: "reference-name-mismatch" };
  }

  const routeSource = await sources.read(routePath);
  if (routeSource === null) return { status: "rejected", reason: "source-unreadable" };
  const language = reference.route.language.toLowerCase();
  let binding: { readonly moduleMatches: boolean; readonly exportName: string } | null;
  if (language === "go") {
    const targetSource = await sources.read(targetPath);
    if (targetSource === null) return { status: "rejected", reason: "source-unreadable" };
    binding = goBinding(reference, routeSource, targetSource, await sources.goImportPath(targetPath));
  } else if (["javascript", "jsx", "tsx", "typescript"].includes(language)) {
    binding = javascriptBinding(routeSource, routePath, referenceName, targetPath);
  } else {
    return { status: "rejected", reason: "unsupported-language" };
  }
  if (binding === null) return { status: "rejected", reason: "source-binding-not-found" };
  if (!binding.moduleMatches) return { status: "rejected", reason: "target-module-mismatch" };
  if (binding.exportName !== reference.target.name) return { status: "rejected", reason: "target-export-mismatch" };
  return { status: "verified", value: { reference, handlerFactId, unitKind, referenceName } };
}

function goBinding(
  reference: GraphRouteReference,
  routeSource: string,
  targetSource: string,
  targetImportPath: string | null
): { moduleMatches: boolean; exportName: string } | null {
  const referenceName = stringMetadata(reference, "refName");
  if (referenceName === null) return null;
  const lines = routeSource.split(/\r?\n/);
  const window = lines.slice(Math.max(0, reference.route.startLine - 1), reference.route.endLine).join("\n");
  const matches = [...window.matchAll(new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\.\\s*${escapeRegex(referenceName)}\\b`, "g"))];
  const qualifiers = [...new Set(matches.map((match) => match[1]!))];
  if (qualifiers.length !== 1) return null;
  const targetPackage = /^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m.exec(targetSource)?.[1] ?? null;
  const targetDir = normalizePath(dirname(reference.target.filePath));
  const imports = goImports(routeSource);
  // Prefer the binding whose local name is literally used at the route. Only fall back to a package-name
  // match when the import had no alias and its path is already the candidate target. Without that ordering,
  // `oauth.Handler` can accidentally select an earlier unrelated implicit import whenever the target package
  // also happens to be named `oauth` (the dominant shape measured in WCP).
  const imported = imports.find((entry) => entry.local === qualifiers[0])
    ?? imports.find((entry) => entry.explicitAlias === false
      && targetPackage !== null
      && qualifiers[0] === targetPackage
      && importMatchesTarget(entry.spec, targetDir, targetImportPath));
  return {
    moduleMatches: imported !== undefined && importMatchesTarget(imported.spec, targetDir, targetImportPath),
    exportName: referenceName
  };
}

function goImports(source: string): Array<{ readonly local: string; readonly spec: string; readonly explicitAlias: boolean }> {
  const rows: Array<{ local: string; spec: string; explicitAlias: boolean }> = [];
  const parse = (value: string): void => {
    for (const match of value.matchAll(/^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"/gm)) {
      const spec = match[2]!;
      rows.push({ local: match[1] ?? posix.basename(spec), spec, explicitAlias: match[1] !== undefined });
    }
  };
  parse(/\bimport\s*\(([\s\S]*?)\)/m.exec(source)?.[1] ?? "");
  for (const match of source.matchAll(/^\s*import\s+((?:[A-Za-z_][A-Za-z0-9_]*\s+)?"[^"]+")/gm)) parse(match[1]!);
  return rows;
}

function javascriptBinding(source: string, routeFile: string, localName: string, targetFile: string): { moduleMatches: boolean; exportName: string } | null {
  const bindings: Array<{ local: string; imported: string; spec: string }> = [];
  for (const match of source.matchAll(/\bimport\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g)) {
    const clause = match[1]!.trim();
    const named = /{([\s\S]*?)}/.exec(clause)?.[1] ?? "";
    for (const raw of named.split(",").map((item) => item.trim()).filter(Boolean)) {
      const [imported, local = imported] = raw.split(/\s+as\s+/);
      if (imported && local) bindings.push({ local, imported, spec: match[2]! });
    }
    const defaultName = clause.replace(/{[\s\S]*?}/, "").split(",")[0]!.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(defaultName)) bindings.push({ local: defaultName, imported: defaultName, spec: match[2]! });
  }
  for (const match of source.matchAll(/\b(?:const|let|var)\s*{([\s\S]*?)}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    for (const raw of match[1]!.split(",").map((item) => item.trim()).filter(Boolean)) {
      const [imported, local = imported] = raw.split(/\s*:\s*/);
      if (imported && local) bindings.push({ local, imported, spec: match[2]! });
    }
  }
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    bindings.push({ local: match[1]!, imported: match[1]!, spec: match[2]! });
  }
  const matches = bindings.filter((binding) => binding.local === localName);
  if (matches.length !== 1) return null;
  return {
    moduleMatches: javascriptModuleCandidates(routeFile, matches[0]!.spec).includes(normalizePath(targetFile)),
    exportName: matches[0]!.imported
  };
}

function javascriptModuleCandidates(routeFile: string, spec: string): string[] {
  if (!spec.startsWith(".")) return [];
  const base = normalizePath(posix.normalize(posix.join(posix.dirname(routeFile), spec)));
  const extensions = ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
  return [...extensions.map((extension) => `${base}${extension}`), ...extensions.slice(1).map((extension) => `${base}/index${extension}`)];
}

function importMatchesTarget(spec: string, targetDir: string, targetImportPath: string | null): boolean {
  const normalized = normalizePath(spec);
  if (targetImportPath !== null) return normalized === normalizePath(targetImportPath);
  return normalized === targetDir || normalized.endsWith(`/${targetDir}`);
}

function firstRejected(verdicts: readonly ReferenceVerdict[]): RouteHandlerResolution {
  return verdicts.find((verdict): verdict is Extract<ReferenceVerdict, { status: "rejected" }> => verdict.status === "rejected")?.reason
    ?? "source-binding-not-found";
}

function candidateReferenceName(candidates: readonly GraphRouteReference[]): string | null {
  const values = [...new Set(candidates.map((candidate) => stringMetadata(candidate, "refName")).filter((value): value is string => value !== null))];
  return values.length === 1 ? values[0]! : null;
}

function stringMetadata(reference: GraphRouteReference, key: string): string | null {
  const value = reference.edge.metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function parseRouteName(value: string): { method: string | null; path: string | null } {
  const match = /^([^\s]+)\s+(.+)$/.exec(value.trim());
  return match ? { method: match[1]!, path: match[2]! } : { method: null, path: null };
}

function usableLines(node: { readonly startLine: number; readonly endLine: number }): boolean {
  return Number.isInteger(node.startLine) && node.startLine >= 1 && Number.isInteger(node.endLine) && node.endLine >= node.startLine;
}

function emptyResolutionCounts(): Record<RouteHandlerResolution, number> {
  return Object.fromEntries(ROUTE_HANDLER_RESOLUTIONS.map((reason) => [reason, 0])) as Record<RouteHandlerResolution, number>;
}

function compareNodes(a: GraphNode, b: GraphNode): number {
  return compare(normalizePath(a.filePath), normalizePath(b.filePath))
    || a.startLine - b.startLine
    || compare(a.name, b.name)
    || compare(a.id, b.id);
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function normalizePath(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/"); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

class SourceFiles {
  private readonly root: string;
  private readonly allowed: ReadonlySet<string>;
  private readonly cache = new Map<string, Promise<string | null>>();
  private readonly goImportCache = new Map<string, Promise<string | null>>();

  constructor(target: string, allowedPaths: readonly string[]) {
    this.root = resolve(target);
    this.allowed = new Set(allowedPaths.map(normalizePath));
  }

  read(relativePath: string): Promise<string | null> {
    const normalized = normalizePath(relativePath);
    const existing = this.cache.get(normalized);
    if (existing) return existing;
    if (!this.allowed.has(normalized)) {
      const unavailable = Promise.resolve(null);
      this.cache.set(normalized, unavailable);
      return unavailable;
    }
    const absolute = resolve(this.root, normalized);
    const fromRoot = relative(this.root, absolute);
    const pending = fromRoot.startsWith("..") || resolve(this.root, fromRoot) !== absolute
      ? Promise.resolve(null)
      : readFile(absolute, "utf8").catch(() => null);
    this.cache.set(normalized, pending);
    return pending;
  }

  /** Resolve a target directory through its nearest go.mod; checkout folder names are not Go module names. */
  goImportPath(relativePath: string): Promise<string | null> {
    const targetDir = posix.dirname(normalizePath(relativePath));
    const existing = this.goImportCache.get(targetDir);
    if (existing) return existing;
    const pending = this.findGoImportPath(targetDir);
    this.goImportCache.set(targetDir, pending);
    return pending;
  }

  private async findGoImportPath(targetDir: string): Promise<string | null> {
    let candidate = targetDir;
    for (;;) {
      const goModPath = candidate === "." ? "go.mod" : `${candidate}/go.mod`;
      const source = await this.read(goModPath);
      const moduleName = source === null ? null : /^\s*module\s+(\S+)/m.exec(source)?.[1] ?? null;
      if (moduleName !== null) {
        const suffix = posix.relative(candidate, targetDir);
        return suffix && suffix !== "." ? `${moduleName}/${suffix}` : moduleName;
      }
      if (candidate === ".") return null;
      candidate = posix.dirname(candidate);
    }
  }
}
