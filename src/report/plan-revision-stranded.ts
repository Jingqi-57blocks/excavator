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
 *
 * AND IT IS A READING, NOT A GATE, WHICH IS WHY IT HAS A `not-read` ARM. Scanning the receipt directory can fail
 * by name (a receipt that is not JSON, one that does not parse as a receipt, one filed under another unit's key),
 * and a plan action must not become hostage to a file it does not otherwise need: `plan` is the command an
 * operator reaches for to get a stuck run moving, and no command deletes a receipt. So a scan that fails says so
 * with the failure in it, and the plan is still recorded. What is NOT allowed is the third possibility — reporting
 * zero stranded drafts because the scan failed — which is the same "empty set meaning two things" this epic keeps
 * closing. Same shape as `PlanPacketReading`'s `measured` / `not-measured`, for the same reason.
 */

import type { UnitDraftReceipt } from "./unit-receipt.ts";
import { compareUnitIds } from "./unit-paths.ts";

/**
 * Every drafted-but-uncollected unit the recorded plan digest has just made uncollectable — or why that could not
 * be read. Two arms, exhaustive, no default; `sentence` is on both, so a printer never has to reconstruct one.
 */
export type StrandedUnitDrafts =
  | {
      readonly state: "read";
      /** Ascending unit ids. Each one has a receipt on disk that `collectUnits` will refuse by name. */
      readonly unitIds: readonly string[];
      /** The reading in words — a real statement in the zero case as well as the non-zero one. */
      readonly sentence: string;
    }
  | {
      readonly state: "not-read";
      /** Why the receipt directory could not be scanned, verbatim, plus what it means for this plan. */
      readonly sentence: string;
    };

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
    state: "read",
    unitIds,
    sentence: unitIds.length === 0
      ? `No drafted unit is waiting to be collected against a superseded plan, so this plan costs no re-drawing (${pending.length} pending draft(s) checked against plan ${planCatalogDigest.slice(0, 16)})`
      : `${unitIds.length} drafted unit(s) were written against a superseded plan and must be re-drafted before they can be collected — collect refuses them by name: ${unitIds.join(", ")}`
  };
}

/** The `not-read` arm, with the scan's own failure in the sentence rather than behind a generic word. */
export function strandedUnitDraftsUnread(reason: string): StrandedUnitDrafts {
  return {
    state: "not-read",
    sentence: `The drafted-but-uncollected units this plan strands could not be read, so this plan's cost in re-drawing is unknown — not zero: ${reason}. Fix the receipt this names, then run \`excavator collect --run <run> --units\` to see which drafts still stand.`
  };
}
