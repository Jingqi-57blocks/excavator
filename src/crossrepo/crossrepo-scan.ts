// CROSSREPO SCAN — the orchestration that turns a multi-module workspace into cross-repo HTTP links.
//
// Three deterministic stages, each already unit-tested on its own:
//   1. discover WHERE the registrations live — from the graph's own `route` nodes, so the parse surface is
//      bounded by a fact rather than by a guess about project layout;
//   2. recover the full route table from those files, and extract the frontend calls from the TS/TSX ones;
//   3. match, and record everything that did not match with the reason it did not.
//
// Discovery deserves the emphasis: a hand-listed set of registration files is how a resolver quietly stops
// seeing half a service. Asking the graph which files declare routes keeps the surface honest — and when
// the graph knows a route the recovery missed, the caller can compare the two counts instead of trusting
// either. Measured on the real target, source-level recovery finds MORE than the graph (339 vs 299), so
// neither is a superset and both numbers belong in the artifact.

import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { CodeGraphIndex } from "../codegraph/codegraph.ts";
import { Deadline } from "../core/util.ts";
import { extractFrontendCalls, type FrontendCall } from "./frontend-calls.ts";
import { expressMounts, recoverExpressRoutes, recoverGinRoutes, type RecoveredRoute } from "./route-table.ts";
import { matchCall, type MatchedLink, type NearMiss, type RouteCandidate } from "./link-match.ts";

export const CROSSREPO_SCAN_VERSION = "crossrepo-links-v1";

/** Default client identifiers. Overridable, and extended structurally by `discoverClients`. */
const FALLBACK_CLIENTS = ["httpClient", "authRequest", "request", "apiClient"];

/** Files this scanner will not read regardless of extension — build output is not source. */
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".codegraph", "vendor"]);

export interface ScanModule {
  id: string;
  dir: string;
  databasePath: string;
}

export interface CrossRepoScan {
  version: string;
  modules: string[];
  clients: string[];
  links: Array<{
    from: { module: string; path: string; line: number; method: string; baseKey: string | null; expression: string; routePath: string };
    to: { module: string; path: string; line: number; route: string; handlerExpression: string };
    resolution: MatchedLink["resolution"];
    confidence: MatchedLink["confidence"];
    rule: MatchedLink["rule"];
  }>;
  unresolved: Array<{ module: string; path: string; line: number; method: string; routePath: string | null; reason: string; nearMisses: NearMiss[] }>;
  ambiguous: Array<{ module: string; path: string; line: number; method: string; routePath: string; candidates: Array<{ module: string; route: string }> }>;
  /** Weak alignments: recorded for a human, never asserted as links (measured 4/4 semantically wrong). */
  candidates: Array<{ module: string; path: string; line: number; method: string; routePath: string; candidates: Array<{ module: string; route: string }> }>;
  routeRecovery: Array<{ module: string; framework: string; recovered: number; graphRouteNodes: number; unrecovered: number }>;
  summary: { calls: number; static: number; framework: number; unresolved: number; ambiguous: number; weak: number; routes: number };
  warnings: string[];
}

/** Scan a workspace. Never throws for a missing graph or an unreadable file — both degrade with a warning. */
export async function scanCrossRepoLinks(workspace: string, modules: ScanModule[]): Promise<CrossRepoScan> {
  const warnings: string[] = [];
  const routeCandidates: RouteCandidate[] = [];
  const routeRecovery: CrossRepoScan["routeRecovery"] = [];
  const frontendFiles: Array<{ module: string; path: string; source: string }> = [];

  for (const module of modules) {
    const registrationFiles = routeFilesFromGraph(module, warnings);
    const moduleRoot = join(workspace, module.dir);
    let recovered = 0;
    let unrecovered = 0;
    let framework = "none";

    for (const relative of registrationFiles) {
      const source = await readSource(join(moduleRoot, relative), warnings);
      if (source === null) continue;
      if (relative.endsWith(".go")) {
        framework = "gin";
        const recovery = recoverGinRoutes(relative, source);
        warnings.push(...recovery.warnings);
        unrecovered += recovery.unrecovered.length;
        for (const route of recovery.routes) routeCandidates.push({ module: module.id, route });
        recovered += recovery.routes.length;
      } else if (/\.(js|ts)$/.test(relative)) {
        framework = "express";
        const mounted = await recoverExpressModule(moduleRoot, relative, source, warnings);
        for (const route of mounted.routes) routeCandidates.push({ module: module.id, route });
        recovered += mounted.routes.length;
        unrecovered += mounted.unrecovered;
      }
    }
    routeRecovery.push({ module: module.id, framework, recovered, graphRouteNodes: registrationFiles.length ? countRouteNodes(module, warnings) : 0, unrecovered });

    // Any module may hold frontend calls — a Node backend calling another service looks the same.
    await collectSources(moduleRoot, module.id, frontendFiles, warnings);
  }

  const clients = [...new Set([...FALLBACK_CLIENTS, ...discoverClients(frontendFiles)])].sort();
  const scan: CrossRepoScan = {
    version: CROSSREPO_SCAN_VERSION,
    modules: modules.map((module) => module.id).sort(),
    clients,
    links: [],
    unresolved: [],
    ambiguous: [],
    candidates: [],
    routeRecovery,
    summary: { calls: 0, static: 0, framework: 0, unresolved: 0, ambiguous: 0, weak: 0, routes: routeCandidates.length },
    warnings,
  };

  for (const file of frontendFiles) {
    for (const call of extractFrontendCalls(file.path, file.source, clients)) {
      scan.summary.calls += 1;
      record(scan, file.module, call, matchCall(call, routeCandidates));
    }
  }

  scan.links.sort((a, b) => cmp(a.from.path, b.from.path) || a.from.line - b.from.line || cmp(a.from.method, b.from.method));
  scan.unresolved.sort((a, b) => cmp(a.path, b.path) || a.line - b.line);
  scan.ambiguous.sort((a, b) => cmp(a.path, b.path) || a.line - b.line);
  scan.candidates.sort((a, b) => cmp(a.path, b.path) || a.line - b.line);
  return scan;
}

function record(scan: CrossRepoScan, module: string, call: FrontendCall, outcome: ReturnType<typeof matchCall>): void {
  if (outcome.kind === "matched") {
    const { link } = outcome;
    scan.links.push({
      from: { module, path: call.path, line: call.line, method: call.method, baseKey: call.baseKey, expression: call.expression, routePath: call.routePath as string },
      to: { module: link.module, path: link.route.file, line: link.route.line, route: `${link.route.method} ${link.route.path}`, handlerExpression: link.route.handlerExpression },
      resolution: link.resolution,
      confidence: link.confidence,
      rule: link.rule,
    });
    if (link.resolution === "static") scan.summary.static += 1;
    else scan.summary.framework += 1;
    return;
  }
  if (outcome.kind === "ambiguous") {
    scan.ambiguous.push({ module, path: call.path, line: call.line, method: call.method, routePath: call.routePath as string, candidates: outcome.candidates });
    scan.summary.ambiguous += 1;
    return;
  }
  if (outcome.kind === "weak") {
    scan.candidates.push({ module, path: call.path, line: call.line, method: call.method, routePath: call.routePath as string, candidates: outcome.candidates });
    scan.summary.weak += 1;
    return;
  }
  scan.unresolved.push({ module, path: call.path, line: call.line, method: call.method, routePath: call.routePath, reason: call.unresolvedReason ?? "no-route", nearMisses: outcome.nearMisses });
  scan.summary.unresolved += 1;
}

/** The files a module declares routes in, according to its own graph. */
function routeFilesFromGraph(module: ScanModule, warnings: string[]): string[] {
  try {
    const index = new CodeGraphIndex(module.databasePath, 200, new Deadline(30_000, "crossrepo route discovery"));
    try {
      // `routeSummary` is the query that returns route nodes without needing a file list up front —
      // which is the whole point here, since the file list is what we are trying to learn.
      const nodes = index.routeSummary(5000);
      return [...new Set(nodes.map((node) => String(node.filePath)))].sort();
    } finally {
      index.close();
    }
  } catch (error) {
    warnings.push(`route discovery skipped for ${module.id}: ${(error as Error).message}`);
    return [];
  }
}

function countRouteNodes(module: ScanModule, warnings: string[]): number {
  try {
    const index = new CodeGraphIndex(module.databasePath, 200, new Deadline(30_000, "crossrepo route discovery"));
    try {
      return index.routeSummary(5000).length;
    } finally {
      index.close();
    }
  } catch (error) {
    warnings.push(`route node count unavailable for ${module.id}: ${(error as Error).message}`);
    return 0;
  }
}

/**
 * Express splits a route's path across two files: the app mounts a router under a prefix, the router
 * declares the rest. The mount identifier resolves through the `require` that produced it — one hop, and
 * the only cross-file step in this module.
 */
async function recoverExpressModule(
  moduleRoot: string,
  relative: string,
  source: string,
  warnings: string[],
): Promise<{ routes: RecoveredRoute[]; unrecovered: number }> {
  const mounts = expressMounts(source);
  if (!mounts.length) {
    // Not an app file: a router file reached directly, whose prefix is unknown from here.
    const recovery = recoverExpressRoutes(relative, source, "");
    warnings.push(...recovery.warnings);
    return { routes: recovery.routes, unrecovered: recovery.unrecovered.length };
  }
  const requires = requireTargets(source);
  const routes: RecoveredRoute[] = [];
  let unrecovered = 0;
  for (const mount of mounts) {
    const target = requires.get(mount.identifier);
    if (!target) {
      warnings.push(`express mount ${mount.prefix} → ${mount.identifier} has no require in ${relative}`);
      unrecovered += 1;
      continue;
    }
    for (const suffix of ["", ".js", ".ts", "/index.js"]) {
      const routerSource = await readSource(join(moduleRoot, `${target}${suffix}`), []);
      if (routerSource === null) continue;
      const recovery = recoverExpressRoutes(`${target}${suffix}`, routerSource, mount.prefix);
      warnings.push(...recovery.warnings);
      routes.push(...recovery.routes);
      unrecovered += recovery.unrecovered.length;
      break;
    }
  }
  return { routes, unrecovered };
}

/** `const leaveRouter = require('./routes/leave')` — identifier to module-relative path. */
function requireTargets(source: string): Map<string, string> {
  const targets = new Map<string, string>();
  const pattern = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*['"]\.\/?([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) targets.set(match[1], match[2]);
  return targets;
}

/**
 * Recognise HTTP clients structurally rather than by name: an `axios.create()` export, or a class that
 * exposes the HTTP verbs. Hard-coding one codebase's vocabulary would tie the engine to that codebase.
 */
export function discoverClients(files: Array<{ path: string; source: string }>): string[] {
  const names = new Set<string>();
  for (const file of files) {
    for (const match of file.source.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*axios\.create\(/g)) names.add(match[1]);
    for (const match of file.source.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*new\s+[A-Za-z0-9_$]*(?:Http|Client|Request)[A-Za-z0-9_$]*\(/g)) names.add(match[1]);
  }
  return [...names].sort();
}

async function collectSources(root: string, moduleId: string, out: Array<{ module: string; path: string; source: string }>, warnings: string[]): Promise<void> {
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) stack.push(full);
        continue;
      }
      if (![".ts", ".tsx", ".js"].includes(extname(entry.name))) continue;
      if (/\.(test|spec|d)\.tsx?$/.test(entry.name)) continue;
      const source = await readSource(full, warnings);
      if (source !== null) out.push({ module: moduleId, path: full.slice(root.length + 1), source });
    }
  }
  out.sort((a, b) => cmp(a.module, b.module) || cmp(a.path, b.path));
}

async function readSource(path: string, warnings: string[]): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (warnings.length < 50) warnings.push(`unreadable: ${path} (${(error as Error).message})`);
    return null;
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
