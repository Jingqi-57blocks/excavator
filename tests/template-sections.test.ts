import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Pins the canonical chapter order of the four report templates. Audits in src/assurance/assurance.ts key on a
// section's 1-based POSITIONAL index (run.ts makeDocumentPlan assigns `index: index + 1` from heading
// order, not from the number written in the title), so several audit constants encode fixed chapter
// numbers: auditTargetProblemAttribution (feature problem chapter = §11, product overview = §9),
// READABILITY_TABLE_SECTIONS ("feature:product" glossary = §13), and the FEATURE_HYPOTHESES canonical
// reportSection map (connected-change-scope → 10, tests/documentation-drift/unfinished-and-current-
// problems → 11, coverage-accounting/open-investigation → 12). These tests freeze the template side of
// that alignment so a future template edit that reorders or renumbers chapters fails here instead of
// silently misrouting an audit.

const REFERENCES = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "excavator", "references");

interface Section {
  /** 1-based position in document order — exactly the sectionIndex every audit receives. */
  index: number;
  /** The number written in the heading text ("## N. Title"). */
  number: number;
  title: string;
}

function sectionsOf(template: string): Section[] {
  const text = readFileSync(join(REFERENCES, template), "utf8");
  // Same heading extraction run.ts's makeDocumentPlan uses.
  const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim());
  return headings.map((heading, i) => {
    const match = heading.match(/^(\d+)\.\s+(.+)$/);
    assert.ok(match, `"${template}" heading is not "N. Title": ${heading}`);
    return { index: i + 1, number: Number(match![1]), title: match![2].trim() };
  });
}

const TEMPLATES = [
  "product-feature.md",
  "product-overview.md",
  "engineering-feature.md",
  "engineering-overview.md",
  "prd-feature.md"
];

test("every template numbers its chapters 1..N in document order (written number == positional index)", () => {
  for (const template of TEMPLATES) {
    const sections = sectionsOf(template);
    assert.ok(sections.length > 0, `"${template}" has no level-two sections`);
    for (const section of sections) {
      assert.equal(section.number, section.index, `"${template}" chapter "${section.title}" is written as §${section.number} but sits at position ${section.index}`);
    }
  }
});

test("product-feature keeps 13 chapters with the standalone problem chapter at §11 (57B-364 #3)", () => {
  const sections = sectionsOf("product-feature.md");
  assert.equal(sections.length, 13);
  const byIndex = new Map(sections.map((section) => [section.index, section.title]));
  assert.equal(byIndex.get(10), "Connected capabilities and scope");
  assert.equal(byIndex.get(11), "Current problems found");
  assert.match(byIndex.get(12)!, /^Coverage/);
  assert.equal(byIndex.get(13), "Glossary");
});

test("product-overview keeps 10 chapters with the problem chapter renamed at §9 (57B-364 #3)", () => {
  const sections = sectionsOf("product-overview.md");
  assert.equal(sections.length, 10);
  const byIndex = new Map(sections.map((section) => [section.index, section.title]));
  assert.equal(byIndex.get(9), "Current problems found");
});

test("both feature templates put the coverage chapter at §12", () => {
  for (const template of ["product-feature.md", "engineering-feature.md"]) {
    const sections = sectionsOf(template);
    const twelfth = sections.find((section) => section.index === 12);
    assert.ok(twelfth, `"${template}" has no §12`);
    assert.match(twelfth!.title, /^Coverage/, `"${template}" §12 is not a coverage chapter`);
  }
});

test("engineering-feature keeps exactly 12 chapters (unchanged by 57B-364)", () => {
  assert.equal(sectionsOf("engineering-feature.md").length, 12);
});

test("prd-feature keeps 10 chapters: acceptance at §9, appendix last at §10 (57B-380)", () => {
  const sections = sectionsOf("prd-feature.md");
  assert.equal(sections.length, 10);
  const byIndex = new Map(sections.map((section) => [section.index, section.title]));
  // §1 opens on current behavior/boundary (no background chapter); §9 acceptance; §10 appendix is last.
  assert.match(byIndex.get(1)!, /boundary/i);
  assert.equal(byIndex.get(9), "Acceptance checklist");
  assert.match(byIndex.get(10)!, /^Appendix/);
});

test("engineering-overview appends the database-design chapter at §13 (57B-379)", () => {
  const sections = sectionsOf("engineering-overview.md");
  assert.equal(sections.length, 13);
  const byIndex = new Map(sections.map((section) => [section.index, section.title]));
  // §11 and §12 keep their pre-append titles so the appended chapter is proven purely additive.
  assert.equal(byIndex.get(11), "Tests, documentation, and current technical problems");
  assert.match(byIndex.get(12)!, /^Coverage/);
  assert.equal(byIndex.get(13), "Database design");
});
