/**
 * Does this run's SECTION completeness family still say anything, or is there nothing for it to be about?
 *
 * THE DEFECT THIS ANSWERS. `auditRun`'s section family — "assembled report is missing" and "document is
 * incomplete (0/N sections checkpointed)" — was written when every run was a section run. After 57B-480 nothing
 * writes a section or an assembled section report, so on every unit-path run both fired, as errors, forever: a
 * finished run that drafted, collected, assembled and audited its units still reported two defects about a path
 * it never used, and `manifest.state = "complete"` became unreachable. Two false sentences on every clean run is
 * how a reader stops reading the true ones.
 *
 * WHAT IT MAY NOT KEY ON, both measured rather than assumed:
 *   - NOT "does the manifest declare sections". R8c-1 deliberately KEPT `templateSections`, because the template
 *     headings are the bound contract's per-section requirement rows and layer 6 declares each as a
 *     `knowledge-requirement`. So every new run still declares 10–12 sections and checkpoints none of them; a
 *     declaration-keyed test would call every run vacuous, including a section run that genuinely stalled.
 *   - NOT the assurance generation. Not bumping it is a hard guardrail of this epic (57B-477), so a generation
 *     test would either need a bump that is forbidden or silently grandfather nothing.
 *
 * WHAT IT KEYS ON INSTEAD: the unit world's own positive evidence, in a fixed order, because the two states that
 * must not be confused are "nothing was written because this run authors units" and "nothing was written because
 * this run stalled".
 *
 *   1. SECTION ARTIFACTS ON DISK → audit exactly as before. This is first on purpose. `plan --run <dir>` accepts
 *      an archived section run, so plan-first ordering would let one command whitewash a half-finished archived
 *      run's completeness. Artifacts are the stronger evidence and they win.
 *   2. NO ARTIFACTS, BUT A RECORDED PLAN → vacuous, stated in R7a's coverage vocabulary. The plan is the unit
 *      path's premise (`plan-gate.ts` refuses authoring without it), so its presence is the run saying which
 *      path it is on, in bytes it wrote itself.
 *   3. NO ARTIFACTS AND NO PLAN → audit exactly as before. A run that was prepared and then abandoned reports
 *      incomplete, which is true and is the half of this that must not be softened.
 *
 * IT IS A STATEMENT, NOT A SILENCE. State 2 emits a warning-level sentence rather than dropping the findings:
 * "no finding" and "the question does not apply" are different readings, and the second one has to be said out
 * loud or the next reader cannot tell which happened.
 */

import type { DocumentPlan } from "../base/types.ts";
import { exists } from "../base/util.ts";
import { join } from "node:path";
import { assertNever } from "../base/artifact-result.ts";
import { COVERAGE_STATEMENT_PREFIXES } from "../investigation/coverage-statement.ts";
import { PLAN_ARTIFACT_PATHS } from "./plan-gate.ts";
import { sectionPaths } from "./section-paths.ts";
import { reportFileName } from "./section-report-name.ts";

/** Why this document's section family does or does not have a subject. Closed; consumed exhaustively. */
export type SectionCoverageState = "section-artifacts-present" | "planned-without-sections" | "unplanned-without-sections";

/** True when the run recorded a validated plan — the same four files `assertValidatedPlanForAuthoring` demands. */
export async function hasRecordedPlan(runDir: string): Promise<boolean> {
  for (const relative of PLAN_ARTIFACT_PATHS) if (!await exists(join(runDir, relative))) return false;
  return true;
}

/**
 * The state of one document, in the order the header states. `planRecorded` is passed in rather than re-read per
 * document: it is a property of the run, and reading it once keeps N documents from producing N answers.
 */
export async function sectionCoverageState(
  runDir: string,
  document: DocumentPlan,
  planRecorded: boolean
): Promise<SectionCoverageState> {
  if (await exists(join(runDir, "reports", reportFileName(document)))) return "section-artifacts-present";
  for (const section of document.sections) {
    if (await exists(sectionPaths(runDir, document.id, section).file)) return "section-artifacts-present";
  }
  return planRecorded ? "planned-without-sections" : "unplanned-without-sections";
}

/**
 * The sentence state 2 prints, in R7a's vocabulary so a reader meets the same four words everywhere.
 *
 * `ledger-empty`, not `ledger-absent`: the run's own plan says it authors units, so "this run genuinely recorded
 * none" is a determination, not an inability to tell.
 */
export function sectionCoverageVacuousStatement(documentId: string): string {
  return `${COVERAGE_STATEMENT_PREFIXES.vacuous}ledger-empty): this run has no section artifacts at all, so no section-completeness statement about ${documentId} applies — it records a validated plan, so its authoring is keyed by unit and the section path was never used.`;
}

/** Whether the section-completeness findings have a subject for this document. Exhaustive over the union. */
export function sectionCoverageApplies(state: SectionCoverageState): boolean {
  switch (state) {
    case "section-artifacts-present": return true;
    case "unplanned-without-sections": return true;
    case "planned-without-sections": return false;
  }
  return assertNever(state, "section coverage state");
}
