// READ COVERAGE — reconcile the read-obligation denominator against what was actually opened and consumed.
//
// Three facts per obligation, each mechanically derived, none of them a model judgement:
//   - was any source window opened over its span (P(window opened));
//   - how much of the span remains unread, as concrete line ranges (cost and residual, not a boolean);
//   - did any claim/trace cite one of those windows (P(fact extracted | opened) — the segment no formal
//     gate can reach, so it is reported, never asserted).
//
// The `openedNotConsumed` counter is deliberately first-class: hardening a gate that only requires
// "opened" pushes a miss from not-opened into opened-not-consumed (a drive-by read), and hardening
// "consumed" pushes it into a boilerplate claim. This report is therefore the Goodhart DETECTOR for its
// own gates — if not-opened falls while opened-not-consumed rises by the same amount, the loss migrated
// rather than disappeared.
//
// Pure: zero I/O, zero model call, byte-stable. One module owns interval algebra and path identity, so
// the freeze gate, the audit and the eval funnel can never disagree about "does this window cover it".

import type { EvidenceItem, InvestigationWorkItem } from "../core/types.ts";
import type { AuditFinding } from "./assurance.ts";
import { LOGIC_WORKITEM_DIMENSION } from "./logic-workitems.ts";
import { normalizeObligationPath, type ReadObligation } from "./read-obligations.ts";

export const READ_COVERAGE_VERSION = "read-coverage-v1";

export type ReadStatus = "covered" | "partial" | "not-opened" | "cannot-determine";

/** A line range, inclusive on both ends. */
export interface LineRange {
  start: number;
  end: number;
}

/** One claim's citations, flattened across documents (`ref` is `<documentId>#<claimId>`). */
export interface ClaimCitation {
  ref: string;
  evidenceIds: string[];
}

export interface ReadCoverageItem {
  id: string;
  name: string;
  path: string;
  startLine: number;
  endLine?: number;
  tier: 0 | 1;
  gated: boolean;
  status: ReadStatus;
  /** Evidence ids of the source windows overlapping this span, sorted. */
  openedWindows: string[];
  openedLines: number;
  uncovered: LineRange[];
  uncoveredLines: number;
  /** Claim refs citing at least one overlapping window, sorted. Empty on a drive-by read. */
  consumedBy: string[];
}

export interface ReadCoverageReport {
  version: string;
  items: ReadCoverageItem[];
  summary: {
    counted: number;
    covered: number;
    partial: number;
    notOpened: number;
    cannotDetermine: number;
    obligationLines: number;
    openedLines: number;
    uncoveredLines: number;
    /** Opened (fully or partly) but cited by no claim — the Goodhart migration signal. */
    openedNotConsumed: number;
    /** Within the hard gate's reach and never opened. */
    gatedNotOpened: number;
  };
}

export interface ReadCoverageInput {
  obligations: ReadObligation[];
  evidence: EvidenceItem[];
  /** Omitted at freeze time (no claims exist yet): the read side is reported, the consumption side stays empty. */
  claims?: ClaimCitation[];
}

/** Reconcile the counted obligations against opened windows and claim citations. */
export function reconcileReadCoverage(input: ReadCoverageInput): ReadCoverageReport {
  const windowsByPath = new Map<string, EvidenceItem[]>();
  for (const item of input.evidence) {
    if (item.kind !== "source" || typeof item.startLine !== "number" || typeof item.endLine !== "number") continue;
    const path = normalizeObligationPath(item.path);
    const list = windowsByPath.get(path);
    if (list) list.push(item);
    else windowsByPath.set(path, [item]);
  }
  const citationsByEvidence = new Map<string, string[]>();
  for (const claim of input.claims ?? []) {
    for (const evidenceId of claim.evidenceIds ?? []) {
      const list = citationsByEvidence.get(evidenceId);
      if (list) list.push(claim.ref);
      else citationsByEvidence.set(evidenceId, [claim.ref]);
    }
  }

  const items: ReadCoverageItem[] = [];
  for (const obligation of input.obligations) {
    if (obligation.excluded) continue;
    items.push(coverageFor(obligation, windowsByPath.get(obligation.path) ?? [], citationsByEvidence));
  }

  return { version: READ_COVERAGE_VERSION, items, summary: summarize(items) };
}

function coverageFor(
  obligation: ReadObligation,
  windows: EvidenceItem[],
  citationsByEvidence: Map<string, string[]>,
): ReadCoverageItem {
  const base: ReadCoverageItem = {
    id: obligation.id,
    name: obligation.name,
    path: obligation.path,
    startLine: obligation.startLine,
    tier: obligation.tier,
    gated: obligation.gated,
    status: "not-opened",
    openedWindows: [],
    openedLines: 0,
    uncovered: [],
    uncoveredLines: 0,
    consumedBy: [],
  };
  if (obligation.endLine !== undefined) base.endLine = obligation.endLine;

  // No declared end line: the span is unknown, so coverage is UNDECIDABLE. Report the windows that
  // contain the start line for navigation, but never claim coverage.
  if (obligation.endLine === undefined) {
    const touching = windows.filter((w) => (w.startLine as number) <= obligation.startLine && (w.endLine as number) >= obligation.startLine);
    base.status = "cannot-determine";
    base.openedWindows = sortedIds(touching);
    base.consumedBy = consumers(touching, citationsByEvidence);
    return base;
  }

  const span: LineRange = { start: obligation.startLine, end: obligation.endLine };
  const overlapping = windows.filter((w) => overlaps(span, { start: w.startLine as number, end: w.endLine as number }));
  base.openedWindows = sortedIds(overlapping);
  base.consumedBy = consumers(overlapping, citationsByEvidence);

  const merged = mergeRanges(overlapping.map((w) => clampRange({ start: w.startLine as number, end: w.endLine as number }, span)));
  base.openedLines = merged.reduce((total, range) => total + (range.end - range.start + 1), 0);
  base.uncovered = subtractRanges(span, merged);
  base.uncoveredLines = base.uncovered.reduce((total, range) => total + (range.end - range.start + 1), 0);
  base.status = !overlapping.length ? "not-opened" : base.uncoveredLines === 0 ? "covered" : "partial";
  return base;
}

/**
 * Does at least one of `citedEvidenceIds` name a source window overlapping this obligation's span?
 * The HARD gate's predicate: a `found` disposition whose citations never touch the function it claims to
 * have investigated is a false ledger entry, mechanically detectable and mechanically fixable (open the
 * window). A span-less obligation cannot be judged, so it never fails the gate.
 */
export function citesOverlappingWindow(
  obligation: ReadObligation,
  citedEvidenceIds: readonly string[],
  evidenceById: Map<string, EvidenceItem>,
): boolean {
  if (obligation.endLine === undefined) return true;
  const span: LineRange = { start: obligation.startLine, end: obligation.endLine };
  for (const id of citedEvidenceIds) {
    const item = evidenceById.get(id);
    if (!item || item.kind !== "source") continue;
    if (typeof item.startLine !== "number" || typeof item.endLine !== "number") continue;
    if (normalizeObligationPath(item.path) !== obligation.path) continue;
    if (overlaps(span, { start: item.startLine, end: item.endLine })) return true;
  }
  return false;
}

export interface ReadAccountabilityInput {
  obligations: ReadObligation[];
  workItems: InvestigationWorkItem[];
  evidenceById: Map<string, EvidenceItem>;
  report: ReadCoverageReport;
}

/**
 * The reading-accountability rules, in two deliberately different strengths.
 *
 * HARD (error) — a false ledger entry: a material decision-function work item disposed `found` whose cited
 * source windows never touch the function it claims to have investigated. There is no discretion in this
 * predicate and no judgement about depth; the author satisfies it by opening the window, so it is safe as
 * a freeze precondition where the fix is cheapest.
 *
 * ADVISORY (warning) — the residual: a promoted decision function left unread or partly read, with the
 * unread ranges and their line count so the cost is visible. It stays advisory in this generation on
 * purpose: hardening "must be opened" without a content red line in the same slice only moves the loss to
 * a drive-by read (see `openedNotConsumed`), so the migration data is collected first. Non-gated residual
 * is reported as ONE aggregate line — visibility without flooding the author with per-item noise.
 *
 * The gate's reach is NARROWER than the denominator, and that is stated rather than implied: gating
 * follows the promoted (rescued, cap-bounded) work items, while the residual covers every counted
 * obligation. A decision function that is in the denominator but was never promoted — verified on a real
 * run: `Approve` in the WCP leave service, the very function holding the 16h/40h approval thresholds — is
 * therefore surfaced by the RESIDUAL, never by the hard gate.
 */
export function auditReadAccountability(input: ReadAccountabilityInput): AuditFinding[] {
  const { obligations, workItems, evidenceById, report } = input;
  const byId = new Map(obligations.map((obligation) => [obligation.id, obligation]));
  const findings: AuditFinding[] = [];

  for (const item of workItems) {
    if (item.dimension !== LOGIC_WORKITEM_DIMENSION || item.status !== "found" || !item.material) continue;
    const obligation = byId.get(item.id);
    if (!obligation || obligation.excluded) continue;
    if (citesOverlappingWindow(obligation, item.evidenceIds ?? [], evidenceById)) continue;
    findings.push({
      level: "error",
      document: "read-coverage",
      message: `work item ${item.id} is disposed found, but none of its cited source windows overlap ${obligation.path}:${obligation.startLine}-${obligation.endLine} — record a source window over the decision function it reports, or dispose it as cannot-determine/not-applicable`,
    });
  }

  const gatedResidual = report.items
    .filter((item) => item.gated && (item.status === "not-opened" || item.status === "partial"))
    .sort((a, b) => b.uncoveredLines - a.uncoveredLines || cmp(a.id, b.id));
  for (const item of gatedResidual) {
    const ranges = item.uncovered.map((range) => `${range.start}-${range.end}`).join(", ") || "—";
    findings.push({
      level: "warning",
      document: "read-coverage",
      message: `read residual (advisory): promoted decision function ${item.name} at ${item.path}:${item.startLine}-${item.endLine} is ${item.status} — ${item.uncoveredLines} line(s) unread (${ranges}); open the range or dispose the work item explicitly`,
    });
  }

  const ungatedNotOpened = report.items.filter((item) => !item.gated && item.status === "not-opened");
  if (ungatedNotOpened.length) {
    const lines = ungatedNotOpened.reduce((total, item) => total + item.uncoveredLines, 0);
    findings.push({
      level: "warning",
      document: "read-coverage",
      message: `read residual (advisory): ${ungatedNotOpened.length} of ${report.summary.counted} counted read obligations were never opened (${lines} line(s) unread) — see coverage/read-residual.json; "read coverage complete" never means "nothing was missed", since obligations only cover the retained boundary`,
    });
  }
  if (report.summary.openedNotConsumed) {
    findings.push({
      level: "warning",
      document: "read-coverage",
      message: `read residual (advisory): ${report.summary.openedNotConsumed} obligation(s) had a window opened but no claim cites it — an opened-not-consumed count that rises while not-opened falls means the loss migrated rather than closed`,
    });
  }
  return findings;
}

function summarize(items: ReadCoverageItem[]): ReadCoverageReport["summary"] {
  const byStatus = (status: ReadStatus): number => items.filter((item) => item.status === status).length;
  return {
    counted: items.length,
    covered: byStatus("covered"),
    partial: byStatus("partial"),
    notOpened: byStatus("not-opened"),
    cannotDetermine: byStatus("cannot-determine"),
    obligationLines: items.reduce((total, item) => total + (item.endLine !== undefined ? item.endLine - item.startLine + 1 : 0), 0),
    openedLines: items.reduce((total, item) => total + item.openedLines, 0),
    uncoveredLines: items.reduce((total, item) => total + item.uncoveredLines, 0),
    openedNotConsumed: items.filter((item) => item.openedWindows.length > 0 && item.consumedBy.length === 0).length,
    gatedNotOpened: items.filter((item) => item.gated && item.status === "not-opened").length,
  };
}

function consumers(windows: EvidenceItem[], citationsByEvidence: Map<string, string[]>): string[] {
  const refs = new Set<string>();
  for (const window of windows) for (const ref of citationsByEvidence.get(window.id) ?? []) refs.add(ref);
  return [...refs].sort(cmp);
}

function sortedIds(windows: EvidenceItem[]): string[] {
  return [...new Set(windows.map((window) => window.id))].sort(cmp);
}

function overlaps(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function clampRange(range: LineRange, span: LineRange): LineRange {
  return { start: Math.max(range.start, span.start), end: Math.min(range.end, span.end) };
}

/** Merge overlapping/adjacent ranges into a minimal sorted cover. */
function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = ranges.filter((range) => range.end >= range.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** The parts of `span` left uncovered by `covered` (which must be a merged, sorted cover). */
function subtractRanges(span: LineRange, covered: LineRange[]): LineRange[] {
  const gaps: LineRange[] = [];
  let cursor = span.start;
  for (const range of covered) {
    if (range.start > cursor) gaps.push({ start: cursor, end: Math.min(range.start - 1, span.end) });
    cursor = Math.max(cursor, range.end + 1);
    if (cursor > span.end) break;
  }
  if (cursor <= span.end) gaps.push({ start: cursor, end: span.end });
  return gaps.filter((gap) => gap.end >= gap.start);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
