/**
 * Shared setup for the plan-side tests: one frozen synthetic run, three recorded requests, and the two
 * denominators read INDEPENDENTLY of the code under test.
 *
 * `materialWorkItemIds` reads `workitems.json` directly and filters on the ledger's own `material` flag. It is
 * deliberately not derived from the catalog: it is the check that the plan's denominator IS the obligation
 * ledger's material bucket, and a denominator that came from the same code path as the thing it grades would
 * agree with it no matter what either one did. No id join anywhere — 57B-458 measured that a naive one silently
 * drops 665 of 946 rows, so the tests compare id SETS taken from one ledger each.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InvestigationPlan } from "../src/base/types.ts";
import type { LegacyDocumentRequest } from "../src/report/legacy-request-mapping.ts";
import { buildTopicCatalog, type TopicCatalogArtifact } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import { buildReportRequestsArtifact, writeReportRequests, type ReportRequestsArtifact } from "../src/report/report-requests-artifact.ts";
import { copyFixture } from "./helpers.ts";

export const MINI_FIXTURE = "topic-catalog-mini";
export const MINI_LEAVE_FEATURE = "leave-1a2b3c4d5e";

/** The three documents the plan tests request: two overviews and one feature view, all `standard`. */
export const MINI_DOCUMENTS: readonly LegacyDocumentRequest[] = [
  { documentId: "overview-product", kind: "overview", audience: "product", featureKey: null, detailLevel: "standard", language: "en-US" },
  { documentId: "overview-engineering", kind: "overview", audience: "engineering", featureKey: null, detailLevel: "standard", language: "en-US" },
  { documentId: "feature-leave-product", kind: "feature", audience: "product", featureKey: MINI_LEAVE_FEATURE, detailLevel: "standard", language: "en-US" }
];

export interface MiniRun {
  readonly runDir: string;
  readonly catalog: TopicCatalogArtifact;
  readonly requests: ReportRequestsArtifact;
}

/** A copy of the frozen mini fixture with `plan/requests.json` recorded. */
export async function miniRun(documents: readonly LegacyDocumentRequest[] = MINI_DOCUMENTS): Promise<MiniRun> {
  const runDir = await copyFixture(MINI_FIXTURE);
  const requests = await writeReportRequests(runDir, documents);
  const catalog = buildTopicCatalog(await loadTopicCatalogSource(runDir));
  return { runDir, catalog, requests };
}

/** The requests artifact without touching disk, for the pure-function tests. */
export function miniRequests(documents: readonly LegacyDocumentRequest[] = MINI_DOCUMENTS): ReportRequestsArtifact {
  return buildReportRequestsArtifact(documents);
}

/** The material obligation ids, straight from `workitems.json`. The 1b denominator, read from the ledger itself. */
export async function materialWorkItemIds(runDir: string): Promise<string[]> {
  const plan = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as InvestigationPlan;
  return plan.items.filter((item) => item.material).map((item) => item.id).sort((a, b) => a.localeCompare(b));
}

/** Every topic that binds one obligation, ascending. Used to build a plan that waives ALL of them. */
export function topicsBinding(catalog: TopicCatalogArtifact, workItemId: string): string[] {
  return catalog.topics
    .filter((topic) => topic.bindings.some((binding) => binding.workItemId === workItemId))
    .map((topic) => topic.topicId)
    .sort((a, b) => a.localeCompare(b));
}
