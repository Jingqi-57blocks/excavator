/**
 * WHAT AN ASSEMBLED DOCUMENT CAN RESOLVE, and what it holds twice — read off the document's own bytes.
 *
 * WHY IT IS READ FROM THE BYTES AND NOT DERIVED FROM THE PLAN. R7b's assembly emits an explicit `<a id>` per unit
 * and one for the contents table, and its own test asserts that every link IT writes points at one of them. That
 * test is true of the renderer and NOT true of the document: a unit's prose is model content, so a `](#…)` a model
 * wrote and a `<a id="contents">` a model wrote are both in the deliverable and neither was ever resolved against
 * anything. Deriving the anchor set from the plan instead would reproduce the same blind spot one level over —
 * the set would hold exactly what the assembler meant to emit, which is the thing already known to be fine.
 *
 * THE RESOLVABLE SET IS THE UNION OF TWO CONVENTIONS, and both are named because one of them is a renderer's:
 *
 *   1. EXPLICIT anchors — every `<a id="…">` in the document, whoever wrote it. Unambiguous.
 *   2. HEADING slugs — the GitHub-style slug of every ATX heading. This is a CONVENTION, not a guarantee, and
 *      `unit-assembly.ts` says so in as many words, which is why it emits explicit anchors for its own links. But
 *      a reader's renderer does resolve them, so a model writing `[see below](#current-behaviour)` beside a
 *      `## Current behaviour` has written a link that works. Leaving slugs out of the set would report that link
 *      as dangling, and a repair set is required to be exact — a false row costs a unit being redrawn for nothing.
 *
 * The slug rule is stated here rather than imported from a renderer: lowercase, drop everything that is not a
 * letter, a digit, a space, `_` or `-`, then spaces to `-`. Repeated slugs take `-1`, `-2` … the way a slugger
 * does, so a document with two `## Contents` headings still resolves `#contents-1`.
 *
 * DUPLICATES ARE COUNTED OVER THE EXPLICIT ANCHORS ONLY. A heading whose slug equals an explicit anchor is normal
 * and intended — `## Contents` sits directly under the `<a id="contents">` the assembler emitted — so folding the
 * two conventions together would report the assembler's own document as broken. What is NOT normal is one id
 * emitted twice: every link to it lands on the first, and which one that is depends on where a unit was placed in
 * the plan's order.
 */

/** Every anchor and reference one assembled document holds. Ascending, and every list is complete — never capped. */
export interface DocumentAnchorReading {
  /** Every `<a id="…">` id in document order, including repeats: the duplicate account is built from this. */
  readonly explicitAnchorIds: readonly string[];
  /** Explicit ids that appear more than once, ascending. */
  readonly duplicateAnchorIds: readonly string[];
  /** Every id a reader's renderer can reach: explicit anchors plus heading slugs. */
  readonly resolvable: ReadonlySet<string>;
}

const EXPLICIT_ANCHOR = /<a\s+id="([^"]*)"/gi;
const ATX_HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
const ANCHOR_LINK = /\]\(#([^)\s]*)\)/g;

/** The slug a markdown renderer gives one heading's text. Deterministic and total; see the file header. */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Every `<a id="…">` id in one markdown text, in document order and including repeats. */
export function explicitAnchorIds(markdown: string): readonly string[] {
  return [...markdown.matchAll(new RegExp(EXPLICIT_ANCHOR.source, EXPLICIT_ANCHOR.flags))].map((match) => match[1]!);
}

/** Every `](#target)` reference in one markdown text, in document order and including repeats. */
export function anchorReferences(markdown: string): readonly string[] {
  return [...markdown.matchAll(new RegExp(ANCHOR_LINK.source, ANCHOR_LINK.flags))].map((match) => match[1]!);
}

/** The anchor reading of one assembled document. */
export function readDocumentAnchors(markdown: string): DocumentAnchorReading {
  const explicit = explicitAnchorIds(markdown);
  const counts = new Map<string, number>();
  for (const id of explicit) counts.set(id, (counts.get(id) ?? 0) + 1);
  const resolvable = new Set<string>(explicit);
  const slugCounts = new Map<string, number>();
  for (const match of markdown.matchAll(new RegExp(ATX_HEADING.source, ATX_HEADING.flags))) {
    const slug = headingSlug(match[2]!);
    if (slug === "") continue;
    const seen = slugCounts.get(slug) ?? 0;
    slugCounts.set(slug, seen + 1);
    resolvable.add(seen === 0 ? slug : `${slug}-${seen}`);
  }
  return {
    explicitAnchorIds: explicit,
    duplicateAnchorIds: [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(),
    resolvable
  };
}
