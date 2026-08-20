/**
 * Shared setup for the R4b tests: an in-memory plan over the frozen mini fixture, and a real run that actually
 * carries material obligations.
 *
 * WHY THE MINI FIXTURE FOR THE PURE TESTS. `tests/fixtures/topic-catalog-mini` is a frozen run whose obligation
 * ledger holds three MATERIAL work items with three different shapes: two `found` (one of them with two evidence
 * ids IN UNSORTED LEDGER ORDER and a trace id, which is what makes "verbatim" testable at all) and one
 * `searched-not-found`. Nothing here writes into it: the plan artifacts are built in memory, the way
 * `eval/plan-readings.ts` builds them over an archival baseline.
 *
 * WHY A SECOND, REAL RUN. The collect barrier needs a run with `run.json`, a timeline and a unit ledger, and the
 * sample target's own work items are all disposed non-material — the zero-material shape R4a asserts. So
 * `materialisedRun` disposes them THROUGH THE REAL COMMAND (`updateWorkItems`) with two of them left material, one
 * `found` citing a frozen source window and one `not-applicable`. It is the legitimate path, and freeze then seals
 * those statuses: nothing here hand-edits a sealed ledger.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceItem, InvestigationPlan, InvestigationWorkItem, RunManifest, SectionClaim } from "../src/base/types.ts";
import { readEvidenceCatalog } from "../src/investigation/evidence-store.ts";
import { freezeRun, prepareRun } from "../src/run/run.ts";
import { updateWorkItems } from "../src/run/stages/investigation-stage.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import type { ProposedUnit } from "../src/report/plan-proposal.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { buildPlanArtifacts, type PlanCatalogArtifact, type PlanCatalogUnit, type PlanDagArtifact } from "../src/report/plan-artifacts.ts";
import {
  deriveObligationOwnership,
  documentOwnership,
  ownershipUnitsOfProposal,
  materialObligationTopics,
  type DocumentObligationOwnership,
  type MaterialObligationTopics,
  type ObligationOwnershipIndex
} from "../src/report/plan-obligation-conservation.ts";
import { validatePlan } from "../src/report/plan-validation.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import type { ReportRequestsArtifact } from "../src/report/report-requests-artifact.ts";
import type { TopicCandidate } from "../src/report/topic-candidate.ts";
import type { TopicCatalogArtifact } from "../src/report/topic-catalog.ts";
import { renderUnitPacket, type RunEvidenceReach, type UnitDossier, type UnitPacket, type UnitPacketInput } from "../src/report/unit-packet.ts";
import type { PacketOverBudgetMode } from "../src/report/planner-packet.ts";
import { loadUnitPlanView, type UnitPlanView } from "../src/report/unit-plan-view.ts";
import { normalizeSection } from "../src/report/checkpoint.ts";
import { collectedUnitsFor, readUnitLedger } from "../src/report/unit-ledger.ts";
import { UNIT_SUMMARY_VERSION, unitClaimsDigest, unitContentDigest, validateUnitClaims, type UnitSummary } from "../src/report/unit-output.ts";
import type { UnitDraftInput } from "../src/report/unit-draft.ts";
import { miniRun } from "./plan-fixture.ts";
import { FIXTURE_DRAFT_AUTHORSHIP, unitRequest } from "./unit-fixture.ts";

/** The three material obligation ids of the mini fixture, pinned so a test can name one and stay readable. */
export const MINI_FOUND_TWO_EVIDENCE = "feature:leave-1a2b3c4d5e:logic:approve@svc/leave/approve.go:10";
export const MINI_FOUND_ONE_EVIDENCE = "feature:leave-1a2b3c4d5e:logic:approve@svc/holiday/approve.go:20";
export const MINI_SEARCHED_NOT_FOUND = "feature:promo-9f8e7d6c5b:logic:rank@svc/promo/rank.go:5";

export interface MiniPlan {
  readonly runDir: string;
  readonly catalog: TopicCatalogArtifact;
  readonly requests: ReportRequestsArtifact;
  readonly planCatalog: PlanCatalogArtifact;
  readonly dag: PlanDagArtifact;
  readonly obligations: readonly MaterialObligationTopics[];
  /** R5a's ownership index for the fixture plan — the same one `validatePlan` derived, not a second derivation. */
  readonly ownership: ObligationOwnershipIndex;
  readonly workItems: ReadonlyMap<string, InvestigationWorkItem>;
  readonly evidence: ReadonlyMap<string, EvidenceItem>;
  readonly unitsById: ReadonlyMap<string, PlanCatalogUnit>;
}

async function workItemsOf(runDir: string): Promise<Map<string, InvestigationWorkItem>> {
  const plan = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as InvestigationPlan;
  return new Map(plan.items.map((item) => [item.id, item]));
}

/** The mini fixture with a deterministic fixture plan built in memory. Nothing is written into the run. */
export async function miniPlan(): Promise<MiniPlan> {
  const run = await miniRun();
  const { runDir, catalog, requests } = run;
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const report = validatePlan({ catalog, requests, proposal, registry: REPORT_POLICY_REGISTRY, budgetTable: PLAN_BUDGET_TABLE, evidence: run.evidenceById, reach: run.reach });
  const artifacts = buildPlanArtifacts({ catalog, requests, proposal, budgetTable: PLAN_BUDGET_TABLE, verdict: report.overall });
  const evidence = await readEvidenceCatalog(runDir);
  return {
    runDir,
    catalog,
    requests,
    planCatalog: artifacts.planCatalog,
    dag: artifacts.dag,
    obligations: materialObligationTopics(catalog),
    ownership: report.ownership,
    workItems: await workItemsOf(runDir),
    evidence: new Map(evidence.evidence.map((item) => [item.id, item])),
    unitsById: new Map(artifacts.planCatalog.units.map((unit) => [unit.unitId, unit]))
  };
}

/** The ownership row of one unit's document. Named refusal on a miss, exactly as Core's own lookup is. */
export function ownershipOf(plan: MiniPlan, unit: PlanCatalogUnit): DocumentObligationOwnership {
  return documentOwnership(plan.ownership, unit.documentId);
}

/**
 * An ownership index over the mini catalog for a hand-built unit set.
 *
 * Used by the fixtures that need a unit shape `buildFixturePlan` never mints — a bridge, or two owning units naming
 * one topic. It goes through the same `deriveObligationOwnership`, so a fixture cannot hand the audit an ownership
 * nothing in Core would produce.
 */
export function ownershipForUnits(plan: MiniPlan, units: readonly ProposedUnit[]): ObligationOwnershipIndex {
  return deriveObligationOwnership(plan.catalog, ownershipUnitsOfProposal(units));
}

/** The topic rows one unit names, in the plan's own order — what a legal topic dossier holds. */
export function topicsOf(plan: MiniPlan, unit: PlanCatalogUnit): readonly TopicCandidate[] {
  return unit.topics.map((reference) => {
    const topic = plan.catalog.topics.find((row) => row.topicId === reference.topicId);
    if (!topic) throw new Error(`fixture: topic ${reference.topicId} is not in the mini catalog`);
    return topic;
  });
}

/** A legal topic dossier for one unit: its topics and every evidence record their obligations bind. */
export function dossierOf(plan: MiniPlan, unit: PlanCatalogUnit): UnitDossier {
  const topics = topicsOf(plan, unit);
  const evidence = new Map<string, EvidenceItem>();
  for (const topic of topics) {
    for (const binding of topic.bindings) {
      for (const id of binding.evidenceIds) {
        const item = plan.evidence.get(id);
        if (!item) throw new Error(`fixture: evidence ${id} is not in the mini catalog`);
        evidence.set(id, item);
      }
    }
  }
  return { source: "topics", topics, evidence };
}

/** The run-level evidence reach of the mini fixture: every frozen record, and the ones no obligation binds. */
export function reachOf(plan: MiniPlan): RunEvidenceReach {
  const bound = new Set<string>();
  for (const item of plan.workItems.values()) for (const id of item.evidenceIds) bound.add(id);
  const unbound = [...plan.evidence.values()].filter((item) => !bound.has(item.id));
  return { frozenEvidenceIds: plan.evidence.size, boundEvidenceIds: bound.size, unbound };
}

export interface MiniPacketOptions {
  readonly overBudget?: PacketOverBudgetMode;
  readonly byteLimit?: number;
  readonly dossier?: UnitDossier;
  readonly ownership?: DocumentObligationOwnership;
  readonly reach?: RunEvidenceReach;
}

/** The packet input for one mini-plan unit, with the pieces a negative fixture wants to replace. */
export function packetInput(plan: MiniPlan, unitId: string, options: MiniPacketOptions = {}): UnitPacketInput {
  const unit = plan.unitsById.get(unitId);
  if (!unit) throw new Error(`fixture: unit ${unitId} is not in the mini plan`);
  return {
    planCatalog: plan.planCatalog,
    facets: plan.catalog.facets,
    dag: plan.dag,
    requests: plan.requests,
    registry: REPORT_POLICY_REGISTRY,
    unitId,
    dossier: options.dossier ?? dossierOf(plan, unit),
    ownership: options.ownership ?? ownershipOf(plan, unit),
    reach: options.reach ?? reachOf(plan),
    byteLimit: options.byteLimit ?? 1_048_576,
    overBudget: options.overBudget ?? "refuse"
  };
}

export function miniPacket(plan: MiniPlan, unitId: string, options: MiniPacketOptions = {}): UnitPacket {
  return renderUnitPacket(packetInput(plan, unitId, options));
}

/** A claim that links one obligation and reuses the ids a test tells it to. */
export function claimFor(id: string, workItemId: string, overrides: Partial<SectionClaim> = {}): SectionClaim {
  return {
    id,
    marker: "fact",
    statement: `${workItemId} 的当前行为已记录。`,
    workItemIds: [workItemId],
    evidenceIds: [],
    traceIds: [],
    confidence: "high",
    ...overrides
  };
}

/**
 * A legal draft for one unit of a materialised run, with the claims a test chose.
 *
 * The digests come from Core's own normalizer and digest functions, exactly as `tests/unit-fixture.ts` argues: a
 * fixture that computed them a second way would be testing the second way. What varies here is only the claims,
 * because the claims are what the grounding audit reads.
 */
export async function unitDraftWithClaims(run: MaterialisedRun, unitId: string, claims: readonly SectionClaim[]): Promise<UnitDraftInput> {
  const unit = run.view.byId.get(unitId);
  if (!unit) throw new Error(`fixture asked for unit ${unitId}, which this plan does not hold`);
  const content = `## ${unit.title}\n\n${unit.unitId} 记录当前状态。\`事实\`\n`;
  const ledger = await readUnitLedger(run.runDir, run.manifest.id);
  const collected = new Map(collectedUnitsFor(ledger, run.view.knowledgeEpoch, run.view.planCatalogDigest).map((row) => [row.unitId, row]));
  const summary: UnitSummary = {
    version: UNIT_SUMMARY_VERSION,
    unitId: unit.unitId,
    documentId: unit.documentId,
    kind: unit.kind,
    coveredTopicIds: unit.topics.map((topic) => topic.topicId).sort((a, b) => a.localeCompare(b)),
    keyStatements: [`${unit.title} 的当前状态已记录。`],
    unknowns: [],
    terminology: [],
    contentDigest: unitContentDigest(normalizeSection(content, unit.title)),
    claimsDigest: unitClaimsDigest(validateUnitClaims(unit.unitId, unit.documentId, claims)),
    childSummaryDigests: [...unit.childUnitIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((childUnitId) => {
      const row = collected.get(childUnitId);
      if (!row) throw new Error(`fixture cannot summarise ${unitId}: its child ${childUnitId} is not collected`);
      return { childUnitId, summaryDigest: row.summaryDigest };
    })
  };
  return { unitId, content, claims: [...claims], summary, authorship: FIXTURE_DRAFT_AUTHORSHIP, provenance: { kind: "fresh" } };
}

export interface MaterialisedRun {
  readonly runDir: string;
  readonly workdir: string;
  readonly manifest: RunManifest;
  readonly view: UnitPlanView;
  /** The material obligation whose determination is `found`, and the evidence id it cites. */
  readonly foundWorkItemId: string;
  readonly foundEvidenceId: string;
  /** The material obligation whose determination is `not-applicable`. */
  readonly unresolvedWorkItemId: string;
}

/**
 * A prepared, frozen, planned run that carries two MATERIAL obligations.
 *
 * The dispositions go through `updateWorkItems`, so freeze seals exactly what this fixture claims. `found` cites a
 * source window the run already captured — a `found` obligation with no evidence would be a fixture that could not
 * exercise the reuse rule at all.
 */
export async function materialisedRun(): Promise<MaterialisedRun> {
  const request = await unitRequest(["product"]);
  const { runDir } = await prepareRun(request);
  const plan = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as InvestigationPlan;
  const evidence = await readEvidenceCatalog(runDir);
  const source = evidence.evidence.find((item) => item.kind === "source");
  if (!source) throw new Error("fixture: the prepared run captured no source evidence");
  const [found, unresolved, ...rest] = plan.items;
  if (!found || !unresolved) throw new Error("fixture: the prepared run has fewer than two work items");
  await updateWorkItems(runDir, [
    { id: found.id, status: "found", material: true, evidenceIds: [source.id], reason: "Kept material by the R4b fixture so a grounding audit has a denominator." },
    { id: unresolved.id, status: "not-applicable", material: true, reason: "Kept material and unresolved by the R4b fixture." },
    ...rest.map((item) => ({ id: item.id, status: "not-applicable" as const, material: false, reason: "Out of scope for the synthetic fixture snapshot." }))
  ]);
  const frozen = await freezeRun(runDir);
  if (!frozen.frozen) throw new Error(`fixture run did not freeze: ${frozen.findings.map((finding) => finding.message).join("; ")}`);
  await planRun(runDir, { mode: "fixture" });
  const manifest = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
  return {
    runDir,
    workdir: request.workdir,
    manifest,
    view: await loadUnitPlanView(runDir, manifest),
    foundWorkItemId: found.id,
    foundEvidenceId: source.id,
    unresolvedWorkItemId: unresolved.id
  };
}
