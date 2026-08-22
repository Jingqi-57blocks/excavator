/**
 * WHO ELSE HAS TO BE WRITTEN AGAIN — the one derivation of "a unit moved, so its ancestors moved too".
 *
 * WHY IT IS ITS OWN FILE. Two consumers need it and they arrived a slice apart. R6a's invalidation plan
 * (`unit-cache-plan.ts`) propagates "this child is not reusable" up to every parent that is written from it; R7c's
 * repair set (`unit-repair-set.ts`) propagates "this unit's content is defective" up the same edges for the same
 * reason — a synthesis is written from its children's summaries, so a child whose bytes change makes its parent's
 * summary a statement about bytes that no longer exist. Two implementations of that would be two answers to "who
 * must be redrawn", and the day they disagree an operator has no way to tell which one the run acted on. So the
 * predicate lives here once, and the transitive form is built out of the predicate rather than beside it.
 *
 * THE PREDICATE AND THE CLOSURE ARE THE SAME RULE AT TWO SCOPES. `blockingChildUnitIds` answers it for ONE unit
 * over its DIRECT children — which is the shape R6a needs, because its rebuild reason names the children that
 * blocked it. `ancestorClosure` answers it for a whole plan by applying that same predicate in dependency order
 * until nothing new is pulled in, which is the shape R7c needs. `tests/unit-ancestor-closure.test.ts` runs both
 * over one plan and asserts they agree: seeds with no candidate make R6a's non-reusable set exactly this closure.
 *
 * EVERY UNIT IT NAMES CARRIES WHY IT IS THERE. A seed carries no child (it was named directly); an ancestor
 * carries the direct children that pulled it in. A repair set whose rows cannot say why they are in it is a set an
 * operator has to trust rather than read, and "rebuild the leaf and its ancestors" then becomes unfalsifiable.
 *
 * IT TAKES VALUES AND IT IS TOTAL. No path, no I/O, no clock. A seed that the plan does not hold is a named
 * refusal, not a row quietly dropped: a repair set over units the plan never had would conserve over the wrong
 * denominator. A child id no unit declares is likewise refused — R3's plan validation already names that shape,
 * and treating it as a satisfied dependency here would hide it.
 */

import { compareUnitIds } from "./unit-paths.ts";

/** One unit's place in the plan's tree: itself, and the children it is written from. Empty for every leaf kind. */
export interface UnitChildEdges {
  readonly unitId: string;
  readonly childUnitIds: readonly string[];
}

/**
 * The DIRECT children of one unit that are in the moved set, ascending.
 *
 * The one spelling of R6a's `child-not-reusable` test and R7c's ancestor step. `moved` is a predicate rather than
 * a set so R6a can pass "its entry is not `reusable`" and R7c can pass "it is already in the repair set" without
 * either of them building an intermediate collection whose contents could differ from what it decided on.
 */
export function blockingChildUnitIds(childUnitIds: readonly string[], moved: (childUnitId: string) => boolean): readonly string[] {
  return [...childUnitIds].filter(moved).sort(compareUnitIds);
}

/** One unit of the closure, and why it is in it. `viaChildUnitIds` is empty exactly for a seed. */
export interface AncestorClosureRow {
  readonly unitId: string;
  /** Ascending. Empty when this unit was named directly; otherwise the direct children that pulled it in. */
  readonly viaChildUnitIds: readonly string[];
}

/**
 * The seeds and every unit written from one of them, however far up, ascending by unit id.
 *
 * The loop is the same one `deriveUnitCachePlan` runs: repeated passes over the units, admitting a unit as soon as
 * one of its direct children is already in, until a pass adds nothing. A cycle cannot make it spin — a pass that
 * adds nothing ends it — and a cycle is R3's business, not this file's.
 */
export function ancestorClosure(units: readonly UnitChildEdges[], seeds: readonly string[]): readonly AncestorClosureRow[] {
  const byId = new Map<string, UnitChildEdges>();
  for (const unit of units) {
    if (byId.has(unit.unitId)) throw new Error(`The unit edge list holds ${JSON.stringify(unit.unitId)} twice; a unit with two child lists has none`);
    byId.set(unit.unitId, unit);
  }
  for (const unit of units) {
    for (const childUnitId of unit.childUnitIds) {
      if (!byId.has(childUnitId)) {
        throw new Error(`Unit ${JSON.stringify(unit.unitId)} is written from child ${JSON.stringify(childUnitId)}, which the unit edge list does not hold; an ancestor closure over a plan that does not hold its own children would silently stop at the gap`);
      }
    }
  }
  const seeded = new Set<string>();
  for (const seed of seeds) {
    if (!byId.has(seed)) {
      throw new Error(`Unit ${JSON.stringify(seed)} was named as a repair seed, but the unit edge list does not hold it; a repair set may only name units this plan holds`);
    }
    seeded.add(seed);
  }
  const included = new Set<string>(seeded);
  for (let added = true; added;) {
    added = false;
    for (const unit of byId.values()) {
      if (included.has(unit.unitId)) continue;
      if (blockingChildUnitIds(unit.childUnitIds, (childUnitId) => included.has(childUnitId)).length === 0) continue;
      included.add(unit.unitId);
      added = true;
    }
  }
  // The `via` lists are derived AFTER membership reaches its fixpoint, never as the loop admits a unit: a parent
  // admitted by its first child in one pass would otherwise never learn about a sibling child that entered in a
  // later one, and its reason would name one of two children while the other stayed invisible.
  return [...included]
    .sort(compareUnitIds)
    .map((unitId) => ({
      unitId,
      viaChildUnitIds: seeded.has(unitId)
        ? []
        : blockingChildUnitIds(byId.get(unitId)!.childUnitIds, (childUnitId) => included.has(childUnitId))
    }));
}
