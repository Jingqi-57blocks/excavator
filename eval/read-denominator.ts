// READ-DENOMINATOR — what the boundary-file second source added to a run's reading obligations.
//
// The denominator is the thing every read-coverage number divides by, so widening it is the one change
// that can make every other metric look different without anything real having improved. This report
// makes the widening itself auditable: how many obligations each source contributed, which spans went
// from unenumerated to enumerated, and — with `--must` — whether specific lines a human knows are rules
// actually entered the denominator.
//
// Two gates, deliberately separate:
//   - NON-REGRESSION: every obligation counted without the second source is still counted with it. Under a
//     union this is nearly tautological, so it proves only that nothing was lost — never that anything
//     was gained. It fails the command because losing an obligation silently is the worst outcome here.
//   - EFFECTIVENESS: each `--must path:line` lands inside a counted obligation. One example can be
//     satisfied by coincidence; pass several.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readObligations, type ReadObligation, type ReadObligationsArtifact } from "../src/assurance/read-obligations.ts";
import type { BoundaryFunctionsArtifact } from "../src/context/boundary-functions.ts";
import type { FeatureFactPack, InvestigationPlan } from "../src/core/types.ts";

export interface MustTarget {
  path: string;
  line: number;
}

export interface MustResult extends MustTarget {
  /** The counted obligation whose span holds this line, if any. */
  obligation?: { name: string; startLine: number; endLine?: number; kind: string; tier: number };
  satisfied: boolean;
}

export interface DenominatorReport {
  runDir: string;
  /** False when the run carries no boundary artifact — the report then only describes the first source. */
  secondSourceAvailable: boolean;
  before: { total: number; counted: number };
  after: { total: number; counted: number };
  secondSource: ReadObligationsArtifact["summary"]["secondSource"];
  /** Counted obligations lost by adding the second source. Non-empty means the non-regression gate failed. */
  lost: string[];
  must: MustResult[];
  /** Per-file enumeration gaps that the second source closed, largest first. */
  gapsClosed: Array<{ path: string; from: number; to: number; lines: number }>;
}

export function buildDenominatorReport(runDir: string, must: MustTarget[]): DenominatorReport {
  const packs = readFactPacks(runDir);
  const plan = readOptional<InvestigationPlan>(join(runDir, "workitems.json"));
  const boundary = readOptional<BoundaryFunctionsArtifact>(join(runDir, "context", "boundary-functions.json"));
  const items = plan?.items ?? [];

  const before = readObligations(packs, items);
  const after = boundary ? readObligations(packs, items, boundary) : before;

  const countedAfter = after.obligations.filter((obligation) => !obligation.excluded);
  const countedAfterIds = new Set(countedAfter.map((obligation) => obligation.id));
  const lost = before.obligations
    .filter((obligation) => !obligation.excluded && !countedAfterIds.has(obligation.id))
    .map((obligation) => obligation.id);

  return {
    runDir,
    secondSourceAvailable: Boolean(boundary),
    before: { total: before.obligations.length, counted: before.obligations.filter((o) => !o.excluded).length },
    after: { total: after.obligations.length, counted: countedAfter.length },
    secondSource: after.summary.secondSource,
    lost,
    must: must.map((target) => resolveMust(target, countedAfter)),
    gapsClosed: gapsClosed(before.obligations, after.obligations),
  };
}

function resolveMust(target: MustTarget, counted: ReadObligation[]): MustResult {
  const hit = counted.find((obligation) =>
    obligation.path === target.path
    && obligation.startLine <= target.line
    && (obligation.endLine ?? obligation.startLine) >= target.line);
  return hit
    ? { ...target, satisfied: true, obligation: { name: hit.name, startLine: hit.startLine, endLine: hit.endLine, kind: hit.kind, tier: hit.tier } }
    : { ...target, satisfied: false };
}

/** Ranges that were between two counted obligations before and are now covered by one. */
function gapsClosed(before: ReadObligation[], after: ReadObligation[]): DenominatorReport["gapsClosed"] {
  const closed: DenominatorReport["gapsClosed"] = [];
  const beforeByPath = groupByPath(before);
  const afterByPath = groupByPath(after);
  for (const [path, spans] of beforeByPath) {
    const later = afterByPath.get(path);
    if (!later) continue;
    for (let index = 1; index < spans.length; index++) {
      const from = spans[index - 1].end + 1;
      const to = spans[index].start - 1;
      if (to < from) continue;
      const filled = later.some((span) => span.start >= from && span.start <= to);
      if (filled) closed.push({ path, from, to, lines: to - from + 1 });
    }
  }
  return closed.sort((a, b) => b.lines - a.lines || cmp(a.path, b.path) || a.from - b.from);
}

function groupByPath(obligations: ReadObligation[]): Map<string, Array<{ start: number; end: number }>> {
  const byPath = new Map<string, Array<{ start: number; end: number }>>();
  for (const obligation of obligations) {
    if (obligation.excluded || obligation.endLine === undefined) continue;
    const list = byPath.get(obligation.path) ?? [];
    list.push({ start: obligation.startLine, end: obligation.endLine });
    byPath.set(obligation.path, list);
  }
  for (const list of byPath.values()) list.sort((a, b) => a.start - b.start);
  return byPath;
}

/** Exit 1 when an obligation was lost or a `--must` target missed: the same honest-red contract as `diff`. */
export function denominatorExitCode(report: DenominatorReport): number {
  if (report.lost.length) return 1;
  if (report.must.some((entry) => !entry.satisfied)) return 1;
  return 0;
}

export function renderDenominator(report: DenominatorReport): string {
  const lines: string[] = [];
  lines.push(`read denominator — ${report.runDir}`);
  if (!report.secondSourceAvailable) lines.push("  (no boundary artifact in this run: first source only)");
  lines.push(`  counted ${report.before.counted} → ${report.after.counted}   total ${report.before.total} → ${report.after.total}`);
  const second = report.secondSource;
  if (second) {
    lines.push(`  second source: ${second.added} added, ${second.duplicate} already known, ${second.candidates} candidates, ${second.decisionBearing} decision-bearing, ${second.unprobed} unprobed, ${second.filesWithoutCandidates} files without candidates (graph ${second.graphAvailable ? "available" : "ABSENT"})`);
  }
  lines.push(`  non-regression: ${report.lost.length === 0 ? "pass — no counted obligation lost" : `FAIL — ${report.lost.length} lost`}`);
  for (const id of report.lost.slice(0, 10)) lines.push(`      lost ${id}`);
  for (const entry of report.must) {
    lines.push(entry.satisfied
      ? `  must ${entry.path}:${entry.line} — covered by ${entry.obligation?.name} ${entry.obligation?.startLine}-${entry.obligation?.endLine} (${entry.obligation?.kind}, tier ${entry.obligation?.tier})`
      : `  must ${entry.path}:${entry.line} — MISSING from the counted denominator`);
  }
  if (report.gapsClosed.length) {
    lines.push(`  enumeration gaps closed: ${report.gapsClosed.length}`);
    for (const gap of report.gapsClosed.slice(0, 5)) lines.push(`      ${gap.path} ${gap.from}-${gap.to} (${gap.lines} lines)`);
  }
  return lines.join("\n");
}

/** `path:line`, where the path may itself contain colons on no platform we support but the line never does. */
export function parseMust(value: string): MustTarget {
  const index = value.lastIndexOf(":");
  const line = index < 0 ? NaN : Number(value.slice(index + 1));
  if (index < 0 || !Number.isInteger(line) || line < 1) throw new Error(`--must expects <path>:<line>, got "${value}"`);
  return { path: value.slice(0, index), line };
}

function readFactPacks(runDir: string): FeatureFactPack[] {
  const dir = join(runDir, "context", "features");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".factpack.json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as FeatureFactPack);
}

function readOptional<T>(path: string): T | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : null;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
