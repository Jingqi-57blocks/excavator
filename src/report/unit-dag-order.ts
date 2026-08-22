/**
 * The authoring order of one unit set, and the document roots it implies — two pure readings over a proposal's
 * units and nothing else.
 *
 * WHY THEY LIVE IN THEIR OWN FILE. Both were `plan-validation.ts`'s, and `plan-artifacts.ts` imported them from
 * there. That edge is what stopped validation from ever MEASURING a packet: measuring one means rendering it,
 * rendering one means holding a plan catalog, and `plan-validation -> … -> plan-artifacts -> plan-validation` is a
 * cycle `tests/layer-order.test.ts` refuses by name (a cycle means two files are one unit that cannot be layered).
 * Moving the two functions down here breaks the cycle at its narrowest point instead of duplicating either of
 * them: one spelling of "children before parents", one spelling of "which unit is a root", read by both files.
 */

import { unitChildIds, type ProposedUnit } from "./plan-proposal.ts";

export type UnitDagOrder =
  | { readonly state: "acyclic"; readonly order: readonly string[] }
  | { readonly state: "cyclic"; readonly cycle: readonly string[] };

/**
 * The authoring order, or the cycle that stops one existing.
 *
 * Children before parents, ascending by unit id among the ready ones, so the order is a pure function of the unit
 * set. A child id no unit declares is IGNORED here — it is already a named reference problem, and treating it as
 * an unsatisfiable dependency would report a phantom cycle instead.
 */
export function unitDagOrder(units: readonly ProposedUnit[]): UnitDagOrder {
  const byId = new Map(units.map((unit) => [unit.unitId, unit]));
  const childrenOf = (unit: ProposedUnit): string[] => unitChildIds(unit).filter((id) => byId.has(id) && id !== unit.unitId);
  const emitted = new Set<string>();
  const order: string[] = [];
  const remaining = [...byId.keys()].sort((a, b) => a.localeCompare(b));
  let progress = true;
  while (progress) {
    progress = false;
    for (const unitId of remaining) {
      if (emitted.has(unitId)) continue;
      if (!childrenOf(byId.get(unitId)!).every((child) => emitted.has(child))) continue;
      emitted.add(unitId);
      order.push(unitId);
      progress = true;
    }
  }
  if (emitted.size === byId.size) return { state: "acyclic", order };
  return { state: "cyclic", cycle: findCycle(byId, childrenOf) ?? remaining.filter((id) => !emitted.has(id)) };
}

/** One concrete cycle, so the failure names a path a reader can follow instead of a set of suspects. */
function findCycle(byId: ReadonlyMap<string, ProposedUnit>, childrenOf: (unit: ProposedUnit) => string[]): string[] | null {
  const state = new Map<string, "open" | "closed">();
  const stack: string[] = [];
  const walk = (unitId: string): string[] | null => {
    const seen = state.get(unitId);
    if (seen === "closed") return null;
    if (seen === "open") return [...stack.slice(stack.indexOf(unitId)), unitId];
    state.set(unitId, "open");
    stack.push(unitId);
    for (const child of childrenOf(byId.get(unitId)!)) {
      const cycle = walk(child);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(unitId, "closed");
    return null;
  };
  for (const unitId of [...byId.keys()].sort((a, b) => a.localeCompare(b))) {
    const cycle = walk(unitId);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Every unit of one document that no unit of that document names as a child, ascending.
 *
 * Exactly one is what a document assembles from; zero or several is a named problem at the two call sites. It is
 * derived rather than declared for the same reason the budget is: a plan that stated its own root could name one
 * that nothing hangs off.
 */
export function documentRootUnitIds(units: readonly ProposedUnit[], documentId: string): readonly string[] {
  const inDocument = units.filter((unit) => unit.documentId === documentId);
  const named = new Set(inDocument.flatMap((unit) => unitChildIds(unit)));
  return inDocument.map((unit) => unit.unitId).filter((unitId) => !named.has(unitId)).sort((a, b) => a.localeCompare(b));
}
