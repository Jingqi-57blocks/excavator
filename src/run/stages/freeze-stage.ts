import { join, resolve } from "node:path";
import type { AuditFinding, EvidenceItem, InvestigationPlan, KnowledgeArtifact, RunManifest, TraceCatalog } from "../../base/types.ts";
import { READ_EXECUTION_ASSURANCE_GENERATION, WORKSET_OBLIGATION_ASSURANCE_GENERATION, assuranceGenerationAtLeast } from "../../base/assurance-version.ts";
import { atomicWrite, exists, nowIso, readJson, writeJson } from "../../base/util.ts";
import { appendTimeline, readTimeline } from "../../base/timeline.ts";
import { readCheckpoint } from "../../base/single-writer.ts";
import { auditContractInstances } from "../../freeze/contract-instance-audit.ts";
import { auditFrozenKnowledge, buildKnowledge, freezePreconditions, knowledgeDigest, readCurrentKnowledge, writeKnowledgeArtifact } from "../../freeze/freeze.ts";
import { buildFreezeCompleteness } from "../../freeze/completeness.ts";
import type { ContractManifest } from "../../contract/contract-manifest.ts";
import { auditReadAccountability } from "../../investigation/read-coverage.ts";
import { inventoryConditions } from "../../investigation/condition-inventory.ts";
import { createInvestigationPlan } from "../../investigation/assurance.ts";
import { warmExtractors } from "../../facts/probe/condition-extract.ts";
import { buildAuthoringPacket } from "../../report/authoring-packet.ts";
import { declarationWorkItems } from "../obligation-stage.ts";
import { logicWorkItems, LOGIC_DISPOSITION_ASSURANCE_GENERATION } from "../../obligation/logic-workitems.ts";
import { deriveReadAccountability, readCrossRepoLinks, readFrozenFactPacks, readRequiredInvestigationResults, readRequiredObligationDeclarations } from "./investigation-read-model.ts";
import { reDeriveIdentities } from "./runtime-identity.ts";
import { canonicalEvidenceDigest, readEvidenceCatalog } from "../../investigation/evidence-store.ts";

/**
 * Freeze a run: verify the investigation-side gate, write the immutable knowledge record and render the
 * deterministic authoring views. Post-freeze changes continue through the supplement channel.
 */
export async function freezeRun(runDirInput: string): Promise<{ manifest: RunManifest; findings: AuditFinding[]; frozen: boolean; knowledge?: KnowledgeArtifact }> {
  const runDir = resolve(runDirInput);
  const runPath = join(runDir, "run.json");
  const manifest = await readJson<RunManifest>(runPath);
  const refreeze = manifest.frozenAt !== undefined;
  if (refreeze && manifest.knowledgeEpoch === undefined) {
    throw new Error("This run was frozen before epoch seals existed and cannot be migrated in place; re-prepare it under the current assurance version");
  }
  const previousKnowledge = refreeze ? await readCurrentKnowledge(runDir, manifest) : null;
  const supplementCheckpoint = await readCheckpoint(runDir, "supplement");
  if (refreeze) {
    if (!supplementCheckpoint) throw new Error("The frozen run has no supplement checkpoint and cannot be re-sealed");
    const previousCutoff = previousKnowledge?.appendStreams?.find((entry) => entry.id === "supplements")?.frozenThroughSequence;
    if (previousCutoff === undefined) throw new Error("The latest knowledge epoch has no supplement cutoff and cannot be re-sealed");
    if (supplementCheckpoint.sequence <= previousCutoff) {
      throw new Error(`Knowledge epoch ${manifest.knowledgeEpoch} has no new supplement to seal; record a justified supplement before re-freezing`);
    }
  }
  const evidenceCatalog = await readEvidenceCatalog(runDir);
  const evidenceById = new Map(evidenceCatalog.evidence.map((item) => [item.id, item]));
  const plan = await readJson<InvestigationPlan>(join(runDir, "workitems.json"));
  const traces = await readJson<TraceCatalog>(join(runDir, "traces.json"));
  const factPacks = await readFrozenFactPacks(runDir, manifest);
  const crossRepoLinks = await readCrossRepoLinks(runDir);
  const accountability = await deriveReadAccountability(runDir, manifest, factPacks, plan.items, evidenceCatalog.evidence, crossRepoLinks);
  const obligations = accountability?.obligations ?? null;
  const readResidual = accountability?.residual ?? null;
  const boundaryFunctions = accountability?.boundaryFunctions ?? null;
  const expectedPlan = createInvestigationPlan(manifest.id, manifest.request, manifest.documents);
  const contractFindings = await auditContractInstances(runDir, manifest);
  let investigationResults: Awaited<ReturnType<typeof readRequiredInvestigationResults>> | null = null;
  if (assuranceGenerationAtLeast(manifest, LOGIC_DISPOSITION_ASSURANCE_GENERATION)) expectedPlan.items.push(...logicWorkItems(Object.values(factPacks), manifest.documents).items);
  if (assuranceGenerationAtLeast(manifest, WORKSET_OBLIGATION_ASSURANCE_GENERATION)) {
    try {
      const declarations = await readRequiredObligationDeclarations(runDir);
      expectedPlan.items.push(...declarationWorkItems(declarations, manifest.documents, new Set(expectedPlan.items.map((item) => item.id))));
    } catch (error) {
      contractFindings.push({ level: "error", document: "contract", message: `obligations/declarations.json cannot be used at freeze: ${(error as Error).message}` });
    }
  }
  if (assuranceGenerationAtLeast(manifest, READ_EXECUTION_ASSURANCE_GENERATION)) {
    try {
      investigationResults = await readRequiredInvestigationResults(runDir, manifest, evidenceCatalog.evidence);
    } catch (error) {
      contractFindings.push({ level: "error", document: "contract", message: `investigation/results.json cannot be used at freeze: ${(error as Error).message}` });
    }
  }
  let completeness: Awaited<ReturnType<typeof buildFreezeCompleteness>>["completeness"] | null = null;
  try {
    const contract = await readJson<ContractManifest>(join(runDir, "contract", "contract-manifest.json"));
    const result = await buildFreezeCompleteness({ runDir, manifest, contract, plan, investigationResults, contractFindings, evidence: evidenceCatalog.evidence });
    completeness = result.completeness;
    contractFindings.splice(0, contractFindings.length, ...result.findings);
  } catch (error) {
    contractFindings.push({ level: "error", document: "freeze-checklist", message: `layer-8 completeness could not be built: ${(error as Error).message}` });
  }
  const documentIds = new Set(manifest.documents.map((document) => document.id));
  const snapshotDrift = (await reDeriveIdentities(runDir, manifest))?.drift ?? null;
  const findings = await freezePreconditions({ runDir, manifest, plan, expectedPlan, evidence: evidenceCatalog.evidence, evidenceById, traces, documentIds, snapshotDrift, contractFindings });
  if (refreeze) findings.push(...await auditFrozenKnowledge(runDir, manifest, evidenceCatalog.evidence, plan, traces));
  if (obligations && readResidual) {
    findings.push(...auditReadAccountability({ obligations: obligations.obligations, workItems: plan.items, evidenceById, report: readResidual }));
  }
  if (findings.some((finding) => finding.level === "error") || !completeness) return { manifest, findings, frozen: false };
  if (obligations && readResidual) {
    await writeJson(join(runDir, "coverage", "read-obligations.json"), obligations);
    await writeJson(join(runDir, "coverage", "read-residual.json"), readResidual);
  }

  if (accountability) await warmExtractors();
  const freezeConditions = accountability ? inventoryConditions(evidenceCatalog.evidence, []) : null;
  if (freezeConditions) await writeJson(join(runDir, "coverage", "condition-inventory.json"), freezeConditions);

  const crossFeaturePath = join(runDir, "context", "cross-feature.json");
  const crossFeature = await exists(crossFeaturePath) ? await readJson<unknown>(crossFeaturePath) : null;
  const frozenAt = nowIso();
  const timelineAtFreeze = await readTimeline(runDir);
  const timelineTail = timelineAtFreeze.at(-1);
  const nextEpoch = refreeze ? manifest.knowledgeEpoch! + 1 : 0;
  const appendStreams = [
    { id: "evidence.json", frozenThroughSequence: evidenceCatalog.evidence.length, tailDigest: canonicalEvidenceDigest(evidenceCatalog.evidence) },
    { id: "timeline.jsonl", frozenThroughSequence: timelineTail?.sequence ?? 0, tailDigest: timelineTail?.digest ?? "" },
    { id: "supplements", frozenThroughSequence: supplementCheckpoint?.sequence ?? 0, tailDigest: supplementCheckpoint?.tailDigest ?? "" },
  ];
  const mechanismsPath = join(runDir, "ledger", "mechanisms.json");
  const mechanismsLedger = await exists(mechanismsPath) ? await readJson<unknown>(mechanismsPath) : null;
  const knowledge = buildKnowledge({
    manifest, plan, evidence: evidenceCatalog.evidence, traces, factPacks, crossFeature, frozenAt,
    readObligations: obligations, boundaryFunctions, crossRepoLinks, mechanismsLedger, investigationResults,
    completeness, appendStreams, epoch: nextEpoch,
    ...(previousKnowledge ? { previousEpochDigest: knowledgeDigest(previousKnowledge) } : {})
  });
  await writeKnowledgeArtifact(runDir, knowledge);
  let authoringPackets = 0;
  for (const document of manifest.documents) {
    const markdown = buildAuthoringPacket(document, plan, evidenceById, traces, factPacks, freezeConditions ?? undefined,
      accountability ? { obligations: accountability.obligations.obligations, items: accountability.residual.items, annotated: accountability.annotated } : undefined,
      nextEpoch);
    await atomicWrite(join(runDir, "context", "authoring", `${document.id}.md`), markdown);
    authoringPackets += 1;
  }
  manifest.frozenAt = frozenAt;
  manifest.knowledgeEpoch = nextEpoch;
  manifest.knowledgeDigest = knowledgeDigest(knowledge);
  manifest.metrics.supplements = manifest.metrics.supplements ?? 0;
  manifest.updatedAt = nowIso();
  await appendTimeline(runDir, manifest.id, {
    stage: "investigation",
    action: refreeze ? "investigation.refrozen" : "investigation.frozen",
    data: { epoch: nextEpoch, knowledgeDigest: manifest.knowledgeDigest, evidence: knowledge.evidenceIds.length, workItems: knowledge.completeness.closure.workItems, traces: knowledge.traceIds.length, authoringPackets }
  });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(runPath, manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  return { manifest, findings, frozen: true, knowledge };
}
