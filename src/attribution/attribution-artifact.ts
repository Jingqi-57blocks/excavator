import type { ArtifactResult } from "../base/artifact-result.ts";
import { summarizeSelection, type SelectionConservation } from "../base/conservation.ts";
import { membershipCells } from "../base/fact-kind-registry.ts";
import type { RowSetCompleteness, RowSetUnitKind } from "../base/row-set.ts";
import { canonicalJson, sha256, stableJson } from "../base/util.ts";
import { inventoryFactIdBaseOf, inventoryFactIdFor, inventoryUnitKind } from "../codegraph/function-inventory.ts";
import type { ProducerFactSet } from "../facts/envelope.ts";
import type { UnitsArtifact } from "../facts/units/units-artifact.ts";
import { unitsContentDigest, unitsRowSet } from "../facts/units/units-artifact.ts";
import { moduleForFile, type DetectedModule } from "../snapshot/module-detection.ts";
import {
  channelConfigDigest, SELECTION_CHANNELS, SELECTION_TRACE_VERSION, WEIGHTS,
  type FeatureSelectionTrace, type SelectionBudgets, type SelectionChannel,
  type SelectionContribution, type SelectionFusion, type TraceNode
} from "./selection-trace.ts";
import type { RouteRecallTraceBlock } from "./route-recall.ts";
import type { CrossrepoRecallTraceBlock } from "./crossrepo-recall.ts";

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

export const ATTRIBUTION_ARTIFACT_VERSION = "attribution-v5";

/** Where a retained node landed when it did NOT reach a cell. Closed: there is no fourth way to miss. */
export const SEAT_PROJECTION_MISSES = ["envelope-unavailable", "file-not-counted", "kind-not-inventoried", "no-matching-fact"] as const;

export type SeatProjectionMiss = typeof SEAT_PROJECTION_MISSES[number];

/**
 * Why a counted cell holds no seat and lost no budget. Closed, and every member is produced by a real path.
 *
 * `structure-not-in-pool` and `structure-unobserved` are deliberately two reasons and not one: the first says
 * the index filed a fact in that cell and this feature's expansion never reached it (a scope question), the
 * second says the index filed none there at all (a coverage question). Collapsing them would hide which of the
 * two a widened budget could fix — and getting the boundary between them wrong hides the same thing, which is
 * why `groupZeroScore` reads the answer off layer 3's memberships instead of matching coordinates.
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
  readonly contributions: readonly SelectionContribution[];
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
  readonly budget: "seat-cap";
  readonly contributions: readonly SelectionContribution[];
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

/**
 * One CodeGraph module's complete participation in one allocation.
 *
 * The inventory, rather than the candidate pool, creates these rows. That distinction is the M6 output law:
 * a module with no candidate still has a visible `zero-signal` row and never receives a fabricated seat.
 */
export interface AttributionModuleRow {
  readonly moduleId: string;
  readonly dir: string;
  readonly denominatorCells: number;
  readonly poolNodes: number;
  readonly retainedNodes: number;
  readonly displacedNodes: number;
  readonly seatedCells: number;
  readonly displacedCells: number;
  readonly soleSourceSeats: number;
  readonly status: "seated" | "candidates-no-seat" | "zero-signal" | "outside-denominator";
  /**
   * What each recall channel did FOR THIS MODULE. Every module lands in exactly one bucket per channel.
   *
   * The distinction that matters is `unavailable` against `no-match`: the first says this module has no route
   * facts at all, so the channel had nothing to work with here; the second says it has them and none aligned with
   * what was asked. Collapsing the two would make "the tool cannot see this module" read as "this module has
   * nothing to do with the capability", which is the confusion the whole mechanism-ledger layer exists to prevent
   * one level down.
   */
  readonly recall: {
    readonly route: "not-run" | "unavailable" | "no-match" | "contributed";
    /**
     * `not-applicable` is this channel's own state and belongs to no other: a single-module target has no
     * cross-repo edge to find, which is a DETERMINATION about the target rather than a gap in what was looked at.
     * Collapsing it into `unavailable` would report "the tool could not see here" for a repository that has
     * nothing there to see.
     */
    readonly crossrepo: "not-run" | "not-applicable" | "unavailable" | "no-match" | "contributed";
  };
}

/** What the channels did, without the pool: the per-node record is republished as seats and displacements. */
export type SelectionSummary =
  | {
    readonly status: "ran";
    readonly poolNodes: number;
    readonly retainedNodes: number;
    readonly seedCount: number;
    readonly budgets: SelectionBudgets;
    readonly fusion: SelectionFusion;
    /** Retained nodes per channel, so a channel that seated nobody is a zero and not an absence. */
    readonly byChannel: Readonly<Record<SelectionChannel, number>>;
    /**
     * What each recall channel did, carried through from the trace.
     *
     * It has to be HERE and not only in the trace, because the trace is a prepare-time cache entry and this is the
     * published artifact: without it, `matchedRouteFactIds` — the only record of which recorded routes a hypothesis
     * reached — never reaches anything an auditor or a later slice can read. A channel whose work is invisible in
     * the artifact is a channel whose contribution cannot be checked against the facts it claims to have used.
     */
    readonly recall: { readonly route: RouteRecallTraceBlock; readonly crossrepo: CrossrepoRecallTraceBlock };
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
  /** Total module census, including zero-signal modules that contributed no candidate and won no seat. */
  readonly modules: readonly AttributionModuleRow[];
  /** One row per RowSet unit kind. The partition is one kind today, so today there is exactly one row. */
  readonly conservation: readonly SelectionConservationRow[];
  /**
   * Cells that hold a seat won by a node the query itself named, sorted.
   *
   * A subset of `seats[].unitId` by construction: a cell only enters here on the seated branch, after the same
   * projection that produced the seat. That is why there is no runtime check for the subset property — a guard
   * on a branch that cannot be reached is a dead arm that reads like a safeguard; the invariant is asserted in
   * `tests/attribution-artifact.test.ts` instead, where it can actually fail.
   *
   * DISPLACED query seeds are deliberately absent. A seed that lost the budget holds no seat, and layer 5's
   * `seeded` relation authorises reading — publishing a displaced seed here would authorise a read for a cell
   * this run decided not to seat.
   *
   * This is what makes layer 5's `seeded` relation reachable at all. Production passed an empty set until now
   * (`run.ts`), so `factpack-annotate.ts`'s `{ kind: "seeded", basis: "explicit-seed" }` branch existed and was
   * never taken on any real run.
   */
  readonly seedCells: readonly string[];
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
    /** Exact module inventory that creates the total module rows; an empty inventory has a real digest. */
    readonly moduleInventoryDigest: string;
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
  /** Complete CodeGraph module inventory. Rows are created from this list, never inferred from candidates. */
  readonly modules: readonly { readonly id: string; readonly dir: string }[];
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
 *
 * `observedCells` is the OTHER thing the envelope answers, and it is read from the same memberships for the same
 * reason: "which cells has a producer's fact been filed in" is a question layer 3 already wrote the answer to.
 * Deriving it from coordinates instead is what this index exists to avoid — see `groupZeroScore`.
 */
type SeatIndex =
  | {
    readonly status: "available";
    readonly byBaseFactId: ReadonlyMap<string, string>;
    /** Every cell any fact of this envelope names, across every membership shape. */
    readonly observedCells: ReadonlySet<string>;
    readonly envelopeDigest: string;
  }
  | { readonly status: "unavailable" };

/**
 * Where the recorded routes were registered.
 *
 * `indexed-route` facts anchor to their handler's cell when the handler was verified and to the registration line
 * otherwise, so the anchor alone does not say which module REGISTERED the route. The detail's `registrationPath`
 * does, and it is the same field the inventory wrote — read, never recomputed.
 */
function routeRegistrationPaths(codegraph: ArtifactResult<ProducerFactSet>): string[] {
  if (codegraph.status !== "built") return [];
  const paths = new Set<string>();
  for (const fact of codegraph.value.facts) {
    if (fact.kind !== "indexed-route") continue;
    const detail = fact.detail as { registrationPath?: unknown; handlerPath?: unknown; handlerResolution?: unknown };
    if (typeof detail.registrationPath === "string" && detail.registrationPath.length) paths.add(detail.registrationPath);
    // The RESOLVED handler's module counts too, and leaving it out was self-contradictory: routes registered in
    // one module with handlers in another — `routes/` beside `controllers/`, the shape framework-convention
    // recovery targets — would read as `unavailable` ("the channel has nothing to work with here") for the
    // handler's module, while the channel demonstrably CAN admit that handler through the other module's
    // registration. The same module could go from `unavailable` straight to `contributed`.
    if (detail.handlerResolution === "resolved" && typeof detail.handlerPath === "string" && detail.handlerPath.length) {
      paths.add(detail.handlerPath);
    }
  }
  return [...paths].sort();
}

function seatIndex(codegraph: ArtifactResult<ProducerFactSet>, unitsDigest: string): SeatIndex {
  if (codegraph.status !== "built") return { status: "unavailable" };
  const envelope = codegraph.value;
  if (envelope.identity.unitsContentDigest !== unitsDigest) {
    throw new Error(`The codegraph fact envelope was written against partition generation ${JSON.stringify(envelope.identity.unitsContentDigest)} but this run's units artifact is ${JSON.stringify(unitsDigest)}; joining across generations would resolve seats to cells that do not exist in this partition`);
  }
  const byBaseFactId = new Map<string, string>();
  const observedCells = new Set<string>();
  for (const fact of envelope.facts) {
    for (const unitId of membershipCells(fact.membership)) observedCells.add(unitId);
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
  return { status: "available", byBaseFactId, observedCells, envelopeDigest: sha256(canonicalJson(envelope)) };
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
}

/**
 * The cell a projection reached, or a refusal.
 *
 * Same failure as the cross-generation check in `seatIndex`, one join later: a membership naming a cell this
 * partition does not hold. It used to be a silent `continue`, and that was WORSE than the zero-score drop the
 * generation check exists to prevent — the node had already been counted in `retainedSeated`, so the census said
 * "seated", the seat list held no row for it, and the conservation sum said nothing was seated. Three published
 * answers to one question, and no error anywhere. `project()` promises every retained node lands in exactly one
 * of five buckets; a node that reaches here and finds no cell is a sixth, so it stops the artifact.
 */
function cellOf(cells: ReadonlyMap<string, CellFacts>, projection: { readonly unitId: string; readonly factId: string }): CellFacts {
  const cell = cells.get(projection.unitId);
  if (cell === undefined) {
    throw new Error(`Fact ${JSON.stringify(projection.factId)} carries a membership in cell ${JSON.stringify(projection.unitId)}, which is not a cell of this run's partition; seating a node against a cell that does not exist would count it as seated and publish no seat for it`);
  }
  return cell;
}

function buildSelection(
  featureKey: string,
  trace: FeatureSelectionTrace,
  cells: ReadonlyMap<string, CellFacts>,
  index: SeatIndex,
  counted: ReadonlySet<string>,
  unitKind: RowSetUnitKind,
  modules: readonly DetectedModule[],
  routeFactPaths: readonly string[]
): AttributionSelection {
  const seats: AttributionSeat[] = [];
  const displacements: AttributionDisplacement[] = [];
  const seatedCells = new Set<string>();
  const seedCells = new Set<string>();
  // The query's own seeds, read off the recorded id set. NOT `node.outcome === "seed"`: the allocator puts
  // seed NEIGHBOURS on that same channel (`allocator.ts`, reason `seed-neighbor`), so the channel would seat a
  // neighbour as if the query had named it.
  const querySeeds = new Set(trace.status === "ran" ? trace.querySeedNodeIds : []);
  const displacedCells = new Set<string>();
  const retainedMiss = emptyMissCounts();
  const displacedMiss = emptyMissCounts();
  let retainedNodes = 0;
  let retainedSeated = 0;
  let displacedNodes = 0;
  let displacedProjected = 0;
  const byChannel = Object.fromEntries(SELECTION_CHANNELS.map((channel) => [channel, 0])) as Record<SelectionChannel, number>;

  if (trace.status === "ran") {
    for (const node of trace.pool) {
      byChannel[node.outcome] += 1;
      const projection = project(node, index, counted);
      if (node.outcome === "displaced") {
        displacedNodes += 1;
        if (projection.kind !== "seated") { displacedMiss[projection.kind] += 1; continue; }
        displacedProjected += 1;
        const cell = cellOf(cells, projection);
        displacedCells.add(projection.unitId);
        displacements.push({
          unitId: projection.unitId,
          relativePath: cell.relativePath,
          rootName: cell.rootName,
          nodeKind: node.nodeKind,
          name: node.name,
          factId: projection.factId,
          score: node.score,
          budget: node.displacedBy ?? "seat-cap",
          contributions: [...node.contributions]
        });
        continue;
      }
      retainedNodes += 1;
      if (projection.kind !== "seated") { retainedMiss[projection.kind] += 1; continue; }
      retainedSeated += 1;
      const cell = cellOf(cells, projection);
      seatedCells.add(projection.unitId);
      if (querySeeds.has(node.nodeId)) seedCells.add(projection.unitId);
      seats.push({
        unitId: projection.unitId,
        relativePath: cell.relativePath,
        rootName: cell.rootName,
        channel: node.outcome,
        nodeKind: node.nodeKind,
        name: node.name,
        factId: projection.factId,
        score: node.score,
        reason: node.reason,
        contributions: [...node.contributions]
      });
    }
  }

  // Priority: a cell that holds a seat is seated even when another of its nodes was displaced. Stated once,
  // here, because the two sets are built from overlapping node sets and the overlap is the normal case (a
  // class cell holds every method node the index reported inside it).
  for (const unitId of seatedCells) displacedCells.delete(unitId);

  const zeroScore = groupZeroScore(cells, seatedCells, displacedCells, trace.status === "ran" ? null : "channels-unavailable", index);
  const zeroScoreCells = zeroScore.reduce((sum, group) => sum + group.cells, 0);
  const moduleRows = buildModuleRows(modules, cells, trace, seats, seatedCells, displacedCells, routeFactPaths);

  return {
    featureKey,
    seedCells: [...seedCells].sort(),
    channels: trace.status === "ran"
      ? {
        status: "ran",
        poolNodes: trace.pool.length,
        retainedNodes,
        recall: trace.recall,
        seedCount: trace.seedCount,
        budgets: trace.budgets,
        fusion: trace.fusion,
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
    modules: moduleRows,
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

interface MutableModuleRow {
  moduleId: string;
  dir: string;
  denominatorCells: number;
  poolNodes: number;
  retainedNodes: number;
  displacedNodes: number;
  seatedCells: Set<string>;
  displacedCells: Set<string>;
  soleSourceSeats: Set<string>;
}

function buildModuleRows(
  modules: readonly DetectedModule[],
  cells: ReadonlyMap<string, CellFacts>,
  trace: FeatureSelectionTrace,
  seats: readonly AttributionSeat[],
  seatedCells: ReadonlySet<string>,
  displacedCells: ReadonlySet<string>,
  /**
   * Every module path a recorded route fact touches: the registration, and the resolved handler's file.
   *
   * Both ends, because `unavailable` means "this channel has nothing to work with in this module" — and a module
   * holding a resolved handler has something to work with even when it registers no route itself.
   */
  routeFactPaths: readonly string[]
): AttributionModuleRow[] {
  const inventory = modules.map((module) => ({ ...module }));
  const rows = new Map<string, MutableModuleRow>(inventory.map((module) => [module.id, {
    moduleId: module.id,
    dir: module.dir,
    denominatorCells: 0,
    poolNodes: 0,
    retainedNodes: 0,
    displacedNodes: 0,
    seatedCells: new Set<string>(),
    displacedCells: new Set<string>(),
    soleSourceSeats: new Set<string>()
  }]));
  const rowForPath = (relativePath: string): MutableModuleRow | undefined => {
    const owner = moduleForFile(inventory, relativePath);
    return owner === undefined ? undefined : rows.get(owner.id);
  };

  for (const cell of cells.values()) {
    const row = rowForPath(cell.relativePath);
    if (row) row.denominatorCells += 1;
  }
  if (trace.status === "ran") for (const node of trace.pool) {
    const row = rowForPath(node.relativePath);
    if (!row) continue;
    row.poolNodes += 1;
    if (node.outcome === "displaced") row.displacedNodes += 1;
    else row.retainedNodes += 1;
  }
  for (const unitId of seatedCells) {
    const cell = cells.get(unitId)!;
    rowForPath(cell.relativePath)?.seatedCells.add(unitId);
  }
  for (const unitId of displacedCells) {
    const cell = cells.get(unitId)!;
    rowForPath(cell.relativePath)?.displacedCells.add(unitId);
  }
  for (const seat of seats) {
    const nonFallback = seat.contributions.filter((item) => item.sourceChannel !== "fallback");
    if (nonFallback.length === 1) rowForPath(seat.relativePath)?.soleSourceSeats.add(seat.unitId);
  }

  // Which modules the route channel actually contributed to, and which ones it could have.
  const contributedModules = new Set<string>();
  if (trace.status === "ran") for (const node of trace.pool) {
    if (!node.contributions.some((item) => item.sourceChannel === "route")) continue;
    const owner = moduleForFile(inventory, node.relativePath);
    if (owner) contributedModules.add(owner.id);
  }
  const modulesWithRouteFacts = new Set<string>();
  for (const path of routeFactPaths) {
    const owner = moduleForFile(inventory, path);
    if (owner) modulesWithRouteFacts.add(owner.id);
  }
  const routeRan = trace.status === "ran" && trace.recall.route.status === "ran";

  const crossrepoContributed = new Set<string>();
  if (trace.status === "ran") for (const node of trace.pool) {
    if (!node.contributions.some((item) => item.sourceChannel === "crossrepo")) continue;
    const owner = moduleForFile(inventory, node.relativePath);
    if (owner) crossrepoContributed.add(owner.id);
  }
  const crossrepoBlock = trace.status === "ran" ? trace.recall.crossrepo : null;
  const crossrepoRan = crossrepoBlock?.status === "ran";
  const crossrepoNotApplicable = crossrepoBlock?.status === "not-run" && crossrepoBlock.cause === "single-module";

  return [...rows.values()].map((row): AttributionModuleRow => {
    const seated = row.seatedCells.size;
    const status: AttributionModuleRow["status"] = seated > 0 ? "seated"
      : row.poolNodes > 0 ? "candidates-no-seat"
      : row.denominatorCells > 0 ? "zero-signal"
      : "outside-denominator";
    return {
      moduleId: row.moduleId,
      dir: row.dir,
      denominatorCells: row.denominatorCells,
      poolNodes: row.poolNodes,
      retainedNodes: row.retainedNodes,
      displacedNodes: row.displacedNodes,
      seatedCells: seated,
      displacedCells: row.displacedCells.size,
      soleSourceSeats: row.soleSourceSeats.size,
      status,
      // The cause of `not-run` is recorded once on the trace rather than copied onto every module row: it is a
      // property of the run, and duplicating it would invite the two records to disagree.
      recall: {
        route: !routeRan ? "not-run"
          : contributedModules.has(row.moduleId) ? "contributed"
          : modulesWithRouteFacts.has(row.moduleId) ? "no-match"
          : "unavailable",
        crossrepo: crossrepoNotApplicable ? "not-applicable"
          : !crossrepoRan ? "not-run"
          : crossrepoContributed.has(row.moduleId) ? "contributed"
          : modulesWithRouteFacts.has(row.moduleId) ? "no-match"
          : "unavailable"
      }
    };
  });
}

/**
 * Every cell that is neither seated nor displaced, counted by (module x language x reason).
 *
 * The reason is decided per cell and the enumeration is total: a run whose channels never ran gives every cell
 * the same reason; otherwise a residual cell says so, and a structure cell says whether the producer the channels
 * select over filed any fact in it — which is the distinction between "this feature's pool never reached it" and
 * "the index has never looked at it".
 *
 * THE OBSERVATION ANSWER IS LAYER 3'S, READ AND NOT RECOMPUTED. It used to be "some reference unit with the
 * SAME (path, startByte, endByte) as this cell was observed", which is a coordinate match, which is the second
 * mapping algorithm §一 forbids the consumer to own — and it was wrong in the ordinary case, not the exotic one:
 * a reference unit at depth ≥ 2 (a method inside a class) never has a cell's span, and neither does a
 * `reported-span` unit, so a cell whose only observation was a nested one came out `structure-unobserved` when
 * the truth was `structure-not-in-pool`. §一's own remedy applies unchanged — associate by the membership
 * layer 3 wrote — so the answer now comes off `fact.membership`, which is the same join the seats use.
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
      : index.observedCells.has(unitId) ? "structure-not-in-pool"
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
  // Registration paths of every recorded route fact, read off the SAME envelope the seats are joined through.
  // This is what separates "this module has no route facts" (`unavailable`) from "it has some and none matched"
  // (`no-match`); deriving it from anywhere else would be a second answer to which routes exist.
  const routeFactPaths = routeRegistrationPaths(input.codegraph);
  const rowSet = unitsRowSet(input.units);
  const counted = new Set(input.countedPaths);
  const modules = canonicalModuleInventory(input.modules);
  const moduleInventoryDigest = sha256(canonicalJson(modules));

  const languageByPath = new Map(input.units.files.map((file) => [file.relativePath, file.language] as const));
  const cells = new Map<string, CellFacts>();
  for (const cell of input.units.partition) {
    cells.set(cell.unitId, {
      rootName: cell.rootName,
      relativePath: cell.relativePath,
      language: languageByPath.get(cell.relativePath) ?? null,
      isResidual: cell.partitionKind === "residual"
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
      channelInputs: {
        codegraphEnvelopeDigest: index.status === "available" ? index.envelopeDigest : null,
        moduleInventoryDigest
      },
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
      .map((selection) => buildSelection(selection.featureKey, selection.trace, cells, index, counted, rowSet.unitKind, modules, routeFactPaths))
  };
}

function canonicalModuleInventory(input: AttributionAssemblyInput["modules"]): DetectedModule[] {
  const modules = input.map((module) => ({ id: module.id, dir: module.dir.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "") }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.dir.localeCompare(b.dir));
  const ids = new Set<string>();
  const dirs = new Set<string>();
  for (const module of modules) {
    if (ids.has(module.id)) throw new Error(`Duplicate CodeGraph module id ${JSON.stringify(module.id)} cannot create one total attribution row`);
    if (dirs.has(module.dir)) throw new Error(`Two CodeGraph modules claim directory ${JSON.stringify(module.dir)}; module attribution would have no single owner`);
    ids.add(module.id);
    dirs.add(module.dir);
  }
  return modules;
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
