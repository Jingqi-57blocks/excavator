/**
 * Do the claims of a document account for the work items that document is required to cover?
 *
 * Moved out of `section-audit.ts` whole (57B-481). It sat there because section claims were its only input, but
 * the question is a WORK-ITEM question, not a section one: `run.ts` is its only importer today (grep-verified
 * when this file was written), and it keeps asking it on every audited run — including runs with no sections at
 * all, where the honest answer is the named "not evaluated from section claims" sentence `auditRun` prints
 * beside it rather than a silent pass over an empty map.
 *
 * THE TWO KINDS OF FINDING ARE WHY IT SURVIVED THE SECTION RULES. Claim-attribution defects are detectable from
 * one document and are always errors; completeness assertions are about the whole requested set and are
 * downgraded by the caller's scope. That split is what let the section rules retire without taking the work-item
 * accounting with them.
 */

import type { AuditFinding, DocumentPlan, InvestigationPlan, SectionClaim } from "../base/types.ts";

function error(document: string, message: string): AuditFinding { return { level: "error", document, message }; }

/**
 * Coverage findings split into two kinds. Claim-attribution defects (a claim pointing at an
 * unknown work item, a document it is not required for, or the wrong section) are always errors:
 * they are detectable from the single document under audit, so they run for every document passed,
 * complete or not. Completeness findings (a material work item that no claim represents) assert
 * something about the WHOLE requested document set: a caller auditing a partial or single-document
 * scope passes `coverageLevel: "warning"` to keep them advisory, and passes `completeDocumentIds`
 * so completeness is certified only for documents whose sections are all checkpointed — an
 * incomplete document is still attribution-checked but never reported as falsely under-covered.
 */
export function auditWorkItemClaimCoverage(plan: InvestigationPlan, documents: DocumentPlan[], claimsByDocument: Map<string, Array<{ section: number; claim: SectionClaim }>>, options: { coverageLevel?: "error" | "warning"; completeDocumentIds?: Set<string> } = {}): AuditFinding[] {
  const coverageLevel = options.coverageLevel ?? "error";
  const coverage = (document: string, message: string): AuditFinding => ({ level: coverageLevel, document, message });
  const findings: AuditFinding[] = [];
  const items = new Map(plan.items.map((item) => [item.id, item]));
  for (const document of documents) {
    const claims = claimsByDocument.get(document.id) ?? [];
    for (const { section, claim } of claims) {
      for (const id of claim.workItemIds ?? []) {
        const item = items.get(id);
        if (!item) { findings.push(error(document.id, `claim ${claim.id} references unknown work item ${id}`)); continue; }
        if (!item.requiredFor.includes(document.id)) findings.push(error(document.id, `claim ${claim.id} references work item ${id} that is not required for this document`));
        // The exact section-link check assumes the canonical 1..12 feature chapter numbering. A prd feature
        // report has its own (fewer) chapters, so a work item pinned to §N need not land in the prd chapter N;
        // skip only this check for prd (product/engineering paths are byte-unchanged). Every other coverage
        // rule below still applies to prd.
        if (document.audience !== "prd" && item.reportSection && item.reportSection !== section) findings.push(error(document.id, `claim ${claim.id} links work item ${id} to section ${section}, expected section ${item.reportSection}`));
      }
    }
    // Completeness certifies the full requested set; skip it for a document the caller marks incomplete.
    if (options.completeDocumentIds && !options.completeDocumentIds.has(document.id)) continue;
    for (const item of plan.items.filter((candidate) => candidate.material && candidate.requiredFor.includes(document.id) && candidate.origin !== "open")) {
      const linked = claims.filter(({ claim }) => (claim.workItemIds ?? []).includes(item.id));
      if (!linked.length) { findings.push(coverage(document.id, `material work item ${item.id} is not represented by any report claim`)); continue; }
      if (item.status === "found") {
        const grounded = linked.some(({ claim }) => (claim.evidenceIds ?? []).some((id) => item.evidenceIds.includes(id)) || (claim.traceIds ?? []).some((id) => item.traceIds.includes(id)));
        if (!grounded) findings.push(coverage(document.id, `claims for material work item ${item.id} do not reuse its evidence or trace`));
      }
      if (item.status === "searched-not-found" && !linked.some(({ claim }) => claim.marker === "verified" && (claim.evidenceIds ?? []).some((id) => item.evidenceIds.includes(id)))) {
        findings.push(coverage(document.id, `searched-not-found work item ${item.id} requires a linked verified claim using its search receipt`));
      }
      if (["cannot-determine", "not-applicable"].includes(item.status) && !linked.some(({ claim }) => claim.marker === "unavailable" || claim.marker === "verified")) {
        findings.push(coverage(document.id, `unresolved work item ${item.id} requires a linked unavailable or verified claim`));
      }
    }
  }
  return findings;
}
