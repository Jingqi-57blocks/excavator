/**
 * THE CROSS-UNIT CONSISTENCY CHECKER (R7c): the seven content-level properties no collect gate can see, checked
 * over an assembled document and reported as findings that NAME THE UNITS.
 *
 * WHAT IT REFUSES TO DO, first, because it is the load-bearing constraint. It does not re-check topic coverage,
 * topic disposition, the grounding audit, the synthesis backlink or the child-digest rule. Those have denominators
 * of their own, one level down, and a second derivation of any of them would be a second denominator — which is
 * the one thing gate 1b forbids. What is left after subtracting them is exactly what this file checks: properties
 * that are invisible to a gate looking at ONE unit, or that nothing looks at at all. `whyCollectCannotSee` states
 * that per class, as an exhaustive switch, so an eighth class cannot be added without answering the question that
 * justifies the file existing.
 *
 * THE SEVEN CLASSES, and the measured gap each one closes:
 *
 *   * `terminology-drift` — one term, two meanings, inside one document. `summary.terminology` is required from
 *     day one and shape-checked per unit; nothing ever compares two units' definitions, because collect audits
 *     one unit at a time.
 *   * `unknown-overclaim` — a `fact` or `inferred` claim linked to an obligation this run recorded as
 *     `cannot-determine` or `searched-not-found`. BOTH grounding gates ask whether a SATISFYING claim EXISTS
 *     (`claimsSatisfying`, `auditWorkItemClaimCoverage`); neither forbids an additional claim that overstates the
 *     same obligation. So an `unavailable` claim and a `fact` claim citing one unanswerable obligation pass today,
 *     and the document asserts as settled a thing the ledger says nobody could settle.
 *   * `cross-unit-contradiction` — one obligation asserted by one unit and declared unavailable by another, and
 *     two units disagreeing about which side of a comparison a piece of evidence is on. `validateComparisonSides`
 *     is per claim; the marker rules are per claim; nothing compares two units' claims about one subject.
 *   * `dangling-reference` — a `](#…)` a model wrote that the assembled document cannot resolve, an explicit
 *     `<a id>` the document holds twice, and a claim citing a work item id this run's ledger does not hold. R7b's
 *     anchor test covers the links the ASSEMBLER writes and its author said so by name: "true of the renderer,
 *     not of the document". The unit path never validates a claim's `workItemIds` at all.
 *   * `policy-violation` — an implementation identifier in the visible prose of a document whose lens keeps them
 *     in evidence (`identifierPlacement: "evidence-only"`), and recommendation language nothing negates. The
 *     advice check exists and runs on the SECTION path's assembled report only (`run.ts`); no unit ever sees it.
 *     Nothing anywhere reads `identifierPlacement` against prose.
 *   * `chapter-contract` — a deliverable whose numbered chapters are not `1..N` for the N requirement rows this
 *     run recorded for it. Every template says its `##` chapters are the fixed contract of the document, and until
 *     this class nothing executed that sentence: a measured run wrote ELEVEN numbered chapters into a document
 *     whose plan recorded TEN requirement rows, and no gate went red. The extra chapter's prose answered no
 *     recorded requirement, so it was content outside the surface the run declares it audited. It counts and
 *     orders and NEVER compares title text — the titles are written in the run's output language, so matching them
 *     against the English template headings would red every correct non-English run. Its one vacuous arm is about
 *     the CONTRACT, never about the document: a run that recorded no requirement row for a document (the
 *     `request-append` door grows `plan/requests.json` only) has no chapter count to hold it to. "The document
 *     wrote no numbered chapter" is a FINDING, not an absence of subject — otherwise the cheapest way past this
 *     gate would be to write no chapter at all.
 *   * `prd-deliverable` — a PRD deliverable whose own words break the four things `prd-feature.md` and
 *     `writing-rules.md` state about them: no acceptance checkbox lists (the acceptance chapter was deleted from
 *     the template, and a model that learnt the old shape writes it back), no `AC-\d+` series (the trace index
 *     "defines no other id series"), `FR-`/`PAGE-` ids of exactly three digits and no id defined twice, and no
 *     storage-schema vocabulary outside the collapsed evidence block. The contract rules are gates; the
 *     storage-schema one is a `warning` tripwire, because it is decided by a word list and a word list cannot be
 *     complete. It reads
 *     VISIBLE prose only, through `visibleUnitText` — the same authority the claim-binding contract uses — so the
 *     DDL a PRD's evidence blocks legitimately carry is not a leak, and a fenced Markdown sample is a quotation.
 *     Its one vacuous arm is about the CONTRACT, never about the document, for the same reason the chapter class
 *     states: the document TASK comes from the run's recorded request, so no prose can write its way out of the
 *     rules — a document that is not a PRD has no PRD word-form contract, and every other document is silent.
 *
 * IT IS A PURE FUNCTION OF VALUES. No path, no I/O, no clock, no model: the caller hands over the collected units'
 * bytes, the assembled document's bytes, the obligation ledger and the sealed evidence ids. Two runs of one input
 * produce one byte sequence, which is what makes the repair set derived from it reproducible.
 *
 * ZERO FINDINGS AND NOTHING TO CHECK ARE TWO SENTENCES. Every class reports what it EXAMINED — `examined` with a
 * count and the noun it counted, or `vacuous` with the reason there was no object — and there is no `passed`
 * boolean anywhere. "0 findings over 3 terms defined twice" and "no term is defined twice in this document" are
 * different facts about a run, and R4b's three-state discipline is why they are not allowed to render the same.
 *
 * EVERY FINDING NAMES AT LEAST ONE UNIT, and that is asserted rather than typed: a finding nobody can act on is
 * this checker's own failure, not a report about the run, so it throws with the finding in the message.
 *
 * WHAT IT DOES NOT DECIDE. Which side of a disagreement is right. When two units define one term differently,
 * both are named: choosing the majority meaning would be Core making a semantic judgement about model prose, and
 * the repair is "make them agree", which an author does. The cost is stated rather than hidden — a three-unit
 * disagreement puts three units in the repair set — and the alternative was measured against the rule that Core
 * states facts and never resolves content.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { EvidenceMarker, InvestigationWorkItem, SectionClaim, WorkItemStatus } from "../base/types.ts";
import { chapterInventory, describeChapterProblem, unterminatedFenceClause, type ChapterProblem } from "./chapter-inventory.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import {
  describePrdProblem,
  duplicateAnchorDefinitions,
  prdProblemSeverity,
  scanPrdUnitProse,
  type PrdProblem
} from "./prd-deliverable-checks.ts";
import { unnegatedAdvice } from "./recommendation-language.ts";
import type { IdentifierPlacement } from "./report-policy-registry.ts";
import type { ReportAudience, ReportIntent } from "./report-request-v2.ts";
import { anchorReferences, explicitAnchorIds, readDocumentAnchors } from "./unit-document-anchors.ts";
import type { UnitSummary } from "./unit-output.ts";
import { compareUnitIds } from "./unit-paths.ts";

export const UNIT_CONSISTENCY_VERSION = "unit-consistency-v1";

/**
 * The obligation statuses a document may not speak about as settled.
 *
 * Exactly the two the ledger uses for "the question was asked and the answer is not a fact": `cannot-determine`
 * (nobody could settle it) and `searched-not-found` (looked for, absent). `not-applicable` is deliberately NOT
 * here — "this does not apply" is a recorded decision, and a claim stating a fact beside it is not an overclaim
 * about an unknown. Widening this list would widen the repair set, and a repair set is required to be exact.
 */
export const UNKNOWN_OBLIGATION_STATUSES: readonly WorkItemStatus[] = ["cannot-determine", "searched-not-found"];

/**
 * The markers that assert content rather than report its absence.
 *
 * `verified` is not here: for a `searched-not-found` obligation a linked `verified` claim reusing the search
 * receipt is exactly what the grounding rule REQUIRES, so calling it an overclaim would make the required shape
 * illegal. `inferred` is here because an inference presented in a document reads as a statement about the system,
 * and the ledger says the underlying question has no answer.
 */
export const OVERCLAIM_MARKERS: readonly EvidenceMarker[] = ["fact", "inferred"];

/**
 * The markers that state something about an obligation, for the contradiction pair: everything but `unavailable`.
 *
 * `inferred` IS here, and keeping it out was an inconsistency worth naming: the overclaim class treats an inference
 * as a statement about the system ("an inference presented in a document reads as a statement about the system"),
 * so excluding it here would have let one unit infer a conclusion about an obligation while another unit recorded
 * that nobody could reach one — a document contradicting itself, with no finding. One reading of `inferred`, used
 * by both classes.
 */
const ASSERTING_MARKERS: readonly EvidenceMarker[] = ["fact", "verified", "inferred"];

export const CONSISTENCY_FINDING_KINDS = [
  "terminology-drift",
  "unknown-overclaim",
  "cross-unit-contradiction",
  "dangling-reference",
  "policy-violation",
  "chapter-contract",
  "prd-deliverable"
] as const;
export type ConsistencyFindingKind = (typeof CONSISTENCY_FINDING_KINDS)[number];

/**
 * What one finding costs the run.
 *
 * `error` is a gate: the command exits non-zero on it, so a pipeline stops. `warning` is a tripwire: it is
 * reported, located and carried into the repair set like anything else, and it does NOT fail the check. The
 * distinction exists because one rule in this checker is decided by a vocabulary list (the PRD technical-leak
 * shape) and a vocabulary list cannot be complete — a rule that must miss cases has no business stopping a
 * pipeline. Every other class is `error`, and `tests/unit-consistency.test.ts` asserts that census so a second
 * warning cannot appear without a decision.
 */
export type ConsistencyFindingSeverity = "error" | "warning";

/**
 * WHY THE COLLECT GATES CANNOT SEE THIS CLASS — one clause per class, exhaustive, no `default`.
 *
 * It is the whole justification for this file, so it is a function the compiler counts rather than a paragraph.
 * Adding a class means answering "and what already checks this?", and if the honest answer is "the collect gate",
 * the class does not belong here.
 */
export function whyCollectCannotSee(kind: ConsistencyFindingKind): string {
  switch (kind) {
    case "terminology-drift":
      return "collect audits one unit at a time, so the other definition of a term — in another unit's summary — is not in anything it reads";
    case "unknown-overclaim":
      return "both grounding gates ask whether a satisfying claim EXISTS and neither forbids an additional claim that overstates the same obligation, so an unavailable claim beside a fact claim on one unanswerable obligation passes";
    case "cross-unit-contradiction":
      return "the marker rules and the comparison-sides rule are per claim inside one unit, so two units' claims about one obligation or one piece of evidence are never compared";
    case "dangling-reference":
      return "assembly resolves the links IT writes and nothing resolves the ones a model wrote in unit prose; a claim's workItemIds are not validated anywhere on the unit path";
    case "policy-violation":
      return "the advice check runs on the section path's assembled report only, and no gate reads the lens policy's identifier placement against prose";
    case "chapter-contract":
      return "a document's chapter set is the concatenation of every unit's prose, so no gate looking at one unit can count it, and nothing anywhere reads the run's recorded requirement rows back against the deliverable they were materialized for";
    case "prd-deliverable":
      return "no gate on the unit path learns which document TASK a unit is being written for — the intent lives on the request the assembler resolves per document — so nothing there can apply a rule that holds of PRDs and of nothing else, and an anchor's uniqueness is a property of every unit's prose concatenated";
  }
  return assertNever(kind, "consistency finding kind");
}

/** One unit as the checker consumes it. Every field required: an absent one would be a class silently skipped. */
export interface ConsistencyUnit {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  readonly title: string;
  /** The bytes of this unit's `content.md`, as its ledger row vouches for them. */
  readonly content: string;
  readonly claims: readonly SectionClaim[];
  readonly summary: UnitSummary;
}

/** One assembled document as the checker consumes it. */
export interface ConsistencyDocument {
  readonly documentId: string;
  /** The assembled deliverable's bytes: the object the anchor checks resolve against. */
  readonly markdown: string;
  readonly audience: ReportAudience;
  /**
   * The document's TASK, from the same recorded request row the audience comes from.
   *
   * It is carried beside the audience rather than derived from it because the two are orthogonal and the PRD
   * rules key on THIS one: `mapLegacyDocumentRequest` sends a prd request to the `product-manager` READER with
   * the `prd` INTENT, so an overview for a product manager and a PRD share an audience and share no word-form
   * contract. A rule keyed on the audience would red every product overview in the run.
   */
  readonly intent: ReportIntent;
  /** From this document's lens policy, which plan validation has already pinned to the registry. */
  readonly identifierPlacement: IdentifierPlacement;
  /**
   * How many numbered chapters this deliverable owes: the number of template-section requirement rows THIS RUN
   * recorded for it, or null when it recorded none.
   *
   * It comes from the run's own `contract/requirements.json` rather than from a template file on disk. A template
   * is what the code says today; the requirement rows are what the run committed to, and a gate that re-read the
   * template would change its verdict about an archived run every time a heading moved.
   *
   * NULL IS A REAL STATE OF A REAL RUN, not a missing argument, which is why the field is required and its type
   * admits it. `contract/requirements.json` is written once by prepare; the supported `request-append` door grows
   * `plan/requests.json` only. So a run that was asked for one more audience assembles a document the contract
   * never recorded a row for — and the epic's own headline case would otherwise make this checker throw and
   * produce NO reading for ANY document of that run. Null is reported as `vacuous` with that reason, which leaves
   * the other five classes speaking.
   */
  readonly plannedChapterCount: number | null;
  /** Every unit of this document, in the plan's one collection order. Never empty. */
  readonly units: readonly ConsistencyUnit[];
}

export interface ConsistencyInput {
  /** In the plan's document order; the result republishes it rather than re-sorting. */
  readonly documents: readonly ConsistencyDocument[];
  /** This run's obligation ledger by id — the same map the grounding audit does its equality lookup in. */
  readonly workItems: ReadonlyMap<string, InvestigationWorkItem>;
  /** The evidence ids the epoch sealed: the denominator of "is this token an implementation identifier". */
  readonly frozenEvidenceIds: readonly string[];
}

export interface TermDefinition {
  readonly unitId: string;
  readonly term: string;
  readonly meaning: string;
}

/** One side of a marker contradiction: which unit said it, in which claim, with which marker. */
export interface ClaimReference {
  readonly unitId: string;
  readonly claimId: string;
  readonly marker: EvidenceMarker;
}

export type ContradictionConflict =
  | {
      readonly shape: "incompatible-markers";
      readonly workItemId: string;
      readonly workItemStatus: WorkItemStatus;
      /** Claims asserting the subject is established (`fact` / `verified`), ascending. */
      readonly asserting: readonly ClaimReference[];
      /** Claims declaring it unavailable, ascending. */
      readonly unavailable: readonly ClaimReference[];
    }
  | {
      readonly shape: "comparison-side-disagreement";
      /**
       * Every pair of evidence ids these two claims place differently, each pair ascending. Never empty.
       *
       * A LIST OF PAIRS rather than one pair: two claims grouping three ids one way and three ways disagree about
       * three pairs, and reporting that as three findings triples the count of one disagreement between one pair
       * of units. The repair is the same either way, so the finding says what it is: one disagreement, these pairs.
       */
      readonly evidencePairs: readonly (readonly string[])[];
      /** The claim that puts them on ONE side of its comparison. */
      readonly sameSide: ClaimReference;
      /** The claim that puts them on TWO sides of its comparison. */
      readonly differentSides: ClaimReference;
    };

export type DanglingReference =
  | { readonly shape: "unresolvable-anchor"; readonly target: string }
  | { readonly shape: "duplicate-anchor"; readonly anchorId: string; readonly occurrences: number }
  | { readonly shape: "unknown-work-item"; readonly claimId: string; readonly workItemId: string };

export type PolicyViolation =
  | { readonly shape: "identifier-in-prose"; readonly evidenceId: string; readonly excerpt: string }
  | { readonly shape: "recommendation-language"; readonly pattern: string; readonly excerpt: string };

/**
 * One finding. Every arm carries the units it names, so a repair set can be built from any of them, and every arm
 * carries its own `severity` — a required field rather than a lookup, so a new arm cannot inherit a cost nobody
 * chose for it. Six of the seven classes can only ever be `error`; see `ConsistencyFindingSeverity`.
 */
export type ConsistencyFinding =
  | {
      readonly kind: "terminology-drift";
      readonly documentId: string;
      readonly unitIds: readonly string[];
      readonly severity: ConsistencyFindingSeverity;
      readonly statement: string;
      readonly term: string;
      readonly definitions: readonly TermDefinition[];
    }
  | {
      readonly kind: "unknown-overclaim";
      readonly documentId: string;
      readonly unitIds: readonly string[];
      readonly severity: ConsistencyFindingSeverity;
      readonly statement: string;
      readonly claimId: string;
      readonly marker: EvidenceMarker;
      readonly workItemId: string;
      readonly workItemStatus: WorkItemStatus;
    }
  | {
      readonly kind: "cross-unit-contradiction";
      readonly documentId: string;
      readonly unitIds: readonly string[];
      readonly severity: ConsistencyFindingSeverity;
      readonly statement: string;
      readonly conflict: ContradictionConflict;
    }
  | {
      readonly kind: "dangling-reference";
      readonly documentId: string;
      readonly unitIds: readonly string[];
      readonly severity: ConsistencyFindingSeverity;
      readonly statement: string;
      readonly reference: DanglingReference;
    }
  | {
      readonly kind: "policy-violation";
      readonly documentId: string;
      readonly unitIds: readonly string[];
      readonly severity: ConsistencyFindingSeverity;
      readonly statement: string;
      readonly violation: PolicyViolation;
    }
  | {
      readonly kind: "chapter-contract";
      readonly documentId: string;
      /**
       * Every unit of the document.
       *
       * The chapter set is the concatenation of every unit's prose, and Core does not decide WHICH unit should
       * have written the missing chapter or dropped the extra one — that is a judgement about content, and the
       * repair is "make the document's chapters 1..N", which an author performs across the units. Same doctrine,
       * and the same stated cost, as terminology-drift naming every unit that defines the term.
       */
      readonly unitIds: readonly string[];
      readonly severity: ConsistencyFindingSeverity;
      readonly statement: string;
      readonly problem: ChapterProblem;
    }
  | {
      readonly kind: "prd-deliverable";
      readonly documentId: string;
      /**
       * The unit whose prose holds it — or, for a duplicated trace anchor, every unit that defines the id.
       *
       * Unlike the chapter contract, four of these five shapes ARE a property of one unit's bytes: a checkbox
       * line, an `AC-\d+` token, a malformed anchor and a leaked storage token each live in one unit's prose, so
       * the finding says which one to open.
       * Uniqueness is the exception and names every definer, because the repair is "make the ids distinct" and
       * this checker does not decide which of the two lines should be renumbered.
       */
      readonly unitIds: readonly string[];
      readonly severity: ConsistencyFindingSeverity;
      readonly statement: string;
      readonly problem: PrdProblem;
    };

/**
 * What one class examined in one document. Two arms, no boolean.
 *
 * `examined` carries the count AND the noun it counted, because "8" is not a fact anybody can check and "8 terms
 * defined more than once" is. `vacuous` carries the reason there was nothing, so "no unit defines a term" and "no
 * term is defined twice" stay two different readings of a run.
 */
export type ClassObjects =
  | { readonly state: "examined"; readonly objects: number; readonly subject: string }
  | { readonly state: "vacuous"; readonly reason: string };

export interface ConsistencyClassReading {
  readonly kind: ConsistencyFindingKind;
  readonly documentId: string;
  readonly objects: ClassObjects;
  readonly findings: number;
  readonly statement: string;
}

export interface ConsistencyResult {
  readonly version: typeof UNIT_CONSISTENCY_VERSION;
  /**
   * In the input's document order — which is the plan's, and `plan-artifacts.ts` sorts that by `localeCompare`.
   *
   * Stated as "the plan's order" rather than "ascending" on purpose: naming a comparator here would be a SECOND
   * claim about the ordering, and the findings below are ordered by `compareUnitIds` (code point), so the two
   * disagree for ids differing only in punctuation. One authority — the plan — and one place that sorts.
   */
  readonly documents: readonly string[];
  /** One row per (document, class): the plan's document order, then classes in `CONSISTENCY_FINDING_KINDS` order. */
  readonly readings: readonly ConsistencyClassReading[];
  /** Totally ordered by (documentId, class, statement) under `compareUnitIds`, so one input has one byte form. */
  readonly findings: readonly ConsistencyFinding[];
}

/** The sentence one class reading prints. Exhaustive over the two arms: the two can never render as one. */
export function describeClassReading(reading: ConsistencyClassReading): string {
  switch (reading.objects.state) {
    case "examined":
      return `checked: ${reading.kind} over ${reading.objects.objects} ${reading.objects.subject} of ${reading.documentId} — ${reading.findings} finding(s)`;
    case "vacuous":
      return `vacuous: ${reading.kind} had no object to check in ${reading.documentId} — ${reading.objects.reason}`;
  }
  return assertNever(reading.objects, "consistency class objects");
}

/** One line naming what a finding found, per arm. Exhaustive, so the union cannot grow an unreported arm. */
export function describeFinding(finding: ConsistencyFinding): string {
  switch (finding.kind) {
    case "terminology-drift":
      return `term ${JSON.stringify(finding.term)} is defined ${finding.definitions.length} time(s) with more than one meaning`;
    case "unknown-overclaim":
      return `claim ${finding.claimId} (${finding.marker}) links obligation ${finding.workItemId} recorded as ${finding.workItemStatus}`;
    case "cross-unit-contradiction":
      return finding.conflict.shape === "incompatible-markers"
        ? `obligation ${finding.conflict.workItemId} is asserted and declared unavailable by different units`
        : `${finding.conflict.evidencePairs.length} evidence pair(s) are one comparison side in ${finding.conflict.sameSide.claimId} and two in ${finding.conflict.differentSides.claimId}`;
    case "dangling-reference":
      switch (finding.reference.shape) {
        case "unresolvable-anchor":
          return `link target ${JSON.stringify(`#${finding.reference.target}`)} resolves to nothing in the assembled document`;
        case "duplicate-anchor":
          return `anchor id ${JSON.stringify(finding.reference.anchorId)} is emitted ${finding.reference.occurrences} times`;
        case "unknown-work-item":
          return `claim ${finding.reference.claimId} cites work item ${finding.reference.workItemId}, which this run's ledger does not hold`;
      }
      return assertNever(finding.reference, "dangling reference shape");
    case "policy-violation":
      return finding.violation.shape === "identifier-in-prose"
        ? `evidence id ${finding.violation.evidenceId} appears in visible prose`
        : `advice wording ${finding.violation.pattern} is not negated`;
    case "chapter-contract":
      return finding.problem.shape === "chapter-count"
        ? `the deliverable writes ${finding.problem.found} numbered chapter(s) against ${finding.problem.expected} recorded requirement row(s)`
        : `the deliverable's ${finding.problem.expected} chapter(s) are numbered ${finding.problem.ordinals.join(", ")} rather than 1..${finding.problem.expected}`;
    case "prd-deliverable":
      switch (finding.problem.shape) {
        case "acceptance-residue":
          return `${finding.problem.occurrences} acceptance checkbox line(s) are in the prd deliverable's visible prose`;
        case "forbidden-anchor-series":
          return `acceptance id ${finding.problem.token} is in the prd deliverable's visible prose`;
        case "anchor-shape":
          return `${finding.problem.token} is not one of the two trace-anchor shapes (FR-### and PAGE-###)`;
        case "anchor-duplicate":
          return `trace anchor ${finding.problem.anchorId} is defined ${finding.problem.definitions} times in one deliverable`;
        case "technical-leak":
          return `storage-schema token ${JSON.stringify(finding.problem.token)} is in the prd deliverable's visible prose`;
      }
      return assertNever(finding.problem, "prd problem shape");
  }
  return assertNever(finding, "consistency finding");
}

/** Run every class over every document. Deterministic: same values, same findings, same order. */
export function checkUnitConsistency(input: ConsistencyInput): ConsistencyResult {
  const findings: ConsistencyFinding[] = [];
  const readings: ConsistencyClassReading[] = [];
  for (const document of input.documents) {
    if (document.units.length === 0) {
      throw new Error(`Document ${JSON.stringify(document.documentId)} was handed to the consistency checker with no unit; a document with no unit is not a document this run wrote`);
    }
    const anchors = readDocumentAnchors(document.markdown);
    const perClass: Array<{ kind: ConsistencyFindingKind; objects: ClassObjects; findings: ConsistencyFinding[] }> = [
      terminologyDrift(document),
      unknownOverclaim(document, input.workItems),
      crossUnitContradiction(document, input.workItems),
      danglingReference(document, anchors, input.workItems),
      policyViolation(document, input.frozenEvidenceIds),
      chapterContract(document),
      prdDeliverable(document)
    ];
    // The class order is the union's order, asserted rather than assumed: a reading that silently reordered would
    // move the golden without any check having changed.
    for (const [index, kind] of CONSISTENCY_FINDING_KINDS.entries()) {
      const row = perClass[index]!;
      if (row.kind !== kind) throw new Error(`The consistency checker ran ${row.kind} where ${kind} belongs; the class order is the union's order`);
      const reading: ConsistencyClassReading = {
        kind,
        documentId: document.documentId,
        objects: row.objects,
        findings: row.findings.length,
        statement: ""
      };
      readings.push({ ...reading, statement: describeClassReading(reading) });
      findings.push(...row.findings);
      if (row.objects.state === "vacuous" && row.findings.length > 0) {
        throw new Error(`Class ${kind} reported ${row.findings.length} finding(s) in ${JSON.stringify(document.documentId)} while declaring it had nothing to check; a finding over no object is a bug in this checker`);
      }
    }
  }
  assertFindingsNameUnits(findings);
  return {
    version: UNIT_CONSISTENCY_VERSION,
    documents: input.documents.map((document) => document.documentId),
    readings,
    findings: [...findings].sort(compareFindings)
  };
}

/** A finding nobody can act on is this checker's own failure. Stated as a throw, with the finding in it. */
function assertFindingsNameUnits(findings: readonly ConsistencyFinding[]): void {
  for (const finding of findings) {
    if (finding.unitIds.length === 0) {
      throw new Error(`The consistency checker produced a ${finding.kind} finding in ${JSON.stringify(finding.documentId)} that names no unit (${finding.statement}); a finding that cannot be located is this checker's failure, not a report about the run`);
    }
  }
}

function compareFindings(a: ConsistencyFinding, b: ConsistencyFinding): number {
  if (a.documentId !== b.documentId) return compareUnitIds(a.documentId, b.documentId);
  const kinds = CONSISTENCY_FINDING_KINDS.indexOf(a.kind) - CONSISTENCY_FINDING_KINDS.indexOf(b.kind);
  if (kinds !== 0) return kinds;
  return compareUnitIds(a.statement, b.statement);
}

/** Ascending, distinct. The unit list of a finding is a set, and one byte form of it. */
function unitList(unitIds: readonly string[]): readonly string[] {
  return [...new Set(unitIds)].sort(compareUnitIds);
}

// --- 1. terminology drift ---------------------------------------------------------------------------------------

/** One term key: trimmed, case-folded, inner whitespace collapsed. `Tenant` and `tenant ` are one term. */
function termKey(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/gu, " ");
}

/** One meaning key: trimmed, inner whitespace collapsed. Case is MEANING here, so it is not folded. */
function meaningKey(meaning: string): string {
  return meaning.trim().replace(/\s+/gu, " ");
}

function terminologyDrift(document: ConsistencyDocument): { kind: "terminology-drift"; objects: ClassObjects; findings: ConsistencyFinding[] } {
  const byTerm = new Map<string, TermDefinition[]>();
  let definitions = 0;
  for (const unit of document.units) {
    for (const entry of unit.summary.terminology) {
      definitions += 1;
      const key = termKey(entry.term);
      const rows = byTerm.get(key) ?? [];
      rows.push({ unitId: unit.unitId, term: entry.term, meaning: entry.meaning });
      byTerm.set(key, rows);
    }
  }
  const comparable = [...byTerm.entries()].filter(([, rows]) => rows.length > 1).sort(([a], [b]) => compareUnitIds(a, b));
  const findings: ConsistencyFinding[] = [];
  for (const [key, rows] of comparable) {
    const meanings = new Set(rows.map((row) => meaningKey(row.meaning)));
    if (meanings.size < 2) continue;
    const ordered = [...rows].sort((a, b) => compareUnitIds(a.unitId, b.unitId) || compareUnitIds(a.meaning, b.meaning));
    findings.push({
      kind: "terminology-drift",
      severity: "error",
      documentId: document.documentId,
      unitIds: unitList(rows.map((row) => row.unitId)),
      term: key,
      definitions: ordered,
      statement: `document ${document.documentId} defines term ${JSON.stringify(key)} with ${meanings.size} different meanings: ${ordered.map((row) => `${row.unitId} says ${JSON.stringify(row.meaning)}`).join("; ")}. Every unit that defines it is named because making them agree is the repair and this checker does not choose which meaning is right.`
    });
  }
  if (comparable.length === 0) {
    return {
      kind: "terminology-drift",
      objects: {
        state: "vacuous",
        reason: definitions === 0
          ? `no unit of ${document.documentId} defines a term, so there is no definition to compare`
          : `${definitions} term definition(s) across ${document.units.length} unit(s) and no term is defined more than once, so no two definitions are comparable`
      },
      findings
    };
  }
  return {
    kind: "terminology-drift",
    objects: { state: "examined", objects: comparable.length, subject: `term(s) defined more than once across ${document.units.length} unit(s)` },
    findings
  };
}

// --- 2. unknown overclaim --------------------------------------------------------------------------------------

function unknownOverclaim(
  document: ConsistencyDocument,
  workItems: ReadonlyMap<string, InvestigationWorkItem>
): { kind: "unknown-overclaim"; objects: ClassObjects; findings: ConsistencyFinding[] } {
  const findings: ConsistencyFinding[] = [];
  let links = 0;
  for (const unit of document.units) {
    for (const claim of unit.claims) {
      // De-duplicated per claim: nothing forbids a claim from listing one obligation twice
      // (`claimIdShapeProblems` checks the shape of the list, not its members' distinctness), and one citation is
      // one object however many times it was written down.
      for (const workItemId of new Set(claim.workItemIds ?? [])) {
        const row = workItems.get(workItemId);
        // A citation of an id the ledger does not hold is a dangling reference, reported by that class. It is
        // skipped here rather than guessed at: an unknown status cannot be read off a row that does not exist.
        if (!row || !UNKNOWN_OBLIGATION_STATUSES.includes(row.status)) continue;
        links += 1;
        if (!OVERCLAIM_MARKERS.includes(claim.marker)) continue;
        findings.push({
          kind: "unknown-overclaim",
          severity: "error",
          documentId: document.documentId,
          unitIds: [unit.unitId],
          claimId: claim.id,
          marker: claim.marker,
          workItemId,
          workItemStatus: row.status,
          statement: `unit ${unit.unitId} states claim ${claim.id} as ${JSON.stringify(claim.marker)} and links it to obligation ${workItemId}, which this run's ledger records as ${JSON.stringify(row.status)}; a document may not present an unanswered question as an established one`
        });
      }
    }
  }
  if (links === 0) {
    return {
      kind: "unknown-overclaim",
      objects: { state: "vacuous", reason: `no claim of ${document.documentId} links an obligation this run recorded as ${UNKNOWN_OBLIGATION_STATUSES.join(" or ")}, so no claim can overstate one` },
      findings
    };
  }
  return {
    kind: "unknown-overclaim",
    objects: { state: "examined", objects: links, subject: `claim link(s) to obligations recorded as ${UNKNOWN_OBLIGATION_STATUSES.join(" or ")}` },
    findings
  };
}

// --- 3. cross-unit contradiction -------------------------------------------------------------------------------

/**
 * One unordered pair of evidence ids, and which claims place them together and which place them apart.
 *
 * The pair is carried as a value beside its key rather than encoded into the key and split back out: an evidence
 * id may hold any character (`condition-inventory.ts` mints `path:line:expression` ids, and an expression holds
 * spaces), so any separator would eventually be inside an id and the pair would be read back wrong.
 */
interface SidePairing {
  /** The two ids, ascending. */
  readonly evidenceIds: readonly string[];
  readonly sameSide: ClaimReference[];
  readonly differentSides: ClaimReference[];
}

/** The pairing row for two ids, created on first use. `JSON.stringify` of the sorted pair is the key. */
function pairingFor(pairs: Map<string, SidePairing>, a: string, b: string): SidePairing {
  const evidenceIds = [a, b].sort();
  const key = JSON.stringify(evidenceIds);
  const existing = pairs.get(key);
  if (existing) return existing;
  const created: SidePairing = { evidenceIds, sameSide: [], differentSides: [] };
  pairs.set(key, created);
  return created;
}

function crossUnitContradiction(
  document: ConsistencyDocument,
  workItems: ReadonlyMap<string, InvestigationWorkItem>
): { kind: "cross-unit-contradiction"; objects: ClassObjects; findings: ConsistencyFinding[] } {
  const findings: ConsistencyFinding[] = [];

  // (a) One obligation, two incompatible markers, in two different units.
  const byObligation = new Map<string, ClaimReference[]>();
  for (const unit of document.units) {
    for (const claim of unit.claims) {
      for (const workItemId of new Set(claim.workItemIds ?? [])) {
        if (!workItems.has(workItemId)) continue;
        const rows = byObligation.get(workItemId) ?? [];
        rows.push({ unitId: unit.unitId, claimId: claim.id, marker: claim.marker });
        byObligation.set(workItemId, rows);
      }
    }
  }
  const sharedObligations = [...byObligation.entries()]
    .filter(([, rows]) => new Set(rows.map((row) => row.unitId)).size > 1)
    .sort(([a], [b]) => compareUnitIds(a, b));
  for (const [workItemId, rows] of sharedObligations) {
    const asserting = rows.filter((row) => ASSERTING_MARKERS.includes(row.marker)).sort(compareClaimReferences);
    const unavailable = rows.filter((row) => row.marker === "unavailable").sort(compareClaimReferences);
    const assertingUnits = new Set(asserting.map((row) => row.unitId));
    const unavailableUnits = new Set(unavailable.map((row) => row.unitId));
    // Two different units must hold the two sides: one unit contradicting itself about one obligation is a
    // within-unit defect and the overclaim class already reports the shape that matters there.
    if (![...assertingUnits].some((unitId) => [...unavailableUnits].some((other) => other !== unitId))) continue;
    const status = workItems.get(workItemId)!.status;
    findings.push({
      kind: "cross-unit-contradiction",
      severity: "error",
      documentId: document.documentId,
      unitIds: unitList([...assertingUnits, ...unavailableUnits]),
      conflict: { shape: "incompatible-markers", workItemId, workItemStatus: status, asserting, unavailable },
      statement: `document ${document.documentId} both asserts and disclaims obligation ${workItemId} (ledger status ${JSON.stringify(status)}): ${asserting.map((row) => `${row.unitId}/${row.claimId} is ${row.marker}`).join(", ")} against ${unavailable.map((row) => `${row.unitId}/${row.claimId} is unavailable`).join(", ")}`
    });
  }

  // (b) Two units disagreeing about which side of a comparison a pair of evidence ids is on.
  const pairs = new Map<string, SidePairing>();
  for (const unit of document.units) {
    for (const claim of unit.claims) {
      const groups = claim.sides;
      if (!groups) continue;
      const reference: ClaimReference = { unitId: unit.unitId, claimId: claim.id, marker: claim.marker };
      for (const [index, group] of groups.entries()) {
        for (const [position, left] of group.entries()) {
          for (const right of group.slice(position + 1)) pairingFor(pairs, left, right).sameSide.push(reference);
        }
        for (const other of groups.slice(index + 1)) {
          for (const left of group) for (const right of other) pairingFor(pairs, left, right).differentSides.push(reference);
        }
      }
    }
  }
  const comparablePairs = [...pairs.entries()]
    .filter(([, pairing]) => new Set([...pairing.sameSide, ...pairing.differentSides].map((row) => row.unitId)).size > 1)
    .sort(([a], [b]) => compareUnitIds(a, b))
    .map(([, pairing]) => pairing);
  // ONE FINDING PER DISAGREEING CLAIM PAIR, carrying EVERY evidence pair they disagree about. Keyed per pair it
  // reported the same disagreement once per pair of ids — three findings for `[[E1,E2,E3]]` against
  // `[[E1],[E2],[E3]]` — which inflates the finding count and the examined objects while the repair set (the two
  // units) is identical. The grouping is the honest shape: two claims disagree, about these pairs.
  const disagreements = new Map<string, { readonly sameSide: ClaimReference; readonly differentSides: ClaimReference; readonly evidencePairs: string[][] }>();
  for (const pairing of comparablePairs) {
    const same = [...pairing.sameSide].sort(compareClaimReferences);
    const split = [...pairing.differentSides].sort(compareClaimReferences);
    // The first pair of claims from TWO DIFFERENT units that disagree. Scanned in sorted order so one input
    // always names one pair; a disagreement inside one unit is `validateComparisonSides`'s business, not this one.
    const disagreement = same.flatMap((one) => split.filter((other) => other.unitId !== one.unitId).map((other) => [one, other] as const))[0];
    if (!disagreement) continue;
    const [one, other] = disagreement;
    const key = JSON.stringify([one.unitId, one.claimId, other.unitId, other.claimId]);
    const row = disagreements.get(key) ?? { sameSide: one, differentSides: other, evidencePairs: [] };
    row.evidencePairs.push([...pairing.evidenceIds]);
    disagreements.set(key, row);
  }
  for (const key of [...disagreements.keys()].sort()) {
    const { sameSide: one, differentSides: other, evidencePairs } = disagreements.get(key)!;
    findings.push({
      kind: "cross-unit-contradiction",
      severity: "error",
      documentId: document.documentId,
      unitIds: unitList([one.unitId, other.unitId]),
      conflict: { shape: "comparison-side-disagreement", evidencePairs, sameSide: one, differentSides: other },
      statement: `document ${document.documentId} disagrees about ${evidencePairs.length} evidence pair(s) (${evidencePairs.map((pair) => pair.join(" and ")).join("; ")}): ${one.unitId}/${one.claimId} groups each pair as ONE comparison side and ${other.unitId}/${other.claimId} puts it on two, so the same two sources are the same thing and two compared things in one document`
    });
  }

  const objects = sharedObligations.length + comparablePairs.length;
  if (objects === 0) {
    return {
      kind: "cross-unit-contradiction",
      objects: {
        state: "vacuous",
        reason: `no obligation of ${document.documentId} is cited by claims of two units and no pair of evidence ids is grouped by two units, so nothing is comparable across its ${document.units.length} unit(s)`
      },
      findings
    };
  }
  return {
    kind: "cross-unit-contradiction",
    objects: {
      state: "examined",
      objects,
      subject: `cross-unit subject(s) (${sharedObligations.length} obligation(s) cited by two or more units, ${comparablePairs.length} evidence pair(s) grouped by two or more units)`
    },
    findings
  };
}

function compareClaimReferences(a: ClaimReference, b: ClaimReference): number {
  return compareUnitIds(a.unitId, b.unitId) || compareUnitIds(a.claimId, b.claimId) || compareUnitIds(a.marker, b.marker);
}

// --- 4. dangling reference -------------------------------------------------------------------------------------

function danglingReference(
  document: ConsistencyDocument,
  anchors: ReturnType<typeof readDocumentAnchors>,
  workItems: ReadonlyMap<string, InvestigationWorkItem>
): { kind: "dangling-reference"; objects: ClassObjects; findings: ConsistencyFinding[] } {
  const findings: ConsistencyFinding[] = [];
  let references = 0;
  const proseAnchors = new Map<string, string[]>();
  for (const unit of document.units) {
    for (const target of anchorReferences(unit.content, "excluded")) {
      references += 1;
      if (target !== "" && anchors.resolvable.has(target)) continue;
      findings.push({
        kind: "dangling-reference",
        severity: "error",
        documentId: document.documentId,
        unitIds: [unit.unitId],
        reference: { shape: "unresolvable-anchor", target },
        statement: `unit ${unit.unitId} links to ${JSON.stringify(`#${target}`)}, which the assembled document ${document.documentId} holds neither as an explicit anchor nor as a heading a renderer would slug to it`
      });
    }
    for (const anchorId of explicitAnchorIds(unit.content, "excluded")) {
      references += 1;
      proseAnchors.set(anchorId, [...(proseAnchors.get(anchorId) ?? []), unit.unitId]);
    }
    for (const claim of unit.claims) {
      for (const workItemId of new Set(claim.workItemIds ?? [])) {
        references += 1;
        if (workItems.has(workItemId)) continue;
        findings.push({
          kind: "dangling-reference",
          severity: "error",
          documentId: document.documentId,
          unitIds: [unit.unitId],
          reference: { shape: "unknown-work-item", claimId: claim.id, workItemId },
          statement: `unit ${unit.unitId} states claim ${claim.id} citing work item ${workItemId}, which this run's obligation ledger does not hold; nothing on the unit path validates a claim's workItemIds, so the citation reaches the deliverable pointing at nothing`
        });
      }
    }
  }
  const occurrences = new Map<string, number>();
  for (const id of anchors.explicitAnchorIds) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
  for (const anchorId of anchors.duplicateAnchorIds) {
    const holders = proseAnchors.get(anchorId) ?? [];
    if (holders.length === 0) {
      throw new Error(`Assembled document ${JSON.stringify(document.documentId)} holds anchor id ${JSON.stringify(anchorId)} ${occurrences.get(anchorId)} times and no unit's prose holds it, so the duplicate was written by assembly itself; that is a defect in the assembler and not a finding this checker can locate to a unit`);
    }
    findings.push({
      kind: "dangling-reference",
      severity: "error",
      documentId: document.documentId,
      unitIds: unitList(holders),
      reference: { shape: "duplicate-anchor", anchorId, occurrences: occurrences.get(anchorId)! },
      statement: `assembled document ${document.documentId} holds anchor id ${JSON.stringify(anchorId)} ${occurrences.get(anchorId)} times — written by ${unitList(holders).join(", ")} — so every link to it lands on whichever copy the plan's order put first`
    });
  }
  if (references === 0) {
    return {
      kind: "dangling-reference",
      objects: { state: "vacuous", reason: `no unit of ${document.documentId} writes an anchor link, an explicit anchor id or a claim work-item citation, so there is no reference to resolve` },
      findings
    };
  }
  return {
    kind: "dangling-reference",
    objects: { state: "examined", objects: references, subject: "reference(s) written in unit prose and unit claims (anchor links, explicit anchor ids, work-item citations)" },
    findings
  };
}

// --- 5. audience / policy violation ----------------------------------------------------------------------------

/**
 * Where one evidence id occurs as a token in prose, not as a substring of a longer id.
 *
 * The boundary test is on the id-shaped character class rather than `\b`, because an id like `S-b524a4194f` ends
 * in a word character and `S-b524a4194f0` would otherwise report a match for the shorter one.
 */
function identifierOccurrences(prose: string, evidenceId: string): readonly number[] {
  const found: number[] = [];
  const boundary = /[A-Za-z0-9_-]/;
  for (let index = prose.indexOf(evidenceId); index >= 0; index = prose.indexOf(evidenceId, index + 1)) {
    const before = index === 0 ? "" : prose[index - 1]!;
    const after = prose[index + evidenceId.length] ?? "";
    if (before !== "" && boundary.test(before)) continue;
    if (after !== "" && boundary.test(after)) continue;
    found.push(index);
  }
  return found;
}

function excerptAround(prose: string, index: number, length: number): string {
  return prose.slice(Math.max(0, index - 20), index + length + 10).replace(/\s+/g, " ").trim();
}

function policyViolation(
  document: ConsistencyDocument,
  frozenEvidenceIds: readonly string[]
): { kind: "policy-violation"; objects: ClassObjects; findings: ConsistencyFinding[] } {
  const findings: ConsistencyFinding[] = [];
  // TWO INDEPENDENT CONDITIONS, KEPT APART. Folding them into one boolean made the reading say "this document's
  // product-manager lens places identifiers in prose" on a run whose sealed evidence set was empty — false about
  // the lens, and the actual fact ("no sealed id, so the rule had no object") was gone. `identifierRuleState` is a
  // closed three-way answer and the subject below prints one sentence per state.
  const identifierRuleState: "applies" | "no-sealed-identifier" | "lens-allows-prose" =
    document.identifierPlacement === "in-prose"
      ? "lens-allows-prose"
      : frozenEvidenceIds.length === 0 ? "no-sealed-identifier" : "applies";
  const identifierRule = identifierRuleState === "applies";
  for (const unit of document.units) {
    if (identifierRule) {
      for (const evidenceId of [...frozenEvidenceIds].sort()) {
        for (const index of identifierOccurrences(unit.content, evidenceId)) {
          findings.push({
            kind: "policy-violation",
            severity: "error",
            documentId: document.documentId,
            unitIds: [unit.unitId],
            violation: { shape: "identifier-in-prose", evidenceId, excerpt: excerptAround(unit.content, index, evidenceId.length) },
            statement: `unit ${unit.unitId} puts evidence id ${evidenceId} in the visible prose of ${document.documentId}, whose ${document.audience} lens keeps implementation identifiers in evidence (identifierPlacement "evidence-only"): ${JSON.stringify(excerptAround(unit.content, index, evidenceId.length))}`
          });
        }
      }
    }
    for (const advice of unnegatedAdvice(unit.content)) {
      findings.push({
        kind: "policy-violation",
        severity: "error",
        documentId: document.documentId,
        unitIds: [unit.unitId],
        violation: { shape: "recommendation-language", pattern: advice.pattern, excerpt: advice.excerpt },
        statement: `unit ${unit.unitId} of ${document.documentId} tells the reader what to do and nothing negates it (${advice.pattern}): ${JSON.stringify(advice.excerpt)}`
      });
    }
  }
  // Never vacuous, and that is stated rather than left to chance: the advice rule applies to every unit's prose in
  // every document, so a document with a unit always has an object. The identifier rule is the one that can be out
  // of scope, and the subject says which rules ran.
  return {
    kind: "policy-violation",
    objects: {
      state: "examined",
      objects: document.units.length * (identifierRule ? 2 : 1),
      subject: `unit prose scan(s) (${identifierPlacementSubject(identifierRuleState, document, frozenEvidenceIds.length)})`
    },
    findings
  };
}

/** Which rules the policy scan ran, per state. Exhaustive: a fourth state has to say its own sentence. */
function identifierPlacementSubject(
  state: "applies" | "no-sealed-identifier" | "lens-allows-prose",
  document: ConsistencyDocument,
  sealedIdentifiers: number
): string {
  switch (state) {
    case "applies":
      return `recommendation language, and ${sealedIdentifiers} sealed evidence id(s) against this document's evidence-only ${document.audience} lens`;
    case "no-sealed-identifier":
      return `recommendation language only; this document's ${document.audience} lens IS evidence-only, but this run sealed no evidence id, so that rule had no object to check`;
    case "lens-allows-prose":
      return `recommendation language only; this document's ${document.audience} lens places identifiers in prose`;
  }
  return assertNever(state, "identifier placement rule state");
}

// --- 6. chapter contract ----------------------------------------------------------------------------------------

/**
 * The deliverable's numbered chapters against the requirement rows this run recorded for it.
 *
 * IT IS NEVER VACUOUS, and that is the whole point. Every other class here can honestly have nothing to look at —
 * a document whose units define no term has no definition to compare. This one always has an object: the run
 * recorded N requirement rows for this document, so there is always a contract and always a document to hold
 * against it. A `vacuous` arm would be a hole in the exact shape the gate exists to close, because the cheapest
 * way to escape a chapter check is to write no numbered chapter at all — that is `0` against `N`, which is a
 * finding, not an absence of subject.
 *
 * IT NAMES EVERY UNIT OF THE DOCUMENT. See the finding arm: the chapter set belongs to the document, not to any
 * one unit, and choosing a culprit would be Core deciding which unit should have written the missing chapter.
 */
function chapterContract(document: ConsistencyDocument): { kind: "chapter-contract"; objects: ClassObjects; findings: ConsistencyFinding[] } {
  if (document.plannedChapterCount === null) {
    // The ONLY vacuous arm, and it is about the CONTRACT rather than about the document: this run recorded no
    // chapter contract for these bytes, so there is nothing to hold them to. It is unreachable from prose — no
    // model can write its way into it — which is what keeps it from being the cheap escape a "the document has no
    // chapter" arm would have been.
    return {
      kind: "chapter-contract",
      objects: {
        state: "vacuous",
        reason: `this run's contract records no template-section requirement row for ${document.documentId}, so the number of chapters its deliverable owes was never fixed; contract/requirements.json is written once by prepare and the request-append door grows plan/requests.json only, so a document added to an existing run has no recorded chapter contract`
      },
      findings: []
    };
  }
  const inventory = chapterInventory(document.markdown, document.plannedChapterCount);
  const fence = unterminatedFenceClause(inventory);
  const findings = inventory.problems.map((problem): ConsistencyFinding => ({
    kind: "chapter-contract",
    severity: "error",
    documentId: document.documentId,
    unitIds: unitList(document.units.map((unit) => unit.unitId)),
    problem,
    statement: `${describeChapterProblem(problem, document.documentId)}.${fence === null ? "" : ` ${fence}.`} Every unit of the document is named because the chapters are the concatenation of all of their prose and this checker does not decide which unit owes the repair.`
  }));
  return {
    kind: "chapter-contract",
    objects: {
      state: "examined",
      objects: inventory.chapters.length,
      subject: `numbered chapter(s) against the ${document.plannedChapterCount} template-section requirement row(s)`
    },
    findings
  };
}

// --- 7. prd deliverable word form -------------------------------------------------------------------------------

/**
 * The four things `prd-feature.md` and `writing-rules.md` state about a PRD deliverable's own WORDS, checked over
 * the visible prose of its units. The rules themselves live in `prd-deliverable-checks.ts`; this function decides
 * WHETHER THEY APPLY and turns each problem into a located finding.
 *
 * ITS ONE VACUOUS ARM IS ABOUT THE CONTRACT, NEVER ABOUT THE DOCUMENT — the same shape, and the same argument, as
 * the chapter class. The document task is read off the request row this run recorded, so no prose can write its
 * way into the arm: a deliverable that is not a PRD has no PRD word-form contract, and the rules say nothing about
 * it. "This PRD wrote no visible prose" is NOT that arm; it is a reading with a denominator of zero, because the
 * cheapest way past a prose rule would otherwise be to write the prose inside a collapsed block.
 *
 * THE DENOMINATOR IS THE UNIT SCAN, and the line and token counts ride along in the subject. `0 finding(s)` over
 * "4 unit prose scan(s) covering 96 visible prose line(s) and 14 FR/PAGE token(s)" is a sentence a reader can
 * check; `0 finding(s)` alone is the sentence this codebase keeps paying for.
 */
function prdDeliverable(document: ConsistencyDocument): { kind: "prd-deliverable"; objects: ClassObjects; findings: ConsistencyFinding[] } {
  if (document.intent !== "prd") {
    return {
      kind: "prd-deliverable",
      objects: {
        state: "vacuous",
        reason: `this run records the document task of ${document.documentId} as ${document.intent}, for the ${document.audience} reader, and these four rules — no acceptance checkbox line, no AC id series, FR/PAGE trace anchors of exactly three digits and each defined once, no storage-schema vocabulary in visible prose — are the PRD deliverable's own word-form contract and hold of no other document task; the task comes from the request row this run recorded, so no prose can write itself into or out of this arm`
      },
      findings: []
    };
  }
  const scans = document.units.map((unit) => ({ unitId: unit.unitId, scan: scanPrdUnitProse(unit.content) }));
  const findings: ConsistencyFinding[] = [];
  for (const row of scans) {
    for (const problem of row.scan.problems) findings.push(prdFinding(document, [row.unitId], problem));
  }
  for (const duplicate of duplicateAnchorDefinitions(scans.map((row) => ({ unitId: row.unitId, anchorIds: row.scan.anchorIds })))) {
    findings.push(prdFinding(document, duplicate.unitIds, duplicate.problem));
  }
  const lines = scans.reduce((total, row) => total + row.scan.visibleLines, 0);
  const tokens = scans.reduce((total, row) => total + row.scan.anchorTokens, 0);
  return {
    kind: "prd-deliverable",
    objects: {
      state: "examined",
      objects: scans.length,
      subject: `unit prose scan(s) covering ${lines} visible prose line(s) and ${tokens} FR/PAGE token(s) (acceptance checkbox residue, forbidden AC id series, trace-anchor shape and uniqueness, storage-schema leak)`
    },
    findings
  };
}

/** One located finding for one problem. The severity is the problem's, from the one function that decides it. */
function prdFinding(document: ConsistencyDocument, unitIds: readonly string[], problem: PrdProblem): ConsistencyFinding {
  const named = unitList(unitIds);
  return {
    kind: "prd-deliverable",
    documentId: document.documentId,
    unitIds: named,
    severity: prdProblemSeverity(problem.shape),
    problem,
    statement: describePrdProblem(problem, document.documentId, named.length === 1 ? `unit ${named[0]}` : `units ${named.join(", ")}`)
  };
}
