import { join } from "node:path";
import { assertNever, built, unavailable, type ArtifactResult } from "../base/artifact-result.ts";
import type { EvidenceItem, InvestigationPlan, InvestigationWorkItem } from "../base/types.ts";
import { writeJson } from "../base/util.ts";
import { mergeWorkItems } from "../investigation/assurance.ts";
import { readWindowDemand, type ReadWindowBudget, type ReadWindowDemand } from "../investigation/read-budget.ts";
import {
  executeReadSpecs, type InvestigationResults, type InvestigationResultsArtifact
} from "../investigation/read-execution.ts";
import type { ObligationDeclarations } from "../obligation/declarations.ts";
import type { ReadSpecsArtifact } from "../workset/read-specs.ts";
import { declarationWorkItemId } from "./obligation-stage.ts";

export interface InvestigationStageResult {
  readonly results: InvestigationResultsArtifact;
  readonly evidence: readonly EvidenceItem[];
  readonly stats: { readonly windows: number; readonly characters: number; readonly hits: number };
  /** Null exactly when no ReadSpec set existed to sum: there is then no demand, which is not a demand of 0. */
  readonly demand: ReadWindowDemand | null;
}

/** Layer-7 orchestration: execute only when both authorization and declaration envelopes are built. */
export async function buildInvestigationStage(input: {
  readonly target: string;
  readonly snapshotId: string;
  readonly filesContentManifestDigest: string;
  readonly cacheDir: string;
  /** The run ceiling and what prepare already spent. The remaining allowance is derived here, in one place,
   *  so the figure execution is held to and the figure reported to the operator cannot drift apart. */
  readonly windowBudget: ReadWindowBudget;
  readonly maxCharacters: number;
  readonly redact: boolean;
  readonly workset: ArtifactResult<ReadSpecsArtifact>;
  readonly obligations: ArtifactResult<ObligationDeclarations>;
}): Promise<InvestigationStageResult> {
  if (input.workset.status !== "built" || input.obligations.status !== "built") {
    const causes = [describe("ReadSpecs", input.workset), describe("obligation declarations", input.obligations)].filter(Boolean);
    const retryable = [input.workset, input.obligations].some((result) => result.status === "unavailable" && result.retryable);
    return { results: unavailable(`Read execution requires built authorization and declarations: ${causes.join("; ")}`, retryable), evidence: [], stats: { windows: 0, characters: 0, hits: 0 }, demand: null };
  }
  const demand = readWindowDemand(input.workset.value.specs, input.windowBudget);
  const executed = await executeReadSpecs({
    target: input.target,
    snapshotId: input.snapshotId,
    filesContentManifestDigest: input.filesContentManifestDigest,
    cacheDir: input.cacheDir,
    maxWindows: demand.availableWindows,
    maxCharacters: input.maxCharacters,
    redact: input.redact,
    workset: input.workset.value,
    obligations: input.obligations.value
  });
  return { results: built(executed.artifact), evidence: executed.evidence, stats: executed.stats, demand };
}

export async function writeInvestigationStage(runDir: string, result: InvestigationResultsArtifact): Promise<void> {
  await writeJson(join(runDir, "investigation", "results.json"), result);
}

/** Project L7 decision dispositions onto the existing compatibility work items without losing the L7 record. */
export function applyInvestigationDispositions(
  plan: InvestigationPlan,
  results: InvestigationResultsArtifact,
  obligations: ArtifactResult<ObligationDeclarations>
): InvestigationPlan {
  if (results.status !== "built" || obligations.status !== "built") return plan;
  const declarations = new Map(obligations.value.declarations
    .filter((row): row is Extract<ObligationDeclarations["declarations"][number], { kind: "decision-reading" }> => row.kind === "decision-reading")
    .map((row) => [row.id, row]));
  const executions = new Map(results.value.executions.map((row) => [row.id, row]));
  const updates: Partial<InvestigationWorkItem>[] = [];
  for (const disposition of results.value.dispositions) {
    const declaration = declarations.get(disposition.declarationId);
    const execution = executions.get(disposition.executionId);
    if (!declaration || !execution) throw new Error(`L7 disposition ${disposition.declarationId} cannot resolve its declaration and execution`);
    const base = {
      id: declarationWorkItemId(declaration),
      evidenceIds: [...disposition.evidenceIds],
      settledBy: disposition.executionId,
      searchScope: `${execution.path}:${execution.requestedSpan.startLine}-${execution.requestedSpan.endLine}`
    };
    updates.push(workItemUpdate(base, disposition.status, execution.cause));
  }
  return mergeWorkItems(plan, updates);
}

/**
 * Project one L7 disposition onto the compatibility work item.
 *
 * `displaced` becomes `cannot-determine` rather than `pending`, and that single mapping is what turns a
 * budget-starved run from unsealable into sealed-with-a-recorded-limitation. `cannot-determine` is not a
 * softer `pending`: the work-item audit demands a reason, a `settledBy` and limitation evidence for it, and
 * the displaced read supplies all three (its ledger row records that nothing was read). `pending` demands
 * the opposite — that someone go and dispose it — and no work-item update can reach `investigation/results.json`,
 * so a displaced read left pending is a bill no one in the run is able to pay.
 */
function workItemUpdate(
  base: Pick<InvestigationWorkItem, "id" | "evidenceIds" | "settledBy" | "searchScope">,
  status: InvestigationResults["dispositions"][number]["status"],
  cause: string | undefined
): Partial<InvestigationWorkItem> {
  switch (status) {
    case "fulfilled":
      return { ...base, status: "found", reason: "The authorized source span was fully read." };
    case "closed-negative":
      return { ...base, status: "cannot-determine", material: false, reason: "The authorized span produced a recorded empty result; this is a negative closure and contributes no positive knowledge." };
    case "displaced":
      return { ...base, status: "cannot-determine", material: false, reason: `This run's recorded budget ceiling displaced the authorized read (${cause ?? "budget exceeded"}); no source bytes stand behind this item, and its ledger evidence records the limitation. Re-prepare with a larger source-window budget to read it.` };
    case "pending":
      return { ...base, status: "pending", reason: `The authorized read remains pending: ${cause ?? "source unavailable"}.` };
    default:
      return assertNever(status, "L7 decision disposition");
  }
}

function describe(name: string, result: ArtifactResult<unknown>): string | null {
  if (result.status === "built") return null;
  return result.status === "unavailable" ? `${name} unavailable: ${result.cause}` : `${name} not applicable: ${result.determination}`;
}
