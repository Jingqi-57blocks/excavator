/**
 * A model-free run whose obligation ledger holds UNANSWERED obligations, drafted through the real commands.
 *
 * WHY IT IS NOT `tests/unit-assembly-fixture.ts`. That chain disposes every work item `not-applicable` and
 * `material: false`, which is the right premise for assembly and the wrong one for R7c: the checker's whole subject
 * is what a document SAYS about obligations, and the sharpest case — a `fact` claim standing beside an
 * `unavailable` one on an obligation this run could not settle — needs a material obligation with a status of
 * `cannot-determine`. So two of the sample target's twelve work items are disposed that way here (with the reason,
 * `settledBy` and limitation evidence `auditWorkItems` requires) and freeze, plan, draft, collect and assemble all
 * run unchanged. That also means the fixture's grounding audit has a real denominator: the owning unit must carry a
 * linked `unavailable` claim per obligation it owns, which `unitClaimsFor` produces, so a run this helper makes is
 * one that passes every gate the production path applies.
 *
 * THE TWO IDS ARE PINNED BY NAME because they are deterministic — the sample target's work item ids are
 * `project:<dimension>` — and a fixture that picked "the first two" would silently change subject when the
 * dimension list moves.
 *
 * EVERY DRAFT GOES THROUGH `checkpointUnit`, and every digest through Core's own functions, for the reason
 * `tests/unit-fixture.ts` states: a fixture that computed a digest a second way would be testing the second way.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceItem, InvestigationPlan, RunManifest, SectionClaim } from "../src/base/types.ts";
import { normalizeSection } from "../src/report/checkpoint.ts";
import type { PlanCatalogUnit } from "../src/report/plan-artifacts.ts";
import { collectedUnitsFor, readUnitLedger } from "../src/report/unit-ledger.ts";
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import {
  unitClaimsDigest,
  unitContentDigest,
  validateUnitClaims,
  UNIT_SUMMARY_VERSION,
  type UnitSummary,
  type UnitTerminologyEntry
} from "../src/report/unit-output.ts";
import { compareUnitIds } from "../src/report/unit-paths.ts";
import { loadUnitPlanView, type UnitPlanView } from "../src/report/unit-plan-view.ts";
import { freezeRun, prepareRun, updateWorkItems } from "../src/run/run.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { assembleUnits } from "../src/run/stages/unit-assemble-stage.ts";
import { manifestOf, planViewOf, unitRequest } from "./unit-fixture.ts";

/** The two obligations this fixture leaves unanswered. Material, so the grounding audit really owes them. */
export const UNANSWERED_OBLIGATION_IDS = ["project:deprecated-or-unfinished", "project:discarded-errors"] as const;

/** An obligation this fixture disposes `not-applicable`: a subject two units can contradict each other about. */
export const SETTLED_OBLIGATION_ID = "project:literal-secrets";

export interface ConsistencyRun {
  readonly runDir: string;
  readonly workdir: string;
  readonly manifest: RunManifest;
  /** The source evidence id every fact claim of this fixture cites. */
  readonly evidenceId: string;
  readonly view: UnitPlanView;
}

/** How one unit's draft differs from the canned one. Every member optional; absent means "the canned form". */
export interface UnitDraftOverride {
  readonly content?: string;
  /** Extra claims appended after the canned ones. */
  readonly extraClaims?: readonly SectionClaim[];
  readonly terminology?: readonly UnitTerminologyEntry[];
  readonly unknowns?: readonly string[];
}

/** The canned prose of one unit: a heading and one sentence, exactly as `tests/unit-fixture.ts` writes it. */
export function unitProse(unit: PlanCatalogUnit): string {
  return `## ${unit.title}\n\n${unit.unitId} 记录当前状态。\`事实\`\n`;
}

/**
 * The canned claims of one unit: one fact claim about itself, and one `unavailable` claim per obligation it OWNS.
 *
 * The second half is what makes the grounding audit pass on a run whose material obligations are all
 * `cannot-determine`: the rule for that status is "a linked claim marked `unavailable` or `verified`", and this is
 * the honest shape of it.
 */
export function unitClaimsFor(view: UnitPlanView, unit: PlanCatalogUnit, evidenceId: string): SectionClaim[] {
  const ownership = view.ownership.documents.find((document) => document.documentId === unit.documentId);
  const owned = [...(ownership?.ownerByObligation ?? new Map()).entries()]
    .filter(([, row]) => row.ownerUnitId === unit.unitId)
    .map(([workItemId]) => workItemId as string)
    .sort();
  return [
    {
      id: `C-${unit.unitId}`,
      marker: "fact",
      statement: `${unit.unitId} 记录当前状态。`,
      evidenceIds: [evidenceId],
      confidence: "high",
      status: "verified"
    },
    ...owned.map((workItemId): SectionClaim => ({
      id: `U-${workItemId}`,
      marker: "unavailable",
      statement: `义务 ${workItemId} 无法判定。`,
      workItemIds: [workItemId],
      reason: "this run recorded the obligation as cannot-determine",
      status: "unavailable"
    }))
  ];
}

/** A prepared, disposed, frozen, planned run whose two named obligations are unanswered and material. */
export async function plannedConsistencyRun(audiences: Array<"product" | "engineering"> = ["product"]): Promise<ConsistencyRun> {
  const request = await unitRequest(audiences);
  const { runDir } = await prepareRun(request);
  const plan = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as InvestigationPlan;
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  const evidenceId = (catalog.evidence.find((item) => item.kind === "source") ?? catalog.evidence[0]!).id;
  const unanswered = new Set<string>(UNANSWERED_OBLIGATION_IDS);
  for (const id of [...unanswered, SETTLED_OBLIGATION_ID]) {
    if (!plan.items.some((item) => item.id === id)) {
      throw new Error(`fixture expects work item ${id}; this run holds ${plan.items.map((item) => item.id).join(", ")}`);
    }
  }
  await updateWorkItems(runDir, plan.items.map((item) => unanswered.has(item.id)
    ? {
        id: item.id,
        status: "cannot-determine" as const,
        material: true,
        reason: "The synthetic fixture snapshot cannot settle this.",
        settledBy: "unit-consistency-fixture",
        evidenceIds: [evidenceId]
      }
    : { id: item.id, status: "not-applicable" as const, material: false, reason: "Out of scope for the synthetic fixture snapshot." }));
  const frozen = await freezeRun(runDir);
  if (!frozen.frozen) throw new Error(`fixture run did not freeze: ${frozen.findings.map((finding) => finding.message).join("; ")}`);
  await planRun(runDir, { mode: "fixture" }, { kind: "record" });
  const manifest = await manifestOf(runDir);
  return { runDir, workdir: request.workdir, manifest, evidenceId, view: await planViewOf(runDir) };
}

/** Draft one unit and collect it, through the real commands. Returns the normalized bytes that landed on disk. */
export async function draftAndCollect(run: ConsistencyRun, unitId: string, override: UnitDraftOverride = {}): Promise<string> {
  // The view is reloaded per unit because collecting one changes what the next may reference: a synthesis's
  // summary has to name its children's RECORDED digests, and those only exist after the children are collected.
  const view = await loadUnitPlanView(run.runDir, await manifestOf(run.runDir));
  const unit = view.byId.get(unitId);
  if (!unit) throw new Error(`fixture asked to draft ${unitId}, which this plan does not hold`);
  const content = override.content ?? unitProse(unit);
  const claims = [...unitClaimsFor(view, unit, run.evidenceId), ...(override.extraClaims ?? [])];
  const ledger = await readUnitLedger(run.runDir, view.runId);
  const collected = new Map(collectedUnitsFor(ledger, view.knowledgeEpoch, view.planCatalogDigest).map((row) => [row.unitId, row]));
  const summary: UnitSummary = {
    version: UNIT_SUMMARY_VERSION,
    unitId,
    documentId: unit.documentId,
    kind: unit.kind,
    coveredTopicIds: unit.topics.map((topic) => topic.topicId).sort((a, b) => a.localeCompare(b)),
    keyStatements: [`${unit.title} 的当前状态已记录。`],
    unknowns: [...(override.unknowns ?? [])],
    terminology: [...(override.terminology ?? [])],
    contentDigest: unitContentDigest(normalizeSection(content, unit.title)),
    claimsDigest: unitClaimsDigest(validateUnitClaims(unitId, unit.documentId, claims)),
    childSummaryDigests: [...unit.childUnitIds].sort(compareUnitIds).map((childUnitId) => {
      const row = collected.get(childUnitId);
      if (!row) throw new Error(`fixture cannot summarise ${unitId}: its child ${childUnitId} is not collected`);
      return { childUnitId, summaryDigest: row.summaryDigest };
    })
  };
  await checkpointUnit(run.runDir, {
    unitId,
    content,
    claims,
    summary,
    authorship: { kind: "model-free", generator: "unit-consistency-fixture" },
    provenance: { kind: "fresh" }
  });
  return normalizeSection(content, unit.title);
}

/** A planned run with every unit drafted and collected in the plan's one order, then assembled. */
export async function assembledConsistencyRun(
  overrides: Readonly<Record<string, UnitDraftOverride>> = {},
  audiences: Array<"product" | "engineering"> = ["product"]
): Promise<ConsistencyRun> {
  const run = await plannedConsistencyRun(audiences);
  const named = new Set(Object.keys(overrides));
  for (const unitId of run.view.collectionOrder) named.delete(unitId);
  if (named.size > 0) throw new Error(`fixture was given overrides for unit(s) this plan does not hold: ${[...named].sort().join(", ")}`);
  for (const unitId of run.view.collectionOrder) await draftAndCollect(run, unitId, overrides[unitId] ?? {});
  await assembleUnits(run.runDir, "write");
  return { ...run, manifest: await manifestOf(run.runDir), view: await planViewOf(run.runDir) };
}

/** Re-draft and re-collect the named units, then assemble again — the repair path, through the real commands. */
export async function repairUnits(
  run: ConsistencyRun,
  unitIds: readonly string[],
  overrides: Readonly<Record<string, UnitDraftOverride>> = {}
): Promise<void> {
  const view = await planViewOf(run.runDir);
  const order = view.collectionOrder.filter((unitId) => unitIds.includes(unitId));
  if (order.length !== unitIds.length) {
    throw new Error(`fixture was asked to repair ${unitIds.length} unit(s) but the plan's order holds ${order.length} of them`);
  }
  for (const unitId of order) await draftAndCollect(run, unitId, overrides[unitId] ?? {});
  await assembleUnits(run.runDir, "write");
}
