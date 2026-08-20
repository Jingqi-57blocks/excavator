/**
 * Shared setup for the R6b admission e2e: ONE real frozen run, authored through the real commands, then re-planned.
 *
 * EVERYTHING HERE HAPPENS ON DISK, THROUGH THE REAL DOORS. `draftUnit` and `collectUnits` write the units; `planRun`
 * records every plan, and every plan after the first is a real `--revise`; `appendReportRequest` is what adds the
 * second audience's document. Nothing hand-writes a ledger row, a receipt, a plan artifact or a request row —
 * because what the admission tests have to establish is that a re-entry passes the gates a real run passes, and a
 * fixture that assembled the prior state itself would be testing its own assembly.
 *
 * WHY THE PERTURBATIONS ARE PLAN-LEVEL. A binding-preserving change to a TOPIC cannot be made on a live run without
 * editing a ledger the epoch seals (refused by name, correctly). So the live perturbations here are the two a
 * re-plan legitimately produces: one more requested document, and one unit's title changed. Both keep every
 * binding and every obligation identical, which is what the epic's "rebuild the leaf and its ancestors" case
 * needs; the topic-content and binding-set shapes stay where R6a proved them, at the value layer, over two plan
 * states.
 */

import { writeFile } from "node:fs/promises";
import { canonicalJson, stableJson } from "../src/base/util.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { FULL_OBLIGATION_SCOPE } from "../src/report/obligation-scope.ts";
import { parsePlanProposal, type PlanProposal, type ProposedUnit } from "../src/report/plan-proposal.ts";
import { plannedDocumentId, type LegacyDocumentRequest } from "../src/report/legacy-request-mapping.ts";
import { appendReportRequest } from "../src/report/report-requests-append.ts";
import { readReportRequests } from "../src/report/report-requests-artifact.ts";
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
 * IT SUPERSEDES THE RECORDED PLAN THROUGH THE REAL DOOR. `plan/catalog.json` is written once per (epoch, revision),
 * and a superseded plan is the ONLY state a unit cache can have candidates in — cross-epoch rows are excluded by
 * design. `--revise` is the operation that reaches that state: it records the next revision, names the digest of
 * the one it replaces, and archives it under `plan/revisions/`. Nothing here deletes a plan artifact, so the only
 * way this fixture can offer a candidate is the way an operator has.
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
  await planRun(run.runDir, { mode: "file", path }, { kind: "revise", reason: `the ${label} scenario re-plans this run` });
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
 * Add one document to the recorded requests — the second-audience shape, on disk, through the append door.
 *
 * The run's own detail level and language are carried over, so the appended row is the row prepare would have
 * written had the request named both audiences. The door refuses to touch the row already recorded, which is why
 * this scenario can be trusted to be "one more document" and nothing else.
 */
export async function requestSecondDocument(run: PlannedRun): Promise<void> {
  const recorded = await readReportRequests(run.runDir);
  if (recorded.requests.length !== 1) {
    throw new Error(`the second-audience fixture appends to a run that records one document; this one records ${recorded.requests.length}`);
  }
  const second: LegacyDocumentRequest = {
    documentId: plannedDocumentId("overview", "engineering", null),
    kind: "overview",
    audience: "engineering",
    featureKey: null,
    detailLevel: run.manifest.request.detailLevel ?? "standard",
    language: run.manifest.request.language
  };
  if (second.documentId !== SECOND_DOCUMENT) throw new Error(`the appended document is ${second.documentId}, and the tests name ${SECOND_DOCUMENT}`);
  await appendReportRequest(run.runDir, second);
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
