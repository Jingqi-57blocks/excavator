/**
 * Shared setup for the authoring-unit tests: a frozen, planned run, and a legal draft for one of its units.
 *
 * THE DRAFT INPUT IS BUILT WITH CORE'S OWN NORMALIZER AND DIGEST FUNCTIONS, on purpose. A summary is only legal
 * when its `contentDigest` and `claimsDigest` are the digests of the bytes about to be written, so a fixture that
 * computed them a second way would be testing the second way. The digest checks are exercised from the other
 * side instead: the negative fixtures corrupt one field of a summary this helper produced and watch the named
 * refusal fire.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceItem, ReportRequest, RunManifest, SectionClaim } from "../src/base/types.ts";
import { stableJson } from "../src/base/util.ts";
import { freezeRun, prepareRun } from "../src/run/run.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { normalizeSection } from "../src/report/checkpoint.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import type { PlanCatalogUnit } from "../src/report/plan-artifacts.ts";
import type { PlanProposal, ProposedUnit } from "../src/report/plan-proposal.ts";
import { readReportRequests } from "../src/report/report-requests-artifact.ts";
import { buildTopicCatalog } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import { collectedUnitsFor, readUnitLedger } from "../src/report/unit-ledger.ts";
import { unitClaimsDigest, unitContentDigest, validateUnitClaims, UNIT_SUMMARY_VERSION, type UnitSummary } from "../src/report/unit-output.ts";
import { loadUnitPlanView, type UnitPlanView } from "../src/report/unit-plan-view.ts";
import { compareUnitIds } from "../src/report/unit-paths.ts";
import type { UnitDraftInput } from "../src/report/unit-draft.ts";
import type { UnitAuthorship } from "../src/report/unit-provenance.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, manifestOf, tempDir } from "./helpers.ts";

export { manifestOf };

/**
 * The author every draft in these fixtures is written by. Model-FREE and named: the fixture is a generator, and a
 * test that claimed a model family wrote its content would be putting a false provenance into a cache key.
 */
export const FIXTURE_DRAFT_AUTHORSHIP: UnitAuthorship = { kind: "model-free", generator: "unit-test-fixture" };

export const UNIT_BUDGETS = {
  prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50,
  maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2
};

export interface PlannedRun {
  readonly runDir: string;
  readonly workdir: string;
  readonly manifest: RunManifest;
  readonly evidenceId: string;
  readonly view: UnitPlanView;
}

export async function unitRequest(audiences: Array<"product" | "engineering"> = ["product"]): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir("excavator-unit-");
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: audiences, features: [], budgets: UNIT_BUDGETS };
}

/** A prepared, disposed, frozen run. The plan is NOT written yet, so a caller can choose which plan it gets. */
export async function frozenRun(audiences: Array<"product" | "engineering"> = ["product"]): Promise<{ runDir: string; workdir: string; manifest: RunManifest; evidenceId: string }> {
  const request = await unitRequest(audiences);
  const { runDir } = await prepareRun(request);
  await disposeAllWorkItems(runDir);
  const frozen = await freezeRun(runDir);
  if (!frozen.frozen) throw new Error(`fixture run did not freeze: ${frozen.findings.map((finding) => finding.message).join("; ")}`);
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  return {
    runDir,
    workdir: request.workdir,
    manifest: await manifestOf(runDir),
    evidenceId: (catalog.evidence.find((item) => item.kind === "source") ?? catalog.evidence[0]!).id
  };
}

/** A frozen run with the deterministic fixture plan recorded — the premise every unit command needs. */
export async function plannedRun(audiences: Array<"product" | "engineering"> = ["product"]): Promise<PlannedRun> {
  const base = await frozenRun(audiences);
  await planRun(base.runDir, { mode: "fixture" });
  return { ...base, view: await loadUnitPlanView(base.runDir, base.manifest) };
}


export function unitContent(unit: PlanCatalogUnit): string {
  return `## ${unit.title}\n\n${unit.unitId} 记录当前状态。\`事实\`\n`;
}

export function unitClaims(unit: PlanCatalogUnit, evidenceId: string): SectionClaim[] {
  return [{
    id: `C-${unit.unitId}`,
    marker: "fact",
    statement: `${unit.unitId} 记录当前状态。`,
    evidenceIds: [evidenceId],
    confidence: "high",
    status: "verified"
  }];
}

/**
 * A legal draft for one unit of a planned run: content, claims, and the summary that describes exactly them.
 *
 * For a synthesis the child digests come from the collect-written ledger, which is the only place a parent may
 * learn what its children said — the same rule the draft path enforces. It FAILS CLOSED when a child it needs is
 * not collected: substituting a plausible all-zeros digest made this fixture able to go red for the wrong reason,
 * so a test that deliberately wants an out-of-order draft passes `childSummaryDigests` explicitly.
 */
export async function unitDraftFor(run: PlannedRun, unitId: string, overrides: Partial<UnitSummary> = {}): Promise<UnitDraftInput> {
  const unit = run.view.byId.get(unitId);
  if (!unit) throw new Error(`fixture asked for unit ${unitId}, which this plan does not hold`);
  const content = unitContent(unit);
  const claims = unitClaims(unit, run.evidenceId);
  const ledger = await readUnitLedger(run.runDir, run.manifest.id);
  const collected = new Map(collectedUnitsFor(ledger, run.view.knowledgeEpoch, run.view.planCatalogDigest).map((row) => [row.unitId, row]));
  // Computed only when the caller has not supplied it: the fail-closed derivation below must not fire for a test
  // that deliberately asks for a draft of a synthesis whose children are not collected yet.
  const childSummaryDigests = overrides.childSummaryDigests ?? [...unit.childUnitIds].sort(compareUnitIds).map((childUnitId) => {
    const row = collected.get(childUnitId);
    if (!row) throw new Error(`fixture cannot summarise ${unitId}: its child ${childUnitId} is not collected, so no real summary digest exists`);
    return { childUnitId, summaryDigest: row.summaryDigest };
  });
  const summary: UnitSummary = {
    version: UNIT_SUMMARY_VERSION,
    unitId: unit.unitId,
    documentId: unit.documentId,
    kind: unit.kind,
    coveredTopicIds: unit.topics.map((topic) => topic.topicId).sort((a, b) => a.localeCompare(b)),
    keyStatements: [`${unit.title} 的当前状态已记录。`],
    unknowns: [],
    terminology: [],
    contentDigest: unitContentDigest(normalizeSection(content, unit.title)),
    claimsDigest: unitClaimsDigest(validateUnitClaims(unit.unitId, unit.documentId, claims)),
    childSummaryDigests,
    ...overrides
  };
  return { unitId, content, claims, summary, authorship: FIXTURE_DRAFT_AUTHORSHIP, provenance: { kind: "fresh" } };
}

/**
 * Record a plan whose unit ids are rewritten by `rename` — how a hostile id from a model's proposal gets onto
 * disk. The proposal goes through the same validator every plan does; `parsePlanProposal` asks only that a unit
 * id be a non-empty string, which is exactly why the path module has to be the one that refuses it.
 */
export async function planWithRenamedUnits(runDir: string, workdir: string, rename: (unitId: string) => string): Promise<void> {
  const catalog = buildTopicCatalog(await loadTopicCatalogSource(runDir, await manifestOf(runDir)));
  const requests = await readReportRequests(runDir);
  const base = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const units: ProposedUnit[] = base.units.map((unit) => unit.kind === "synthesis"
    ? { ...unit, unitId: rename(unit.unitId), childUnitIds: unit.childUnitIds.map(rename).sort((a, b) => a.localeCompare(b)) }
    : { ...unit, unitId: rename(unit.unitId) });
  const proposal: PlanProposal = { ...base, units: units.sort((a, b) => a.unitId.localeCompare(b.unitId)) };
  const path = join(workdir, `proposal-${units.length}.json`);
  await writeFile(path, `${stableJson(proposal)}\n`);
  await planRun(runDir, { mode: "file", path });
}

/**
 * Record a plan that adds one leaf unit carrying real topics, so the tests see a document with more than the
 * appendix the sample target's zero-material catalog yields on its own.
 */
export async function planWithLeaf(runDir: string, workdir: string, facet: string, topicCount: number): Promise<string> {
  const catalog = buildTopicCatalog(await loadTopicCatalogSource(runDir, await manifestOf(runDir)));
  const requests = await readReportRequests(runDir);
  const base = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const documentId = [...requests.requests].sort((a, b) => a.documentId.localeCompare(b.documentId))[0]!.documentId;
  const topicIds = catalog.topics
    .filter((topic) => topic.facet === facet)
    .map((topic) => topic.topicId)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, topicCount);
  if (topicIds.length !== topicCount) throw new Error(`fixture wanted ${topicCount} ${facet} topic(s); the catalog holds ${topicIds.length}`);
  const leafId = `${documentId}::leaf::${facet}`;
  const units: ProposedUnit[] = base.units.map((unit) => unit.kind === "synthesis" && unit.documentId === documentId
    ? { ...unit, childUnitIds: [...unit.childUnitIds, leafId].sort((a, b) => a.localeCompare(b)) }
    : unit);
  units.push({ kind: "leaf", unitId: leafId, documentId, title: `${facet} topics`, topics: topicIds.map((topicId) => ({ topicId, obligationScope: { kind: "all" as const } })) });
  const proposal: PlanProposal = { ...base, units: units.sort((a, b) => a.unitId.localeCompare(b.unitId)) };
  const path = join(workdir, "proposal-leaf.json");
  await writeFile(path, `${stableJson(proposal)}\n`);
  await planRun(runDir, { mode: "file", path });
  return leafId;
}
