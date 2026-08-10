// RunComparison -> human-readable A->B delta view. This module owns every
// human-facing string for the `compare` command, including the honesty note that
// carries the two caveats from compare-runs.ts (wall-clock gap-attribution;
// knowledge alignment by cited-evidence anchor, not by claim id).
//
// It is a report, not a gate: it prints deltas and flags notable changes, but
// asserts improvement/regression ONLY for lower-is-better time metrics. Count
// deltas are shown with a direction arrow and no value judgement.

import { fmtDuration } from "./render-run-stats.ts";
import type { Anchor, MetricDelta, RunComparison } from "./compare-runs.ts";

function arrow(direction: MetricDelta["direction"]): string {
  return direction === "up" ? "↑" : direction === "down" ? "↓" : direction === "flat" ? "=" : "?";
}

/** Format one side of a metric by its unit. */
function fmtValue(value: number | null, unit: MetricDelta["unit"]): string {
  if (value === null) return "n/a";
  if (unit === "ms") return fmtDuration(value);
  return String(value);
}

/** Signed delta, formatted by unit (durations stay human, counts keep their sign). */
function fmtDelta(delta: number | null, unit: MetricDelta["unit"]): string {
  if (delta === null) return "n/a";
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "±";
  if (unit === "ms") return `${sign}${fmtDuration(Math.abs(delta))}`;
  return `${sign}${Math.abs(delta)}`;
}

function fmtPct(pct: number | null): string {
  if (pct === null) return "";
  const sign = pct > 0 ? "+" : "";
  return `, ${sign}${pct}%`;
}

function tag(metric: MetricDelta): string {
  if (metric.assessment === "improvement") return "  [improvement]";
  if (metric.assessment === "regression") return "  [regression]";
  return "";
}

function metricLine(metric: MetricDelta): string {
  const a = fmtValue(metric.a, metric.unit);
  const b = fmtValue(metric.b, metric.unit);
  return `    ${metric.label}: ${a} -> ${b}  (Δ ${fmtDelta(metric.delta, metric.unit)}${fmtPct(metric.pct)}) ${arrow(metric.direction)}${tag(metric)}`;
}

function fmtAnchor(anchor: Anchor): string {
  return `${anchor.path}:${anchor.startLine}-${anchor.endLine}`;
}

function renderHeader(comparison: RunComparison): string[] {
  return [
    "=== run comparison (A -> B) ===",
    `  A: ${comparison.a.runId}  (${comparison.a.runDir})`,
    `  B: ${comparison.b.runId}  (${comparison.b.runDir})`
  ];
}

function renderHonesty(): string[] {
  return [
    "=== how to read this (honesty) ===",
    "  Wall-clock deltas inherit the gap-attribution caveat from the single-run view: per-stage and",
    "  total wall clock include the host agent's own thinking and CLI execution between timeline events,",
    "  which Excavator cannot observe or separate out. Only the Core prepare timings are directly measured.",
    "  Improvement/regression is asserted ONLY for these lower-is-better time metrics; count deltas carry a",
    "  direction arrow and no value judgement (more claims is not inherently 'better').",
    "  Knowledge deltas align FACTS by their CITED SOURCE-WINDOW ANCHOR (path + overlapping line range),",
    "  NEVER by claim id — ids are not stable across runs. Relation alignment is best-effort by the same",
    "  anchor rule; coverage aligns by dimension. This is a report, not a gate: no pass/fail."
  ];
}

function renderNotable(comparison: RunComparison): string[] {
  const lines = ["=== notable changes ==="];
  if (!comparison.notable.length) { lines.push("  (none)"); return lines; }
  for (const metric of comparison.notable) lines.push(metricLine(metric).replace(/^ {4}/, "  "));
  return lines;
}

function renderMetrics(comparison: RunComparison): string[] {
  const lines = ["=== metrics delta ==="];
  for (const group of comparison.metrics) {
    lines.push(`  ${group.title}:`);
    for (const metric of group.metrics) lines.push(metricLine(metric));
  }
  return lines;
}

function renderKnowledge(comparison: RunComparison): string[] {
  const k = comparison.knowledge;
  const lines = ["=== knowledge delta ==="];

  lines.push(`  fact-anchors (aligned by path + overlapping line range, not by claim id):`);
  lines.push(`    gained in B (${k.factAnchors.gained.length}):`);
  if (k.factAnchors.gained.length) for (const anchor of k.factAnchors.gained) lines.push(`      + ${fmtAnchor(anchor)}`);
  else lines.push("      (none)");
  lines.push(`    lost from A (${k.factAnchors.lost.length}):`);
  if (k.factAnchors.lost.length) for (const anchor of k.factAnchors.lost) lines.push(`      - ${fmtAnchor(anchor)}`);
  else lines.push("      (none)");
  lines.push(`    retained (overlapping in both): ${k.factAnchors.shared}`);

  lines.push("  marker distribution (Δ):");
  for (const marker of k.markerDistribution) {
    const sign = marker.delta > 0 ? "+" : marker.delta < 0 ? "-" : "±";
    lines.push(`    ${marker.marker}: ${marker.a} -> ${marker.b}  (Δ ${sign}${Math.abs(marker.delta)})`);
  }

  lines.push("  relations (best-effort, by trace step anchors):");
  lines.push(`    gained in B (${k.relations.gained.length}):${k.relations.gained.length ? "" : " (none)"}`);
  for (const relation of k.relations.gained) lines.push(`      + [${relation.id}] ${relation.type}/${relation.status}`);
  lines.push(`    lost from A (${k.relations.lost.length}):${k.relations.lost.length ? "" : " (none)"}`);
  for (const relation of k.relations.lost) lines.push(`      - [${relation.id}] ${relation.type}/${relation.status}`);
  lines.push(`    retained: ${k.relations.shared}`);

  lines.push("  coverage (by dimension):");
  lines.push(`    status changed (${k.coverage.changed.length}):${k.coverage.changed.length ? "" : " (none)"}`);
  for (const change of k.coverage.changed) lines.push(`      ~ ${change.dimension}: ${change.a} -> ${change.b}`);
  if (k.coverage.added.length) { lines.push(`    dimensions added in B (${k.coverage.added.length}):`); for (const change of k.coverage.added) lines.push(`      + ${change.dimension}: ${change.b}`); }
  if (k.coverage.removed.length) { lines.push(`    dimensions removed from A (${k.coverage.removed.length}):`); for (const change of k.coverage.removed) lines.push(`      - ${change.dimension}: ${change.a}`); }

  const u = k.unknowns;
  const sign = u.delta > 0 ? "+" : u.delta < 0 ? "-" : "±";
  lines.push(`  unknowns: ${u.a} -> ${u.b}  (Δ ${sign}${Math.abs(u.delta)})  [claim ${u.bySource.claim.a}->${u.bySource.claim.b}, workitem ${u.bySource.workitem.a}->${u.bySource.workitem.b}]`);

  return lines;
}

/** Render a RunComparison as the default text view. */
export function renderRunComparison(comparison: RunComparison): string {
  const blocks = [
    renderHeader(comparison),
    renderHonesty(),
    renderNotable(comparison),
    renderMetrics(comparison),
    renderKnowledge(comparison)
  ];
  return blocks.map((block) => block.join("\n")).join("\n\n");
}
