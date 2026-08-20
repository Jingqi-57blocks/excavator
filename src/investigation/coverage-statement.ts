/**
 * COVERAGE STATEMENT — the one place that decides whether a denominator may be described as covered.
 *
 * WHY THIS MODULE EXISTS. Two measured defects, one wording rule. 57B-449: an overview-only run mints zero read
 * obligations, so `coverage/read-obligations.json` holds `obligations: []`, and `excavator reading` answered
 * "every strong-partition obligation has at least one window" — TRUE over the empty set, and read by a human as
 * "this 2,142-file target is covered", while the run actually had 22 usable windows. 57B-456: after 451 downgraded
 * a budget-truncated read from a hard freeze error to a recorded limitation, a run that read 7% of its obligations
 * seals an epoch SHAPED EXACTLY LIKE a complete one — visible in the closure record, and nothing downstream said a
 * different sentence because of it. Same family, two denominator states: empty, and non-empty with a large unread
 * remainder. Both produced the MOST optimistic wording available.
 *
 * SO THE RULE IS A CLOSED UNION WITH ONE CONSTRUCTOR, NOT A BOOLEAN. There is no `passed` field anywhere here. A
 * boolean is what let both defects happen: `unread === 0` is true of an empty ledger and of a fully-read one, and a
 * caller holding a boolean cannot tell those apart even when it wants to. `complete` is reachable only through
 * `coverageStatement`, and only when the denominator's ledger was present, its row count is non-zero, and every row
 * is accounted for — displacement, waiving and an absent ledger cannot reach that arm BY CONSTRUCTION rather than
 * because a call site remembered to check. `assertNever` closes both switches: a twelfth violation kind or a third
 * vacuous source has to be given its own sentence before this file compiles.
 *
 * IT LIVES IN LAYER 7 ON PURPOSE, and that is a named deviation from "new report code goes in `src/report/`". The
 * first consumer is `read-residual-exposure.ts`, which is layer 7; the report side may import layer 7 and not the
 * reverse (`tests/layering-registry.ts`'s directory order). Putting the rule in `src/report/` would have made the
 * 449 fix impossible to reach from the file that renders the sentence.
 *
 * ONE STATEMENT, ONE LEDGER. `ledger` is required and singular. Two ledgers' rows may never be added into one
 * denominator: 57B-458 measured what a naive id join across `read-obligations.json` and `workitems.json` costs
 * (665 of 946 rows silently unmatched because one id segment differs), and a single blended "coverage %" is exactly
 * the number that join would be needed to produce. Callers therefore emit SEVERAL statements, each naming its own
 * ledger, and nothing here can combine them.
 *
 * THE THREE-STATE LAW IS THE ARITHMETIC, borrowed rather than re-spelled: every statement carries a
 * `CoverageConservation` from `src/base/conservation.ts`, the only constructor for `total = counted + excluded +
 * unexplained`. A non-zero residue is refused at construction rather than published, for the same reason
 * `accountPlanObligations` throws on its own imbalance: this module's callers derive `counted` and the entries from
 * one pass over one ledger, so a residue is an arithmetic bug in the caller, not a fact about the run — and a
 * number a report cannot explain is worse than a crash.
 *
 * Pure: zero I/O, zero model call, byte-stable ordering.
 */

import { assertNever } from "../base/artifact-result.ts";
import { summarizeCoverage, type CoverageConservation } from "../base/conservation.ts";

/**
 * WHY A STATEMENT HAS NO DENOMINATOR. Two states, because they are two different sentences and merging them is a
 * defect this repository has already paid for twice: the topic catalog's facet census keeps them apart
 * (`ledger-absent` = the producer's own artifact is missing or unavailable, `ledger-empty` = the artifact is there
 * and holds no row), and the closure record's own comment forbids reading an absent field as a zero.
 *
 * The difference is actionable. `ledger-empty` says the run genuinely produced nothing to measure — for an
 * overview-only run that is the correct and final answer. `ledger-absent` says nobody can tell, and re-running or
 * re-freezing might change the answer. A single "no data" sentence would make a blind spot look like a finding.
 */
export const VACUOUS_SOURCES = ["ledger-absent", "ledger-empty"] as const;
export type VacuousSource = (typeof VACUOUS_SOURCES)[number];

/**
 * Every named reason a denominator's rows are NOT covered. Closed, exported, and each one gets its own sentence.
 *
 * "Violation" here means a violation of the completeness a reader would otherwise infer — not that the plan or the
 * run did something illegal. Some of these are legitimate, counted exits: `waived-by-state` is a plan omitting a
 * topic for an audience, which a plan is allowed to do, and `displaced-by-budget` is the recorded limitation 451
 * deliberately made non-fatal. What they have in common — the only thing this union asserts — is that a statement
 * carrying one of them MUST NOT read as covered. The kind is what distinguishes a decision from a defect, which is
 * why each has its own sentence rather than a shared "N rows missing".
 *
 * ONE KIND SERVES TWO LEDGERS EXACTLY ONCE, and it is `cannot-determine`: a work item whose ledger status is
 * `cannot-determine` and a read obligation with no end line are the same fact about knowledge — the question was
 * asked and could not be settled — and `detail` is required precisely so a shared kind still names which ledger a
 * row came from. Nothing else is shared. `ledger-excluded` in particular is NOT unread residual: a read obligation
 * the ledger excluded (declaration-only, or contained in another) was removed from that ledger's OWN counted
 * denominator before anything was measured, and folding it into the covered count is how 27 of wcp's 946 rows
 * would have become invisible.
 */
export const COVERAGE_VIOLATION_KINDS = [
  "unread-residual",
  "ledger-excluded",
  "displaced-by-budget",
  "waived-by-state",
  "claimed-but-unplaced",
  "undispositioned",
  "owned-by-no-unit",
  "grounding-exempt",
  "cannot-determine",
  "open-determination",
  "unknown-topic",
  "stated-unknown"
] as const;
export type CoverageViolationKind = (typeof COVERAGE_VIOLATION_KINDS)[number];

/**
 * One named entry against a denominator.
 *
 * `ids` may be empty, because some ledgers record only a count: the sealed closure carries
 * `readsDisplacedByBudget` as a number and no id list, and inventing ids for it would be worse than saying how
 * many. It is never CAPPED here — a cap on a conservation residue is where the next silent loss hides — so a
 * caller that must bound a rendering bounds it in its own renderer and says so.
 */
export interface CoverageViolation {
  readonly kind: CoverageViolationKind;
  /** How many of the denominator's rows this entry accounts for. A zero-row entry is dropped, never printed. */
  readonly rows: number;
  /** The rows' own ids, ascending, or empty when the ledger records only a count. Never capped by this module. */
  readonly ids: readonly string[];
  /** One clause naming WHERE these rows came from, in the ledger's own words. Required: a bare count is unactionable. */
  readonly detail: string;
}

/**
 * A denominator and where it came from. `absent` is not a zero — it is the state 449's other half.
 *
 * `counted` is an INPUT rather than `rows - entries`, which is what makes the conservation law a check instead of
 * an identity: the caller counts the covered rows in the same pass that produces the entries, and a disagreement
 * between the two surfaces as a residue the constructor refuses.
 */
export type CoverageDenominator =
  | { readonly state: "present"; readonly ledger: string; readonly rows: number; readonly counted: number }
  | { readonly state: "absent"; readonly ledger: string; readonly reason: string };

export interface CoverageStatementInput {
  /** What is being counted, as a noun phrase a sentence can be built around. */
  readonly subject: string;
  readonly denominator: CoverageDenominator;
  /** Entries against this denominator. Zero-row entries are dropped; `undefined` members are allowed and skipped. */
  readonly entries: readonly (CoverageViolation | undefined)[];
}

/** What every arm carries: what was counted, and out of which single ledger. */
export interface CoverageStatementSubject {
  readonly subject: string;
  readonly ledger: string;
}

/**
 * The closed union. Three arms, no boolean, and `complete` is unreachable except through the constructor below.
 *
 * `complete` carries the conservation record rather than a bare count so a reader can see the denominator it is a
 * statement about; `vacuous` carries no conservation at all, because there is nothing to conserve and a
 * `total: 0` record next to the word "complete" is precisely the shape 449 produced.
 */
export type CoverageStatement =
  | (CoverageStatementSubject & { readonly state: "complete"; readonly conservation: CoverageConservation })
  | (CoverageStatementSubject & { readonly state: "vacuous"; readonly source: VacuousSource; readonly reason: string })
  | (CoverageStatementSubject & {
      readonly state: "violations";
      readonly conservation: CoverageConservation;
      /** At least one, ascending by kind then by detail. Never empty: an empty list would be `complete`. */
      readonly entries: readonly CoverageViolation[];
    });

/**
 * One entry, or nothing at all when the ledger holds no such row.
 *
 * Exported because every caller needs it and the alternative is `...(n > 0 ? [entry] : [])` at every site, which is
 * the kind of line that eventually gets written as `[entry]`.
 */
export function coverageViolation(
  kind: CoverageViolationKind,
  rows: number,
  ids: readonly string[],
  detail: string
): CoverageViolation | undefined {
  if (!Number.isInteger(rows) || rows < 0) {
    throw new Error(`A ${kind} coverage entry must carry a non-negative integer row count; it carries ${rows}`);
  }
  if (rows === 0) return undefined;
  if (ids.length > 0 && ids.length !== rows) {
    throw new Error(`A ${kind} coverage entry names ${ids.length} id(s) for ${rows} row(s); an entry either lists every row it accounts for or lists none`);
  }
  if (detail.trim() === "") throw new Error(`A ${kind} coverage entry must say where its ${rows} row(s) came from`);
  return { kind, rows, ids: [...ids].sort(compare), detail };
}

/**
 * THE ONLY CONSTRUCTOR. Derives the arm from the counts; no caller may state which arm it wants.
 *
 * The order of the three tests is the whole point. An absent ledger is decided FIRST, so no row count can override
 * it; an empty ledger is decided SECOND, so `entries: []` over zero rows can never be read as covered; and only
 * then may a fully-accounted denominator be called complete. Displacement, waiving and an empty denominator
 * therefore cannot reach `complete` structurally, rather than because a call site remembered to look.
 */
export function coverageStatement(input: CoverageStatementInput): CoverageStatement {
  const { subject, denominator } = input;
  if (subject.trim() === "") throw new Error("A coverage statement must name what it counts");
  if (denominator.ledger.trim() === "") throw new Error(`The coverage statement about ${JSON.stringify(subject)} must name the one ledger its denominator came from`);
  const { ledger } = denominator;

  if (denominator.state === "absent") {
    if (denominator.reason.trim() === "") throw new Error(`An absent denominator for ${JSON.stringify(subject)} must say why ${ledger} could not be read`);
    return { subject, ledger, state: "vacuous", source: "ledger-absent", reason: denominator.reason };
  }
  const { rows, counted } = denominator;
  if (!Number.isInteger(rows) || rows < 0) throw new Error(`The denominator of ${JSON.stringify(subject)} must be a non-negative integer row count; ${ledger} reported ${rows}`);
  if (rows === 0) {
    return {
      subject,
      ledger,
      state: "vacuous",
      source: "ledger-empty",
      reason: `${ledger} is present and its denominator is empty`
    };
  }

  const entries = [...input.entries]
    .filter((entry): entry is CoverageViolation => entry !== undefined)
    .sort((a, b) => COVERAGE_VIOLATION_KINDS.indexOf(a.kind) - COVERAGE_VIOLATION_KINDS.indexOf(b.kind) || compare(a.detail, b.detail));
  const excluded = entries.reduce((total, entry) => total + entry.rows, 0);
  const conservation = summarizeCoverage({ total: rows, counted, excluded });
  if (conservation.unexplained !== 0) {
    throw new Error(`The coverage statement about ${subject} does not conserve: ${ledger} holds ${rows} row(s), ${counted} are counted as covered and ${excluded} are accounted for by ${entries.length} named entry/entries, leaving ${conservation.unexplained} in no bucket at all`);
  }
  if (entries.length === 0) return { subject, ledger, state: "complete", conservation };
  return { subject, ledger, state: "violations", conservation, entries };
}

/**
 * One sentence per entry kind, exhaustive with no `default`.
 *
 * `displaced-by-budget` and the determined-negative sentence below are the pair 57B-456 requires to stay
 * distinguishable: "a ceiling this run recorded pushed the read out" and "the read happened and found nothing" are
 * opposite facts about knowledge, and a shared phrase like "not found" would let a reader take the first for the
 * second. Nothing else in this file is allowed to phrase either one.
 */
export function coverageViolationSentence(entry: CoverageViolation): string {
  const rows = `${entry.rows} row${entry.rows === 1 ? "" : "s"}`;
  switch (entry.kind) {
    case "unread-residual":
      return `${rows}: read obligations no source window covers — nothing is known about what they would have shown (${entry.detail})`;
    case "ledger-excluded":
      return `${rows}: rows the ledger removed from its OWN counted denominator before anything was measured, so they are neither read nor unread (${entry.detail})`;
    case "displaced-by-budget":
      return `${rows}: authorized reads a ceiling THIS RUN RECORDED pushed out before they happened — they were never attempted, so nothing was learned or ruled out by them (${entry.detail})`;
    case "waived-by-state":
      return `${rows}: material obligations a plan disposition took OUT of this document — a decision the plan is allowed to make, and one this document does not answer for (${entry.detail})`;
    case "claimed-but-unplaced":
      return `${rows}: material obligations a placing disposition claims are covered and no unit writes (${entry.detail})`;
    case "undispositioned":
      return `${rows}: material obligations in no unit whose topics carry no readable disposition at all (${entry.detail})`;
    case "owned-by-no-unit":
      return `${rows}: material obligations this document reaches and no unit of it grounds (${entry.detail})`;
    case "grounding-exempt":
      return `${rows}: material obligations exempt from the grounding check, so nothing verifies that the document states them (${entry.detail})`;
    case "cannot-determine":
      return `${rows}: obligations the investigation could not determine — the question was asked and left open (${entry.detail})`;
    case "open-determination":
      return `${rows}: obligations still pending or in progress, so no determination exists for them yet (${entry.detail})`;
    case "unknown-topic":
      return `${rows}: catalog topics carrying an unknown — an unread residual span or an undetermined obligation (${entry.detail})`;
    case "stated-unknown":
      return `${rows}: unknowns the written units state about themselves (${entry.detail})`;
  }
  return assertNever(entry.kind, "coverage violation kind");
}

/**
 * The sentence for reads that HAPPENED and settled the question negatively.
 *
 * It lives beside `displaced-by-budget` deliberately: the two are the pair a reader most easily conflates, and
 * keeping them in one file is the only way "distinguishable in wording" can be checked in one place. It is NOT a
 * violation kind — a determined negative is knowledge, and counting it against coverage would punish the run for
 * answering.
 */
export function determinedNegativeSentence(rows: number): string {
  return `${rows} obligation${rows === 1 ? "" : "s"} were READ AND SETTLED NEGATIVELY: the window was opened, the thing looked for was not there, and that is a determination rather than a gap.`;
}

/**
 * THE THREE SENTENCE PREFIXES, exported so a test can assert one is ABSENT without a regex over prose.
 *
 * No prefix is a substring of another — that is a requirement, not a coincidence. "COVERED" and "NOT COVERED"
 * were the first spelling, and a test asserting "the covered wording never appears" passed over "NOT COVERED"
 * because the second contains the first. A wording rule whose own assertion can be fooled by a substring is the
 * instrument-not-verified failure this repository has a memory of. The words are the union's own arm names, which
 * is also the house style `summariseUnitGrounding` already prints.
 */
export const COVERAGE_STATEMENT_PREFIXES = {
  complete: "complete:",
  vacuous: "vacuous (",
  violations: "violations:"
} as const satisfies Record<CoverageStatement["state"], string>;

/** One line naming the arm and the arithmetic. The sentence a reader cannot mistake for the other two arms. */
export function coverageStatementSentence(statement: CoverageStatement): string {
  switch (statement.state) {
    case "complete":
      return `${COVERAGE_STATEMENT_PREFIXES.complete} all ${statement.conservation.total} ${statement.subject} in ${statement.ledger} are accounted for, and nothing is withheld.`;
    case "vacuous":
      return `${COVERAGE_STATEMENT_PREFIXES.vacuous}${statement.source}): this run has no ${statement.subject} at all, so no coverage statement about them applies — ${statement.reason}.`;
    case "violations":
      return `${COVERAGE_STATEMENT_PREFIXES.violations} of the ${statement.conservation.total} ${statement.subject} in ${statement.ledger}, ${statement.conservation.counted} ${statement.conservation.counted === 1 ? "is" : "are"} accounted for and ${statement.conservation.excluded} ${statement.conservation.excluded === 1 ? "is" : "are"} not, for ${statement.entries.length} named reason${statement.entries.length === 1 ? "" : "s"}.`;
  }
  return assertNever(statement, "coverage statement state");
}

/**
 * The statement as markdown lines: the sentence, then one bullet per entry.
 *
 * `idLimit` bounds only the ID LIST inside a bullet, never the entry set and never a count: the bullet always
 * states how many rows it stands for before any id is shown, so a bounded rendering still declares the full size
 * it was cut from. That is the same discipline `read-residual-exposure.ts` uses for its file list.
 */
export function renderCoverageStatement(statement: CoverageStatement, idLimit: number): readonly string[] {
  if (!Number.isInteger(idLimit) || idLimit < 0) throw new Error(`A coverage statement's id bound must be a non-negative integer; it is ${idLimit}`);
  const lines = [coverageStatementSentence(statement)];
  if (statement.state !== "violations") return lines;
  for (const entry of statement.entries) {
    lines.push(`- ${coverageViolationSentence(entry)}`);
    if (entry.ids.length === 0) continue;
    const shown = entry.ids.slice(0, idLimit);
    const hidden = entry.ids.length - shown.length;
    if (shown.length > 0) lines.push(`  - ${shown.map((id) => `\`${id}\``).join(", ")}${hidden > 0 ? `, … ${hidden} more id(s) not listed here` : ""}`);
    else lines.push(`  - ${entry.ids.length} id(s) not listed here`);
  }
  return lines;
}

/**
 * Whether a statement may be read as covering its denominator. Derived, never stored.
 *
 * Exported for one purpose: a test asserting that a run's companion contains NO covered-family wording. It is not a
 * field on the union, because a field is a boolean and a boolean is what 449 and 456 both exploited.
 */
export function readsAsCovered(statement: CoverageStatement): boolean {
  return statement.state === "complete";
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
