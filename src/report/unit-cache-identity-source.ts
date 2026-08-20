/**
 * Every authoring unit's cache identity for one run ON DISK — the read-only reading behind `excavator unit-cache-identity`.
 *
 * THE RENDERER TAKES VALUES; THIS FILE TAKES A PATH, the same split `unit-packet-source.ts` uses and for the same
 * reason: the identity of a unit must be computable over an archival run without writing a byte into it, and the
 * command an operator runs must not be a second way of assembling the packet inputs. So this loads through
 * `loadUnitPacketSource` per unit rather than rebuilding the input map beside it — one spelling of "what a unit's
 * packet is rendered from", or the identity would be measured over inputs no packet was ever rendered from.
 *
 * A SYNTHESIS WITHOUT COLLECTED CHILDREN IS NAMED, NEVER SKIPPED AND NEVER GUESSED. Its packet is its children's
 * verified summaries, so before any child is collected there is no identity to compute — and that is a fact about
 * the run's state, not a gap in the reading. The row says which children are missing. Nothing here invents a
 * placeholder summary: an identity computed from a summary nobody wrote would be the one thing a cache key may
 * never be.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { PlanCatalogUnit } from "./plan-artifacts.ts";
import { collectedUnitsFor, readUnitLedger } from "./unit-ledger.ts";
import { unitIdentityOf, type UnitAuthorship, type UnitIdentity } from "./unit-cache-identity.ts";
import { loadUnitPacketSource } from "./unit-packet-source.ts";
import { compareUnitIds } from "./unit-paths.ts";
import { loadUnitPlanView } from "./unit-plan-view.ts";

/** One unit's row: an identity, or the named reason there is none yet. No third state. */
export type RunUnitIdentityRow =
  | { readonly state: "identified"; readonly identity: UnitIdentity }
  | {
      readonly state: "unavailable";
      readonly unitId: string;
      readonly documentId: string;
      readonly kind: PlanCatalogUnit["kind"];
      readonly reason: string;
    };

export interface RunUnitIdentities {
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  readonly authorship: UnitAuthorship;
  /** One row per planned unit, ascending by unit id. Every unit of the plan is here, identified or named. */
  readonly rows: readonly RunUnitIdentityRow[];
  /** Every run-relative path this reading opened, sorted. The input contract, as data. */
  readonly readPaths: readonly string[];
}

/** The unit id of one row, whichever arm it is. */
export function rowUnitId(row: RunUnitIdentityRow): string {
  switch (row.state) {
    case "identified":
      return row.identity.unitId;
    case "unavailable":
      return row.unitId;
  }
  return assertNever(row, "run unit identity row state");
}

/**
 * Compute the identity of every unit of a planned run. Never writes; every failure is a named throw.
 *
 * `authorship` is required and has no default for the reason the identity carries it at all: a reading that
 * silently assumed an author would report identities admissible for a draft nobody said was written by anyone.
 */
export async function loadRunUnitIdentities(runDir: string, authorship: UnitAuthorship): Promise<RunUnitIdentities> {
  const view = await loadUnitPlanView(runDir);
  const ledger = await readUnitLedger(runDir, view.runId);
  const collected = new Set(collectedUnitsFor(ledger, view.knowledgeEpoch, view.planCatalogDigest).map((row) => row.unitId));
  const readPaths = new Set<string>(["units/collected.json"]);
  const rows: RunUnitIdentityRow[] = [];
  for (const unit of [...view.planCatalog.units].sort((a, b) => compareUnitIds(a.unitId, b.unitId))) {
    const missing = [...unit.childUnitIds].filter((childUnitId) => !collected.has(childUnitId)).sort(compareUnitIds);
    if (missing.length > 0) {
      rows.push({
        state: "unavailable",
        unitId: unit.unitId,
        documentId: unit.documentId,
        kind: unit.kind,
        reason: `written from collected child summaries, and ${missing.length} of its ${unit.childUnitIds.length} child unit(s) are not collected for knowledge epoch ${view.knowledgeEpoch} under this plan: ${missing.join(", ")}`
      });
      continue;
    }
    // `overBudget` decides what happens to a packet that does not fit its bound; an identity is a measurement over
    // the same composition and never consults it, so the mode here changes nothing about what is digested.
    const source = await loadUnitPacketSource(runDir, { unitId: unit.unitId, overBudget: "record-limitation" });
    for (const path of source.readPaths) readPaths.add(path);
    rows.push({ state: "identified", identity: unitIdentityOf(source.input, authorship) });
  }
  return {
    runId: view.runId,
    knowledgeEpoch: view.knowledgeEpoch,
    planCatalogDigest: view.planCatalogDigest,
    authorship,
    rows,
    readPaths: [...readPaths].sort((a, b) => a.localeCompare(b))
  };
}
