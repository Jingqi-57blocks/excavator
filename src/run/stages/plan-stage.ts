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
 * projection inside the knowledge seal. Which sealed epoch gets planned is the manifest's answer, not this
 * stage's: a re-frozen run re-plans onto its NEW epoch, and `plan/catalog.json` records that epoch number.
 */

import { join, resolve } from "node:path";
import { assertNever } from "../../base/artifact-result.ts";
import type { RunManifest } from "../../base/types.ts";
import { exists, readJson } from "../../base/util.ts";
import { buildFixturePlan } from "../../report/fixture-plan.ts";
import { projectEpochCoverage } from "../../report/coverage-projection.ts";
import { PLAN_BUDGET_TABLE } from "../../report/plan-budget.ts";
import {
  FIRST_PLAN_REVISION,
  buildPlanArtifacts,
  planCatalogDigest,
  planCatalogPath,
  planDagPath,
  readPlanCatalog,
  writePlanArtifacts,
  type PlanArtifacts,
  type PlanCatalogArtifact,
  type PlanRevisionRef
} from "../../report/plan-artifacts.ts";
import { nextPlanRevision, planToSupersede, recordPlanRevision, type PlanRevisionArchive } from "../../report/plan-revision.ts";
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
import { strandedUnitDrafts, strandedUnitDraftsUnread, type StrandedUnitDrafts } from "../../report/plan-revision-stranded.ts";
import { pendingUnitReceipts } from "../../report/unit-collect.ts";
import type { ReportRequestsArtifact } from "../../report/report-requests-artifact.ts";

/** Where the proposal comes from. A closed union with no default: the caller states which, always. */
export type PlanProposalSource =
  | { readonly mode: "fixture" }
  | { readonly mode: "file"; readonly path: string };

/**
 * What this plan action is allowed to do to a plan the run already records. Closed, required, no default.
 *
 * `record` is the behaviour that has always existed: write revision 0 of this epoch's plan, refuse different bytes
 * for a revision already recorded. `revise` is the explicit act — it needs a reason, it supersedes the recorded
 * plan by writing the next revision, and it archives the one it replaces. Making it a required argument rather
 * than an optional flag is deliberate: an optional mode is a mode the next call site forgets, and the two arms
 * differ in whether a recorded plan can be replaced.
 */
export type PlanRecording =
  | { readonly kind: "record" }
  | { readonly kind: "revise"; readonly reason: string };

/**
 * What one recording put on disk. The plain arm archives nothing, so `archive` is nullable HERE and not in
 * `RecordedPlanRevision` — a recorded revision always has an archive, and a type that allowed it not to would let
 * the "archive first" precondition be omitted one call site at a time.
 */
interface RecordedPlan {
  readonly artifacts: PlanArtifacts;
  readonly archive: PlanRevisionArchive | null;
  readonly succession: readonly string[];
}

/** What a revise did, or what a plain recording did not do. Reported so the two are never inferred from paths. */
export interface PlanRevisionResult {
  readonly planRevision: number;
  readonly previousPlanCatalogDigest: string | null;
  readonly revisionReason: string | null;
  /** Where the superseded revision was archived, or `null` when nothing was superseded. */
  readonly archive: PlanRevisionArchive | null;
  /** The chain back to revision 0, re-computed from the archive. Empty for revision 0. */
  readonly succession: readonly string[];
  /**
   * The drafts this recording just made uncollectable, by unit id, with the reading in words.
   *
   * REQUIRED, and taken on BOTH recording arms rather than only on `revise`. The comparison is the same one
   * either way (a pending receipt's plan digest against the plan now on disk), so making it a revise-only field
   * would be two answers to one question — and revision 0 over a run that already holds receipts is exactly the
   * state where a reader would most want the zero to be a measured zero.
   */
  readonly strandedDrafts: StrandedUnitDrafts;
}

export interface PlanRunResult {
  readonly runDir: string;
  readonly topicsPath: string;
  readonly planCatalogPath: string;
  readonly planDagPath: string;
  readonly artifacts: PlanArtifacts;
  /** Which revision was recorded, what it superseded, and where that went. */
  readonly revision: PlanRevisionResult;
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

/**
 * Load the three inputs every plan action needs, naming whichever file is not there.
 *
 * THE MANIFEST IS READ HERE, ONCE, and handed to the catalog projection, because the epoch a plan is built from is
 * the one the manifest selects. Both plan actions — recording a plan and rendering the model-facing packet — come
 * through this function, so neither can end up planning against a superseded epoch while the other does not.
 */
async function planInputs(runDir: string): Promise<{ catalog: TopicCatalogArtifact; requests: ReportRequestsArtifact; source: TopicCatalogSource }> {
  const requestsPath = reportRequestsPath(runDir);
  if (!await exists(requestsPath)) {
    throw new Error(`${requestsPath} is missing; a plan is validated against the recorded request set, and this run has none. Re-prepare the run under the current version.`);
  }
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const source = await loadTopicCatalogSource(runDir, manifest);
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

/**
 * Validate a proposal against this run's epoch and record it. Writes `plan/topics.json`, `catalog.json`, `dag.json`.
 *
 * THE RECORDING MODE IS READ BEFORE THE PROPOSAL IS BUILT, because it decides which revision the artifacts carry
 * and a revision is part of their bytes. `revise` reads the plan on disk THROUGH THE FULL READER: a recorded plan
 * that no longer validates against this run's epoch is not a plan this command may extend, and the refusal says
 * which one it is instead of silently writing revision 0 over it.
 */
export async function planRun(runDirInput: string, source: PlanProposalSource, recording: PlanRecording): Promise<PlanRunResult> {
  const runDir = resolve(runDirInput);
  const { catalog, requests, source: catalogSource } = await planInputs(runDir);
  await writeTopicCatalog(runDir, catalog);
  const { revision, superseded } = await planRevisionFor(runDir, catalog, recording);
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
    reach: evidence.reach,
    epochCoverage: projectEpochCoverage(catalogSource)
  });
  if (planned.state === "rejected") {
    throw new Error(`The proposal does not validate against this run's epoch (${planned.problems.length} problem(s)): ${planned.problems.join("; ")}`);
  }
  const artifacts = buildPlanArtifacts({
    catalog,
    requests,
    proposal: planned.proposal,
    budgetTable: PLAN_BUDGET_TABLE,
    verdict: planned.report.overall,
    revision
  });
  // Both arms produce the same three things, so the recording mode is the ONLY difference between them: a plain
  // recording archives nothing and has no chain to report, a revision does both.
  const recorded: RecordedPlan = superseded === null
    ? { artifacts: await writePlanArtifacts(runDir, artifacts, catalog, { kind: "record" }), archive: null, succession: [] }
    : await recordPlanRevision(runDir, artifacts, catalog, superseded);
  const stranded = await strandedDraftsOf(runDir, planCatalogDigest(recorded.artifacts.planCatalog));
  return {
    runDir,
    topicsPath: topicsPath(runDir),
    planCatalogPath: planCatalogPath(runDir),
    planDagPath: planDagPath(runDir),
    artifacts: recorded.artifacts,
    revision: { ...revision, archive: recorded.archive, succession: recorded.succession, strandedDrafts: stranded },
    report: planned.report,
    verdicts: summarisePlanValidation(planned.report),
    divisions: planned.divisions,
    refinementPasses: planned.iterations
  };
}

/**
 * The stranded-draft reading, taken AFTER the write and against the plan that is now on disk: the question is what
 * the RECORDED plan cannot collect, and comparing against the plan being replaced would answer a question nobody
 * asked.
 *
 * The scan's failure is caught and CARRIED, never swallowed: `pendingUnitReceipts` refuses a malformed receipt by
 * name, and letting that refusal take down the plan action would make `plan` — the command that gets a stuck run
 * moving — hostage to a file it does not need, with nothing on offer to clear it. The plan is still recorded; the
 * reading says it could not be taken, and why.
 */
async function strandedDraftsOf(runDir: string, planCatalogDigest: string): Promise<StrandedUnitDrafts> {
  try {
    return strandedUnitDrafts(await pendingUnitReceipts(runDir), planCatalogDigest);
  } catch (error) {
    return strandedUnitDraftsUnread((error as Error).message);
  }
}

/**
 * Which revision this action records, and the plan it supersedes — `null` when it supersedes nothing.
 *
 * Exhaustive over the recording modes, and the two facts come out together because they are one decision: the
 * revision number is a function of the plan being superseded, so deriving them apart would be two answers to the
 * same question. The `revise` arm refuses by name in the two ways it can fail: no plan is recorded at all, or the
 * recorded one does not read against this epoch (which is what a re-freeze produces — and its remedy is a plain
 * `plan`, not a revision of a plan belonging to another epoch).
 */
async function planRevisionFor(
  runDir: string,
  catalog: TopicCatalogArtifact,
  recording: PlanRecording
): Promise<{ revision: PlanRevisionRef; superseded: PlanArtifacts | null }> {
  switch (recording.kind) {
    case "record":
      return { revision: FIRST_PLAN_REVISION, superseded: null };
    case "revise": {
      if (!await exists(planCatalogPath(runDir))) {
        throw new Error(`${planCatalogPath(runDir)} is missing, so there is no plan for --revise to supersede; record one first with \`excavator plan --run ${runDir} --fixture-plan\` (or \`--proposal <file>\`)`);
      }
      let planCatalog: PlanCatalogArtifact;
      try {
        planCatalog = await readPlanCatalog(runDir, catalog);
      } catch (error) {
        throw new Error(`--revise cannot supersede the plan this run records: ${(error as Error).message}. A plan that does not read against this run's epoch is re-planned (plain \`plan\`), not revised.`);
      }
      const superseded = await planToSupersede(runDir, planCatalog);
      return { revision: nextPlanRevision(planCatalog, recording.reason), superseded };
    }
  }
  return assertNever(recording, "plan recording mode");
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
