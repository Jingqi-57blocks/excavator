import type { AuditFinding } from "./assurance.ts";
import type { EvidenceItem, SearchReceipt, SectionClaim } from "./types.ts";

/**
 * Receipt-support faithfulness for claims that cite a SEARCH receipt. The base audit proves each cited
 * evidence item EXISTS, matches its digest, and is bound to the section — but not that a cited SEARCH
 * receipt's CONTENT supports the claim's count language. The cebreo run (docs/findings/2026-08-06) cited
 * two zero-match receipts as proof of "136 处命中" / "1068 个声明" and audited clean; this closes that gap.
 *
 * Core makes zero model calls, so support can only be APPROXIMATED mechanically. Three rules do that:
 *   1. Rule A (version-gated error): a statement that states a match-context count against a cited
 *      SEARCH receipt must be provable from that receipt — an exact count equals a complete receipt's
 *      match total (or the sum across every cited complete receipt), a lower bound stays within what the
 *      receipts provably cover, and upper-bound / approximate wording is only ever nudged. Because it is
 *      a tightening, it is a hard error only for runs prepared under the current assurance version and a
 *      warning for grandfathered runs.
 *   2. Rule B (advisory warning): a `verified`/`fact` claim that cites only zero-match receipts but whose
 *      statement reports neither a negative finding nor a match count is flagged so the author states the
 *      negative result explicitly.
 *   3. Rule A2 (advisory warning): a claim whose evidence is entirely SEARCH yet asserts an item count
 *      (个/条/项) — which a match-line receipt cannot establish — is nudged toward better-grounded evidence.
 * Every wordlist is framework-independent: only generic quantity / negation words, no domain terms.
 */

/** A count mentioned in match context, with the qualifier its surrounding words imply. */
export interface MatchCountMention {
  value: number;
  qualifier: "exact" | "lower" | "upper" | "approximate";
  raw: string;
}

// Match-context anchors: a number adjacent to 处 (not 处理/处置/处于), to 命中 within a few chars, or to an
// English match/hit/occurrence noun. The `d` flag exposes the capture group's absolute offset so the
// qualifier window can be read from the original string. `\+?` lets an inline "122+ matches" count.
const MATCH_CONTEXT_PATTERNS: RegExp[] = [
  /(\d[\d,]*)\s*处(?!理|置|于)/dg,
  /命中[^\d\n]{0,4}(\d[\d,]*)/dg,
  /(\d[\d,]*)[^\d\n]{0,4}命中/dg,
  /(\d[\d,]*)\+?\s+(?:match(?:es)?|hits?|occurrences?)\b/dig
];

// An item count (个/条/项) is NOT a match-context count: a match-line receipt never establishes it.
const ITEM_COUNT_PATTERN = /(\d[\d,]*)\s*[个条项]/g;

// Qualifier wordlists over the ±window around a number. English tokens are word-bounded to avoid
// matching inside longer words (e.g. "over" inside "recover"); CJK tokens need no boundary.
// `(?<!不)` so "不超过"/"不多于" (upper bounds) are not caught by the lower-bound 超过/多于.
const LOWER_BOUND = /不少于|至少|(?<!不)超过|(?<!不)多于|逾|以上|或更多|\+|\bat least\b|\bmore than\b|\bover\b|\bno fewer than\b|\bexceed\b/i;
const UPPER_BOUND = /至多|不超过|以内|\bat most\b|\bfewer than\b|\bunder\b/i;
const APPROXIMATE = /约|大约|\bapproximately\b|\broughly\b|~/i;

// Negation wordlist for Rule B: a statement that honestly reports "nothing found". Two-character/phrase
// forms only (无命中, not bare 无) so an honest negation like "该服务无状态" is not misread as a hit claim
// — the 57B-358 lesson. Positive/negative controls live in tests/claim-receipt-support.test.ts.
// `(?<!\d)0\s*处` so the honest-negation "0 处" does not also fire inside a positive "50 处".
const NEGATION = /未发现|未找到|未见|不存在|没有|无命中|零命中|(?<!\d)0\s*处|\bnot found\b|\bno match(?:es)?\b|\bno occurrences\b|\bnone\b|\babsent\b|does not (?:exist|appear|occur)/i;

/** Parse `\d[\d,]*` (thousands commas allowed) into an integer. */
function toInt(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/** Classify a number by the words in the ≤10-char window before it and the ≤6-char window after it. */
function qualifierFor(statement: string, start: number, end: number): MatchCountMention["qualifier"] {
  const before = statement.slice(Math.max(0, start - 10), start);
  const after = statement.slice(end, end + 6);
  if (LOWER_BOUND.test(before) || LOWER_BOUND.test(after)) return "lower";
  if (UPPER_BOUND.test(before) || UPPER_BOUND.test(after)) return "upper";
  if (APPROXIMATE.test(before) || APPROXIMATE.test(after)) return "approximate";
  return "exact";
}

/**
 * Deterministically extract every match-context count in a statement, deduplicated by the number's
 * position so a number caught by two anchors (e.g. "37 处命中") yields one mention.
 */
export function extractMatchCounts(statement: string): MatchCountMention[] {
  const byStart = new Map<number, MatchCountMention>();
  for (const pattern of MATCH_CONTEXT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of statement.matchAll(pattern)) {
      const indices = match.indices?.[1];
      if (!indices) continue;
      const [start, end] = indices;
      if (byStart.has(start)) continue;
      byStart.set(start, { value: toInt(match[1]), qualifier: qualifierFor(statement, start, end), raw: match[1] });
    }
  }
  return [...byStart.values()];
}

/** True when the statement asserts an item count (个/条/项) rather than a match count. */
export function hasItemCount(statement: string): boolean {
  ITEM_COUNT_PATTERN.lastIndex = 0;
  return ITEM_COUNT_PATTERN.test(statement);
}

/** True when the statement honestly reports a negative / zero result (Rule B negation wordlist). */
export function matchesNegation(statement: string): boolean {
  return NEGATION.test(statement);
}

/** Matches recorded by a receipt, guarding a malformed `matches` field. */
function matchesLen(receipt: SearchReceipt): number {
  return Array.isArray(receipt.matches) ? receipt.matches.length : 0;
}

/**
 * The largest match count a single receipt can PROVE. A complete receipt proves exactly its recorded
 * matches; a truncated one proves at least `atLeast` (or its recorded matches, whichever is larger).
 */
export function provableLowerBound(receipt: SearchReceipt): number {
  const matches = matchesLen(receipt);
  return receipt.truncated ? Math.max(matches, receipt.atLeast ?? 0) : matches;
}

interface CountVerdict {
  severity: "error" | "warning";
  message: string;
}

/** Evaluate one match-context count against the receipts the claim cites (null = supported). */
function evaluateMatchCount(mention: MatchCountMention, receipts: SearchReceipt[]): CountVerdict | null {
  const { value: n, qualifier, raw } = mention;
  if (qualifier === "upper") {
    return { severity: "warning", message: `states an upper-bound count (${raw}); a SEARCH receipt establishes an exact or lower-bound match total, not an upper bound` };
  }
  if (qualifier === "approximate") {
    return { severity: "warning", message: `states an approximate count (${raw}); a SEARCH receipt establishes an exact or lower-bound match total, not an estimate` };
  }
  if (qualifier === "lower") {
    const maxSingle = Math.max(...receipts.map(provableLowerBound));
    const sum = receipts.reduce((total, receipt) => total + provableLowerBound(receipt), 0);
    if (n <= maxSingle) return null;
    if (n <= sum) return { severity: "warning", message: `states a lower bound of ${n} matches that no single cited SEARCH receipt proves; it holds only when summed across ${receipts.length} receipts` };
    return { severity: "error", message: `states a lower bound of ${n} matches but the cited SEARCH receipt(s) prove at most ${sum}` };
  }
  // exact
  if (receipts.every((receipt) => receipt.truncated)) {
    return { severity: "error", message: `states an exact count of ${n} matches but every cited SEARCH receipt is truncated and can prove only a lower bound; use lower-bound wording (e.g. "at least ${n}") or cite a complete receipt` };
  }
  const singleMatch = receipts.some((receipt) => !receipt.truncated && matchesLen(receipt) === n);
  const sumMatch = receipts.length >= 2 && receipts.every((receipt) => !receipt.truncated) && receipts.reduce((total, receipt) => total + matchesLen(receipt), 0) === n;
  if (singleMatch || sumMatch) return null;
  const observed = receipts.map((receipt) => (receipt.truncated ? `>=${provableLowerBound(receipt)}` : String(matchesLen(receipt)))).join(", ");
  return { severity: "error", message: `states an exact count of ${n} matches but the cited SEARCH receipt(s) contain ${observed}` };
}

/**
 * Audit a section's claims for SEARCH-receipt support. A claim citing no SEARCH receipt is skipped.
 * Rule A findings are hard errors only under the current assurance version (`strict`); older runs are
 * grandfathered to warnings. Rules B and A2 are always advisory warnings and never version-gated.
 */
export function auditClaimReceiptSupport(options: {
  documentId: string;
  sectionIndex: number;
  claims: SectionClaim[];
  evidenceById: Map<string, EvidenceItem>;
  strict: boolean;
}): AuditFinding[] {
  const { documentId, sectionIndex, claims, evidenceById, strict } = options;
  const findings: AuditFinding[] = [];
  const gate = (severity: "error" | "warning"): "error" | "warning" => (severity === "error" ? (strict ? "error" : "warning") : "warning");
  const at = (message: string): string => `section ${sectionIndex}: ${message}`;
  for (const claim of claims) {
    const evidenceIds = claim.evidenceIds ?? [];
    const cited = evidenceIds.map((id) => evidenceById.get(id));
    const receipts = cited
      .filter((item): item is EvidenceItem => item?.kind === "search")
      .map((item) => item.data as SearchReceipt | undefined)
      .filter((data): data is SearchReceipt => Boolean(data));
    if (!receipts.length) continue; // no SEARCH reference to check against

    // Rule A: match-context counts must be provable from the cited receipts.
    const mentions = extractMatchCounts(claim.statement);
    for (const mention of mentions) {
      const verdict = evaluateMatchCount(mention, receipts);
      if (verdict) findings.push({ level: gate(verdict.severity), document: documentId, message: at(`claim ${claim.id} ${verdict.message}`) });
    }

    // Rule B: verified/fact claim citing only zero-match receipts must read as a negative finding.
    if ((claim.marker === "verified" || claim.marker === "fact") && receipts.every((receipt) => matchesLen(receipt) === 0)) {
      if (!matchesNegation(claim.statement) && !mentions.some((mention) => mention.value > 0)) {
        findings.push({ level: "warning", document: documentId, message: at(`claim ${claim.id} is marked ${claim.marker} and cites only zero-match SEARCH receipts, but its statement reports neither a negative finding nor a match count; state the negative result explicitly or cite supporting evidence`) });
      }
    }

    // Rule A2: all-SEARCH evidence asserting an item count a match-line receipt cannot establish.
    const allSearch = cited.length > 0 && cited.every((item) => item?.kind === "search");
    if (allSearch && hasItemCount(claim.statement)) {
      findings.push({ level: "warning", document: documentId, message: at(`claim ${claim.id} cites only SEARCH receipts but asserts an item count; a receipt counts matched lines, not entities, so the count is not established by the cited evidence`) });
    }
  }
  return findings;
}
