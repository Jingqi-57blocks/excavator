/**
 * The OUTPUT half of the plan's budget, enforced at the moment a unit's bytes exist.
 *
 * WHY IT IS ENFORCED HERE AND NOWHERE ELSE. R4b printed "output budget: NONE DECLARED" into every packet and
 * deferred the number to this slice, for an honest reason: nothing declared one. Now the allowance table does
 * (`perUnitOutputBytes`, `perUnitSummaryBytes`), and the only place the real bytes are known is `draftUnit` — the
 * packet can state the bound, and a later audit can only report a violation after the fact. So the gate sits at the
 * write, before anything lands.
 *
 * IT REFUSES; IT NEVER TRIMS. The refusal names the unit, the measured bytes, the bound and the overrun, and it says
 * in as many words what satisfying it means: WRITE MORE TIGHTLY. It must never read as an invitation to drop an
 * obligation, an unknown or a terminology entry — an upper bound that becomes an incentive to delete content would
 * buy bytes with exactly the silence this epic exists to remove, and Core deleting content on an author's behalf
 * would be the truncation every other file here refuses.
 *
 * THE SUMMARY IS MEASURED AS THE PARENT WILL READ IT. `perUnitSummaryBytes` bounds the RENDERED child block
 * (`renderChildSummaryBlock`), not the canonical JSON, because the plan-time synthesis bound multiplies that same
 * block by the child count. Bounding the JSON here and the block there would be two bounds, and the author would be
 * graded against the one the plan did not budget.
 */

import { canonicalJson } from "../base/util.ts";
import type { PlanDocumentBudget } from "./plan-budget.ts";
import { childSummaryBlockBytes } from "./unit-packet.ts";
import type { UnitClaimsFile, UnitSummary } from "./unit-output.ts";

export interface UnitOutputMeasurement {
  /** Bytes of the normalized `content.md` about to be written. */
  readonly contentBytes: number;
  /** Canonical bytes of the claims sidecar about to be written. */
  readonly claimsBytes: number;
  /** Bytes of the summary block a parent synthesis would be handed for this unit. */
  readonly summaryBytes: number;
}

/** Measure what one draft is about to write. Pure: the caller hands over the values, this returns three numbers. */
export function measureUnitOutput(normalizedContent: string, claims: UnitClaimsFile, summary: UnitSummary): UnitOutputMeasurement {
  return {
    contentBytes: Buffer.byteLength(normalizedContent, "utf8"),
    claimsBytes: Buffer.byteLength(canonicalJson(claims), "utf8"),
    summaryBytes: childSummaryBlockBytes(summary)
  };
}

/**
 * Where a draft exceeds its document's declared output budget, as named problems. Empty means inside both bounds.
 *
 * Two independent bounds, reported independently: content-plus-claims against `perUnitOutputBytes`, and the summary
 * block against `perUnitSummaryBytes`. Folding them into one number would let a large summary be excused by short
 * prose, and it is the summary alone that decides whether a parent synthesis fits.
 */
export function unitOutputBudgetProblems(
  unitId: string,
  budget: PlanDocumentBudget,
  measurement: UnitOutputMeasurement
): string[] {
  const problems: string[] = [];
  const written = measurement.contentBytes + measurement.claimsBytes;
  if (written > budget.perUnitOutputBytes) {
    problems.push(`unit ${JSON.stringify(unitId)} writes ${written} bytes (${measurement.contentBytes} of content plus ${measurement.claimsBytes} of canonical claims), ${written - budget.perUnitOutputBytes} over the ${budget.perUnitOutputBytes}-byte output budget its document's ${budget.detailBudget} detail budget declares. REWRITE IT MORE TIGHTLY — do not drop an obligation, an unknown or a terminology entry to fit; nothing here shortens content on your behalf, and a shorter document that covers less is not what this bound is for`);
  }
  if (measurement.summaryBytes > budget.perUnitSummaryBytes) {
    problems.push(`the summary of unit ${JSON.stringify(unitId)} renders to ${measurement.summaryBytes} bytes for a parent synthesis, ${measurement.summaryBytes - budget.perUnitSummaryBytes} over the ${budget.perUnitSummaryBytes}-byte summary budget its document's ${budget.detailBudget} detail budget declares. This is the number a synthesis's own input budget is computed from, so it is not negotiable per unit. REWRITE THE STATEMENTS MORE TIGHTLY — keep every unknown and every term, and say each one in fewer words`);
  }
  return problems;
}
