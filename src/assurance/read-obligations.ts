// READ OBLIGATIONS — the deterministic denominator for reading accountability.
//
// The assurance chain audits the WRITING layer: whatever a report states can be traced to a window that
// was read. It says nothing about the READING layer: whether the windows that should have been read were
// opened at all. A dimension-level ledger ("calculations-and-thresholds: found") cannot express that
// loss, because the unit of the ledger (a topic) is not the unit of the loss (an unread window). This
// module supplies the missing unit: one obligation per in-boundary decision function, with its span.
//
// Membership derives from the fact pack's `logic` category — already a COMPLEMENT FULL-ENUMERATION of the
// retained pruned feature graph (see context/factpack-logic.ts), so the denominator inherits that
// enumeration rather than inventing a second one. Two consequences are load-bearing and honest:
//   - the denominator inherits the boundary's recall ceiling: a file the prune never retained has no
//     obligation here, so "read coverage complete" NEVER means "nothing was missed";
//   - a span-less item stays in the denominator and reconciles to `cannot-determine` — never silently
//     counted as covered.
//
// CURATION (not "more is better"): a raw retained-node set carries fake obligations — a single-line
// interface method signature or struct declaration is "covered" by opening one line — and nested spans
// double-count. Those are marked `excluded` with a reason and left VISIBLE in the artifact instead of
// being dropped, so curation can never hide a real obligation. Verified against a real run
// (WCP 请假管理): 170 logic items, all with spans, of which 5 single-line declarations on one file.
//
// Pure: zero I/O, zero model call, byte-stable ordering — freeze, audit and eval all derive the same
// denominator from the same frozen fact packs.

import type { FactPackItem, FeatureFactPack, InvestigationWorkItem } from "../core/types.ts";
import type { BoundaryFunctionsArtifact } from "../context/boundary-functions.ts";
import { LOGIC_WORKITEM_DIMENSION } from "./logic-workitems.ts";

export const READ_OBLIGATIONS_VERSION = "read-obligations-v1";

/** The assurance generation that introduced reading accountability (obligations, reconciliation, gates). */
export const READ_ACCOUNTABILITY_ASSURANCE_GENERATION = 5;

/** Obligation kinds. An enum from day one so a later denominator (route/table/module/test) adds a member,
 *  never a new artifact shape. The kind records WHICH source found the obligation: `decision-function` is
 *  the fact-pack complement, `boundary-decision-function` is the boundary-file enumeration that closes its
 *  recall gap. A function both sources find keeps the first kind, so the second kind counts exactly the
 *  additions — and so a work-item join built on the first kind's ids never shifts underneath. */
export type ObligationKind = "decision-function" | "boundary-decision-function";

/** The assurance generation that admits the boundary-file second source into the denominator. */
export const BOUNDARY_DENOMINATOR_ASSURANCE_GENERATION = 6;

/** Why an obligation is outside the counted denominator. It stays in the artifact for visibility. */
export type ObligationExclusion = "declaration-only" | "contained";

export interface ReadObligation {
  /** Same convention as a logic work item id, so the two join without a lookup table. */
  id: string;
  kind: ObligationKind;
  featureKey: string;
  name: string;
  path: string;
  startLine: number;
  /** Absent when the source never stated an end line; reconciliation then yields `cannot-determine`. */
  endLine?: number;
  /** Span length when known — the cost of this obligation, so a read budget is visible, not implied. */
  lines?: number;
  /** 0 = structurally rescued (carries a fact-pack signal), 1 = plain complement member,
   *  2 = boundary supplement (the prune never retained it; only the second source found it). */
  tier: 0 | 1 | 2;
  /** True when a promoted logic work item covers this obligation — i.e. it is within the HARD gate's
   *  reach. The denominator is deliberately WIDER than the gate: gating is rescued-only (cap-bounded),
   *  while visibility must cover every decision function. */
  gated: boolean;
  workItemId?: string;
  excluded?: ObligationExclusion;
}

export interface ReadObligationsArtifact {
  version: string;
  obligations: ReadObligation[];
  summary: {
    total: number;
    /** Obligations inside the counted denominator (not excluded). */
    counted: number;
    excludedDeclarationOnly: number;
    excludedContained: number;
    /** Counted obligations with no end line — they reconcile to `cannot-determine`. */
    noSpan: number;
    /** Counted obligations within the hard gate's reach. */
    gated: number;
    /** Total lines of counted obligation span — the read budget this run is accountable for. */
    lines: number;
    /** Present only when a boundary artifact was supplied, so a run without one stays byte-identical. */
    secondSource?: {
      graphAvailable: boolean;
      /** Every function-shaped candidate the enumeration saw, whatever its probe verdict. */
      candidates: number;
      decisionBearing: number;
      /** Decision-bearing candidates the first source had already enumerated. */
      duplicate: number;
      /** Obligations this source actually contributed — the headline reading of the slice. */
      added: number;
      /** Candidates in a language with no grammar: judged by nobody, counted by everybody. */
      unprobed: number;
      filesWithoutCandidates: number;
    };
  };
}

/**
 * Derive the frozen read-obligation denominator from a run's fact packs and work items, optionally widened
 * by the boundary-file enumeration.
 *
 * Three phases, in this order, and the order is load-bearing:
 *   1. the first source is built and excluded exactly as it always was — with no boundary artifact the
 *      output is byte-identical to the pre-second-source version, which is what keeps frozen runs stable;
 *   2. boundary candidates that the first source already found are dropped (same feature, path and start
 *      line is the same reading unit, and charging it twice would inflate the denominator);
 *   3. exclusions are marked on the SUPPLEMENTS ONLY. A first-source obligation is never re-judged as
 *      `contained` because a supplement happens to span it: reconciliation skips excluded items, so
 *      re-judging one would remove it from coverage entirely and silently narrow the gate it feeds.
 */
export function readObligations(
  factPacks: FeatureFactPack[],
  workItems: InvestigationWorkItem[] = [],
  boundary?: BoundaryFunctionsArtifact | null,
): ReadObligationsArtifact {
  const gatedIds = new Set(
    workItems.filter((item) => item.dimension === LOGIC_WORKITEM_DIMENSION).map((item) => item.id),
  );

  const primary: ReadObligation[] = [];
  for (const pack of factPacks) {
    const featureKey = String(pack.featureKey ?? "");
    if (!featureKey) continue;
    for (const item of pack.items ?? []) {
      if (item.category !== "logic") continue;
      primary.push(obligationFor(featureKey, item, gatedIds));
    }
  }

  primary.sort(byLocation);
  markExclusions(primary);

  const second = boundary ? supplement(boundary, primary) : null;
  const obligations = second ? [...primary, ...second.added].sort(byLocation) : primary;

  const counted = obligations.filter((obligation) => !obligation.excluded);
  const summary: ReadObligationsArtifact["summary"] = {
    total: obligations.length,
    counted: counted.length,
    excludedDeclarationOnly: obligations.filter((o) => o.excluded === "declaration-only").length,
    excludedContained: obligations.filter((o) => o.excluded === "contained").length,
    noSpan: counted.filter((o) => o.endLine === undefined).length,
    gated: counted.filter((o) => o.gated).length,
    lines: counted.reduce((total, o) => total + (o.lines ?? 0), 0),
  };
  if (second) summary.secondSource = second.stats;
  return { version: READ_OBLIGATIONS_VERSION, obligations, summary };
}

/** Phase 2 + 3: turn decision-bearing boundary functions into obligations the first source never had. */
function supplement(
  boundary: BoundaryFunctionsArtifact,
  primary: ReadObligation[],
): { added: ReadObligation[]; stats: NonNullable<ReadObligationsArtifact["summary"]["secondSource"]> } {
  const known = new Set(primary.map((obligation) => `${obligation.featureKey}${obligation.path}${obligation.startLine}`));
  const added: ReadObligation[] = [];
  let candidates = 0;
  let decisionBearing = 0;
  let duplicate = 0;
  let unprobed = 0;
  let filesWithoutCandidates = 0;

  for (const feature of boundary.features ?? []) {
    const featureKey = String(feature.featureKey ?? "");
    filesWithoutCandidates += feature.filesWithoutCandidates?.length ?? 0;
    for (const fn of feature.functions ?? []) {
      candidates++;
      if (fn.probe === "unavailable") unprobed++;
      if (fn.probe !== "decision") continue;
      decisionBearing++;
      const path = normalizeObligationPath(fn.path);
      if (known.has(`${featureKey}${path}${fn.startLine}`)) { duplicate++; continue; }
      added.push({
        id: `feature:${featureKey}:boundary-fn:${fn.name}@${fn.path}:${fn.startLine}`,
        kind: "boundary-decision-function",
        featureKey,
        name: fn.name,
        path,
        startLine: fn.startLine,
        endLine: fn.endLine,
        lines: fn.endLine - fn.startLine + 1,
        tier: 2,
        // Gating is rescued-only and cap-bounded; a supplement is visibility, never a hard gate's reach.
        gated: false,
      });
    }
  }

  added.sort(byLocation);
  markSupplementExclusions(added, primary);
  return {
    added,
    stats: {
      graphAvailable: Boolean(boundary.graphAvailable),
      candidates,
      decisionBearing,
      duplicate,
      added: added.length,
      unprobed,
      filesWithoutCandidates,
    },
  };
}

/** Same two exclusions as the first source, applied to supplements only — see the phase-3 note above. */
function markSupplementExclusions(supplements: ReadObligation[], primary: ReadObligation[]): void {
  for (const obligation of supplements) {
    if (obligation.endLine !== undefined && obligation.endLine === obligation.startLine) {
      obligation.excluded = "declaration-only";
    }
  }
  const containers = [...primary, ...supplements].filter((o) => !o.excluded && o.endLine !== undefined);
  for (const inner of supplements) {
    if (inner.excluded || inner.endLine === undefined) continue;
    const container = containers.find((outer) =>
      outer !== inner
      && !outer.excluded
      && outer.path === inner.path
      && outer.startLine <= inner.startLine
      && (outer.endLine as number) >= (inner.endLine as number)
      && (outer.startLine !== inner.startLine || outer.endLine !== inner.endLine));
    if (container) inner.excluded = "contained";
  }
}

function byLocation(a: ReadObligation, b: ReadObligation): number {
  return cmp(a.path, b.path) || a.startLine - b.startLine || cmp(a.name, b.name) || cmp(a.id, b.id);
}

function obligationFor(featureKey: string, item: FactPackItem, gatedIds: Set<string>): ReadObligation {
  const path = normalizeObligationPath(item.filePath);
  const startLine = Number(item.line) || 0;
  const endLine = typeof item.endLine === "number" && item.endLine >= startLine ? item.endLine : undefined;
  const id = `feature:${featureKey}:logic:${item.name}@${item.filePath}:${item.line}`;
  const obligation: ReadObligation = {
    id,
    kind: "decision-function",
    featureKey,
    name: item.name,
    path,
    startLine,
    tier: typeof item.signal === "string" && item.signal.length > 0 ? 0 : 1,
    gated: gatedIds.has(id),
  };
  if (endLine !== undefined) {
    obligation.endLine = endLine;
    obligation.lines = endLine - startLine + 1;
  }
  if (gatedIds.has(id)) obligation.workItemId = id;
  return obligation;
}

/**
 * Mark the two deterministic exclusions, in order:
 *   1. `declaration-only` — a single-line span (an interface method signature, a struct declaration):
 *      opening one line would "cover" it, so counting it would inflate coverage with a free pass.
 *   2. `contained` — a span strictly inside another still-counted obligation on the same path: the
 *      container already carries the read obligation, so counting both double-charges the same lines.
 */
function markExclusions(obligations: ReadObligation[]): void {
  for (const obligation of obligations) {
    if (obligation.endLine !== undefined && obligation.endLine === obligation.startLine) {
      obligation.excluded = "declaration-only";
    }
  }
  const byPath = new Map<string, ReadObligation[]>();
  for (const obligation of obligations) {
    if (obligation.excluded || obligation.endLine === undefined) continue;
    const list = byPath.get(obligation.path);
    if (list) list.push(obligation);
    else byPath.set(obligation.path, [obligation]);
  }
  for (const list of byPath.values()) {
    for (const inner of list) {
      const container = list.find((outer) =>
        outer !== inner
        && !outer.excluded
        && outer.startLine <= inner.startLine
        && (outer.endLine as number) >= (inner.endLine as number)
        && (outer.startLine !== inner.startLine || outer.endLine !== inner.endLine));
      if (container) inner.excluded = "contained";
    }
  }
}

/** Obligation paths are normalized exactly like fact-pack paths so they compare byte-for-byte with the
 *  evidence windows recorded for the same snapshot. Shared with the reconciliation module. */
export function normalizeObligationPath(value: unknown): string {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
