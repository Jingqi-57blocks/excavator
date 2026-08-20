/**
 * `checkpoint`, for one unit: draft it and collect it, in that order, in one call.
 *
 * IT IS THE COMPOSITION AND NOTHING ELSE. The serial convenience of a checkpoint must not become a second way to
 * write a unit — a path that skipped a validation the split path performs, or appended an event the split path
 * does not, would make the two forms disagree about what a run holds. So this function calls `draftUnit` and then
 * `collectUnits`, and the ledger and timeline a checkpoint leaves are the ones the two commands leave.
 *
 * `collectUnits` COLLECTS EVERYTHING PENDING, not just this unit, and that is the honest semantics: the barrier is
 * run-wide by construction, and a checkpoint that collected one receipt while leaving others would be a second
 * ordering rule. The result therefore reports every receipt the barrier recorded, this unit among them.
 */

import type { UnitDraftInput } from "./unit-draft.ts";
import { draftUnit } from "./unit-draft.ts";
import { collectUnits } from "./unit-collect.ts";
import type { UnitCollectResult } from "./unit-collect.ts";
import type { UnitDraftReceipt } from "./unit-receipt.ts";

export interface UnitCheckpointResult {
  readonly receipt: UnitDraftReceipt;
  readonly collected: UnitCollectResult;
}

/** Draft one unit and run the barrier. */
export async function checkpointUnit(runDir: string, input: UnitDraftInput): Promise<UnitCheckpointResult> {
  const receipt = await draftUnit(runDir, input);
  return { receipt, collected: await collectUnits(runDir) };
}
