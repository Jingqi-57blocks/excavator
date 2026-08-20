/**
 * The plan stage: the one deterministic entry point that turns a frozen epoch plus a proposal into the recorded
 * plan artifacts.
 *
 * ZERO MODEL CALLS, both paths. `--fixture-plan` derives the proposal from the catalog; `--proposal <file>` reads
 * one somebody else produced (a model, through the skill) and puts it through the SAME validator. There is no
 * third path, and the model-facing packet is rendered by a separate read-only command — Core renders the view and
 * checks the answer; it never asks the question.
 *
 * ORDER, AND WHY. `plan/topics.json` is written FIRST, before the proposal is even looked at: it is a pure
 * projection of the sealed epoch, so it cannot depend on the plan, and having it on disk is what makes a rejected
 * proposal re-proposable against exactly the same catalog bytes. A rejected proposal writes nothing else and
 * leaves the run in the state it was in — a plan is corrected and re-validated, never a run condemned.
 *
 * FREEZE IS THE PRECONDITION, NOT THE PRODUCER. `loadTopicCatalogSource` refuses a run that is not frozen, by
 * name, so a plan can only exist after the epoch is sealed. Freeze itself stays untouched: it cannot be the
 * enforcer of artifacts that are all produced after it, and making it write them would put a report-side
 * projection inside the knowledge seal.
 */

import { join, resolve } from "node:path";
import { assertNever } from "../../base/artifact-result.ts";
import { exists, readJson } from "../../base/util.ts";
import { buildFixturePlan } from "../../report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../../report/plan-budget.ts";
import {
  buildPlanArtifacts,
  planCatalogPath,
  planDagPath,
  writePlanArtifacts,
  type PlanArtifacts
} from "../../report/plan-artifacts.ts";
import { parsePlanProposal, type PlanProposal } from "../../report/plan-proposal.ts";
import { summarisePlanValidation, type PlanValidationReport } from "../../report/plan-validation.ts";
import { planThroughBudgetRefinement, type PlanUnitDivision } from "../../report/plan-unit-split.ts";
import { loadRunEvidenceReach } from "../../report/run-evidence-reach.ts";
import {
  PLANNER_PACKET_BYTE_LIMIT,
  renderPlannerPacket,
  type PacketOverBudgetMode,
  type PlannerPacket
} from "../../report/planner-packet.ts";
import { REPORT_POLICY_REGISTRY } from "../../report/report-policy-registry.ts";
import { readReportRequests, reportRequestsPath } from "../../report/report-requests-artifact.ts";
import { buildTopicCatalog, type TopicCatalogArtifact } from "../../report/topic-catalog.ts";
import { loadTopicCatalogSource, type TopicCatalogSource } from "../../report/topic-catalog-source.ts";
import { topicsPath, writeTopicCatalog } from "../../report/topics-artifact.ts";
import type { ReportRequestsArtifact } from "../../report/report-requests-artifact.ts";

/** Where the proposal comes from. A closed union with no default: the caller states which, always. */
export type PlanProposalSource =
  | { readonly mode: "fixture" }
  | { readonly mode: "file"; readonly path: string };

export interface PlanRunResult {
  readonly runDir: string;
  readonly topicsPath: string;
  readonly planCatalogPath: string;
  readonly planDagPath: string;
  readonly artifacts: PlanArtifacts;
  readonly report: PlanValidationReport;
  /** One line per facet plus the overall line, in the verdict's own three-state vocabulary. */
  readonly verdicts: readonly string[];
  /**
   * Every over-budget unit this plan divided, with the rung it was divided at and the parts it became.
   *
   * Empty when the proposal already fitted. It is reported rather than hidden because a division changes the unit
   * set an operator will see on disk, and "why are there nine units where the proposal said four" has to have an
   * answer that is not "read the code".
   */
  readonly divisions: readonly PlanUnitDivision[];
  /** Measurement passes the refinement took. 1 means nothing was divided. */
  readonly refinementPasses: number;
}

/** Load the three inputs every plan action needs, naming whichever file is not there. */
async function planInputs(runDir: string): Promise<{ catalog: TopicCatalogArtifact; requests: ReportRequestsArtifact; source: TopicCatalogSource }> {
  const requestsPath = reportRequestsPath(runDir);
  if (!await exists(requestsPath)) {
    throw new Error(`${requestsPath} is missing; a plan is validated against the recorded request set, and this run has none. Re-prepare the run under the current version.`);
  }
  const source = await loadTopicCatalogSource(runDir);
  return { catalog: buildTopicCatalog(source), requests: await readReportRequests(runDir), source };
}

/** Render the model-facing planner packet. Read-only: it writes nothing into the run. */
export async function renderPlannerPacketForRun(
  runDirInput: string,
  options: { readonly overBudget: PacketOverBudgetMode; readonly byteLimit: number }
): Promise<PlannerPacket> {
  const runDir = resolve(runDirInput);
  const { catalog, requests } = await planInputs(runDir);
  return renderPlannerPacket({
    catalog,
    requests,
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    byteLimit: options.byteLimit,
    overBudget: options.overBudget
  });
}

export const DEFAULT_PLANNER_PACKET_BYTE_LIMIT = PLANNER_PACKET_BYTE_LIMIT;

/** Validate a proposal against this run's epoch and record it. Writes `plan/topics.json`, `catalog.json`, `dag.json`. */
export async function planRun(runDirInput: string, source: PlanProposalSource): Promise<PlanRunResult> {
  const runDir = resolve(runDirInput);
  const { catalog, requests, source: catalogSource } = await planInputs(runDir);
  await writeTopicCatalog(runDir, catalog);
  const proposed = await loadProposal(catalog, requests, source);
  // The evidence records are an input to PLANNING now: the budget check measures each unit's packet by rendering
  // it, and a packet renders the evidence its obligations bind.
  const evidence = await loadRunEvidenceReach(runDir, catalogSource);
  // One door for both proposal sources: validate, divide whatever is over budget, validate the divided plan.
  const planned = planThroughBudgetRefinement({
    catalog,
    requests,
    proposal: proposed,
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    evidence: evidence.evidenceById,
    reach: evidence.reach
  });
  if (planned.state === "rejected") {
    throw new Error(`The proposal does not validate against this run's epoch (${planned.problems.length} problem(s)): ${planned.problems.join("; ")}`);
  }
  const artifacts = buildPlanArtifacts({
    catalog,
    requests,
    proposal: planned.proposal,
    budgetTable: PLAN_BUDGET_TABLE,
    verdict: planned.report.overall
  });
  await writePlanArtifacts(runDir, artifacts, catalog);
  return {
    runDir,
    topicsPath: topicsPath(runDir),
    planCatalogPath: planCatalogPath(runDir),
    planDagPath: planDagPath(runDir),
    artifacts,
    report: planned.report,
    verdicts: summarisePlanValidation(planned.report),
    divisions: planned.divisions,
    refinementPasses: planned.iterations
  };
}

/** Exhaustive over the proposal sources: a third source must say where it comes from before this compiles. */
async function loadProposal(
  catalog: TopicCatalogArtifact,
  requests: ReportRequestsArtifact,
  source: PlanProposalSource
): Promise<PlanProposal> {
  switch (source.mode) {
    case "fixture":
      return buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
    case "file": {
      const path = resolve(source.path);
      if (!await exists(path)) throw new Error(`${path} does not exist; a plan proposal is read from a file this command is given`);
      let raw: unknown;
      try {
        raw = await readJson<unknown>(path);
      } catch (error) {
        throw new Error(`${path} could not be read as JSON: ${(error as Error).message}`);
      }
      const parsed = parsePlanProposal(raw);
      if (parsed.proposal === null) {
        throw new Error(`${path} is not a valid plan proposal: ${parsed.problems.join("; ")}`);
      }
      return parsed.proposal;
    }
  }
  return assertNever(source, "plan proposal source");
}

/** Where the plan artifacts of one run live, for a caller that reports paths without reading them. */
export function planPaths(runDir: string): { readonly topics: string; readonly catalog: string; readonly dag: string; readonly requests: string } {
  return {
    requests: reportRequestsPath(runDir),
    topics: topicsPath(runDir),
    catalog: planCatalogPath(runDir),
    dag: planDagPath(runDir)
  };
}

/** The `plan/` directory of one run. Stated once so no caller re-spells it. */
export function planDir(runDir: string): string {
  return join(runDir, "plan");
}
