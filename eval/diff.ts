// Pure Knowledge x Expected -> Diff. No I/O, no model. Every decision here is a
// deterministic function of its two inputs, so re-diffing an existing run after
// changing the harness or the expected file is sub-second and reproducible.

import type { EvidenceWindow, Knowledge, KnowledgeFact } from "./knowledge.ts";
import type { Anchor, CoverageExpectation, Expected, ExpectedItem, ForbiddenItem, Pattern } from "./expected.ts";

/**
 * Which segment of the pipeline lost a gold item. A single recall number cannot be acted on — it does not
 * say whether to fix the boundary, the reading, the extraction or the writing — so a miss is attributed to
 * exactly one segment of the funnel:
 *
 *   prepare-miss  the anchor never entered the prepared boundary (fix Target Resolution / the prune);
 *   read-miss     in the boundary, but no source window was ever opened over it (fix reading discipline);
 *   consume-miss  a window was opened over it, but no claim cites that window (a drive-by read);
 *   write-miss    a claim does cite the window, but the expected statement never appeared (fix authoring).
 *
 * `authoring-miss` remains a real value for the one case the split is UNKNOWABLE: a knowledge record with
 * no opened-window inventory (captured before this funnel existed). It is never inferred — an unrefinable
 * record reports the coarse bucket instead of a guessed segment. In the summary `authoringMiss` stays the
 * whole post-boundary segment (the three refined counters plus the unrefinable ones), so existing
 * consumers keep their meaning while the funnel adds resolution.
 */
export type Attribution = "read-miss" | "consume-miss" | "write-miss" | "authoring-miss" | "prepare-miss" | "no-anchor";

export interface FoundEntry {
  id: string;
  kind: string;
  /** ref of the claim / trace / unknown that satisfied the item. */
  via: string;
}

export interface MissingEntry {
  id: string;
  kind: string;
  mustFind: boolean;
  attribution: Attribution;
}

export interface ForbiddenHit {
  id: string;
  ref: string;
  marker: string;
  statement: string;
}

/** A claim that matched a forbidden rule's base pattern but was dropped before becoming a hit. */
export interface ForbiddenExemption {
  ruleId: string;
  ref: string;
  marker: string;
  statement: string;
  reason: "unless" | "searched-not-found";
}

export interface CoverageFailure {
  dimension: string;
  expect: string[];
  actual: string[];
}

export interface DiffSummary {
  items: number;
  found: number;
  missing: number;
  mustFindMissing: number;
  /** The whole post-boundary segment: readMiss + consumeMiss + writeMiss. */
  authoringMiss: number;
  readMiss: number;
  consumeMiss: number;
  writeMiss: number;
  prepareMiss: number;
  forbiddenHits: number;
  coverageFailures: number;
  pass: boolean;
}

export interface Diff {
  found: FoundEntry[];
  missing: MissingEntry[];
  forbiddenHits: ForbiddenHit[];
  /** Claims that matched a forbidden base pattern but were exempted (do not count toward pass). */
  forbiddenExempted: ForbiddenExemption[];
  coverageFailures: CoverageFailure[];
  summary: DiffSummary;
}

export function parseLines(lines: string | undefined): { start: number; end: number } | null {
  if (!lines) return null;
  const match = lines.match(/(\d+)(?:\D+(\d+))?/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  return { start, end };
}

/** Three-form path match: `root/path` exact | `endsWith("/"+path)` | bare `path` exact. */
export function pathMatches(candidate: string, anchor: Anchor): boolean {
  const rooted = anchor.root ? `${anchor.root}/${anchor.path}` : anchor.path;
  return candidate === rooted || candidate.endsWith(`/${anchor.path}`) || candidate === anchor.path;
}

/** A window matches an anchor when paths match and (if the anchor carries lines) the ranges overlap. */
function windowMatchesAnchor(window: EvidenceWindow, anchor: Anchor): boolean {
  if (!pathMatches(window.path, anchor)) return false;
  const range = parseLines(anchor.lines);
  if (!range) return true; // anchor without lines -> path match suffices
  return window.startLine <= range.end && window.endLine >= range.start;
}

function windowsMatchAnyAnchor(windows: EvidenceWindow[], anchors: Anchor[]): boolean {
  return windows.some((window) => anchors.some((anchor) => windowMatchesAnchor(window, anchor)));
}

function allPatternsMatch(patterns: Pattern[] | undefined, text: string): boolean {
  if (!patterns) return true;
  return patterns.every((pattern) => pattern.re.test(text));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `text` reference `path` as a whole path token rather than as a prefix of a longer name?
 * A plain substring check lets `src/auth.ts` match inside `src/auth.tsx`; this requires a
 * non-continuation boundary on both sides. A leading `/` is allowed so a bare path still matches
 * its rooted occurrence (endsWith semantics); a trailing `\w`/`.` is rejected so `.ts` ≠ `.tsx`.
 */
function textContainsPath(text: string, path: string): boolean {
  return new RegExp(`(?:^|[^\\w.-])${escapeRegExp(path)}(?![\\w.])`, "u").test(text);
}

/** Is any of the item's anchor files present in the prepared horizon (fact pack files or scope text)? */
function anchorInHorizon(anchor: Anchor, horizon: Knowledge["prepareHorizon"]): boolean {
  if (horizon.files.some((file) => pathMatches(file, anchor))) return true;
  const rooted = anchor.root ? `${anchor.root}/${anchor.path}` : anchor.path;
  return textContainsPath(horizon.scopeText, rooted) || textContainsPath(horizon.scopeText, anchor.path);
}

function findFact(item: ExpectedItem, knowledge: Knowledge): string | null {
  for (const fact of knowledge.facts) {
    if (item.markers && !item.markers.includes(fact.marker)) continue;
    if (!windowsMatchAnyAnchor(fact.windows, item.anchors)) continue;
    if (!allPatternsMatch(item.statementPatterns, fact.statement)) continue;
    return fact.ref;
  }
  return null;
}

function findRelation(item: ExpectedItem, knowledge: Knowledge): string | null {
  for (const relation of knowledge.relations) {
    for (const step of relation.steps) {
      if (!windowsMatchAnyAnchor(step.windows, item.anchors)) continue;
      if (!allPatternsMatch(item.stepPatterns, step.action)) continue;
      return relation.id;
    }
  }
  return null;
}

function findUnknown(item: ExpectedItem, knowledge: Knowledge): string | null {
  for (const unknown of knowledge.unknowns) {
    if (allPatternsMatch(item.patterns, unknown.text)) return unknown.ref;
  }
  return null;
}

function findItem(item: ExpectedItem, knowledge: Knowledge): string | null {
  if (item.kind === "fact") return findFact(item, knowledge);
  if (item.kind === "relation") return findRelation(item, knowledge);
  return findUnknown(item, knowledge);
}

function attribute(item: ExpectedItem, knowledge: Knowledge): Attribution {
  if (item.anchors.length === 0) return "no-anchor";
  if (!item.anchors.some((anchor) => anchorInHorizon(anchor, knowledge.prepareHorizon))) return "prepare-miss";
  // In the boundary: split the authoring segment by what actually happened to the anchor region. A record
  // with no opened-window inventory cannot be split, so it keeps the coarse bucket.
  if (knowledge.openedWindows === undefined) return "authoring-miss";
  if (!windowsMatchAnyAnchor(knowledge.openedWindows, item.anchors)) return "read-miss";
  const cited = knowledge.facts.some((fact) => windowsMatchAnyAnchor(fact.windows, item.anchors))
    || knowledge.relations.some((relation) => relation.steps.some((step) => windowsMatchAnyAnchor(step.windows, item.anchors)));
  return cited ? "write-miss" : "consume-miss";
}

/**
 * A claim whose every cited evidence id is a zero-match, non-truncated search receipt cannot, by
 * construction, be a positive "the system has capability X" assertion — it is an honest "searched, not
 * found". Structurally separates such honest negations from real hallucinations without weakening the
 * base pattern (57B-358: widen the exemption, never the base). Conservative: any cited id that is not a
 * search receipt (source window, unresolved, missing/non-array matches), any nonzero match, or any
 * truncation makes the equality fail, so the claim is NOT exempt.
 */
function isSearchedNotFound(fact: KnowledgeFact): boolean {
  return (
    fact.citedEvidenceCount > 0 &&
    fact.searchEvidence.length === fact.citedEvidenceCount &&
    fact.searchEvidence.every((receipt) => receipt.matchCount === 0 && !receipt.truncated)
  );
}

function detectForbidden(forbidden: ForbiddenItem[], knowledge: Knowledge): { hits: ForbiddenHit[]; exempted: ForbiddenExemption[] } {
  const hits: ForbiddenHit[] = [];
  const exempted: ForbiddenExemption[] = [];
  for (const rule of forbidden) {
    for (const fact of knowledge.facts) {
      if (!rule.markers.includes(fact.marker)) continue;
      if (!allPatternsMatch(rule.patterns, fact.statement)) continue;
      const base = { ruleId: rule.id, ref: fact.ref, marker: fact.marker, statement: fact.statement };
      // Exempt honest negations ("... does NOT send ...") so the pin never punishes the report it rewards.
      if (rule.unless && rule.unless.some((pattern) => pattern.re.test(fact.statement))) {
        exempted.push({ ...base, reason: "unless" });
        continue;
      }
      // Exempt claims whose only evidence is a zero-match search receipt (searched, not found).
      if (isSearchedNotFound(fact)) {
        exempted.push({ ...base, reason: "searched-not-found" });
        continue;
      }
      hits.push({ id: rule.id, ref: fact.ref, marker: fact.marker, statement: fact.statement });
    }
  }
  return { hits, exempted };
}

function checkCoverage(coverage: CoverageExpectation[], knowledge: Knowledge): CoverageFailure[] {
  const failures: CoverageFailure[] = [];
  for (const expectation of coverage) {
    const statuses = knowledge.coverage.filter((entry) => entry.dimension === expectation.dimension).map((entry) => entry.status);
    const satisfied = statuses.some((status) => expectation.expect.includes(status));
    if (!satisfied) {
      failures.push({ dimension: expectation.dimension, expect: expectation.expect, actual: statuses.length ? [...new Set(statuses)] : ["<absent>"] });
    }
  }
  return failures;
}

/** Compare extracted Knowledge against an expected-knowledge-v1 spec. Pure. */
export function diffKnowledge(knowledge: Knowledge, expected: Expected): Diff {
  const found: FoundEntry[] = [];
  const missing: MissingEntry[] = [];
  for (const item of expected.items) {
    const via = findItem(item, knowledge);
    if (via !== null) {
      found.push({ id: item.id, kind: item.kind, via });
    } else {
      missing.push({ id: item.id, kind: item.kind, mustFind: item.mustFind, attribution: attribute(item, knowledge) });
    }
  }
  const { hits: forbiddenHits, exempted: forbiddenExempted } = detectForbidden(expected.forbidden, knowledge);
  const coverageFailures = checkCoverage(expected.coverage, knowledge);

  const mustFindMissing = missing.filter((entry) => entry.mustFind).length;
  const summary: DiffSummary = {
    items: expected.items.length,
    found: found.length,
    missing: missing.length,
    mustFindMissing,
    // authoringMiss keeps its original meaning as the whole post-boundary segment; the three funnel
    // counters below say WHERE inside it the item was lost.
    authoringMiss: missing.filter((entry) => ["read-miss", "consume-miss", "write-miss", "authoring-miss"].includes(entry.attribution)).length,
    readMiss: missing.filter((entry) => entry.attribution === "read-miss").length,
    consumeMiss: missing.filter((entry) => entry.attribution === "consume-miss").length,
    writeMiss: missing.filter((entry) => entry.attribution === "write-miss").length,
    prepareMiss: missing.filter((entry) => entry.attribution === "prepare-miss").length,
    forbiddenHits: forbiddenHits.length,
    coverageFailures: coverageFailures.length,
    pass: mustFindMissing === 0 && forbiddenHits.length === 0 && coverageFailures.length === 0
  };
  return { found, missing, forbiddenHits, forbiddenExempted, coverageFailures, summary };
}

/** Exit code: any mustFind missing, forbidden violation, or coverage failure -> 1. */
export function exitCodeFor(diff: Diff): number {
  return diff.summary.pass ? 0 : 1;
}

export interface ContainmentEntry {
  id: string;
  anchor: Anchor;
  path: string;
}

export interface Containment {
  contained: ContainmentEntry[];
  missing: ContainmentEntry[];
  allContained: boolean;
}

/** Deterministic, sub-second: every expected anchor file must land in the prepared horizon. */
export function checkContainment(knowledge: Knowledge, expected: Expected): Containment {
  const contained: ContainmentEntry[] = [];
  const missing: ContainmentEntry[] = [];
  for (const item of expected.items) {
    for (const anchor of item.anchors) {
      const entry: ContainmentEntry = { id: item.id, anchor, path: anchor.root ? `${anchor.root}/${anchor.path}` : anchor.path };
      if (anchorInHorizon(anchor, knowledge.prepareHorizon)) contained.push(entry);
      else missing.push(entry);
    }
  }
  return { contained, missing, allContained: missing.length === 0 };
}
