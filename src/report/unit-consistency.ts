/**
 * THE CROSS-UNIT CONSISTENCY CHECKER (R7c): the five content-level properties no collect gate can see, checked
 * over an assembled document and reported as findings that NAME THE UNITS.
 *
 * WHAT IT REFUSES TO DO, first, because it is the load-bearing constraint. It does not re-check topic coverage,
 * topic disposition, the grounding audit, the synthesis backlink or the child-digest rule. Those have denominators
 * of their own, one level down, and a second derivation of any of them would be a second denominator — which is
 * the one thing gate 1b forbids. What is left after subtracting them is exactly what this file checks: properties
 * that are invisible to a gate looking at ONE unit, or that nothing looks at at all. `whyCollectCannotSee` states
 * that per class, as an exhaustive switch, so a sixth class cannot be added without answering the question that
 * justifies the file existing.
 *
 * THE FIVE CLASSES, and the measured gap each one closes:
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
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import { unnegatedAdvice } from "./recommendation-language.ts";
import type { IdentifierPlacement } from "./report-policy-registry.ts";
import type { ReportAudience } from "./report-request-v2.ts";
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
  "policy-violation"
] as const;
export type ConsistencyFindingKind = (typeof CONSISTENCY_FINDING_KINDS)[number];

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
  /** From this document's lens policy, which plan validation has already pinned to the registry. */
  readonly identifierPlacement: IdentifierPlacement;
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

/** One finding. Every arm carries the units it names, so a repair set can be built from any of them. */
export type ConsistencyFinding =
  | {
      readonly kind: "terminology-drift";
      readonly documentId: string;
      readonly unitIds: readonly string[];
      readonly statement: string;
      readonly term: string;
      readonly definitions: readonly TermDefinition[];
    }
  | {
      readonly kind: "unknown-overclaim";
      readonly documentId: string;
      readonly unitIds: readonly string[];
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
      readonly statement: string;
      readonly conflict: ContradictionConflict;
    }
  | {
      readonly kind: "dangling-reference";
      readonly documentId: string;
      readonly unitIds: readonly string[];
      readonly statement: string;
      readonly reference: DanglingReference;
    }
  | {
      readonly kind: "policy-violation";
      readonly documentId: string;
      readonly unitIds: readonly string[];
      readonly statement: string;
      readonly violation: PolicyViolation;
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
      policyViolation(document, input.frozenEvidenceIds)
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
