/**
 * The model-free fixture plan: a legal plan derived from a catalog by construction, and the ONLY plan premise any
 * Core test is allowed to have.
 *
 * WHY IT EXISTS. Every gate downstream of the planner — the authoring precondition, the unit packet, the coverage
 * companions — needs a plan in place to be exercised. If that plan came from a model, the test suite would depend
 * on a model's output for its own preconditions, and a red test could mean "the code broke" or "the model wrote
 * something else today". So the plan a test uses is derived here, deterministically, from the catalog's own rows,
 * and it passes the SAME validator a model's proposal has to pass. Not a bypass: the same door.
 *
 * THE SHAPE. Per requested document: one leaf per facet that holds a material topic, carrying that facet's
 * material topics; one appendix carrying the coverage facet's non-material topics (the run's own unknowns, which
 * gate 10 requires to reach a reader); and one synthesis root over all of them. Every material topic gets a
 * `primary` disposition, so the obligation accounting comes out with everything in units and the waived list empty
 * — which is what makes a NON-empty waived list in a test a signal rather than noise.
 *
 * THE ZERO-FEATURE SHAPE IS FIRST-CLASS. The second baseline target has no feature, no route ledger and no
 * material topic at all (measured: 14 topics, 0 material). This generator mints no unit for a facet with no
 * material topic — it never forges a feature that does not exist — so on that catalog the plan is a synthesis over
 * a single appendix, and validation reads `vacuous`, not `complete`.
 */

import { FULL_OBLIGATION_SCOPE } from "./obligation-scope.ts";
import { planBudgetFor, type PlanBudgetTable } from "./plan-budget.ts";
import { PLAN_PROPOSAL_VERSION, type PlanProposal, type ProposedUnit } from "./plan-proposal.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";
import { TOPIC_FACETS, type TopicCandidate } from "./topic-candidate.ts";
import type { TopicCatalogArtifact } from "./topic-catalog.ts";
import type { TopicDisposition } from "./topic-disposition.ts";

export const FIXTURE_PLAN_VERSION = "fixture-plan-v1";

/**
 * A whole-topic reference per id: the generator never divides, so every scope is `all`.
 *
 * Stated as one helper rather than inline at three call sites, because `all` is a DECISION here: the fixture plan
 * proposes the undivided shape and `plan-unit-split.ts` divides whatever does not fit, through the same door a
 * model's proposal goes through. A generator that pre-divided would be a second splitter.
 */
function wholeTopics(topicIds: readonly string[]): readonly { readonly topicId: string; readonly obligationScope: typeof FULL_OBLIGATION_SCOPE }[] {
  return topicIds.map((topicId) => ({ topicId, obligationScope: FULL_OBLIGATION_SCOPE }));
}

/** Ascending topic ids of the catalog's material topics in one facet. */
function materialTopicsOf(catalog: TopicCatalogArtifact, facet: TopicCandidate["facet"]): readonly string[] {
  return catalog.topics
    .filter((topic) => topic.facet === facet && topic.materiality === "material")
    .map((topic) => topic.topicId)
    .sort((a, b) => a.localeCompare(b));
}

/** The coverage facet's non-material topics: the run's residual and unknowns, which the appendix carries. */
function coverageAppendixTopics(catalog: TopicCatalogArtifact): readonly string[] {
  return catalog.topics
    .filter((topic) => topic.facet === "coverage" && topic.materiality !== "material")
    .map((topic) => topic.topicId)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Derive a plan from a catalog and the recorded requests. Same inputs, same bytes, always.
 *
 * `budgetTable` is required rather than defaulted for the reason every flag in this codebase is required: a
 * generator that quietly used the live table would produce a plan whose budget nobody chose, and the negative
 * fixtures need to hand it a table small enough to overflow.
 */
export function buildFixturePlan(
  catalog: TopicCatalogArtifact,
  requests: ReportRequestsArtifact,
  budgetTable: PlanBudgetTable
): PlanProposal {
  const units: ProposedUnit[] = [];
  for (const record of [...requests.requests].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
    const documentId = record.documentId;
    const children: string[] = [];
    for (const facet of TOPIC_FACETS) {
      const topicIds = materialTopicsOf(catalog, facet);
      if (topicIds.length === 0) continue;
      const unitId = `${documentId}::leaf::${facet}`;
      children.push(unitId);
      units.push({ kind: "leaf", unitId, documentId, title: `Material ${facet} topics`, topics: wholeTopics(topicIds) });
    }
    const appendixId = `${documentId}::appendix::coverage`;
    children.push(appendixId);
    units.push({
      kind: "appendix",
      unitId: appendixId,
      documentId,
      title: "Coverage and unknowns",
      topics: wholeTopics(coverageAppendixTopics(catalog))
    });
    units.push({
      kind: "synthesis",
      unitId: `${documentId}::synthesis::document`,
      documentId,
      title: `${documentId} synthesis`,
      childUnitIds: [...children].sort((a, b) => a.localeCompare(b))
    });
  }

  const dispositions: TopicDisposition[] = catalog.topics
    .filter((topic) => topic.materiality === "material")
    .map((topic) => ({ topicId: topic.topicId, state: "primary" as const, reason: "", lensPolicyId: "" }))
    .sort((a, b) => a.topicId.localeCompare(b.topicId));

  return {
    version: PLAN_PROPOSAL_VERSION,
    units: units.sort((a, b) => a.unitId.localeCompare(b.unitId)),
    dispositions,
    budget: planBudgetFor(requests, budgetTable)
  };
}
