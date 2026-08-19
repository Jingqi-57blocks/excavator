import type { ArtifactResult } from "../base/artifact-result.ts";
import type { AttributionArtifact } from "./attribution-artifact.ts";

/**
 * Layer 4's seed cells, shaped as layer 5's input.
 *
 * It exists as its own file because it is the ONE place the L4 → L5 seed join happens. That join was missing
 * entirely: `run.ts` passed an explicit empty set per feature with the comment "until attribution records seed
 * identity", so `factpack-annotate.ts`'s `{ kind: "seeded", basis: "explicit-seed" }` branch was live code that
 * no production run could reach and `relations.seeded` was structurally zero on every report ever produced.
 *
 * The objection that comment recorded — deriving seed identity in `run.ts` would create a second join — was
 * right, and this is the answer to it rather than a way around it: layer 4 is the single writer of seed
 * identity, and this function only reads what layer 4 published. Nothing here re-derives, re-matches, or
 * consults the feature graph.
 */
export function seedCellsByFeature(
  attribution: ArtifactResult<AttributionArtifact>,
  featureKeys: readonly string[]
): Map<string, ReadonlySet<string>> {
  const published = new Map<string, ReadonlySet<string>>();
  if (attribution.status === "built") {
    for (const selection of attribution.value.selections) {
      published.set(selection.featureKey, new Set(selection.seedCells));
    }
  }
  // EVERY requested key gets an entry, including on the unavailable and channel-unavailable paths. The workset
  // stage throws when a key is missing, and that throw is a live tripwire for "a feature silently lost its
  // working set" — returning a short map would convert it into an unrelated crash, and returning nothing at all
  // would let a feature vanish. An empty set is the written answer: this feature seated no query seed.
  const out = new Map<string, ReadonlySet<string>>();
  for (const key of featureKeys) out.set(key, published.get(key) ?? new Set<string>());
  return out;
}
