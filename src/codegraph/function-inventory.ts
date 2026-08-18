import type { GraphNode } from "../base/types.ts";
import type { FactDetail, ObservedFact } from "../facts/units/membership-map.ts";
import type { UnitKind } from "../facts/units/unit-identity.ts";
import type { GraphReader } from "./codegraph.ts";

/**
 * Every function, method and class the index has a node for, over the WHOLE counted corpus.
 *
 * It is an enumeration, not a search. Every other query into the index today is scoped by a feature's terms or by
 * a pruned graph, which is precisely why the index could never be a second observer of a code unit: it was only
 * ever asked about the parts of the corpus a feature already pointed at (P17, one level down). Layer 3's facts are
 * feature-free by contract — the fifth column of §一's table says the layer-3 identity may not contain a feature
 * key — so this asks about the corpus and nothing else.
 *
 * `nodesByKindInFiles` is the query, chosen because it is the one that takes a KIND and a file list rather than a
 * scored term set. Its `limit` is a real ceiling and `CodeGraphSet` applies it per module and then slices the
 * merged result, so reaching it would silently drop whole modules. That is why `truncated` is computed and
 * published rather than assumed away: a capped enumeration is a capped denominator input, and layer 8 has to be
 * able to see it.
 */

export const FUNCTION_INVENTORY_VERSION = "function-inventory-v1";

/**
 * The node kinds this inventory claims, and the unit kind each maps to.
 *
 * `route` and `component` are deliberately absent: they are not structural declarations of a code unit, they are
 * roles played by one, and a route node and the function it points at would then be two observations of the same
 * bytes under two kinds. `variable`, `constant`, `import` and `property` are absent for the plainer reason that
 * the reference-unit vocabulary has no member for them.
 */
export const UNIT_KIND_BY_NODE_KIND: Readonly<Record<string, UnitKind>> = {
  "class": "class",
  "function": "function",
  "method": "method"
};

export const INVENTORY_NODE_KINDS: readonly string[] = Object.keys(UNIT_KIND_BY_NODE_KIND).sort();

/**
 * The declared query ceiling. Generous rather than tuned: the largest index measured here holds 11,279 function
 * nodes, so 50,000 is not a bound anything real reaches — and if something does, `truncated` says so instead of
 * the inventory quietly becoming a sample.
 */
export const FUNCTION_INVENTORY_LIMIT = 50_000;

export interface InventoryFunction {
  readonly factId: string;
  readonly unitKind: UnitKind;
  readonly nodeKind: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly relativePath: string;
  readonly language: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface FunctionInventory {
  readonly version: typeof FUNCTION_INVENTORY_VERSION;
  readonly functions: readonly InventoryFunction[];
  readonly completeness: {
    readonly filesQueried: number;
    readonly nodeKinds: readonly string[];
    readonly limit: number;
    readonly returned: number;
    /** True when the query came back at its ceiling, so nodes past it are unknown rather than absent. */
    readonly truncated: boolean;
    /** Nodes the index reported with no usable line range; kept as a number so the loss is not silent. */
    readonly withoutLineRange: number;
  };
}

/**
 * Enumerate the index's structural declarations over one file list.
 *
 * `relativePaths` is the layer-1 counted set, handed in rather than read from the index: asking the index which
 * files it contains would be the mechanism reporting its own coverage, which layer 2's contract forbids as an
 * input. Nodes for files outside the counted set are dropped here — the index may have been built over a wider
 * tree — and they cannot become facts because they have no partition cell to belong to.
 */
export function functionInventory(reader: GraphReader, relativePaths: readonly string[], limit = FUNCTION_INVENTORY_LIMIT): FunctionInventory {
  const counted = new Set(relativePaths);
  const nodes = reader.nodesByKindInFiles([...INVENTORY_NODE_KINDS], [...counted], limit);
  const functions: InventoryFunction[] = [];
  const used = new Map<string, number>();
  let withoutLineRange = 0;
  for (const node of nodes) {
    const unitKind = UNIT_KIND_BY_NODE_KIND[node.kind];
    if (unitKind === undefined || !counted.has(node.filePath)) continue;
    if (!usableLines(node)) { withoutLineRange += 1; continue; }
    functions.push({
      factId: factId(used, node, unitKind),
      unitKind,
      nodeKind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      relativePath: node.filePath,
      language: node.language,
      startLine: node.startLine,
      endLine: node.endLine
    });
  }
  return {
    version: FUNCTION_INVENTORY_VERSION,
    functions: functions.sort((a, b) => a.factId.localeCompare(b.factId)),
    completeness: {
      filesQueried: counted.size,
      nodeKinds: [...INVENTORY_NODE_KINDS],
      limit,
      returned: nodes.length,
      truncated: nodes.length >= limit,
      withoutLineRange
    }
  };
}

/** An index row with no line range cannot be anchored, so it is counted rather than given a made-up line. */
function usableLines(node: { readonly startLine: number; readonly endLine: number }): boolean {
  return Number.isInteger(node.startLine) && node.startLine >= 1 && Number.isInteger(node.endLine) && node.endLine >= node.startLine;
}

/**
 * A stable, readable fact id, derived from the node's OWN coordinates rather than from its database id.
 *
 * The database id is per-module and `CodeGraphSet` namespaces it with a NUL byte, which has no business in a
 * published artifact. Repeats — two nodes the index reports at the same place under the same name — get a
 * deterministic suffix rather than being deduplicated, because the query order is fixed and dropping one would
 * make the count depend on the coincidence.
 */
function factId(used: Map<string, number>, node: GraphNode, unitKind: UnitKind): string {
  const base = inventoryFactIdBase(node, unitKind);
  const seen = (used.get(base) ?? 0) + 1;
  used.set(base, seen);
  return seen === 1 ? base : `${base}#${seen}`;
}

function inventoryFactIdBase(node: { readonly filePath: string; readonly startLine: number; readonly endLine: number; readonly name: string }, unitKind: UnitKind): string {
  return `${unitKind}:${node.filePath}:${node.startLine}-${node.endLine}:${node.name}`;
}

/** The unit kind this inventory claims for an index node kind, or `null` when it claims none. */
export function inventoryUnitKind(nodeKind: string): UnitKind | null {
  return UNIT_KIND_BY_NODE_KIND[nodeKind] ?? null;
}

/**
 * The fact id this inventory WOULD mint for one index node, or `null` when it would mint none.
 *
 * Exported because layer 4 has to find the fact row a retained graph node corresponds to, and the only
 * alternative — re-matching by path and span downstream — is the second mapping algorithm §一 forbids the
 * consumer to own. There is exactly one encoder of this id and this is it; a caller gets the BASE id (no repeat
 * suffix), because a caller holding one node cannot know how many other nodes share its coordinates.
 *
 * `null` covers both ways a node fails to become a fact: a kind the inventory does not claim, and a node the
 * index reported with no usable line range. Both are states the caller must be able to see rather than infer.
 */
export function inventoryFactIdFor(node: {
  readonly kind: string;
  readonly filePath: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly name: string;
}): string | null {
  const unitKind = inventoryUnitKind(node.kind);
  if (unitKind === null) return null;
  if (!usableLines({ startLine: node.startLine ?? -1, endLine: node.endLine ?? -1 })) return null;
  return inventoryFactIdBase({ filePath: node.filePath, startLine: node.startLine!, endLine: node.endLine!, name: node.name }, unitKind);
}

/**
 * The base id of a published fact id: the repeat suffix removed.
 *
 * The suffix format has one owner and it is this file, so a consumer joining on base ids reads it back through
 * here rather than re-implementing `#N` splitting — which is how two readers of one format start disagreeing.
 */
export function inventoryFactIdBaseOf(factId: string): string {
  const hash = factId.lastIndexOf("#");
  return hash > 0 && /^[0-9]+$/.test(factId.slice(hash + 1)) ? factId.slice(0, hash) : factId;
}

/**
 * The inventory as observations for the membership mapper.
 *
 * Both ends of the line range travel, which is what makes the index the one producer that can mint a
 * `reported-span` reference unit where the designated builder is `file-level` — a Python function on a Perl
 * target has no skeleton node, and its span is real even though no builder produced it.
 */
export function inventoryObservations(inventory: FunctionInventory): ObservedFact[] {
  return inventory.functions.map((entry) => ({
    factId: entry.factId,
    kind: "indexed-function" as const,
    anchors: [{
      relativePath: entry.relativePath,
      startLine: entry.startLine,
      endLine: entry.endLine,
      unitKind: entry.unitKind
    }],
    detail: {
      name: entry.name,
      qualifiedName: entry.qualifiedName,
      nodeKind: entry.nodeKind,
      language: entry.language,
      startLine: entry.startLine,
      endLine: entry.endLine
    } satisfies FactDetail
  }));
}
