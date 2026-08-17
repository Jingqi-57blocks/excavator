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
import { dirname, extname, join, resolve } from "node:path";
import { CodeGraphIndex } from "../codegraph/codegraph.ts";
import { Deadline } from "../base/util.ts";
import { extractFrontendCalls, type FrontendCall } from "./frontend-calls.ts";
import { expressMounts, recoverExpressRoutes, recoverGinRoutes, type RecoveredRoute } from "./route-table.ts";
import { matchCall, type MatchedLink, type NearMiss, type RouteCandidate } from "./link-match.ts";

export const CROSSREPO_SCAN_VERSION = "crossrepo-links-v1";

/** A seed list of conventional client names, UNIONED with what `discoverClients` finds structurally.
 *  The structural discovery is what makes this work on an unseen codebase; the seed only covers clients
 *  that are imported without a recognisable construction site in the scanned set. */
const FALLBACK_CLIENTS = ["httpClient", "authRequest", "request", "apiClient"];

/** Extensions the frontend-call walk reads. */
const FRONTEND_EXTENSIONS = [".ts", ".tsx", ".js"];
/** Every extension this scanner reads: the frontend walk plus the two route dialects it recognises on the
 *  registration side (`.go` for gin, `.js`/`.ts` for express). Exported so the mechanism registry's
 *  `crossrepo` support set is proven equal to what the code actually opens. */
export const CROSSREPO_EXTENSIONS: ReadonlySet<string> = new Set([...FRONTEND_EXTENSIONS, ".go", ".js", ".ts"]);

/** Files this scanner will not read regardless of extension — build output is not source. */
/** Route-node query cap; reaching it truncates discovery, which is warned rather than hidden. */
const ROUTE_NODE_CAP = 5000;

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".codegraph", "vendor"]);

export interface UnrecoveredEntry {
  module: string;
  file: string;
  line: number;
  reason: string;
}

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
    /** `localPath` is the path as written at the registration line: when it differs from the matched
     *  route, the full path was COMPOSED from group/mount prefixes, and a reader can see that. */
    to: { module: string; path: string; line: number; route: string; localPath: string; prefixComposed: boolean; handlerExpression: string };
    resolution: MatchedLink["resolution"];
    confidence: MatchedLink["confidence"];
    rule: MatchedLink["rule"];
  }>;
  unresolved: Array<{ module: string; path: string; line: number; method: string; routePath: string | null; reason: string; nearMisses: NearMiss[] }>;
  ambiguous: Array<{ module: string; path: string; line: number; method: string; routePath: string; candidates: Array<{ module: string; route: string }> }>;
  /** Weak alignments: recorded for a human, never asserted as links (measured 4/4 semantically wrong). */
  candidates: Array<{ module: string; path: string; line: number; method: string; routePath: string; candidates: Array<{ module: string; route: string }> }>;
  routeRecovery: Array<{ module: string; framework: string; recovered: number; graphRouteNodes: number; unrecovered: number }>;
  /**
   * Every recovered registration with its full span. The counts above say HOW MANY were recovered; these
   * say WHERE, which is what a reading obligation needs. An express registration's inline closure IS the
   * handler, so this span is the only handle on 897 lines of v1 leave logic that no other source enumerates.
   */
  registrations: Array<{ module: string; method: string; path: string; file: string; line: number; endLine?: number; framework: string }>;
  /** Registrations found but not turned into routes, with the reason — the audit trail for "recorded, not guessed". */
  unrecoveredRoutes: UnrecoveredEntry[];
  summary: { calls: number; static: number; framework: number; unresolved: number; ambiguous: number; weak: number; routes: number };
  warnings: string[];
}

/** Scan a workspace. Never throws for a missing graph or an unreadable file — both degrade with a warning. */
export async function scanCrossRepoLinks(workspace: string, modules: ScanModule[]): Promise<CrossRepoScan> {
  const warnings: string[] = [];
  const routeCandidates: RouteCandidate[] = [];
  const routeRecovery: CrossRepoScan["routeRecovery"] = [];
  const frontendFiles: Array<{ module: string; path: string; source: string }> = [];
  const unrecoveredDetail: UnrecoveredEntry[] = [];

  for (const module of modules) {
    const registrationFiles = routeFilesFromGraph(module, warnings);
    const moduleRoot = join(workspace, module.dir);
    let recovered = 0;
    let unrecovered = 0;
    let framework = "none";

    const expressFiles: string[] = [];
    for (const relative of registrationFiles) {
      const source = await readSource(join(moduleRoot, relative), warnings);
      if (source === null) continue;
      if (relative.endsWith(".go")) {
        framework = "gin";
        const recovery = recoverGinRoutes(relative, source);
        warnings.push(...recovery.warnings);
        unrecovered += recovery.unrecovered.length;
        for (const entry of recovery.unrecovered) unrecoveredDetail.push({ module: module.id, file: entry.file, line: entry.line, reason: entry.reason });
        for (const route of recovery.routes) routeCandidates.push({ module: module.id, route });
        recovered += recovery.routes.length;
      } else if (/\.(js|ts)$/.test(relative)) {
        framework = "express";
        expressFiles.push(relative);
      }
    }
    // Express is resolved as one pass over the module: mounts first, so a router file reached through a
    // mount is never recovered a SECOND time with an empty prefix. That second pass is how 23 phantom
    // routes with wrong paths entered the table on the real target — `POST /token` instead of
    // `POST /oauth/token` — and a wrong path is worse than a missing one, because it gets asserted.
    if (expressFiles.length) {
      const express = await recoverExpressWorkspace(moduleRoot, expressFiles, warnings, unrecoveredDetail, module.id);
      for (const route of express.routes) routeCandidates.push({ module: module.id, route });
      recovered += express.routes.length;
      unrecovered += express.unrecovered;
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
    registrations: routeCandidates
      .map(({ module, route }) => ({ module, method: route.method, path: route.path, file: route.file, line: route.line, ...(route.endLine === undefined ? {} : { endLine: route.endLine }), framework: route.framework }))
      .sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line),
    unrecoveredRoutes: unrecoveredDetail,
    summary: { calls: 0, static: 0, framework: 0, unresolved: 0, ambiguous: 0, weak: 0, routes: routeCandidates.length },
    warnings,
  };

  for (const file of frontendFiles) {
    for (const call of extractFrontendCalls(file.path, file.source, clients, warnings)) {
      scan.summary.calls += 1;
      record(scan, file.module, call, matchCall(call, routeCandidates));
    }
  }

  scan.links.sort((a, b) => cmp(a.from.module, b.from.module) || cmp(a.from.path, b.from.path) || a.from.line - b.from.line || cmp(a.from.method, b.from.method) || cmp(a.from.expression, b.from.expression));
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
      to: {
        module: link.module,
        path: link.route.file,
        line: link.route.line,
        route: `${link.route.method} ${link.route.path}`,
        localPath: link.route.localPath,
        prefixComposed: link.route.path !== link.route.localPath,
        handlerExpression: link.route.handlerExpression,
      },
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
      const nodes = index.routeSummary(ROUTE_NODE_CAP);
      if (nodes.length >= ROUTE_NODE_CAP) {
        warnings.push(`route discovery for ${module.id} hit the ${ROUTE_NODE_CAP}-node cap; some registration files may be missing`);
      }
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
      return index.routeSummary(ROUTE_NODE_CAP).length;
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
async function recoverExpressWorkspace(
  moduleRoot: string,
  files: string[],
  warnings: string[],
  unrecoveredDetail: UnrecoveredEntry[],
  moduleId: string,
): Promise<{ routes: RecoveredRoute[]; unrecovered: number }> {
  const routes: RecoveredRoute[] = [];
  let unrecovered = 0;
  const consumed = new Set<string>();

  // Pass 1: every app file's mounts, resolved through the `require` that produced the router.
  for (const relative of files) {
    const source = await readSource(join(moduleRoot, relative), warnings);
    if (source === null) continue;
    const mounts = expressMounts(source);
    if (!mounts.length) continue;
    consumed.add(relative);
    const requires = requireTargets(source);
    for (const mount of mounts) {
      const target = requires.get(mount.identifier);
      if (!target) {
        warnings.push(`express mount ${mount.prefix} → ${mount.identifier} has no require in ${relative}`);
        unrecovered += 1;
        unrecoveredDetail.push({ module: moduleId, file: relative, line: mount.line, reason: `mount target ${mount.identifier} has no require` });
        continue;
      }
      const resolved = await resolveRouterFile(moduleRoot, relative, target);
      if (!resolved) {
        // Never silent: an unresolvable mount means a whole prefix's routes are missing from the table.
        warnings.push(`express mount ${mount.prefix} → ${target} could not be read from ${relative}`);
        unrecovered += 1;
        unrecoveredDetail.push({ module: moduleId, file: relative, line: mount.line, reason: `mount target ${target} unreadable` });
        continue;
      }
      consumed.add(resolved.relative);
      const recovery = recoverExpressRoutes(resolved.relative, resolved.source, mount.prefix);
      warnings.push(...recovery.warnings);
      routes.push(...recovery.routes);
      unrecovered += recovery.unrecovered.length;
      for (const entry of recovery.unrecovered) unrecoveredDetail.push({ module: moduleId, file: entry.file, line: entry.line, reason: entry.reason });
    }
  }

  // Pass 2: a router file no mount reached. Its prefix is unknown, so its registrations are recorded as
  // unrecovered rather than rooted at "/" — the module's own "recorded rather than guessed" discipline.
  for (const relative of files) {
    if (consumed.has(relative)) continue;
    const source = await readSource(join(moduleRoot, relative), warnings);
    if (source === null) continue;
    const probe = recoverExpressRoutes(relative, source, "");
    if (!probe.routes.length && !probe.unrecovered.length) continue;
    unrecovered += probe.routes.length + probe.unrecovered.length;
    unrecoveredDetail.push({ module: moduleId, file: relative, line: probe.routes[0]?.line ?? 0, reason: `no mount prefix known for this router file (${probe.routes.length} registrations)` });
    warnings.push(`express router ${relative} is not reached by any mount; its ${probe.routes.length} registrations have no known prefix and were not added`);
  }

  return { routes, unrecovered };
}

/** Resolve a `require` target relative to the requiring file, trying the usual extensions. */
async function resolveRouterFile(moduleRoot: string, from: string, target: string): Promise<{ relative: string; source: string } | null> {
  const base = target.startsWith(".") ? join(dirname(from), target) : target;
  // A `require('../../../etc/x')` must not walk out of the module being scanned. The engine reads only
  // inside the boundary it was pointed at; a target that escapes it resolves to nothing.
  const resolvedRoot = resolve(moduleRoot);
  for (const suffix of ["", ".js", ".ts", "/index.js", "/index.ts"]) {
    const relative = `${base}${suffix}`;
    const absolute = resolve(moduleRoot, relative);
    if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}/`)) continue;
    const source = await readSource(absolute, []);
    if (source !== null) return { relative, source };
  }
  return null;
}

/** `const leaveRouter = require('./routes/leave')` — identifier to module-relative path. */
function requireTargets(source: string): Map<string, string> {
  const targets = new Map<string, string>();
  // The leading `./` or `../` is part of the path: swallowing it turns `../x` into `./x` and resolves
  // the wrong file — or, worse, silently none.
  const pattern = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
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
      if (!FRONTEND_EXTENSIONS.includes(extname(entry.name))) continue;
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
