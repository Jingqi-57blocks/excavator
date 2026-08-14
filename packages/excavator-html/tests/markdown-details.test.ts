import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/markdown.ts";

// The real authoring shape: an open tag, a `<summary>` label, a blank line, inner markdown, a close.
const AUTHORED = "<details>\n<summary>依据</summary>\n\n- S-a1b2 — src/a.ts:1-20 handles login\n\n</details>";

test("inner markdown of a multi-line details block is rendered, its summary kept verbatim", () => {
  const html = renderMarkdown(AUTHORED);
  assert.match(html, /<ul><li>/, "the inner list is rendered, not left as raw text");
  assert.match(html, /<summary>依据<\/summary>/, "the summary line is preserved verbatim");
  assert.match(html, /^<details>/, "the open tag line is preserved");
  assert.match(html, /<\/details>$/, "the close tag is appended");
  assert.doesNotMatch(html, /(^|\n)- /, "no bare '- ' list marker survives into the HTML");
});

test("a Markdown table inside a details block becomes a real <table>", () => {
  const block = "<details>\n<summary>evidence</summary>\n\n| id | path |\n| --- | --- |\n| S-1 | a.ts |\n\n</details>";
  const html = renderMarkdown(block);
  assert.match(html, /<table>/, "the inner table is rendered");
  assert.match(html, /<td>S-1<\/td>/, "a table cell is present");
  assert.match(html, /<summary>evidence<\/summary>/);
});

test("an inner paragraph separated by a blank line renders as <p>", () => {
  const block = "<details>\n<summary>依据</summary>\n\nThis paragraph explains the evidence.\n\n</details>";
  const html = renderMarkdown(block);
  assert.match(html, /<p>This paragraph explains the evidence\.<\/p>/);
});

test("an inner evidence-marker code span becomes a tag chip", () => {
  const block = "<details>\n<summary>依据</summary>\n\nThe comparison is a `fact`.\n\n</details>";
  const html = renderMarkdown(block);
  // The chip shows the report's own marker word; `fact` is the neutral English built-in vocabulary.
  assert.match(html, /<span class="tag fact">fact<\/span>/, "the marker renders as a tag chip inside the block");
});

test("a whole <details>…</details> on a single line passes through as raw HTML (no re-render)", () => {
  // Guards packages/excavator-html/tests/html.test.ts:22, whose fixture depends on this passthrough.
  const block = "<details><summary>依据</summary><p>source</p></details>";
  assert.equal(renderMarkdown(block), block, "the single-line block is emitted verbatim");
});

test("a details block without a summary sends its whole body through the recursive renderer", () => {
  const block = "<details>\n\n- item one\n- item two\n\n</details>";
  const html = renderMarkdown(block);
  assert.match(html, /<ul><li>item one<\/li><li>item two<\/li><\/ul>/);
  assert.doesNotMatch(html, /<summary>/, "there is no summary to emit");
});

test("nested details close at the correct depth, both bodies rendered", () => {
  const block = "<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\ntext body here\n\n</details>\n\n</details>";
  const html = renderMarkdown(block);
  assert.equal((html.match(/<details>/g) ?? []).length, 2, "both open tags survive");
  assert.equal((html.match(/<\/details>/g) ?? []).length, 2, "both close tags survive, none swallowed");
  assert.match(html, /<summary>Outer<\/summary>/);
  assert.match(html, /<summary>Inner<\/summary>/);
  assert.match(html, /<p>text body here<\/p>/);
});

test("a details block with no matching close is kept raw to end of input (swallow-tail)", () => {
  const block = "<details>\n<summary>truncated</summary>\n\nsome content without a close";
  const html = renderMarkdown(block);
  assert.match(html, /some content without a close/, "the tail content is retained");
  assert.doesNotMatch(html, /<p>/, "the unterminated block is not partially rendered");
});
