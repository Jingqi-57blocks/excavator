/**
 * The file name the SECTION path gives one document's assembled report.
 *
 * IT OUTLIVED ITS OWN PATH ON PURPOSE. This was one function in `authoring-plan.ts`, beside the section
 * authoring chain that 57B-480 retires. It moved here instead of going with them because two LIVE readers ask
 * "what would the section path call this document's report?" and neither is section authoring:
 *
 *   - `unit-assembly-source.ts` derives the section path's target set so `assertNoSectionPathConflict` can refuse
 *     a unit deliverable that would write over one — the two report worlds share `reports/`, and that refusal is
 *     the only thing standing between them and one file silently holding two documents.
 *   - `run.ts`'s run-wide audit reports a document whose assembled report is not on disk.
 *
 * SO IT IS AN ARCHIVED-RUN ARM, not a producer: nothing writes this name any more once the section assemble is
 * gone. Its retirement therefore belongs with the rest of that arm (`section-paths.ts`, 57B-481), which is where
 * the question "may an archived run still be located and audited?" gets answered once, for all of them.
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
