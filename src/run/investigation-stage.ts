import { join } from "node:path";
import { built, unavailable, type ArtifactResult } from "../base/artifact-result.ts";
import type { EvidenceItem, InvestigationPlan, InvestigationWorkItem } from "../base/types.ts";
import { writeJson } from "../base/util.ts";
import { mergeWorkItems } from "../investigation/assurance.ts";
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
}

/** Layer-7 orchestration: execute only when both authorization and declaration envelopes are built. */
export async function buildInvestigationStage(input: {
  readonly target: string;
  readonly snapshotId: string;
  readonly filesContentManifestDigest: string;
  readonly cacheDir: string;
  readonly maxWindows: number;
  readonly maxCharacters: number;
  readonly redact: boolean;
  readonly workset: ArtifactResult<ReadSpecsArtifact>;
  readonly obligations: ArtifactResult<ObligationDeclarations>;
}): Promise<InvestigationStageResult> {
  if (input.workset.status !== "built" || input.obligations.status !== "built") {
    const causes = [describe("ReadSpecs", input.workset), describe("obligation declarations", input.obligations)].filter(Boolean);
    const retryable = [input.workset, input.obligations].some((result) => result.status === "unavailable" && result.retryable);
    return { results: unavailable(`Read execution requires built authorization and declarations: ${causes.join("; ")}`, retryable), evidence: [], stats: { windows: 0, characters: 0, hits: 0 } };
  }
  const executed = await executeReadSpecs({
    target: input.target,
    snapshotId: input.snapshotId,
    filesContentManifestDigest: input.filesContentManifestDigest,
    cacheDir: input.cacheDir,
    maxWindows: input.maxWindows,
    maxCharacters: input.maxCharacters,
    redact: input.redact,
    workset: input.workset.value,
    obligations: input.obligations.value
  });
  return { results: built(executed.artifact), evidence: executed.evidence, stats: executed.stats };
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
    updates.push(disposition.status === "fulfilled"
      ? { ...base, status: "found", reason: "The authorized source span was fully read." }
      : disposition.status === "closed-negative"
        ? { ...base, status: "cannot-determine", material: false, reason: "The authorized span produced a recorded empty result; this is a negative closure and contributes no positive knowledge." }
        : { ...base, status: "pending", reason: `The authorized read remains pending: ${execution.cause ?? "source unavailable"}.` });
  }
  return mergeWorkItems(plan, updates);
}

function describe(name: string, result: ArtifactResult<unknown>): string | null {
  if (result.status === "built") return null;
  return result.status === "unavailable" ? `${name} unavailable: ${result.cause}` : `${name} not applicable: ${result.determination}`;
}
