/**
 * THE TREE LAW: a unit is named as a child by AT MOST ONE unit.
 *
 * WHY IT IS A SEPARATE CHECK FROM "ONE ROOT PER DOCUMENT". `documentRootUnitIds` counts the units NO unit names as
 * a child, and exactly one of those is what a document assembles from. That is a check on the set of named
 * children, so it is blind to how many times a name appears in it: a proposal where two syntheses both name the
 * same leaf still has one root and still passes. Measured on the shape it lets through — one leaf, two parents —
 * every downstream consumer silently picks one: `assemblyUnitsInOrder` places the child under whichever parent it
 * reaches first, the contents table nests it once, and the other parent's `childSummaryDigests` names a child that
 * does not appear beneath it.
 *
 * WHY A TREE AND NOT A DAG, stated because the epic's own vocabulary is "Authoring DAG". The DAG is about
 * DEPENDENCY — a synthesis may not depend on a unit that depends on it — and it is checked as such by
 * `unitDagOrder`. The DOCUMENT is a tree: collection order, the contents table, the heading depth and every
 * `childSummaryDigest` assume one parent per unit, and no epic scenario asks for a unit to be written into two
 * places at once — a topic more than one place needs is handled by the `referenced` TOPIC DISPOSITION (one unit is
 * its primary owner, the others cite it), not by giving one unit two parents. So the acyclicity check and this one
 * are two different laws and neither implies the other.
 *
 * IT IS THE FIRST OF TWO DEFENCES, ON PURPOSE. `parentUnitIdByChild` refuses the same shape at assembly time, over
 * the RECORDED dag edges rather than over a proposal. Keeping both means a hand-edited `plan/dag.json` is still
 * refused, and a bad proposal is refused before anything is written — two different inputs, so removing either
 * leaves a reachable hole.
 *
 * Pure: no I/O, no model call, ascending output.
 */

import { unitChildIds, type ProposedUnit } from "./plan-proposal.ts";

/**
 * One named problem per over-parented unit, ascending by child id, with every parent named.
 *
 * A unit naming the same child twice is included: that is one parent, but it is still a plan that would place the
 * unit under it twice, and the count a reader needs to see is the number of NAMINGS.
 */
export function singleParentProblems(units: readonly ProposedUnit[]): readonly string[] {
  const parentsByChild = new Map<string, string[]>();
  for (const unit of units) {
    for (const childId of unitChildIds(unit)) {
      if (childId === unit.unitId) continue; // already a named self-child problem where the references are checked
      const named = parentsByChild.get(childId);
      if (named) named.push(unit.unitId);
      else parentsByChild.set(childId, [unit.unitId]);
    }
  }
  return [...parentsByChild.entries()]
    .filter(([, parents]) => parents.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([childId, parents]) =>
      `unit ${JSON.stringify(childId)} is named as a child ${parents.length} time(s), by ${[...parents].sort((a, b) => a.localeCompare(b)).map((id) => JSON.stringify(id)).join(" and ")}; a document is a TREE — its collection order, contents table and childSummaryDigests all assume one parent per unit, so a second parent would name a child that does not appear beneath it`);
}
