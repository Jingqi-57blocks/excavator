/**
 * Blank out JavaScript comments while keeping every byte offset intact.
 *
 * The Sequelize parsers recover schema facts by scanning source TEXT, and text does not know what is code.
 * Sequelize's own `migration-skeleton` ships this in every generated file:
 *
 *     /*
 *       Example:
 *       return queryInterface.createTable('users', { id: Sequelize.INTEGER });
 *     *\/
 *
 * A scanner that reads calls straight out of the raw source takes that example as a declaration and invents
 * a table nobody ever created — measured on one real repository: nine migrations carrying the skeleton
 * comment produced a phantom `users` table with a single `id` column, sitting in the report beside 180 real
 * ones with nothing to distinguish it. Guessing which tables "look like" scaffolding is not available to a
 * deterministic extractor; reading only real code is.
 *
 * So the fix is upstream of every pattern: mask first, scan after. Each comment character becomes a space
 * (newlines are kept, so line numbers do not move) and the result has EXACTLY the length of the input —
 * offsets taken from the masked text still index the original, which is what lets the caller keep resolving
 * lines against a LineMap built on the real content.
 *
 * String literals are preserved verbatim, and are skipped BEFORE comment detection: `'http://x'` and
 * `"/* not a comment *\/"` contain comment openers that are not comment openers. That ordering is the whole
 * correctness argument — a masker that scanned for `//` first would eat the rest of every URL-bearing line.
 *
 * NOTE — deliberately NOT applied to the layer-ordering checker (57B-419), which reads comments on purpose:
 * there, a relative specifier appearing in a comment means the instrument is broken and must go red. Two
 * different jobs: this one must understand the code, that one must not be fooled into thinking it does.
 */

import { skipJsString } from "./js-scan.ts";

/**
 * Return `source` with every line/block comment replaced by spaces (newlines kept), preserving length,
 * offsets, and all string literals.
 */
export function maskJsComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "'" || c === '"' || c === "`") {
      const end = skipJsString(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      const end = endOfComment(source, i);
      out += blank(source.slice(i, end));
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** `s[i]` opens a comment; return the index just past it (an unterminated comment runs to end of input). */
function endOfComment(s: string, i: number): number {
  if (s[i + 1] === "/") {
    i += 2;
    while (i < s.length && s[i] !== "\n") i++;
    return i;
  }
  i += 2;
  while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
  return Math.min(i + 2, s.length);
}

/** Same length, same newlines, no content. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}
