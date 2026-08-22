/**
 * THE UNIT-PATH COVERAGE COMPANION — epic gate 10's carrier, and the one place a coverage account is worded.
 *
 * WHAT GATE 10 ASKS FOR. "A report refactor must not hide an upstream non-discovery: unknown and coverage residual
 * must reach the coverage output of an appropriate audience." Before this file there was no unit-path companion at
 * all: the section path's `assurance-artifacts.ts` writes a `<document>.coverage.json` whose `complete` field is
 * "work items not pending" — a count with no denominator state, which is the very shape 57B-449 and 57B-456 attack.
 * That file is not touched here — and since 57B-479 retired the golden that pinned it (`assemble-canonical.txt`),
 * it has no byte-level pin at all until R8c removes the section path. This is a new artifact on the new path.
 *
 * FOUR FAMILIES, FOUR LEDGERS, AND NO SINGLE NUMBER. Material obligations are counted against the plan's own
 * accounting (`plan-obligation-conservation.ts`, wcp 847); read obligations against `coverage/read-obligations.json`
 * (wcp 946, cebreo 0); authorized read EXECUTIONS against the sealed closure's `authorizedReads`; determinations
 * against `workitems.json`. Those are four denominators from four ledgers and this file never adds them. A single
 * blended "coverage %" would require exactly the cross-ledger id join 57B-458 measured — 665 of 946 rows silently
 * unmatched because one id segment differs — so there is no such number anywhere below, and a test asserts the
 * rendering contains no percentage at all.
 *
 * EVERY SENTENCE GOES THROUGH `CoverageStatement`. Nothing here decides whether something reads as covered, and
 * nothing here decides whether what is missing is a DECISION or a DEBT — the layer-7 constructor does both, from
 * the counts and from the entry kinds. That is why the companion cannot report cebreo's empty read ledger as a
 * clean run even if a future edit here wanted to, and why a plan legitimately omitting a topic prints `withheld`
 * while an unread residual prints `defective`: the arm is not this file's to choose. This file's only job is to
 * name each entry's kind correctly, and `COVERAGE_KIND_CATEGORY` turns that into the arm.
 *
 * THE PACKET BLOCK RENDERS THE EPOCH-ONLY HALF, AND THAT SPLIT IS FORCED. A unit packet's bytes ARE that unit's
 * cache identity (R6a), so anything the block prints becomes part of what invalidates a written unit. The four
 * families divide cleanly: read coverage, the closure and the determination census are functions of the SEALED
 * EPOCH alone, and cannot move while the epoch stands; the material accounting is a function of the plan being
 * measured, and the topic census is a function of the catalog — perturb one topic and it moves. Putting either of
 * the latter two in the packet would make dividing an unrelated leaf, or editing one topic, force every appendix to
 * be rewritten, which is precisely what R6a's normalization list exists to prevent. So `PacketCoverageFacts` holds
 * the epoch-only half and `CoverageStateFacts` adds the other two for the companion command, which is neither
 * budgeted nor a cache key. Nothing is lost to the author: the material accounting is already printed in every
 * packet's header and obligation tables, and the topic census in the appendix's own facet census.
 *
 * IT TAKES VALUES, NEVER A PATH. `coverage-projection.ts` projects and `coverage-companion-source.ts` loads; this
 * file renders. Same split as `topic-catalog-source.ts`/`topic-catalog.ts` and
 * `unit-packet-source.ts`/`unit-packet.ts`.
 */

import { assertNever } from "../base/artifact-result.ts";
import {
  coverageStatement,
  coverageEntry,
  determinedNegativeSentence,
  renderCoverageStatement,
  type CoverageStatement
} from "../investigation/coverage-statement.ts";
import type { PlanObligationAccounting } from "./plan-obligation-conservation.ts";

export const COVERAGE_COMPANION_VERSION = "coverage-companion-v1";

/**
 * The companion lists every id it holds. Naming the sentinel is the point: an id cap here would bound a
 * conservation residue, and this artifact is under no byte budget that would justify one.
 */
const UNCAPPED = Number.MAX_SAFE_INTEGER;

/**
 * What the appendix packet block bounds. Only ID LISTS — never a count, and never an entry: every bullet states how
 * many rows it stands for before any id is shown, so a bounded block still declares the full size it was cut from,
 * and the companion command renders the same facts unbounded.
 */
const BLOCK_MAX_IDS = 5;

/** One document's material coverage, projected from the ONE ownership derivation. Never recomputed here. */
export interface DocumentCoverageOwnership {
  readonly documentId: string;
  /** Material obligations some unit of this document reaches — ownership's own denominator. */
  readonly reachedObligations: number;
  /** Of those, the ones a unit of this document owns. */
  readonly ownedObligations: number;
  /** Reached and owned by none, by id, ascending. A named plan violation, never a bucket. Uncapped. */
  readonly unownedObligationIds: readonly string[];
  /** Owned here and carrying `origin: "open"`, so the grounding audit does not ask for them. Ascending. */
  readonly groundingExemptIds: readonly string[];
  /** One row per unit of this document, ascending, so a unit owing nothing is a visible zero. */
  readonly ownedByUnit: readonly { readonly unitId: string; readonly owned: number }[];
}

export interface MaterialCoverageFacts {
  /** Gate 1b's four buckets, READ from the recorded plan. The material family's only denominator. */
  readonly accounting: PlanObligationAccounting;
  readonly documents: readonly DocumentCoverageOwnership[];
}

/**
 * What the sealed closure records about authorized reads — or that it records nothing.
 *
 * `not-measured` is required rather than a zero, and that is the closure record's own rule: "ABSENCE of a field in
 * an archived epoch means NOT MEASURED — never 0. No reader may treat a missing value as 'nothing was displaced'."
 * The two R0 baselines were frozen under `knowledge-completeness-v3`, before 57B-451 added these three fields, so
 * that is the arm they take.
 */
export type ClosureReadReading =
  | {
      readonly state: "recorded";
      readonly authorizedReads: number;
      readonly readsDisplacedByBudget: number;
      /** Decision readings the closure marks `displaced`. Reported beside, never added to, the execution count. */
      readonly displacedDispositions: number;
    }
  | { readonly state: "not-measured"; readonly reason: string };

/** One topic's read residual, as the catalog's own row records it. Companion-only: it moves when a topic moves. */
export interface TopicResidualRow {
  readonly topicId: string;
  readonly title: string;
  readonly residualRows: number;
  readonly uncoveredLines: number;
}

/** The read family. Every field is a summary the producer already wrote; nothing here is recounted. */
export interface ReadCoverageFacts {
  /** The one ledger this family's denominator comes from. */
  readonly ledger: string;
  /** Every row of that ledger. NOT its own counted subset: the excluded rows are named below, never folded in. */
  readonly obligationRows: number;
  /** Rows with at least one source window (covered or partial). */
  readonly withWindowRows: number;
  readonly notOpenedRows: number;
  /** Rows whose coverage could not be reconciled — a counted obligation with no end line. */
  readonly unreconcilableRows: number;
  /** Rows the ledger itself excluded before measuring: declaration-only, or contained in another obligation. */
  readonly ledgerExcludedRows: number;
  readonly uncoveredLines: number;
  readonly closure: ClosureReadReading;
}

/**
 * The obligation ledger's own determination census, from `workitems.json` and its digest-sealed rows.
 *
 * Its denominator is the LEDGER'S rows, not the plan's material projection — which is what keeps it epoch-only and
 * therefore safe inside a packet. `determinedNegative` travels here because it is the fact 57B-456 requires to stay
 * distinguishable from displacement, and it is a determination rather than a gap.
 */
export interface ObligationDeterminationFacts {
  readonly ledger: string;
  readonly rows: number;
  readonly cannotDetermineIds: readonly string[];
  readonly openIds: readonly string[];
  readonly determinedNegative: number;
}

/**
 * The unknowns the written units state about themselves, or a named absence.
 *
 * Absent is not zero: a run whose units have not been collected has no unit-stated unknowns to report, and printing
 * "0 unknowns stated" for it would be 449's shape one level up.
 */
export type CollectedUnknownsReading =
  | {
      readonly state: "present";
      readonly ledger: string;
      readonly collectedUnits: number;
      /** One row per collected unit, ascending. A unit stating none is a visible empty list. */
      readonly units: readonly { readonly unitId: string; readonly unknowns: readonly string[] }[];
    }
  | { readonly state: "absent"; readonly ledger: string; readonly reason: string };

/** The catalog family: which topics carry an unknown, and which carry a read residual. Companion-only. */
export interface TopicCoverageFacts {
  readonly ledger: string;
  readonly topics: number;
  readonly unknownTopicIds: readonly string[];
  /** Topics carrying residual rows, descending by rows then ascending by id. Uncapped in the value. */
  readonly topicResidual: readonly TopicResidualRow[];
}

/**
 * THE EPOCH-ONLY HALF: exactly what a unit packet may render. See the file header for why the split is forced.
 *
 * Every member is a function of the sealed epoch, so two packets rendered against one epoch carry identical bytes
 * here however the plan is divided and however the catalog's rows are perturbed.
 */
export interface PacketCoverageFacts {
  readonly read: ReadCoverageFacts;
  readonly determinations: ObligationDeterminationFacts;
  readonly statedUnknowns: CollectedUnknownsReading;
}

export interface CoverageStateFacts extends PacketCoverageFacts {
  readonly version: typeof COVERAGE_COMPANION_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly knowledgeDigest: string;
  readonly planCatalogDigest: string;
  readonly material: MaterialCoverageFacts;
  readonly topics: TopicCoverageFacts;
}

/** One statement with the heading it is rendered under, so both renderings order them the same way. */
export interface TitledCoverageStatement {
  readonly title: string;
  readonly statement: CoverageStatement;
}

/**
 * EVERY STATEMENT THIS RUN CAN MAKE ABOUT COVERAGE, in one fixed order, from the four families.
 *
 * The epoch-only statements come from the same functions the packet uses, so the appendix block and the companion
 * command may differ in how much of a list they print and may never differ in what the run's coverage state IS.
 */
export function coverageStatements(facts: CoverageStateFacts): readonly TitledCoverageStatement[] {
  return [
    { title: "Material obligations: where the plan puts them", statement: materialPlacementStatement(facts.material.accounting) },
    ...facts.material.documents.map((document) => ({
      title: `Material obligations of ${document.documentId}: which unit grounds them`,
      statement: documentOwnershipStatement(document)
    })),
    ...packetCoverageStatements(facts),
    { title: "Topic catalog: which topics carry an unknown", statement: topicUnknownStatement(facts.topics) }
  ];
}

/** The epoch-only statements: exactly the ones a packet renders. Same functions, same order. */
export function packetCoverageStatements(facts: PacketCoverageFacts): readonly TitledCoverageStatement[] {
  return [
    { title: "Read obligations: which have a source window", statement: readWindowStatement(facts.read) },
    { title: "Authorized reads: which were executed", statement: authorizedReadStatement(facts.read) },
    { title: "Obligation determinations: which were settled", statement: determinationStatement(facts.determinations) },
    { title: "Written units: which state an unknown about themselves", statement: statedUnknownStatement(facts.statedUnknowns) }
  ];
}

/** The plan's four buckets as one statement. `inUnits` is the counted arm; the other three are named entries. */
function materialPlacementStatement(accounting: PlanObligationAccounting): CoverageStatement {
  return coverageStatement({
    subject: "material obligations",
    denominator: {
      state: "present",
      ledger: "plan/catalog.json obligation accounting",
      rows: accounting.materialObligations,
      counted: accounting.inUnits
    },
    entries: [
      // One entry PER WAIVING STATE, because "the plan omitted this for an audience" and "the plan cannot determine
      // this" are two different decisions and a single `waived: 799` prints them as one.
      ...accounting.waivedByState.map((row) => coverageEntry(
        "waived-by-state",
        row.obligations,
        accounting.waivedObligations.filter((entry) => entry.state === row.state).map((entry) => entry.workItemId),
        `disposition ${row.state}`
      )),
      coverageEntry(
        "claimed-but-unplaced",
        accounting.unplaced,
        accounting.unplacedObligations.map((row) => row.workItemId),
        "a placing disposition on topic(s) no unit names"
      ),
      coverageEntry(
        "undispositioned",
        accounting.undispositioned,
        accounting.undispositionedObligations.map((row) => row.workItemId),
        "topic(s) carrying no readable disposition"
      )
    ]
  });
}

/** One document's ownership, over the reach denominator the ownership derivation itself publishes. */
function documentOwnershipStatement(document: DocumentCoverageOwnership): CoverageStatement {
  const exempt = document.groundingExemptIds.length;
  return coverageStatement({
    subject: "material obligations reached by this document",
    denominator: {
      state: "present",
      ledger: "plan/catalog.json ownership derivation",
      rows: document.reachedObligations,
      counted: document.ownedObligations - exempt
    },
    entries: [
      coverageEntry("owned-by-no-unit", document.unownedObligationIds.length, document.unownedObligationIds, `reached by ${document.documentId} and owned by no unit of it`),
      coverageEntry("grounding-exempt", exempt, document.groundingExemptIds, 'owned here and carrying origin "open" in this run\'s obligation ledger')
    ]
  });
}

/** The 57B-449 statement: the read-obligation ledger's own rows, and how many have no window. */
function readWindowStatement(read: ReadCoverageFacts): CoverageStatement {
  return coverageStatement({
    subject: "read obligations",
    denominator: { state: "present", ledger: read.ledger, rows: read.obligationRows, counted: read.withWindowRows },
    entries: [
      coverageEntry("unread-residual", read.notOpenedRows, [], `${read.uncoveredLines} unread line(s) across them`),
      coverageEntry("cannot-determine", read.unreconcilableRows, [], "counted read obligations with no end line, so their coverage cannot be reconciled"),
      coverageEntry("ledger-excluded", read.ledgerExcludedRows, [], `declaration-only or contained in another obligation, per ${read.ledger}'s own summary`)
    ]
  });
}

/**
 * The 57B-456 statement, over the closure's OWN denominator.
 *
 * `authorizedReads` and the read-obligation count are two different ledgers — a ReadSpec execution is not a read
 * obligation — so they get two statements. Adding them would be the cross-ledger merge this file exists to refuse.
 */
function authorizedReadStatement(read: ReadCoverageFacts): CoverageStatement {
  const ledger = "the sealed epoch's completeness closure";
  if (read.closure.state === "not-measured") {
    return coverageStatement({ subject: "authorized reads", denominator: { state: "absent", ledger, reason: read.closure.reason }, entries: [] });
  }
  const { authorizedReads, readsDisplacedByBudget } = read.closure;
  return coverageStatement({
    subject: "authorized reads",
    denominator: { state: "present", ledger, rows: authorizedReads, counted: authorizedReads - readsDisplacedByBudget },
    entries: [coverageEntry("displaced-by-budget", readsDisplacedByBudget, [], "a ceiling this run recorded, sealed as closure.readsDisplacedByBudget")]
  });
}

/** Determination over the obligation ledger's own rows: determined, undetermined, still open. Exhaustive. */
function determinationStatement(determinations: ObligationDeterminationFacts): CoverageStatement {
  return coverageStatement({
    subject: "recorded obligations",
    denominator: {
      state: "present",
      ledger: determinations.ledger,
      rows: determinations.rows,
      counted: determinations.rows - determinations.cannotDetermineIds.length - determinations.openIds.length
    },
    entries: [
      coverageEntry("cannot-determine", determinations.cannotDetermineIds.length, determinations.cannotDetermineIds, "ledger status cannot-determine"),
      coverageEntry("open-determination", determinations.openIds.length, determinations.openIds, "ledger status pending or in_progress")
    ]
  });
}

function topicUnknownStatement(topics: TopicCoverageFacts): CoverageStatement {
  return coverageStatement({
    subject: "catalog topics",
    denominator: { state: "present", ledger: topics.ledger, rows: topics.topics, counted: topics.topics - topics.unknownTopicIds.length },
    entries: [coverageEntry("unknown-topic", topics.unknownTopicIds.length, topics.unknownTopicIds, "the topic's own ledger row or one of its obligations is undetermined")]
  });
}

/** The value-passed arm: absent units are a named absence, never a zero. */
function statedUnknownStatement(stated: CollectedUnknownsReading): CoverageStatement {
  if (stated.state === "absent") {
    return coverageStatement({ subject: "collected units", denominator: { state: "absent", ledger: stated.ledger, reason: stated.reason }, entries: [] });
  }
  const withUnknowns = stated.units.filter((row) => row.unknowns.length > 0);
  const statements = withUnknowns.reduce((total, row) => total + row.unknowns.length, 0);
  return coverageStatement({
    subject: "collected units",
    denominator: { state: "present", ledger: stated.ledger, rows: stated.collectedUnits, counted: stated.collectedUnits - withUnknowns.length },
    entries: [coverageEntry("stated-unknown", withUnknowns.length, withUnknowns.map((row) => row.unitId), `${statements} unknown statement(s) across them`)]
  });
}

// --- the two renderings ----------------------------------------------------------------------------------------

/**
 * The standalone companion: every statement, every id, every topic row.
 *
 * Read-only prose. It states no percentage of its own and it never adds two families' rows — the same two
 * prohibitions the unit packet's "What this packet is not" section already declares, restated where a coverage
 * account is actually written.
 */
export function renderCoverageCompanion(facts: CoverageStateFacts): string {
  const lines = [
    `# Coverage companion (${facts.version})`,
    "",
    `- run: ${facts.runId}`,
    `- knowledge epoch: ${facts.knowledgeEpoch} (digest ${facts.knowledgeDigest})`,
    `- plan catalog digest: ${facts.planCatalogDigest}`,
    "",
    "## What this companion is and is not",
    "",
    "It is a projection of four ledgers this run already sealed, each answering for its own rows: the plan's material",
    "obligation accounting, this run's read-obligation ledger, the sealed epoch's completeness closure, and the",
    "obligation ledger's determinations. Every statement below names the ONE ledger its denominator came from. There",
    "is deliberately no combined coverage figure and no percentage anywhere: combining two ledgers' rows requires",
    "joining ids across them, and that join was measured to lose 665 of 946 rows silently. Four statements a reader",
    "must weigh are more useful than one number that is wrong.",
    "",
    "An empty denominator is reported as `vacuous`, never as covered. A run that recorded nothing to measure is not a",
    "run that measured everything, and `ledger-absent` (nobody can tell) and `ledger-empty` (this run genuinely",
    "recorded none) stay two different sentences.",
    ""
  ];

  for (const { title, statement } of coverageStatements(facts)) {
    lines.push(`## ${title}`, "", ...renderCoverageStatement(statement, UNCAPPED), "");
  }

  lines.push(
    "## Reading, in the run's own words",
    "",
    determinedNegativeSentence(facts.determinations.determinedNegative),
    "",
    displacedDispositionSentence(facts.read.closure),
    "That is the disposition side of the same recorded ceiling the authorized-read statement above counts. The two",
    "are reported separately because they count different things (executions, and the obligations those executions",
    "were for), and neither is the same fact as a read that happened and settled the question negatively.",
    "",
    "### Read residual per topic",
    "",
    "Derived from each topic's own catalog row (path/window overlap), never from an id join between the obligation",
    "ledger and the work-item ledger. A topic with no residual row is not listed; that is not a claim it was read.",
    ""
  );
  lines.push(...topicResidualTable(facts.topics.topicResidual));

  lines.push("", "### Material obligations waived, by disposition state", "", "| state | obligations |", "| --- | --- |");
  for (const row of facts.material.accounting.waivedByState) lines.push(`| ${row.state} | ${row.obligations} |`);

  lines.push("", "### Ownership per document", "", "| document | reached | owned | owned by no unit | grounding-exempt |", "| --- | --- | --- | --- | --- |");
  for (const document of facts.material.documents) {
    lines.push(`| ${document.documentId} | ${document.reachedObligations} | ${document.ownedObligations} | ${document.unownedObligationIds.length} | ${document.groundingExemptIds.length} |`);
  }
  lines.push("", "| document | unit | obligations owned |", "| --- | --- | --- |");
  for (const document of facts.material.documents) {
    for (const row of document.ownedByUnit) lines.push(`| ${document.documentId} | ${row.unitId} | ${row.owned} |`);
  }

  lines.push("", "### Unknowns stated by written units", "");
  const stated = facts.statedUnknowns;
  if (stated.state === "absent") lines.push(`No unit summary ledger was read (${stated.ledger}): ${stated.reason}.`);
  else if (stated.collectedUnits === 0) lines.push(`${stated.ledger} is present and records no collected unit, so no unit has stated anything yet.`);
  else {
    for (const row of stated.units) {
      lines.push(`- ${row.unitId} — ${row.unknowns.length === 0 ? "states no unknown" : `${row.unknowns.length} unknown(s)`}`);
      for (const unknown of row.unknowns) lines.push(`  - ${unknown}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The appendix packet block: the epoch-only statements, bounded, for the author writing the coverage chapter.
 *
 * It renders in the appendix only — the deterministic tail, the same gate the facet census and the unbound-evidence
 * enumeration use — because that is the unit gate 10 routes the run's residue through. It asks for nothing and
 * counts nothing: like the reading-boundary block, an author who answers it item by item is paying a Goodhart tax
 * this repository has already measured once.
 */
export function renderCoverageStateBlock(facts: PacketCoverageFacts): string {
  const lines = [
    "## Coverage state of this run (from the sealed ledgers, not from this document)",
    "",
    "These are the coverage facts a coverage chapter has to state, taken from the ledgers that own them. Each line",
    "names the ONE ledger its denominator came from; there is no combined figure and no percentage, because combining",
    "two of these ledgers requires an id join that was measured to lose rows silently. Where a statement reads",
    "`vacuous`, the run recorded no denominator at all — write that, and do not write that the area was covered. Do",
    "not answer these lines one by one, and do not open windows to shorten them.",
    "",
    "Every figure below is a function of the SEALED EPOCH alone. Where this document's material obligations go, and",
    "which unit grounds each of them, is stated in this packet's header and obligation tables; the topic census is in",
    "the facet census above. `excavator coverage-companion --run <run>` renders all four families together.",
    ""
  ];
  for (const { title, statement } of packetCoverageStatements(facts)) {
    lines.push(`- **${title}** — ${renderCoverageStatement(statement, BLOCK_MAX_IDS).join("\n  ")}`);
  }
  lines.push(
    "",
    determinedNegativeSentence(facts.determinations.determinedNegative),
    `${displacedDispositionSentence(facts.read.closure)} A displaced disposition is an authorized read a recorded ceiling pushed out, which is not the same fact as a read that happened and found nothing.`,
    ""
  );
  return lines.join("\n");
}

/**
 * The disposition side of displacement, or the named absence.
 *
 * Exhaustive over the closure reading with no `default`, and the absent arm says "not measured" rather than "0" —
 * the sealed record's own rule, and the arm both R0 baselines take.
 */
function displacedDispositionSentence(closure: ClosureReadReading): string {
  switch (closure.state) {
    case "recorded":
      return `${closure.displacedDispositions} decision reading(s) are sealed as \`displaced\` in this run's closure record.`;
    case "not-measured":
      return `How many decision readings were displaced is NOT MEASURED for this run, not zero: ${closure.reason}.`;
  }
  return assertNever(closure, "closure read reading");
}

/** The residual table. Companion-only, so it is uncapped: nothing here is inside a byte budget. */
function topicResidualTable(rows: readonly TopicResidualRow[]): readonly string[] {
  const lines = ["| topic | title | residual rows | unread lines |", "| --- | --- | --- | --- |"];
  if (rows.length === 0) {
    lines.push("| (none) | no topic of this catalog carries a read residual row | 0 | 0 |");
    return lines;
  }
  for (const row of rows) {
    lines.push(`| ${row.topicId} | ${row.title.replace(/\|/g, "\\|")} | ${row.residualRows} | ${row.uncoveredLines} |`);
  }
  return lines;
}
