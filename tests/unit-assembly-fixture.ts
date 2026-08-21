/**
 * The model-free chain, one step further than `tests/unit-fixture.ts` takes it: plan -> draft every unit -> collect.
 *
 * It exists because unit assembly's premise is "every unit of every planned document is collected", and a test that
 * built that state inline would be a second copy of the drafting rules. Everything here goes through the real
 * commands — `checkpointUnit` is `draftUnit` + `collectUnits` — and through the fixture's own summary derivation, so
 * a run this helper produces is one the production path could have produced.
 *
 * `redraftUnit` re-drafts ONE unit with different bytes and re-collects it, which is how a test moves a document's
 * content without hand-editing a file the ledger vouches for. The summary's `contentDigest` is recomputed with
 * Core's own normalizer and digest for the reason `unitDraftFor` states: a fixture that computed it a second way
 * would be testing the second way.
 */

import { normalizeSection } from "../src/report/checkpoint.ts";
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import { unitContentDigest, type UnitSummary } from "../src/report/unit-output.ts";
import { manifestOf, planViewOf, plannedRun, unitDraftFor, type PlannedRun } from "./unit-fixture.ts";

/** A planned run with every unit of every document drafted and collected, in the plan's one order. */
export async function collectedRun(audiences: Array<"product" | "engineering"> = ["product"]): Promise<PlannedRun> {
  return checkpointEveryUnit(await plannedRun(audiences));
}

/**
 * Draft and collect every unit the run's CURRENTLY RECORDED plan holds, in that plan's one order.
 *
 * Split out of `collectedRun` for the caller that re-plans a run onto a new knowledge epoch and has to redraw the
 * whole document against the new plan: the collection order and the unit ids both come from the recorded plan, so
 * a caller that spelled the loop itself would hold a second copy of "which units, in which order" the moment a
 * re-plan changed either.
 *
 * THE MANIFEST IS RE-READ ON THE WAY OUT, for the same reason the view is. That caller has just moved the run to a
 * new epoch, which is exactly when `knowledgeEpoch`, `frozenAt` and `knowledgeDigest` on the manifest it handed in
 * became wrong; returning it unchanged would hand back a value that reads fine and is stale.
 */
export async function checkpointEveryUnit(run: PlannedRun): Promise<PlannedRun> {
  for (const unitId of (await planViewOf(run.runDir)).collectionOrder) {
    // The view is reloaded per unit because collecting one changes what the next may reference: a synthesis's
    // summary has to name its children's RECORDED digests, and those only exist after the children are collected.
    await checkpointUnit(run.runDir, await unitDraftFor({ ...run, view: await planViewOf(run.runDir) }, unitId));
  }
  return { ...run, manifest: await manifestOf(run.runDir), view: await planViewOf(run.runDir) };
}

/** Re-draft one unit with the given content and collect it. Returns the normalized bytes that landed on disk. */
export async function redraftUnit(run: PlannedRun, unitId: string, content: string): Promise<string> {
  const view = await planViewOf(run.runDir);
  const unit = view.byId.get(unitId);
  if (!unit) throw new Error(`fixture asked to re-draft ${unitId}, which this plan does not hold`);
  const draft = await unitDraftFor({ ...run, view }, unitId);
  const normalized = normalizeSection(content, unit.title);
  // `UnitDraftInput.summary` is deliberately `unknown` — the draft path parses it as untrusted input — so the
  // fixture names the type it just built rather than reaching through `unknown`.
  const summary = draft.summary as UnitSummary;
  await checkpointUnit(run.runDir, {
    ...draft,
    content,
    summary: { ...summary, contentDigest: unitContentDigest(normalized) }
  });
  return normalized;
}
