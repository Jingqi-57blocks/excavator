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
 *
 * CODE IS EXCLUDED FROM WHAT IS HARVESTED AND KEPT IN WHAT IS RESOLVABLE, and the asymmetry is each side's safe
 * direction. An anchor or a link inside a fence is literal text a renderer prints: it emits no anchor and nobody
 * follows it, so counting it would report a unit that documents markdown syntax as defective and put it — and every
 * ancestor — in a repair set. Keeping those ids in the RESOLVABLE set can only ever make one fewer finding, which is
 * the direction an exact repair set wants.
 */

/** Every anchor and reference one assembled document holds. Ascending, and every list is complete — never capped. */
export interface DocumentAnchorReading {
  /**
   * Every `<a id="…">` id OUTSIDE code, in document order and including repeats: the duplicate account is this.
   *
   * Code is excluded here because an anchor inside a fence is literal text a renderer prints — it emits no anchor,
   * so it cannot make one a duplicate. The resolvable set below keeps them, for the same reason it keeps heading
   * slugs: too large is the safe direction there, and too small is the safe direction here.
   */
  readonly explicitAnchorIds: readonly string[];
  /** Explicit ids that appear more than once, ascending. */
  readonly duplicateAnchorIds: readonly string[];
  /** Every id a reader's renderer can reach: explicit anchors plus heading slugs. */
  readonly resolvable: ReadonlySet<string>;
}

const EXPLICIT_ANCHOR = /<a\s+id="([^"]*)"/gi;
const ATX_HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
/** A markdown anchor link, with the optional title a link may carry: `](#target)` and `](#target "why")`. */
const ANCHOR_LINK = /\]\(#([^)\s]*)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g;
/**
 * A fenced code block: three or more backticks or tildes, to the matching fence or the end of the text.
 *
 * The fallback is `$(?![\s\S])` — the end of the INPUT — and not a bare `$`. Under the `m` flag a bare `$` matches
 * at every line end, so the lazy body matched nothing at all and an unclosed fence swallowed only its own opening
 * line. Measured: an anchor inside a closed fence survived the strip.
 */
const FENCED_CODE = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*$|$(?![\s\S]))/gm;
/** An inline code span. Backtick runs of any length, matched pairwise, so `` `a` `` and ```` ``a`` ```` both go. */
const INLINE_CODE = /(`+)(?:[^`]|(?!\1)`)*\1/g;

/**
 * The slug a markdown renderer gives one heading's text. Deterministic and total; see the file header.
 *
 * One space becomes one hyphen, which is what a slugger does: `## A & B` loses the `&` and keeps both spaces, so
 * the id is `a--b`. `headingSlugVariants` also offers the whitespace-COLLAPSED form, because renderers differ on
 * exactly that and the resolvable set may only ever be too large — a link a reader's renderer resolves must not be
 * reported as a repair.
 */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/** Both slug spellings of one heading, distinct: one hyphen per space, and whitespace runs collapsed to one. */
export function headingSlugVariants(text: string): readonly string[] {
  const spaced = headingSlug(text);
  return [...new Set([spaced, spaced.replace(/-+/g, "-")])];
}

/**
 * The prose of one markdown text with its code removed — fenced blocks and inline spans replaced by blanks.
 *
 * WHY IT IS ONLY USED ON THE HARVEST SIDE. A unit documenting markdown syntax inside a fence writes a literal
 * `[see](#some-anchor)` that no reader ever follows, and reporting it would put that unit and every ancestor into a
 * repair set for nothing — a repair set is required to be EXACT. The resolvable set, by contrast, is deliberately
 * left over-large (see the file header), so stripping code there could only ever turn a working link into a
 * finding. The asymmetry is the safe direction of each.
 *
 * Replacement is by spaces of the same length, so offsets into the original text stay valid for an excerpt.
 */
export function withoutCode(markdown: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, " ");
  return markdown
    .replace(new RegExp(FENCED_CODE.source, FENCED_CODE.flags), blank)
    .replace(new RegExp(INLINE_CODE.source, INLINE_CODE.flags), blank);
}

/**
 * Every `<a id="…">` id in one markdown text, in document order and including repeats.
 *
 * `insideCode: "excluded"` is for the harvest side — an anchor a unit shows inside a fence is an example, not an
 * emitted anchor — and `"included"` is for reading a whole assembled document, where the duplicate account has to
 * see every id a renderer would emit.
 */
export function explicitAnchorIds(markdown: string, insideCode: "included" | "excluded" = "included"): readonly string[] {
  const text = insideCode === "excluded" ? withoutCode(markdown) : markdown;
  return [...text.matchAll(new RegExp(EXPLICIT_ANCHOR.source, EXPLICIT_ANCHOR.flags))].map((match) => match[1]!);
}

/** Every `](#target)` reference in one markdown text, in document order and including repeats. */
export function anchorReferences(markdown: string, insideCode: "included" | "excluded" = "included"): readonly string[] {
  const text = insideCode === "excluded" ? withoutCode(markdown) : markdown;
  return [...text.matchAll(new RegExp(ANCHOR_LINK.source, ANCHOR_LINK.flags))].map((match) => match[1]!);
}

/** The anchor reading of one assembled document. */
export function readDocumentAnchors(markdown: string): DocumentAnchorReading {
  const explicit = explicitAnchorIds(markdown, "excluded");
  const counts = new Map<string, number>();
  for (const id of explicit) counts.set(id, (counts.get(id) ?? 0) + 1);
  // The resolvable set keeps the ones inside code too: over-large is its safe direction (see the file header).
  const resolvable = new Set<string>(explicitAnchorIds(markdown, "included"));
  const slugCounts = new Map<string, number>();
  for (const match of markdown.matchAll(new RegExp(ATX_HEADING.source, ATX_HEADING.flags))) {
    for (const slug of headingSlugVariants(match[2]!)) {
      if (slug === "") continue;
      const seen = slugCounts.get(slug) ?? 0;
      slugCounts.set(slug, seen + 1);
      // The `-N` suffix a slugger appends to a repeated heading, so `#contents-1` resolves in a document with two
      // `## Contents` headings.
      resolvable.add(seen === 0 ? slug : `${slug}-${seen}`);
    }
  }
  return {
    explicitAnchorIds: explicit,
    duplicateAnchorIds: [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(),
    resolvable
  };
}
