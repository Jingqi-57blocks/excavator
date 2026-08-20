/**
 * The authoring precondition: no unit gets written until a VALIDATED plan is on disk.
 *
 * WHY THIS FILE IS THE ENFORCER. `plan/requests.json` shipped in R1 as a record nobody read — deliberately, but a
 * record with no enforcer is a record that rots, and the epic ruled that this slice gives the whole `plan/` family
 * one. Freeze cannot be it: topics, catalog and dag are all produced AFTER the epoch is sealed. So the enforcer is
 * here, at the same place the epoch check already stands, and it is the same shape: authoring refuses to start
 * against a run whose premises are not verifiably in place.
 *
 * IT RE-VALIDATES, IT DOES NOT TRUST. Reading the four files is not enough — the plan on disk goes back through
 * the same `validatePlan` that admitted it, over the topics catalog re-derived from the same epoch. A plan whose
 * catalog was hand-edited, whose topic digests moved, or whose obligation accounting no longer matches its own
 * units fails here rather than becoming the denominator of an audit that then passes.
 *
 * A `vacuous` VERDICT OPENS THE GATE, and that is not a loophole: a catalog with no material topic (the
 * zero-feature shape one of the two baseline targets actually has) yields a plan with nothing to disposition, and
 * refusing it would mean no run of that shape could ever be written. What the gate refuses is `violations`. The
 * distinction only exists because the verdict has three states instead of a boolean.
 */

import { join } from "node:path";
import type { RunManifest } from "../base/types.ts";
import { exists, stableJson } from "../base/util.ts";
import { PLAN_BUDGET_TABLE } from "./plan-budget.ts";
import {
  proposalFromPlanCatalog,
  readPlanCatalog,
  readPlanDag,
  type PlanCatalogArtifact,
  type PlanDagArtifact
} from "./plan-artifacts.ts";
import { validatePlan, type PlanValidationReport } from "./plan-validation.ts";
import { loadRunEvidenceReach } from "./run-evidence-reach.ts";
import { REPORT_POLICY_REGISTRY } from "./report-policy-registry.ts";
import { readReportRequests, reportRequestsPath, type ReportRequestsArtifact } from "./report-requests-artifact.ts";
import { buildTopicCatalog, type TopicCatalogArtifact } from "./topic-catalog.ts";
import { loadTopicCatalogSource, type TopicCatalogSource } from "./topic-catalog-source.ts";
import { readTopicCatalog, topicsPath } from "./topics-artifact.ts";

/** The run-relative files a plan is made of, in the order the gate needs them. Named individually when missing. */
export const PLAN_ARTIFACT_PATHS = ["plan/requests.json", "plan/topics.json", "plan/catalog.json", "plan/dag.json"] as const;

export interface PlanGateResult {
  readonly requests: ReportRequestsArtifact;
  readonly catalog: TopicCatalogArtifact;
  /**
   * The knowledge-side ledgers the catalog was projected from, digest-checked against the sealed epoch.
   *
   * Returned rather than dropped so a caller that needs the OBLIGATION LEDGER ITSELF — R4b's grounding audit reads
   * each obligation's `origin` from it — reads the same bytes this gate already verified, instead of opening
   * `workitems.json` a second time with no seal check.
   */
  readonly source: TopicCatalogSource;
  readonly planCatalog: PlanCatalogArtifact;
  readonly dag: PlanDagArtifact;
  readonly report: PlanValidationReport;
}

/**
 * Assert that this run has a validated plan, and return it.
 *
 * Every failure names the file. The first missing file is reported on its own rather than as part of a list: the
 * operator's next command is the same either way, and pointing at one file is what makes the message actionable.
 *
 * `manifest` is required because the epoch the catalog is re-derived from is the one the manifest selects. Every
 * caller already holds it — the epoch gate beside this one takes the same object — so passing it costs nothing and
 * removes the possibility of a gate that re-validates a plan against an epoch the run has moved past.
 */
export async function assertValidatedPlanForAuthoring(runDir: string, manifest: RunManifest): Promise<PlanGateResult> {
  for (const relative of PLAN_ARTIFACT_PATHS) {
    if (!await exists(join(runDir, relative))) {
      throw new Error(`${relative} is missing from ${runDir}; authoring cannot start without a validated plan. Run \`excavator plan --run ${runDir} --fixture-plan\` (or \`--proposal <file>\`) first.`);
    }
  }
  const requests = await readReportRequests(runDir);
  const recordedCatalog = await readTopicCatalog(runDir);
  // Re-derived from the epoch, not read from the file it is compared against: a topics catalog that no longer
  // matches its own knowledge is the one thing reading the file alone could never catch.
  const source = await loadTopicCatalogSource(runDir, manifest);
  const catalog = buildTopicCatalog(source);
  if (stableJson(recordedCatalog) !== stableJson(catalog)) {
    throw new Error(`${topicsPath(runDir)} is not what this run's frozen knowledge derives; the recorded Topic Catalog and the epoch disagree`);
  }
  const planCatalog = await readPlanCatalog(runDir, catalog);
  const dag = await readPlanDag(runDir, planCatalog);
  // The evidence records are part of re-validation now, not an authoring-time extra: R5b's budget check MEASURES
  // each unit's packet by rendering it, and a packet renders the evidence its obligations bind. A gate that skipped
  // the measurement would be admitting plans on a number nobody took.
  const evidence = await loadRunEvidenceReach(runDir, source);
  const report = validatePlan({
    catalog,
    requests,
    proposal: proposalFromPlanCatalog(planCatalog),
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    evidence: evidence.evidenceById,
    reach: evidence.reach
  });
  if (report.overall.conclusion === "violations") {
    throw new Error(`The recorded plan in ${runDir} does not validate against its own epoch: ${report.overall.problems.join("; ")}`);
  }
  return { requests, catalog, source, planCatalog, dag, report };
}

/** Where the recorded request set lives, for a caller that wants to name it without reading it. */
export function planRequestsPath(runDir: string): string {
  return reportRequestsPath(runDir);
}
