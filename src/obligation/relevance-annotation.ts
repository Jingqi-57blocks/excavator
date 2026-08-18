// RELEVANCE ANNOTATION — which reading obligations look like they belong to the feature being investigated.
//
// WHY THIS IS A LABEL AND NOT A JUDGEMENT. The obligation denominator enumerates every decision function in
// the boundary's FILES, not every decision function about the feature. Measured on a real run: of 225
// not-opened obligations, a human reading each one judged 113 to be noise — functions that merely share a
// file or directory with leave code (interview positions, worklog sheets, project thumbnails). Ranked by
// unread lines, the top five files that reading pointed at contained THREE noise-dominated files, so the
// funnel would have spent the next slice on `management/*`, which has nothing to do with leave. The
// instrument was misdirecting.
//
// The obvious fix — drop the irrelevant ones — is the wrong one, and the measurements say so. No zero-model
// signal separates the two groups cleanly: the best (this one) recovers 72–77% of the real misses while
// leaking 21–24% of the noise. Filtering on that would delete real misses; one of them is measured and
// named — `retiredSummaryReportService.js`'s PTO settlement functions are real leave logic that this signal
// misses, because the run's aliases happen not to include `pto`.
//
// So the denominator does not change by one item. Every obligation stays counted, and this module only
// attaches a label the reading layer can group by. Curation marks; it never drops — the same discipline
// read-obligations.ts states for its own exclusions.
//
// The vocabulary is the RUN'S OWN: the anchor terms its feature request produced, through the same
// tokenizer and abbreviation derivation the boundary detection used. Nothing is tunable here — no
// threshold, no hand-written word list — because a knob would let whoever runs the numbers move them.

import { deriveAbbreviations, nameTokens } from "../attribution/allocator.ts";

/** Where a feature's vocabulary was found. Absent means "nowhere" — never "irrelevant". */
export type AnchorHit = "name" | "path";

/**
 * Annotate one obligation. `name` beats `path`: a function CALLED `approveLeave` is feature vocabulary
 * itself, while a function that merely lives under `handlers/leave/` inherits it from its neighbours — a
 * weaker signal, and the reading layer keeps them apart for exactly that reason.
 *
 * `route` participates when present (`POST /leaves` carries the vocabulary a Go symbol name may not).
 */
export function anchorHitFor(input: { name?: string; path?: string; route?: string }, anchorTerms: string[]): AnchorHit | undefined {
  const vocabulary = anchorVocabulary(anchorTerms);
  if (!vocabulary.size) return undefined;
  if (matches(`${input.name ?? ""} ${input.route ?? ""}`, vocabulary)) return "name";
  if (matches(directoryOf(input.path), vocabulary)) return "path";
  return undefined;
}

/**
 * The terms plus their consonant skeletons — `leave` also matches `lv`, which is how this codebase writes
 * it (`LvHldyTypeC`, `lvService`). Derived, not listed: a hand-written synonym table would be a knob.
 */
export function anchorVocabulary(anchorTerms: string[]): Set<string> {
  const vocabulary = new Set<string>();
  for (const term of anchorTerms) {
    const lower = term.toLowerCase().trim();
    if (lower.length >= 2) vocabulary.add(lower);
    for (const abbreviation of deriveAbbreviations([lower])) if (abbreviation.length >= 2) vocabulary.add(abbreviation);
  }
  return vocabulary;
}

/** Only the DIRECTORY of a path is vocabulary — a file named `service.go` under `leave/` is the signal. */
function directoryOf(path: string | undefined): string {
  const value = String(path ?? "");
  const slash = value.lastIndexOf("/");
  return slash < 0 ? "" : value.slice(0, slash);
}

function matches(text: string, vocabulary: Set<string>): boolean {
  if (!text.trim()) return false;
  for (const token of nameTokens(text)) {
    if (vocabulary.has(token)) return true;
  }
  // A CJK anchor (`请假`) has no camelCase tokens to split, so it is matched as a substring — the only
  // honest way to read a language that does not delimit words.
  for (const term of vocabulary) {
    if (/[一-鿿]/.test(term) && text.includes(term)) return true;
  }
  return false;
}
