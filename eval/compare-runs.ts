// Deterministic, pure cross-run comparison. Given two runs already projected
// into RunStats (eval/run-stats.ts) and Knowledge (eval/knowledge.ts), it answers
// "did run B get faster / find more-or-fewer facts / gain-or-lose coverage vs run A".
// No I/O: the CLI loads both runs via the existing extractors and passes the four
// models in. Zero dependencies, zero model calls. This is the data layer;
// render-run-comparison.ts owns all human-facing strings.
//
// Two alignment rules, both stated in the render honesty note:
//   - METRICS deltas are computed straight off RunStats. Wall-clock deltas inherit
//     the gap-attribution caveat from RunStats (per-stage/total wall clock includes
//     host-agent thinking + CLI exec between events, unobservable to Excavator);
//     only Core prepare timings are directly measured. `pct` is (delta/a) rounded to
//     one decimal, and is null when a == 0 (no meaningful ratio).
//   - KNOWLEDGE deltas align by CITED SOURCE-WINDOW ANCHOR (path + overlapping line
//     range), NEVER by claim/trace id — ids are not stable across runs. Two anchors
//     match iff same path AND their [startLine,endLine] ranges intersect. Coverage
//     aligns by dimension (a stable label, unlike ids).
//
// It is a report, not a gate: no pass/fail, no ASSURANCE_VERSION, not wired to audit.

import type { RunStats } from "./run-stats.ts";
import type { EvidenceWindow, Knowledge, Marker } from "./knowledge.ts";

/** Ordered marker vocabulary so the distribution delta is always emitted in a stable order. */
const MARKERS: Marker[] = ["fact", "verified", "inferred", "unavailable"];

export type MetricUnit = "ms" | "count" | "chars";
export type MetricKind = "time" | "count";
export type Direction = "up" | "down" | "flat" | "n/a";
export type Assessment = "improvement" | "regression" | "neutral";

export interface MetricDelta {
  /** stable machine key, e.g. "totalWallMs", "stage.investigation", "sourceWindows". */
  metric: string;
  label: string;
  unit: MetricUnit;
  a: number | null;
  b: number | null;
  /** b - a; null when either side is null. */
  delta: number | null;
  /** round((delta / a) * 100, 1 decimal); null when a is 0 or either side is null. */
  pct: number | null;
  direction: Direction;
  /** improvement/regression is asserted ONLY for lower-is-better time metrics; counts stay neutral. */
  assessment: Assessment;
  /** true for any nonzero time delta, or a count delta of >= 25% magnitude. */
  notable: boolean;
}

export interface MetricGroup { title: string; metrics: MetricDelta[]; }

/** A cited source window reduced to its comparable anchor (id/title dropped). */
export interface Anchor { path: string; startLine: number; endLine: number; }

export interface AnchorDelta {
  /** anchors cited by a B fact with no overlapping anchor in A. */
  gained: Anchor[];
  /** anchors cited by an A fact with no overlapping anchor in B. */
  lost: Anchor[];
  /** count of A anchors that overlap at least one B anchor (retained). */
  shared: number;
}

export interface MarkerDelta { marker: Marker; a: number; b: number; delta: number; }

export interface RelationRef { id: string; type: string; status: string; }

export interface RelationDelta {
  /** B relations whose step anchors overlap nothing any A relation cited. */
  gained: RelationRef[];
  /** A relations whose step anchors overlap nothing any B relation cited. */
  lost: RelationRef[];
  /** count of A relations that overlap at least one B relation's anchors. */
  shared: number;
}

export interface CoverageChange {
  dimension: string;
  /** status in A (null when the dimension is absent from A). */
  a: string | null;
  /** status in B (null when the dimension is absent from B). */
  b: string | null;
}

export interface CoverageDelta {
  /** dimensions present in both runs with a different status. */
  changed: CoverageChange[];
  /** dimensions present only in B. */
  added: CoverageChange[];
  /** dimensions present only in A. */
  removed: CoverageChange[];
}

export interface UnknownsDelta {
  a: number;
  b: number;
  delta: number;
  bySource: { claim: { a: number; b: number }; workitem: { a: number; b: number } };
}

export interface KnowledgeComparison {
  factAnchors: AnchorDelta;
  markerDistribution: MarkerDelta[];
  relations: RelationDelta;
  coverage: CoverageDelta;
  unknowns: UnknownsDelta;
}

export interface RunSide { runDir: string; runId: string; }

export interface RunComparison {
  a: RunSide;
  b: RunSide;
  metrics: MetricGroup[];
  /** flat list of the notable metric deltas, in group/emit order. */
  notable: MetricDelta[];
  knowledge: KnowledgeComparison;
}

/** Two anchors are the same fact iff they share a path and their line ranges intersect. */
export function anchorsOverlap(a: Anchor, b: Anchor): boolean {
  return a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;
}

const anchorKey = (a: Anchor): string => `${a.path}:${a.startLine}:${a.endLine}`;

/** Stable order for anchor lists: path, then startLine, then endLine. */
function sortAnchors(anchors: Anchor[]): Anchor[] {
  return [...anchors].sort((x, y) => x.path.localeCompare(y.path) || x.startLine - y.startLine || x.endLine - y.endLine);
}

function toAnchor(window: EvidenceWindow): Anchor {
  return { path: window.path, startLine: window.startLine, endLine: window.endLine };
}

function dedupeAnchors(anchors: Anchor[]): Anchor[] {
  const seen = new Map<string, Anchor>();
  for (const anchor of anchors) if (!seen.has(anchorKey(anchor))) seen.set(anchorKey(anchor), anchor);
  return sortAnchors([...seen.values()]);
}

/** Distinct anchors cited by every fact in a run's Knowledge, sorted. */
export function collectFactAnchors(knowledge: Knowledge): Anchor[] {
  return dedupeAnchors(knowledge.facts.flatMap((fact) => fact.windows.map(toAnchor)));
}

/** gained = B anchors overlapping nothing in A; lost = A anchors overlapping nothing in B. */
export function diffAnchors(aAnchors: Anchor[], bAnchors: Anchor[]): AnchorDelta {
  const gained = bAnchors.filter((b) => !aAnchors.some((a) => anchorsOverlap(a, b)));
  const lost = aAnchors.filter((a) => !bAnchors.some((b) => anchorsOverlap(a, b)));
  const shared = aAnchors.filter((a) => bAnchors.some((b) => anchorsOverlap(a, b))).length;
  return { gained: sortAnchors(gained), lost: sortAnchors(lost), shared };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Build one MetricDelta. `kind === "time"` marks a lower-is-better metric (improvement when it drops). */
function makeMetric(metric: string, label: string, kind: MetricKind, unit: MetricUnit, a: number | null, b: number | null): MetricDelta {
  const delta = a === null || b === null ? null : b - a;
  const pct = delta === null || a === null || a === 0 ? null : round1((delta / a) * 100);
  const direction: Direction = delta === null ? "n/a" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const assessment: Assessment = kind === "time" && delta !== null && delta !== 0 ? (delta < 0 ? "improvement" : "regression") : "neutral";
  const notable = delta !== null && delta !== 0 && (kind === "time" || (pct !== null && Math.abs(pct) >= 25));
  return { metric, label, unit, a, b, delta, pct, direction, assessment, notable };
}

function timeMetric(metric: string, label: string, a: number | null, b: number | null): MetricDelta {
  return makeMetric(metric, label, "time", "ms", a, b);
}

function countMetric(metric: string, label: string, a: number | null, b: number | null, unit: MetricUnit = "count"): MetricDelta {
  return makeMetric(metric, label, "count", unit, a, b);
}

function stageMap(stats: RunStats): Map<string, number> {
  return new Map(stats.stages.map((stage) => [stage.stage, stage.wallMs]));
}

function buildMetricGroups(a: RunStats, b: RunStats): MetricGroup[] {
  const wallClock: MetricGroup = {
    title: "wall clock (gap-attributed)",
    metrics: [
      timeMetric("totalWallMs", "total (startedAt -> finishedAt)", a.header.totalWallMs, b.header.totalWallMs),
      timeMetric("timingTotalMs", "metrics.timing.totalMs", a.header.timingTotalMs, b.header.timingTotalMs)
    ]
  };

  const prepare: MetricGroup = {
    title: "Core prepare (directly measured)",
    metrics: [
      timeMetric("totalPrepareMs", "totalPrepareMs", a.prepareTiming.totalPrepareMs, b.prepareTiming.totalPrepareMs),
      timeMetric("snapshotMs", "snapshotMs", a.prepareTiming.snapshotMs, b.prepareTiming.snapshotMs)
    ]
  };

  const aStages = stageMap(a);
  const bStages = stageMap(b);
  const stageNames = [...new Set([...aStages.keys(), ...bStages.keys()])].sort((x, y) => x.localeCompare(y));
  const stages: MetricGroup = {
    title: "per-stage wall clock (gap-attributed)",
    metrics: stageNames.map((name) => timeMetric(`stage.${name}`, name, aStages.get(name) ?? 0, bStages.get(name) ?? 0))
  };

  const counters: MetricGroup = {
    title: "counters",
    metrics: [
      countMetric("timelineSearchEvents", "search events (timeline)", a.searchCounters.timelineSearchEvents, b.searchCounters.timelineSearchEvents),
      countMetric("sourceSearches", "sourceSearches (cache misses)", a.searchCounters.sourceSearches, b.searchCounters.sourceSearches),
      countMetric("sourceSearchCacheHits", "sourceSearchCacheHits", a.searchCounters.sourceSearchCacheHits, b.searchCounters.sourceSearchCacheHits),
      countMetric("sourceFilesSearched", "sourceFilesSearched", a.searchCounters.sourceFilesSearched, b.searchCounters.sourceFilesSearched),
      countMetric("sourceWindows", "sourceWindows", a.counters.sourceWindows, b.counters.sourceWindows),
      countMetric("sourceWindowCacheHits", "sourceWindowCacheHits", a.counters.sourceWindowCacheHits, b.counters.sourceWindowCacheHits),
      countMetric("graphQueries", "graphQueries", a.counters.graphQueries, b.counters.graphQueries),
      countMetric("graphQueryCacheHits", "graphQueryCacheHits", a.counters.graphQueryCacheHits, b.counters.graphQueryCacheHits),
      countMetric("sourceCharacters", "sourceCharacters", a.counters.sourceCharacters, b.counters.sourceCharacters, "chars"),
      countMetric("filesConsidered", "filesConsidered", a.counters.filesConsidered, b.counters.filesConsidered),
      countMetric("claims", "claims (counter)", a.counters.claims, b.counters.claims),
      countMetric("traces", "traces (counter)", a.counters.traces, b.counters.traces),
      countMetric("workItemsComplete", "workItems.complete", a.counters.workItems?.complete ?? null, b.counters.workItems?.complete ?? null),
      countMetric("workItemsTotal", "workItems.total", a.counters.workItems?.total ?? null, b.counters.workItems?.total ?? null)
    ]
  };

  return [wallClock, prepare, stages, counters];
}

function markerDistribution(a: Knowledge, b: Knowledge): MarkerDelta[] {
  const count = (knowledge: Knowledge, marker: Marker): number => knowledge.facts.filter((fact) => fact.marker === marker).length;
  return MARKERS.map((marker) => {
    const aCount = count(a, marker);
    const bCount = count(b, marker);
    return { marker, a: aCount, b: bCount, delta: bCount - aCount };
  });
}

/** Union of every anchor a run's relation steps cite (best-effort pooling for relation alignment). */
function relationAnchorPool(knowledge: Knowledge): Anchor[] {
  return dedupeAnchors(knowledge.relations.flatMap((relation) => relation.steps.flatMap((step) => step.windows.map(toAnchor))));
}

function relationAnchors(relation: Knowledge["relations"][number]): Anchor[] {
  return relation.steps.flatMap((step) => step.windows.map(toAnchor));
}

function diffRelations(a: Knowledge, b: Knowledge): RelationDelta {
  const aPool = relationAnchorPool(a);
  const bPool = relationAnchorPool(b);
  const overlapsPool = (anchors: Anchor[], pool: Anchor[]): boolean => anchors.some((x) => pool.some((y) => anchorsOverlap(x, y)));
  const toRef = (relation: Knowledge["relations"][number]): RelationRef => ({ id: relation.id, type: relation.type, status: relation.status });
  const byId = (x: RelationRef, y: RelationRef): number => x.id.localeCompare(y.id);
  const gained = b.relations.filter((relation) => !overlapsPool(relationAnchors(relation), aPool)).map(toRef).sort(byId);
  const lost = a.relations.filter((relation) => !overlapsPool(relationAnchors(relation), bPool)).map(toRef).sort(byId);
  const shared = a.relations.filter((relation) => overlapsPool(relationAnchors(relation), bPool)).length;
  return { gained, lost, shared };
}

function diffCoverage(a: Knowledge, b: Knowledge): CoverageDelta {
  const aMap = new Map(a.coverage.map((entry) => [entry.dimension, entry.status]));
  const bMap = new Map(b.coverage.map((entry) => [entry.dimension, entry.status]));
  const dimensions = [...new Set([...aMap.keys(), ...bMap.keys()])].sort((x, y) => x.localeCompare(y));
  const changed: CoverageChange[] = [];
  const added: CoverageChange[] = [];
  const removed: CoverageChange[] = [];
  for (const dimension of dimensions) {
    const inA = aMap.has(dimension);
    const inB = bMap.has(dimension);
    const statusA = aMap.get(dimension) ?? null;
    const statusB = bMap.get(dimension) ?? null;
    if (inA && inB) { if (statusA !== statusB) changed.push({ dimension, a: statusA, b: statusB }); }
    else if (inB) added.push({ dimension, a: null, b: statusB });
    else removed.push({ dimension, a: statusA, b: null });
  }
  return { changed, added, removed };
}

function diffUnknowns(a: Knowledge, b: Knowledge): UnknownsDelta {
  const bySource = (knowledge: Knowledge, source: "claim" | "workitem"): number => knowledge.unknowns.filter((unknown) => unknown.source === source).length;
  return {
    a: a.unknowns.length,
    b: b.unknowns.length,
    delta: b.unknowns.length - a.unknowns.length,
    bySource: {
      claim: { a: bySource(a, "claim"), b: bySource(b, "claim") },
      workitem: { a: bySource(a, "workitem"), b: bySource(b, "workitem") }
    }
  };
}

/** Pure cross-run comparison. Both runs must already be projected into RunStats + Knowledge. */
export function compareRuns(statsA: RunStats, statsB: RunStats, knowledgeA: Knowledge, knowledgeB: Knowledge): RunComparison {
  const metrics = buildMetricGroups(statsA, statsB);
  const notable = metrics.flatMap((group) => group.metrics).filter((metric) => metric.notable);
  return {
    a: { runDir: statsA.runDir, runId: statsA.header.runId },
    b: { runDir: statsB.runDir, runId: statsB.header.runId },
    metrics,
    notable,
    knowledge: {
      factAnchors: diffAnchors(collectFactAnchors(knowledgeA), collectFactAnchors(knowledgeB)),
      markerDistribution: markerDistribution(knowledgeA, knowledgeB),
      relations: diffRelations(knowledgeA, knowledgeB),
      coverage: diffCoverage(knowledgeA, knowledgeB),
      unknowns: diffUnknowns(knowledgeA, knowledgeB)
    }
  };
}
