import type { AttributionArtifact, AttributionSelection } from "../../src/attribution/attribution-artifact.ts";

/**
 * Fields deliberately left out of the baseline, each with the reason it would produce a false red.
 *
 * Listed as data rather than omitted silently: a projection that just does not mention a field is
 * indistinguishable from one that forgot it, and the next person cannot tell which.
 */
export const EXCLUDED = {
  "identity.runIntentSummary.digest": "hashes the request, which carries absolute workdir paths — differs per machine and per temp dir, saying nothing about selection",
  "identity.channelInputs.codegraphEnvelopeDigest": "measured: materializing the SAME pinned corpus to two different absolute paths and rebuilding the index there produces a different envelope digest, while every other projected field — every seat, every seedCell, every module row, both ledger digests, conservation — stays byte-identical. So the index envelope digest is a property of where the index was built, and the selection it feeds is not. Pinning it would make the baseline red on any machine that is not the one it was measured on, which is a false red about the loudest possible thing",
  "seats[].score": "weighted reciprocal rank over the channel set; S4 adds a channel and every score legitimately moves, which would swamp the diff with noise that hides the membership changes this baseline is for",
  "seats[].reason": "prose assembled from contribution reasons; same objection as score, plus it is not a decision",
  "seats[].contributions": "per-channel evidence; S4 legitimately adds entries to every seat",
  "displacements[].score": "the losing side of the same fusion; it moves for the same reason seats[].score moves, and a displaced row's number is not a decision anyone reads",
  "displacements[].contributions": "per-channel evidence for a row that won no seat; S4 legitimately adds entries here too, and the membership fact being pinned is that the cell was displaced at all"
} as const;

export interface BaselineProjection {
  readonly identity: Record<string, unknown>;
  readonly denominator: Record<string, unknown>;
  readonly selections: readonly Record<string, unknown>[];
}

/** Seats reduced to what a membership decision is: which cell, read through which fact, won by which channel. */
function seatRows(selection: AttributionSelection): unknown[] {
  return selection.seats
    .map((seat) => ({ unitId: seat.unitId, factId: seat.factId, channel: seat.channel, rootName: seat.rootName }))
    .sort((a, b) => a.unitId.localeCompare(b.unitId) || a.factId.localeCompare(b.factId));
}

/**
 * The comparable shape of one attribution artifact.
 *
 * Pure and total: same artifact in, same bytes out, no clock, no path, no environment. That is what lets a byte
 * comparison mean "the selection moved" rather than "the run happened somewhere else".
 */
export function projectBaseline(artifact: AttributionArtifact): BaselineProjection {
  const id = artifact.identity;
  return {
    identity: {
      version: artifact.version,
      unitsContentDigest: id.unitsContentDigest,
      filesContentManifestDigest: id.filesContentManifestDigest,
      mechanismsDigest: id.mechanismsDigest,
      channels: [...id.channels],
      channelConfigDigest: id.channelConfigDigest,
      // The envelope digest is excluded (see EXCLUDED); the inventory digest is not — it decides the module rows.
      channelInputs: { moduleInventoryDigest: id.channelInputs.moduleInventoryDigest, codegraphEnvelopePresent: id.channelInputs.codegraphEnvelopeDigest !== null },
      budgets: { ...id.budgets },
      // The intent's SHAPE travels; its digest does not (see EXCLUDED) — it hashes absolute workdir paths.
      runIntentVersion: id.runIntentSummary.version,
      runIntentFeatureCount: id.runIntentSummary.featureCount,
      runIntentFeatures: id.runIntentSummary.features.map((feature) => ({ key: feature.key, subject: feature.subject, aliases: [...feature.aliases] }))
    },
    denominator: { ...(artifact.denominator as unknown as Record<string, unknown>) },
    selections: [...artifact.selections]
      .sort((a, b) => a.featureKey.localeCompare(b.featureKey))
      .map((selection) => ({
        featureKey: selection.featureKey,
        channels: selection.channels,
        seats: seatRows(selection),
        displaced: selection.displacements.map((row) => row.unitId).sort(),
        seedCells: [...selection.seedCells].sort(),
        zeroScore: [...selection.zeroScore].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        projection: selection.projection,
        modules: [...selection.modules].sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
        conservation: [...selection.conservation].sort((a, b) => a.unitKind.localeCompare(b.unitKind))
      }))
  };
}
