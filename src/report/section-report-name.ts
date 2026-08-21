/**
 * The file name the SECTION path gives one document's assembled report.
 *
 * IT OUTLIVED ITS OWN PATH ON PURPOSE. This was one function in `authoring-plan.ts`, beside the section
 * authoring chain that 57B-480 retires. It moved here instead of going with them because it has THREE callers
 * today and only one of them is section authoring:
 *
 *   - `unit-assembly-source.ts` derives the section path's target set so `assertNoSectionPathConflict` can refuse
 *     a unit deliverable that would write over one — the two report worlds share `reports/`, and that refusal is
 *     the only thing standing between them and one file silently holding two documents.
 *   - `run.ts`'s run-wide audit reports a document whose assembled report is not on disk.
 *   - `authoring-stage.ts`'s `assembleRun` WRITES `reports/<this name>`. It is still exported from `run.ts` and
 *     still exercised by ten test files, so this function is a PRODUCER's name today, not only a reader's.
 *
 * READ THE TENSE BEFORE RETIRING IT. Once `assembleRun` goes — the next PR of this same slice family — the two
 * readers above are all that is left and this becomes an archived-run arm, whose retirement belongs with
 * `section-paths.ts` (57B-481). Until then it has a live writer, and deleting or relocating it on the strength of
 * "read-only, no producer" would break that writer.
 *
 * MOVED WITHOUT A BYTE OF BEHAVIOUR CHANGE: same slug, same audience suffix, same `feature` fallback. Its
 * callers' assertions were not touched, which is what makes that claim checkable rather than stated.
 */

import type { DocumentPlan } from "../base/types.ts";
import { slugify } from "../base/util.ts";

export function reportFileName(document: DocumentPlan): string {
  if (document.kind === "overview") return `${document.audience}-overview.md`;
  return `${slugify(document.subject ?? "feature")}-${document.audience}.md`;
}
