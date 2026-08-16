/**
 * Does the report tell the reader what to DO? Reports state current behaviour and current problems; advice
 * is out of contract.
 *
 * A plain word list cannot answer that, because the contract makes authors WRITE about advice in order to
 * disclaim it. `product-overview.md` §9 says "Do not include remediation", so a §9 lead-in naturally reads
 * `…优先级与置信度。不给出修复建议。` — and a `/修复建议/` match reported that sentence as the violation it
 * announces the absence of. Measured on a real run: the author had to reword the disclaimer, which then
 * became a new substantive paragraph needing its own claim, and ended up folded into the previous sentence.
 * The engine taught the author to stop disclaiming rather than to stop advising.
 *
 * So a match is a violation only when nothing NEGATES it. The negator has to be close by and on the left:
 * `不给出修复建议` disclaims, `修复建议不多` does not.
 */

/** Advice vocabulary. Matching one of these is necessary for a violation, never sufficient. */
const ADVICE_PATTERNS: RegExp[] = [
  /修复建议/g,
  /改进建议/g,
  /解决方案/g,
  /推荐采用/g,
  /recommendation/gi,
  /should fix/gi,
  /we recommend/gi,
];

/**
 * Negation, as a position rather than a shape.
 *
 * Enumerating negated verb forms is the wrong move and I tried it first: a list like
 * `[不未无勿]\s*[给提包含涉及做出]{0,4}` silently misses `未提供` (供 was not in the class) and
 * `does not include` (17 characters, past any short window). Both were caught only by testing the real
 * wordings a report actually uses.
 *
 * So the rule is structural: a negator somewhere in the window to the left, with NO sentence terminator
 * between it and the advice word. `不给出修复建议` and `does not include recommendations` qualify;
 * `不属于本次范围。修复建议见附录` does not, because the full stop ends the negator's reach.
 */
const NEGATOR = /(?:[不未无勿非]|\bnot\b|\bno\b|\bwithout\b|\bnever\b)/gi;
const SENTENCE_END = /[。！？；.!?;]/;

/** How far left of a match a negator may sit and still govern it. */
const NEGATION_WINDOW = 24;

/** Whether something in the window negates the advice word that follows it. */
function negated(left: string): boolean {
  const scanner = new RegExp(NEGATOR.source, "gi");
  let last = -1;
  for (let match = scanner.exec(left); match !== null; match = scanner.exec(left)) last = match.index + match[0].length;
  if (last < 0) return false;
  return !SENTENCE_END.test(left.slice(last));
}

export interface AdviceMatch {
  /** The pattern that matched, for the operator-facing message. */
  pattern: string;
  /** The matched text with a little context, so a reader can judge the call without opening the report. */
  excerpt: string;
}

/**
 * Advice mentions that nothing negates. Empty means the report is within contract.
 *
 * Deliberately NOT a whitelist of section lead-ins: a whitelist grants the exemption by POSITION, and the
 * same disclaimer is legitimate anywhere. Negation is what actually distinguishes the two cases, so that is
 * what the check reads.
 */
export function unnegatedAdvice(reportText: string): AdviceMatch[] {
  const found: AdviceMatch[] = [];
  for (const pattern of ADVICE_PATTERNS) {
    // A fresh regex per call: a `g`-flagged pattern reused across calls carries `lastIndex` and would skip
    // matches on the second report it is asked about.
    const scanner = new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g");
    for (let match = scanner.exec(reportText); match !== null; match = scanner.exec(reportText)) {
      const left = reportText.slice(Math.max(0, match.index - NEGATION_WINDOW), match.index);
      if (negated(left)) continue;
      found.push({
        pattern: String(pattern),
        excerpt: reportText.slice(Math.max(0, match.index - 20), match.index + match[0].length + 10).replace(/\s+/g, " ").trim(),
      });
    }
  }
  return found;
}
