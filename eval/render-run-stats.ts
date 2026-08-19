// RunStats -> human-readable text view. This module owns every human-facing
// string: the mandatory honesty legend, the action-specific narrative summaries,
// and the generic fallback that keeps UNKNOWN actions/stages rendering (never
// throwing) because the action/stage vocabulary is not a closed set.
//
// The legend is load-bearing, not decoration: per-stage wall clock is
// gap-attributed and INCLUDES host-agent thinking between CLI calls that
// Excavator cannot observe separately. Only metrics.timing is directly measured.
// The view performs no audit and does not verify the hash chain.

import type { NarrativeEntry, RunStats } from "./run-stats.ts";
import { TOP_GAPS } from "./run-stats.ts";

/** Compact wall-clock: sub-second stays in ms; otherwise h/m/s, leading zero units dropped. */
export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function truncate(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Compact rendering of an event's data for the generic fallback; never throws. */
function fallbackData(data: Record<string, unknown>): string {
  try {
    const keys = Object.keys(data);
    if (!keys.length) return "";
    return truncate(JSON.stringify(data), 100);
  } catch {
    return "";
  }
}

/**
 * One-line, action-specific summary of a narrative entry. Unknown actions fall
 * through to a generic renderer that shows the subject and a compact data dump.
 */
export function summarizeEvent(entry: NarrativeEntry): string {
  const data = entry.data;
  switch (entry.action) {
    case "run.prepared": {
      const snapshot = typeof data.snapshotId === "string" ? data.snapshotId : "?";
      const docs = Array.isArray(data.documents) ? data.documents.length : 0;
      return `snapshot ${snapshot}, ${docs} document(s)`;
    }
    case "source.window": {
      const start = data.startLine;
      const end = data.endLine;
      const cache = data.cacheHit === true ? "cache hit" : "read";
      const reason = typeof data.reason === "string" ? ` — ${truncate(data.reason)}` : "";
      return `${entry.subject ?? "?"}:${start}-${end} [${cache}]${reason}`;
    }
    case "source.search": {
      const terms = Array.isArray(data.terms) ? data.terms.map(String).join(", ") : "";
      const prefixes = Array.isArray(data.pathPrefixes) && data.pathPrefixes.length ? ` under ${data.pathPrefixes.map(String).join(", ")}` : "";
      const cache = data.cacheHit === true ? "cache hit" : "scanned";
      const matches = typeof data.matchCount === "number" ? `${data.matchCount} match(es)` : "? matches";
      const reason = typeof data.reason === "string" ? ` — ${truncate(data.reason)}` : "";
      return `[${terms}]${prefixes} -> ${matches} [${cache}]${reason}`;
    }
    case "document.begin":
      return `begin ${entry.documentId ?? "?"}`;
    case "section.checkpoint":
    case "section.revised": {
      const verb = entry.action === "section.revised" || data.revision === true ? "revised" : "checkpoint";
      const section = entry.section !== null ? `section ${entry.section}` : "section";
      const timedOut = data.timedOut === true ? ", TIMED OUT" : "";
      return `${section} ${verb} (${entry.evidenceCount} evidence, ${entry.traceCount} traces${timedOut})`;
    }
    case "traces.updated":
      return `${entry.traceCount} trace(s) updated`;
    case "workitems.updated":
      return `${entry.workItemCount} work item(s) updated`;
    case "run.assembled": {
      const docs = Array.isArray(data.documents) ? data.documents.length : 0;
      return `assembled ${docs} document(s)`;
    }
    case "audit.passed":
    case "audit.failed": {
      const verb = entry.action === "audit.failed" ? "failed" : "passed";
      return `audit ${verb} (${data.errors ?? "?"} errors, ${data.warnings ?? "?"} warnings)`;
    }
    default: {
      const subject = entry.subject ? ` ${entry.subject}` : "";
      const dump = fallbackData(data);
      return `${subject}${dump ? ` ${dump}` : ""}`.trim() || "(no detail)";
    }
  }
}

function renderHeader(stats: RunStats): string[] {
  const h = stats.header;
  const audit = h.audit.outcome === "unknown"
    ? "unknown"
    : `${h.audit.outcome} (${h.audit.errors ?? "?"} errors, ${h.audit.warnings ?? "?"} warnings)`;
  return [
    "=== run ===",
    `  runId:      ${h.runId}`,
    `  snapshot:   ${h.snapshotId ?? "(unknown)"}`,
    `  documents:  ${h.documents.length ? h.documents.join(", ") : "(none)"}`,
    `  window:     ${h.startedAt} -> ${h.finishedAt ?? "(unfinished)"}`,
    `  wall clock: ${fmtDuration(h.totalWallMs)}${h.timingTotalMs !== null ? `  (metrics.timing.totalMs ${fmtDuration(h.timingTotalMs)})` : ""}`,
    `  audit:      ${audit}`
  ];
}

function renderLegend(): string[] {
  return [
    "=== how to read the wall clock (honesty) ===",
    "  Per-stage and per-document wall clock is GAP-ATTRIBUTED: the interval between two",
    "  timeline events is charged to the event that closes it. That interval INCLUDES the",
    "  host agent's own thinking and CLI execution between calls, which Excavator cannot",
    "  observe or separate out. Only the Core prepare timings (metrics.timing) below are",
    "  directly measured. The top-gaps table exposes the largest such intervals as raw fact",
    "  rather than smoothing them away. This view runs no audit and does not verify the",
    "  timeline hash chain."
  ];
}

function renderTimeSplit(stats: RunStats): string[] {
  const lines = ["=== time split ==="];

  lines.push("  Core prepare (directly measured):");
  const pt = stats.prepareTiming;
  lines.push(`    totalPrepareMs: ${fmtDuration(pt.totalPrepareMs)}`);
  lines.push(`    snapshotMs:     ${fmtDuration(pt.snapshotMs)}`);
  if (pt.featureScopes.length) for (const scope of pt.featureScopes) lines.push(`    feature ${scope.key}: ${fmtDuration(scope.ms)}`);
  if (pt.other.length) for (const entry of pt.other) lines.push(`    ${entry.key}: ${fmtDuration(entry.ms)}`);

  lines.push("  Per-stage wall clock (gap-attributed, includes host thinking):");
  for (const stage of stats.stages) {
    lines.push(`    ${stage.stage}: ${fmtDuration(stage.wallMs)}  (${stage.eventCount} events)`);
    for (const action of stage.actions) lines.push(`      - ${action.action}: ${fmtDuration(action.wallMs)} x${action.count}`);
  }

  lines.push(`  Top ${TOP_GAPS} longest gaps (unobservable latency shown raw):`);
  for (const gap of stats.topGaps) {
    const from = gap.fromSeq === null ? "start" : `#${gap.fromSeq}`;
    const flag = gap.clamped ? " [clamped skew]" : "";
    lines.push(`    ${from} -> #${gap.seq}  ${fmtDuration(gap.gapMs)}  ${gap.stage}/${gap.action}${flag}`);
  }

  lines.push("  Per-document wall clock (bucketed to the last-seen document.begin):");
  for (const doc of stats.documentSplit) lines.push(`    ${doc.documentId}: ${fmtDuration(doc.wallMs)}  (${doc.eventCount} events)`);

  return lines;
}

function renderSearches(stats: RunStats): string[] {
  const lines = ["=== searches ==="];
  if (!stats.searches.length) {
    lines.push("  (no source.search events)");
  } else {
    for (const search of stats.searches) {
      const prefixes = search.pathPrefixes.length ? ` under [${search.pathPrefixes.join(", ")}]` : "";
      const cache = search.cacheHit ? "cache hit" : "scanned";
      lines.push(`  #${search.seq} [${search.terms.join(", ")}]${prefixes} -> ${search.matchCount ?? "?"} match(es) [${cache}]`);
      if (search.reason) lines.push(`       reason: ${truncate(search.reason, 100)}`);
    }
  }
  const c = stats.searchCounters;
  lines.push("  metrics counters (shown raw, NOT reconciled with the above — they count different things):");
  lines.push(`    timeline source.search events: ${c.timelineSearchEvents}  (every search, cache hit or miss)`);
  lines.push(`    metrics.sourceSearches:        ${c.sourceSearches}  (cache MISSES only)`);
  lines.push(`    metrics.sourceSearchCacheHits: ${c.sourceSearchCacheHits}  (cache HITS only)`);
  lines.push(`    metrics.sourceFilesSearched:   ${c.sourceFilesSearched}  (files scanned across cache-missing searches)`);
  lines.push(`    identity: sourceSearches + sourceSearchCacheHits = ${c.sourceSearches + c.sourceSearchCacheHits} timeline events`);
  return lines;
}

function renderCounters(stats: RunStats): string[] {
  const c = stats.counters;
  const lines = ["=== counters ==="];
  lines.push(`  source windows:  ${c.sourceWindows} recorded, ${c.sourceWindowCacheHits} cache hits`);
  lines.push(`  graph queries:   ${c.graphQueries} (counts only; ${c.graphQueryCacheHits} cache hits) — no per-query timeline events exist`);
  lines.push(`  source chars:    ${c.sourceCharacters}`);
  lines.push(`  files considered:${" "}${c.filesConsidered}`);
  if (c.codegraphCoverage) {
    // `n/a`, not `0`: a pre-rename archive did not measure this denominator, and "1668/0" is a lie about it.
    const denominator = c.codegraphCoverage.counted === null ? "n/a (pre-rename archive)" : String(c.codegraphCoverage.counted);
    lines.push(`  codegraph:       ${c.codegraphCoverage.indexed}/${denominator} indexed (ratio ${c.codegraphCoverage.ratio.toFixed(4)})`);
  }
  lines.push(`  claims:          ${c.claims ?? "n/a"}`);
  lines.push(`  traces:          ${c.traces ?? "n/a"}`);
  lines.push(`  work items:      ${c.workItems ? `${c.workItems.complete}/${c.workItems.total} complete` : "n/a"}`);
  lines.push(`  timeline events: ${c.timelineEvents ?? "n/a"}`);
  if (stats.warnings.length) {
    lines.push(`  warnings (${stats.warnings.length}):`);
    for (const warning of stats.warnings) lines.push(`    - ${truncate(warning, 140)}`);
  }
  return lines;
}

function renderNarrative(stats: RunStats): string[] {
  const lines = ["=== process narrative ==="];
  for (const entry of stats.narrative) {
    const gap = `+${fmtDuration(entry.gapMs)}`.padEnd(10);
    const seq = `#${entry.seq}`.padStart(4);
    const flag = entry.clamped ? " [clamped]" : "";
    lines.push(`  ${gap} ${seq}  ${entry.stage}/${entry.action}${flag}  ${summarizeEvent(entry)}`);
  }
  return lines;
}

/** Render a RunStats as the default text view. */
export function renderRunStats(stats: RunStats): string {
  const blocks: string[][] = [renderHeader(stats), renderLegend()];
  if (stats.anomalies.length) blocks.push(["=== anomalies ===", ...stats.anomalies.map((line) => `  ! ${line}`)]);
  blocks.push(renderTimeSplit(stats), renderSearches(stats), renderCounters(stats), renderNarrative(stats));
  return blocks.map((block) => block.join("\n")).join("\n\n");
}
