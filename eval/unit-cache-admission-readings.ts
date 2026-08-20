// Deterministic, read-only projection of one frozen run into UNIT CACHE ADMISSION readings (57B-434 R6b).
//
// WHAT THIS ANSWERS THAT R6A'S READING DOES NOT. On a re-planned run, a candidate's identity is NOT recomputed — the
// plan it was drafted under is no longer on disk — so the admission compares the identity DIGEST its ledger row
// recorded. That is a second form of candidate, and a second form is a second chance to disagree. This projection
// derives the invalidation plan TWICE over the same plan states, once with whole identities (the form only a
// projection holding both states can produce) and once with nothing but the digests a ledger row would have
// recorded, and it records whether the two agreed unit for unit. They must, in every scenario, on both baselines:
// the buckets are decided by one equality either way, and only the REBUILD REASON differs — sections named when the
// candidate's whole identity is in hand, "the plan it was drafted under is gone" when it is not.
//
// WHAT IT DELIBERATELY DOES NOT MEASURE. Whether a candidate's bytes on disk are still the verified ones, and
// therefore anything about ADMISSION ITSELF. Both R0 baselines are archival runs that authored no unit: there is no
// content, claims or summary to verify, and `CandidateVerification` has no "not checked" arm precisely so that a
// reading cannot pretend it verified something. The admitted/fell-to-rebuild/skipped-new account is exercised
// end to end against real run directories in `tests/unit-cache-admission-e2e.test.ts`, where the bytes exist.
//
// Nothing here writes into the run it reads: every plan state is built in memory, exactly as R6a's reading does.

import { join } from "node:path";
import { assertNever } from "../src/base/artifact-result.ts";
import type { RunManifest } from "../src/base/types.ts";
import { canonicalJson, readJson, sha256 } from "../src/base/util.ts";
import { planCatalogDigest } from "../src/report/plan-artifacts.ts";
import { loadRunEvidenceReach } from "../src/report/run-evidence-reach.ts";
import { buildReportRequestsArtifact } from "../src/report/report-requests-artifact.ts";
import { buildTopicCatalog } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import { describeAuthorship, type UnitAuthorship } from "../src/report/unit-provenance.ts";
import {
  deriveUnitCachePlan,
  type CandidateIdentity,
  type CandidateSource,
  type PlannedUnitIdentity,
  type RebuildReason,
  type UnitCacheEntry,
  type UnitCachePlan
} from "../src/report/unit-cache-plan.ts";
import { legacyDocuments, projectState, reminted, secondAudienceDocument, smallestMaterialTopic, withTopic } from "./unit-cache-identity-readings.ts";

export const UNIT_CACHE_ADMISSION_READINGS_VERSION = "unit-cache-admission-readings-v1";

/** The buckets of one invalidation plan, as the id lists a comparison is made of. */
export interface BucketReading {
  readonly reusable: readonly string[];
  readonly rebuild: readonly string[];
  readonly new: readonly string[];
  readonly retired: readonly string[];
}

/** One scenario, derived from both candidate forms. Closed: a target that cannot support it says so by name. */
export type AdmissionScenarioOutcome =
  | {
      readonly state: "derived";
      /** The units the plan of THIS scenario holds — not the base state's, which a perturbation can change. */
      readonly plannedUnits: number;
      readonly candidateStatement: string;
      /** From whole candidate identities — what a projection holding both plan states can decide. */
      readonly fromWholeIdentities: BucketReading;
      /** From the digests a ledger row would have recorded — what a re-planned run on disk decides. */
      readonly fromRecordedDigests: BucketReading;
      /** True when the two forms placed every unit in the same bucket. The extractor throws when it is false. */
      readonly bucketsAgree: boolean;
      /** How each form explained its rebuilds, by cause. The one place the two forms legitimately differ. */
      readonly rebuildCauses: readonly { readonly form: "whole-identities" | "recorded-digests"; readonly cause: string; readonly units: number }[];
      /** Rebuilds whose reason could name the sections that moved — only ever the whole-identity form. */
      readonly rebuildsNamingSections: readonly { readonly form: "whole-identities" | "recorded-digests"; readonly units: number }[];
    }
  | { readonly state: "not-applicable"; readonly reason: string };

export interface AdmissionScenarioReading {
  readonly scenario: string;
  readonly perturbation: string;
  readonly outcome: AdmissionScenarioOutcome;
}

export interface UnitAdmissionReadings {
  readonly version: typeof UNIT_CACHE_ADMISSION_READINGS_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly knowledgeDigest: string;
  readonly planCatalogDigest: string;
  readonly authorship: string;
  readonly plannedUnits: number;
  /** The units a candidate set can hold at all: the ones whose identity is computable on an archival run. */
  readonly candidateUnits: number;
  /**
   * Why this reading stops at the decision. Recorded rather than left to a reader to infer: an archival run has no
   * authored unit, so no candidate's bytes can be verified and no admission can be projected here.
   */
  readonly bytesNotVerified: string;
  readonly scenarios: readonly AdmissionScenarioReading[];
  readonly readPaths: readonly string[];
}

function bucketsOf(plan: UnitCachePlan): BucketReading {
  const ids = (status: UnitCacheEntry["status"]): readonly string[] =>
    plan.entries.filter((entry) => entry.status === status).map((entry) => entry.unitId);
  return { reusable: ids("reusable"), rebuild: ids("rebuild"), new: ids("new"), retired: plan.retired.map((row) => row.unitId) };
}

/** Whether a rebuild reason could name the sections that moved. Exhaustive over the causes. */
function namesSections(reason: RebuildReason): boolean {
  switch (reason.cause) {
    case "identity-changed":
      return reason.changedSections.length > 0;
    case "recorded-identity-differs":
    case "child-not-reusable":
    case "children-unavailable":
      return false;
  }
  return assertNever(reason, "unit cache rebuild reason cause");
}

function causeCensus(plan: UnitCachePlan, form: "whole-identities" | "recorded-digests"): readonly { readonly form: "whole-identities" | "recorded-digests"; readonly cause: string; readonly units: number }[] {
  const counts = new Map<string, number>();
  for (const entry of plan.entries) {
    if (entry.status !== "rebuild") continue;
    counts.set(entry.reason.cause, (counts.get(entry.reason.cause) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cause, units]) => ({ form, cause, units }));
}

/**
 * Derive one scenario from BOTH candidate forms over the same candidate identities.
 *
 * The recorded-digest form is built from the same identities, keeping only what a ledger row records — so any
 * difference in the buckets can only come from how the two forms are compared, which is the thing being checked. A
 * disagreement is a named throw: an instrument that reported it as a number would let the two forms drift.
 */
function outcomeOf(
  scenario: string,
  planned: readonly PlannedUnitIdentity[],
  candidates: readonly { readonly identity: PlannedUnitIdentity }[],
  candidateSource: CandidateSource
): AdmissionScenarioOutcome {
  const whole: CandidateIdentity[] = [];
  const recorded: CandidateIdentity[] = [];
  for (const { identity } of candidates) {
    if (identity.derivation === "children-unavailable") continue;
    whole.push({ form: "identity", identity: identity.identity });
    recorded.push({
      form: "recorded-digest",
      unitId: identity.identity.unitId,
      documentId: identity.identity.documentId,
      kind: identity.identity.kind,
      digest: identity.identity.digest,
      recordedBy: "the ledger row a prior collect would have written"
    });
  }
  const fromWhole = deriveUnitCachePlan({ planned, candidates: whole, candidateSource });
  const fromRecorded = deriveUnitCachePlan({ planned, candidates: recorded, candidateSource });
  const wholeBuckets = bucketsOf(fromWhole);
  const recordedBuckets = bucketsOf(fromRecorded);
  const agree = canonicalJson(wholeBuckets) === canonicalJson(recordedBuckets);
  if (!agree) {
    throw new Error(`scenario ${JSON.stringify(scenario)}: the two candidate forms placed units in different buckets (whole ${canonicalJson(wholeBuckets)} against recorded ${canonicalJson(recordedBuckets)}); reuse is decided by one equality and the forms may only differ in the reason they give`);
  }
  return {
    state: "derived",
    plannedUnits: fromRecorded.conservation.plannedUnits,
    candidateStatement: fromRecorded.candidateStatement,
    fromWholeIdentities: wholeBuckets,
    fromRecordedDigests: recordedBuckets,
    bucketsAgree: agree,
    rebuildCauses: [...causeCensus(fromWhole, "whole-identities"), ...causeCensus(fromRecorded, "recorded-digests")],
    rebuildsNamingSections: [
      { form: "whole-identities", units: fromWhole.entries.filter((entry) => entry.status === "rebuild" && namesSections(entry.reason)).length },
      { form: "recorded-digests", units: fromRecorded.entries.filter((entry) => entry.status === "rebuild" && namesSections(entry.reason)).length }
    ]
  };
}

/** Project one frozen run directory. Never writes; every failure is a named throw. */
export async function extractUnitAdmissionReadings(runDir: string): Promise<UnitAdmissionReadings> {
  const source = await loadTopicCatalogSource(runDir);
  const catalog = buildTopicCatalog(source);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const documents = legacyDocuments(manifest);
  const requests = buildReportRequestsArtifact(documents);
  const evidence = await loadRunEvidenceReach(runDir, source);
  const base = projectState("base", catalog, requests, evidence.evidenceById, evidence.reach);
  const candidates = base.planned.map((identity) => ({ identity }));
  const priorRun: CandidateSource = {
    origin: "prior-verified-units",
    runId: catalog.runId,
    knowledgeEpoch: catalog.knowledgeEpoch,
    planCatalogDigests: [planCatalogDigest(base.planCatalog)]
  };
  const scenarios: AdmissionScenarioReading[] = [];

  scenarios.push({
    scenario: "unchanged",
    perturbation: "nothing is changed; the plan is compared with the identities of its own units",
    outcome: outcomeOf("unchanged", base.planned, candidates, priorRun)
  });

  const second = secondAudienceDocument(documents);
  scenarios.push({
    scenario: "second-audience-document",
    perturbation: second === null
      ? "no document could be added: every audience this run's manifest can express is already requested"
      : `one document added to the recorded requests: ${second.documentId} (${second.kind}, audience ${second.audience})`,
    outcome: second === null
      ? { state: "not-applicable", reason: "this run's manifest already requests every document the legacy mapping can express for it" }
      : outcomeOf(
          "second-audience-document",
          projectState("second-audience", catalog, buildReportRequestsArtifact([...documents, second]), evidence.evidenceById, evidence.reach).planned,
          candidates,
          priorRun
        )
  });

  const smallest = smallestMaterialTopic(catalog.topics);
  scenarios.push(smallest === null
    ? {
        scenario: "content-change-smallest-topic",
        perturbation: "no material topic exists to perturb",
        outcome: { state: "not-applicable", reason: "this catalog holds no material topic with a binding, so a topic perturbation cannot be applied to one" }
      }
    : {
        scenario: "content-change-smallest-topic",
        perturbation: `binding-preserving: the title of topic ${smallest.topicId} (facet ${smallest.facet}, ${smallest.bindings.length} binding(s)) changed; its binding set and every other topic are untouched`,
        outcome: outcomeOf(
          "content-change-smallest-topic",
          projectState(
            "content-change-smallest-topic",
            withTopic(catalog, reminted(smallest, { title: `${smallest.title} (perturbed by eval)`, bindings: smallest.bindings })),
            requests,
            evidence.evidenceById,
            evidence.reach
          ).planned,
          candidates,
          priorRun
        )
      });

  return {
    version: UNIT_CACHE_ADMISSION_READINGS_VERSION,
    runId: catalog.runId,
    knowledgeEpoch: catalog.knowledgeEpoch,
    knowledgeDigest: catalog.knowledgeDigest,
    planCatalogDigest: planCatalogDigest(base.planCatalog),
    // Read off an identity this projection actually computed rather than restated here: the states come from R6a's
    // projection, and an authorship stated twice is an authorship that will one day be stated two ways.
    authorship: describeAuthorship(authorshipOf(base.planned)),
    plannedUnits: base.planCatalog.units.length,
    candidateUnits: base.planned.filter((identity) => identity.derivation !== "children-unavailable").length,
    bytesNotVerified: "this run authored no unit, so no candidate's content, claims or summary exists to verify; every reading here is the DECISION an admission would make, and none of them is an admission",
    scenarios,
    readPaths: [...new Set([...source.readPaths, "run.json", "evidence.json"])].sort((a, b) => a.localeCompare(b))
  };
}

/** The author every identity in this projection was computed for, taken from one of them. */
function authorshipOf(planned: readonly PlannedUnitIdentity[]): UnitAuthorship {
  for (const identity of planned) {
    if (identity.derivation !== "children-unavailable") return identity.identity.terms.authorship;
  }
  throw new Error("this projection computed no identity at all, so it cannot state the author they were computed for");
}

/** The readings' own content identity, for a caller that wants to compare two projections. */
export function unitAdmissionReadingsDigest(readings: UnitAdmissionReadings): string {
  return sha256(canonicalJson(readings));
}
