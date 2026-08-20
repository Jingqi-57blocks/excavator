/**
 * COVERAGE STATEMENT — the one place that decides whether a denominator may be described as covered, and the one
 * place that decides whether what is missing from it is a DECISION or a DEFECT.
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
 * because a call site remembered to check. `assertNever` closes every switch: a thirteenth entry kind or a third
 * vacuous source has to be given its own sentence before this file compiles.
 *
 * WHY THERE ARE FOUR ARMS AND NOT THREE — the arm name is read as a verdict, so it has to be one. The first
 * spelling had ONE arm called `violations` holding both a plan legitimately omitting a topic for an audience and an
 * unread residual nothing measured. Two consecutive slices objected to it independently, and the second brought
 * behavioural evidence: writing the assembly step, the arm name pulled its author toward "refuse to assemble" three
 * times, and the only thing that stopped it was an explicit instruction — after which the reason assembly may NOT
 * gate on it had to be argued in a paragraph of prose. A comment doing a type's job is a comment that loses. The
 * repair set consumer that comes next reads this union while holding the list of units it is about to rebuild, and
 * an instruction is not available to it. So the distinction is now two arms the compiler forces apart:
 *
 *   * `withheld` — every entry is a recorded exercise of discretion that took the row OUT of the answer's scope.
 *     Someone can be named as the decider, and re-drafting or reading more would not, and should not, change it.
 *   * `defective` — at least one entry is a row this run still OWES, or an unresolved unknown. Carrying a withheld
 *     entry alongside is normal and the withheld list travels with it; nothing is dropped by the split.
 *
 * Nothing about this makes a `withheld` statement read as covered: both arms are outside `complete`, both name
 * their entries, and the negative law R7a set — a statement carrying ANY entry may not use the covered wording —
 * applies to both unchanged.
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
 * unexplained`. On the two entry-carrying arms `excluded` is the sum of BOTH lists, so the split cannot lose a row
 * on its way into an arm. A non-zero residue is refused at construction rather than published, for the same reason
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
 * The name is `entry`, not `violation`, and that is not cosmetic: a value of kind `waived-by-state` under a type
 * called `CoverageViolation` is the same conflation the arm split removes, one level down, and it would have
 * regrown the trap on the item type the moment the arms stopped carrying it. What every kind here has in common —
 * the only thing this union asserts — is that a statement carrying one of them MUST NOT read as covered. Whether
 * it is a decision or a gap is decided once, by `COVERAGE_KIND_CATEGORY` below, and by nothing else.
 *
 * ONE KIND SERVES TWO LEDGERS EXACTLY ONCE, and it is `cannot-determine`: a work item whose ledger status is
 * `cannot-determine` and a read obligation with no end line are the same fact about knowledge — the question was
 * asked and could not be settled — and `detail` is required precisely so a shared kind still names which ledger a
 * row came from. Nothing else is shared. `ledger-excluded` in particular is NOT unread residual: a read obligation
 * the ledger excluded (declaration-only, or contained in another) was removed from that ledger's OWN counted
 * denominator before anything was measured, and folding it into the covered count is how 27 of wcp's 946 rows
 * would have become invisible.
 */
export const COVERAGE_ENTRY_KINDS = [
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
export type CoverageEntryKind = (typeof COVERAGE_ENTRY_KINDS)[number];

export const COVERAGE_ENTRY_CATEGORIES = ["withheld", "defective"] as const;
export type CoverageEntryCategory = (typeof COVERAGE_ENTRY_CATEGORIES)[number];

/**
 * WHICH KINDS ARE DECISIONS AND WHICH ARE DEBTS — the whole arm split, as one table the compiler must see is total.
 *
 * `satisfies Record<CoverageEntryKind, CoverageEntryCategory>` is the mechanism, and it is the reason this is a
 * table and not a list in a comment: a thirteenth kind added above without a row here does not compile. It is
 * declared in the same file and the same batch as the kind union for the same reason `fact-kind-registry` is —
 * one judgement point, reachable from every consumer, with no second copy to drift.
 *
 * THE CRITERION, stated so a new kind can be classified rather than guessed at:
 *   * `withheld` — a RECORDED exercise of discretion took this row out of what the answer is responsible for. A
 *     decider can be pointed at, and re-drawing the plan or buying more reading would not change it and should not.
 *   * `defective` — this row is still OWED and unpaid, or it stands for an unresolved unknown. An unknown is never
 *     `withheld`: "nobody could settle it" is not "somebody decided".
 *
 * `grounding-exempt` is the one row of this table that was a judgement call rather than a reading. It is the
 * obligations carrying `origin: "open"` in the run's own ledger, which the grounding audit is registered NOT to ask
 * about — a registered exemption, with the register as the decider — so it sits with the decisions. It is the
 * closest of the withheld three to the line: nothing verifies that the document states those obligations, which
 * reads like a gap. If a consumer ever needs them in a repair set, that is a planning-layer decision to move this
 * one row, made in the open, and not a silent edit of this table.
 */
export const COVERAGE_KIND_CATEGORY = {
  "unread-residual": "defective",
  "ledger-excluded": "withheld",
  "displaced-by-budget": "defective",
  "waived-by-state": "withheld",
  "claimed-but-unplaced": "defective",
  "undispositioned": "defective",
  "owned-by-no-unit": "defective",
  "grounding-exempt": "withheld",
  "cannot-determine": "defective",
  "open-determination": "defective",
  "unknown-topic": "defective",
  "stated-unknown": "defective"
} as const satisfies Record<CoverageEntryKind, CoverageEntryCategory>;

/** Which side of the split one kind falls on. The table is the authority; this is only the reading of it. */
export function coverageEntryCategory(kind: CoverageEntryKind): CoverageEntryCategory {
  return COVERAGE_KIND_CATEGORY[kind];
}

/**
 * One named entry against a denominator.
 *
 * `ids` may be empty, because some ledgers record only a count: the sealed closure carries
 * `readsDisplacedByBudget` as a number and no id list, and inventing ids for it would be worse than saying how
 * many. It is never CAPPED here — a cap on a conservation residue is where the next silent loss hides — so a
 * caller that must bound a rendering bounds it in its own renderer and says so.
 */
export interface CoverageEntry {
  readonly kind: CoverageEntryKind;
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
  readonly entries: readonly (CoverageEntry | undefined)[];
}

/** What every arm carries: what was counted, and out of which single ledger. */
export interface CoverageStatementSubject {
  readonly subject: string;
  readonly ledger: string;
}

/**
 * The closed union. Four arms, no boolean, and `complete` is unreachable except through the constructor below.
 *
 * `complete` carries the conservation record rather than a bare count so a reader can see the denominator it is a
 * statement about; `vacuous` carries no conservation at all, because there is nothing to conserve and a
 * `total: 0` record next to the word "complete" is precisely the shape 449 produced.
 *
 * `defective` carries BOTH lists. The withheld entries of a defective statement are not folded into the defects
 * and not dropped: a repair set built from `defects` must not contain a row a plan legitimately waived, and a
 * reader of the same statement must still be able to see that the waiver happened. `withheld` may be empty there;
 * on the `withheld` arm it is non-empty by construction, because an empty one is `complete`.
 */
export type CoverageStatement =
  | (CoverageStatementSubject & { readonly state: "complete"; readonly conservation: CoverageConservation })
  | (CoverageStatementSubject & { readonly state: "vacuous"; readonly source: VacuousSource; readonly reason: string })
  | (CoverageStatementSubject & {
      readonly state: "withheld";
      readonly conservation: CoverageConservation;
      /** At least one, ascending by kind then by detail. Never empty: an empty list would be `complete`. */
      readonly withheld: readonly CoverageEntry[];
    })
  | (CoverageStatementSubject & {
      readonly state: "defective";
      readonly conservation: CoverageConservation;
      /** At least one, ascending by kind then by detail. What a repair set may be built from. */
      readonly defects: readonly CoverageEntry[];
      /** The decisions riding along, possibly none. Carried, never dropped, and never a repair target. */
      readonly withheld: readonly CoverageEntry[];
    });

/**
 * One entry, or nothing at all when the ledger holds no such row.
 *
 * Exported because every caller needs it and the alternative is `...(n > 0 ? [entry] : [])` at every site, which is
 * the kind of line that eventually gets written as `[entry]`.
 */
export function coverageEntry(
  kind: CoverageEntryKind,
  rows: number,
  ids: readonly string[],
  detail: string
): CoverageEntry | undefined {
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
 * THE ONLY CONSTRUCTOR. Derives the arm from the counts and from the entry kinds; no caller may state which arm it
 * wants.
 *
 * The order of the tests is the whole point. An absent ledger is decided FIRST, so no row count can override it; an
 * empty ledger is decided SECOND, so `entries: []` over zero rows can never be read as covered; a single defective
 * entry then decides the arm THIRD, so a defect can never be hidden behind a longer list of legitimate withholdings;
 * and only a denominator with no entry at all may be called complete. Displacement, waiving and an empty denominator
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
    .filter((entry): entry is CoverageEntry => entry !== undefined)
    .sort((a, b) => COVERAGE_ENTRY_KINDS.indexOf(a.kind) - COVERAGE_ENTRY_KINDS.indexOf(b.kind) || compare(a.detail, b.detail));
  const defects = entries.filter((entry) => COVERAGE_KIND_CATEGORY[entry.kind] === "defective");
  const withheld = entries.filter((entry) => COVERAGE_KIND_CATEGORY[entry.kind] === "withheld");
  // The conservation is taken over the SUM OF THE TWO LISTS rather than over `entries`, so a row that fell out
  // between the partition and an arm shows up as a residue the constructor refuses instead of as a smaller total.
  const excluded = rowsOf(defects) + rowsOf(withheld);
  const conservation = summarizeCoverage({ total: rows, counted, excluded });
  if (conservation.unexplained !== 0) {
    throw new Error(`The coverage statement about ${subject} does not conserve: ${ledger} holds ${rows} row(s), ${counted} are counted as covered and ${excluded} are accounted for by ${defects.length} defective and ${withheld.length} withheld named entry/entries, leaving ${conservation.unexplained} in no bucket at all`);
  }
  if (defects.length > 0) return { subject, ledger, state: "defective", conservation, defects, withheld };
  if (withheld.length > 0) return { subject, ledger, state: "withheld", conservation, withheld };
  return { subject, ledger, state: "complete", conservation };
}

/** How many of a denominator's rows a list of entries accounts for. */
export function rowsOf(entries: readonly CoverageEntry[]): number {
  return entries.reduce((total, entry) => total + entry.rows, 0);
}

/**
 * EVERY entry a statement carries, defects before the decisions riding with them. Exhaustive, no `default`.
 *
 * It exists so a renderer cannot reach one arm's list and forget the other's: the defective arm's withheld entries
 * are part of what that statement says, and a rendering that printed only `defects` would drop a fact this run
 * recorded. Repair-set consumers want `defects` alone and must reach for it by name.
 */
export function coverageStatementEntries(statement: CoverageStatement): readonly CoverageEntry[] {
  switch (statement.state) {
    case "complete":
      return [];
    case "vacuous":
      return [];
    case "withheld":
      return statement.withheld;
    case "defective":
      return [...statement.defects, ...statement.withheld];
  }
  return assertNever(statement, "coverage statement state");
}

/**
 * One sentence per entry kind, exhaustive with no `default`.
 *
 * `displaced-by-budget` and the determined-negative sentence below are the pair 57B-456 requires to stay
 * distinguishable: "a ceiling this run recorded pushed the read out" and "the read happened and found nothing" are
 * opposite facts about knowledge, and a shared phrase like "not found" would let a reader take the first for the
 * second. Nothing else in this file is allowed to phrase either one.
 *
 * These sentences are BYTE-FROZEN by the arm split: the split changed which arm a statement takes, never what one
 * of its entries says, and `tests/coverage-statement.test.ts` compares all twelve against the pre-split text.
 */
export function coverageEntrySentence(entry: CoverageEntry): string {
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
  return assertNever(entry.kind, "coverage entry kind");
}

/**
 * The sentence for reads that HAPPENED and settled the question negatively.
 *
 * It lives beside `displaced-by-budget` deliberately: the two are the pair a reader most easily conflates, and
 * keeping them in one file is the only way "distinguishable in wording" can be checked in one place. It is NOT an
 * entry kind — a determined negative is knowledge, and counting it against coverage would punish the run for
 * answering.
 */
export function determinedNegativeSentence(rows: number): string {
  return `${rows} obligation${rows === 1 ? "" : "s"} were READ AND SETTLED NEGATIVELY: the window was opened, the thing looked for was not there, and that is a determination rather than a gap.`;
}

/**
 * THE FOUR SENTENCE PREFIXES, exported so a test can assert one is ABSENT without a regex over prose.
 *
 * No prefix is a substring of another — that is a requirement, not a coincidence. "COVERED" and "NOT COVERED"
 * were the first spelling, and a test asserting "the covered wording never appears" passed over "NOT COVERED"
 * because the second contains the first. A wording rule whose own assertion can be fooled by a substring is the
 * instrument-not-verified failure this repository has a memory of. The words are the union's own arm names, which
 * is also the house style `summariseUnitGrounding` already prints.
 *
 * THE WORD `violations` IS DELIBERATELY NOT HERE, and it is not free to come back. `TopicDispositionVerdict` and
 * plan validation use `violations` for something this union does not have: a conclusion that is entirely defects,
 * which `plan-gate.ts` really does refuse a plan on. Two unions, two vocabularies, and the one thing they must
 * never share is a word that means "broken" in one and "broken or deliberate" in the other.
 */
export const COVERAGE_STATEMENT_PREFIXES = {
  complete: "complete:",
  vacuous: "vacuous (",
  withheld: "withheld:",
  defective: "defective:"
} as const satisfies Record<CoverageStatement["state"], string>;

/** One line naming the arm and the arithmetic. The sentence a reader cannot mistake for the other three arms. */
export function coverageStatementSentence(statement: CoverageStatement): string {
  switch (statement.state) {
    case "complete":
      return `${COVERAGE_STATEMENT_PREFIXES.complete} all ${statement.conservation.total} ${statement.subject} in ${statement.ledger} are accounted for, and nothing is withheld.`;
    case "vacuous":
      return `${COVERAGE_STATEMENT_PREFIXES.vacuous}${statement.source}): this run has no ${statement.subject} at all, so no coverage statement about them applies — ${statement.reason}.`;
    case "withheld":
      return `${COVERAGE_STATEMENT_PREFIXES.withheld} of the ${statement.conservation.total} ${statement.subject} in ${statement.ledger}, ${statement.conservation.counted} ${isAre(statement.conservation.counted)} accounted for and ${statement.conservation.excluded} ${isAre(statement.conservation.excluded)} held back by ${statement.withheld.length} recorded decision${plural(statement.withheld.length)} — nobody owes them, and this is not a statement about the rest.`;
    case "defective":
      return `${COVERAGE_STATEMENT_PREFIXES.defective} of the ${statement.conservation.total} ${statement.subject} in ${statement.ledger}, ${statement.conservation.counted} ${isAre(statement.conservation.counted)} accounted for and ${statement.conservation.excluded} ${isAre(statement.conservation.excluded)} not: ${rowsOf(statement.defects)} row${plural(rowsOf(statement.defects))} this run still owes across ${statement.defects.length} named gap${plural(statement.defects.length)}, beside ${rowsOf(statement.withheld)} row${plural(rowsOf(statement.withheld))} a recorded decision held back.`;
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
  for (const entry of coverageStatementEntries(statement)) {
    lines.push(`- ${coverageEntrySentence(entry)}`);
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

function isAre(count: number): string {
  return count === 1 ? "is" : "are";
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
