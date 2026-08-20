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
import { summarisePlanValidation, validatePlan } from "../src/report/plan-validation.ts";
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
  readonly overallVerdict: string;
  readonly facetVerdicts: readonly { readonly facet: string; readonly verdict: string }[];
  readonly materialTopics: number;
  /** Gate 1b's reading. The denominator here is the OBLIGATION ledger's material bucket, not the topic count. */
  readonly obligations: PlanObligationAccounting;
  readonly obligationSummary: string;
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
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const report = validatePlan({ catalog, requests, proposal, registry: REPORT_POLICY_REGISTRY, budgetTable: PLAN_BUDGET_TABLE });
  const artifacts = buildPlanArtifacts({ catalog, requests, proposal, report });
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
        inputBytes: row.inputBytes,
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
    routeFacetUnobligated: route ? route.materiality.unobligated : 0,
    namedEmptyFacets: catalog.facets
      .filter((row) => row.outcome.state !== "populated")
      .map((row) => ({ facet: row.facet, state: row.outcome.state, reason: row.outcome.state === "populated" ? "" : row.outcome.reason })),
    readPaths: source.readPaths
  };
}
