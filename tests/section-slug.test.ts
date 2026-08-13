import test from "node:test";
import assert from "node:assert/strict";
import { sectionFileStem, sectionTitleSlug } from "../src/assurance/section-slug.ts";

test("sectionTitleSlug strips a leading ordinal and slugifies the remainder", () => {
  assert.equal(sectionTitleSlug("4. Business rules, states, and consistency"), "business-rules-states-and-consistency");
  assert.equal(sectionTitleSlug("10. Configuration, jobs, deployment, and observability"), "configuration-jobs-deployment-and-observability");
  // "N)" ordinal form is also stripped; a title without an ordinal is kept whole.
  assert.equal(sectionTitleSlug("2) Entry points"), "entry-points");
  assert.equal(sectionTitleSlug("Glossary"), "glossary");
});

test("sectionTitleSlug collapses punctuation runs and trims edges", () => {
  assert.equal(sectionTitleSlug("  Files, messages & external — integrations!  "), "files-messages-external-integrations");
  assert.equal(sectionTitleSlug("A/B  test:  v2"), "a-b-test-v2");
});

test("sectionTitleSlug caps length without a trailing separator", () => {
  const slug = sectionTitleSlug("word ".repeat(40), 20);
  assert.ok(slug.length <= 20, `slug too long: ${slug.length}`);
  assert.ok(!slug.endsWith("-"), `slug ends with separator: ${slug}`);
  // A cap that lands exactly on a separator boundary still yields no trailing "-".
  assert.equal(sectionTitleSlug("alpha beta gamma", 11), "alpha-beta");
});

test("sectionTitleSlug returns empty when the title has no alphanumeric content", () => {
  assert.equal(sectionTitleSlug("—  ,  !"), "");
  assert.equal(sectionTitleSlug("###"), "");
});

test("sectionTitleSlug is byte-stable for identical input", () => {
  assert.equal(sectionTitleSlug("4. Business rules"), sectionTitleSlug("4. Business rules"));
});

test("sectionFileStem pads the number and joins the slug; falls back to the bare number when empty", () => {
  assert.equal(sectionFileStem(4, "4. Business rules, states, and consistency"), "04-business-rules-states-and-consistency");
  assert.equal(sectionFileStem(13, "13. Glossary"), "13-glossary");
  // Empty slug (defensive) falls back to just the zero-padded number.
  assert.equal(sectionFileStem(7, "—"), "07");
});
