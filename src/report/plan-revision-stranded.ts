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
 * TWO BUCKETS, BECAUSE THE REMEDIES ARE OPPOSITE. A pending receipt whose unit the new plan STILL HOLDS is
 * re-draftable: collect refuses it by name and re-drafting it against the recorded plan clears it. A pending
 * receipt whose unit the new plan DROPPED can be neither collected nor re-drafted — `collectUnits` puts it in
 * `unplanned` (reported, never refused, so one stray file cannot stop the run) and `planUnit` refuses the id, so
 * there is no draft command that will accept it. Telling an operator to "re-draft" that one sends them to a
 * refusal; telling them nothing leaves a directory of work they think is pending. Both are named, separately,
 * with the remedy each actually has.
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
 * Every drafted-but-uncollected unit the recorded plan has just made uncollectable, split by the remedy it has —
 * or why that could not be read. Two arms, exhaustive, no default; `sentence` is on both, so a printer never has
 * to reconstruct one.
 */
export type StrandedUnitDrafts =
  | {
      readonly state: "read";
      /**
       * Ascending unit ids the recorded plan still holds. `collectUnits` refuses each by name, and re-drafting it
       * against the recorded plan is what clears it.
       */
      readonly redraftable: readonly string[];
      /**
       * Ascending unit ids the recorded plan no longer holds. Collect reports these as `unplanned` rather than
       * refusing, and no draft command will accept them (`planUnit` refuses an id the plan does not hold) — so the
       * work is lost and the files are inert. Named because a directory of drafts nobody can act on is worse
       * unmentioned than mentioned.
       */
      readonly unplannable: readonly string[];
      /** The reading in words — a real statement in the zero case as well as the non-zero one. */
      readonly sentence: string;
    }
  | {
      readonly state: "not-read";
      /** Why the receipt directory could not be scanned, verbatim, plus what it means for this plan. */
      readonly sentence: string;
    };

/**
 * Which pending drafts the plan now on disk cannot collect, and which of those can still be re-drawn.
 *
 * BOTH TESTS ARE THE ONES COLLECT MAKES, in the order collect makes them: `collectUnits` first splits pending
 * receipts on whether the plan view holds the unit id (`unplanned` versus recordable) and only then compares the
 * plan digest. Classifying in the other order would put a dropped unit in the re-draftable bucket and send an
 * operator to `planUnit`'s refusal.
 *
 * Every input is an argument: a function that went and read the run itself would be a second reader of a state
 * the caller already holds — and the unit ids must come from the SAME artifact the digest does, or the two halves
 * of one classification would be about two different plans.
 */
export function strandedUnitDrafts(
  pending: readonly UnitDraftReceipt[],
  planCatalogDigest: string,
  plannedUnitIds: readonly string[]
): StrandedUnitDrafts {
  const planned = new Set(plannedUnitIds);
  const unplannable: string[] = [];
  const redraftable: string[] = [];
  for (const receipt of pending) {
    if (!planned.has(receipt.unitId)) unplannable.push(receipt.unitId);
    else if (receipt.planCatalogDigest !== planCatalogDigest) redraftable.push(receipt.unitId);
  }
  unplannable.sort(compareUnitIds);
  redraftable.sort(compareUnitIds);
  return { state: "read", redraftable, unplannable, sentence: sentenceFor(pending.length, planCatalogDigest, redraftable, unplannable) };
}

/** One sentence covering the four combinations, so neither bucket can be reported by silence. */
function sentenceFor(
  pending: number,
  planCatalogDigest: string,
  redraftable: readonly string[],
  unplannable: readonly string[]
): string {
  const clauses: string[] = [];
  if (redraftable.length > 0) {
    clauses.push(`${redraftable.length} drafted unit(s) were written against a superseded plan and must be re-drafted before they can be collected — collect refuses them by name: ${redraftable.join(", ")}`);
  }
  if (unplannable.length > 0) {
    clauses.push(`${unplannable.length} drafted unit(s) name a unit this plan no longer holds, so they can be neither collected nor re-drafted and the work in them is lost: ${unplannable.join(", ")}`);
  }
  if (clauses.length === 0) {
    return `No drafted unit is waiting to be collected against a superseded plan, so this plan costs no re-drawing (${pending} pending draft(s) checked against plan ${planCatalogDigest.slice(0, 16)})`;
  }
  return clauses.join("; and ");
}

/** The `not-read` arm, with the scan's own failure in the sentence rather than behind a generic word. */
export function strandedUnitDraftsUnread(reason: string): StrandedUnitDrafts {
  return {
    state: "not-read",
    sentence: `The drafted-but-uncollected units this plan strands could not be read, so this plan's cost in re-drawing is unknown — not zero: ${reason}. Fix the receipt this names, then run \`excavator collect --run <run> --units\` to see which drafts still stand.`
  };
}
