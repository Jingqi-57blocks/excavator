/**
 * What is left to do on the unit path: `status` and `resume`, as a read.
 *
 * THREE STATES, AND NO FOURTH. Every unit of the validated plan is exactly one of `drafted` (a receipt is on disk
 * and has not been collected), `collected` (the collect-written ledger records it for this epoch and this plan) or
 * `unwritten` (neither). The precedence is stated rather than implied: a unit that was collected and then
 * re-drafted reads `drafted`, because uncollected work is the fact an operator has to act on.
 *
 * WHAT WOULD HAVE BEEN THE FOURTH STATE IS REPORTED, NOT SWALLOWED. A receipt or a ledger row from a superseded
 * epoch, from a superseded plan, or naming a unit this plan no longer holds, is not a state of a current unit —
 * but it IS bytes on disk, and a status that ignored them would be a status that quietly forgot work someone did.
 * They come back in `superseded`, each carrying the reason it is not current, with the reasons closed by
 * `assertNever`.
 *
 * THIS FILE WRITES NOTHING. `resumeRun` on the section path rewrites the manifest when a run is timed-out; there
 * is no unit equivalent, because `collect` is the only writer of the shared ledger and a status read must not
 * become a second one. A unit run is resumed by drafting what is unwritten and collecting what is drafted, both
 * of which are named here.
 *
 * ZERO PENDING IS NOT "NO PLAN". A run with no validated plan cannot produce this view at all — the plan gate
 * refuses it by name and says which file is missing. A run whose every unit is collected produces a view with a
 * plan digest, a full unit list and an empty `pending`. The two are different outputs, which is the only way a
 * reader can tell "nothing left to do" from "nothing was ever planned".
 */

import { basename, join, resolve } from "node:path";
import type { RunManifest } from "../base/types.ts";
import { exists, listDirectories, readJson } from "../base/util.ts";
import { assertNever } from "../base/artifact-result.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import { collectedUnitsFor, readUnitLedger } from "./unit-ledger.ts";
import { unitPaths, unitsDir } from "./unit-paths.ts";
import { assertPlanEpoch, loadUnitPlanView, requireKnowledgeEpoch } from "./unit-plan-view.ts";
import { parseUnitReceipt } from "./unit-receipt.ts";

export const UNIT_STATUS_VERSION = "unit-status-v1";

/** The three states of a planned unit. Closed, and consumed exhaustively by the census below. */
export type UnitState = "collected" | "drafted" | "unwritten";

/** Why a receipt or a ledger row is not part of the current picture. Closed, consumed exhaustively. */
export type SupersededReason = "epoch" | "plan" | "not-in-plan";

export interface UnitStatusRow {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  readonly title: string;
  readonly state: UnitState;
}

export interface SupersededUnitRecord {
  readonly unitId: string;
  readonly source: "receipt" | "ledger";
  readonly reason: SupersededReason;
  readonly knowledgeEpoch: number;
}

export interface UnitStateCensus {
  readonly collected: number;
  readonly drafted: number;
  readonly unwritten: number;
}

export interface UnitStatusView {
  readonly version: typeof UNIT_STATUS_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  /** Every planned unit, in collection order. */
  readonly units: readonly UnitStatusRow[];
  readonly census: UnitStateCensus;
  /** Not collected, in collection order: what stands between this run and a complete set of units. */
  readonly pending: readonly string[];
  /** Drafted and awaiting the barrier, in collection order. */
  readonly toCollect: readonly string[];
  /** Unwritten and writable now — for a synthesis, that means every child is already collected. */
  readonly toDraft: readonly string[];
  /** The first of `toDraft`, or null. */
  readonly next: string | null;
  readonly superseded: readonly SupersededUnitRecord[];
  /** One line a reader cannot mistake for a coverage claim. */
  readonly summary: string;
}

/** The unit view of one run. Read-only, and it refuses a run with no validated plan by naming the missing file. */
export async function unitStatus(runDirInput: string): Promise<UnitStatusView> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const knowledgeEpoch = requireKnowledgeEpoch(manifest, "reported");
  const view = await loadUnitPlanView(runDir);
  // The same premise draft and collect stand on: a view derived from a plan that projects a superseded epoch
  // would report units as writable when nothing can be written, so it is refused with the reason instead.
  assertPlanEpoch(view, knowledgeEpoch);
  const ledger = await readUnitLedger(runDir, manifest.id);
  const currentRows = new Map(collectedUnitsFor(ledger, knowledgeEpoch, view.planCatalogDigest).map((row) => [row.unitId, row]));

  const superseded: SupersededUnitRecord[] = [];
  for (const row of ledger.units) {
    if (currentRows.has(row.unitId)) continue;
    superseded.push({
      unitId: row.unitId,
      source: "ledger",
      reason: supersededReason(view.byId.has(row.unitId), row.knowledgeEpoch, knowledgeEpoch),
      knowledgeEpoch: row.knowledgeEpoch
    });
  }

  const drafted = new Set<string>();
  for (const dir of await listDirectories(unitsDir(runDir)).catch(() => [] as string[])) {
    const path = join(dir, "receipt.json");
    if (!await exists(path)) continue;
    let raw: unknown;
    try {
      raw = await readJson<unknown>(path);
    } catch (error) {
      throw new Error(`${path} could not be read as JSON: ${(error as Error).message}`);
    }
    const parsed = parseUnitReceipt(raw);
    if (parsed.receipt === null) throw new Error(`${path} is not a valid unit draft receipt: ${parsed.problems.join("; ")}`);
    const receipt = parsed.receipt;
    const current = view.byId.has(receipt.unitId)
      && receipt.knowledgeEpoch === knowledgeEpoch
      && receipt.planCatalogDigest === view.planCatalogDigest
      && unitPaths(runDir, receipt.unitId).key === basename(dir);
    if (current) drafted.add(receipt.unitId);
    else {
      superseded.push({
        unitId: receipt.unitId,
        source: "receipt",
        reason: supersededReason(view.byId.has(receipt.unitId), receipt.knowledgeEpoch, knowledgeEpoch),
        knowledgeEpoch: receipt.knowledgeEpoch
      });
    }
  }

  const units: UnitStatusRow[] = view.collectionOrder.map((unitId) => {
    const unit = view.byId.get(unitId)!;
    const state: UnitState = drafted.has(unitId) ? "drafted" : currentRows.has(unitId) ? "collected" : "unwritten";
    return { unitId, documentId: unit.documentId, kind: unit.kind, title: unit.title, state };
  });
  const pending = units.filter((row) => row.state !== "collected").map((row) => row.unitId);
  const toCollect = units.filter((row) => row.state === "drafted").map((row) => row.unitId);
  const toDraft = units
    .filter((row) => row.state === "unwritten")
    .filter((row) => view.byId.get(row.unitId)!.childUnitIds.every((childUnitId) => currentRows.has(childUnitId)))
    .map((row) => row.unitId);
  const census = unitStateCensus(units);
  return {
    version: UNIT_STATUS_VERSION,
    runId: manifest.id,
    knowledgeEpoch,
    planCatalogDigest: view.planCatalogDigest,
    units,
    census,
    pending,
    toCollect,
    toDraft,
    next: toDraft[0] ?? null,
    superseded: superseded.sort((a, b) => a.unitId.localeCompare(b.unitId) || a.source.localeCompare(b.source)),
    summary: `${units.length} planned unit(s) at knowledge epoch ${knowledgeEpoch}: ${census.collected} collected, ${census.drafted} drafted and awaiting collect, ${census.unwritten} not yet written; ${superseded.length} superseded record(s)`
  };
}

/** What is left, for a caller that resumes rather than reports. Read-only, like `unitStatus` itself. */
export async function resumeUnits(runDir: string): Promise<{
  readonly pending: readonly string[];
  readonly toDraft: readonly string[];
  readonly toCollect: readonly string[];
  readonly next: string | null;
  readonly superseded: readonly SupersededUnitRecord[];
}> {
  const view = await unitStatus(runDir);
  return { pending: view.pending, toDraft: view.toDraft, toCollect: view.toCollect, next: view.next, superseded: view.superseded };
}

/** The census, exhaustive over the three states: a fourth would have to be counted before this compiles. */
export function unitStateCensus(rows: readonly UnitStatusRow[]): UnitStateCensus {
  const census = { collected: 0, drafted: 0, unwritten: 0 };
  for (const row of rows) census[stateBucket(row.state)] += 1;
  return census;
}

function stateBucket(state: UnitState): keyof UnitStateCensus {
  switch (state) {
    case "collected": return "collected";
    case "drafted": return "drafted";
    case "unwritten": return "unwritten";
  }
  return assertNever(state, "authoring unit state");
}

/** One sentence per superseded record, exhaustive over the reasons. */
export function describeSupersededUnit(record: SupersededUnitRecord, knowledgeEpoch: number): string {
  switch (record.reason) {
    case "epoch":
      return `${record.source} for ${record.unitId} was written at knowledge epoch ${record.knowledgeEpoch}; this run is at epoch ${knowledgeEpoch}, so the unit has to be re-drawn`;
    case "plan":
      return `${record.source} for ${record.unitId} was written against a superseded plan; the unit has to be re-drawn against the recorded one`;
    case "not-in-plan":
      return `${record.source} for ${record.unitId} names a unit this run's plan does not hold`;
  }
  return assertNever(record.reason, "superseded unit reason");
}

/** Epoch first, then plan, then membership: the strongest true statement about why a record is not current. */
function supersededReason(inPlan: boolean, recordEpoch: number, knowledgeEpoch: number): SupersededReason {
  if (recordEpoch !== knowledgeEpoch) return "epoch";
  if (!inPlan) return "not-in-plan";
  return "plan";
}
