import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { computeRunStats, type NarrativeEntry } from "../run-stats.ts";
import { renderRunStats, summarizeEvent, fmtDuration } from "../render-run-stats.ts";

const RUN = join(import.meta.dirname, "fixtures", "run-observe-mini");
const stats = computeRunStats(RUN);
const stageMs = Object.fromEntries(stats.stages.map((s) => [s.stage, s.wallMs]));
const stageCount = Object.fromEntries(stats.stages.map((s) => [s.stage, s.eventCount]));

test("stage wall clock is gap-attributed over INTERLEAVED stages, not a first/last range", () => {
  // The fixture interleaves investigation events (seq 6,7,9) among authoring events.
  // A naive first-event->last-event range would give investigation 175000 / authoring 235000;
  // the correct gap-sum is 95000 / 200000. These assertions guard the algorithm.
  assert.equal(stageMs.investigation, 95_000);
  assert.equal(stageMs.authoring, 200_000);
  assert.equal(stageMs.prepare, 10_000);
  assert.equal(stageMs.assemble, 20_000);
  assert.equal(stageMs.audit, 15_000);
  assert.deepEqual(stageCount, { prepare: 1, investigation: 5, authoring: 5, reflection: 1, assemble: 1, audit: 2 });
});

test("startedAt -> event 1 is the prepare opening gap", () => {
  // metrics.startedAt is 00:00:00, run.prepared (seq 1) is at 00:00:10 => 10s, charged to prepare.
  assert.equal(stats.narrative[0].seq, 1);
  assert.equal(stats.narrative[0].stage, "prepare");
  assert.equal(stats.narrative[0].gapMs, 10_000);
  assert.equal(stageMs.prepare, 10_000); // prepare has only event 1, so the stage equals that opening gap
});

test("per-action breakdown sums the per-action gaps", () => {
  const authoring = stats.stages.find((s) => s.stage === "authoring")!;
  const byAction = Object.fromEntries(authoring.actions.map((a) => [a.action, a]));
  assert.deepEqual({ count: byAction["section.checkpoint"].count, wallMs: byAction["section.checkpoint"].wallMs }, { count: 2, wallMs: 120_000 });
  assert.deepEqual({ count: byAction["document.begin"].count, wallMs: byAction["document.begin"].wallMs }, { count: 2, wallMs: 50_000 });
  assert.deepEqual({ count: byAction["section.revised"].count, wallMs: byAction["section.revised"].wallMs }, { count: 1, wallMs: 30_000 });
});

test("per-document split buckets gaps to the last-seen document.begin across an interleave", () => {
  const byDoc = Object.fromEntries(stats.documentSplit.map((d) => [d.documentId, d]));
  // seq 1..3 precede any document.begin.
  assert.deepEqual({ wallMs: byDoc["(before first document)"].wallMs, n: byDoc["(before first document)"].eventCount }, { wallMs: 50_000, n: 3 });
  // doc-a owns seq 4..9, INCLUDING the interleaved investigation gaps (seq 6,7,9).
  assert.deepEqual({ wallMs: byDoc["feature-doc-a-product"].wallMs, n: byDoc["feature-doc-a-product"].eventCount }, { wallMs: 165_000, n: 6 });
  // doc-b's own document.begin gap (seq 10) is charged to doc-b, not the prior doc.
  assert.deepEqual({ wallMs: byDoc["feature-doc-b-product"].wallMs, n: byDoc["feature-doc-b-product"].eventCount }, { wallMs: 145_000, n: 6 });
});

test("top gaps are the longest intervals, sorted desc with seq tiebreak", () => {
  assert.deepEqual(
    stats.topGaps.map((g) => [g.fromSeq, g.seq, g.gapMs]),
    [[4, 5, 60_000], [10, 11, 60_000], [1, 2, 30_000], [6, 7, 30_000], [7, 8, 30_000]]
  );
});

test("negative gap (clock skew) is clamped to 0 and raises an anomaly", () => {
  // seq 15 (00:05:55) precedes seq 14 (00:06:00) by 5s.
  const skewed = stats.narrative.find((n) => n.seq === 15)!;
  assert.equal(skewed.gapMs, 0);
  assert.equal(skewed.clamped, true);
  assert.equal(stats.anomalies.some((a) => /clock skew/.test(a) && /event 15/.test(a)), true);
});

test("search extraction and the un-reconciled counter passthrough (R2)", () => {
  assert.equal(stats.searches.length, 2);
  assert.deepEqual(stats.searches.map((s) => [s.seq, s.matchCount, s.cacheHit]), [[7, 3, false], [9, 7, true]]);
  assert.deepEqual(stats.searchCounters, { timelineSearchEvents: 2, sourceSearches: 1, sourceSearchCacheHits: 1, sourceFilesSearched: 5 });
  // The two legitimately differ: 2 timeline events, but sourceSearches counts misses only.
  assert.notEqual(stats.searchCounters.timelineSearchEvents, stats.searchCounters.sourceSearches);
  assert.equal(stats.searchCounters.sourceSearches + stats.searchCounters.sourceSearchCacheHits, stats.searchCounters.timelineSearchEvents);
});

test("counters and prepare timings are read from metrics.json", () => {
  assert.equal(stats.counters.graphQueries, 4);
  assert.equal(stats.counters.sourceWindows, 3);
  assert.equal(stats.counters.sourceWindowCacheHits, 1);
  assert.deepEqual(stats.counters.workItems, { complete: 3, total: 4 });
  assert.equal(stats.prepareTiming.totalPrepareMs, 340);
  assert.equal(stats.prepareTiming.snapshotMs, 120);
  assert.deepEqual(stats.prepareTiming.featureScopes, [{ key: "doc-scope-abc123", ms: 210 }]);
  assert.deepEqual(stats.prepareTiming.other, [{ key: "sharedContextMs", ms: 95 }]);
  assert.equal(stats.warnings.length, 2);
});

test("header total is startedAt->finishedAt, kept distinct from metrics.timing.totalMs", () => {
  assert.equal(stats.header.totalWallMs, 370_000);
  assert.equal(stats.header.timingTotalMs, 371_000);
  assert.equal(stats.header.snapshotId, "snap-observe-mini");
  assert.deepEqual(stats.header.documents, ["feature-doc-a-product", "feature-doc-b-product"]);
});

test("audit outcome reads the LAST audit event (failed -> passed => passed)", () => {
  assert.deepEqual(stats.header.audit, { outcome: "passed", errors: 0, warnings: 1, seq: 15 });
});

test("forward-compat: an unknown stage + unknown action renders generically and never throws", () => {
  const unknown = stats.narrative.find((n) => n.action === "notes.pinned")!;
  assert.equal(unknown.stage, "reflection");
  const summary = summarizeEvent(unknown);
  assert.match(summary, /balance-edge-case/);
  assert.doesNotThrow(() => renderRunStats(stats));
});

test("summarizeEvent tolerates a totally empty event", () => {
  const bare: NarrativeEntry = {
    seq: 99, at: "2026-01-01T00:00:00.000Z", gapMs: 0, clamped: false,
    stage: "mystery", action: "future.thing", subject: null, documentId: null, section: null,
    data: {}, evidenceCount: 0, workItemCount: 0, traceCount: 0
  };
  assert.equal(summarizeEvent(bare), "(no detail)");
});

test("render includes the honesty legend, header, time-split and search lines", () => {
  const text = renderRunStats(stats);
  // Legend: gap-attribution is stated, host thinking is disclosed, and no audit/chain claim is made.
  assert.match(text, /GAP-ATTRIBUTED/);
  assert.match(text, /host agent/);
  assert.match(text, /does not verify the/);
  assert.match(text, /runs no audit/);
  // Header.
  assert.match(text, /runId: +run-observe-mini/);
  assert.match(text, /audit: +passed \(0 errors, 1 warnings\)/);
  // Time split (gap-attributed stage lines).
  assert.match(text, /investigation: 1m 35s {2}\(5 events\)/);
  assert.match(text, /authoring: 3m 20s {2}\(5 events\)/);
  // Search line + un-reconciled counters.
  assert.match(text, /#7 \[role, permission\] under \[svc\/auth\] -> 3 match\(es\) \[scanned\]/);
  assert.match(text, /NOT reconciled/);
  assert.match(text, /cache MISSES only/);
  // Anomaly surfaced.
  assert.match(text, /clock skew/);
});

test("fmtDuration keeps sub-second in ms and composes h/m/s otherwise", () => {
  assert.equal(fmtDuration(120), "120ms");
  assert.equal(fmtDuration(95_000), "1m 35s");
  assert.equal(fmtDuration(370_000), "6m 10s");
  assert.equal(fmtDuration(null), "n/a");
});

test("computeRunStats throws on a missing run dir / missing metrics.json", () => {
  assert.throws(() => computeRunStats(join(RUN, "nope")), /run directory not found/);
  assert.throws(() => computeRunStats(import.meta.dirname), /metrics\.json not found/);
});
