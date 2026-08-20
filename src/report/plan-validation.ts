/**
 * Deterministic plan validation: the gate between a proposal (which a model may write) and the plan artifacts
 * (which the rest of the pipeline treats as premises).
 *
 * WHAT IT REFUSES TO BELIEVE. Anything the proposal says about itself. The material-topic denominator comes from
 * the catalog, the budget is re-derived from the recorded requests and compared to the proposal's echo, and the
 * obligation accounting is computed from the catalog's own bindings. A proposal cannot widen a denominator, raise
 * a budget or declare its own coverage, because none of those numbers are read off it.
 *
 * WHAT IT CHECKS, in the epic's own words plus the one this slice adds:
 *   * every material topic carries exactly one of six dispositions (R2's validator, reused whole — not restated);
 *   * every topic a unit names exists in the catalog, and every child a synthesis names exists among the units;
 *   * the unit graph is acyclic, and each document has exactly one root;
 *   * every unit belongs to a requested document, and every requested document has at least one unit;
 *   * every unit's topic dossier fits its document's budget, and the document's units fit its total;
 *   * the lens policy a plan invokes to omit something is a lens some request in this plan actually reads under;
 *   * and GATE 1b's reading: where each material OBLIGATION goes, with the ones a waiving disposition removed
 *     listed by id (`plan-obligation-conservation.ts`).
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
import { stableJson } from "../base/util.ts";
import { planBudgetFor, unitInputBytes, type PlanBudget, type PlanBudgetTable, type PlanDocumentBudget } from "./plan-budget.ts";
import {
  accountPlanObligations,
  obligationAccountingProblems,
  type PlanObligationAccounting
} from "./plan-obligation-conservation.ts";
import { unitChildIds, unitTopicIds, type PlanProposal, type ProposedUnit } from "./plan-proposal.ts";
import {
  intentPolicyFor,
  lensPolicyFor,
  policyReference,
  type ReportPolicyRegistry
} from "./report-policy-registry.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";
import { TOPIC_FACETS, type TopicCandidate, type TopicFacet } from "./topic-candidate.ts";
import { materialTopics, type TopicCatalogArtifact } from "./topic-catalog.ts";
import {
  parseTopicDisposition,
  summariseVerdict,
  validateTopicDispositions,
  type TopicDisposition,
  type TopicDispositionReport,
  type TopicDispositionVerdict
} from "./topic-disposition.ts";

export const PLAN_VALIDATION_VERSION = "plan-validation-v1";

/** Every input required, none defaulted: a validation that silently used the live registry is one nobody chose. */
export interface PlanValidationInput {
  readonly catalog: TopicCatalogArtifact;
  readonly requests: ReportRequestsArtifact;
  readonly proposal: PlanProposal;
  readonly registry: ReportPolicyRegistry;
  readonly budgetTable: PlanBudgetTable;
}

export interface PlanDocumentReading {
  readonly documentId: string;
  /** Every unit no other unit in this document names as a child, ascending. Exactly one, or a named problem. */
  readonly rootUnitIds: readonly string[];
  readonly units: number;
  readonly inputBytes: number;
  readonly budget: PlanDocumentBudget;
}

export interface PlanValidationReport {
  readonly version: typeof PLAN_VALIDATION_VERSION;
  readonly overall: TopicDispositionVerdict;
  /** One row per facet, in `TOPIC_FACETS` order — a facet with no material topic reads vacuous, never complete. */
  readonly facets: readonly { readonly facet: TopicFacet; readonly verdict: TopicDispositionVerdict }[];
  /** The disposition rows this validation accepted, ascending by topic id. Empty when any of them failed to parse. */
  readonly dispositions: readonly TopicDisposition[];
  readonly obligations: PlanObligationAccounting;
  readonly documents: readonly PlanDocumentReading[];
  /** The authoring order: every unit after all of its children. Empty when the graph is not acyclic. */
  readonly authoringOrder: readonly string[];
  /** The re-derived budget. The proposal's echo is compared against this, never trusted in its place. */
  readonly budget: PlanBudget;
  /** Plan-level problems (the disposition ones live in the verdicts). */
  readonly problems: readonly string[];
}

export type UnitDagOrder =
  | { readonly state: "acyclic"; readonly order: readonly string[] }
  | { readonly state: "cyclic"; readonly cycle: readonly string[] };

/**
 * The authoring order, or the cycle that stops one existing.
 *
 * Children before parents, ascending by unit id among the ready ones, so the order is a pure function of the unit
 * set. A child id no unit declares is IGNORED here — it is already a named reference problem, and treating it as
 * an unsatisfiable dependency would report a phantom cycle instead.
 */
export function unitDagOrder(units: readonly ProposedUnit[]): UnitDagOrder {
  const byId = new Map(units.map((unit) => [unit.unitId, unit]));
  const childrenOf = (unit: ProposedUnit): string[] => unitChildIds(unit).filter((id) => byId.has(id) && id !== unit.unitId);
  const emitted = new Set<string>();
  const order: string[] = [];
  const remaining = [...byId.keys()].sort((a, b) => a.localeCompare(b));
  let progress = true;
  while (progress) {
    progress = false;
    for (const unitId of remaining) {
      if (emitted.has(unitId)) continue;
      if (!childrenOf(byId.get(unitId)!).every((child) => emitted.has(child))) continue;
      emitted.add(unitId);
      order.push(unitId);
      progress = true;
    }
  }
  if (emitted.size === byId.size) return { state: "acyclic", order };
  return { state: "cyclic", cycle: findCycle(byId, childrenOf) ?? remaining.filter((id) => !emitted.has(id)) };
}

/** One concrete cycle, so the failure names a path a reader can follow instead of a set of suspects. */
function findCycle(byId: ReadonlyMap<string, ProposedUnit>, childrenOf: (unit: ProposedUnit) => string[]): string[] | null {
  const state = new Map<string, "open" | "closed">();
  const stack: string[] = [];
  const walk = (unitId: string): string[] | null => {
    const seen = state.get(unitId);
    if (seen === "closed") return null;
    if (seen === "open") return [...stack.slice(stack.indexOf(unitId)), unitId];
    state.set(unitId, "open");
    stack.push(unitId);
    for (const child of childrenOf(byId.get(unitId)!)) {
      const cycle = walk(child);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(unitId, "closed");
    return null;
  };
  for (const unitId of [...byId.keys()].sort((a, b) => a.localeCompare(b))) {
    const cycle = walk(unitId);
    if (cycle) return cycle;
  }
  return null;
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

  // --- the graph.
  const dag = unitDagOrder(proposal.units);
  if (dag.state === "cyclic") {
    problems.push(`the unit graph has a cycle: ${dag.cycle.join(" -> ")}; a synthesis cannot depend on a unit that depends on it`);
  }

  // --- one root per document, and the per-document budget.
  const budget = planBudgetFor(requests, budgetTable);
  const budgetByDocument = new Map(budget.documents.map((row) => [row.documentId, row]));
  if (stableJson(proposal.budget) !== stableJson(budget)) {
    problems.push(`the proposal echoes a budget that is not the one the recorded requests derive; a plan does not set its own budget (echoed ${stableJson(proposal.budget)}, derived ${stableJson(budget)})`);
  }
  const documents: PlanDocumentReading[] = [];
  for (const documentId of [...requestedIds].sort()) {
    const units = proposal.units.filter((unit) => unit.documentId === documentId);
    const named = new Set(units.flatMap((unit) => unitChildIds(unit)));
    const rootUnitIds = units.map((unit) => unit.unitId).filter((unitId) => !named.has(unitId)).sort((a, b) => a.localeCompare(b));
    const documentBudget = budgetByDocument.get(documentId)!;
    let inputBytes = 0;
    for (const unit of units) {
      const topics = unitTopicIds(unit).map((topicId) => topicsById.get(topicId)).filter((topic): topic is TopicCandidate => topic !== undefined);
      const bytes = unitInputBytes(topics);
      inputBytes += bytes;
      if (bytes > documentBudget.perUnitInputBytes) {
        problems.push(`unit ${JSON.stringify(unit.unitId)} would be handed ${bytes} bytes of topic dossier over the ${documentBudget.detailBudget} per-unit budget of ${documentBudget.perUnitInputBytes} (topics: ${unitTopicIds(unit).join(", ")}); the plan is not satisfiable at this granularity and nothing here truncates it`);
      }
    }
    if (units.length > 0 && rootUnitIds.length !== 1) {
      problems.push(`document ${JSON.stringify(documentId)} has ${rootUnitIds.length} root unit(s) (${rootUnitIds.join(", ") || "none"}); a document assembles from exactly one root`);
    }
    if (inputBytes > documentBudget.totalInputBytes) {
      problems.push(`document ${JSON.stringify(documentId)} would read ${inputBytes} bytes of topic dossier over its ${documentBudget.detailBudget} total budget of ${documentBudget.totalInputBytes}`);
    }
    documents.push({ documentId, rootUnitIds, units: units.length, inputBytes, budget: documentBudget });
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
  // the rows. Parsed once here so the obligation accounting sees exactly the rows that validator judged.
  const dispositionReport = validateTopicDispositions(catalog, proposal.dispositions, registry);
  const parsedRows: TopicDisposition[] = [];
  const byTopic = new Map<string, TopicDisposition>();
  if (Array.isArray(proposal.dispositions)) {
    for (const row of proposal.dispositions) {
      const parsed = parseTopicDisposition(row);
      if (parsed.disposition === null) continue;
      if (byTopic.has(parsed.disposition.topicId)) continue;
      byTopic.set(parsed.disposition.topicId, parsed.disposition);
      parsedRows.push(parsed.disposition);
    }
  }
  for (const disposition of parsedRows) {
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
  const obligations = accountPlanObligations(catalog, proposal.units, byTopic);
  problems.push(...obligationAccountingProblems(obligations));

  parsedRows.sort((a, b) => a.topicId.localeCompare(b.topicId));
  return {
    version: PLAN_VALIDATION_VERSION,
    overall: overallVerdict(catalog, dispositionReport, problems),
    facets: dispositionReport.facets.map((row) => ({ facet: row.facet, verdict: row.verdict })),
    dispositions: parsedRows,
    obligations,
    documents,
    authoringOrder: dag.state === "acyclic" ? dag.order : [],
    budget,
    problems
  };
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
