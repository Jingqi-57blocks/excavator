import test from "node:test";
import assert from "node:assert/strict";
import { auditReadabilityTables } from "../src/assurance/section-audit.ts";
import type { Audience, DocumentKind, DocumentPlan } from "../src/core/types.ts";

function doc(kind: DocumentKind, audience: Audience): DocumentPlan {
  return { id: `${kind}-${audience}`, kind, audience, templatePath: "", contextPath: "", sections: [] };
}

// A substantive inventory chapter written as prose, with no Markdown table.
const PROSE = "## Inventory\n\nThe system exposes an accounts capability, a billing capability and a reporting capability.\n";
// The same chapter with the items presented as a Markdown table.
const TABLE = "## Inventory\n\n| Capability | Purpose |\n| --- | --- |\n| Accounts | Sign in |\n| Billing | Invoices |\n";
// A table that lives only inside a collapsed evidence block is not part of the tabular reading flow.
const TABLE_IN_DETAILS = "## Inventory\n\nThe system exposes an accounts capability, a billing capability and a reporting capability.\n\n<details><summary>evidence</summary>\n\n| id | path |\n| --- | --- |\n| S-1 | a.ts |\n\n</details>\n";
// A heading with no substantive statement: nothing to tabulate.
const HEADING_ONLY = "## Inventory\n";

function audit(document: DocumentPlan, sectionIndex: number, sectionText: string) {
  return auditReadabilityTables({ document, sectionIndex, sectionText });
}

test("a designated inventory section with prose but no table warns exactly once, never errors", () => {
  const cases: Array<[DocumentPlan, number]> = [
    [doc("feature", "product"), 3],
    [doc("overview", "product"), 2],
    [doc("overview", "engineering"), 2]
  ];
  for (const [document, sectionIndex] of cases) {
    const findings = audit(document, sectionIndex, PROSE);
    assert.equal(findings.length, 1, `${document.id} section ${sectionIndex}`);
    assert.equal(findings[0].level, "warning");
    assert.notEqual(findings[0].level, "error");
    assert.equal(findings[0].document, document.id);
    assert.match(findings[0].message, /no Markdown table/);
  }
});

test("the same designated section carrying a Markdown table produces no finding", () => {
  const cases: Array<[DocumentPlan, number]> = [
    [doc("feature", "product"), 3],
    [doc("overview", "product"), 2],
    [doc("overview", "engineering"), 2]
  ];
  for (const [document, sectionIndex] of cases) {
    assert.deepEqual(audit(document, sectionIndex, TABLE), [], `${document.id} section ${sectionIndex}`);
  }
});

test("a table only inside a collapsed evidence block still warns (reading flow is prose)", () => {
  assert.equal(audit(doc("feature", "product"), 3, TABLE_IN_DETAILS).length, 1);
});

test("engineering-feature documents are untouched by this advisory check (hard path owns them)", () => {
  // Even on an index the hard path treats as tabular, this new function emits nothing for eng-feature.
  for (const sectionIndex of [3, 5, 6, 7, 8, 9, 11]) {
    assert.deepEqual(audit(doc("feature", "engineering"), sectionIndex, PROSE), [], `eng-feature section ${sectionIndex}`);
  }
});

test("a non-designated section of a covered contract is not flagged", () => {
  // product-feature §1 is a boundary narrative, deliberately absent from the inventory set.
  assert.deepEqual(audit(doc("feature", "product"), 1, PROSE), []);
  // product-overview §1 (purpose) and §10 (coverage) are omitted too.
  assert.deepEqual(audit(doc("overview", "product"), 1, PROSE), []);
  assert.deepEqual(audit(doc("overview", "product"), 10, PROSE), []);
});

test("a heading-only designated section has nothing to tabulate and is not flagged", () => {
  assert.deepEqual(audit(doc("feature", "product"), 3, HEADING_ONLY), []);
  assert.deepEqual(audit(doc("overview", "engineering"), 2, HEADING_ONLY), []);
});

test("every designated inventory index warns on prose and clears on a table, and never errors", () => {
  const contracts: Array<[DocumentPlan, number[]]> = [
    [doc("overview", "product"), [2, 3, 4, 5, 7, 8]],
    [doc("overview", "engineering"), [2, 3, 5, 7, 8, 9, 10, 11]],
    [doc("feature", "product"), [3, 5, 6, 7, 8, 9, 13]]
  ];
  for (const [document, indices] of contracts) {
    for (const sectionIndex of indices) {
      const prose = audit(document, sectionIndex, PROSE);
      assert.equal(prose.length, 1, `${document.id} section ${sectionIndex} prose`);
      assert.equal(prose[0].level, "warning");
      assert.deepEqual(audit(document, sectionIndex, TABLE), [], `${document.id} section ${sectionIndex} table`);
    }
  }
});
