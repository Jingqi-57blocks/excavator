import { join } from "node:path";
import { built, unavailable, type ArtifactResult } from "../base/artifact-result.ts";
import type { DocumentPlan, InvestigationWorkItem } from "../base/types.ts";
import { writeJson } from "../base/util.ts";
import type { Requirements } from "../contract/bound-run-contract.ts";
import type { UnitsArtifact } from "../facts/units/units-artifact.ts";
import type { MechanismLedger } from "../mechanism/mechanism-ledger.ts";
import { buildObligationDeclarations, type ObligationDeclarations } from "../obligation/declarations.ts";
import type { ReadSpecsArtifact } from "../workset/read-specs.ts";

/** Layer 6 has exactly four inputs. Keeping the envelope join here makes accidental evidence/template access visible. */
export function buildObligationStage(input: {
  readonly requirements: Requirements;
  readonly workset: ArtifactResult<ReadSpecsArtifact>;
  readonly mechanisms: ArtifactResult<MechanismLedger>;
  readonly units: ArtifactResult<UnitsArtifact>;
}): ArtifactResult<ObligationDeclarations> {
  const missing = [
    describe("workset", input.workset),
    describe("mechanisms", input.mechanisms),
    describe("units", input.units)
  ].filter((cause): cause is string => cause !== null);
  if (missing.length > 0) {
    const retryable = [input.workset, input.mechanisms, input.units].some((result) => result.status === "unavailable" && result.retryable);
    return unavailable(`Obligation declarations require built workset, mechanisms and units: ${missing.join("; ")}`, retryable);
  }
  if (input.workset.status !== "built" || input.mechanisms.status !== "built" || input.units.status !== "built") {
    throw new Error("Obligation stage availability narrowing failed");
  }
  return built(buildObligationDeclarations({
    requirements: input.requirements,
    workset: input.workset.value,
    mechanisms: input.mechanisms.value,
    units: input.units.value
  }));
}

export async function writeObligationStage(runDir: string, result: ArtifactResult<ObligationDeclarations>): Promise<void> {
  await writeJson(join(runDir, "obligations", "declarations.json"), result);
}

export async function writeUnavailableObligationStage(runDir: string, cause: string, retryable: boolean): Promise<void> {
  await writeObligationStage(runDir, unavailable(cause, retryable));
}

/** Layer-7 compatibility projection; audience-bearing document plans never enter the layer-6 declaration builder. */
export function declarationWorkItems(
  artifact: ObligationDeclarations,
  documents: readonly DocumentPlan[],
  existingIds: ReadonlySet<string> = new Set()
): InvestigationWorkItem[] {
  const out: InvestigationWorkItem[] = [];
  const seen = new Set(existingIds);
  for (const declaration of artifact.declarations) {
    if (declaration.kind !== "decision-reading") continue;
    const id = declarationWorkItemId(declaration);
    if (seen.has(id)) continue;
    seen.add(id);
    const requiredFor = documents.filter((document) => document.id.startsWith(`feature-${declaration.featureKey}-`)).map((document) => document.id);
    out.push({
      id,
      dimension: "decision-function",
      scope: `feature:${declaration.featureKey}`,
      hypothesis: `The decision-bearing function ${declaration.name} is investigated from its authorised source span.`,
      status: "pending",
      material: true,
      requiredFor,
      evidenceIds: [],
      traceIds: [],
      origin: "default"
    });
  }
  return out;
}

export function declarationWorkItemId(declaration: Extract<ObligationDeclarations["declarations"][number], { kind: "decision-reading" }>): string {
  return `feature:${declaration.featureKey}:logic:${declaration.name}@${declaration.path}:${declaration.span.startLine}`;
}

function describe(name: string, result: ArtifactResult<unknown>): string | null {
  if (result.status === "built") return null;
  return result.status === "unavailable"
    ? `${name} unavailable: ${result.cause}`
    : `${name} not applicable: ${result.determination}`;
}
