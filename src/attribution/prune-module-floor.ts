// Module-local strong-rescue floor for the feature-graph prune (57B-377).
//
// The global prune (feature-prune.ts) spends one shared rescue quota across the WHOLE candidate
// pool. When the pool spans several modules (e.g. adding a frontend CodeGraph makes wcp-ui a graph-
// set member), a module's high-scoring rescue candidates can crowd another module's rightful rescue
// out of that shared quota — backend `syncLvCompleted` was displaced by frontend route/component
// nodes and fell out of scope (boundary-gold 13/13 -> 12/13).
//
// The fix is additive and module-locally decided: the global prune runs BYTE-UNCHANGED, then a node
// that (i) WOULD be rescued when its OWN module is pruned alone and (ii) carries strong rescue
// signals (name > 0 AND total > NAME_TOKEN_EXACT) may not be displaced by other modules' candidates
// — if it is absent from the global result it is added back. Adding zero nodes returns the global
// result unchanged (proven byte-identical for existing single-/multi-module pools).
//
// Framework-neutral and target-agnostic: module identity is ONLY the id's NUL-namespace prefix
// (the CodeGraphSet ID_SEPARATOR), never a "ui"/"frontend"/"tsx"/business token. Zero npm
// dependency, zero model, deterministic.

import { pruneFeatureGraphRecorded, rescueSignalsFor, dedupeEdges, NAME_TOKEN_EXACT, type RecordedPrune } from "./feature-prune.ts";
import type { FloorDecision, SelectionChannel, TraceNode } from "./selection-trace.ts";
import { ID_SEPARATOR } from "../codegraph/codegraph-set.ts";

/** The module a namespaced node id belongs to: the prefix before the NUL separator, or "" (a single
 *  implicit module) when the id carries no namespace. This is the ONLY source of module identity. */
function moduleOf(id: string): string {
  const index = id.indexOf(ID_SEPARATOR);
  return index < 0 ? "" : id.slice(0, index);
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Prune a feature graph with the module-local strong-rescue floor applied on top of the global prune, AND
 * record every decision the floor made — including the ones that added nothing.
 *
 * moduleCount <= 1 (single module, or a namespace-free pool) is a provable no-op: it returns the global prune
 * verbatim, and records `no-op-single-module` rather than an empty decision list, because "the floor did not run"
 * and "the floor ran and found nothing" are the two facts P15 says a mechanism must be able to tell apart.
 * Otherwise the global result is computed first (unchanged); then, per module in sorted id order, the module's
 * OWN sub-pool is pruned alone and each of its Stage-2 rescues whose (name, total) signals clear the strong-rescue
 * gate and that is missing from the global result is added back (annotated via the existing `rescued` field,
 * "module-floor: <reason>"). The retained edge set is recomputed over the union with the same semantics as the
 * global prune.
 *
 * The module-local sub-prunes produce traces of their own and those are DISCARDED on purpose: they are decisions
 * about a hypothetical pool that was never this feature's selection, and publishing them would put candidates
 * into the channel census that no seat was ever available to.
 */
export function pruneFeatureGraphWithModuleFloorRecorded(
  nodes: any[],
  edges: any[],
  seeds: any[],
  anchorTerms: string[],
  maxNodes: number
): RecordedPrune {
  const modules = new Set<string>();
  for (const node of nodes) modules.add(moduleOf(String(node.id)));
  // Single module (or no namespace at all): the global prune already decides the whole pool.
  if (modules.size <= 1) {
    const only = pruneFeatureGraphRecorded(nodes, edges, seeds, anchorTerms, maxNodes);
    return withFloor(only, [{ decision: "no-op-single-module", moduleCount: modules.size }], new Set());
  }

  const base = pruneFeatureGraphRecorded(nodes, edges, seeds, anchorTerms, maxNodes);
  const baseIds = new Set(base.nodes.map((node) => String(node.id)));

  const added: any[] = [];
  const addedIds = new Set<string>();
  const decisions: FloorDecision[] = [];
  for (const moduleId of [...modules].sort(compareStr)) {
    const subNodes = nodes.filter((node) => moduleOf(String(node.id)) === moduleId);
    const subNodeIds = new Set(subNodes.map((node) => String(node.id)));
    // Induced sub-pool: edges/seeds that live entirely inside this module. Pre-dedupe the edges so
    // the signals recomputed below match the module-local prune's own internal (deduped) scoring.
    const subEdges = dedupeEdges(edges.filter((edge) => subNodeIds.has(String(edge.source)) && subNodeIds.has(String(edge.target))));
    const subSeeds = seeds.filter((seed) => moduleOf(String(seed.id)) === moduleId);

    const localPruned = pruneFeatureGraphRecorded(subNodes, subEdges, subSeeds, anchorTerms, maxNodes);
    const signals = rescueSignalsFor(subNodes, subEdges, anchorTerms);
    const addedHere: string[] = [];
    // Module-local rescues, in the module-local rescue order (the order pruneFeatureGraph appended them).
    for (const node of localPruned.nodes) {
      if (typeof node.rescued !== "string") continue; // only Stage-2 rescues carry `rescued`
      const id = String(node.id);
      const signal = signals.get(id);
      if (!signal || !(signal.name > 0 && signal.total > NAME_TOKEN_EXACT)) continue; // strong-rescue gate
      if (baseIds.has(id) || addedIds.has(id)) continue; // already retained globally, or already floored
      addedIds.add(id);
      addedHere.push(id);
      added.push({ ...node, rescued: `module-floor: ${node.rescued}` });
    }
    // Recorded for every module, `added: []` included: the empty decision is the one that says the floor
    // looked and had nothing to recover, which is the difference between a no-op and an absence.
    decisions.push({ decision: "module-evaluated", moduleId, added: addedHere });
  }

  // Additive: nothing floored -> the global result is returned untouched (byte-identical).
  if (!added.length) return withFloor(base, decisions, addedIds);

  const unionNodes = [...base.nodes, ...added];
  const ids = new Set(unionNodes.map((node) => String(node.id)));
  return withFloor({
    nodes: unionNodes,
    edges: dedupeEdges(edges).filter((edge) => ids.has(String(edge.source)) && ids.has(String(edge.target))),
    trace: base.trace
  }, decisions, addedIds);
}

/**
 * Fold the floor's decisions into the global trace: floored nodes were `displaced` in it and are now seated.
 *
 * Rewriting the outcome rather than appending a second list is what keeps the channel census a PARTITION of the
 * pool. Two lists would let a node be counted as displaced and as floored at once, and the seat conservation
 * downstream would still balance — the failure mode slice 4 named, where an identity collapse survives every
 * conservation check because the sum is taken after the collapse.
 */
function withFloor(pruned: RecordedPrune, decisions: readonly FloorDecision[], floored: ReadonlySet<string>): RecordedPrune {
  const pool: TraceNode[] = pruned.trace.pool.map((node) => floored.has(node.nodeId)
    ? { ...node, outcome: "module-floor" as SelectionChannel, displacedBy: null }
    : node);
  return { nodes: pruned.nodes, edges: pruned.edges, trace: { ...pruned.trace, pool, floorDecisions: [...decisions] } };
}

/**
 * The trace-free floor: `pruneFeatureGraphWithModuleFloorRecorded` with the record dropped.
 *
 * A shell with no logic of its own, so the 57B-377 frozen real-pool gates in `eval/tests/module-floor.test.ts`
 * exercise the recorded path directly rather than a second copy of it.
 */
export function pruneFeatureGraphWithModuleFloor(
  nodes: any[],
  edges: any[],
  seeds: any[],
  anchorTerms: string[],
  maxNodes: number
): { nodes: any[]; edges: any[] } {
  const pruned = pruneFeatureGraphWithModuleFloorRecorded(nodes, edges, seeds, anchorTerms, maxNodes);
  return { nodes: pruned.nodes, edges: pruned.edges };
}
