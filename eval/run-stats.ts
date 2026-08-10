// Deterministic, read-only projection of one completed Excavator run into a
// RunStats model. Reads ONLY metrics.json + timeline.jsonl from the run dir.
// Zero dependencies, zero model calls, never writes. This is the data layer;
// render-run-stats.ts owns all human-facing strings. The next increment
// (cross-run metrics delta) consumes RunStats directly, so the types are
// exported — but the shape is internal/evolving and carries no stability
// promise.
//
// Wall-clock attribution (the gap algorithm) is decided in 57B-360 and
// implemented here exactly:
//   - events are ordered by `sequence` (file order is a WARN, never a failure);
//   - metrics.startedAt -> at[event 1] is the prepare stage's opening gap;
//   - for every later event i, gap = at[i] - at[i-1], attributed to the STAGE
//     OF EVENT i (the event that CLOSES the gap = where the wall time went,
//     including host-agent thinking + CLI exec, which Excavator cannot observe
//     separately);
//   - negative gaps (clock skew) clamp to 0 and raise an anomaly.
// Only metrics.timing values are directly measured; everything gap-derived is
// wall clock, not CPU. render-run-stats.ts states this in the honesty legend.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** How many of the longest gaps the top-gaps table exposes. */
export const TOP_GAPS = 5;

export interface AuditOutcome {
  outcome: "passed" | "failed" | "unknown";
  errors: number | null;
  warnings: number | null;
  /** sequence of the audit event this outcome was read from, if any. */
  seq: number | null;
}

export interface RunHeader {
  runId: string;
  snapshotId: string | null;
  documents: string[];
  startedAt: string;
  finishedAt: string | null;
  /** startedAt -> finishedAt, the authoritative total; null if finishedAt absent. */
  totalWallMs: number | null;
  /** metrics.timing.totalMs, kept separate as a cross-check (may differ slightly). */
  timingTotalMs: number | null;
  audit: AuditOutcome;
}

/** Directly-measured Core prepare timings (metrics.timing), split by kind. */
export interface PrepareTiming {
  totalPrepareMs: number | null;
  snapshotMs: number | null;
  /** feature:<scopeKey>Ms entries, prefix/suffix stripped to the raw scope key. */
  featureScopes: Array<{ key: string; ms: number }>;
  /** any other timing key except totalMs (e.g. sharedContextMs). */
  other: Array<{ key: string; ms: number }>;
}

export interface ActionBreakdown { action: string; count: number; wallMs: number; }

/** Per-stage wall clock computed by the gap algorithm. */
export interface StageStat { stage: string; wallMs: number; eventCount: number; actions: ActionBreakdown[]; }

/** One inter-event gap, attributed to the closing event's stage/action. */
export interface Gap {
  /** the event that closes the gap. */
  seq: number;
  /** the event that opens it; null = the run.startedAt boundary. */
  fromSeq: number | null;
  at: string;
  gapMs: number;
  stage: string;
  action: string;
  /** true when a negative (clock-skew) gap was clamped to 0. */
  clamped: boolean;
}

export interface DocumentSplit { documentId: string; wallMs: number; eventCount: number; }

export interface SearchStat {
  seq: number;
  terms: string[];
  pathPrefixes: string[];
  matchCount: number | null;
  cacheHit: boolean;
  reason: string;
}

/**
 * Timeline-derived search count next to the metrics counters. These legitimately
 * differ and are NEVER reconciled here (R2): metrics counts cache misses only,
 * so timelineSearchEvents == sourceSearches + sourceSearchCacheHits.
 */
export interface SearchCounters {
  timelineSearchEvents: number;
  sourceSearches: number;
  sourceSearchCacheHits: number;
  sourceFilesSearched: number;
}

export interface Counters {
  sourceWindows: number;
  sourceWindowCacheHits: number;
  graphQueries: number;
  graphQueryCacheHits: number;
  sourceCharacters: number;
  filesConsidered: number;
  claims: number | null;
  traces: number | null;
  workItems: { complete: number; total: number } | null;
  timelineEvents: number | null;
  codegraphCoverage: { indexed: number; eligible: number; ratio: number } | null;
}

/** One narrative row: a projection of a timeline event plus its opening gap. */
export interface NarrativeEntry {
  seq: number;
  at: string;
  gapMs: number;
  clamped: boolean;
  stage: string;
  action: string;
  subject: string | null;
  documentId: string | null;
  section: number | null;
  /** raw event data, passed through so render can format unknown actions too. */
  data: Record<string, unknown>;
  evidenceCount: number;
  workItemCount: number;
  traceCount: number;
}

export interface RunStats {
  runDir: string;
  header: RunHeader;
  prepareTiming: PrepareTiming;
  stages: StageStat[];
  topGaps: Gap[];
  documentSplit: DocumentSplit[];
  searches: SearchStat[];
  searchCounters: SearchCounters;
  counters: Counters;
  /** metrics.warnings, passed through verbatim. */
  warnings: string[];
  /** computed observations about the run's own timeline (skew, out-of-order, ...). */
  anomalies: string[];
  narrative: NarrativeEntry[];
}

/** Minimal shape of one parsed timeline event; unknown actions/stages are allowed. */
interface TimelineEvent {
  sequence: number;
  at: string;
  stage: string;
  action: string;
  subject?: string;
  documentId?: string;
  section?: number;
  data?: Record<string, unknown>;
  evidenceIds?: unknown[];
  workItemIds?: unknown[];
  traceIds?: unknown[];
}

const DOC_BEFORE = "(before first document)";

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readTimeline(runDir: string): TimelineEvent[] {
  const file = join(runDir, "timeline.jsonl");
  if (!existsSync(file)) throw new Error(`timeline.jsonl not found in ${runDir}`);
  const text = readFileSync(file, "utf8");
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line, index) => {
    try { return JSON.parse(line) as TimelineEvent; }
    catch { throw new Error(`invalid timeline JSON at line ${index + 1}`); }
  });
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrLen(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function splitPrepareTiming(timing: Record<string, unknown>): PrepareTiming {
  const featureScopes: Array<{ key: string; ms: number }> = [];
  const other: Array<{ key: string; ms: number }> = [];
  for (const [key, raw] of Object.entries(timing)) {
    const ms = num(raw);
    if (ms === null) continue;
    if (key === "totalMs" || key === "totalPrepareMs" || key === "snapshotMs") continue;
    if (key.startsWith("feature:") && key.endsWith("Ms")) {
      featureScopes.push({ key: key.slice("feature:".length, -"Ms".length), ms });
    } else {
      other.push({ key, ms });
    }
  }
  featureScopes.sort((a, b) => a.key.localeCompare(b.key));
  other.sort((a, b) => a.key.localeCompare(b.key));
  return {
    totalPrepareMs: num(timing.totalPrepareMs),
    snapshotMs: num(timing.snapshotMs),
    featureScopes,
    other
  };
}

function auditOutcome(events: TimelineEvent[]): AuditOutcome {
  let last: TimelineEvent | null = null;
  for (const event of events) if (event.action.startsWith("audit.")) last = event;
  if (!last) return { outcome: "unknown", errors: null, warnings: null, seq: null };
  const outcome = last.action === "audit.passed" ? "passed" : last.action === "audit.failed" ? "failed" : "unknown";
  return { outcome, errors: num(last.data?.errors), warnings: num(last.data?.warnings), seq: last.sequence };
}

/**
 * Build the gap list. Each gap is the interval that PRECEDES its event, so the
 * narrative can print it inline. gaps[0] spans metrics.startedAt -> at[event 1].
 * Negative gaps clamp to 0 and push an anomaly. prevAt always advances to the
 * raw timestamp so later gaps stay pairwise (gap = at[i] - at[i-1]).
 */
function computeGaps(events: TimelineEvent[], startedAt: string, anomalies: string[]): Gap[] {
  const gaps: Gap[] = [];
  let prevAt = Date.parse(startedAt);
  let prevSeq: number | null = null;
  for (const event of events) {
    const at = Date.parse(event.at);
    let gapMs = at - prevAt;
    let clamped = false;
    if (!Number.isFinite(gapMs)) gapMs = 0;
    else if (gapMs < 0) {
      anomalies.push(`clock skew: event ${event.sequence} (${event.at}) precedes the previous timestamp by ${Math.abs(gapMs)}ms; gap clamped to 0`);
      gapMs = 0;
      clamped = true;
    }
    gaps.push({ seq: event.sequence, fromSeq: prevSeq, at: event.at, gapMs, stage: event.stage, action: event.action, clamped });
    prevAt = at;
    prevSeq = event.sequence;
  }
  return gaps;
}

function computeStages(events: TimelineEvent[], gaps: Gap[]): StageStat[] {
  const order: string[] = [];
  const byStage = new Map<string, { wallMs: number; eventCount: number; actions: Map<string, { count: number; wallMs: number }> }>();
  events.forEach((event, index) => {
    const gap = gaps[index].gapMs;
    if (!byStage.has(event.stage)) { byStage.set(event.stage, { wallMs: 0, eventCount: 0, actions: new Map() }); order.push(event.stage); }
    const bucket = byStage.get(event.stage)!;
    bucket.wallMs += gap;
    bucket.eventCount += 1;
    const action = bucket.actions.get(event.action) ?? { count: 0, wallMs: 0 };
    action.count += 1;
    action.wallMs += gap;
    bucket.actions.set(event.action, action);
  });
  return order.map((stage) => {
    const bucket = byStage.get(stage)!;
    return {
      stage,
      wallMs: bucket.wallMs,
      eventCount: bucket.eventCount,
      actions: [...bucket.actions.entries()].map(([action, value]) => ({ action, count: value.count, wallMs: value.wallMs }))
    };
  });
}

/** Bucket each gap to the last-seen document.begin; a document.begin's own gap lands in the document it opens (R1). */
function computeDocumentSplit(events: TimelineEvent[], gaps: Gap[]): DocumentSplit[] {
  const order: string[] = [];
  const byDoc = new Map<string, { wallMs: number; eventCount: number }>();
  let currentDoc = DOC_BEFORE;
  events.forEach((event, index) => {
    if (event.action === "document.begin") {
      currentDoc = event.documentId ?? (typeof event.data?.documentId === "string" ? event.data.documentId : `(document@seq${event.sequence})`);
    }
    if (!byDoc.has(currentDoc)) { byDoc.set(currentDoc, { wallMs: 0, eventCount: 0 }); order.push(currentDoc); }
    const bucket = byDoc.get(currentDoc)!;
    bucket.wallMs += gaps[index].gapMs;
    bucket.eventCount += 1;
  });
  return order.map((documentId) => ({ documentId, ...byDoc.get(documentId)! }));
}

function computeSearches(events: TimelineEvent[]): SearchStat[] {
  return events.filter((event) => event.action === "source.search").map((event) => {
    const data = event.data ?? {};
    return {
      seq: event.sequence,
      terms: Array.isArray(data.terms) ? data.terms.map(String) : [],
      pathPrefixes: Array.isArray(data.pathPrefixes) ? data.pathPrefixes.map(String) : [],
      matchCount: num(data.matchCount),
      cacheHit: data.cacheHit === true,
      reason: typeof data.reason === "string" ? data.reason : ""
    };
  });
}

/** Read a run directory and return its RunStats. Pure read of metrics.json + timeline.jsonl; never writes. */
export function computeRunStats(runDir: string): RunStats {
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) throw new Error(`run directory not found: ${runDir}`);
  const metricsFile = join(runDir, "metrics.json");
  if (!existsSync(metricsFile)) throw new Error(`metrics.json not found in ${runDir}`);
  const metrics = readJson(metricsFile);
  const raw = readTimeline(runDir);

  const anomalies: string[] = [];
  const events = [...raw].sort((a, b) => a.sequence - b.sequence);
  const reordered = raw.some((event, index) => event.sequence !== events[index].sequence);
  if (reordered) anomalies.push("timeline events are out of sequence order in the file; analysis uses the sorted order");
  if (events.length && events[0].action !== "run.prepared") anomalies.push(`timeline does not start with run.prepared (first action is ${events[0].action})`);
  if (!events.length) anomalies.push("timeline is empty");

  const prepared = events.find((event) => event.action === "run.prepared");
  const startedAt = typeof metrics.startedAt === "string" ? metrics.startedAt : events[0]?.at ?? "";
  const finishedAt = typeof metrics.finishedAt === "string" ? metrics.finishedAt : null;
  const timing: Record<string, unknown> = (metrics.timing && typeof metrics.timing === "object") ? metrics.timing : {};

  const gaps = computeGaps(events, startedAt, anomalies);

  const documents = Array.isArray(prepared?.data?.documents) ? prepared!.data!.documents.map(String) : [];
  const snapshotId = typeof prepared?.data?.snapshotId === "string" ? prepared.data.snapshotId : null;

  const header: RunHeader = {
    runId: typeof metrics.runId === "string" ? metrics.runId : String((raw[0] as any)?.runId ?? ""),
    snapshotId,
    documents,
    startedAt,
    finishedAt,
    totalWallMs: finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null,
    timingTotalMs: num(timing.totalMs),
    audit: auditOutcome(events)
  };

  const searches = computeSearches(events);
  const searchCounters: SearchCounters = {
    timelineSearchEvents: searches.length,
    sourceSearches: num(metrics.sourceSearches) ?? 0,
    sourceSearchCacheHits: num(metrics.sourceSearchCacheHits) ?? 0,
    sourceFilesSearched: num(metrics.sourceFilesSearched) ?? 0
  };

  const counters: Counters = {
    sourceWindows: num(metrics.sourceWindows) ?? 0,
    sourceWindowCacheHits: num(metrics.sourceWindowCacheHits) ?? 0,
    graphQueries: num(metrics.graphQueries) ?? 0,
    graphQueryCacheHits: num(metrics.graphQueryCacheHits) ?? 0,
    sourceCharacters: num(metrics.sourceCharacters) ?? 0,
    filesConsidered: num(metrics.filesConsidered) ?? 0,
    claims: num(metrics.claims),
    traces: num(metrics.traces),
    workItems: metrics.workItems && typeof metrics.workItems === "object"
      ? { complete: num(metrics.workItems.complete) ?? 0, total: num(metrics.workItems.total) ?? 0 }
      : null,
    timelineEvents: num(metrics.timelineEvents),
    codegraphCoverage: metrics.codegraphCoverage && typeof metrics.codegraphCoverage === "object"
      ? { indexed: num(metrics.codegraphCoverage.indexed) ?? 0, eligible: num(metrics.codegraphCoverage.eligible) ?? 0, ratio: num(metrics.codegraphCoverage.ratio) ?? 0 }
      : null
  };

  const narrative: NarrativeEntry[] = events.map((event, index) => ({
    seq: event.sequence,
    at: event.at,
    gapMs: gaps[index].gapMs,
    clamped: gaps[index].clamped,
    stage: event.stage,
    action: event.action,
    subject: typeof event.subject === "string" ? event.subject : null,
    documentId: typeof event.documentId === "string" ? event.documentId : null,
    section: num(event.section),
    data: (event.data && typeof event.data === "object") ? event.data : {},
    evidenceCount: arrLen(event.evidenceIds),
    workItemCount: arrLen(event.workItemIds),
    traceCount: arrLen(event.traceIds)
  }));

  return {
    runDir,
    header,
    prepareTiming: splitPrepareTiming(timing),
    stages: computeStages(events, gaps),
    topGaps: [...gaps].sort((a, b) => b.gapMs - a.gapMs || a.seq - b.seq).slice(0, TOP_GAPS),
    documentSplit: computeDocumentSplit(events, gaps),
    searches,
    searchCounters,
    counters,
    warnings: Array.isArray(metrics.warnings) ? metrics.warnings.map(String) : [],
    anomalies,
    narrative
  };
}
