import { join } from "node:path";
import type { ArtifactResult } from "../base/artifact-result.ts";
import type { CollectedFeatureFactPack, EvidenceItem, FeatureFactPack } from "../base/types.ts";
import { writeJson } from "../base/util.ts";
import type { AttributionArtifact } from "../attribution/attribution-artifact.ts";
import { computeCrossFeatureRelationships, renderCrossFeatureSection, type CrossFeatureRelationships } from "../context/cross-feature.ts";
import type { ProducerFactSet } from "../facts/envelope.ts";
import type { UnitsArtifact } from "../facts/units/units-artifact.ts";
import { annotateFactPack } from "../workset/factpack-annotate.ts";
import { factPackEvidence, renderFactPackSection } from "../workset/factpack-view.ts";

export interface WorksetStageInput {
  readonly collected: ReadonlyMap<string, CollectedFeatureFactPack>;
  readonly attribution: ArtifactResult<AttributionArtifact>;
  readonly units: ArtifactResult<UnitsArtifact>;
  readonly producers: Readonly<Record<string, ArtifactResult<ProducerFactSet>>>;
  /** Required; production passes one explicit empty set per feature until attribution records seed identity. */
  readonly seedCellsByFeature: ReadonlyMap<string, ReadonlySet<string>>;
  readonly features: readonly { readonly key: string; readonly subject: string; readonly files: readonly string[] }[];
}

export interface WorksetStageResult {
  readonly factPacks: ReadonlyMap<string, FeatureFactPack>;
  readonly evidence: readonly EvidenceItem[];
  readonly featureSections: ReadonlyMap<string, string>;
  readonly crossFeature: CrossFeatureRelationships;
  readonly crossFeatureSection: string;
}

/** Layer-5 orchestration after layer 4: annotate once, then derive every consumer from the same v2 packs. */
export function buildWorksetStage(input: WorksetStageInput): WorksetStageResult {
  const factPacks = new Map<string, FeatureFactPack>();
  const evidence: EvidenceItem[] = [];
  const featureSections = new Map<string, string>();
  for (const key of [...input.collected.keys()].sort()) {
    const collected = input.collected.get(key)!;
    if (!input.seedCellsByFeature.has(key)) throw new Error(`Workset stage has no explicit seed set for feature ${JSON.stringify(key)}`);
    const pack = annotateFactPack({
      pack: collected,
      attribution: input.attribution,
      units: input.units,
      producers: input.producers,
      seedCells: input.seedCellsByFeature.get(key)!
    });
    factPacks.set(key, pack);
    evidence.push(...factPackEvidence(pack));
    featureSections.set(key, renderFactPackSection(pack));
  }
  const features = input.features.map((feature) => {
    const factPack = factPacks.get(feature.key);
    if (!factPack) throw new Error(`Workset stage has no fact pack for feature ${JSON.stringify(feature.key)}`);
    return { key: feature.key, subject: feature.subject, files: [...feature.files], factPack };
  });
  const crossFeature = computeCrossFeatureRelationships(features);
  return {
    factPacks,
    evidence,
    featureSections,
    crossFeature,
    crossFeatureSection: features.length >= 2 ? renderCrossFeatureSection(crossFeature) : ""
  };
}

export async function writeWorksetStage(runDir: string, stage: WorksetStageResult): Promise<void> {
  for (const [key, pack] of [...stage.factPacks.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await writeJson(join(runDir, "context", "features", `${key}.factpack.json`), pack);
  }
}
