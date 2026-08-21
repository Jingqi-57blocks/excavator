import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { auditTraces } from "../src/investigation/assurance.ts";
import { collectClaims } from "../src/report/assurance-artifacts.ts";
import type { DocumentPlan, SectionClaim, TraceCatalog } from "../src/base/types.ts";
import { tempDir } from "./helpers.ts";

// A CHECK THAT WAS MEASURING SOMETHING OTHER THAN WHAT IT PROMISED.
//
// `collectClaims` keyed on the claim id alone, but ids are unique only within a section. A run with 472 claims
// across 12 sections reported 81 — the number that becomes `metrics.claims` and feeds `eval compare`. Fixing the
// key then endangers `auditTraces`, which compares against BARE ids; that hazard is the second test here, and the
// suite could not see it before it was written.
//
// THE FILE HELD A SECOND SUBJECT UNTIL 57B-481. The rescued-logic advisory — which searched the report text for
// an identifier while `writing-rules.md` told authors the opposite ("The prose need not contain the identifier —
// the coverage ledger binds through the cited evidence"), warned about five properly disposed items on a real
// run, and was silenced by stuffing identifiers into a collapsed block — was retired with the section audit. Its
// disposition-through-evidence half is what the unit path enforces instead, and enforces harder: a rescued logic
// item is promoted to a work item (`logic-workitems.ts`), so `auditUnitGrounding` demands a linked claim reusing
// its evidence rather than warning when the prose omits a name.

function claim(overrides: Partial<SectionClaim>): SectionClaim {
  return { id: "claim-1", kind: "fact", statement: "s", evidenceIds: [], ...overrides } as SectionClaim;
}

// --- claim counting ---

// The layout is the one `makeDocumentPlan` builds — `sections/<documentId>/` and `claims/<documentId>/` —
// because `collectClaims` resolves a section's sidecar under the run directory it is given (57B-452), and a
// fixture inventing its own layout would be testing a shape the product never writes.
const DOCUMENT_ID = "feature-k-engineering";

async function runWithClaims(sections: Array<{ index: number; claims: SectionClaim[] }>): Promise<{ documents: DocumentPlan[]; runDir: string }> {
  const runDir = await tempDir();
  await mkdir(join(runDir, "claims", DOCUMENT_ID), { recursive: true });
  const document = {
    id: DOCUMENT_ID, kind: "feature", audience: "engineering", subject: "Leave",
    templatePath: "/tmp/t.md", contextPath: "/tmp/c.md",
    sections: sections.map((section) => ({
      index: section.index, title: `S${section.index}`,
      file: join(runDir, "sections", DOCUMENT_ID, `${section.index}.md`),
      claimsFile: join(runDir, "claims", DOCUMENT_ID, `${section.index}.json`), complete: true,
    })),
  } as unknown as DocumentPlan;
  for (const section of sections) {
    await writeFile(join(runDir, "claims", DOCUMENT_ID, `${section.index}.json`), JSON.stringify({ version: 2, documentId: document.id, section: section.index, claims: section.claims }));
  }
  return { documents: [document], runDir };
}

// Every section numbers its claims from 1, so an id-keyed map collapses the run into one section's worth.
test("claims are counted per section, not collapsed by a shared id", async () => {
  const { documents, runDir } = await runWithClaims([
    { index: 1, claims: [claim({ id: "claim-1" }), claim({ id: "claim-2" })] },
    { index: 2, claims: [claim({ id: "claim-1" }), claim({ id: "claim-2" }), claim({ id: "claim-3" })] },
  ]);
  const claims = await collectClaims(runDir, documents);
  assert.equal(claims.size, 5, "two sections of 2 and 3 are five claims, not three");
  assert.ok(claims.has("feature-k-engineering#1#claim-1"));
  assert.ok(claims.has("feature-k-engineering#2#claim-1"), "same id, different section, both kept");
});

// The hazard the fix creates, which the suite could not see until this test existed: a trace step cites a
// claim by its BARE id, so handing it the composite keys would report every legitimate citation as missing.
test("trace citations are checked against bare claim ids, not the composite keys", async () => {
  const { documents, runDir } = await runWithClaims([{ index: 1, claims: [claim({ id: "claim-1" })] }]);
  const collected = await collectClaims(runDir, documents);
  const traces = {
    version: 1,
    traces: [{
      id: "TRACE-1", title: "t", kind: "call", status: "verified", documentIds: ["feature-k-engineering"],
      steps: [{ index: 1, action: "a", location: "l", evidenceIds: [], claimIds: ["claim-1"] }],
    }],
  } as unknown as TraceCatalog;

  const bare = new Set([...collected.values()].map((entry) => entry.id));
  assert.deepEqual(
    auditTraces(traces, new Set(["feature-k-engineering"]), new Set(), bare).filter((finding) => /missing claim id/.test(finding.message)),
    [], "a real citation resolves",
  );

  const composite = new Set(collected.keys());
  const broken = auditTraces(traces, new Set(["feature-k-engineering"]), new Set(), composite);
  assert.equal(broken.filter((finding) => /missing claim id/.test(finding.message)).length, 1,
    "and passing the composite keys instead would break every citation — which is why the call site converts");
});
