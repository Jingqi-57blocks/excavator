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
 *   - it USED to have a third caller, `authoring-stage.ts`'s `assembleRun`, which wrote `reports/<this name>`.
 *     That one went in the same slice's next batch, and with it the last producer of this name.
 *
 * SO IT IS NOW AN ARCHIVED-RUN ARM, and the tense above is checked rather than assumed: grep-verified when this
 * was rewritten, the only callers are the two readers named above (`git grep -n reportFileName -- src` → one
 * conflict-refusal site, one audit site). Nothing writes this name any more, so its retirement belongs with the
 * rest of that arm — `section-paths.ts`, 57B-481 — which answers "may an archived run still be located and
 * audited?" once, for all of them.
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
