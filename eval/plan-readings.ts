// Deterministic, read-only projection of one frozen run's PLAN into byte readings.
//
// What it answers (57B-434 R3 baseline): what the planner packet costs and whether it fits its declared bound;
// what a model-free fixture plan looks like on this catalog (units by kind, per-document input bytes against the
// per-document budget); what plan validation concludes, per facet, in the three-state vocabulary; and — the one
// this slice exists for — where every MATERIAL OBLIGATION goes under that plan, including the by-id list of the
// ones a waiving disposition removed.
//
// Three rules this file holds:
//
//  1. It NEVER writes into the run directory it reads. The two R0 baselines are archival and 57B-452 (a run that
//     records absolute paths and splits when copied) is unfixed, so this builds every artifact in memory and the
//     readings land wherever the caller says. Nothing here calls the plan STAGE, which does write.
//  2. The recorded request set is RECOVERED, not invented. These baselines predate `plan/requests.json`, so the
//     v2 rows are derived from the run manifest's own planned documents through the same legacy mapping prepare
//     uses. A feature document that carries no `featureKey` (the field postdates these archives) has it recovered
//     from the document id by the packet renderer's own `featureKeyOf`, so the recovery cannot invent a feature.
//  3. Verdicts are recorded as their three states, never as a boolean, and the obligation buckets are recorded
//     with their id lists. A count with no list is a count nobody can check.
//
// R5a adds the ownership reading: per document, which unit owns each material obligation it reaches. On wcp it is
// what turns "each of the four documents owes the same 847 obligations three times over" into "the feature leaf owns
// 847 and the other two own 0", which is the deduplication the packet bytes then show.
//
// Zero model calls. Any input it cannot project is a named throw from the loader.

import { join } from "node:path";
import type { DocumentPlan, RunManifest } from "../src/base/types.ts";
import { readJson, sha256, canonicalJson } from "../src/base/util.ts";
import { featureKeyOf } from "../src/report/authoring-packet.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { buildPlanArtifacts, planCatalogDigest, reportRequestsDigest } from "../src/report/plan-artifacts.ts";
import { summariseObligationAccounting, type PlanObligationAccounting } from "../src/report/plan-obligation-conservation.ts";
import { AUTHORING_UNIT_KINDS } from "../src/report/plan-proposal.ts";
import { summarisePlanValidation, measuredDocumentBytes } from "../src/report/plan-validation.ts";
import { planThroughBudgetRefinement } from "../src/report/plan-unit-split.ts";
import { loadRunEvidenceReach } from "../src/report/run-evidence-reach.ts";
import { MATERIALITY_BUCKET_DEFINITIONS, PLANNER_PACKET_BYTE_LIMIT, renderPlannerPacket } from "../src/report/planner-packet.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { buildReportRequestsArtifact, type ReportRequestsArtifact } from "../src/report/report-requests-artifact.ts";
import { buildTopicCatalog } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import { topicCatalogDigest } from "../src/report/topics-artifact.ts";
import { summariseVerdict } from "../src/report/topic-disposition.ts";

export const PLAN_READINGS_VERSION = "plan-readings-v1";

export interface PlanDocumentReadingRow {
  readonly documentId: string;
  readonly audience: string;
  readonly intent: string;
  readonly detailBudget: string;
  readonly rootUnitId: string;
  readonly units: number;
  readonly inputBytes: number;
  readonly perUnitInputBytes: number;
  readonly totalInputBytes: number;
}

export interface PlanReadings {
  readonly version: typeof PLAN_READINGS_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly knowledgeDigest: string;
  readonly topicsDigest: string;
  readonly requestsDigest: string;
  readonly planCatalogDigest: string;
  readonly dagDigest: string;
  /** The model-facing view's cost against its declared bound, and whatever it had to record as a limitation. */
  readonly packetBytes: number;
  readonly packetByteLimit: number;
  readonly packetLimitations: readonly string[];
  /** The bucket definitions as the packet actually printed them — the wording, in the readings. */
  readonly bucketDefinitions: readonly string[];
  readonly units: number;
  readonly unitsByKind: readonly { readonly kind: string; readonly units: number }[];
  readonly documents: readonly PlanDocumentReadingRow[];
  /**
   * R5b: every over-budget unit the budget refinement divided, with the rung and the parts it became.
   *
   * Empty means the proposal already fitted. It is a reading rather than an assertion: what the ladder actually did
   * on a real corpus is the thing a reviewer has to be able to see.
   */
  readonly divisions: readonly { readonly unitId: string; readonly level: string; readonly measuredBytes: number; readonly byteLimit: number; readonly partUnitIds: readonly string[] }[];
  /** Measurement passes the refinement took. 1 means nothing was divided. */
  readonly refinementPasses: number;
  /** Per-unit measured packet bytes against the per-unit bound, ascending. The same-source measure, recorded. */
  readonly unitBytes: readonly { readonly unitId: string; readonly kind: string; readonly costState: string; readonly bytes: number; readonly byteLimit: number; readonly overBy: number }[];
  /** Units over their own bound after refinement. Zero is the acceptance condition. */
  readonly overBudgetUnitIds: readonly string[];
  readonly overallVerdict: string;
  readonly facetVerdicts: readonly { readonly facet: string; readonly verdict: string }[];
  readonly materialTopics: number;
  /** Gate 1b's reading. The denominator here is the OBLIGATION ledger's material bucket, not the topic count. */
  readonly obligations: PlanObligationAccounting;
  readonly obligationSummary: string;
  /**
   * R5a's ownership reading, per document: who owns each material obligation the document reaches.
   *
   * One row per unit, always, so a unit that owns nothing is a visible zero. `unownedObligationIds` is empty on any
   * plan that validates — an obligation only referencing units reach is a named violation, not a bucket.
   */
  readonly ownership: readonly {
    readonly documentId: string;
    readonly reachedObligations: number;
    readonly ownedByUnit: readonly { readonly unitId: string; readonly kind: string; readonly role: string; readonly owned: number }[];
    readonly unownedObligationIds: readonly string[];
  }[];
  /** The route facet's unobligated count, next to the definition that says what the word means. */
  readonly routeFacetUnobligated: number;
  readonly namedEmptyFacets: readonly { readonly facet: string; readonly state: string; readonly reason: string }[];
  readonly readPaths: readonly string[];
}

/** Recover the v2 request rows from the run manifest, the way prepare records them. */
function requestsFor(manifest: RunManifest): ReportRequestsArtifact {
  return buildReportRequestsArtifact(manifest.documents.map((document: DocumentPlan) => ({
    documentId: document.id,
    kind: document.kind,
    audience: document.audience,
    featureKey: document.kind === "feature" ? featureKeyOf(document) : null,
    detailLevel: manifest.request.detailLevel ?? "standard",
    language: manifest.request.language
  })));
}

/** Project one frozen run directory. Never writes; every failure is a named throw. */
export async function extractPlanReadings(runDir: string): Promise<PlanReadings> {
  const source = await loadTopicCatalogSource(runDir);
  const catalog = buildTopicCatalog(source);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const requests = requestsFor(manifest);
  const packet = renderPlannerPacket({
    catalog,
    requests,
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    byteLimit: PLANNER_PACKET_BYTE_LIMIT,
    // Recorded, not refused: a baseline reading that threw would report nothing at all, and the whole point of
    // this projection is to say what the packet costs on a real corpus.
    overBudget: "record-limitation"
  });
  // The fixture plan goes through the SAME door a model's proposal does: validate, divide whatever is over budget,
  // validate the divided plan. `divisions` and `refinementPasses` below are what that door did on this corpus.
  const evidence = await loadRunEvidenceReach(runDir, source);
  const planned = planThroughBudgetRefinement({
    catalog,
    requests,
    proposal: buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE),
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    evidence: evidence.evidenceById,
    reach: evidence.reach
  });
  if (planned.state === "rejected") {
    throw new Error(`the fixture plan for ${runDir} cannot be recorded: ${planned.problems.join("; ")}`);
  }
  const report = planned.report;
  const artifacts = buildPlanArtifacts({
    catalog,
    requests,
    proposal: planned.proposal,
    budgetTable: PLAN_BUDGET_TABLE,
    verdict: report.overall
  });
  const requestById = new Map(requests.requests.map((record) => [record.documentId, record]));
  const route = catalog.facets.find((row) => row.facet === "route");

  return {
    version: PLAN_READINGS_VERSION,
    runId: catalog.runId,
    knowledgeEpoch: catalog.knowledgeEpoch,
    knowledgeDigest: catalog.knowledgeDigest,
    topicsDigest: topicCatalogDigest(catalog),
    requestsDigest: reportRequestsDigest(requests),
    planCatalogDigest: planCatalogDigest(artifacts.planCatalog),
    dagDigest: sha256(canonicalJson(artifacts.dag)),
    packetBytes: packet.bytes,
    packetByteLimit: packet.byteLimit,
    packetLimitations: packet.limitations,
    bucketDefinitions: MATERIALITY_BUCKET_DEFINITIONS.filter((definition) => packet.markdown.includes(definition)),
    units: artifacts.planCatalog.units.length,
    unitsByKind: AUTHORING_UNIT_KINDS.map((kind) => ({ kind, units: artifacts.planCatalog.units.filter((unit) => unit.kind === kind).length })),
    divisions: planned.divisions.map((row) => ({
      unitId: row.unitId,
      level: row.level,
      measuredBytes: row.measuredBytes,
      byteLimit: row.byteLimit,
      partUnitIds: row.partUnitIds
    })),
    refinementPasses: planned.iterations,
    unitBytes: report.packets.state === "measured"
      ? report.packets.measurement.units.map((row) => ({
          unitId: row.unitId,
          kind: row.kind,
          costState: row.cost.state,
          bytes: row.cost.bytes,
          byteLimit: row.byteLimit,
          overBy: row.overBy
        }))
      : [],
    overBudgetUnitIds: report.packets.state === "measured" ? report.packets.measurement.overBudgetUnitIds : [],
    documents: artifacts.planCatalog.documents.map((row) => {
      const record = requestById.get(row.documentId)!;
      const budget = artifacts.planCatalog.budget.documents.find((entry) => entry.documentId === row.documentId)!;
      return {
        documentId: row.documentId,
        audience: record.request.audience,
        intent: record.request.intent,
        detailBudget: record.request.detailBudget,
        rootUnitId: row.rootUnitId,
        units: row.units,
        // The MEASURED packet bytes of this document's units, from the one measurement `validatePlan` took. R4b
        // recorded a proxy here (canonical topic rows) that was out by 9x against what a packet renders.
        inputBytes: measuredDocumentBytes(report.packets, row.documentId) ?? 0,
        perUnitInputBytes: budget.perUnitInputBytes,
        totalInputBytes: budget.totalInputBytes
      };
    }),
    overallVerdict: summariseVerdict(report.overall),
    // Split on the FIRST separator only: a vacuous verdict's own source sentence contains one too, and splitting
    // on every occurrence silently dropped the half that says WHY the denominator was empty.
    facetVerdicts: summarisePlanValidation(report).slice(1).map((line) => ({
      facet: line.slice(0, line.indexOf(" — ")),
      verdict: line.slice(line.indexOf(" — ") + " — ".length)
    })),
    materialTopics: catalog.materiality.material,
    obligations: report.obligations,
    obligationSummary: summariseObligationAccounting(report.obligations),
    ownership: report.ownership.documents.map((document) => ({
      documentId: document.documentId,
      reachedObligations: document.reachedObligations,
      ownedByUnit: document.ownedByUnit.map((row) => ({ unitId: row.unitId, kind: row.kind, role: row.role, owned: row.owned })),
      unownedObligationIds: document.unowned.map((row) => row.workItemId)
    })),
    routeFacetUnobligated: route ? route.materiality.unobligated : 0,
    namedEmptyFacets: catalog.facets
      .filter((row) => row.outcome.state !== "populated")
      .map((row) => ({ facet: row.facet, state: row.outcome.state, reason: row.outcome.state === "populated" ? "" : row.outcome.reason })),
    // `evidence.json` is in the list because the budget check RENDERS every packet to measure it, and a read that
    // does not name itself is a read the forbidden-input assertion cannot see.
    readPaths: [...new Set([...source.readPaths, ...evidence.readPaths])].sort((a, b) => a.localeCompare(b))
  };
}
