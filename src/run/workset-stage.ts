import { join } from "node:path";
import { built, unavailable, type ArtifactResult } from "../base/artifact-result.ts";
import type { CollectedFeatureFactPack, EvidenceItem, FeatureFactPack } from "../base/types.ts";
import { atomicWrite, writeJson } from "../base/util.ts";
import { attributionContentDigest, type AttributionArtifact } from "../attribution/attribution-artifact.ts";
import { computeCrossFeatureRelationships, renderCrossFeatureSection, type CrossFeatureRelationships } from "../context/cross-feature.ts";
import type { BoundaryFunctionsArtifact } from "../facts/probe/boundary-functions.ts";
import type { ProducerFactSet } from "../facts/envelope.ts";
import { unitsRowSet, type UnitsArtifact } from "../facts/units/units-artifact.ts";
import { countedRowSet, type FileLedger } from "../snapshot/file-ledger.ts";
import { annotateFactPack } from "../workset/factpack-annotate.ts";
import { factPackEvidence, renderFactPackSection } from "../workset/factpack-view.ts";
import {
  buildOverviewCensus, buildScopeCensus, unavailableScopeCensus,
  type OverviewCensusV2, type ScopeCensusV2
} from "../workset/census.ts";
import { buildReadSpecs, type ReadSpecsArtifact } from "../workset/read-specs.ts";
import { renderWorksetView } from "../workset/workset-view.ts";

export interface WorksetStageInput {
  readonly collected: ReadonlyMap<string, CollectedFeatureFactPack>;
  readonly attribution: ArtifactResult<AttributionArtifact>;
  readonly units: ArtifactResult<UnitsArtifact>;
  readonly producers: Readonly<Record<string, ArtifactResult<ProducerFactSet>>>;
  readonly ledger: FileLedger;
  readonly boundaryFunctions: BoundaryFunctionsArtifact;
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
  readonly scopeCensuses: ReadonlyMap<string, ArtifactResult<ScopeCensusV2>>;
  readonly overviewCensus: ArtifactResult<OverviewCensusV2>;
  readonly readSpecs: ArtifactResult<ReadSpecsArtifact>;
  readonly view: string;
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
  const files = countedRowSet(input.ledger);
  const overviewCensus = built(buildOverviewCensus(input.ledger, files));
  const scopeCensuses = new Map<string, ArtifactResult<ScopeCensusV2>>();
  for (const feature of [...input.features].sort((a, b) => a.key.localeCompare(b.key))) {
    if (input.units.status !== "built") {
      const cause = input.units.status === "unavailable" ? input.units.cause : `units are not applicable: ${input.units.determination}`;
      scopeCensuses.set(feature.key, built(unavailableScopeCensus(feature.key, files, cause, input.units.status === "unavailable" && input.units.retryable)));
      continue;
    }
    if (input.attribution.status !== "built") {
      const cause = input.attribution.status === "unavailable" ? input.attribution.cause : `attribution is not applicable: ${input.attribution.determination}`;
      scopeCensuses.set(feature.key, built(unavailableScopeCensus(feature.key, files, cause, input.attribution.status === "unavailable" && input.attribution.retryable)));
      continue;
    }
    scopeCensuses.set(feature.key, built(buildScopeCensus({
      featureKey: feature.key,
      files,
      ledger: input.ledger,
      partition: unitsRowSet(input.units.value),
      units: input.units.value,
      attribution: input.attribution.value,
      attributionDigest: attributionContentDigest(input.attribution.value)
    })));
  }
  const readSpecs: ArtifactResult<ReadSpecsArtifact> = input.units.status === "built"
    ? built(buildReadSpecs({ factPacks, boundaryFunctions: input.boundaryFunctions, units: input.units.value }))
    : unavailable("ReadSpecs require the units artifact so every copied UnitId names this run's partition", input.units.status === "unavailable" && input.units.retryable);
  const view = renderWorksetView({ readSpecs, overviewCensus, scopeCensuses });
  return {
    factPacks,
    evidence,
    featureSections,
    crossFeature,
    crossFeatureSection: features.length >= 2 ? renderCrossFeatureSection(crossFeature) : "",
    scopeCensuses,
    overviewCensus,
    readSpecs,
    view
  };
}

export async function writeWorksetStage(runDir: string, stage: WorksetStageResult): Promise<void> {
  for (const [key, pack] of [...stage.factPacks.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await writeJson(join(runDir, "context", "features", `${key}.factpack.json`), pack);
  }
  for (const [key, census] of [...stage.scopeCensuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await writeJson(join(runDir, "context", `${key}.scope-census.json`), census);
  }
  await writeJson(join(runDir, "context", "overview-census.json"), stage.overviewCensus);
  await writeJson(join(runDir, "workset", "read-specs.json"), stage.readSpecs);
  await atomicWrite(join(runDir, "context", "workset.md"), stage.view);
}

/** Failure-path writer: every enforced layer-5 instance still gets the one shared ArtifactResult envelope. */
export async function writeUnavailableWorksetStage(runDir: string, featureKeys: readonly string[], cause: string, retryable: boolean): Promise<void> {
  const result = unavailable(cause, retryable);
  for (const key of [...featureKeys].sort()) await writeJson(join(runDir, "context", `${key}.scope-census.json`), result);
  await writeJson(join(runDir, "context", "overview-census.json"), result);
  await writeJson(join(runDir, "workset", "read-specs.json"), result);
}
