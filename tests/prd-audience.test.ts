import test from "node:test";
import assert from "node:assert/strict";
import type { DocumentPlan, InvestigationPlan, InvestigationWorkItem, SectionClaim } from "../src/base/types.ts";
import { auditWorkItemClaimCoverage } from "../src/report/work-item-claim-coverage.ts";

// --- 1. the ONE substantive prd relaxation: the section-link check, with a hard negative control ---

function featureDoc(audience: DocumentPlan["audience"], id: string): DocumentPlan {
  return { id, kind: "feature", audience, subject: "Leave", templatePath: "/t", contextPath: "/c", sections: [] };
}

test("the section-link check is relaxed for prd but still fires for engineering (negative control) (57B-380)", () => {
  const prdDoc = featureDoc("prd", "feature-abc-prd");
  const engDoc = featureDoc("engineering", "feature-abc-engineering");
  // One §5-pinned work item, required for both documents; non-material so no completeness finding intrudes.
  const item: InvestigationWorkItem = {
    id: "feature:abc:authorization", dimension: "authorization", scope: "feature:abc", hypothesis: "h",
    status: "found", material: false, requiredFor: [prdDoc.id, engDoc.id], evidenceIds: [], traceIds: [],
    reportSection: 5, origin: "default"
  };
  const plan: InvestigationPlan = { version: 1, runId: "run-x", createdAt: "t", items: [item] };
  // A claim placed in section 3 — the "wrong" chapter for a §5-pinned item — that cites the work item.
  const claim: SectionClaim = { id: "C-1", marker: "fact", statement: "s", evidenceIds: [], workItemIds: [item.id] };

  const prdFindings = auditWorkItemClaimCoverage(plan, [prdDoc], new Map([[prdDoc.id, [{ section: 3, claim }]]]));
  assert.ok(!prdFindings.some((finding) => /expected section/.test(finding.message)), JSON.stringify(prdFindings));

  // Negative control — the exact same scenario on an engineering document STILL errors. This proves the
  // relaxation is prd-gated and does not leak into the product/engineering paths.
  const engFindings = auditWorkItemClaimCoverage(plan, [engDoc], new Map([[engDoc.id, [{ section: 3, claim }]]]));
  assert.ok(
    engFindings.some((finding) => finding.level === "error" && /links work item .* to section 3, expected section 5/.test(finding.message)),
    JSON.stringify(engFindings)
  );
});
