/**
 * Shared setup for the R6b admission e2e: ONE real frozen run, authored through the real commands, then re-planned.
 *
 * EVERYTHING HERE HAPPENS ON DISK, THROUGH THE REAL DOORS. `draftUnit` and `collectUnits` write the units; `planRun`
 * records every plan. Nothing hand-writes a ledger row, a receipt or a plan artifact — because what the admission
 * tests have to establish is that a re-entry passes the gates a real run passes, and a fixture that assembled the
 * prior state itself would be testing its own assembly. The one thing written by hand is `plan/requests.json` for
 * the second-audience scenario, and it is written with `buildReportRequestsArtifact`, Core's own builder, because
 * prepare writes that file once per run and this scenario is precisely "one more document was requested".
 *
 * WHY THE PERTURBATIONS ARE PLAN-LEVEL. A binding-preserving change to a TOPIC cannot be made on a live run without
 * either editing a ledger the epoch seals (refused by name, correctly) or re-freezing, which 57B-462 blocks on this
 * branch. So the live perturbations here are the two a re-plan legitimately produces: one more requested document,
 * and one unit's title changed. Both keep every binding and every obligation identical, which is what the epic's
 * "rebuild the leaf and its ancestors" case needs; the topic-content and binding-set shapes stay where R6a proved
 * them, at the value layer, over two plan states.
 */

import { rm, writeFile } from "node:fs/promises";
import { canonicalJson, exists, stableJson, writeJson } from "../src/base/util.ts";
import { planCatalogPath, planDagPath } from "../src/report/plan-artifacts.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { FULL_OBLIGATION_SCOPE } from "../src/report/obligation-scope.ts";
import { parsePlanProposal, type PlanProposal, type ProposedUnit } from "../src/report/plan-proposal.ts";
import type { LegacyDocumentRequest } from "../src/report/legacy-request-mapping.ts";
import { buildReportRequestsArtifact, readReportRequests, reportRequestsPath } from "../src/report/report-requests-artifact.ts";
import { buildTopicCatalog, type TopicCatalogArtifact } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import type { UnitAuthorship } from "../src/report/unit-provenance.ts";
import { FIXTURE_DRAFT_AUTHORSHIP, manifestOf, planViewOf, plannedRun, unitDraftFor, type PlannedRun } from "./unit-fixture.ts";

/** The author of every draft and every admission in these tests — the same one, so nothing measures an author change. */
export const ADMISSION_AUTHORSHIP: UnitAuthorship = FIXTURE_DRAFT_AUTHORSHIP;

/** The document the sample target's own request produces, and the second audience's. */
export const FIRST_DOCUMENT = "overview-product";
export const SECOND_DOCUMENT = "overview-engineering";

/** How a proposal is mutated before it is recorded. Takes the fixture plan's units and this run's catalog. */
export type ProposalMutation = (units: readonly ProposedUnit[], catalog: TopicCatalogArtifact) => readonly ProposedUnit[];

/** A planned run whose `overview-product` document holds an appendix, a second leaf, and a synthesis over both. */
export async function admissionRun(): Promise<PlannedRun> {
  const run = await plannedRun(["product"]);
  return recordPlan(run, "with-leaf", withExtraLeaf(FIRST_DOCUMENT));
}

/** Reload the plan view after anything that re-plans the run, at the epoch the manifest selects NOW. */
export async function reloadPlan(run: PlannedRun): Promise<PlannedRun> {
  return { ...run, manifest: await manifestOf(run.runDir), view: await planViewOf(run.runDir) };
}

/**
 * Record a plan derived from THIS run's current requests, with the units mutated, through `planRun`'s file mode.
 *
 * The proposal goes through `parsePlanProposal` here and through the whole validator inside `planRun`, so no state
 * these tests stand on is a plan Core would refuse.
 *
 * IT REMOVES THE RECORDED PLAN FIRST, AND THAT IS A FINDING RATHER THAN A CONVENIENCE. `writePlanArtifacts` writes
 * `plan/catalog.json` and `plan/dag.json` ONCE PER EPOCH and refuses different bytes for an epoch it already
 * recorded (`plan-artifacts.ts`), so no command re-plans a run within its knowledge epoch. But a superseded plan is
 * the ONLY state a unit cache can ever have candidates in — cross-epoch rows are excluded by design — so the state
 * this whole slice is about is unreachable through supported operations today. The fixture reaches it by deleting
 * the two recorded artifacts, in the open, so that what the admission does with that state can be tested at all.
 * The missing piece (an explicit re-plan operation) is reported with the slice, not worked around in `src/`.
 */
export async function recordPlan(run: PlannedRun, label: string, mutate: ProposalMutation): Promise<PlannedRun> {
  const catalog = buildTopicCatalog(await loadTopicCatalogSource(run.runDir, await manifestOf(run.runDir)));
  const requests = await readReportRequests(run.runDir);
  const base = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const units = [...mutate(base.units, catalog)].sort((a, b) => a.unitId.localeCompare(b.unitId));
  const parsed = parsePlanProposal({ ...JSON.parse(canonicalJson(base)) as Record<string, unknown>, units: units.map((unit) => JSON.parse(canonicalJson(unit)) as unknown) });
  if (!parsed.proposal) throw new Error(`the ${label} proposal does not parse: ${parsed.problems.join("; ")}`);
  const path = `${run.workdir}/proposal-${label}.json`;
  await writeFile(path, `${stableJson(parsed.proposal satisfies PlanProposal)}\n`);
  for (const recorded of [planCatalogPath(run.runDir), planDagPath(run.runDir)]) {
    if (await exists(recorded)) await rm(recorded);
  }
  await planRun(run.runDir, { mode: "file", path });
  return reloadPlan(run);
}

/**
 * A second LEAF, over two topics no unit of this document names, added to the document and to its synthesis.
 *
 * The sample target has no material topic at all (the zero-feature shape), so the generated plan is a synthesis over
 * a single appendix. A document with THREE units is what makes a mixed outcome possible: one unit rebuilt, one
 * admitted beside it, and the root rebuilt because a child moved.
 *
 * ITS TOPICS ARE NOT THE APPENDIX'S, and that is the validator's rule rather than a preference: two OWNING units
 * naming one topic would both ground its obligations and render their evidence twice, which `validatePlan` refuses
 * by name (it did, on the first version of this fixture). A bridge over the appendix's one topic is not available
 * either — a bridge explains a relation and needs two topics, and this catalog gives the appendix exactly one.
 */
export function withExtraLeaf(documentId: string): ProposalMutation {
  return (units, catalog) => {
    const leafId = `${documentId}::leaf::extra`;
    const taken = new Set(units.flatMap((unit) => (unit.kind === "synthesis" ? [] : unit.topics.map((topic) => topic.topicId))));
    const free = catalog.topics
      .filter((topic) => !taken.has(topic.topicId) && topic.bindings.length > 0)
      .map((topic) => topic.topicId)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 2);
    if (free.length < 2) throw new Error(`this catalog holds ${free.length} bound topic(s) no unit names; the fixture needs two for a second leaf`);
    return [
      ...units.map((unit) => (unit.kind === "synthesis" && unit.documentId === documentId
        ? { ...unit, childUnitIds: [...unit.childUnitIds, leafId].sort((a, b) => a.localeCompare(b)) }
        : unit)),
      {
        kind: "leaf" as const,
        unitId: leafId,
        documentId,
        title: "Two more obligation dimensions",
        topics: free.map((topicId) => ({ topicId, obligationScope: FULL_OBLIGATION_SCOPE }))
      }
    ];
  };
}

/** One unit's title changed: a binding-preserving perturbation a re-plan legitimately produces. */
export function withTitle(unitId: string, title: string): ProposalMutation {
  return (units) => {
    if (!units.some((unit) => unit.unitId === unitId)) throw new Error(`the plan holds no unit ${unitId} to retitle`);
    return units.map((unit) => (unit.unitId === unitId ? { ...unit, title } : unit));
  };
}

/**
 * Add one document to the recorded requests — the second-audience shape, on disk.
 *
 * Written with Core's own builder rather than by hand, and the run's own detail level and language are carried over,
 * so the added row is the row prepare would have written had the request named both audiences.
 */
export async function requestSecondDocument(run: PlannedRun): Promise<void> {
  const recorded = await readReportRequests(run.runDir);
  const documents: LegacyDocumentRequest[] = run.manifest.documents.map((document) => ({
    documentId: document.id,
    kind: document.kind,
    audience: document.audience,
    featureKey: null,
    detailLevel: run.manifest.request.detailLevel ?? "standard",
    language: run.manifest.request.language
  }));
  if (documents.length !== recorded.requests.length) {
    throw new Error(`the fixture recovered ${documents.length} document(s) from the manifest and the run records ${recorded.requests.length}`);
  }
  const second: LegacyDocumentRequest = { ...documents[0]!, documentId: SECOND_DOCUMENT, audience: "engineering" };
  await writeJson(reportRequestsPath(run.runDir), buildReportRequestsArtifact([...documents, second]));
}

/** Draft and collect every planned unit, in the plan's own collection order. The prior verified state. */
export async function authorEveryUnit(run: PlannedRun): Promise<void> {
  for (const unitId of run.view.collectionOrder) {
    await draftUnit(run.runDir, await unitDraftFor(run, unitId));
    const collected = await collectUnits(run.runDir);
    if (!collected.collected.some((receipt) => receipt.unitId === unitId)) {
      throw new Error(`the fixture drafted ${unitId} and collect did not record it`);
    }
  }
}
