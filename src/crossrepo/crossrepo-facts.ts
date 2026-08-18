import { notApplicable, unavailable, type NotApplicable, type Unavailable } from "../base/artifact-result.ts";
import {
  canonicalModuleSources, CODEGRAPH_MODULES_BASIS, coverageBasisDigest, fileCompletenessValue, FILE_COMPLETENESS_BASIS,
  mechanismCoverageBasisName
} from "../base/coverage-basis.ts";
import { sha256, stableJson } from "../base/util.ts";
import type { FactDetail, ObservedFact } from "../facts/units/membership-map.ts";
import { CROSSREPO_SCAN_VERSION, type CrossRepoScan } from "./crossrepo-scan.ts";

/**
 * The cross-repo resolver as a layer-3 fact producer: three fact kinds, one determination.
 *
 * `http-link` is the reason `Membership` is a closed union rather than a cell id (§一): a resolved link really has
 * TWO ends in two modules — the call in a frontend file and the route in another repository — and picking one end
 * is how a cross-repo edge gets read as co-located and dropped, which is P17 at another granularity. Its seat rule
 * is `any-endpoint`, declared in the base registry beside the kind, so the consumer has no rule to choose.
 *
 * PATHS. The scan reports MODULE-relative paths, because each module's route recovery and frontend walk run inside
 * that module's directory; a partition cell is keyed by a target-relative path. The translation happens here, once,
 * against the module list the run detected — and a path that does not translate to a counted row lands in the
 * envelope's `membershipUnmapped` bucket rather than being silently matched against nothing.
 */

export const CROSSREPO_FACTS_VERSION = "crossrepo-facts-v1";

export interface CrossRepoModule {
  readonly id: string;
  /** The module's directory, target-relative. Empty for a module rooted at the target itself. */
  readonly dir: string;
}

/**
 * The observations, from the scan the run already performed.
 *
 * Every call site the scan saw is here, not just the ones that matched: `links[].from` plus the unresolved,
 * ambiguous and weak buckets is exactly the set `record()` in `crossrepo-scan.ts` routes calls into, so the
 * `frontend-call` count equals `summary.calls` — an equality worth asserting, because "the matcher's yield" and
 * "the call sites that exist" are the two numbers the resolver must never confuse.
 */
export function crossRepoObservations(scan: CrossRepoScan, modules: readonly CrossRepoModule[]): ObservedFact[] {
  const dirOf = new Map(modules.map((module) => [module.id, module.dir]));
  const resolve = (moduleId: string, path: string): string => targetRelative(dirOf.get(moduleId) ?? "", path);
  const used = new Map<string, number>();
  const facts: ObservedFact[] = [];

  for (const registration of scan.registrations) {
    const relativePath = resolve(registration.module, registration.file);
    facts.push({
      factId: unique(used, `route:${registration.module}:${relativePath}:${registration.line}:${registration.method} ${registration.path}`),
      kind: "recovered-route",
      // No unit kind is claimed. A registration line declares a ROUTE; whatever unit sits there is the file
      // builder's finding, and a producer naming one would be inventing structure it did not parse.
      anchors: [{ relativePath, startLine: registration.line, endLine: registration.endLine ?? null, unitKind: null }],
      detail: {
        module: registration.module,
        method: registration.method,
        path: registration.path,
        framework: registration.framework,
        startLine: registration.line,
        endLine: registration.endLine ?? null
      } satisfies FactDetail
    });
  }

  for (const call of callSites(scan)) {
    const relativePath = resolve(call.module, call.path);
    facts.push({
      factId: unique(used, `call:${relativePath}:${call.line}:${call.method}:${call.routePath ?? "unresolved"}`),
      kind: "frontend-call",
      anchors: [{ relativePath, startLine: call.line, endLine: null, unitKind: null }],
      detail: { module: call.module, method: call.method, routePath: call.routePath, outcome: call.outcome, startLine: call.line } satisfies FactDetail
    });
  }

  for (const link of scan.links) {
    const fromPath = resolve(link.from.module, link.from.path);
    const toPath = resolve(link.to.module, link.to.path);
    facts.push({
      factId: unique(used, `link:${fromPath}:${link.from.line}:${link.to.module}:${toPath}:${link.to.line}`),
      kind: "http-link",
      anchors: [
        { relativePath: fromPath, startLine: link.from.line, endLine: null, unitKind: null },
        { relativePath: toPath, startLine: link.to.line, endLine: null, unitKind: null }
      ],
      detail: {
        fromModule: link.from.module,
        toModule: link.to.module,
        method: link.from.method,
        route: link.to.route,
        resolution: link.resolution,
        confidence: link.confidence,
        rule: link.rule
      } satisfies FactDetail
    });
  }
  return facts;
}

interface CallSite {
  readonly module: string;
  readonly path: string;
  readonly line: number;
  readonly method: string;
  readonly routePath: string | null;
  readonly outcome: "linked" | "unresolved" | "ambiguous" | "weak";
}

/** Every call site the scan classified, across all four outcomes. Exhaustive over `record()`'s branches. */
function callSites(scan: CrossRepoScan): CallSite[] {
  return [
    ...scan.links.map((link) => ({ module: link.from.module, path: link.from.path, line: link.from.line, method: link.from.method, routePath: link.from.routePath, outcome: "linked" as const })),
    ...scan.unresolved.map((entry) => ({ module: entry.module, path: entry.path, line: entry.line, method: entry.method, routePath: entry.routePath, outcome: "unresolved" as const })),
    ...scan.ambiguous.map((entry) => ({ module: entry.module, path: entry.path, line: entry.line, method: entry.method, routePath: entry.routePath, outcome: "ambiguous" as const })),
    ...scan.candidates.map((entry) => ({ module: entry.module, path: entry.path, line: entry.line, method: entry.method, routePath: entry.routePath, outcome: "weak" as const }))
  ];
}

/** The module-relative → target-relative translation, the exact inverse of what the scan's walk produced. */
export function targetRelative(moduleDir: string, modulePath: string): string {
  const normalized = modulePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!moduleDir) return normalized;
  return normalized ? `${moduleDir}/${normalized}` : moduleDir;
}

function unique(used: Map<string, number>, base: string): string {
  const seen = (used.get(base) ?? 0) + 1;
  used.set(base, seen);
  return seen === 1 ? base : `${base}#${seen}`;
}

export interface CrossRepoDeterminationInput {
  /** The module list the run detected, or null when it detected none at all. */
  readonly modules: readonly CrossRepoModule[] | null;
  /** Whether the resolver's own runtime dependency (the ast-grep binding) is available this run. */
  readonly resolverAvailable: boolean;
  /** Null when resolution was attempted and produced nothing usable. */
  readonly scan: CrossRepoScan | null;
  /** Layer 1's scan completeness. A capped scan cannot support a "there is only one module" determination. */
  readonly ledgerCompleteness: { readonly capReached: boolean; readonly skippedByCap: number; readonly droppedRoots: readonly string[]; readonly readFailures?: number };
  /** The exact request-level module database paths persisted in request.json. */
  readonly moduleSources?: readonly string[];
  /** The normalized layer-2 record for the crossrepo mechanism. */
  readonly mechanismCoverage?: unknown;
}

/**
 * Whether this run can publish cross-repo facts, and if not, WHICH kind of not.
 *
 * The single-module answer is a `NotApplicable` determination, not a blind spot: a target with one module provably
 * has no cross-repo edge. But §四 makes a determination carry its premise, and the premise here is that layer 1
 * saw the whole tree. If the file cap refused candidates or dropped a root, a second module may be sitting in the
 * part nobody looked at — so the determination does not hold and the honest answer is `Unavailable`. That check
 * mirrors what layer 8 does to every `NotApplicable` it reads; doing it at the source means the two agree.
 *
 * Returns `null` when the producer may proceed to `Built`.
 */
export function crossRepoDetermination(input: CrossRepoDeterminationInput): NotApplicable | Unavailable | null {
  if (!input.resolverAvailable) {
    return unavailable("the cross-repo resolver's ast-grep binding is unavailable, so no call site could be parsed", true);
  }
  const modules = input.modules ?? [];
  const capped = input.ledgerCompleteness.capReached || input.ledgerCompleteness.skippedByCap > 0
    || input.ledgerCompleteness.droppedRoots.length > 0 || Number(input.ledgerCompleteness.readFailures ?? 0) > 0;
  if (modules.length < 2) {
    if (capped) {
      return unavailable(`the target looks single-module, but layer 1's scan was incomplete (skippedByCap ${input.ledgerCompleteness.skippedByCap}, droppedRoots ${input.ledgerCompleteness.droppedRoots.length}, readFailures ${input.ledgerCompleteness.readFailures ?? 0}), so a second module may be in the part that was never examined`, true);
    }
    return notApplicable(
      "single-module",
      [FILE_COMPLETENESS_BASIS, mechanismCoverageBasisName("crossrepo"), CODEGRAPH_MODULES_BASIS],
      coverageBasisDigest([
        { reference: FILE_COMPLETENESS_BASIS, value: fileCompletenessValue(input.ledgerCompleteness) },
        { reference: mechanismCoverageBasisName("crossrepo"), value: input.mechanismCoverage ?? null },
        { reference: CODEGRAPH_MODULES_BASIS, value: canonicalModuleSources(input.moduleSources) }
      ])
    );
  }
  if (input.scan === null) {
    return unavailable(`the target has ${modules.length} modules but cross-repo resolution produced no scan`, true);
  }
  return null;
}

/** The producer's configuration and mode, digested into its envelope identity. */
export function crossRepoConfigDigest(modules: readonly CrossRepoModule[], scan: CrossRepoScan): string {
  return sha256(stableJson({
    factsVersion: CROSSREPO_FACTS_VERSION,
    scanVersion: scan.version,
    scannerContract: CROSSREPO_SCAN_VERSION,
    modules: modules.map((module) => ({ id: module.id, dir: module.dir })).sort((a, b) => a.id.localeCompare(b.id)),
    clients: [...scan.clients].sort()
  }));
}

/** The producer's own completeness record: what it looked at and what it could not resolve. Scalars only. */
export function crossRepoCompleteness(scan: CrossRepoScan): FactDetail {
  return {
    modules: scan.modules.length,
    calls: scan.summary.calls,
    routes: scan.summary.routes,
    linked: scan.links.length,
    unresolved: scan.summary.unresolved,
    ambiguous: scan.summary.ambiguous,
    weak: scan.summary.weak,
    unrecoveredRoutes: scan.unrecoveredRoutes.length,
    warnings: scan.warnings.length
  };
}
