import test from "node:test";
import assert from "node:assert/strict";
import { scaffoldSectionClaims } from "../src/assurance/claims-scaffold.ts";
import { auditSectionClaims, substantiveSegments } from "../src/assurance/section-audit.ts";

// A section with prose and a markdown table, plus the evidence block a real section carries. Each
// table cell that clears the substantive threshold is its own segment, exactly as the audit splits
// them; the collapsed evidence block is excluded from segmentation but supplies the cited id.
const EVIDENCE_ID = "S-abc1234567";
const SECTION = `## Overview

The system validates each incoming request before persistence.

| Component | Responsibility |
| --- | --- |
| Authentication middleware | Rejects unauthenticated requests |
| Persistence layer | Writes validated records to storage |

<details>
<summary>Evidence</summary>

- ${EVIDENCE_ID}

</details>
`;

test("scaffold emits one fact stub per substantive segment, including per table cell", () => {
  const stubs = scaffoldSectionClaims(SECTION);
  const segments = substantiveSegments(SECTION);

  // Reuse, not re-derivation: one stub per audit segment, each stub statement derived from (and
  // contained by) its segment, with the segment's trailing terminator dropped so it binds to prose.
  assert.equal(stubs.length, segments.length);
  stubs.forEach((claim, index) => {
    assert.equal(claim.id, `claim-${index + 1}`);
    assert.equal(claim.marker, "fact");
    assert.deepEqual(claim.evidenceIds, []);
    assert.deepEqual(claim.workItemIds, []);
    assert.ok(claim.statement.length > 0);
    assert.doesNotMatch(claim.statement, /[；;。！？!?]$/u, `stub ${claim.id} kept a trailing terminator`);
    assert.ok(segments[index].includes(claim.statement), `stub ${claim.id} statement is not derived from its segment`);
  });

  // Prose and each table cell surface as distinct statements.
  const statements = stubs.map((claim) => claim.statement);
  assert.ok(statements.some((statement) => statement.includes("validates each incoming request")), statements.join(" | "));
  assert.ok(statements.some((statement) => statement.includes("Rejects unauthenticated requests")), statements.join(" | "));
  assert.ok(statements.some((statement) => statement.includes("Writes validated records to storage")), statements.join(" | "));
});

test("scaffold output binds to the section and passes the audit with no findings", () => {
  // Attach the section's cited evidence id to every stub, exactly what an author does next.
  const claims = scaffoldSectionClaims(SECTION).map((claim) => ({ ...claim, evidenceIds: [EVIDENCE_ID] }));
  const findings = auditSectionClaims({
    documentId: "doc",
    sectionIndex: 1,
    sectionText: SECTION,
    claimsFile: { version: 2, documentId: "doc", section: 1, claims },
    evidenceIds: new Set([EVIDENCE_ID])
  });
  // No coverage gap AND no "statement is not present" binding error: every stub is both covered and
  // verbatim in the section. This fails against an untrimmed scaffold (table cells carry a stray ；).
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
});
