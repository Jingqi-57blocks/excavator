/**
 * The plan, as the unit machinery needs to read it: which units exist, what each one is, and the ONE order they
 * are collected in.
 *
 * THE ORDER IS A PURE FUNCTION OF THE PLAN, never of who finished drafting first. Documents ascending by
 * `documentId`, and inside a document the `authoringOrder` `plan/dag.json` already records — children before
 * parents, because a synthesis may only be written from summaries that exist. `collect` filters this order down
 * to the receipts on disk, so the timeline event sequence it produces is decided by the plan and reproducible
 * from it.
 *
 * IT RE-VALIDATES THROUGH THE ONE GATE. Everything here comes from `assertValidatedPlanForAuthoring`, so a unit
 * is never drafted or collected against a plan that no longer validates against its own epoch. There is no
 * lighter path that reads the files without checking them.
 *
 * IT ALSO OWNS THE TWO EPOCH PREMISES, because draft, collect and status all stand on them and a premise stated
 * three times is a premise that will one day be stated three ways: a run must have a current knowledge epoch,
 * and the recorded plan must project that same epoch. Authoring against a plan built from superseded knowledge
 * is refused by name rather than performed.
 *
 * THE TWO CONSERVATION CHECKS BELOW ARE NOT CEREMONY. If the recorded authoring order held fewer units than the
 * plan, `collect` would skip the missing ones in silence and every count downstream would still add up — the
 * order would just quietly not mention them. And if two unit ids encoded to one directory, two units would share
 * one set of artifacts while every row count stayed balanced. Both are stated as named failures here, once, for
 * every caller.
 */

import type { RunManifest } from "../base/types.ts";
import { assertValidatedPlanForAuthoring } from "./plan-gate.ts";
import { planCatalogDigest, type PlanCatalogUnit } from "./plan-artifacts.ts";
import { assertDistinctUnitPathKeys, compareUnitIds, unitPathKey } from "./unit-paths.ts";

export interface UnitPlanView {
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  /** Every unit of the plan, ascending by unit id. */
  readonly units: readonly PlanCatalogUnit[];
  readonly byId: ReadonlyMap<string, PlanCatalogUnit>;
  /** Every unit exactly once: documents ascending, then each document's authoring order. */
  readonly collectionOrder: readonly string[];
}

/** Load and re-validate this run's plan, then derive the unit view of it. */
export async function loadUnitPlanView(runDir: string): Promise<UnitPlanView> {
  const gate = await assertValidatedPlanForAuthoring(runDir);
  const units = [...gate.planCatalog.units].sort((a, b) => compareUnitIds(a.unitId, b.unitId));
  assertDistinctUnitPathKeys(units.map((unit) => unit.unitId), unitPathKey);
  const collectionOrder = unitCollectionOrder(units.map((unit) => unit.unitId), gate.dag.documents);
  return {
    runId: gate.planCatalog.runId,
    knowledgeEpoch: gate.planCatalog.knowledgeEpoch,
    planCatalogDigest: planCatalogDigest(gate.planCatalog),
    units,
    byId: new Map(units.map((unit) => [unit.unitId, unit])),
    collectionOrder
  };
}

/** The epoch a unit is drafted from. Absent is a named refusal, never a draft that skips the comparison. */
export function requireKnowledgeEpoch(manifest: RunManifest, action: string): number {
  if (manifest.knowledgeEpoch === undefined) {
    throw new Error(`This run has no current knowledge epoch, so a unit cannot be ${action}; re-prepare it under the current assurance version and freeze it`);
  }
  return manifest.knowledgeEpoch;
}

/** The plan and the manifest must name one epoch. A disagreement is a bug in the run, and it is named as one. */
export function assertPlanEpoch(view: UnitPlanView, knowledgeEpoch: number): void {
  if (view.knowledgeEpoch !== knowledgeEpoch) {
    throw new Error(`The recorded plan projects knowledge epoch ${view.knowledgeEpoch} but the run manifest is at epoch ${knowledgeEpoch}; re-plan this run before authoring units`);
  }
}

/**
 * The one collection order, as a pure function of the plan: documents ascending, then each document's recorded
 * authoring order.
 *
 * Both refusals are about the same silent failure. If the recorded order held FEWER units than the plan, collect
 * would skip the missing ones and say nothing — every count it reported would still add up, because the order
 * would simply not mention them. If it named a unit the plan does not hold, collect would look for a receipt that
 * can never exist. R3's `readPlanDag` re-derives this order and refuses a recorded one that differs, so a plan
 * that gets this far has already been checked once; this is the second, cheap statement of the same law, at the
 * place that consumes it.
 */
export function unitCollectionOrder(
  unitIds: readonly string[],
  documents: readonly { readonly documentId: string; readonly authoringOrder: readonly string[] }[]
): readonly string[] {
  const order = [...documents]
    .sort((a, b) => compareUnitIds(a.documentId, b.documentId))
    .flatMap((document) => [...document.authoringOrder]);
  if (order.length !== unitIds.length || new Set(order).size !== unitIds.length) {
    throw new Error(`The recorded authoring order covers ${new Set(order).size} of this plan's ${unitIds.length} unit(s); a unit missing from the order would be skipped by collect without anything saying so`);
  }
  const known = new Set(unitIds);
  for (const unitId of order) {
    if (!known.has(unitId)) throw new Error(`The recorded authoring order names ${JSON.stringify(unitId)}, which is not a unit of this plan`);
  }
  return order;
}

/**
 * The plan row for one unit id, or a named refusal.
 *
 * "Not in the plan" and "not a unit at all" are one message on purpose: from the writer's side they are the same
 * fact — the plan does not give this run a unit by that name — and the plan is the thing to fix either way.
 */
export function planUnit(view: UnitPlanView, unitId: string): PlanCatalogUnit {
  const unit = view.byId.get(unitId);
  if (!unit) {
    throw new Error(`Unknown authoring unit ${JSON.stringify(unitId)}; this run's validated plan holds ${view.units.length} unit(s): ${view.units.map((row) => row.unitId).join(", ")}`);
  }
  return unit;
}
