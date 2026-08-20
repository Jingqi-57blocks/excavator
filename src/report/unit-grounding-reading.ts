/**
 * The run-level reading of gate 1b: every unit's grounding verdict, over the plan's OWN obligation accounting.
 *
 * THERE IS ONE DENOMINATOR AND THIS FILE DOES NOT COMPUTE IT. `accounting` is read from the recorded plan (where
 * R3's `accountPlanObligations` put it, and where the plan gate re-derives it on every read); the per-unit
 * reachable sets come from the SAME shared index those buckets were computed from. So the four buckets here are
 * the four buckets there, by construction rather than by agreement — and `assertReachMatchesAccounting` states it
 * as a check anyway, because a conservation law nobody asserts is a comment.
 *
 * THE FIFTH BUCKET IS VISIBLE, NOT SILENT. The full audit's grounding denominator excludes `origin === "open"` work
 * items; the plan accounting counts every material binding. `openOriginExempt` is that difference, listed by id, so
 * the two readings can differ without either one lying. On the wcp baseline it is 0 — a latent fork, not an active
 * one, which is exactly the kind that is cheapest to close and easiest to forget.
 *
 * WHAT AN EMPTY SET MEANS IS ALWAYS STATED. A unit with no claims sidecar on disk is `unwritten` and named, never
 * counted as a clean unit; a unit that reaches no material obligation is `vacuous` with its source, never
 * `complete`. "Nothing was checked" and "everything checked out" are two sentences here.
 */

import { join, resolve } from "node:path";
import type { RunManifest } from "../base/types.ts";
import { exists, readJson } from "../base/util.ts";
import type { PlanCatalogUnit } from "./plan-artifacts.ts";
import type { PlanObligationAccounting } from "./plan-obligation-conservation.ts";
import { parseUnitClaims } from "./unit-output.ts";
import { auditUnitGrounding, summariseUnitGrounding, type OpenOriginObligation, type UnitGroundingResult } from "./unit-grounding-audit.ts";
import { unitPaths } from "./unit-paths.ts";
import { assertPlanEpoch, loadUnitPlanView, requireKnowledgeEpoch, type UnitPlanView } from "./unit-plan-view.ts";

export const UNIT_GROUNDING_READING_VERSION = "unit-grounding-reading-v1";

export interface UnitGroundingReading {
  readonly version: typeof UNIT_GROUNDING_READING_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  /** Gate 1b's plan-side accounting, READ from the recorded plan. The one denominator. */
  readonly accounting: PlanObligationAccounting;
  /** Material obligations in units whose ledger row carries `origin: "open"` — exempt, counted, listed. */
  readonly openOriginExempt: readonly OpenOriginObligation[];
  /** One row per planned unit whose claims sidecar is on disk, in collection order. */
  readonly units: readonly UnitGroundingResult[];
  /** Planned units with no claims on disk. Named: there is nothing to audit yet, which is not the same as clean. */
  readonly unwritten: readonly string[];
  readonly summary: string;
}

/** Audit one unit from the artifacts on disk. What the collect barrier calls before it records a unit. */
export async function auditUnitFromDisk(runDir: string, view: UnitPlanView, unit: PlanCatalogUnit): Promise<UnitGroundingResult> {
  const paths = unitPaths(runDir, unit.unitId);
  const parsed = parseUnitClaims(await readJson<unknown>(paths.claims));
  if (parsed.claims === null) {
    throw new Error(`${paths.claims} is not a valid unit claims sidecar: ${parsed.problems.join("; ")}`);
  }
  if (parsed.claims.unitId !== unit.unitId) {
    throw new Error(`${paths.claims} records unit ${JSON.stringify(parsed.claims.unitId)}, but it sits in the directory of ${JSON.stringify(unit.unitId)}`);
  }
  return auditUnitGrounding({ unit, obligations: view.obligations, workItems: view.workItems, claims: parsed.claims.claims });
}

/**
 * The run-wide reading: every written unit audited, every planned unit accounted for.
 *
 * Read-only. It is the re-runnable entry point for a verdict `collect` already applied once, and the reading a
 * baseline projection records.
 */
export async function readUnitGrounding(runDir: string, view: UnitPlanView): Promise<UnitGroundingReading> {
  const accounting = view.planCatalog.obligationAccounting;
  assertReachMatchesAccounting(view, accounting);

  const units: UnitGroundingResult[] = [];
  const unwritten: string[] = [];
  const openOriginExempt = new Map<string, OpenOriginObligation>();
  for (const unitId of view.collectionOrder) {
    const unit = view.byId.get(unitId)!;
    // Computed for every planned unit, written or not: the exemption is a property of the plan and the ledger, not
    // of whether anybody has written the prose yet.
    for (const row of auditUnitGrounding({ unit, obligations: view.obligations, workItems: view.workItems, claims: [] }).openOriginExempt) {
      openOriginExempt.set(row.workItemId, row);
    }
    if (!await exists(unitPaths(runDir, unitId).claims)) {
      unwritten.push(unitId);
      continue;
    }
    units.push(await auditUnitFromDisk(runDir, view, unit));
  }

  const violations = units.filter((row) => row.verdict.conclusion === "violations");
  return {
    version: UNIT_GROUNDING_READING_VERSION,
    runId: view.runId,
    knowledgeEpoch: view.knowledgeEpoch,
    planCatalogDigest: view.planCatalogDigest,
    accounting,
    openOriginExempt: [...openOriginExempt.values()].sort((a, b) => a.workItemId.localeCompare(b.workItemId)),
    units,
    unwritten,
    summary: `${accounting.materialObligations} material obligation(s): ${accounting.inUnits} in units, ${accounting.waived} waived, ${accounting.unplaced} claimed but unplaced, ${accounting.undispositioned} undispositioned; ${openOriginExempt.size} of the in-unit ones are open-origin and exempt from grounding. ${units.length} of ${view.units.length} planned unit(s) audited (${violations.length} with violations), ${unwritten.length} not written.`
  };
}

/**
 * The read-only entry point: load the validated plan, check the two epoch premises, produce the reading.
 *
 * The same premises `draft`, `collect` and `status` stand on, in the same order and with the same messages. A run
 * with no validated plan is refused by the gate naming the missing file, never reported as "0 units audited".
 */
export async function readUnitGroundingForRun(runDirInput: string): Promise<UnitGroundingReading> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const knowledgeEpoch = requireKnowledgeEpoch(manifest, "audited");
  const view = await loadUnitPlanView(runDir);
  assertPlanEpoch(view, knowledgeEpoch);
  return readUnitGrounding(runDir, view);
}

/**
 * The same-source check: the obligations the units can reach ARE the plan accounting's `inUnits` bucket.
 *
 * The `inUnits` id list is not a field of the accounting, so it is DERIVED FROM THE ACCOUNTING'S OWN LISTS — every
 * material obligation minus the three it names by id. That keeps one source: if this file recomputed which
 * obligations are in units, a bug in either derivation would just produce two plausible numbers.
 */
export function assertReachMatchesAccounting(view: UnitPlanView, accounting: PlanObligationAccounting): void {
  const exits = new Set<string>([
    ...accounting.waivedObligations.map((row) => row.workItemId),
    ...accounting.unplacedObligations.map((row) => row.workItemId),
    ...accounting.undispositionedObligations.map((row) => row.workItemId)
  ]);
  const expected = view.obligations.map((row) => row.workItemId).filter((workItemId) => !exits.has(workItemId));
  if (expected.length !== accounting.inUnits) {
    throw new Error(`The recorded plan accounts ${accounting.inUnits} material obligation(s) as in units, but its own bucket lists leave ${expected.length} of ${view.obligations.length}; the plan's obligation accounting does not match its own lists`);
  }
  const unitTopics = new Set<string>();
  for (const unit of view.units) for (const reference of unit.topics) unitTopics.add(reference.topicId);
  const reached = new Set(view.obligations
    .filter((row) => row.topicIds.some((topicId) => unitTopics.has(topicId)))
    .map((row) => row.workItemId));
  const missing = expected.filter((workItemId) => !reached.has(workItemId));
  const extra = [...reached].filter((workItemId) => !expected.includes(workItemId)).sort((a, b) => a.localeCompare(b));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`The units of this plan reach ${reached.size} material obligation(s) but its accounting puts ${expected.length} in units; ${missing.length} accounted-for obligation(s) are reachable through no unit (${missing.slice(0, 5).join(", ")}) and ${extra.length} reachable one(s) are not accounted for (${extra.slice(0, 5).join(", ")})`);
  }
}

/** One line per audited unit, in collection order. The reading a CLI prints. */
export function summariseUnitGroundingReading(reading: UnitGroundingReading): readonly string[] {
  return [
    reading.summary,
    ...reading.units.map((row) => summariseUnitGrounding(row)),
    ...reading.unwritten.map((unitId) => `unwritten: unit ${unitId} has no claims on disk, so nothing was checked for it`)
  ];
}
