import { join, resolve } from "node:path";
import type { AuditFinding, EvidenceItem, InvestigationPlan, KnowledgeArtifact, RunManifest, TraceCatalog } from "../../base/types.ts";
import { WORKSET_OBLIGATION_ASSURANCE_GENERATION, assuranceGenerationAtLeast } from "../../base/assurance-version.ts";
import { atomicWrite, exists, nowIso, readJson, writeJson } from "../../base/util.ts";
import { appendTimeline, readTimeline } from "../../base/timeline.ts";
import { auditContractInstances } from "../../freeze/contract-instance-audit.ts";
import { buildKnowledge, freezePreconditions, knowledgeDigest, writeKnowledgeArtifact } from "../../freeze/freeze.ts";
import { auditReadAccountability } from "../../investigation/read-coverage.ts";
import { inventoryConditions } from "../../investigation/condition-inventory.ts";
import { createInvestigationPlan } from "../../investigation/assurance.ts";
import { warmExtractors } from "../../facts/probe/condition-extract.ts";
import { buildAuthoringPacket } from "../../report/authoring-packet.ts";
import { declarationWorkItems } from "../obligation-stage.ts";
import { logicWorkItems, LOGIC_DISPOSITION_ASSURANCE_GENERATION } from "../../obligation/logic-workitems.ts";
import { deriveReadAccountability, readCrossRepoLinks, readFrozenFactPacks, readRequiredObligationDeclarations } from "./investigation-read-model.ts";
import { reDeriveIdentities } from "./runtime-identity.ts";
import { readEvidenceCatalog } from "../../investigation/evidence-store.ts";

/**
 * Freeze a run: verify the investigation-side gate, write the immutable knowledge record and render the
 * deterministic authoring views. Post-freeze changes continue through the supplement channel.
 */
export async function freezeRun(runDirInput: string): Promise<{ manifest: RunManifest; findings: AuditFinding[]; frozen: boolean; knowledge?: KnowledgeArtifact }> {
  const runDir = resolve(runDirInput);
  const runPath = join(runDir, "run.json");
  const manifest = await readJson<RunManifest>(runPath);
  if (manifest.frozenAt) throw new Error(`Run is already frozen at ${manifest.frozenAt}; re-freeze is not supported. Post-freeze changes go through the supplement channel.`);
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
  if (assuranceGenerationAtLeast(manifest, LOGIC_DISPOSITION_ASSURANCE_GENERATION)) expectedPlan.items.push(...logicWorkItems(Object.values(factPacks), manifest.documents).items);
  if (assuranceGenerationAtLeast(manifest, WORKSET_OBLIGATION_ASSURANCE_GENERATION)) {
    try {
      const declarations = await readRequiredObligationDeclarations(runDir);
      expectedPlan.items.push(...declarationWorkItems(declarations, manifest.documents, new Set(expectedPlan.items.map((item) => item.id))));
    } catch (error) {
      contractFindings.push({ level: "error", document: "contract", message: `obligations/declarations.json cannot be used at freeze: ${(error as Error).message}` });
    }
  }
  const documentIds = new Set(manifest.documents.map((document) => document.id));
  const snapshotDrift = (await reDeriveIdentities(runDir, manifest))?.drift ?? null;
  const findings = await freezePreconditions({ runDir, manifest, plan, expectedPlan, evidence: evidenceCatalog.evidence, evidenceById, traces, documentIds, snapshotDrift, contractFindings });
  if (obligations && readResidual) {
    findings.push(...auditReadAccountability({ obligations: obligations.obligations, workItems: plan.items, evidenceById, report: readResidual }));
  }
  if (findings.some((finding) => finding.level === "error")) return { manifest, findings, frozen: false };
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
  const appendStreams = [
    { id: "evidence.json", frozenThroughSequence: evidenceCatalog.evidence.length, tailDigest: manifest.evidenceDigest },
    { id: "timeline.jsonl", frozenThroughSequence: timelineTail?.sequence ?? 0, tailDigest: timelineTail?.digest ?? "" },
    { id: "supplements", frozenThroughSequence: 0, tailDigest: "" },
  ];
  const mechanismsPath = join(runDir, "ledger", "mechanisms.json");
  const mechanismsLedger = await exists(mechanismsPath) ? await readJson<unknown>(mechanismsPath) : null;
  const knowledge = buildKnowledge({ manifest, plan, evidence: evidenceCatalog.evidence, traces, factPacks, crossFeature, frozenAt, readObligations: obligations, boundaryFunctions, crossRepoLinks, mechanismsLedger, appendStreams });
  await writeKnowledgeArtifact(runDir, knowledge);
  let authoringPackets = 0;
  for (const document of manifest.documents) {
    const markdown = buildAuthoringPacket(document, plan, evidenceById, traces, factPacks, freezeConditions ?? undefined,
      accountability ? { obligations: accountability.obligations.obligations, items: accountability.residual.items, annotated: accountability.annotated } : undefined);
    await atomicWrite(join(runDir, "context", "authoring", `${document.id}.md`), markdown);
    authoringPackets += 1;
  }
  manifest.frozenAt = frozenAt;
  manifest.knowledgeDigest = knowledgeDigest(knowledge);
  manifest.metrics.supplements = manifest.metrics.supplements ?? 0;
  manifest.updatedAt = nowIso();
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "investigation.frozen", data: { knowledgeDigest: manifest.knowledgeDigest, evidence: knowledge.evidenceIds.length, workItems: { total: plan.items.length, disposed: knowledge.completeness.disposed }, traces: knowledge.traceIds.length, authoringPackets } });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(runPath, manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  return { manifest, findings, frozen: true, knowledge };
}
