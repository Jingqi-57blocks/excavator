import { membershipCells } from "../base/fact-kind-registry.ts";
import type { FactPackItem } from "../base/types.ts";

/** The already-existing authorization as seen by layer 7; it carries resolved cells and no source text. */
export interface ExistingReadSpecCoverage {
  readonly readSpecId: string;
  readonly coveredUnitIds: readonly string[];
}

export interface ColocatedPromotionRequest {
  readonly item: FactPackItem;
  readonly readSpecs: readonly ExistingReadSpecCoverage[];
  readonly judge: string;
  readonly evidenceId: string;
}

export type ColocatedPromotionResult =
  | {
    readonly status: "accepted";
    readonly judgement: {
      readonly item: { readonly category: string; readonly name: string; readonly filePath: string; readonly line: number };
      readonly readSpecId: string;
      readonly coveredUnitId: string;
      readonly judge: string;
      readonly evidenceId: string;
    };
  }
  | { readonly status: "rejected"; readonly reason: "item-not-co-located" | "item-has-no-membership" | "no-independent-read-spec" };

/**
 * The only reverse promotion door. It is pure and returns a layer-7 judgement; it cannot alter the fact pack,
 * attribution or ReadSpec. A co-located item with no independently authorized cell remains rejected.
 */
export function promoteColocated(input: ColocatedPromotionRequest): ColocatedPromotionResult {
  if (input.item.relation.kind !== "co-located") return { status: "rejected", reason: "item-not-co-located" };
  if (!input.item.membership.joined) return { status: "rejected", reason: "item-has-no-membership" };
  if (!input.judge.trim()) throw new Error("A co-located promotion requires a named judge");
  if (!input.evidenceId.trim()) throw new Error("A co-located promotion requires the evidence id produced by the independent read");

  const memberCells = new Set(membershipCells(input.item.membership.joined.membership));
  const ordered = [...input.readSpecs].sort((a, b) => a.readSpecId.localeCompare(b.readSpecId));
  for (const spec of ordered) {
    if (!spec.readSpecId.trim()) throw new Error("A promotion ReadSpec coverage row requires an id");
    const covered = [...new Set(spec.coveredUnitIds)].sort().find((unitId) => memberCells.has(unitId));
    if (!covered) continue;
    return {
      status: "accepted",
      judgement: {
        item: { category: input.item.category, name: input.item.name, filePath: input.item.filePath, line: input.item.line },
        readSpecId: spec.readSpecId,
        coveredUnitId: covered,
        judge: input.judge,
        evidenceId: input.evidenceId
      }
    };
  }
  return { status: "rejected", reason: "no-independent-read-spec" };
}
