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
export function visibleText(section: string): string {
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

export function markersIn(text: string): Set<EvidenceMarker> {
  const markers = new Set<EvidenceMarker>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const level = MARKER_TOKENS[match[1].trim()];
    if (level) markers.add(level);
  }
  // English markers stay bare words, as they always were — changing that would move existing runs.
  if (/\bfact\b/i.test(text)) markers.add("fact");
  if (/\bverified\b/i.test(text)) markers.add("verified");
  if (/\binferred\b/i.test(text)) markers.add("inferred");
  if (/\bunavailable\b/i.test(text)) markers.add("unavailable");
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
