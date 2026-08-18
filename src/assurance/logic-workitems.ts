// Promote rescued `logic` fact-pack items into DISPOSABLE work items — the "forcing function" that keeps
// an authoring agent from silently skipping a material decision function. A rescued logic item is a
// business/decision function structural analysis pulled into the feature boundary that the six structural
// fact-pack categories do not name; it carries a `signal` (tier-0). This module turns each such item into a
// work item the freeze gate and audit already enforce (disposition required, found needs evidence, a
// material found item needs a claim reusing that evidence) — no new audit rule, only new work items.
//
// Membership is rescued-only and NOT a score: it reuses the fact pack's own `signal` flag (57B-372 already
// rejected scoring for membership). Rank is used only to ORDER items and to choose which survive the cap.
//
// Pure: zero I/O, zero npm dependency, no model call. Deterministic and byte-stable — the same fact packs
// and documents produce byte-identical work items, so the plan, the freeze expected-plan and the audit
// expected-plan/checklist can all derive from this one function and never disagree.

import type { DocumentPlan, FactPackItem, FeatureFactPack, InvestigationWorkItem } from "../base/types.ts";
import { consumableFactPackItems } from "../workset/factpack-view.ts";

/** Per-feature ceiling on promoted rescued logic functions; a pathological feature cannot flood the plan. */
export const LOGIC_WORKITEM_CAP = 24;

/** The assurance generation that introduced logic-disposition work items. A run prepared under this
 *  generation or later baked them into its plan, so freeze/audit re-derive them; earlier runs never did.
 *  Gating on the generation (not exact-version equality) keeps a later assurance/redaction bump from
 *  false-failing a run that already carries these baked default items. */
export const LOGIC_DISPOSITION_ASSURANCE_GENERATION = 4;

/** The fixed dimension every promoted logic item carries. Deliberately outside auditWorkItems's material-flow
 *  dimension set, so a `found` logic item needs evidence but not a trace. */
export const LOGIC_WORKITEM_DIMENSION = "logic-disposition";

export interface LogicWorkItemsResult {
  items: InvestigationWorkItem[];
  /** Per-feature truncation notes (cap reached); the caller records them in run metrics. */
  warnings: string[];
}

/**
 * Derive the DISPOSABLE work items for a run's rescued logic functions.
 *
 * For each feature fact pack, its rescued `logic` items (category `logic`, a non-empty `signal`) are ordered
 * by the pack's own within-feature attention `rank`, capped at `cap` (default {@link LOGIC_WORKITEM_CAP}, a
 * warning per truncated feature), and each promoted to a work item:
 *
 *  - `id` = `feature:<featureKey>:logic:<name>@<filePath>:<line>` — location is part of the id because one
 *    feature can carry the same symbol name at two locations (no literal NUL; `@`/`:` are the separators);
 *  - `dimension` = `logic-disposition`; `material` = true; `origin` = `default` (so it is required, not open);
 *  - `requiredFor` = the feature's own document ids (matched by `feature-<featureKey>-<audience>`);
 *  - `reportSection` LEFT EMPTY — a behavioral rule may legitimately land in §3/§4/§5, so it is not pinned to
 *    one section (pinning would trip the section-bound coverage reconciliation);
 *  - `hypothesis` = framework-neutral: the symbol name, its location and the target-derived rescue signal —
 *    no business vocabulary is baked into Core.
 *
 * A fact pack no document consumes (an overview-only run, or an unmatched key) contributes nothing, so a
 * derived item never has an empty `requiredFor`. The final list is sorted by (rank, id) for byte-stability.
 */
export function logicWorkItems(factPacks: FeatureFactPack[], documents: DocumentPlan[], options: { cap?: number } = {}): LogicWorkItemsResult {
  const cap = Math.max(0, options.cap ?? LOGIC_WORKITEM_CAP);
  const warnings: string[] = [];
  const ranked: Array<{ rank: number; item: InvestigationWorkItem }> = [];
  for (const pack of factPacks) {
    const featureKey = String(pack.featureKey ?? "");
    if (!featureKey) continue;
    const requiredFor = documents
      .filter((document) => document.kind === "feature" && document.id === `feature-${featureKey}-${document.audience}`)
      .map((document) => document.id);
    if (!requiredFor.length) continue;
    const rescued = consumableFactPackItems(pack)
      .filter((item) => item.category === "logic" && typeof item.signal === "string" && item.signal.length > 0)
      .sort((a, b) => rankOf(a) - rankOf(b) || compareStrings(a.filePath, b.filePath) || a.line - b.line || compareStrings(a.name, b.name));
    if (rescued.length > cap) {
      warnings.push(`Logic disposition: feature ${featureKey} has ${rescued.length} rescued logic functions; only the ${cap} highest-ranked were promoted to work items — ${rescued.length - cap} lower-ranked remain covered only by the fact-pack advisory.`);
    }
    for (const item of rescued.slice(0, cap)) ranked.push({ rank: rankOf(item), item: workItemFor(featureKey, item, requiredFor) });
  }
  ranked.sort((a, b) => a.rank - b.rank || compareStrings(a.item.id, b.item.id));
  return { items: ranked.map((entry) => entry.item), warnings };
}

function workItemFor(featureKey: string, item: FactPackItem, requiredFor: string[]): InvestigationWorkItem {
  return {
    id: `feature:${featureKey}:logic:${item.name}@${item.filePath}:${item.line}`,
    dimension: LOGIC_WORKITEM_DIMENSION,
    scope: `feature:${featureKey}`,
    hypothesis: `Decision function ${item.name} at ${item.filePath}:${item.line} was rescued into the feature boundary by structural analysis (${item.signal}); its behavior must be dispositioned individually — described in the report and cited to its source window, or explicitly ruled not applicable.`,
    status: "pending",
    material: true,
    requiredFor: [...requiredFor],
    evidenceIds: [],
    traceIds: [],
    reportSection: undefined,
    origin: "default"
  };
}

function rankOf(item: FactPackItem): number { return typeof item.rank === "number" ? item.rank : Number.MAX_SAFE_INTEGER; }
function compareStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
