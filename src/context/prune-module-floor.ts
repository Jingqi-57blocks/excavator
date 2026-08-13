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

import { pruneFeatureGraph, rescueSignalsFor, dedupeEdges, NAME_TOKEN_EXACT } from "./feature-prune.ts";
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
 * Prune a feature graph with the module-local strong-rescue floor applied on top of the global prune.
 *
 * moduleCount <= 1 (single module, or a namespace-free pool) is a provable no-op: it returns
 * `pruneFeatureGraph` verbatim. Otherwise the global result is computed first (unchanged); then, per
 * module in sorted id order, the module's OWN sub-pool is pruned alone and each of its Stage-2
 * rescues whose (name, total) signals clear the strong-rescue gate and that is missing from the
 * global result is added back (annotated via the existing `rescued` field, "module-floor: <reason>").
 * The retained edge set is recomputed over the union with the same semantics as the global prune.
 */
export function pruneFeatureGraphWithModuleFloor(
  nodes: any[],
  edges: any[],
  seeds: any[],
  anchorTerms: string[],
  maxNodes: number
): { nodes: any[]; edges: any[] } {
  const modules = new Set<string>();
  for (const node of nodes) modules.add(moduleOf(String(node.id)));
  // Single module (or no namespace at all): the global prune already decides the whole pool.
  if (modules.size <= 1) return pruneFeatureGraph(nodes, edges, seeds, anchorTerms, maxNodes);

  const base = pruneFeatureGraph(nodes, edges, seeds, anchorTerms, maxNodes);
  const baseIds = new Set(base.nodes.map((node) => String(node.id)));

  const added: any[] = [];
  const addedIds = new Set<string>();
  for (const moduleId of [...modules].sort(compareStr)) {
    const subNodes = nodes.filter((node) => moduleOf(String(node.id)) === moduleId);
    const subNodeIds = new Set(subNodes.map((node) => String(node.id)));
    // Induced sub-pool: edges/seeds that live entirely inside this module. Pre-dedupe the edges so
    // the signals recomputed below match the module-local prune's own internal (deduped) scoring.
    const subEdges = dedupeEdges(edges.filter((edge) => subNodeIds.has(String(edge.source)) && subNodeIds.has(String(edge.target))));
    const subSeeds = seeds.filter((seed) => moduleOf(String(seed.id)) === moduleId);

    const localPruned = pruneFeatureGraph(subNodes, subEdges, subSeeds, anchorTerms, maxNodes);
    const signals = rescueSignalsFor(subNodes, subEdges, anchorTerms);
    // Module-local rescues, in the module-local rescue order (the order pruneFeatureGraph appended them).
    for (const node of localPruned.nodes) {
      if (typeof node.rescued !== "string") continue; // only Stage-2 rescues carry `rescued`
      const id = String(node.id);
      const signal = signals.get(id);
      if (!signal || !(signal.name > 0 && signal.total > NAME_TOKEN_EXACT)) continue; // strong-rescue gate
      if (baseIds.has(id) || addedIds.has(id)) continue; // already retained globally, or already floored
      addedIds.add(id);
      added.push({ ...node, rescued: `module-floor: ${node.rescued}` });
    }
  }

  // Additive: nothing floored -> the global result is returned untouched (byte-identical).
  if (!added.length) return base;

  const unionNodes = [...base.nodes, ...added];
  const ids = new Set(unionNodes.map((node) => String(node.id)));
  return { nodes: unionNodes, edges: dedupeEdges(edges).filter((edge) => ids.has(String(edge.source)) && ids.has(String(edge.target))) };
}
