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
 * A table rather than four inline regexes because it now has two readers — `markersIn` below and the folding
 * pattern this module exports — and four inline literals cannot be widened in one place. The word patterns are
 * COMPILED ONCE beside it: building them inside `markersIn` recompiled four regexes on every call, and
 * interpolating a key raw would let a future token carrying a regex metacharacter (`c++`, `a.b`) throw at call
 * time and take down every marker check instead of merely failing to match.
 */
const ENGLISH_MARKER_WORDS: Record<string, EvidenceMarker> = {
  fact: "fact",
  verified: "verified",
  inferred: "inferred",
  unavailable: "unavailable",
};

/** `\b`-anchored one per English word, escaped and compiled once. Bare words, as they always were. */
const ENGLISH_MARKER_PATTERNS: readonly (readonly [RegExp, EvidenceMarker])[] =
  Object.entries(ENGLISH_MARKER_WORDS).map(([word, level]) => [new RegExp(`\\b${escapeForRegExp(word)}\\b`, "i"), level] as const);

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * WHICH RECOGNISED TOKENS THE FOLD REMOVES, AND WHICH IT DELIBERATELY LEAVES STANDING (57B-494).
 *
 * TWO QUESTIONS, ONE VOCABULARY, AND THEY DO NOT HAVE THE SAME ANSWER. `markersIn` asks "does this prose carry
 * an evidence level" over all eight tokens. `foldUnitText` (`unit-claim-binding.ts`) has to REMOVE the token
 * before comparing prose against a claim statement, and it removes only four — so `` `已验证` `` is recognised
 * as an evidence level and folded as ORDINARY PROSE. That asymmetry is REAL AND IT IS LEFT ALONE HERE. Measured
 * on the real command: making the fold strip all eight flips a unit whose claim statement swallowed
 * `` `已验证` `` from `complete` to `violations`, which is a change of FOLDING GENERATION, and
 * `unit-claim-binding.ts`'s header states the law for that — prior unit products become a second generation and
 * the per-generation judgement has to be rebuilt with it. Unit products live in arbitrary target run dirs that
 * `audit --units` is pointed at, so the population is NOT bounded by this repository, and this repository's own
 * `tests/evidence-marker-vocabulary.test.ts` records why it is probably not empty: a real zh-CN run wrote
 * `` `已验证` `` and `` `不可用` `` in good faith. Unifying the two sets is therefore a decision with a
 * migration attached, not a tidy-up, and it is not taken here.
 *
 * WHAT IS FIXED INSTEAD IS THE SILENT PART. The hazard was never today's asymmetry — both halves of the fold
 * agree with each other, so no segment goes missing from its own unit. It was that WIDENING THE VOCABULARY MOVED
 * ONLY THE RECOGNITION, with nothing able to see it. So the split is now DECLARED rather than implied: every
 * token of `MARKER_TOKENS` must appear in exactly one of these two lists, and
 * `tests/evidence-marker-vocabulary.test.ts` asserts that partition is total and that each token's real folding
 * behaviour matches the list it is in. A ninth synonym added to the vocabulary belongs to neither list and goes
 * RED until somebody decides which — which is what "widening has to pass the fold as well as the check" buys
 * without a migration.
 */
export const MARKER_FOLDING: {
  readonly folded: readonly string[];
  readonly unfolded: readonly string[];
} = {
  folded: ["事实", "验证", "推断", "不可得"],
  unfolded: ["已验证", "已推断", "不可用", "无法获得"],
};

/**
 * THE ONE PATTERN FOR "THIS IS A BACKTICKED MARKER TOKEN THE FOLD REMOVES" — derived from `MARKER_FOLDING`
 * rather than spelled again at its consumer, which is the whole of what 57B-494 changed here.
 *
 * LONGEST TOKEN FIRST. Alternation is first-match and `验证` is a prefix of `已验证`; the backticks make a
 * short-token match impossible in practice, but ordering by length removes the dependence on that argument.
 *
 * `g` AND `replace` ONLY. A global regex carries `lastIndex`, which `String.prototype.replace` resets and
 * `RegExp.prototype.test` does not. Every consumer of this export replaces with it; none tests with it. Ask
 * "does this prose carry a marker" through `markersIn`/`hasEvidenceMarkers`, which is the reader that answers it.
 */
export const EVIDENCE_MARKER_TOKEN_PATTERN: RegExp = new RegExp(
  `\`(?:${[...MARKER_FOLDING.folded, ...Object.keys(ENGLISH_MARKER_WORDS)]
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegExp)
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
  for (const [pattern, level] of ENGLISH_MARKER_PATTERNS) {
    if (pattern.test(text)) markers.add(level);
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
