/**
 * How many bytes a plan actually costs — the ONE measurement, taken with the renderer the author reads from.
 *
 * WHY THIS FILE EXISTS. R4b's plan-time budget check measured a PROXY: the canonical bytes of a unit's topic rows
 * (`unitInputBytes`). Measured against the packet those rows produce, the proxy was out by about 9x on the wcp
 * baseline — one feature leaf's topic rows are ~220 KB and its packet is 1,993,499 B, because the packet also
 * renders the evidence bodies the obligations bind. The gate existed and the instrument was not attached to the
 * thing it graded, so eight units passed a check they exceeded. Nothing here estimates: every renderable unit is
 * measured by `unitPacketBytes`, which is the same composition `renderUnitPacket` returns, and the identity is
 * asserted per unit over both R0 baselines in test.
 *
 * A SYNTHESIS IS THE ONE UNIT THAT CANNOT BE RENDERED AT PLAN TIME, and it is bounded rather than estimated. Its
 * packet is its children's summaries, and no summary exists before its children are drafted — so the measure is a
 * WORST CASE that is still a real render: each child is represented by a synthetic summary whose rendered block is
 * exactly `perUnitSummaryBytes` (the plan's declared bound, enforced at draft), and the packet is composed from
 * those. The result is an upper bound by construction, computed by the same renderer, with no slack constant and no
 * second formula. This is where the output budget becomes load-bearing: without a declared summary bound a
 * synthesis's input is unbounded, and "every packet is inside its budget" could not be said at plan time at all.
 *
 * IT MEASURES, IT DOES NOT JUDGE. `measurePlanPackets` returns numbers; `packetMeasurementProblems` turns them into
 * named problems, and `plan-unit-split.ts` turns them into divisions. Keeping the three apart is what lets the
 * splitter re-measure a candidate plan without going through a verdict, and what stops a measurement from ever
 * being the thing that drops a row.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { EvidenceItem } from "../base/types.ts";
import { documentBudgetRow, type PlanBudgetTable, type PlanDocumentBudget } from "./plan-budget.ts";
import { derivePlanArtifacts, type PlanArtifacts, type PlanCatalogUnit } from "./plan-artifacts.ts";
import { deriveObligationOwnership, documentOwnership, ownershipUnitsOfProposal } from "./plan-obligation-conservation.ts";
import { scopeIncludes } from "./obligation-scope.ts";
import type { AuthoringUnitKind, PlanProposal } from "./plan-proposal.ts";
import type { ReportPolicyRegistry } from "./report-policy-registry.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";
import type { TopicCandidate } from "./topic-candidate.ts";
import type { TopicCatalogArtifact } from "./topic-catalog.ts";
import { UNIT_SUMMARY_VERSION, type UnitSummary } from "./unit-output.ts";
import { childSummaryBlockBytes, topicDossier, unitPacketBytes, type RunEvidenceReach, type UnitDossier } from "./unit-packet.ts";
import { compareUnitIds } from "./unit-paths.ts";

/**
 * Everything a measurement needs beyond the proposal itself. Every field required.
 *
 * `evidence` is a VALUE MAP, never a path: the measure runs over archival baselines that may not be written to and
 * have no `plan/` on disk, exactly like the R4b renderer it shares. `reach` is mechanism A's three numbers, derived
 * once by `evidenceReachOf` — the packet prints them, so a measurement that invented its own would be measuring a
 * different packet.
 */
export interface UnitPacketMeasureInputs {
  readonly catalog: TopicCatalogArtifact;
  readonly requests: ReportRequestsArtifact;
  readonly registry: ReportPolicyRegistry;
  readonly budgetTable: PlanBudgetTable;
  readonly evidence: ReadonlyMap<string, EvidenceItem>;
  readonly reach: RunEvidenceReach;
}

/**
 * What one unit's packet costs. Two arms, exhaustive, no default.
 *
 * `rendered` is the packet that exists now, measured. `bounded` is a synthesis: the same renderer over a worst-case
 * child set, with the three numbers that produced it so a failure can be read rather than guessed at.
 */
export type UnitPacketCost =
  | { readonly state: "rendered"; readonly bytes: number }
  | {
      readonly state: "bounded";
      readonly bytes: number;
      readonly children: number;
      readonly perChildBytes: number;
      /** The packet's cost with no child block at all: header, framing, and the child count line. */
      readonly fixedBytes: number;
    };

/** The bytes of one cost, whichever arm it is. Exhaustive. */
export function costBytes(cost: UnitPacketCost): number {
  switch (cost.state) {
    case "rendered":
    case "bounded":
      return cost.bytes;
  }
  return assertNever(cost, "unit packet cost state");
}

export interface UnitPacketCostRow {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  readonly cost: UnitPacketCost;
  readonly byteLimit: number;
  /** Bytes over the per-unit bound, or 0 when it fits. Never negative — "fits" is one number, not a sign. */
  readonly overBy: number;
  readonly topics: number;
  /** Obligations this unit's scopes select across its topics. What a division redistributes. */
  readonly obligationsInScope: number;
}

export interface DocumentPacketCostRow {
  readonly documentId: string;
  readonly bytes: number;
  readonly budget: PlanDocumentBudget;
  readonly overBy: number;
}

export interface PlanPacketMeasurement {
  /** Ascending by unit id. Every unit of the proposal, measured or bounded — none skipped. */
  readonly units: readonly UnitPacketCostRow[];
  /** Ascending by document id. */
  readonly documents: readonly DocumentPacketCostRow[];
  /** Unit ids over their own bound, ascending. Empty is the acceptance condition. */
  readonly overBudgetUnitIds: readonly string[];
}

/**
 * Measure every unit of one proposal.
 *
 * The plan artifacts are DERIVED here rather than accepted, so a measurement is always of the plan in hand: a
 * caller that passed artifacts could pass ones built from other units, and the packet header prints the plan's own
 * digest. It throws only on inconsistencies a validated plan cannot have (an unknown topic, an unowned material
 * obligation, a scope that partitions nothing) — which is why `validatePlan` measures ONLY after those checks are
 * clean, and reports `not-measured` with the reason when they are not.
 */
export function measurePlanPackets(inputs: UnitPacketMeasureInputs, proposal: PlanProposal): PlanPacketMeasurement {
  const artifacts = derivePlanArtifacts({ catalog: inputs.catalog, requests: inputs.requests, proposal, budgetTable: inputs.budgetTable });
  const ownership = deriveObligationOwnership(inputs.catalog, ownershipUnitsOfProposal(proposal.units));
  const topicsById = new Map(inputs.catalog.topics.map((topic) => [topic.topicId, topic]));
  const units: UnitPacketCostRow[] = [];
  for (const unit of [...artifacts.planCatalog.units].sort((a, b) => a.unitId.localeCompare(b.unitId))) {
    const budget = documentBudgetRow(artifacts.planCatalog.budget, unit.documentId);
    const cost = costOf(unit, artifacts, inputs, topicsById, ownership, budget);
    units.push({
      unitId: unit.unitId,
      documentId: unit.documentId,
      kind: unit.kind,
      cost,
      byteLimit: budget.perUnitInputBytes,
      overBy: Math.max(0, costBytes(cost) - budget.perUnitInputBytes),
      topics: unit.topics.length,
      obligationsInScope: obligationsInScopeOf(unit, topicsById)
    });
  }
  const documents: DocumentPacketCostRow[] = artifacts.planCatalog.documents.map((document) => {
    const budget = documentBudgetRow(artifacts.planCatalog.budget, document.documentId);
    const bytes = units.filter((row) => row.documentId === document.documentId).reduce((total, row) => total + costBytes(row.cost), 0);
    return { documentId: document.documentId, bytes, budget, overBy: Math.max(0, bytes - budget.totalInputBytes) };
  });
  return {
    units,
    documents,
    overBudgetUnitIds: units.filter((row) => row.overBy > 0).map((row) => row.unitId)
  };
}

/** How many obligations one unit's scopes select. Not a byte count — what a division has to redistribute. */
function obligationsInScopeOf(unit: PlanCatalogUnit, topicsById: ReadonlyMap<string, TopicCandidate>): number {
  let total = 0;
  for (const reference of unit.topics) {
    const topic = topicsById.get(reference.topicId);
    if (!topic) continue;
    total += topic.bindings.filter((binding) => scopeIncludes(reference.obligationScope, binding.workItemId)).length;
  }
  return total;
}

/** The cost of one unit, exhaustive over the kinds so a fifth has to say how it is measured. */
function costOf(
  unit: PlanCatalogUnit,
  artifacts: PlanArtifacts,
  inputs: UnitPacketMeasureInputs,
  topicsById: ReadonlyMap<string, TopicCandidate>,
  ownership: ReturnType<typeof deriveObligationOwnership>,
  budget: PlanDocumentBudget
): UnitPacketCost {
  const measure = (dossier: UnitDossier): number => unitPacketBytes({
    planCatalog: artifacts.planCatalog,
    facets: inputs.catalog.facets,
    dag: artifacts.dag,
    requests: inputs.requests,
    registry: inputs.registry,
    unitId: unit.unitId,
    dossier,
    ownership: documentOwnership(ownership, unit.documentId),
    reach: inputs.reach,
    byteLimit: budget.perUnitInputBytes,
    // A measurement is not a verdict, and `unitPacketBytes` does not consult this field. Stated rather than
    // omitted because the input type has no optional member: every caller says what over-budget would mean.
    overBudget: "refuse"
  });
  switch (unit.kind) {
    case "leaf":
    case "bridge":
    case "appendix":
      return { state: "rendered", bytes: measure(topicDossier(unit, topicsById, inputs.evidence)) };
    case "synthesis": {
      // The children are ordered by `compareUnitIds` because that is the order the renderer's own entry check
      // demands (`assertDossierMatchesUnit`). Two comparators for one list is how a measurement starts refusing the
      // very plan it is measuring.
      const children = [...unit.childUnitIds].sort(compareUnitIds);
      const worstCase = children.map((childUnitId) => maximalChildSummary(
        childUnitId,
        unit.documentId,
        kindOf(artifacts, childUnitId),
        budget.perUnitSummaryBytes
      ));
      const bytes = measure({ source: "child-summaries", children: worstCase });
      // The fixed cost is what is left once the child blocks are taken out: header, framing, and the separators
      // between them. Derived by subtraction from the same render rather than measured a second way — a synthesis
      // rendered with NO children is a packet the renderer refuses (its children are declared in the plan), so
      // there is no "empty" render to compare against, and inventing one would be a second measurement.
      const childBytes = worstCase.reduce((total, child) => total + childSummaryBlockBytes(child), 0);
      return {
        state: "bounded",
        bytes,
        children: children.length,
        perChildBytes: budget.perUnitSummaryBytes,
        fixedBytes: bytes - childBytes
      };
    }
  }
  return assertNever(unit.kind, "authoring unit kind");
}

function kindOf(artifacts: PlanArtifacts, unitId: string): AuthoringUnitKind {
  const child = artifacts.planCatalog.units.find((row) => row.unitId === unitId);
  if (!child) throw new Error(`Synthesis child ${JSON.stringify(unitId)} is not a unit of this plan, so its summary cannot be bounded`);
  return child.kind;
}

/** 64 zeroes: a syntactically valid sha256 for the synthetic worst-case summary. It is never written anywhere. */
const PLACEHOLDER_DIGEST = "0".repeat(64);

/**
 * A synthetic child summary whose RENDERED block is exactly `bytes` long, or the smallest one this child can have.
 *
 * The padding goes into one key statement, and the length is solved rather than guessed: the block is measured with
 * a one-character statement, and the filler is grown by the difference. So the worst case is the declared bound
 * exactly, which is what makes the synthesis measurement an upper bound with no slack constant in it. If the
 * smallest possible block already exceeds the bound (a child whose id alone is longer than the summary allowance),
 * the minimum is used and the resulting overrun is reported by `packetMeasurementProblems` like any other.
 */
export function maximalChildSummary(childUnitId: string, documentId: string, kind: AuthoringUnitKind, bytes: number): UnitSummary {
  const of = (statement: string): UnitSummary => ({
    version: UNIT_SUMMARY_VERSION,
    unitId: childUnitId,
    documentId,
    kind,
    coveredTopicIds: [],
    keyStatements: [statement],
    unknowns: [],
    terminology: [],
    contentDigest: PLACEHOLDER_DIGEST,
    claimsDigest: PLACEHOLDER_DIGEST,
    childSummaryDigests: []
  });
  const minimum = childSummaryBlockBytes(of("x"));
  if (bytes <= minimum) return of("x");
  return of("x".repeat(bytes - minimum + 1));
}

/**
 * The named problems in a measurement. Empty means every packet of the plan is inside its declared bounds.
 *
 * A per-unit overrun says WHAT to do about it — divide the unit's obligations, which `plan-unit-split.ts` does
 * deterministically — and never suggests trimming one, because nothing in this system trims. A synthesis overrun
 * prints its arithmetic (children, per-child bound, fixed cost) so the reader can see which of the three to change.
 */
export function packetMeasurementProblems(measurement: PlanPacketMeasurement): string[] {
  const problems: string[] = [];
  for (const row of measurement.units) {
    if (row.overBy === 0) continue;
    problems.push(unitOverBudgetProblem(row));
  }
  for (const row of measurement.documents) {
    if (row.overBy === 0) continue;
    problems.push(`document ${JSON.stringify(row.documentId)} would read ${row.bytes} bytes of packet across its units, ${row.overBy} byte(s) over its ${row.budget.detailBudget} total input budget of ${row.budget.totalInputBytes}; dividing a unit cannot change this sum — only owning fewer duplicate obligations can`);
  }
  return problems;
}

/**
 * The named problem one over-budget unit has. Exhaustive over the two cost arms, no default.
 *
 * Exported so `plan-unit-split.ts` reports the SAME sentence when it cannot divide a unit: the splitter and the
 * validator would otherwise describe one overrun two ways, and a reader would have to know which one to trust.
 */
export function unitOverBudgetProblem(row: UnitPacketCostRow): string {
  switch (row.cost.state) {
    case "rendered":
      return `unit ${JSON.stringify(row.unitId)} renders a ${row.cost.bytes}-byte packet, ${row.overBy} byte(s) over the ${row.byteLimit}-byte per-unit input budget of document ${JSON.stringify(row.documentId)} (${row.topics} topic(s), ${row.obligationsInScope} obligation(s) in scope); divide its obligations across more units — nothing here truncates a packet to fit`;
    case "bounded":
      return `synthesis unit ${JSON.stringify(row.unitId)} would be handed up to ${row.cost.bytes} bytes — ${row.cost.fixedBytes} fixed plus ${row.cost.children} child summar(ies) at the declared ${row.cost.perChildBytes}-byte bound each — which is ${row.overBy} byte(s) over the ${row.byteLimit}-byte per-unit input budget of document ${JSON.stringify(row.documentId)}; give this synthesis fewer children (an intermediate synthesis level), or lower the summary bound deliberately`;
  }
  return assertNever(row.cost, "unit packet cost state");
}

/** One line per unit, for a CLI reading or a PR table. The cost's arm is named, never flattened into a number. */
export function summariseUnitCost(row: UnitPacketCostRow): string {
  const fit = row.overBy === 0 ? "fits" : `OVER by ${row.overBy}`;
  switch (row.cost.state) {
    case "rendered":
      return `${row.unitId} (${row.kind}): ${row.cost.bytes} of ${row.byteLimit} bytes rendered — ${fit}`;
    case "bounded":
      return `${row.unitId} (${row.kind}): up to ${row.cost.bytes} of ${row.byteLimit} bytes bounded (${row.cost.children} x ${row.cost.perChildBytes} + ${row.cost.fixedBytes}) — ${fit}`;
  }
  return assertNever(row.cost, "unit packet cost state");
}
