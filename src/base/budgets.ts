import type { Audience, BudgetConfig, FeatureRequest } from "./types.ts";

const MAX_PREPARE_MS = 3_600_000;

// Documents, not audiences, drive evidence volume: every audience of every requested
// report reads the same shared context but adds its own feature and source demand.
export function plannedDocumentCount(overviewAudiences: Audience[], features: FeatureRequest[]): number {
  return overviewAudiences.length + features.reduce((total, feature) => total + feature.audiences.length, 0);
}

export function deriveDefaultBudgets(documentCount: number, featureCount: number): BudgetConfig {
  const documents = Math.max(0, Math.trunc(documentCount));
  const features = Math.max(0, Math.trunc(featureCount));
  return {
    prepareMs: Math.min(MAX_PREPARE_MS, 180_000 + 120_000 * features),
    authorMs: 2_400_000,
    maxGraphQueries: 60 + 80 * features,
    maxSourceWindows: 150 + 150 * documents,
    maxSourceCharacters: 300_000 + 700_000 * documents,
    maxFiles: 100_000,
    maxFeatureNodes: 220,
    maxExpansionDepth: 2
  };
}
