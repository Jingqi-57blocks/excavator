import type { SectionClaim } from "./types.ts";
import { substantiveSegments } from "./assurance.ts";

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
export function scaffoldSectionClaims(sectionText: string): SectionClaim[] {
  return substantiveSegments(sectionText).map((segment, index) => ({
    id: `claim-${index + 1}`,
    marker: "fact",
    statement: segment.replace(/[；;。！？!?]+$/u, "").trim(),
    evidenceIds: [],
    workItemIds: []
  }));
}
