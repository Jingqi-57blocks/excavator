/**
 * THE EVIDENCE-MARKER VOCABULARY, AND THE READING SURFACE IT IS READ OVER.
 *
 * Moved out of `section-audit.ts` whole (57B-481) because it has a consumer that outlives the section path:
 * `unit-claim-binding.ts` routes its own marker check through `hasEvidenceMarkers`. Grep-verified when this file
 * was written — `git grep -n "from \"./section-audit.ts\"" -- src` returned three importers, and this is the
 * symbol the unit path takes.
 *
 * THE VOCABULARY HAS ONE READER, AND KEEPING IT THAT WAY IS THE POINT. 491's header states the rule: every check
 * that asks "does this prose carry an evidence level" must route through `markersIn`, so the section and unit
 * paths cannot drift onto two answers. A second spelling of the token list is the drift; importing this one is
 * the fix. `tests/evidence-marker-vocabulary.test.ts` pins `MARKER_TOKENS` against `markersIn` BIDIRECTIONALLY,
 * which is what makes "one reader" checkable rather than asserted.
 *
 * `visibleText` travels with it rather than staying behind: the rule is "over the text a reader actually sees",
 * and a marker check that read collapsed evidence blocks or fenced code would answer a different question.
 */

import type { EvidenceMarker } from "../base/types.ts";

/** The visible reading surface of a section: no collapsed evidence blocks, no fenced code, no HTML comments. */
function visibleText(section: string): string {
  return section
    .replace(/<details[\s\S]*?<\/details>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
}

/**
 * The localized marker vocabulary, as whole backticked tokens.
 *
 * `writing-rules.md` tells authors to "render these semantic markers naturally … in the requested output
 * language", while this function accepted exactly four Chinese strings — so an author following the contract
 * wrote `` `已验证` `` or `` `不可用` `` and the chapter was reported as having no marker at all. Measured on a
 * real Chinese run: `` `不可得` `` was the only accepted way to say "unavailable", which reads badly, and the
 * accepted set appeared in no document.
 *
 * Matched as COMPLETE tokens rather than substrings: `` `验证服务` `` is a component name, not a marker, and a
 * substring rule would read it as one. Adding a synonym means adding it here AND to `writing-rules.md`,
 * which is the honest state — the deeper fix is one vocabulary both the doc and the code read.
 */
export const MARKER_TOKENS: Record<string, EvidenceMarker> = {
  "事实": "fact",
  "验证": "verified",
  "已验证": "verified",
  "推断": "inferred",
  "已推断": "inferred",
  "不可得": "unavailable",
  "不可用": "unavailable",
  "无法获得": "unavailable",
};

/**
 * The English half of the same vocabulary, which `references/evidence-markers.json` lists under `en-US`.
 *
 * It is a table rather than four inline regexes because it now has TWO readers — `markersIn` below, and the
 * folding pattern this module exports — and four inline literals cannot be widened in one place.
 */
const ENGLISH_MARKER_WORDS: Record<string, EvidenceMarker> = {
  fact: "fact",
  verified: "verified",
  inferred: "inferred",
  unavailable: "unavailable",
};

/**
 * THE ONE PATTERN FOR "THIS IS A BACKTICKED EVIDENCE-LEVEL MARKER", derived from the vocabulary above rather
 * than spelled a second time.
 *
 * WHY IT LIVES HERE AND NOT AT ITS CONSUMER (57B-494). `unit-claim-binding.ts` folds prose and claim statements
 * into one comparable form, and folding has to REMOVE the marker token — a claim statement never repeats the
 * author's `` `事实` ``. Until this export existed it carried its own literal of four Chinese tokens while
 * `MARKER_TOKENS` here listed eight, so the two halves of the marker rule answered different questions about
 * `` `已验证` ``: recognised as an evidence level by `markersIn`, folded as ordinary prose by the comparator.
 * Both halves were internally consistent, so nothing bound wrongly — but widening the vocabulary would have
 * moved only one of them, which is a drift with no test able to see it. Deriving the pattern makes the widening
 * atomic: A TOKEN ADDED TO `MARKER_TOKENS` (or to `ENGLISH_MARKER_WORDS`) IS RECOGNISED AND FOLDED IN THE SAME
 * EDIT. `tests/evidence-marker-vocabulary.test.ts` falsifies this by widening a copy of the table and checking
 * both halves move together.
 *
 * LONGEST TOKEN FIRST. Alternation is first-match, and `验证` is a prefix of `已验证`; the backticks make a
 * short-token match impossible in practice, but ordering by length removes the dependence on that argument.
 *
 * `g` AND `replace` ONLY. A global regex carries `lastIndex`, which `String.prototype.replace` resets and
 * `RegExp.prototype.test` does not. Every consumer of this export replaces with it; none tests with it. Ask
 * "does this prose carry a marker" through `markersIn`/`hasEvidenceMarkers`, which is the reader that answers it.
 */
export const EVIDENCE_MARKER_TOKEN_PATTERN: RegExp = new RegExp(
  `\`(?:${[...Object.keys(MARKER_TOKENS), ...Object.keys(ENGLISH_MARKER_WORDS)]
    .sort((a, b) => b.length - a.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\``,
  "gi",
);

export function markersIn(text: string): Set<EvidenceMarker> {
  const markers = new Set<EvidenceMarker>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const level = MARKER_TOKENS[match[1].trim()];
    if (level) markers.add(level);
  }
  // English markers stay bare words, as they always were — changing that would move existing runs.
  for (const [word, level] of Object.entries(ENGLISH_MARKER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) markers.add(level);
  }
  return markers;
}

/**
 * The one rule for "does this prose carry an evidence-level marker". Document- and section-level
 * checks both route through `markersIn` over `visibleText`, so they cannot drift onto different rules:
 * a bare backtick-free word like an incidental "事实" in prose is not a marker, only a real
 * `事实`/`验证`/`推断`/`不可得` (or the English marker words the paragraph audit already accepts) is.
 */
export function hasEvidenceMarkers(text: string): boolean {
  return markersIn(visibleText(text)).size > 0;
}
