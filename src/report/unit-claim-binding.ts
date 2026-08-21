/**
 * THE CLAIM ↔ PROSE BINDING CONTRACT, PER AUTHORING UNIT.
 *
 * Three questions about one unit's own bytes: is every substantive statement its visible prose makes bound to a
 * claim, does every claim's `statement` really appear in that prose, and is a statement long enough that
 * "appears in" means anything. Plus the fourth rule that shares this file's folding — a unit with substantive
 * prose must carry a real evidence-level marker in it.
 *
 * WHY THE UNIT PATH NEEDED THIS FILE AT ALL. It had none of it. Draft and collect check the summary's digests and
 * the grounding verdict; the grounding audit's subject is OBLIGATIONS (which claim links which work item); the
 * consistency checker's five classes are the properties no per-unit gate sees, and none of them reads a claim's
 * `statement` at all. So a unit could state anything whatever in its prose and satisfy every gate by linking
 * claims whose statements were nowhere in it. The section path has checked this since the beginning
 * (`section-audit.ts`); this is that check, on the unit key.
 *
 * VERIFIED, NOT REMEMBERED: `grep -rn --include='*.ts' '\.statement' src/` — outside this file and
 * `section-audit.ts`, every hit is a statement of some OTHER kind (a coverage statement, a finding's own text, a
 * cache-intent reason) or reads a claim statement for something other than prose containment
 * (`claim-comparison.ts` checks comparative wording, `condition-inventory.ts` looks for a literal, `run.ts` copies
 * it into the claims companion). Re-run it before treating this paragraph as current.
 *
 * ═══ SINGLE FOLDING AUTHORITY ═══
 *
 * `substantiveUnitSegments` (which parts of the prose must be claimed) and the statement comparison below fold
 * text through `foldUnitText` and nothing else. The fold is NOT a parameter of the segmenter — the section path
 * made it one, and the accident that cost a real report ~30 errors was exactly two halves folding differently:
 * the segmenter dropped `**` while the comparator turned it into a SPACE, so `产品名为 **CMS3000**，其源码`
 * folded to `… CMS3000 ，其源码` on one side only — a space before the comma that appears in no rendering of the
 * prose and in nothing an author would write. Every claim binding a bold lead-in became unbindable, while
 * `writing-rules.md` asks every chapter for bold lead-ins. Making the fold uninjectable is the structural form
 * of that fix: the two halves cannot drift, because there is nothing to set differently.
 *
 * ═══ ONE GENERATION, AND THE LAW FOR CHANGING IT ═══
 *
 * The section path judges a section under TWO foldings and keeps the reading that costs least, because runs
 * archived before the fold changed carry the old artefact IN THEIR CLAIMS. Its own words: "Mixing generations is
 * what broke archived runs." That machinery — the folding array, the cost comparison, the folding-sensitive
 * finding pattern — is deliberately NOT here: authoring units exist only from R4a onward, every unit product on
 * disk was written under this one folding, and there is no archived generation to be compatible with. A second
 * generation with an empty population is a mechanism that can only ever be wrong.
 *
 * FORWARD-LOOKING RULE, so this is not left to anyone's memory: THE MOMENT `foldUnitText` CHANGES IN A WAY THAT
 * MOVES WHICH STATEMENTS BIND, unit products written before the change become a second generation, and the
 * per-generation judgement must be rebuilt with it — segments and statements folded the same way, one generation
 * at a time, whole, and the reading chosen per unit rather than per finding. Do not add a per-check fallback:
 * comparing the two sides across generations is the drift this file exists to make impossible. The tuition for
 * this lesson has been paid once already, on the section path, in archived runs that fell out of audit.
 *
 * ═══ WHAT THIS FILE DOES NOT CHECK ═══
 *
 * Claim SHAPE (`assertValidClaim`), which obligation a claim grounds (`unit-grounding-audit.ts`), and every
 * cross-unit property (`unit-consistency.ts`). Those have denominators of their own and a second derivation of
 * any of them would be a second denominator.
 *
 * IT IS A PURE FUNCTION OF VALUES: no path, no I/O, no clock, no model. `unit-claim-binding-source.ts` is the
 * half that opens files.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { SectionClaim } from "../base/types.ts";
// THE MARKER VOCABULARY HAS ONE READER, AND THIS IS THE IMPORT THAT KEEPS IT SO. `hasEvidenceMarkers` routes
// through `markersIn`/`MARKER_TOKENS`, which `tests/evidence-marker-vocabulary.test.ts` pins BIDIRECTIONALLY
// against `skills/excavator/references/evidence-markers.json`. Copying the table here would give that contract a
// second reader covered by half a test — a worse trade than one import into a file 57B-481 retires.
//
// WHAT 57B-481 INHERITS BECAUSE OF THIS LINE, grep-verified rather than recalled: after this slice the `src/`
// importers of `section-audit.ts` are exactly four —
//   `claims-scaffold.ts` (substantiveSegments), `unit-output.ts` (assertValidClaim), THIS file
//   (hasEvidenceMarkers), and `run.ts` (the section path itself, which goes with it).
// Command: grep -rn --include='*.ts' section-audit.ts src/ — and read the import lines out of the hits. (Spelled
// this way rather than as a quoted import specifier because `layer-order.test.ts` refuses a relative specifier
// written inside a comment: it looks like an import to a reader and is invisible to the graph.)
// So retiring `section-audit.ts` means relocating exactly `assertValidClaim` and `hasEvidenceMarkers` (with the
// `markersIn` / `MARKER_TOKENS` / `visibleText` support the latter stands on); `claims-scaffold.ts` retires with
// it, per that file's own deferral note.
import { hasEvidenceMarkers } from "./section-audit.ts";

export const UNIT_CLAIM_BINDING_VERSION = "unit-claim-binding-v1";

/**
 * The shortest folded statement that may be said to "appear in" a unit's prose.
 *
 * Six characters, byte for byte the section path's threshold. Below it a substring match says nothing: a
 * three-character statement is contained by most sentences of any length, so a claim that short is bound to
 * nothing in particular and the binding guarantee is void for it.
 */
const MINIMUM_BINDABLE_STATEMENT_LENGTH = 6;

/**
 * The evidence-level marker token, as prose carries it.
 *
 * ONE definition, used by the segmenter and by the fold: the segmenter strips it and the fold must strip it
 * identically, or a segment stops being a substring of the very unit that produced it. That was the SECOND
 * independent drift of this kind on the section path — the segmenter removed the token outright while the fold
 * removed only the backticks and left `事实` standing as a bare word.
 *
 * The four tokens here are the section path's, verbatim. Note that `markersIn`'s vocabulary is WIDER (it accepts
 * `已验证`, `不可用`, `无法获得` too); the two sets have differed since the vocabulary was widened, which means a
 * unit written with a synonym has the synonym folded as ordinary text on both sides. That is consistent — both
 * halves see the same thing — but it is not the same set, and it is stated here rather than left to be
 * rediscovered.
 */
const EVIDENCE_MARKER_TOKEN = /`(?:事实|验证|推断|不可得|fact|verified|inferred|unavailable)`/gi;

/**
 * Remove what is decoration rather than content: the marker token, and the backticks and asterisks that sit
 * BETWEEN characters a reader sees as adjacent.
 *
 * INLINE DECORATION IS REMOVED, NOT SPACED, and that is the whole substance of the bold lead-in fix. Turning `*`
 * or `` ` `` into whitespace injects a separator that exists in no rendering of the text.
 */
function foldInlineDecoration(value: string): string {
  return value.replace(EVIDENCE_MARKER_TOKEN, "").replace(/[`*]/g, "");
}

/**
 * Fold unit prose and a claim statement into one comparable form. THE authority — there is no second one.
 *
 * `-` and `_` stay SPACED rather than removed: they occur INSIDE identifiers (`read-obligations`, `snake_case`),
 * where removal would weld words together and silently change which statements match — a different way to break
 * the same binding.
 */
export function foldUnitText(value: string): string {
  return foldInlineDecoration(value).replace(/[_>#-]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The reading flow of a unit: what a reader sees, with collapsed evidence blocks, fenced code and HTML comments
 * removed. A table living only inside a collapsed block is not part of the prose a claim binds to.
 */
export function visibleUnitText(content: string): string {
  return content
    .replace(/<details[\s\S]*?<\/details>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
}

/**
 * Every substantive statement a unit's visible prose makes, folded, de-duplicated, in reading order.
 *
 * Headings, table rules and list markers are structure rather than statement; a table row becomes its cells
 * joined by `；`, so a row is claimed like a sentence. A part survives only if it carries at least eight letters
 * or digits after folding — the threshold that keeps a `| --- |` fragment or a two-word cell from demanding a
 * claim of its own.
 *
 * THE FOLD IS NOT A PARAMETER. See the file header: the segmenter and the comparator sharing one fold by
 * construction is the fix for the defect this whole file records.
 */
export function substantiveUnitSegments(content: string): readonly string[] {
  const segments: string[] = [];
  for (const raw of visibleUnitText(content).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^#{1,6}\s+/.test(line) || /^[-| :]+$/.test(line)) continue;
    if (/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) continue;
    line = line
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(EVIDENCE_MARKER_TOKEN, "")
      .trim();
    if (line.startsWith("|") && line.endsWith("|")) {
      line = line.slice(1, -1).split("|").map((cell) => cell.trim()).filter(Boolean).join("；");
    }
    for (const part of line.split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z0-9])/u)) {
      const normalized = foldUnitText(part).trim();
      const semanticLength = (normalized.match(/[\p{Letter}\p{Number}]/gu) ?? []).length;
      if (semanticLength >= 8) segments.push(normalized);
    }
  }
  return [...new Set(segments)];
}

/**
 * The four ways a unit can break the binding contract. Exhaustive and named, so a caller can route one kind
 * without matching on a message, and so a fifth kind cannot be added without being classified.
 */
export const UNIT_BINDING_PROBLEM_KINDS = [
  "unclaimed-statement",
  "statement-absent",
  "statement-too-short",
  "missing-evidence-marker"
] as const;
// The census, not decoration: `tests/unit-claim-binding.test.ts` walks this array and demands a named fixture
// that produces each kind, so a fifth kind cannot be added with nothing reaching it.

export type UnitBindingProblemKind = (typeof UNIT_BINDING_PROBLEM_KINDS)[number];

/** One violation. `claimId` is null exactly for the two kinds whose subject is the unit rather than a claim. */
export interface UnitBindingProblem {
  readonly kind: UnitBindingProblemKind;
  readonly claimId: string | null;
  readonly message: string;
}

/**
 * The three-state verdict. No boolean anywhere.
 *
 * `vacuous` is a unit with neither a substantive statement nor a claim: there is nothing to bind, which is a
 * different fact about a run from "everything binds" and must never render with the same words. `complete`
 * carries BOTH denominators — how many statements were required to be claimed and how many claims were required
 * to appear — because "0 findings" over an empty denominator is the sentence this codebase keeps paying for.
 */
export type UnitBindingVerdict =
  | { readonly conclusion: "complete"; readonly segments: number; readonly statements: number }
  | { readonly conclusion: "vacuous"; readonly source: string }
  | { readonly conclusion: "violations"; readonly segments: number; readonly statements: number; readonly problems: readonly string[] };

export interface UnitClaimBindingResult {
  readonly version: typeof UNIT_CLAIM_BINDING_VERSION;
  readonly unitId: string;
  readonly documentId: string;
  /** Every substantive statement of this unit's visible prose, folded — the claimed-coverage denominator. */
  readonly segments: readonly string[];
  readonly problems: readonly UnitBindingProblem[];
  readonly verdict: UnitBindingVerdict;
}

export interface UnitClaimBindingInput {
  readonly unitId: string;
  readonly documentId: string;
  /** The unit's `content.md`, as written. */
  readonly content: string;
  /** The unit's claims sidecar, as written. */
  readonly claims: readonly SectionClaim[];
}

/**
 * Audit one unit's binding contract. Pure: the caller hands over the bytes.
 *
 * ORDER MATTERS FOR ONE PAIR. A statement below the length threshold is reported as too short and NOT also as
 * absent: "abc is not in the prose" would be a second, misleading sentence about the same defect, and the repair
 * for both is to write a real statement.
 */
export function auditUnitClaimBinding(input: UnitClaimBindingInput): UnitClaimBindingResult {
  const { unitId, documentId, content, claims } = input;
  const segments = substantiveUnitSegments(content);
  const visible = foldUnitText(visibleUnitText(content));
  const problems: UnitBindingProblem[] = [];

  for (const claim of claims) {
    const statement = foldUnitText(claim.statement);
    const claimId = claim.id || "<missing>";
    if (statement.length < MINIMUM_BINDABLE_STATEMENT_LENGTH) {
      problems.push({
        kind: "statement-too-short",
        claimId,
        message: `claim ${claimId} statement is too short to bind to the prose of unit ${JSON.stringify(unitId)}`
      });
      continue;
    }
    if (!visible.includes(statement)) {
      problems.push({
        kind: "statement-absent",
        claimId,
        message: `claim ${claimId} statement is not present in unit ${JSON.stringify(unitId)}: ${statement.slice(0, 120)}`
      });
    }
  }

  // Bidirectional containment, as on the section path: a claim may state more than one segment carries, and a
  // segment split off a longer sentence may be a substring of the statement that covers it.
  const folded = claims.map((claim) => foldUnitText(claim.statement)).filter(Boolean);
  for (const segment of segments) {
    if (folded.some((statement) => statement.includes(segment) || segment.includes(statement))) continue;
    problems.push({
      kind: "unclaimed-statement",
      claimId: null,
      message: `unit ${JSON.stringify(unitId)} has an unclaimed substantive statement: ${segment.slice(0, 120)}`
    });
  }

  // The fourth rule, sharing this file's segmentation: the report's "evidence levels are annotated" conclusion is
  // only trustworthy if a unit with substantive prose actually carries a marker in it. `hasEvidenceMarkers` is
  // the one rule for that and is imported rather than re-spelled, so the marker VOCABULARY has a single reader.
  // NOT version-gated: the section path grandfathers runs prepared before the rule existed, and no unit product
  // predates this contract, so a gate here would have an empty population.
  if (segments.length > 0 && !hasEvidenceMarkers(content)) {
    problems.push({
      kind: "missing-evidence-marker",
      claimId: null,
      message: `unit ${JSON.stringify(unitId)} has substantive statements but no evidence-level marker in its visible prose`
    });
  }

  return {
    version: UNIT_CLAIM_BINDING_VERSION,
    unitId,
    documentId,
    segments,
    problems,
    verdict: verdictOf(unitId, segments.length, claims.length, problems)
  };
}

function verdictOf(unitId: string, segments: number, statements: number, problems: readonly UnitBindingProblem[]): UnitBindingVerdict {
  if (problems.length > 0) return { conclusion: "violations", segments, statements, problems: problems.map((row) => row.message) };
  if (segments === 0 && statements === 0) {
    return {
      conclusion: "vacuous",
      source: `unit ${JSON.stringify(unitId)} makes no substantive statement in its visible prose and declares no claim, so there is nothing to bind in either direction`
    };
  }
  return { conclusion: "complete", segments, statements };
}

/** One sentence a reader cannot mistake for the other two states. Exhaustive; there is no `passed` boolean. */
export function summariseUnitClaimBinding(result: UnitClaimBindingResult): string {
  const { verdict } = result;
  switch (verdict.conclusion) {
    case "complete":
      return `complete: unit ${result.unitId} binds all ${verdict.statements} claim statement(s) to its prose and leaves none of its ${verdict.segments} substantive statement(s) unclaimed`;
    case "vacuous":
      return `vacuous: unit ${result.unitId} has no binding to check — ${verdict.source}`;
    case "violations":
      return `violations: unit ${result.unitId} breaks the binding contract in ${verdict.problems.length} place(s) over ${verdict.segments} substantive statement(s) and ${verdict.statements} claim(s)`;
  }
  return assertNever(verdict, "unit claim binding conclusion");
}
