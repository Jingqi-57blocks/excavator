/**
 * What one unit packet is rendered FROM, loaded from a run directory and checked before the renderer sees it.
 *
 * THE RENDERER TAKES VALUES; THIS FILE TAKES A PATH. That split is what lets the packet be rendered over an archival
 * baseline without writing a byte into it, and it is the same shape R2/R3 use (`topic-catalog-source.ts` loads,
 * `topic-catalog.ts` derives). Everything here is a read.
 *
 * WHAT IT MAY NOT READ. `sections/`, `claims/`, `context/authoring/`, `reports/` and `prompts/` — the section
 * world's authoring artifacts — and no file outside the run directory, so no target source is opened. Every read
 * goes through one helper that records the run-relative path, `readPaths` publishes the list, and the forbidden set
 * is asserted against it in test. What it DOES read beyond the plan gate's own inputs is `evidence.json` (by id,
 * for the records the obligations bind) and, for a synthesis, its collected children's `summary.json` — the epic's
 * one legal parent input.
 *
 * THE BOUND COMES FROM THE PLAN. `PlanBudget.perUnitInputBytes` for the unit's own document is the declared bound
 * unless a caller states another one; there is no invented number and no second authority. A caller MUST state the
 * over-budget mode: `refuse` or `record-limitation`, never a default and never truncation.
 */

import { join, resolve } from "node:path";
import { assertNever } from "../base/artifact-result.ts";
import type { EvidenceItem, RunManifest } from "../base/types.ts";
import { readJson } from "../base/util.ts";
import { readEvidenceCatalog } from "../investigation/evidence-store.ts";
import type { PlanCatalogUnit } from "./plan-artifacts.ts";
import { documentOwnership } from "./plan-obligation-conservation.ts";
import type { PacketOverBudgetMode } from "./planner-packet.ts";
import { REPORT_POLICY_REGISTRY } from "./report-policy-registry.ts";
import { collectedUnitsFor, readUnitLedger, type CollectedUnit } from "./unit-ledger.ts";
import { parseUnitSummary, unitSummaryDigest, type UnitSummary } from "./unit-output.ts";
import { evidenceReachOf, renderUnitPacket, topicDossier, unitInputBound, type RunEvidenceReach, type UnitDossier, type UnitPacket, type UnitPacketInput } from "./unit-packet.ts";
import { unitPaths } from "./unit-paths.ts";
import { assertPlanEpoch, loadUnitPlanView, planUnit, requireKnowledgeEpoch, type UnitPlanView } from "./unit-plan-view.ts";

/** Run-relative directories a unit packet may never read. Asserted against `readPaths` in test. */
export const UNIT_PACKET_FORBIDDEN_INPUT_PREFIXES = ["claims/", "context/authoring/", "prompts/", "reports/", "sections/"] as const;

/**
 * WHICH RECORDED ROWS a synthesis's child summaries must verify against. Required, closed, and never defaulted.
 *
 * `collected-for-this-plan` is the authoring case: a synthesis may only be written from children this run has
 * collected UNDER THE PLAN NOW IN FORCE, which is what `draftUnit` and the read-only packet command need.
 *
 * `verified-candidates` is R6b's admission case, and it exists because of an ordering fact rather than a
 * preference: a candidate synthesis is decided BEFORE its children are re-collected, so under the plan now in force
 * none of them is collected yet. Its identity is the one its CANDIDATE was written from — the children's summaries
 * as the rows that verified them recorded them. The digest check is the same check either way: the bytes on disk
 * must still digest to what a recorded row promised. Nothing here ever reads a summary no row vouches for.
 *
 * Making it a required parameter rather than an option with a default is the point: a mode that could be omitted
 * would be omitted, and the omission would silently mean "the current plan" at the one call site where that answer
 * is wrong.
 */
export type UnitChildSummarySource =
  | { readonly from: "collected-for-this-plan" }
  | { readonly from: "verified-candidates"; readonly rows: ReadonlyMap<string, CollectedUnit> };

export interface UnitPacketSource {
  readonly view: UnitPlanView;
  readonly unit: PlanCatalogUnit;
  readonly input: UnitPacketInput;
  /** Every run-relative path this load opened, sorted. The input contract, as data. */
  readonly readPaths: readonly string[];
}

export interface UnitPacketOptions {
  readonly unitId: string;
  readonly overBudget: PacketOverBudgetMode;
  /** Which recorded rows a synthesis's children must verify against. Required: there is no default. */
  readonly childSummaries: UnitChildSummarySource;
  /** Defaults to the plan's `perUnitInputBytes` for this unit's document — the only authority for an input bound. */
  readonly byteLimit?: number;
}

/** Load everything one unit's packet is rendered from. Never writes; every failure is a named throw. */
export async function loadUnitPacketSource(runDirInput: string, options: UnitPacketOptions): Promise<UnitPacketSource> {
  const runDir = resolve(runDirInput);
  const readPaths: string[] = ["run.json"];
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const knowledgeEpoch = requireKnowledgeEpoch(manifest, "rendered as a packet");
  const view = await loadUnitPlanView(runDir);
  assertPlanEpoch(view, knowledgeEpoch);
  readPaths.push(...planReadPaths(view));
  const unit = planUnit(view, options.unitId);

  readPaths.push("evidence.json");
  const evidence = await readEvidenceCatalog(runDir);
  const evidenceById = new Map(evidence.evidence.map((item) => [item.id, item]));
  const reach = evidenceReach(view, evidenceById);

  const { dossier, paths } = await dossierFor(runDir, view, unit, manifest, knowledgeEpoch, evidenceById, options.childSummaries);
  readPaths.push(...paths);

  return {
    view,
    unit,
    input: {
      planCatalog: view.planCatalog,
      facets: view.catalog.facets,
      dag: view.dag,
      requests: view.requests,
      registry: REPORT_POLICY_REGISTRY,
      unitId: unit.unitId,
      dossier,
      // The ownership the grounding audit will use, from the view's single derivation: the author must be handed
      // the same owner map the gate reads, or the packet's stubs and the audit's exemptions would be two answers.
      ownership: documentOwnership(view.ownership, unit.documentId),
      reach,
      byteLimit: options.byteLimit ?? unitInputBound(view.planCatalog, unit),
      overBudget: options.overBudget
    },
    readPaths: [...new Set(readPaths)].sort((a, b) => a.localeCompare(b))
  };
}

/** Load and render in one call — what the read-only CLI command does. */
export async function renderUnitPacketForRun(runDir: string, options: UnitPacketOptions): Promise<{ readonly packet: UnitPacket; readonly readPaths: readonly string[] }> {
  const source = await loadUnitPacketSource(runDir, options);
  return { packet: renderUnitPacket(source.input), readPaths: source.readPaths };
}

/**
 * How far the obligation ledger reaches into the frozen evidence set — mechanism A, as three numbers and a list.
 *
 * Delegated to `evidenceReachOf`, which the plan-side budget measure reads too: this was spelled twice before R5b
 * and the measure would have made it three times. The packet PRINTS these numbers and the plan CHECKS against a
 * packet, so two derivations of them are two packets.
 */
function evidenceReach(view: UnitPlanView, evidenceById: ReadonlyMap<string, EvidenceItem>): RunEvidenceReach {
  return evidenceReachOf(view.frozenEvidenceIds, view.workItems.values(), evidenceById);
}

/**
 * The dossier for one unit — exhaustive over the four kinds, so a fifth has to say what it is written from.
 *
 * A synthesis's children must already be COLLECTED, and each summary on disk must still digest to what the ledger
 * recorded. Refusing an uncollected child is not a limitation of this loader: there is no summary to render, and a
 * placeholder would be a parent written from something no child said.
 */
async function dossierFor(
  runDir: string,
  view: UnitPlanView,
  unit: PlanCatalogUnit,
  manifest: RunManifest,
  knowledgeEpoch: number,
  evidenceById: ReadonlyMap<string, EvidenceItem>,
  childSummaries: UnitChildSummarySource
): Promise<{ readonly dossier: UnitDossier; readonly paths: readonly string[] }> {
  switch (unit.kind) {
    case "leaf":
    case "bridge":
    case "appendix":
      return { dossier: topicDossier(unit, view.topicsById, evidenceById), paths: [] };
    case "synthesis": {
      const vouched = await vouchedChildRows(runDir, view, manifest, knowledgeEpoch, childSummaries);
      const paths = [...vouched.paths];
      const children: UnitSummary[] = [];
      for (const childUnitId of [...unit.childUnitIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        const row = vouched.rows.get(childUnitId);
        if (!row) {
          throw new Error(`Synthesis unit ${JSON.stringify(unit.unitId)} cannot be given a packet yet: its child ${JSON.stringify(childUnitId)} ${vouched.missing}, and a synthesis is written from child summaries a recorded row vouches for`);
        }
        const childPaths = unitPaths(runDir, childUnitId);
        paths.push(`units/${childPaths.key}/summary.json`);
        const parsed = parseUnitSummary(await readJson<unknown>(childPaths.summary));
        if (parsed.summary === null) {
          throw new Error(`${childPaths.summary} is not a valid unit summary: ${parsed.problems.join("; ")}`);
        }
        const digest = unitSummaryDigest(parsed.summary);
        if (digest !== row.summaryDigest) {
          throw new Error(`Child ${JSON.stringify(childUnitId)} has a summary digesting to ${digest} but the unit ledger recorded ${row.summaryDigest}; re-collect the child before writing ${JSON.stringify(unit.unitId)}`);
        }
        children.push(parsed.summary);
      }
      return { dossier: { source: "child-summaries", children }, paths };
    }
  }
  return assertNever(unit.kind, "authoring unit kind");
}

/**
 * The recorded rows that vouch for the child summaries this packet may read — exhaustive over the two sources.
 *
 * Each arm publishes the paths IT opened: the candidate arm opens nothing, because the caller that assembled the
 * candidate rows is the one that read the ledger and the one that publishes having done so.
 */
async function vouchedChildRows(
  runDir: string,
  view: UnitPlanView,
  manifest: RunManifest,
  knowledgeEpoch: number,
  childSummaries: UnitChildSummarySource
): Promise<{ readonly rows: ReadonlyMap<string, CollectedUnit>; readonly paths: readonly string[]; readonly missing: string }> {
  switch (childSummaries.from) {
    case "collected-for-this-plan": {
      const ledger = await readUnitLedger(runDir, manifest.id);
      return {
        rows: new Map(collectedUnitsFor(ledger, knowledgeEpoch, view.planCatalogDigest).map((row) => [row.unitId, row])),
        paths: ["units/collected.json"],
        missing: "is not collected under the plan now in force"
      };
    }
    case "verified-candidates":
      return { rows: childSummaries.rows, paths: [], missing: "is not offered as a verified candidate" };
  }
  return assertNever(childSummaries, "unit child summary source");
}

/** The plan files the gate read, as run-relative paths, plus the knowledge-side ledgers it projected. */
export function planReadPaths(view: UnitPlanView): readonly string[] {
  return ["plan/requests.json", "plan/topics.json", "plan/catalog.json", "plan/dag.json", ...view.sourceReadPaths];
}
