import type { ArtifactResult } from "../base/artifact-result.ts";
import { summarizeSelection, type SelectionConservation } from "../base/conservation.ts";
import type { RowSetCompleteness, RowSetUnitKind } from "../base/row-set.ts";
import { canonicalJson, sha256, stableJson } from "../base/util.ts";
import { inventoryFactIdBaseOf, inventoryFactIdFor, inventoryUnitKind } from "../codegraph/function-inventory.ts";
import type { ProducerFactSet } from "../facts/envelope.ts";
import type { UnitsArtifact } from "../facts/units/units-artifact.ts";
import { unitsContentDigest, unitsRowSet } from "../facts/units/units-artifact.ts";
import {
  channelConfigDigest, SELECTION_CHANNELS, SELECTION_TRACE_VERSION, WEIGHTS,
  type FeatureSelectionTrace, type FloorDecision, type SelectionBudgets, type SelectionChannel, type TraceNode
} from "./selection-trace.ts";

/**
 * `attribution/attribution.json`: which partition cells this run's selection seated, and what happened to the rest.
 *
 * THE PROJECTION, and why it is three steps and not a match. A retained graph node becomes a seat by going
 * `node → the fact id layer 3 minted for it → the membership layer 3 already wrote → the cell`. Nothing here
 * compares a path or a span: §一 says the membership is written once by layer 3 and the consumer associates by
 * it, and re-deriving a cell from coordinates would be the second mapping algorithm that contract forbids —
 * which would agree with layer 3 on the easy cases and disagree exactly where it matters (a nested method, a
 * file-level partition, a minified line shared by two structures).
 *
 * WHY THE FIVE-BUCKET CENSUS IS THE DEFENCE AND CONSERVATION IS NOT. Slice 4's lesson (identity collapse passes
 * conservation) applies verbatim: `zeroScore` is computed as `counted - seated - displaced`, so a projection
 * that silently seats nothing still balances perfectly — every cell simply becomes zero-score and the sum is
 * exact. The only place a broken projection is visible is the per-node census, where every retained node must
 * land in one of `seated` / `kind-not-inventoried` / `file-not-counted` / `no-matching-fact` /
 * `envelope-unavailable`. That is why the census is published per selection and not summarised away.
 *
 * WHY ZERO-SCORE IS COMPRESSED AND SEATS ARE NOT. Seats and displacements are decisions about individual nodes
 * and each carries its own row. Zero-score is the complement — on wcp, 14,443 cells minus a few hundred — and
 * writing a row per cell per feature would produce a multi-million-row artifact whose only reader is the
 * conservation sum that already knows the number. It is published as counts per (module x language x reason),
 * which keeps every named reason and every module visible without the multiplier.
 *
 * WHY CONSERVATION IS PER SELECTION. A cell seated for feature A and zero-score for feature B is the normal
 * case, not a contradiction: the two selections are two independent allocations over one denominator. Summing
 * them into one run-level record would need a precedence rule across features, and inventing one would be this
 * layer deciding something no feature asked it to decide.
 */

export const ATTRIBUTION_ARTIFACT_VERSION = "attribution-v1";

/** Where a retained node landed when it did NOT reach a cell. Closed: there is no fourth way to miss. */
export const SEAT_PROJECTION_MISSES = ["envelope-unavailable", "file-not-counted", "kind-not-inventoried", "no-matching-fact"] as const;

export type SeatProjectionMiss = typeof SEAT_PROJECTION_MISSES[number];

/**
 * Why a counted cell holds no seat and lost no budget. Closed, and every member is produced by a real path.
 *
 * `structure-not-in-pool` and `structure-unobserved` are deliberately two reasons and not one: the first says
 * the index knows a declaration in that cell and this feature's expansion never reached it (a scope question),
 * the second says nothing observed the cell at all (a coverage question). Collapsing them would hide which of
 * the two a widened budget could fix.
 */
export const ZERO_SCORE_REASONS = [
  "channels-unavailable",
  "residual-no-channel-contribution",
  "structure-not-in-pool",
  "structure-unobserved"
] as const;

export type ZeroScoreReason = typeof ZERO_SCORE_REASONS[number];

export interface AttributionSeat {
  readonly unitId: string;
  readonly relativePath: string;
  readonly rootName: string;
  /** The channel that seated it. `displaced` never appears here; it is the one channel that awards no seat. */
  readonly channel: SelectionChannel;
  readonly nodeKind: string;
  readonly name: string;
  /** The layer-3 fact this seat was read through, so the seat can be walked back to its membership row. */
  readonly factId: string;
  readonly score: number;
  readonly reason: string;
}

export interface AttributionDisplacement {
  readonly unitId: string;
  readonly relativePath: string;
  readonly rootName: string;
  readonly nodeKind: string;
  readonly name: string;
  readonly factId: string;
  readonly score: number;
  /** Which budget squeezed it out. A displacement that cannot name its budget is P15 unchanged. */
  readonly budget: "rescue-quota" | "stage1-cut";
}

/** Zero-score cells, counted per (module x language x reason) instead of listed per cell. */
export interface ZeroScoreGroup {
  readonly rootName: string;
  readonly language: string | null;
  readonly reason: ZeroScoreReason;
  readonly cells: number;
}

/** Every node of one set in exactly one bucket. `nodes = seated + sum(missCounts)`, checked at construction. */
export interface SeatProjectionCensus {
  readonly nodes: number;
  readonly seated: number;
  readonly missCounts: Readonly<Record<SeatProjectionMiss, number>>;
}

export interface SelectionConservationRow {
  readonly unitKind: RowSetUnitKind;
  readonly totals: SelectionConservation;
}

/** What the channels did, without the pool: the per-node record is republished as seats and displacements. */
export type SelectionSummary =
  | {
    readonly status: "ran";
    readonly poolNodes: number;
    readonly retainedNodes: number;
    readonly seedCount: number;
    readonly budgets: SelectionBudgets;
    readonly stage1CutScore: number | null;
    readonly floorDecisions: readonly FloorDecision[];
    /** Retained nodes per channel, so a channel that seated nobody is a zero and not an absence. */
    readonly byChannel: Readonly<Record<SelectionChannel, number>>;
  }
  | { readonly status: "channel-unavailable"; readonly cause: "no-graph" | "empty-vocabulary" };

export interface AttributionSelection {
  readonly featureKey: string;
  readonly channels: SelectionSummary;
  readonly seats: readonly AttributionSeat[];
  readonly displacements: readonly AttributionDisplacement[];
  readonly zeroScore: readonly ZeroScoreGroup[];
  readonly projection: {
    readonly retained: SeatProjectionCensus;
    readonly displaced: SeatProjectionCensus;
  };
  /** One row per RowSet unit kind. The partition is one kind today, so today there is exactly one row. */
  readonly conservation: readonly SelectionConservationRow[];
}

/** The run intent, with everything audience-shaped removed. See `runIntentSummary` for why each field is gone. */
export interface RunIntentSummary {
  readonly version: string;
  readonly featureCount: number;
  readonly features: readonly { readonly key: string; readonly subject: string; readonly aliases: readonly string[] }[];
  readonly digest: string;
}

export interface AttributionIdentity {
  readonly unitsContentDigest: string;
  readonly filesContentManifestDigest: string;
  readonly mechanismsDigest: string;
  readonly channels: readonly string[];
  /** Digest of the scoring table. Change one weight and every seat may move, so the identity moves with it. */
  readonly channelConfigDigest: string;
  readonly channelInputs: {
    /** The envelope the seats were read through, `null` when there was none to read. */
    readonly codegraphEnvelopeDigest: string | null;
  };
  readonly budgets: { readonly maxFeatureNodes: number; readonly maxExpansionDepth: number; readonly maxGraphQueries: number };
  readonly runIntentSummary: RunIntentSummary;
  readonly traceVersion: string;
}

export interface AttributionArtifact {
  readonly version: typeof ATTRIBUTION_ARTIFACT_VERSION;
  readonly identity: AttributionIdentity;
  /** The denominator, named by the artifact it came from. Never a pool, never a candidate list (§四). */
  readonly denominator: {
    readonly artifact: string;
    readonly contentDigest: string;
    readonly producerVersion: string;
    readonly unitKind: RowSetUnitKind;
    readonly cells: number;
    readonly completeness: RowSetCompleteness;
  };
  /** 0 is a real value with `selections: []`; a run with no feature never gets a fabricated selection record. */
  readonly featureCount: number;
  readonly selections: readonly AttributionSelection[];
}

export interface AttributionAssemblyInput {
  readonly units: UnitsArtifact;
  /** The layer-3 producer whose facts the channels select over. Its `Unavailable` states are a real input. */
  readonly codegraph: ArtifactResult<ProducerFactSet>;
  /** Layer 1's counted paths, so "the node's file is outside the corpus" is a bucket and not a silent drop. */
  readonly countedPaths: readonly string[];
  readonly selections: readonly { readonly featureKey: string; readonly trace: FeatureSelectionTrace }[];
  readonly identity: {
    readonly filesContentManifestDigest: string;
    readonly mechanismsDigest: string;
    readonly budgets: AttributionIdentity["budgets"];
    readonly runIntent: {
      readonly version: string;
      readonly features: readonly { readonly key: string; readonly subject: string; readonly aliases: readonly string[] }[];
    };
  };
}

// --- the seat index: layer 3's memberships, joined by base fact id -------------------------------------------

/**
 * The membership rows a retained node can be joined against, or the reason there are none.
 *
 * The units-digest check is a REFUSAL, not a warning. A `UnitId` names a cell of one partition generation; an
 * envelope written against another generation would join to ids that no longer exist and every one of its seats
 * would silently become a zero-score cell — the artifact would balance and be wrong. So a mismatch throws.
 */
type SeatIndex =
  | { readonly status: "available"; readonly byBaseFactId: ReadonlyMap<string, string>; readonly envelopeDigest: string }
  | { readonly status: "unavailable" };

function seatIndex(codegraph: ArtifactResult<ProducerFactSet>, unitsDigest: string): SeatIndex {
  if (codegraph.status !== "built") return { status: "unavailable" };
  const envelope = codegraph.value;
  if (envelope.identity.unitsContentDigest !== unitsDigest) {
    throw new Error(`The codegraph fact envelope was written against partition generation ${JSON.stringify(envelope.identity.unitsContentDigest)} but this run's units artifact is ${JSON.stringify(unitsDigest)}; joining across generations would resolve seats to cells that do not exist in this partition`);
  }
  const byBaseFactId = new Map<string, string>();
  for (const fact of envelope.facts) {
    if (fact.membership.kind !== "unit") continue;
    // Two index nodes at the same coordinates get `base` and `base#2`, and both carry the SAME anchor, so the
    // mapper gives both the same cell. Joining on the base id is therefore lossless — and a disagreement would
    // mean the anchor stopped deciding the membership, which is not a state to average over.
    const base = inventoryFactIdBaseOf(fact.factId);
    const existing = byBaseFactId.get(base);
    if (existing !== undefined && existing !== fact.membership.unitId) {
      throw new Error(`Fact ids sharing the base ${JSON.stringify(base)} carry two memberships (${existing} and ${fact.membership.unitId}); same-coordinate rows must resolve to one cell or the seat join has no single answer`);
    }
    byBaseFactId.set(base, fact.membership.unitId);
  }
  return { status: "available", byBaseFactId, envelopeDigest: sha256(canonicalJson(envelope)) };
}

/** One node's projection outcome: the cell it reached, or the visible bucket it fell into. */
type Projection = { readonly kind: "seated"; readonly unitId: string; readonly factId: string } | { readonly kind: SeatProjectionMiss };

function project(node: TraceNode, index: SeatIndex, counted: ReadonlySet<string>): Projection {
  if (index.status === "unavailable") return { kind: "envelope-unavailable" };
  if (inventoryUnitKind(node.nodeKind) === null) return { kind: "kind-not-inventoried" };
  if (!counted.has(node.relativePath)) return { kind: "file-not-counted" };
  const factId = inventoryFactIdFor({
    kind: node.nodeKind,
    filePath: node.relativePath,
    startLine: node.startLine,
    endLine: node.endLine,
    name: node.name
  });
  // `null` here means the index reported the node with no usable line range, so layer 3 minted no fact for it:
  // there is nothing to match, which is the same visible bucket as a fact that was never published.
  const unitId = factId === null ? undefined : index.byBaseFactId.get(factId);
  if (factId === null || unitId === undefined) return { kind: "no-matching-fact" };
  return { kind: "seated", unitId, factId };
}

function emptyMissCounts(): Record<SeatProjectionMiss, number> {
  return { "envelope-unavailable": 0, "file-not-counted": 0, "kind-not-inventoried": 0, "no-matching-fact": 0 };
}

function census(nodes: number, seated: number, missCounts: Record<SeatProjectionMiss, number>): SeatProjectionCensus {
  const accounted = seated + SEAT_PROJECTION_MISSES.reduce((sum, miss) => sum + missCounts[miss], 0);
  if (accounted !== nodes) {
    throw new Error(`The seat projection lost a node: ${nodes} offered, ${accounted} in a bucket. Every node must land in exactly one of seated / ${SEAT_PROJECTION_MISSES.join(" / ")}`);
  }
  return { nodes, seated, missCounts: { ...missCounts } };
}

// --- one selection -------------------------------------------------------------------------------------------

interface CellFacts {
  readonly rootName: string;
  readonly relativePath: string;
  readonly language: string | null;
  readonly isResidual: boolean;
  /** Whether any layer-3 fact points at this cell at all — the difference between "not reached" and "unseen". */
  readonly observed: boolean;
}

function buildSelection(
  featureKey: string,
  trace: FeatureSelectionTrace,
  cells: ReadonlyMap<string, CellFacts>,
  index: SeatIndex,
  counted: ReadonlySet<string>,
  unitKind: RowSetUnitKind
): AttributionSelection {
  const seats: AttributionSeat[] = [];
  const displacements: AttributionDisplacement[] = [];
  const seatedCells = new Set<string>();
  const displacedCells = new Set<string>();
  const retainedMiss = emptyMissCounts();
  const displacedMiss = emptyMissCounts();
  let retainedNodes = 0;
  let retainedSeated = 0;
  let displacedNodes = 0;
  let displacedProjected = 0;
  const byChannel: Record<SelectionChannel, number> = { "stage1": 0, "rescue": 0, "backfill": 0, "module-floor": 0, "displaced": 0 };

  if (trace.status === "ran") {
    for (const node of trace.pool) {
      byChannel[node.outcome] += 1;
      const projection = project(node, index, counted);
      if (node.outcome === "displaced") {
        displacedNodes += 1;
        if (projection.kind !== "seated") { displacedMiss[projection.kind] += 1; continue; }
        displacedProjected += 1;
        const cell = cells.get(projection.unitId);
        if (cell === undefined) continue; // a membership naming a cell outside the partition cannot occur; §四
        displacedCells.add(projection.unitId);
        displacements.push({
          unitId: projection.unitId,
          relativePath: cell.relativePath,
          rootName: cell.rootName,
          nodeKind: node.nodeKind,
          name: node.name,
          factId: projection.factId,
          score: node.score,
          budget: node.displacedBy ?? "stage1-cut"
        });
        continue;
      }
      retainedNodes += 1;
      if (projection.kind !== "seated") { retainedMiss[projection.kind] += 1; continue; }
      retainedSeated += 1;
      const cell = cells.get(projection.unitId);
      if (cell === undefined) continue;
      seatedCells.add(projection.unitId);
      seats.push({
        unitId: projection.unitId,
        relativePath: cell.relativePath,
        rootName: cell.rootName,
        channel: node.outcome,
        nodeKind: node.nodeKind,
        name: node.name,
        factId: projection.factId,
        score: node.score,
        reason: node.reason
      });
    }
  }

  // Priority: a cell that holds a seat is seated even when another of its nodes was displaced. Stated once,
  // here, because the two sets are built from overlapping node sets and the overlap is the normal case (a
  // class cell holds every method node the index reported inside it).
  for (const unitId of seatedCells) displacedCells.delete(unitId);

  const zeroScore = groupZeroScore(cells, seatedCells, displacedCells, trace.status === "ran" ? null : "channels-unavailable", index);
  const zeroScoreCells = zeroScore.reduce((sum, group) => sum + group.cells, 0);

  return {
    featureKey,
    channels: trace.status === "ran"
      ? {
        status: "ran",
        poolNodes: trace.pool.length,
        retainedNodes,
        seedCount: trace.seedCount,
        budgets: trace.budgets,
        stage1CutScore: trace.stage1CutScore,
        floorDecisions: [...trace.floorDecisions],
        byChannel
      }
      : { status: "channel-unavailable", cause: trace.cause },
    seats: seats.sort((a, b) => a.unitId.localeCompare(b.unitId) || a.factId.localeCompare(b.factId)),
    displacements: displacements.sort((a, b) => a.unitId.localeCompare(b.unitId) || a.factId.localeCompare(b.factId)),
    zeroScore,
    projection: {
      retained: census(retainedNodes, retainedSeated, retainedMiss),
      displaced: census(displacedNodes, displacedProjected, displacedMiss)
    },
    // The ONE constructor (`src/base/conservation.ts`). `zeroScore` arrives as the complement, so "a cell that
    // is in none of the three buckets" is not a state this arithmetic can express.
    conservation: [{
      unitKind,
      totals: summarizeSelection({
        counted: cells.size,
        seated: seatedCells.size,
        zeroScore: zeroScoreCells,
        displaced: displacedCells.size
      })
    }]
  };
}

/**
 * Every cell that is neither seated nor displaced, counted by (module x language x reason).
 *
 * The reason is decided per cell and the enumeration is total: a run whose channels never ran gives every cell
 * the same reason; otherwise a residual cell says so, and a structure cell says whether any producer observed it
 * — which is the distinction between "this feature's pool never reached it" and "nothing in this run has ever
 * looked at it".
 */
function groupZeroScore(
  cells: ReadonlyMap<string, CellFacts>,
  seated: ReadonlySet<string>,
  displaced: ReadonlySet<string>,
  forced: ZeroScoreReason | null,
  index: SeatIndex
): ZeroScoreGroup[] {
  const groups = new Map<string, ZeroScoreGroup & { cells: number }>();
  for (const [unitId, cell] of cells) {
    if (seated.has(unitId) || displaced.has(unitId)) continue;
    const reason: ZeroScoreReason = forced !== null ? forced
      : index.status === "unavailable" ? "channels-unavailable"
      : cell.isResidual ? "residual-no-channel-contribution"
      : cell.observed ? "structure-not-in-pool"
      : "structure-unobserved";
    const key = JSON.stringify([cell.rootName, cell.language, reason]);
    const existing = groups.get(key);
    if (existing) existing.cells += 1;
    else groups.set(key, { rootName: cell.rootName, language: cell.language, reason, cells: 1 });
  }
  return [...groups.values()].sort((a, b) =>
    a.rootName.localeCompare(b.rootName)
    || (a.language ?? "").localeCompare(b.language ?? "")
    || a.reason.localeCompare(b.reason));
}

// --- the artifact --------------------------------------------------------------------------------------------

export function assembleAttributionArtifact(input: AttributionAssemblyInput): AttributionArtifact {
  const unitsDigest = unitsContentDigest(input.units);
  const index = seatIndex(input.codegraph, unitsDigest);
  const rowSet = unitsRowSet(input.units);
  const counted = new Set(input.countedPaths);

  const languageByPath = new Map(input.units.files.map((file) => [file.relativePath, file.language] as const));
  // Which cells any producer's fact points at. Read off the units artifact's OWN observation record rather than
  // recomputed: `observedBy` is the merge across producers, and a second derivation here would be a second
  // answer to "was this unit observed".
  const observedSpans = new Set<string>();
  for (const unit of input.units.refUnits) {
    if (unit.observedBy.length) observedSpans.add(spanKey(unit.relativePath, unit.span.startByte, unit.span.endByte));
  }
  const cells = new Map<string, CellFacts>();
  for (const cell of input.units.partition) {
    cells.set(cell.unitId, {
      rootName: cell.rootName,
      relativePath: cell.relativePath,
      language: languageByPath.get(cell.relativePath) ?? null,
      isResidual: cell.partitionKind === "residual",
      observed: observedSpans.has(spanKey(cell.relativePath, cell.span.startByte, cell.span.endByte))
    });
  }

  const features = input.identity.runIntent.features.map((feature) => ({
    key: feature.key,
    subject: feature.subject,
    aliases: [...feature.aliases]
  }));
  return {
    version: ATTRIBUTION_ARTIFACT_VERSION,
    identity: {
      unitsContentDigest: unitsDigest,
      filesContentManifestDigest: input.identity.filesContentManifestDigest,
      mechanismsDigest: input.identity.mechanismsDigest,
      channels: [...SELECTION_CHANNELS],
      channelConfigDigest: channelConfigDigest(WEIGHTS),
      channelInputs: { codegraphEnvelopeDigest: index.status === "available" ? index.envelopeDigest : null },
      budgets: input.identity.budgets,
      runIntentSummary: runIntentSummary(input.identity.runIntent.version, features),
      traceVersion: SELECTION_TRACE_VERSION
    },
    denominator: {
      artifact: rowSet.identity.artifact,
      contentDigest: rowSet.identity.contentDigest,
      producerVersion: rowSet.identity.producerVersion,
      unitKind: rowSet.unitKind,
      cells: rowSet.size,
      completeness: rowSet.identity.completeness
    },
    featureCount: input.selections.length,
    selections: [...input.selections]
      .sort((a, b) => a.featureKey.localeCompare(b.featureKey))
      .map((selection) => buildSelection(selection.featureKey, selection.trace, cells, index, counted, rowSet.unitKind))
  };
}

/** A path plus a byte interval as one lookup key. JSON-encoded, so no separator can appear in a path. */
function spanKey(relativePath: string, startByte: number, endByte: number): string {
  return JSON.stringify([relativePath, startByte, endByte]);
}

/**
 * The run intent with everything audience-shaped taken out.
 *
 * Three omissions, each for the same reason: an attribution identity that moves when the AUDIENCE moves would
 * make one corpus's seats look like two different allocations. `documents[]` is the worst offender because a
 * document id encodes the audience directly; `outputLanguage` decides prose and nothing about which cell is
 * selected; and `target` is an absolute path, which makes the identity machine-specific for no gain — the
 * corpus is already pinned by `filesContentManifestDigest`.
 *
 * What stays is what actually steers the channels: the feature keys, their subjects and their aliases, which
 * ARE the vocabulary the seeds are searched with.
 */
function runIntentSummary(version: string, features: RunIntentSummary["features"]): RunIntentSummary {
  const rows = [...features].sort((a, b) => a.key.localeCompare(b.key));
  return {
    version,
    featureCount: rows.length,
    features: rows,
    digest: sha256(stableJson({ version, features: rows }))
  };
}

/** The artifact's own content digest, over everything it declares. */
export function attributionContentDigest(artifact: AttributionArtifact): string {
  return sha256(canonicalJson(artifact));
}

/**
 * Canonical bytes: stable key order, stable row order, no wall-clock field, unindented.
 *
 * Unindented for the same reason `facts/units.json` is: the seat and displacement rows are machine-read and a
 * multi-module run produces thousands of them.
 */
export function serializeAttributionArtifact(result: ArtifactResult<AttributionArtifact>): string {
  return `${canonicalJson(result)}\n`;
}
