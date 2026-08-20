/**
 * The read-coverage denominators one frozen epoch sealed, projected from the ledgers the plan gate already checked.
 *
 * WHY IT IS ITS OWN FILE. `unit-plan-view.ts` carries this projection so the packet source and the companion source
 * read ONE of it, and the companion source imports the view — so the projection cannot live in either of them
 * without a cycle (`tests/layer-order.test.ts` counts `import type` too, and has caught exactly this before).
 *
 * IT PROJECTS, IT DOES NOT MEASURE. Every number below is copied from a summary the producer already wrote:
 * `coverage/read-obligations.json`'s own row count and exclusion counts, `coverage/read-residual.json`'s own status
 * census, and the sealed epoch's completeness closure. Nothing is recounted here, because a second count is a second
 * denominator — and the whole point of the read family is that its denominator is the ledger's, not the report's.
 *
 * THE EXCLUDED ROWS ARE CARRIED, NOT DROPPED. The residual reconciles only the ledger's COUNTED rows (919 of wcp's
 * 946: 26 declaration-only and 1 contained are excluded before measuring). Reporting 919 as the denominator would
 * make 27 rows invisible; reporting 946 while counting all of them as covered would be worse. So both numbers
 * travel, and the coverage statement puts the difference in a named bucket.
 *
 * ABSENCE IS NEVER ZERO. The three displacement fields arrived with 57B-451 under
 * `knowledge-completeness-v4`; both R0 baselines are v3 and carry none of them. The closure record's own comment
 * makes the rule explicit — "ABSENCE of a field in an archived epoch means NOT MEASURED — never 0" — so this file
 * returns the `not-measured` arm naming which field was missing, and the companion prints that instead of a zero.
 */

import { FROZEN_READ_LEDGER } from "../investigation/read-residual-exposure.ts";
import type { InvestigationWorkItem } from "../base/types.ts";
import type {
  ClosureReadReading,
  CollectedUnknownsReading,
  DocumentCoverageOwnership,
  PacketCoverageFacts,
  ReadCoverageFacts,
  TopicCoverageFacts
} from "./coverage-companion.ts";
import type { DocumentObligationOwnership } from "./plan-obligation-conservation.ts";
import { statusDetermination } from "./topic-candidate.ts";
import type { TopicCatalogArtifact } from "./topic-catalog.ts";
import type { TopicCatalogSource } from "./topic-catalog-source.ts";

/** The two ledgers this file names, so a statement and its source cannot drift into two spellings. */
export const WORK_ITEM_LEDGER = "workitems.json";
export const TOPIC_CATALOG_LEDGER = "plan/topics.json";
/** The unit ledger the companion path reads and a packet deliberately does not. */
export const UNIT_LEDGER_RELATIVE_PATH = "units/collected.json";

/**
 * The read family, projected from the two coverage ledgers' OWN summaries.
 *
 * The row count is taken from the ARRAY and cross-checked against the ledger's own `summary.total`, and the
 * residual's reconciled count plus the ledger's exclusions is cross-checked against the same number: a
 * disagreement means the summary and the rows are not about the same set, which would make every statement built
 * on either of them unfalsifiable. Both are named throws rather than a preference for one of the two.
 */
function projectSealedReadCoverage(source: TopicCatalogSource): ReadCoverageFacts {
  const obligations = source.obligations;
  const rows = obligations.obligations.length;
  const summary = obligations.summary;
  if (summary.total !== rows) {
    throw new Error(`${FROZEN_READ_LEDGER} summarises ${summary.total} obligation(s) but holds ${rows} row(s); the summary and the rows are not about the same set, so no coverage statement over either is checkable`);
  }
  const residual = source.residual.summary;
  const ledgerExcludedRows = summary.excludedDeclarationOnly + summary.excludedContained;
  if (residual.counted + ledgerExcludedRows !== rows) {
    throw new Error(`${FROZEN_READ_LEDGER} holds ${rows} row(s), of which ${ledgerExcludedRows} are excluded, but coverage/read-residual.json reconciled ${residual.counted}; the two ledgers do not partition the same denominator`);
  }
  return {
    ledger: FROZEN_READ_LEDGER,
    obligationRows: rows,
    withWindowRows: residual.covered + residual.partial,
    notOpenedRows: residual.notOpened,
    unreconcilableRows: residual.cannotDetermine,
    ledgerExcludedRows,
    uncoveredLines: residual.uncoveredLines,
    closure: projectClosure(source)
  };
}

/**
 * The three displacement figures, or the named absence.
 *
 * All three are required together: they came in one change, and a record holding one but not another is a shape
 * nothing has ever written. Naming the missing field in the reason is what makes the absence actionable — an
 * operator reading it knows the answer is "re-freeze under the current assurance version", not "nothing happened".
 */
function projectClosure(source: TopicCatalogSource): ClosureReadReading {
  const closure = source.knowledge.completeness?.closure;
  if (!closure) {
    return { state: "not-measured", reason: `the sealed epoch of run ${source.knowledge.runId} carries no completeness closure at all` };
  }
  const { authorizedReads, readsDisplacedByBudget } = closure;
  const displacedDispositions = closure.decisions?.displaced;
  if (authorizedReads === undefined || readsDisplacedByBudget === undefined || displacedDispositions === undefined) {
    const missing = [
      authorizedReads === undefined ? "closure.authorizedReads" : undefined,
      readsDisplacedByBudget === undefined ? "closure.readsDisplacedByBudget" : undefined,
      displacedDispositions === undefined ? "closure.decisions.displaced" : undefined
    ].filter((name): name is string => name !== undefined);
    return {
      state: "not-measured",
      reason: `this run's sealed completeness record (${source.knowledge.completeness.version}) declares no ${missing.join(", ")}, and an absent field in an archived epoch means NOT MEASURED rather than zero`
    };
  }
  return { state: "recorded", authorizedReads, readsDisplacedByBudget, displacedDispositions };
}

/**
 * The unit-stated-unknowns reading a unit packet ALWAYS uses.
 *
 * Absence with its reason, never a zero, and a constant rather than a per-call string so that neither the packet's
 * bytes nor any unit's cache identity can drift on a reworded explanation. The reason it is absent at all is a
 * requirement, not a shortcut: the packet's bytes ARE the unit's cache identity (R6a), so quoting what sibling
 * units have stated would make drafting any unit of a document rewrite that document's appendix.
 */
export const PACKET_STATED_UNKNOWNS: CollectedUnknownsReading = {
  state: "absent",
  ledger: UNIT_LEDGER_RELATIVE_PATH,
  reason: "a unit packet's coverage block is derived from this run's sealed ledgers only, so that collecting a sibling unit cannot change this unit's cache identity; run `excavator coverage-companion` for the unknowns the written units have stated"
};

/**
 * THE ONE ENTRY POINT: the epoch-only coverage families of one loaded, digest-checked source.
 *
 * Four callers need this value — the plan view, the plan-time budget measure (which renders candidate packets before
 * any plan is recorded), the packet loader and the companion command — and four spellings of "what is this run's
 * read coverage" would be four denominators, which is the one thing the epic forbids outright. So it is projected
 * once, here, and threaded unchanged.
 *
 * IT DELIBERATELY DOES NOT TOUCH THE CATALOG OR THE PLAN. The determination census counts `workitems.json`'s OWN
 * rows rather than the plan's material projection of them, precisely so that perturbing one topic or dividing one
 * leaf cannot change a byte of what a packet renders — see the header of `coverage-companion.ts`. `statedUnknowns`
 * is the packet constant for the same reason; the companion command replaces exactly that one field.
 */
export function projectEpochCoverage(source: TopicCatalogSource): PacketCoverageFacts {
  const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const rows = source.workItems;
  const ofDetermination = (which: "determined" | "undetermined" | "open"): string[] => rows
    .filter((row) => statusDetermination(row.status) === which)
    .map((row) => row.id)
    .sort(ascending);
  return {
    read: projectSealedReadCoverage(source),
    determinations: {
      ledger: WORK_ITEM_LEDGER,
      rows: rows.length,
      cannotDetermineIds: ofDetermination("undetermined"),
      openIds: ofDetermination("open"),
      determinedNegative: rows.filter((row) => row.status === "searched-not-found").length
    },
    statedUnknowns: PACKET_STATED_UNKNOWNS
  };
}

/** The catalog family: companion-only, because it moves whenever a topic does. */
export function projectTopicCoverage(catalog: TopicCatalogArtifact): TopicCoverageFacts {
  const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    ledger: TOPIC_CATALOG_LEDGER,
    topics: catalog.topics.length,
    unknownTopicIds: catalog.topics.filter((topic) => topic.unknown).map((topic) => topic.topicId).sort(ascending),
    topicResidual: catalog.topics
      .filter((topic) => topic.completeness.residualRows > 0)
      .map((topic) => ({
        topicId: topic.topicId,
        title: topic.title,
        residualRows: topic.completeness.residualRows,
        uncoveredLines: topic.completeness.uncoveredLines
      }))
      .sort((a, b) => b.residualRows - a.residualRows || ascending(a.topicId, b.topicId))
  };
}

/**
 * One document's material coverage, projected from the ownership derivation the audit and the packet already share.
 *
 * The grounding exemption uses the SAME predicate `auditUnitGrounding` applies — the owner's own ledger row carries
 * `origin: "open"` — because a second spelling of an exemption is a second exemption. Nothing is recounted: the
 * reach denominator and the unowned list are the derivation's own fields.
 */
export function projectDocumentCoverage(
  documents: readonly DocumentObligationOwnership[],
  workItems: ReadonlyMap<string, InvestigationWorkItem>
): readonly DocumentCoverageOwnership[] {
  const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return documents.map((document) => ({
    documentId: document.documentId,
    reachedObligations: document.reachedObligations,
    ownedObligations: document.obligations.length,
    unownedObligationIds: document.unowned.map((row) => row.workItemId).sort(ascending),
    groundingExemptIds: document.obligations
      .filter((row) => workItems.get(row.workItemId)?.origin === "open")
      .map((row) => row.workItemId)
      .sort(ascending),
    ownedByUnit: document.ownedByUnit.map((row) => ({ unitId: row.unitId, owned: row.owned }))
  }));
}
