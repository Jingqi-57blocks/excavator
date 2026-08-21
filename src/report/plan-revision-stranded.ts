/**
 * The drafts a recorded plan just made uncollectable, as a reading.
 *
 * THE STATE THIS NAMES. A unit is drafted (`units/<key>/receipt.json` on disk, content and claims and summary
 * beside it) and not yet collected. Recording a new plan revision changes `plan/catalog.json`, and `collectUnits`
 * refuses a receipt written against a different plan digest BY NAME — "re-draft it against the recorded plan". That
 * refusal is correct and the receipt is deliberately kept: nothing deletes an operator's work. But the refusal
 * arrives at the NEXT collect, possibly much later, one unit at a time; the revise that caused it said nothing.
 *
 * SO IT IS REPORTED WHERE THE COST IS INCURRED, with the unit ids in it. "This plan revision costs you these three
 * drafts" is the fact an operator needs before they start writing the fourth, and the whole point of the cache work
 * this epic does is that re-drawing is the expensive part — a revision that silently strands drafts is the same
 * failure as a cache hit that reads as "nothing happened".
 *
 * ONE SENTENCE, ALWAYS, NEVER AN EMPTY STRING. The zero case is a reading too ("no drafted unit needs re-drawing"),
 * and an empty list beside an empty sentence would leave a reader unable to tell "nothing was stranded" from
 * "nobody looked". Same three-state discipline the coverage statements are held to.
 *
 * IT IS ALSO NOT A REFUSAL. A revise that strands drafts is a legitimate act — the operator asked for it, and the
 * remedy (re-draft) is available. This file returns data; nothing here throws.
 */

import type { UnitDraftReceipt } from "./unit-receipt.ts";
import { compareUnitIds } from "./unit-paths.ts";

/** Every drafted-but-uncollected unit that the recorded plan digest has just made uncollectable, plus the sentence. */
export interface StrandedUnitDrafts {
  /** Ascending unit ids. Each one has a receipt on disk that `collectUnits` will refuse by name. */
  readonly unitIds: readonly string[];
  /** The reading in words — a real statement in the zero case as well as the non-zero one. */
  readonly sentence: string;
}

/**
 * Which pending drafts the plan now on disk cannot collect.
 *
 * The comparison is the SAME one `collectUnits` makes (receipt digest against the recorded plan catalog digest), so
 * this reading cannot claim a draft is fine that collect will refuse, or vice versa. Both are given as arguments:
 * a function that went and read the run itself would be a second reader of a state the caller already holds.
 */
export function strandedUnitDrafts(
  pending: readonly UnitDraftReceipt[],
  planCatalogDigest: string
): StrandedUnitDrafts {
  const unitIds = pending
    .filter((receipt) => receipt.planCatalogDigest !== planCatalogDigest)
    .map((receipt) => receipt.unitId)
    .sort(compareUnitIds);
  return {
    unitIds,
    sentence: unitIds.length === 0
      ? `No drafted unit is waiting to be collected against a superseded plan, so this plan costs no re-drawing (${pending.length} pending draft(s) checked against plan ${planCatalogDigest.slice(0, 16)})`
      : `${unitIds.length} drafted unit(s) were written against a superseded plan and must be re-drafted before they can be collected — collect refuses them by name: ${unitIds.join(", ")}`
  };
}
