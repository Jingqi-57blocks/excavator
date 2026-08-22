/**
 * THE NUMBERED-CHAPTER INVENTORY OF ONE ASSEMBLED DELIVERABLE: which `## <n>. …` chapters it holds, and whether
 * they are exactly `1..N` for the N the run's own requirement rows recorded.
 *
 * WHY IT EXISTS. Every report template says its `##` chapters are the fixed contract — prd-feature.md says it in
 * words ("keep all eleven, in this order, numbered 1..11") and the other four say it by numbering their own
 * headings. Nothing executed it. A real run wrote ELEVEN numbered chapters into a document whose plan recorded TEN
 * requirement rows, and no gate anywhere went red: the extra chapter's prose answered no recorded requirement, so
 * it was content outside the surface the run declares it audited. A contract nobody enforces is worse than either
 * having one or not.
 *
 * WHAT IT REFUSES TO COMPARE: TITLE TEXT. The chapter count and the 1..N numbering are language-independent facts
 * about a deliverable; the titles are written in the run's output language, so machine-comparing them against the
 * English template headings would red every non-English run for being correct. So this file counts and orders, and
 * never reads a title for anything but reporting it back.
 *
 * THE DENOMINATOR IS NOT READ FROM A TEMPLATE FILE. `expected` is handed in by the caller from what THIS RUN
 * recorded, because a template on disk is what the code says today and the requirement rows are what the run
 * committed to. A gate that re-read the template would change its verdict about an archived run every time a
 * heading moved.
 *
 * THE EXTRACTION RULE, stated so it can be argued with:
 *
 *   * A chapter heading is a line that opens a level-two ATX heading — exactly two `#` followed by a space or tab —
 *     whose title then begins with ASCII digits followed by a `.`. `### 1. …` is a sub-heading, not a chapter.
 *   * `## Contents` and `## Companions` are written by the ASSEMBLER itself (`unit-assembly.ts`) and carry no
 *     number, so they fall outside the rule by construction. They are not on a name list — a name list would have
 *     to be kept in step with the assembler, and the day it fell behind, a real chapter would go uncounted.
 *   * A line inside a fenced code block is not a heading. Deliverables carry fenced Mermaid, SQL and Markdown
 *     samples, and a sample that contains `## 3. …` would otherwise be counted as a chapter of the document that
 *     quotes it — a miscount reported as a contract breach, which is the false positive this gate can least afford.
 *
 * IT IS A PURE FUNCTION OF TWO VALUES: the assembled bytes and a count. No path, no I/O, no template, no model.
 */

import { assertNever } from "../base/artifact-result.ts";

export const CHAPTER_INVENTORY_VERSION = "chapter-inventory-v1";

/** One numbered chapter of a deliverable, as the document prints it. */
export interface NumberedChapter {
  /** The integer the heading printed. `## 07. …` reads 7: a leading zero is a spelling, not a different chapter. */
  readonly ordinal: number;
  /** The heading line verbatim, trimmed of surrounding whitespace, so a report can quote what it read. */
  readonly heading: string;
  /** 1-based line number in the assembled document: where an author goes to fix it. */
  readonly line: number;
}

/**
 * What is wrong with one document's chapter set. Two shapes, because they read as two different sentences to the
 * person repairing them, and at most one is ever reported for one document:
 *
 *   * `chapter-count` — the deliverable holds a different NUMBER of chapters than the run recorded requirement
 *     rows for. This is the shape the measured defect had (11 written, 10 recorded).
 *   * `chapter-sequence` — the count is right and the numbering is not `1..N` ascending: a gap (1, 2, 4), a
 *     repeat, or two chapters out of order (1, 3, 2).
 *
 * A wrong count is reported ALONE even though its sequence is also not 1..N, because "you wrote one chapter too
 * many" and "your chapters are misnumbered" are two different repairs and reporting both would ask for one that
 * is not needed.
 */
export type ChapterProblem =
  | {
      readonly shape: "chapter-count";
      readonly found: number;
      readonly expected: number;
      /** The ordinals as written, in document order. Carried so a reader can see WHICH chapter is the extra one. */
      readonly ordinals: readonly number[];
    }
  | {
      readonly shape: "chapter-sequence";
      readonly expected: number;
      /** The ordinals as written, in document order — the sequence that is not `1..N`. */
      readonly ordinals: readonly number[];
    };

export interface ChapterInventory {
  readonly version: typeof CHAPTER_INVENTORY_VERSION;
  /** Every numbered chapter, in document order. */
  readonly chapters: readonly NumberedChapter[];
  /** The count this run recorded requirement rows for. */
  readonly expected: number;
  /** Empty means the chapter set is exactly `1..expected` in ascending order. Never more than one entry. */
  readonly problems: readonly ChapterProblem[];
  /**
   * The line a code fence was opened on and never closed, or null.
   *
   * Reported because it CHANGES WHAT A COUNT MEANS. A renderer runs an unclosed fence to the end of the document,
   * so every heading after it really is code and really is not a chapter — the count is right about what a reader
   * sees. But the repair is one stray backtick, not the missing chapters the count would otherwise send an author
   * looking for, and this class seeds every unit of the document. Naming the fence is the difference between an
   * actionable finding and a whole document re-drafted for the wrong reason.
   */
  readonly unterminatedFenceLine: number | null;
}

/**
 * Exactly two `#`, then a space or tab, then digits, then an enumerator mark. `###` and `##Contents` both fail it.
 *
 * Up to three leading spaces are allowed, because a renderer treats them as a heading and
 * `unit-document-anchors.ts` already reads headings that way. Being stricter here would UNDER-count, and
 * under-counting is the dangerous direction: an extra chapter written with one space of indent would go
 * uncounted and a document with one chapter too many would read as compliant.
 *
 * THREE ENUMERATOR MARKS, not one, and this is the same argument as the title rule. The count is meant to be a
 * language-independent fact, but a document whose output language is Chinese writes `## 1、功能概述` as readily as
 * `## 1. 功能概述`, and `．` is the full-width period an IME produces. Accepting only the ASCII `.` would read a
 * correct Chinese deliverable as having ZERO chapters and seed every one of its units for re-drafting — the
 * false positive this gate can least afford, aimed squarely at the language every fixture and default run uses.
 * It costs nothing in the other direction: this file counts and orders, it never polices how a number is spelled.
 */
const CHAPTER_HEADING = /^[ \t]{0,3}##[ \t]+(\d+)[.．、](.*)$/u;

/** The opening or closing line of a fenced code block: at least three backticks or tildes, indented at most three. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

/**
 * Every numbered chapter heading of a document, in document order.
 *
 * The fence state is tracked by the CommonMark rule that matters here: a fence closes only on the same character
 * and at least as many of them, so a ```` ```mermaid ```` block containing a ``` ``` ```` inside a string does not
 * leave the block early. The info string of an opening fence may not contain the fence character, which is what
 * keeps ```` ``` ```` on the same line from opening and closing at once.
 */
export function numberedChapters(markdown: string): readonly NumberedChapter[] {
  return scanChapters(markdown).chapters;
}

/** The chapters and the fence that was never closed, from one pass over the bytes. */
function scanChapters(markdown: string): { chapters: NumberedChapter[]; unterminatedFenceLine: number | null } {
  const chapters: NumberedChapter[] = [];
  let openedAt: number | null = null;
  let fence: { readonly char: string; readonly length: number } | null = null;
  for (const [index, line] of markdown.split("\n").entries()) {
    const fenced = FENCE.exec(line);
    if (fenced) {
      const marker = fenced[1]!;
      const char = marker[0]!;
      if (fence === null) {
        openedAt = index + 1;
        // A BACKTICK fence's info string may not contain a backtick — that rule is what keeps ```` ``a`` ```` on one
        // line from opening a block. A tilde fence carries no such restriction, and applying it there would leave
        // the block unopened and its contents scanned for headings, which over-counts.
        if (char !== "`" || !fenced[2]!.includes(char)) fence = { char, length: marker.length };
        continue;
      }
      if (char === fence.char && marker.length >= fence.length && fenced[2]!.trim() === "") {
        fence = null;
        openedAt = null;
      }
      continue;
    }
    if (fence !== null) continue;
    const heading = CHAPTER_HEADING.exec(line);
    if (!heading) continue;
    chapters.push({ ordinal: Number.parseInt(heading[1]!, 10), heading: line.trim(), line: index + 1 });
  }
  return { chapters, unterminatedFenceLine: fence === null ? null : openedAt };
}

/**
 * The inventory of one assembled deliverable against the number of chapters this run recorded for it.
 *
 * A non-positive or non-integer `expected` is refused rather than checked against: every template this engine
 * ships has at least one level-two section and `materializeBoundRunContract` mints one requirement row per
 * section, so a document with no recorded row is a broken run, and silently reporting "0 chapters is correct"
 * would turn that into a document nothing checks.
 */
export function chapterInventory(markdown: string, expected: number): ChapterInventory {
  if (!Number.isInteger(expected) || expected < 1) {
    throw new Error(`A deliverable's chapter contract needs the number of chapters this run recorded for it; ${JSON.stringify(expected)} is not a positive whole number, so there is no contract to check against`);
  }
  const { chapters, unterminatedFenceLine } = scanChapters(markdown);
  const ordinals = chapters.map((chapter) => chapter.ordinal);
  const problems: ChapterProblem[] = [];
  if (ordinals.length !== expected) {
    problems.push({ shape: "chapter-count", found: ordinals.length, expected, ordinals });
  } else if (ordinals.some((ordinal, index) => ordinal !== index + 1)) {
    problems.push({ shape: "chapter-sequence", expected, ordinals });
  }
  return { version: CHAPTER_INVENTORY_VERSION, chapters, expected, problems, unterminatedFenceLine };
}

/** The sentence one problem prints, naming the document it is about. Exhaustive over the two shapes. */
export function describeChapterProblem(problem: ChapterProblem, documentId: string): string {
  switch (problem.shape) {
    case "chapter-count":
      return `document ${documentId} writes ${problem.found} numbered chapter(s) (${renderOrdinals(problem.ordinals)}) and this run recorded ${problem.expected} requirement row(s) for it; the chapter set is the run's declared answer surface, so a chapter with no requirement row is prose nothing audited and a missing chapter is a recorded question the deliverable never reaches`;
    case "chapter-sequence":
      return `document ${documentId} numbers its ${problem.expected} chapter(s) ${renderOrdinals(problem.ordinals)} rather than 1..${problem.expected} in ascending order; the numbering is the reader's index into the deliverable and a gap, a repeat or a swap makes it point at the wrong chapter`;
  }
  return assertNever(problem, "chapter problem shape");
}

/**
 * The sentence to append when an unclosed fence is what swallowed the rest of the document, or null.
 *
 * Kept apart from `describeChapterProblem` because it is a statement about the BYTES, not about the contract: the
 * contract was still broken, and this says what most likely broke it.
 */
export function unterminatedFenceClause(inventory: ChapterInventory): string | null {
  if (inventory.unterminatedFenceLine === null) return null;
  return `a code fence opened on line ${inventory.unterminatedFenceLine} of the assembled document is never closed, so a renderer shows everything after it as code and no heading past that line counts as a chapter; closing that fence is likely the whole repair`;
}

/** The observed ordinals as a readable list, or a named empty so "()" never reads as a rendering bug. */
function renderOrdinals(ordinals: readonly number[]): string {
  return ordinals.length === 0 ? "none" : ordinals.join(", ");
}
