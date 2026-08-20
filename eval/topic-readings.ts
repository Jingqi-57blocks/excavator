// Deterministic, read-only projection of one frozen run's Topic Catalog into byte readings.
//
// What it answers (57B-434 R2 baseline): how many topics per facet, in which of the three materiality buckets;
// which facets are named-empty and WHY; whether the obligation ledger conserves (total = assigned + unassigned);
// how many producer facts became topics and how many did not; and what the disposition validator concludes over a
// catalog with NO dispositions yet — which is the honest reading in this slice, because the only disposition
// producer at this point is a test fixture.
//
// Two rules this file exists to hold:
//
//  1. It NEVER writes into the run directory it reads. The two R0 baselines are archival, and 57B-452 (a run that
//     records absolute paths and splits in two when copied) is unfixed, so a generator that wrote a `plan/`
//     directory into them would be risking the baseline to save a temp copy. `extractTopicReadings` is a pure
//     function of the run directory's bytes, and the readings land wherever the caller says.
//  2. The validator conclusion is recorded as its THREE states, never as a boolean. `vacuous` over cebreo (whose
//     material-topic denominator is empty) and `complete` over a run that dispositioned everything are different
//     readings, and 57B-449 is what happens when an empty denominator gets to share a word with a real pass.
//
// Zero model calls. Any input it cannot project is a named throw from the loader — there is no path here that
// reports a zero because a file was missing.

import { join } from "node:path";
import type { RunManifest } from "../src/base/types.ts";
import { readJson } from "../src/base/util.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import { buildTopicCatalog, type TopicCatalogArtifact, type TopicFacetCensus } from "../src/report/topic-catalog.ts";
import { topicCatalogDigest } from "../src/report/topics-artifact.ts";
import { TOPIC_CONFIDENCES, type TopicConfidence } from "../src/report/topic-candidate.ts";
import { summariseVerdict, validateTopicDispositions } from "../src/report/topic-disposition.ts";

export const TOPIC_READINGS_VERSION = "topic-readings-v1";

export interface TopicFacetReading {
  readonly facet: string;
  readonly state: TopicFacetCensus["outcome"]["state"];
  readonly topics: number;
  /** The census row's own reason for an empty facet; empty string when the facet is populated. */
  readonly reason: string;
  readonly material: number;
  readonly obligatedNonMaterial: number;
  readonly unobligated: number;
  /** What the validator concludes for this facet over an empty disposition set, in words. */
  readonly verdictWithNoDispositions: string;
}

export interface TopicReadings {
  readonly version: typeof TOPIC_READINGS_VERSION;
  readonly runId: string;
  readonly snapshotId: string;
  readonly knowledgeEpoch: number;
  readonly knowledgeDigest: string;
  readonly catalogDigest: string;
  readonly topics: number;
  /** Obligation-granular bindings, summed over topics. A work item bound by two topics counts twice. */
  readonly bindings: number;
  readonly distinctBoundWorkItems: number;
  readonly unknownTopics: number;
  readonly materiality: TopicCatalogArtifact["materiality"];
  readonly confidence: Readonly<Record<TopicConfidence, number>>;
  readonly obligationAccounting: TopicCatalogArtifact["obligationAccounting"];
  readonly factRouting: TopicCatalogArtifact["factRouting"];
  readonly facets: readonly TopicFacetReading[];
  /** The facets that hold no topic, with the ledger reason — the "named empty" list, as a list. */
  readonly namedEmptyFacets: readonly { readonly facet: string; readonly state: string; readonly reason: string }[];
  readonly overallVerdictWithNoDispositions: string;
  /**
   * The CATALOG PROJECTION's input contract, recorded next to the numbers: every run-relative path
   * `loadTopicCatalogSource` opened, and no others. `run.json` is not among them — the extractor reads the
   * manifest to choose which epoch to project, and the epoch file it chose IS in the list, by its own name.
   */
  readonly readPaths: readonly string[];
}

/** Project one frozen run directory. Never writes; every failure is a named throw from the loader. */
export async function extractTopicReadings(runDir: string): Promise<TopicReadings> {
  // The manifest selects WHICH sealed epoch gets projected. Read here, before the load, so a re-frozen baseline
  // reads at its current epoch instead of forever at epoch 0.
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const source = await loadTopicCatalogSource(runDir, manifest);
  const catalog = buildTopicCatalog(source);
  const report = validateTopicDispositions(catalog, []);
  const verdictByFacet = new Map(report.facets.map((row) => [row.facet as string, summariseVerdict(row.verdict)]));
  const confidence = Object.fromEntries(TOPIC_CONFIDENCES.map((name) => [
    name,
    catalog.topics.filter((topic) => topic.confidence === name).length
  ])) as Record<TopicConfidence, number>;
  const facets: TopicFacetReading[] = catalog.facets.map((row) => ({
    facet: row.facet,
    state: row.outcome.state,
    topics: row.outcome.state === "populated" ? row.outcome.topics : 0,
    reason: row.outcome.state === "populated" ? "" : row.outcome.reason,
    material: row.materiality.material,
    obligatedNonMaterial: row.materiality.obligatedNonMaterial,
    unobligated: row.materiality.unobligated,
    verdictWithNoDispositions: verdictByFacet.get(row.facet) ?? "(no verdict row)"
  }));
  return {
    version: TOPIC_READINGS_VERSION,
    runId: catalog.runId,
    snapshotId: catalog.snapshotId,
    knowledgeEpoch: catalog.knowledgeEpoch,
    knowledgeDigest: catalog.knowledgeDigest,
    catalogDigest: topicCatalogDigest(catalog),
    topics: catalog.topics.length,
    bindings: catalog.topics.reduce((total, topic) => total + topic.bindings.length, 0),
    distinctBoundWorkItems: new Set(catalog.topics.flatMap((topic) => topic.bindings.map((row) => row.workItemId))).size,
    unknownTopics: catalog.topics.filter((topic) => topic.unknown).length,
    materiality: catalog.materiality,
    confidence,
    obligationAccounting: catalog.obligationAccounting,
    factRouting: catalog.factRouting,
    facets,
    namedEmptyFacets: facets.filter((row) => row.state !== "populated").map((row) => ({ facet: row.facet, state: row.state, reason: row.reason })),
    overallVerdictWithNoDispositions: summariseVerdict(report.overall),
    readPaths: source.readPaths
  };
}
