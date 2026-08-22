/**
 * The knowledge boundary a recorded request names, checked against the catalog the plan is validated over.
 *
 * WHY PLAN VALIDATION IS WHERE THIS BELONGS. `plan/requests.json` is a file on disk, re-read at every plan action,
 * and it is the document set units are minted for (`validatePlan`: "the requests are the document set"). So the
 * boundary a row names is an EXTERNAL INPUT to validation in the same sense a `--proposal <file>` is: the append
 * door checks the key it writes, and this checks the key the plan is about to mint units against, whatever wrote
 * it. Before either existed, a feature row naming a key the run never investigated produced a plan that validated
 * `complete` and a document of authoring units with no knowledge behind them.
 *
 * WHERE THE BOUND KEYS COME FROM. The catalog's own feature facet: `projectFeatures` mints exactly one topic per
 * key `contract/run-intent.json` binds, carrying the key as its ledger row id. Reading them off the catalog rather
 * than opening the contract again keeps validation a pure function of its inputs — and the catalog was itself
 * projected from that contract, so the two cannot disagree without the projection being wrong first.
 *
 * AN EMPTY FEATURE FACET IS A STATE, NOT A ZERO. A run that binds no feature has a `ledger-empty` census row with
 * its reason, and a feature request over it must say "this run binds no feature" rather than "your key is not in
 * this list of none" — 57B-449's lesson applied to a different denominator.
 *
 * EXHAUSTIVE OVER ALL SIX SCOPES, NO DEFAULT. Only `project` and `feature` have a producer today
 * (`legacy-request-mapping.ts`), and the other four are a NAMED problem rather than a silent pass: a request whose
 * boundary this file cannot resolve is a request whose units nobody can bound, so whoever adds the producer for
 * `domain` has to add its resolver in the same change instead of inheriting a green.
 *
 * WHAT THIS DOES NOT CHECK, and it is the other half of the same hole: whether the units of a feature document then
 * confine themselves to that feature's knowledge. That is measured, not guessed — see the note at
 * `buildFixturePlan`, which names the count and why the rule is not here yet.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";
import type { TopicCatalogArtifact } from "./topic-catalog.ts";

/** The feature keys this catalog projects, ascending. One per key the run's contract binds. */
export function catalogFeatureKeys(catalog: TopicCatalogArtifact): readonly string[] {
  return catalog.topics
    .filter((topic) => topic.facet === "feature")
    .map((topic) => topic.source.rowId)
    .sort((a, b) => a.localeCompare(b));
}

/** Named problems for every recorded request whose knowledge boundary this catalog cannot account for. */
export function scopeBoundaryProblems(catalog: TopicCatalogArtifact, requests: ReportRequestsArtifact): string[] {
  const problems: string[] = [];
  const bound = catalogFeatureKeys(catalog);
  for (const record of [...requests.requests].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
    problems.push(...boundaryProblemsOf(record.documentId, record.request.scope, record.request.scopeIds, bound));
  }
  return problems;
}

function boundaryProblemsOf(
  documentId: string,
  scope: ReportRequestsArtifact["requests"][number]["request"]["scope"],
  scopeIds: readonly string[],
  bound: readonly string[]
): string[] {
  switch (scope) {
    case "project":
      // The project boundary is the whole scope; `parseReportRequestV2` already refuses ids on it.
      return [];
    case "feature":
      return scopeIds
        .filter((scopeId) => !bound.includes(scopeId))
        .map((scopeId) => bound.length === 0
          ? `document ${JSON.stringify(documentId)} is bounded to feature ${JSON.stringify(scopeId)} and this run binds no feature at all, so the document has no knowledge to be written from`
          : `document ${JSON.stringify(documentId)} is bounded to feature ${JSON.stringify(scopeId)}, which this run did not investigate (bound features: ${bound.join(", ")}); its units would be written from knowledge the run does not hold`);
    case "domain":
    case "flow":
    case "component":
    case "change":
      return [`document ${JSON.stringify(documentId)} is bounded to scope ${JSON.stringify(scope)} (${scopeIds.join(", ") || "no id"}), and the catalog projects no facet that resolves that boundary; a plan cannot bound its units to a scope nothing attributes knowledge to`];
  }
  return assertNever(scope, "report request scope");
}
