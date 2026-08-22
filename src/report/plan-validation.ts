/**
 * Deterministic plan validation: the gate between a proposal (which a model may write) and the plan artifacts
 * (which the rest of the pipeline treats as premises).
 *
 * WHAT IT REFUSES TO BELIEVE. Anything the proposal says about itself. The material-topic denominator comes from
 * the catalog, the budget is re-derived from the recorded requests and compared to the proposal's echo, and the
 * obligation accounting is computed from the catalog's own bindings. A proposal cannot widen a denominator, raise
 * a budget or declare its own coverage, because none of those numbers are read off it.
 *
 * WHAT IT CHECKS, in the epic's own words plus the ones R5a and R5b add:
 *   * every material topic carries exactly one of six dispositions (R2's validator, reused whole — not restated);
 *   * every topic a unit names exists in the catalog, and every child a synthesis names exists among the units;
 *   * the unit graph is acyclic, each document has exactly one root, and no unit is named as a child twice — the
 *     tree law `unit-parentage.ts` owns, which the root count cannot see;
 *   * every unit belongs to a requested document, and every requested document has at least one unit;
 *   * the KNOWLEDGE BOUNDARY each request names is one this catalog can account for — a feature document bounded
 *     to a key the run never investigated is refused here rather than planned for (`plan-scope-boundary.ts`);
 *   * the lens policy a plan invokes to omit something is a lens some request in this plan actually reads under;
 *   * GATE 1b's reading: where each material OBLIGATION goes, with the ones a waiving disposition removed
 *     listed by id (`plan-obligation-conservation.ts`);
 *   * R5a's ownership: within one document every material obligation has exactly one owner unit. Derived from the
 *     catalog's bindings and the units' kinds by the same file that owns gate 1b's denominator — never read off the
 *     proposal, which carries no ownership field at all;
 *   * R5b's PARTITION LAW: the obligation scopes of one topic's owning units cover its bindings exactly — no id
 *     missed, none covered twice, none named that the topic does not bind (`obligation-scope.ts`). This is the
 *     anti-truncation tripwire: a division that lost a row fails here rather than fitting quietly;
 *   * and R5b's BYTES, measured rather than estimated: every unit's packet is rendered by the same function the
 *     author reads from (`plan-packet-measure.ts`) and compared to its document's per-unit allowance, with a
 *     synthesis bounded by its child count times the declared summary allowance. R4b measured a proxy here — the
 *     canonical bytes of a unit's topic rows — and was out by 9x on the wcp baseline.
 *
 * THE BYTES ARE A THREE-STATE READING, NOT A SILENT SKIP. Measuring a packet means rendering one, and rendering
 * one is only meaningful over a plan whose references, ownership and scopes already hold — otherwise the renderer
 * would throw on the first broken row instead of this file returning a list of named problems. So `packets` is a
 * union: `measured` carries the per-unit rows, `not-measured` carries WHY it could not be taken. An unmeasured plan
 * always has problems, so it can never read as "every packet fits"; the empty set is never read as complete.
 *
 * THREE CONCLUSIONS, NOT A BOOLEAN. `complete` / `vacuous` / `violations`, reusing R2's `TopicDispositionVerdict`
 * shape verbatim — the same type, so a consumer that learned to read one reads the other, and so `vacuous` (an
 * empty material denominator, with its source) can never be printed with `complete`'s words. There is no `passed`
 * field anywhere in this file.
 *
 * FAILURE IS RE-PROPOSABLE, NEVER TERMINAL. Every problem is returned as data with the offending id in it, and
 * nothing is written by this file. A rejected plan is corrected and validated again against the same epoch; there
 * is no state here that a bad proposal can put a run into permanently.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { EvidenceItem } from "../base/types.ts";
import { stableJson } from "../base/util.ts";
import { planBudgetFor, type PlanBudget, type PlanBudgetTable, type PlanDocumentBudget } from "./plan-budget.ts";
import {
  measurePlanPackets,
  packetMeasurementProblems,
  type PlanPacketMeasurement,
  type UnitPacketMeasureInputs
} from "./plan-packet-measure.ts";
import { scopePartitionProblems, type ScopePartitionUnit } from "./obligation-scope.ts";
import { scopeBoundaryProblems } from "./plan-scope-boundary.ts";
import {
  accountPlanObligations,
  deriveObligationOwnership,
  obligationAccountingProblems,
  ownershipProblems,
  ownershipUnitsOfProposal,
  unitTopicRole,
  type ObligationOwnershipIndex,
  type PlanObligationAccounting
} from "./plan-obligation-conservation.ts";
import { unitChildIds, unitTopicIds, unitTopics, type PlanProposal } from "./plan-proposal.ts";
import { documentRootUnitIds, unitDagOrder } from "./unit-dag-order.ts";
import { singleParentProblems } from "./unit-parentage.ts";
import {
  intentPolicyFor,
  lensPolicyFor,
  policyReference,
  type ReportPolicyRegistry
} from "./report-policy-registry.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";
import { TOPIC_FACETS, type TopicFacet } from "./topic-candidate.ts";
import { materialTopics, type TopicCatalogArtifact } from "./topic-catalog.ts";
import {
  parsedDispositionIndex,
  summariseVerdict,
  validateTopicDispositions,
  type TopicDisposition,
  type TopicDispositionReport,
  type TopicDispositionVerdict
} from "./topic-disposition.ts";
import type { PacketCoverageFacts } from "./coverage-companion.ts";
import type { RunEvidenceReach } from "./unit-packet.ts";

export const PLAN_VALIDATION_VERSION = "plan-validation-v2";

/** Every input required, none defaulted: a validation that silently used the live registry is one nobody chose. */
export interface PlanValidationInput {
  readonly catalog: TopicCatalogArtifact;
  readonly requests: ReportRequestsArtifact;
  readonly proposal: PlanProposal;
  readonly registry: ReportPolicyRegistry;
  readonly budgetTable: PlanBudgetTable;
  /**
   * The frozen evidence records, BY VALUE and keyed by id — required.
   *
   * The budget check renders each unit's packet to measure it, and a packet renders the evidence its obligations
   * bind. R4b avoided the parameter by measuring topic rows instead, and that is exactly the 9x error this slice
   * removes. Values rather than a path, the same shape the renderer takes, so a validation can run over an archival
   * run that must not be written to.
   */
  readonly evidence: ReadonlyMap<string, EvidenceItem>;
  /** Mechanism A's three numbers, from `evidenceReachOf`. The packet prints them, so the measure needs them. */
  readonly reach: RunEvidenceReach;
  /**
   * The epoch-only coverage families (R7a) — required for the same reason `evidence` and `reach` are.
   *
   * The appendix packet renders a coverage block from them, and the budget check measures the packet the author
   * reads. A validation that could omit them would grade a packet nobody is handed.
   */
  readonly epochCoverage: PacketCoverageFacts;
}

export interface PlanDocumentReading {
  readonly documentId: string;
  /** Every unit no other unit in this document names as a child, ascending. Exactly one, or a named problem. */
  readonly rootUnitIds: readonly string[];
  readonly units: number;
  readonly budget: PlanDocumentBudget;
}

/**
 * What the plan's packets cost, or why that could not be measured. Two arms, exhaustive, no default.
 *
 * `not-measured` carries the reason, and it only ever happens on a plan that already has problems — so a reader
 * cannot mistake "not measured" for "measured and fine". The empty set is not read as complete anywhere here.
 */
export type PlanPacketReading =
  | { readonly state: "measured"; readonly measurement: PlanPacketMeasurement }
  | { readonly state: "not-measured"; readonly reason: string };

/** The measured bytes of one document, or `null` when nothing was measured. Exhaustive over the two arms. */
export function measuredDocumentBytes(reading: PlanPacketReading, documentId: string): number | null {
  switch (reading.state) {
    case "measured":
      return reading.measurement.documents.find((row) => row.documentId === documentId)?.bytes ?? null;
    case "not-measured":
      return null;
  }
  return assertNever(reading, "plan packet reading state");
}

export interface PlanValidationReport {
  readonly version: typeof PLAN_VALIDATION_VERSION;
  readonly overall: TopicDispositionVerdict;
  /** One row per facet, in `TOPIC_FACETS` order — a facet with no material topic reads vacuous, never complete. */
  readonly facets: readonly { readonly facet: TopicFacet; readonly verdict: TopicDispositionVerdict }[];
  /** The disposition rows this validation accepted, ascending by topic id. Empty when any of them failed to parse. */
  readonly dispositions: readonly TopicDisposition[];
  readonly obligations: PlanObligationAccounting;
  /**
   * R5a's per-document ownership, derived. The same index the unit packet and the per-unit grounding audit read:
   * one derivation, three consumers, so a per-unit "who owes this" can never disagree with the plan-side reading.
   */
  readonly ownership: ObligationOwnershipIndex;
  readonly documents: readonly PlanDocumentReading[];
  /** The authoring order: every unit after all of its children. Empty when the graph is not acyclic. */
  readonly authoringOrder: readonly string[];
  /** The re-derived budget. The proposal's echo is compared against this, never trusted in its place. */
  readonly budget: PlanBudget;
  /** R5b's measurement, or the named reason it could not be taken. */
  readonly packets: PlanPacketReading;
  /** Plan-level problems (the disposition ones live in the verdicts). */
  readonly problems: readonly string[];
}

/** Validate one proposal against one catalog and one recorded request set. Writes nothing; returns everything. */
export function validatePlan(input: PlanValidationInput): PlanValidationReport {
  const { catalog, requests, proposal, registry, budgetTable } = input;
  const problems: string[] = [];
  const topicsById = new Map(catalog.topics.map((topic) => [topic.topicId, topic]));
  const unitsById = new Map(proposal.units.map((unit) => [unit.unitId, unit]));
  if (unitsById.size !== proposal.units.length) {
    problems.push(`the proposal declares ${proposal.units.length} units under ${unitsById.size} distinct unit ids; a unit id names exactly one unit`);
  }

  // --- the requests are the document set. A unit for an unrequested document, or a document with no unit, is a
  // plan that does not answer the request it was made for.
  const requestedIds = new Set(requests.requests.map((record) => record.documentId));
  if (requestedIds.size === 0) problems.push("the recorded request set names no document, so there is nothing for a plan to cover");
  for (const unit of proposal.units) {
    if (!requestedIds.has(unit.documentId)) {
      problems.push(`unit ${JSON.stringify(unit.unitId)} names document ${JSON.stringify(unit.documentId)}, which no recorded request asks for (requested: ${[...requestedIds].sort().join(", ") || "none"})`);
    }
  }
  for (const documentId of [...requestedIds].sort()) {
    if (!proposal.units.some((unit) => unit.documentId === documentId)) {
      problems.push(`document ${JSON.stringify(documentId)} is requested and no unit writes any part of it`);
    }
  }

  // --- and the boundary each requested document is written against. Checked here, next to "the requests are the
  // document set", because it is the same input read the same way: a row on disk that decides what gets minted.
  problems.push(...scopeBoundaryProblems(catalog, requests));

  // --- references: a topic id the catalog does not hold, or a child id no unit declares.
  for (const unit of proposal.units) {
    for (const topicId of unitTopicIds(unit)) {
      if (!topicsById.has(topicId)) {
        problems.push(`unit ${JSON.stringify(unit.unitId)} names topic ${JSON.stringify(topicId)}, which is not in this catalog`);
      }
    }
    for (const childId of unitChildIds(unit)) {
      if (childId === unit.unitId) {
        problems.push(`synthesis unit ${JSON.stringify(unit.unitId)} names itself as a child`);
        continue;
      }
      const child = unitsById.get(childId);
      if (child === undefined) {
        problems.push(`synthesis unit ${JSON.stringify(unit.unitId)} names child unit ${JSON.stringify(childId)}, which the proposal does not declare`);
        continue;
      }
      if (child.documentId !== unit.documentId) {
        problems.push(`synthesis unit ${JSON.stringify(unit.unitId)} of document ${JSON.stringify(unit.documentId)} names child ${JSON.stringify(childId)} from document ${JSON.stringify(child.documentId)}; a unit is written into exactly one document`);
      }
    }
  }

  // --- the tree law, which the root count does not imply: a unit named as a child by two units still leaves one
  // root and would be placed under whichever parent a consumer reached first.
  problems.push(...singleParentProblems(proposal.units));

  // --- the graph.
  const dag = unitDagOrder(proposal.units);
  if (dag.state === "cyclic") {
    problems.push(`the unit graph has a cycle: ${dag.cycle.join(" -> ")}; a synthesis cannot depend on a unit that depends on it`);
  }

  // --- one root per document, and the budget the requests derive.
  const budget = planBudgetFor(requests, budgetTable);
  const budgetByDocument = new Map(budget.documents.map((row) => [row.documentId, row]));
  if (stableJson(proposal.budget) !== stableJson(budget)) {
    problems.push(`the proposal echoes a budget that is not the one the recorded requests derive; a plan does not set its own budget (echoed ${stableJson(proposal.budget)}, derived ${stableJson(budget)})`);
  }
  const documents: PlanDocumentReading[] = [];
  for (const documentId of [...requestedIds].sort()) {
    const units = proposal.units.filter((unit) => unit.documentId === documentId);
    const rootUnitIds = documentRootUnitIds(proposal.units, documentId);
    if (units.length > 0 && rootUnitIds.length !== 1) {
      problems.push(`document ${JSON.stringify(documentId)} has ${rootUnitIds.length} root unit(s) (${rootUnitIds.join(", ") || "none"}); a document assembles from exactly one root`);
    }
    documents.push({ documentId, rootUnitIds, units: units.length, budget: budgetByDocument.get(documentId)! });
  }

  // --- the policies. A recorded reference that no longer matches the live registry means the request was
  // resolved against other bytes than the ones in force now, and a plan built on it would cite a policy nobody
  // can reproduce.
  const planLensIds = new Set<string>();
  for (const record of requests.requests) {
    const lens = policyReference(lensPolicyFor(record.request.audience, registry));
    const intent = policyReference(intentPolicyFor(record.request.intent, registry));
    if (stableJson(record.lensPolicy) !== stableJson(lens)) {
      problems.push(`document ${JSON.stringify(record.documentId)} records lens policy ${stableJson(record.lensPolicy)}, which is not the registry's ${stableJson(lens)}`);
    }
    if (stableJson(record.intentPolicy) !== stableJson(intent)) {
      problems.push(`document ${JSON.stringify(record.documentId)} records intent policy ${stableJson(record.intentPolicy)}, which is not the registry's ${stableJson(intent)}`);
    }
    planLensIds.add(lens.id);
  }

  // --- the dispositions: R2's validator owns the six-state rules; this file owns what the PLAN then does with
  // the rows. Parsed once, by the one index `plan-artifacts.ts` re-derives from, so the recorded accounting is
  // checked against exactly the rows this validation judged.
  const dispositionReport = validateTopicDispositions(catalog, proposal.dispositions, registry);
  const dispositions = parsedDispositionIndex(proposal.dispositions);
  for (const disposition of dispositions.rows) {
    if (disposition.state !== "omitted-for-audience") continue;
    if (!planLensIds.has(disposition.lensPolicyId)) {
      problems.push(`topic ${JSON.stringify(disposition.topicId)} is omitted for lens policy ${JSON.stringify(disposition.lensPolicyId)}, which no document in this plan is written under (this plan's lenses: ${[...planLensIds].sort().join(", ") || "none"})`);
    }
  }

  // --- gate 1b's reading. An obligation no topic carries cannot be dispositioned by any plan, so the catalog's
  // own conservation residue becomes a plan violation rather than a bucket nobody owns.
  if (catalog.obligationAccounting.unassigned > 0) {
    problems.push(`the catalog leaves ${catalog.obligationAccounting.unassigned} obligation(s) bound to no topic (${catalog.obligationAccounting.unassignedWorkItemIds.join(", ")}); no plan can dispose of an obligation no topic carries`);
  }
  const obligations = accountPlanObligations(catalog, proposal.units, dispositions.byTopic);
  problems.push(...obligationAccountingProblems(obligations));

  // --- R5b's partition law, checked BEFORE ownership is read: a topic whose owning units do not partition its
  // bindings has an obligation that either nobody writes or two units write, and the ownership derivation below
  // would then report a plausible-looking owner for a plan that is broken. Both are named here, by id.
  const bindingIdsByTopic = new Map(catalog.topics.map((topic) => [topic.topicId, topic.bindings.map((binding) => binding.workItemId)]));
  const partitionUnits: ScopePartitionUnit[] = proposal.units
    .filter((unit) => unitTopicRole(unit.kind) !== "topic-free")
    .map((unit) => ({
      unitId: unit.unitId,
      documentId: unit.documentId,
      owning: unitTopicRole(unit.kind) === "owning",
      topics: unitTopics(unit)
    }));
  problems.push(...scopePartitionProblems(bindingIdsByTopic, partitionUnits));

  // --- R5a's ownership. Derived from the catalog's bindings, the units' kinds and their scopes, and asserted at
  // the document level: every material obligation a document reaches is owned by exactly one of its units.
  const ownership = deriveObligationOwnership(catalog, ownershipUnitsOfProposal(proposal.units));
  problems.push(...ownershipProblems(ownership));
  for (const document of ownership.documents) {
    const owned = document.ownedByUnit.reduce((total, row) => total + row.owned, 0);
    if (owned + document.unowned.length !== document.reachedObligations) {
      problems.push(`document ${JSON.stringify(document.documentId)} owns ${owned} of the ${document.reachedObligations} material obligation(s) its units reach and lists ${document.unowned.length} as owned by none; the two must account for every reachable obligation`);
    }
  }

  // --- R5b's bytes. Measured LAST and only over a plan whose structure already holds: the measure renders every
  // packet, and a renderer handed a plan with an unknown topic or an unowned obligation refuses by name rather than
  // returning a number. `not-measured` therefore always sits beside problems, never alone.
  const packets = measurePackets(input, problems);
  switch (packets.state) {
    case "measured":
      problems.push(...packetMeasurementProblems(packets.measurement));
      break;
    case "not-measured":
      break;
  }

  return {
    version: PLAN_VALIDATION_VERSION,
    overall: overallVerdict(catalog, dispositionReport, problems),
    facets: dispositionReport.facets.map((row) => ({ facet: row.facet, verdict: row.verdict })),
    dispositions: dispositions.rows,
    obligations,
    ownership,
    documents,
    authoringOrder: dag.state === "acyclic" ? dag.order : [],
    budget,
    packets,
    problems
  };
}

/**
 * Take the measurement, or say why not.
 *
 * Two reasons it is not taken, and both are stated rather than silent: the plan already has problems (so the
 * renderer would throw on one of them instead of this file returning a list), or the measurement itself refused —
 * which means the plan is internally inconsistent in a way the checks above did not name, and THAT is worth saying
 * in the reason rather than crashing a validation whose contract is to return data.
 */
function measurePackets(input: PlanValidationInput, problems: string[]): PlanPacketReading {
  if (problems.length > 0) {
    return {
      state: "not-measured",
      reason: `this plan has ${problems.length} problem(s) that must be fixed before its packets can be rendered, so no byte measurement was taken: ${problems.join("; ")}`
    };
  }
  const measureInputs: UnitPacketMeasureInputs = {
    catalog: input.catalog,
    requests: input.requests,
    registry: input.registry,
    budgetTable: input.budgetTable,
    evidence: input.evidence,
    reach: input.reach,
    epochCoverage: input.epochCoverage
  };
  try {
    return { state: "measured", measurement: measurePlanPackets(measureInputs, input.proposal) };
  } catch (error) {
    const reason = `the packets of this plan could not be rendered, so no byte measurement was taken: ${(error as Error).message}`;
    problems.push(reason);
    return { state: "not-measured", reason };
  }
}

/**
 * Fold the plan-level problems into the disposition verdict.
 *
 * Exhaustive over the three conclusions with no `default` arm: a fourth conclusion would have to be handled here
 * before this compiles. The vacuous arm is the one that matters — a plan over a catalog with no material topic
 * still has to be able to fail its budget or its graph, and folding that into `vacuous` would print "nothing was
 * checked" over a plan that was checked and broken.
 */
function overallVerdict(
  catalog: TopicCatalogArtifact,
  dispositionReport: TopicDispositionReport,
  problems: readonly string[]
): TopicDispositionVerdict {
  const denominator = materialTopics(catalog).length;
  const overall = dispositionReport.overall;
  switch (overall.conclusion) {
    case "violations":
      return { conclusion: "violations", denominator, dispositioned: overall.dispositioned, problems: [...overall.problems, ...problems] };
    case "complete":
      return problems.length === 0 ? overall : { conclusion: "violations", denominator, dispositioned: overall.dispositioned, problems: [...problems] };
    case "vacuous":
      return problems.length === 0 ? overall : { conclusion: "violations", denominator, dispositioned: 0, problems: [...problems] };
  }
  return assertNever(overall, "topic disposition conclusion");
}

/** One line per facet plus the overall line, in the vocabulary `summariseVerdict` fixed. */
export function summarisePlanValidation(report: PlanValidationReport): string[] {
  return [
    `overall — ${summariseVerdict(report.overall)}`,
    ...TOPIC_FACETS.map((facet) => {
      const row = report.facets.find((entry) => entry.facet === facet);
      return `${facet} — ${row ? summariseVerdict(row.verdict) : "(no verdict row)"}`;
    })
  ];
}
