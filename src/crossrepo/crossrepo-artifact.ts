// CROSSREPO ARTIFACT — the scan, turned into run artifacts: a frozen link record and the evidence each
// link is bound to.
//
// EVIDENCE KIND IS A CORRECTNESS DECISION, NOT A FORMATTING ONE. A link's two ends point at source lines,
// so `kind: "source"` looks like the obvious choice — and it would be a silent, self-inflicted wound:
// `reconcileReadCoverage` treats every `source` evidence item as a WINDOW THAT WAS OPENED
// (`read-coverage.ts:92`). Minting link ends as source would mark each resolved handler's span as read
// without anyone having read it, inflating the very reading accountability this line of work exists to
// establish. They are minted as `derived`: snapshot-bound, digest-carrying, citable — and invisible to the
// read-coverage reconciliation, which is exactly right, because resolving a route is not reading it.
//
// What a link's evidence does buy: a claim about "the frontend calls this endpoint and this handler serves
// it" cites two records that name a file, a line and the expression found there, so the statement is
// checkable rather than asserted.

import type { EvidenceItem } from "../core/types.ts";
import { redactSecrets, sha256, stableJson } from "../core/util.ts";
import type { CrossRepoScan } from "./crossrepo-scan.ts";

export const CROSSREPO_ARTIFACT_VERSION = "crossrepo-links-v1";

/** Evidence ids for cross-repo links are prefixed so their provenance is legible in any citation list. */
const EVIDENCE_PREFIX = "XR";

export interface CrossRepoEvidence {
  evidence: EvidenceItem[];
  /** Link id → its two evidence ids, in `[from, to]` order. */
  byLink: Map<string, [string, string]>;
}

/** A stable id for one link: the call site plus its method fully determines it. */
export function linkId(link: CrossRepoScan["links"][number]): string {
  return `xrl:${link.from.module}:${link.from.path}:${link.from.line}:${link.from.method}`;
}

/**
 * Mint the two derived evidence records each link is bound to. Deterministic: ids and digests derive from
 * the link's own coordinates, so the same snapshot yields byte-identical evidence.
 */
/**
 * The two fields of a link that are SOURCE TEXT rather than structure, under this run's mode.
 *
 * Shared by the evidence and the artifact because they were written separately and diverged: the evidence
 * twin redacted a `?key=…` URL literal while `context/crossrepo-links.json` kept it verbatim, and nothing
 * could see the difference — a structured artifact's digest is self-consistent whatever it holds, so the
 * audit's re-derivation, the one check that catches a window recorded under the wrong mode, does not apply.
 * One function so a third writer cannot invent a third answer.
 */
function underMode(link: CrossRepoScan["links"][number], redact: boolean): CrossRepoScan["links"][number] {
  if (!redact) return link;
  return {
    ...link,
    from: { ...link.from, expression: redactSecrets(link.from.expression) },
    to: { ...link.to, handlerExpression: redactSecrets(link.to.handlerExpression) },
  };
}

export function mintCrossRepoEvidence(scan: CrossRepoScan, snapshotId: string, redact: boolean): CrossRepoEvidence {
  const evidence: EvidenceItem[] = [];
  const byLink = new Map<string, [string, string]>();

  for (const raw of scan.links) {
    const link = underMode(raw, redact);
    const id = linkId(raw);
    const fromId = `${EVIDENCE_PREFIX}-call-${sha256(id).slice(0, 12)}`;
    const toId = `${EVIDENCE_PREFIX}-route-${sha256(`${id}|${link.to.module}|${link.to.path}|${link.to.line}`).slice(0, 12)}`;
    const fromRecord = {
      module: link.from.module,
      path: link.from.path,
      line: link.from.line,
      method: link.from.method,
      routePath: link.from.routePath,
      // Source text verbatim would route around the redaction pipeline: a URL literal can carry a
      // token (`?key=…`), and evidence.json is a durable artifact.
      expression: link.from.expression,
    };
    const toRecord = {
      module: link.to.module,
      path: link.to.path,
      line: link.to.line,
      route: link.to.route,
      handlerExpression: link.to.handlerExpression,
    };
    evidence.push({
      id: fromId,
      snapshotId,
      kind: "derived",
      title: `HTTP call ${link.from.method} ${link.from.routePath}`,
      path: `${link.from.module}/${link.from.path}`,
      startLine: link.from.line,
      endLine: link.from.line,
      data: fromRecord,
      reason: "the frontend call site this cross-repo link starts from",
      digest: sha256(stableJson(fromRecord)),
    });
    evidence.push({
      id: toId,
      snapshotId,
      kind: "derived",
      title: `Route ${link.to.route}`,
      path: `${link.to.module}/${link.to.path}`,
      startLine: link.to.line,
      endLine: link.to.line,
      data: toRecord,
      reason: "the backend registration this cross-repo link resolves to",
      digest: sha256(stableJson(toRecord)),
    });
    byLink.set(id, [fromId, toId]);
  }

  evidence.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { evidence, byLink };
}

/** The frozen link artifact: the scan plus the evidence binding, in the §四 payload shape. */
export interface CrossRepoArtifact {
  version: string;
  snapshotId: string;
  modules: string[];
  clients: string[];
  links: Array<{
    id: string;
    kind: "http-route";
    from: CrossRepoScan["links"][number]["from"];
    to: CrossRepoScan["links"][number]["to"];
    resolution: string;
    confidence: string;
    rule: string;
    evidenceIds: [string, string];
  }>;
  unresolved: CrossRepoScan["unresolved"];
  ambiguous: CrossRepoScan["ambiguous"];
  candidates: CrossRepoScan["candidates"];
  routeRecovery: CrossRepoScan["routeRecovery"];
  registrations: CrossRepoScan["registrations"];
  summary: CrossRepoScan["summary"];
  warnings: string[];
}

export function buildCrossRepoArtifact(scan: CrossRepoScan, snapshotId: string, binding: CrossRepoEvidence, redact: boolean): CrossRepoArtifact {
  return {
    version: CROSSREPO_ARTIFACT_VERSION,
    snapshotId,
    modules: scan.modules,
    clients: scan.clients,
    links: scan.links.map((raw) => {
      const id = linkId(raw);
      const link = underMode(raw, redact);
      return {
        id,
        kind: "http-route" as const,
        from: link.from,
        to: link.to,
        resolution: link.resolution,
        confidence: link.confidence,
        rule: link.rule,
        evidenceIds: binding.byLink.get(id) as [string, string],
      };
    }),
    unresolved: scan.unresolved,
    ambiguous: scan.ambiguous,
    candidates: scan.candidates,
    routeRecovery: scan.routeRecovery,
    registrations: scan.registrations,
    summary: scan.summary,
    warnings: scan.warnings,
  };
}

/**
 * The handler obligations this artifact contributes to one feature.
 *
 * Attribution runs from the CALL side: a handler is this feature's reading obligation when the feature's
 * boundary contains the frontend file that calls it. That is the whole point of a cross-repo link — the
 * backend file is normally in a different repo and would never enter the boundary on its own, which is
 * exactly the blindness being removed. A handler whose span could not be resolved contributes nothing,
 * because a registration line is one line long and would be excluded as declaration-only anyway.
 */
export function routeHandlerObligations(
  artifact: CrossRepoArtifact,
  featureKey: string,
  boundaryFiles: Set<string>,
  resolve: (link: CrossRepoArtifact["links"][number]) => { name: string; path: string; startLine: number; endLine: number } | null,
): Array<{ featureKey: string; name: string; path: string; startLine: number; endLine: number; route: string }> {
  const out: Array<{ featureKey: string; name: string; path: string; startLine: number; endLine: number; route: string }> = [];
  const seen = new Set<string>();
  for (const link of artifact.links) {
    if (!boundaryFiles.has(link.from.path) && !boundaryFiles.has(`${link.from.module}/${link.from.path}`)) continue;
    const resolved = resolve(link);
    if (!resolved) continue;
    const path = `${link.to.module}/${resolved.path}`;
    const key = `${path}:${resolved.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ featureKey, name: resolved.name, path, startLine: resolved.startLine, endLine: resolved.endLine, route: link.to.route });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.startLine - b.startLine);
  return out;
}

/**
 * Turn RECOVERED route registrations into reading obligations — the FOURTH denominator source.
 *
 * Distinct from `routeHandlerObligations` in what it can reach, not in how it works. That one starts from a
 * resolved link and needs a NAMED handler to resolve to; a registration whose handler is written inline
 * resolves to nothing, so every earlier source is silent on it. Measured on the real target: two v1 express
 * files hold 16 registrations, 9 decision-bearing, 719 accountable lines that no source enumerated — and
 * because a file with no obligation contributes to no bucket, windows opened there were invisible to BOTH
 * sides of the funnel (9 in one run, 13 in another, all unaccounted).
 *
 * The name carries the route because that is where the vocabulary lives: a mounted express path is often
 * just `/` locally, so `relevance-annotation` would have nothing to match without it.
 *
 * Exported and pure for the same reason its sibling is: a construction that only exists inside a freeze
 * function can be deleted whole with every test still green — measured, twice, on this very function.
 */
export function recoveredRouteObligations(
  links: { registrations?: CrossRepoArtifact["registrations"] } | null,
  factPacks: Record<string, { items?: Array<{ filePath?: unknown }> }>,
): Array<{ featureKey: string; name: string; path: string; startLine: number; endLine: number; route: string }> | null {
  const registrations = links?.registrations ?? [];
  const obligations: Array<{ featureKey: string; name: string; path: string; startLine: number; endLine: number; route: string }> = [];
  for (const [featureKey, pack] of Object.entries(factPacks)) {
    const boundaryFiles = new Set((pack.items ?? []).map((item) => String(item.filePath ?? "")));
    for (const entry of registrations) {
      // Only a registration whose span is known can become an obligation: without an end line there is no
      // span to reconcile, and a span-less obligation would sit in `cannot-determine` forever.
      if (entry.endLine === undefined || entry.endLine < entry.line) continue;
      // Both forms, because a fact pack's paths are target-relative while a registration knows its module:
      // whichever way the target's modules are laid out, one of the two matches — and a scan that matched
      // neither would contribute zero obligations without saying so, which is the silence this line removes.
      const qualified = `${entry.module}/${entry.file}`;
      if (!boundaryFiles.has(entry.file) && !boundaryFiles.has(qualified)) continue;
      obligations.push({
        featureKey,
        name: `${entry.method} ${entry.path}`,
        path: qualified,
        startLine: entry.line,
        endLine: entry.endLine,
        route: entry.path,
      });
    }
  }
  obligations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.startLine - b.startLine);
  return obligations.length ? obligations : null;
}

/** The handler spans this artifact resolves — the input the read-obligation third source consumes. */
export function resolvedHandlers(artifact: CrossRepoArtifact): Array<{ module: string; path: string; line: number; route: string; symbol: string }> {
  const seen = new Set<string>();
  const handlers: Array<{ module: string; path: string; line: number; route: string; symbol: string }> = [];
  for (const link of artifact.links) {
    const key = `${link.to.module}\u0000${link.to.path}\u0000${link.to.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    handlers.push({ module: link.to.module, path: link.to.path, line: link.to.line, route: link.to.route, symbol: link.to.handlerExpression });
  }
  handlers.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line);
  return handlers;
}
