import type { SectionClaim } from "../base/types.ts";
import { substantiveSegments } from "./section-audit.ts";

/**
 * Emit one claim stub per substantive segment of a section, reusing the exact segmentation the audit
 * enforces (`substantiveSegments`) so a scaffold can never drift from `auditSectionClaims`. Each stub
 * carries the segment text as its statement and leaves the evidence and work-item links for the
 * author to fill; the default `fact` marker is the weakest level that still requires evidence.
 *
 * The segmenter joins table-row cells with `；` and keeps that terminator on non-final cells, so a
 * raw segment such as `"Component；"` carries a separator that is absent from the source prose. A
 * claim `statement` must appear verbatim in the section, so the trailing terminator is trimmed here:
 * audit coverage is bidirectional containment, so the trimmed statement is still contained by its
 * segment and stays covered, while now also binding to the visible section text.
 */
/**
 * RETIREMENT DEFERRED, WITH A REASON (57B-480 batch 2d). `scaffoldClaims` — the `claims scaffold` command's
 * Core half — was this module's only production caller, and it is gone. What is left is a module whose two
 * tests defend code nothing in the product reaches, which is normally a defect and is called out here rather
 * than left for someone to notice.
 *
 * It is NOT retired in this slice for two checkable reasons:
 *   - it imports `substantiveSegments` / `auditSectionClaims` from `section-audit.ts`, which this slice is
 *     forbidden to touch (that file's retirement is 57B-481's, per its own scope);
 *   - `tests/claim-statement-binding.test.ts` still uses `scaffoldSectionClaims` as its claim GENERATOR, and
 *     that file is the 16-case real-corpus fixture 57B-491 is scheduled to migrate onto the unit path. Deleting
 *     the generator first would delete the corpus's scaffolding before its new home exists.
 *
 * So it goes with `section-audit.ts` (57B-481) or with the corpus migration (57B-491), whichever lands first.
 */

export function scaffoldSectionClaims(sectionText: string): SectionClaim[] {
  return substantiveSegments(sectionText).map((segment, index) => ({
    id: `claim-${index + 1}`,
    marker: "fact",
    statement: segment.replace(/[；;。！？!?]+$/u, "").trim(),
    evidenceIds: [],
    workItemIds: []
  }));
}
