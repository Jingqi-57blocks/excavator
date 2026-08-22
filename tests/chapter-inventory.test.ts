/**
 * THE NUMBERED-CHAPTER INVENTORY (`src/report/chapter-inventory.ts`), over values.
 *
 * WHAT IS PROVED HERE AND WHAT IS NOT. This file is about the extraction rule and the four ways a chapter set can
 * fail — each with a fixture built to be red, because a rule nobody has seen go red is a rule nobody has tested.
 * `tests/unit-consistency.test.ts` proves the class is wired and reports findings that name units;
 * `tests/unit-consistency-e2e.test.ts` and `eval/tests/unit-consistency-readings.test.ts` prove a real assembled
 * run reaches it with the count taken from the run's own recorded requirement rows.
 *
 * THE GREEN CASE IS ASSERTED, not implied. A gate with several exits and no assertion that it stays silent on a
 * correct document is a gate nobody has shown does not misfire, and this one runs over EVERY planned document of
 * every run — the cost of a false positive is a whole document redrawn for nothing.
 *
 * TITLE TEXT IS NEVER COMPARED, and that is asserted too: the same chapter set written in Chinese and in English
 * has to read identically to this file, or every non-English run would go red for being correct.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAPTER_INVENTORY_VERSION,
  chapterInventory,
  describeChapterProblem,
  numberedChapters
} from "../src/report/chapter-inventory.ts";

/** A document body with one heading per ordinal, in the order given. */
function body(ordinals: readonly number[], title = "章"): string {
  return ordinals.map((ordinal) => `## ${ordinal}. ${title}${ordinal}\n\n正文。\n`).join("\n");
}

// --- the extraction rule ------------------------------------------------------------------------------------

test("a numbered chapter is a level-two heading whose title opens with digits and a period", () => {
  const chapters = numberedChapters("## 1. 概述\n\n## 2. 规则\n");
  assert.deepEqual(chapters.map((chapter) => chapter.ordinal), [1, 2]);
  assert.deepEqual(chapters.map((chapter) => chapter.heading), ["## 1. 概述", "## 2. 规则"]);
  assert.deepEqual(chapters.map((chapter) => chapter.line), [1, 3]);
});

test("the assembler's own Contents and Companions headings carry no number and are not chapters", () => {
  // They are excluded BY THE RULE, not by a name list: a list would have to be kept in step with
  // `unit-assembly.ts`, and the day it fell behind a real chapter would go uncounted.
  const markdown = "## Contents\n\n| # | unit |\n\n## Companions\n\n| companion | path |\n\n## 1. 概述\n";
  assert.deepEqual(numberedChapters(markdown).map((chapter) => chapter.ordinal), [1]);
});

test("a sub-heading and an unnumbered heading are not chapters", () => {
  assert.deepEqual(numberedChapters("### 1. 子节\n#### 2. 更深\n## 概述\n#1. 一级\n"), []);
});

test("a heading inside a fenced code block is not a chapter, for either fence character", () => {
  // A deliverable quotes Markdown, Mermaid and SQL. Counting a sample's headings would report the document that
  // quotes them as breaking a contract it keeps — the false positive this gate can least afford.
  const fenced = "## 1. 概述\n\n```markdown\n## 2. 这是示例\n```\n\n~~~\n## 3. 也是示例\n~~~\n\n## 2. 规则\n";
  assert.deepEqual(numberedChapters(fenced).map((chapter) => chapter.ordinal), [1, 2]);
});

test("a longer closing fence closes, a shorter run inside does not, and an unclosed fence swallows the rest", () => {
  const nested = "````\n```\n## 9. 里面\n```\n````\n\n## 1. 概述\n";
  assert.deepEqual(numberedChapters(nested).map((chapter) => chapter.ordinal), [1]);
  assert.deepEqual(numberedChapters("```\n## 9. 未闭合\n").map((chapter) => chapter.ordinal), []);
});

test("up to three leading spaces still make a heading, because under-counting is the dangerous direction", () => {
  // A renderer treats them as a heading, so an indented chapter IS a chapter of the deliverable. If it went
  // uncounted, a document with one chapter too many would read as compliant — the exact defect this gate is for.
  assert.deepEqual(numberedChapters("   ## 1. 概述\n  ## 2. 规则\n").map((chapter) => chapter.ordinal), [1, 2]);
  // Four spaces is an indented code block, not a heading, and the anchor module draws the line in the same place.
  assert.deepEqual(numberedChapters("    ## 3. 缩进代码块\n"), []);
});

test("a tilde fence may carry a tilde in its info string, and a backtick fence may not", () => {
  // The restriction is the backtick fence's alone. Applying it to tildes would leave the block unopened and its
  // contents scanned for headings — over-counting, which is the direction that produces false findings.
  assert.deepEqual(numberedChapters("~~~diff~mode\n## 9. 示例\n~~~\n\n## 1. 概述\n").map((chapter) => chapter.ordinal), [1]);
  // `` `a` `` on one line opens nothing, so the heading after it is a real chapter.
  assert.deepEqual(numberedChapters("```a```\n\n## 1. 概述\n").map((chapter) => chapter.ordinal), [1]);
});

test("a leading zero is a spelling of the ordinal, not a different chapter", () => {
  assert.deepEqual(numberedChapters("## 01. 概述\n\n## 002. 规则\n").map((chapter) => chapter.ordinal), [1, 2]);
});

test("a Chinese enumerator mark counts, because the deliverable's output language is usually Chinese", () => {
  // `## 1、功能概述` is how a Chinese document numbers a chapter, and `．` is the full-width period an IME gives.
  // Accepting only the ASCII `.` would read a correct Chinese deliverable as having ZERO chapters and seed every
  // one of its units for re-drafting. The gate counts and orders; it does not police how a number is spelled.
  assert.deepEqual(numberedChapters("## 1、概述\n\n## 2．规则\n\n## 3. 数据\n").map((chapter) => chapter.ordinal), [1, 2, 3]);
  assert.deepEqual(chapterInventory("## 1、概述\n\n## 2、规则\n", 2).problems, []);
  // A mark that is not an enumerator is still not a chapter: `## 2024 年回顾` must not read as chapter 2024.
  assert.deepEqual(numberedChapters("## 2024 年回顾\n"), []);
});

test("the rule reads a chapter set the same way whatever language its titles are in", () => {
  const chinese = chapterInventory(body([1, 2, 3], "章"), 3);
  const english = chapterInventory(body([1, 2, 3], "Chapter "), 3);
  assert.deepEqual(chinese.problems, []);
  assert.deepEqual(english.problems, []);
  assert.deepEqual(chinese.chapters.map((chapter) => chapter.ordinal), english.chapters.map((chapter) => chapter.ordinal));
});

// --- the four failing shapes, each with a red fixture -------------------------------------------------------

test("one chapter more than the run recorded is a count problem", () => {
  // The measured defect: eleven numbered chapters against ten recorded requirement rows, and no gate went red.
  const inventory = chapterInventory(body([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 10);
  assert.equal(inventory.problems.length, 1);
  assert.deepEqual(inventory.problems[0], {
    shape: "chapter-count",
    found: 11,
    expected: 10,
    ordinals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  });
  assert.match(describeChapterProblem(inventory.problems[0]!, "feature-x-prd"), /11 numbered chapter\(s\)/u);
});

test("one chapter fewer than the run recorded is a count problem", () => {
  const inventory = chapterInventory(body([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 11);
  assert.equal(inventory.problems.length, 1);
  assert.equal(inventory.problems[0]!.shape, "chapter-count");
  assert.equal(inventory.problems[0]!.shape === "chapter-count" && inventory.problems[0]!.found, 10);
});

test("chapters out of order are a sequence problem, with the count left alone", () => {
  const inventory = chapterInventory(body([1, 3, 2]), 3);
  assert.deepEqual(inventory.problems, [{ shape: "chapter-sequence", expected: 3, ordinals: [1, 3, 2] }]);
  // Reported as a sequence rather than a count on purpose: the repair is "renumber", not "write another chapter".
  assert.match(describeChapterProblem(inventory.problems[0]!, "feature-x-prd"), /rather than 1\.\.3/u);
});

test("a gap and a repeat are sequence problems too", () => {
  assert.deepEqual(chapterInventory(body([1, 2, 4]), 3).problems, [{ shape: "chapter-sequence", expected: 3, ordinals: [1, 2, 4] }]);
  assert.deepEqual(chapterInventory(body([1, 2, 2]), 3).problems, [{ shape: "chapter-sequence", expected: 3, ordinals: [1, 2, 2] }]);
});

test("a document with no numbered chapter at all is a count problem, never an absence of subject", () => {
  // The cheapest way out of a chapter gate is to write no numbered chapter; if that read as "nothing to check",
  // the gate would have an exit that costs a model nothing to take.
  const inventory = chapterInventory("## 概述\n\n正文。\n", 10);
  assert.equal(inventory.problems.length, 1);
  assert.deepEqual(inventory.chapters, []);
  assert.match(describeChapterProblem(inventory.problems[0]!, "overview-product"), /0 numbered chapter\(s\) \(none\)/u);
});

// --- the green case, and the refusal ------------------------------------------------------------------------

test("a chapter set that is exactly 1..N ascending has no problem at all", () => {
  for (const count of [1, 3, 11, 13]) {
    const ordinals = Array.from({ length: count }, (_unused, index) => index + 1);
    const inventory = chapterInventory(body(ordinals), count);
    assert.deepEqual(inventory.problems, [], `1..${count} must be silent`);
    assert.equal(inventory.version, CHAPTER_INVENTORY_VERSION);
    assert.equal(inventory.expected, count);
    assert.deepEqual(inventory.chapters.map((chapter) => chapter.ordinal), ordinals);
  }
});

test("the assembler's headings beside a correct chapter set stay silent", () => {
  const markdown = `<a id="contents"></a>\n\n## Contents\n\n## Companions\n\n${body([1, 2])}`;
  assert.deepEqual(chapterInventory(markdown, 2).problems, []);
});

test("a count no planned document can have is refused rather than checked against", () => {
  // A document with no recorded requirement row is a broken run; reporting "0 chapters is correct" would turn it
  // into a document nothing checks.
  for (const expected of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => chapterInventory(body([1]), expected), /not a positive whole number/u, `expected ${expected}`);
  }
});
