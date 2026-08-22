import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditFinding } from "../base/types.ts";
import { exists, listDirectories } from "../base/util.ts";

/**
 * What is left of parallel section authoring: the advisory that counts receipts nobody can collect any more.
 *
 * `draftSection` and `collectDrafts` are gone (57B-480). They were the "write in parallel, account serially" pair
 * of the section path — N drafts at per-(document, section) unique paths, then one single-writer barrier recording
 * them into the timeline in a deterministic order. `unit-collect.ts` answers THAT requirement with the same shape,
 * which is why `docs/layering.md` now cites it as the sequence authority.
 *
 * TWO OF `collectDrafts`'s BEHAVIOURS HAVE NO UNIT COUNTERPART, and neither is covered by the sentence above — it
 * is about the sequence authority alone. (1) The author-budget overrun that set `manifest.state = "timed-out"` and
 * pushed a warning: `budgets.authorMs` is named for retirement (the epic's G1), because the unit path's budget
 * authority is the plan's BYTE budget and a wall-clock gate is the assertion shape this repository forbids. Its
 * last enforcer was `checkpointSection`, deleted in the same slice, so the budget now has NO executor at all —
 * the field and its CLI flag are what 57B-480's third batch retires. (2) The once-per-run `metrics.claims` aggregation, which
 * R8a classified as going with the deletion. `unit-collect.ts`'s own header says it touches neither
 * `manifest.state` nor `metrics.claims`, deliberately — so "same shape" is a claim about the ordering guarantee,
 * not about these two.
 *
 * WHY THE ADVISORY OUTLIVES BOTH. `drafts/` receipts are bytes an already-prepared run may be carrying, and its
 * only writer is gone — so from here on this can only ever fire on a run drafted before the cutover. It is an
 * ARCHIVED-RUN ARM, and it is deliberately left byte-for-byte as it was, message included, because the audit of an
 * archived run must not change in the same slice that deletes the writers. That leaves its remediation sentence
 * naming a command that can no longer record those receipts, which is a real defect and reported as one: it
 * belongs with the rest of the archived-audit arm (57B-481), where the audit output is allowed to move.
 */

/**
 * Warning-only audit advisory: uncollected drafts. Self-gated on the `drafts/` directory existing, so a run
 * that never drafted is untouched. It counts receipts left on disk — section drafts written but never
 * recorded into the timeline by `collect` — and surfaces them so an author does not assemble a run whose
 * ledger silently omits drafted sections. Additive and always advisory: it introduces no error-level rule
 * and does not bump the assurance version.
 */
export async function auditPendingDrafts(runDir: string): Promise<AuditFinding[]> {
  const draftsDir = join(runDir, "drafts");
  if (!await exists(draftsDir)) return [];
  let pending = 0;
  for (const documentDir of await listDirectories(draftsDir)) {
    for (const entry of await readdir(documentDir)) if (entry.endsWith(".json")) pending += 1;
  }
  if (!pending) return [];
  return [{ level: "warning", document: "drafts", message: `${pending} section draft(s) were written but never collected; run \`excavator collect\` to record them into the timeline before assembling.` }];
}
