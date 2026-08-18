import { join } from "node:path";
import { built, unavailable, type ArtifactResult, type Unavailable } from "../base/artifact-result.ts";
import { atomicWrite } from "../base/util.ts";
import {
  assembleAttributionArtifact, serializeAttributionArtifact,
  type AttributionArtifact, type AttributionAssemblyInput
} from "../attribution/attribution-artifact.ts";
import type { FeatureSelectionTrace } from "../attribution/selection-trace.ts";
import type { ProducerFactSet } from "../facts/envelope.ts";
import type { UnitsArtifact } from "../facts/units/units-artifact.ts";
import type { FileLedger } from "../snapshot/file-ledger.ts";

/**
 * Layer 4, wired into prepare: `attribution/attribution.json`, written on every path.
 *
 * Same shape as `facts-stage.ts` and for the same reason. The registry says a missing attribution record is a
 * finding, and that flag is only honest if there is no prepare that leaves the file out: a run that failed
 * before layer 3, a run whose designated builder could not run, a run with no feature at all — each of those
 * gets a written record here rather than an absent file. `unavailableAttributionStage` is the failure half and
 * `writeAttributionStage` is the single writer, so the success and failure paths cannot lay the directory out
 * differently.
 *
 * THE ORDER IS FORCED, exactly as it is one layer down: the seats are joined against the layer-3 envelope's
 * membership rows and the identity carries `unitsContentDigest`, so layer 3 must have finished before this runs.
 * It reads the facts stage's IN-MEMORY result rather than the files it just wrote — re-reading would let the two
 * layers disagree about what was written if anything touched the directory in between.
 *
 * It lives in `src/run/` and not in `src/attribution/` for the reason the facts stage states: deciding which
 * producers and which features a run has is not a layer-4 question, and letting layer 4 ask would give it an
 * upward reach. Everything it needs is handed to it.
 */

export interface AttributionStageResult {
  readonly attribution: ArtifactResult<AttributionArtifact>;
}

export interface AttributionStageInput {
  readonly units: ArtifactResult<UnitsArtifact>;
  /** The layer-3 producer whose facts the channels select over; its `Unavailable` states are a real input. */
  readonly codegraph: ArtifactResult<ProducerFactSet>;
  readonly ledger: FileLedger;
  /** Complete resolved module inventory, including modules that emitted no candidate for this feature. */
  readonly modules: readonly { readonly id: string; readonly dir: string }[];
  readonly mechanismsDigest: string;
  /**
   * One entry per feature this run prepared, in any order. An EMPTY array is a legal, meaningful input: an
   * overview-only run selected nothing, and the artifact says `featureCount: 0` with no selections rather than
   * inventing a record of a selection that never happened.
   */
  readonly selections: readonly { readonly featureKey: string; readonly trace: FeatureSelectionTrace }[];
  readonly identity: AttributionAssemblyInput["identity"];
}

export function buildAttributionStage(input: AttributionStageInput): AttributionStageResult {
  // No partition, no denominator: a seat is awarded to a cell, and with no cells there is nothing to award. The
  // cause travels from layer 3 so the record says which layer stopped, not merely that this one did not run.
  if (input.units.status !== "built") {
    const cause = input.units.status === "unavailable"
      ? input.units.cause
      : `the partition was determined not applicable: ${input.units.determination}`;
    return { attribution: unavailable(`no partition to seat anything in — ${cause}`, input.units.status === "unavailable" ? input.units.retryable : false) };
  }
  return {
    attribution: built(assembleAttributionArtifact({
      units: input.units.value,
      codegraph: input.codegraph,
      countedPaths: input.ledger.counted.map((row) => row.relativePath),
      modules: input.modules,
      selections: input.selections,
      identity: input.identity
    }))
  };
}

/** The failure-path stage: the same one record, written. */
export function unavailableAttributionStage(cause: string, retryable: boolean): AttributionStageResult {
  return { attribution: unavailableRecord(cause, retryable) };
}

function unavailableRecord(cause: string, retryable: boolean): Unavailable {
  return unavailable(`no selection to attribute — ${cause}`, retryable);
}

/** The one writer. */
export async function writeAttributionStage(runDir: string, stage: AttributionStageResult): Promise<void> {
  await atomicWrite(join(runDir, "attribution", "attribution.json"), serializeAttributionArtifact(stage.attribution));
}
