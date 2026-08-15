// CROSSREPO GATE — does the resolver still find the links a human verified, and does it still refuse the
// ones a human verified are not links?
//
// Two directions, because a resolver can fail in two directions. A missing link is a gap the reader can
// still see in the unresolved list; a WRONG link is a false statement in a report, and nothing downstream
// will question it. So the gate is:
//   - `links`          every gold pair must be found, and found pointing at the same backend;
//   - `mustUnresolved` every gold non-link must still be unresolved. A resolver that "helpfully" matched
//                      `PATCH /v2/employee/:id/personal-information` to the backend's GET would hide a real
//                      product bug — the gate has to be able to go red in that direction too.
//
// And a sample, because gold only constrains gold. Ten hand-checked pairs say nothing about the precision
// of the other several hundred links; the sample is the part of the gate that can catch a resolver that is
// right where it was watched and wrong everywhere else. It is deterministic (ordered by the hash of each
// link's id) so the same run always offers the same sample for review.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

export interface CrossRepoGoldLink {
  id: string;
  from: { path: string; line: number; method: string };
  to: { module: string; route: string; handler?: string };
  note?: string;
}

export interface CrossRepoGoldUnresolved {
  id: string;
  from: { path: string; line: number; method: string };
  routePath: string;
  note?: string;
}

export interface CrossRepoGold {
  version: string;
  target: string;
  links: CrossRepoGoldLink[];
  mustUnresolved: CrossRepoGoldUnresolved[];
}

/** A gold call site is matched by file + method, with a small line tolerance so edits above it do not lie. */
const LINE_TOLERANCE = 3;

export function loadCrossRepoGold(path: string): CrossRepoGold {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CrossRepoGold>;
  if (parsed.version !== "crossrepo-gold-v1") throw new Error(`unsupported gold version: ${String(parsed.version)}`);
  if (!Array.isArray(parsed.links) || !parsed.links.length) throw new Error("gold has no links");
  for (const link of parsed.links) {
    if (!link.id || !link.from?.path || !link.from?.method || !link.to?.module || !link.to?.route) {
      throw new Error(`gold link ${String(link.id)} is missing a required field`);
    }
  }
  return { version: parsed.version, target: parsed.target ?? "", links: parsed.links, mustUnresolved: parsed.mustUnresolved ?? [] };
}

interface ArtifactLink {
  id: string;
  from: { module: string; path: string; line: number; method: string; routePath: string };
  to: { module: string; path: string; line: number; route: string; handlerExpression: string };
  resolution: string;
  rule: string;
  evidenceIds?: string[];
}

interface Artifact {
  links: ArtifactLink[];
  unresolved: Array<{ path: string; line: number; method: string; routePath: string | null }>;
  candidates: Array<{ path: string; line: number; method: string; routePath: string }>;
  ambiguous: Array<{ path: string; line: number; method: string; routePath: string }>;
  summary: Record<string, number>;
}

export interface GoldResult {
  id: string;
  status: "found" | "missing" | "wrong-target";
  expected: string;
  actual?: string;
}

export interface UnresolvedResult {
  id: string;
  status: "still-unresolved" | "now-linked";
  actual?: string;
}

export interface CrossRepoReport {
  artifactPath: string;
  gold: GoldResult[];
  mustUnresolved: UnresolvedResult[];
  /** Links whose two evidence records are not both present — a link nobody can check. */
  unboundLinks: string[];
  sample: Array<{ id: string; resolution: string; rule: string; from: string; to: string }>;
  summary: Record<string, number>;
}

export function buildCrossRepoReport(artifactPath: string, gold: CrossRepoGold, sampleSize: number): CrossRepoReport {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Artifact;
  const goldIds = new Set<string>();

  const results: GoldResult[] = gold.links.map((entry) => {
    const found = artifact.links.find((link) =>
      link.from.path === entry.from.path
      && link.from.method === entry.from.method
      && Math.abs(link.from.line - entry.from.line) <= LINE_TOLERANCE);
    const expected = `${entry.to.module} ${entry.to.route}`;
    if (!found) return { id: entry.id, status: "missing", expected };
    goldIds.add(found.id);
    const actual = `${found.to.module} ${found.to.route}`;
    if (actual !== expected) return { id: entry.id, status: "wrong-target", expected, actual };
    if (entry.to.handler && !found.to.handlerExpression.includes(entry.to.handler)) {
      return { id: entry.id, status: "wrong-target", expected: `${expected} via ${entry.to.handler}`, actual: `${actual} via ${found.to.handlerExpression.slice(0, 60)}` };
    }
    return { id: entry.id, status: "found", expected, actual };
  });

  const unresolvedResults: UnresolvedResult[] = gold.mustUnresolved.map((entry) => {
    const linked = artifact.links.find((link) =>
      link.from.path === entry.from.path
      && link.from.method === entry.from.method
      && Math.abs(link.from.line - entry.from.line) <= LINE_TOLERANCE);
    return linked
      ? { id: entry.id, status: "now-linked", actual: `${linked.to.module} ${linked.to.route}` }
      : { id: entry.id, status: "still-unresolved" };
  });

  const unboundLinks = artifact.links
    .filter((link) => !Array.isArray(link.evidenceIds) || link.evidenceIds.length !== 2)
    .map((link) => link.id)
    .slice(0, 20);

  // Deterministic sample of links gold does not already pin: ordered by the hash of the link id, so the
  // same artifact always offers the same links for human review, with no seed to remember or lose.
  const sample = artifact.links
    .filter((link) => !goldIds.has(link.id))
    .map((link) => ({ link, key: createHash("sha256").update(link.id).digest("hex") }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, sampleSize)
    .map(({ link }) => ({
      id: link.id,
      resolution: link.resolution,
      rule: link.rule,
      from: `${link.from.path}:${link.from.line} ${link.from.method} ${link.from.routePath}`,
      to: `${link.to.module} ${link.to.route} @${link.to.path}:${link.to.line}`,
    }));

  return { artifactPath, gold: results, mustUnresolved: unresolvedResults, unboundLinks, sample, summary: artifact.summary };
}

/** Exit 1 on any gold miss, wrong target, silenced non-link, or unbound link — the honest-red contract. */
export function crossRepoExitCode(report: CrossRepoReport): number {
  if (report.gold.some((entry) => entry.status !== "found")) return 1;
  if (report.mustUnresolved.some((entry) => entry.status !== "still-unresolved")) return 1;
  if (report.unboundLinks.length) return 1;
  return 0;
}

export function renderCrossRepoReport(report: CrossRepoReport): string {
  const lines: string[] = [];
  lines.push(`crossrepo gate — ${report.artifactPath}`);
  lines.push(`  links ${report.summary.static ?? 0} static / ${report.summary.framework ?? 0} framework, unresolved ${report.summary.unresolved ?? 0}, ambiguous ${report.summary.ambiguous ?? 0}, weak ${report.summary.weak ?? 0}`);

  const missed = report.gold.filter((entry) => entry.status !== "found");
  lines.push(`  gold: ${report.gold.length - missed.length}/${report.gold.length} found`);
  for (const entry of missed) {
    lines.push(`      ${entry.status.toUpperCase()} ${entry.id} — expected ${entry.expected}${entry.actual ? `, got ${entry.actual}` : ""}`);
  }

  const silenced = report.mustUnresolved.filter((entry) => entry.status !== "still-unresolved");
  lines.push(`  must-stay-unresolved: ${report.mustUnresolved.length - silenced.length}/${report.mustUnresolved.length} still unresolved`);
  for (const entry of silenced) lines.push(`      NOW LINKED ${entry.id} → ${entry.actual} (a real finding would be hidden by this)`);

  if (report.unboundLinks.length) {
    lines.push(`  UNBOUND LINKS: ${report.unboundLinks.length} link(s) do not carry two evidence records`);
    for (const id of report.unboundLinks.slice(0, 5)) lines.push(`      ${id}`);
  }

  if (report.sample.length) {
    lines.push(`  sample for human review (${report.sample.length}, deterministic, gold excluded):`);
    for (const entry of report.sample) lines.push(`      [${entry.resolution}/${entry.rule}] ${entry.from}  →  ${entry.to}`);
  }
  return lines.join("\n");
}

export function artifactExists(path: string): boolean {
  return existsSync(path);
}
