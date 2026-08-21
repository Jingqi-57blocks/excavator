import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditFinding } from "../base/types.ts";
import { exists, listDirectories } from "../base/util.ts";

/**
 * What is left of parallel section authoring: the advisory that counts receipts nobody can collect any more.
 *
 * `draftSection` and `collectDrafts` are gone (57B-480). They were the "write in parallel, account serially" pair
 * of the section path — N drafts at per-(document, section) unique paths, then one single-writer barrier recording
 * them into the timeline in a deterministic order. The unit path answers the same requirement with the same shape
 * (`unit-collect.ts`, which is what `docs/layering.md` now cites as the sequence authority), so what was deleted
 * is one implementation of it, not the property.
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
