import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { built, unavailable } from "../src/base/artifact-result.ts";
import { summarizeSelection } from "../src/base/conservation.ts";
import { LANGUAGE_REGISTRY } from "../src/base/language-registry.ts";
import { MECHANISM_REGISTRY } from "../src/base/mechanism-registry.ts";
import { PARTITION_DESIGNATION } from "../src/base/partition-designation.ts";
import type { GraphNode } from "../src/base/types.ts";
import {
  assembleAttributionArtifact, attributionContentDigest, serializeAttributionArtifact,
  SEAT_PROJECTION_MISSES, ZERO_SCORE_REASONS,
  type AttributionArtifact, type AttributionAssemblyInput, type ZeroScoreReason
} from "../src/attribution/attribution-artifact.ts";
import {
  channelConfigDigest, channelUnavailable, RANK_CONSTANT, SELECTION_CHANNELS, WEIGHTS,
  type ContributionChannel, type FeatureSelectionTrace, type RanSelectionTrace, type TraceNode
} from "../src/attribution/selection-trace.ts";
import { allocateFeatureGraph, allocateFeatureGraphRecorded } from "../src/attribution/allocator.ts";
import { ID_SEPARATOR } from "../src/codegraph/codegraph-set.ts";
import type { GraphReader } from "../src/codegraph/codegraph.ts";
import { functionInventory, FUNCTION_INVENTORY_VERSION, inventoryObservations } from "../src/codegraph/function-inventory.ts";
import { buildProducerFactSet, factsOfProducer } from "../src/facts/envelope.ts";
import { loadAstGrep } from "../src/facts/probe/condition-extract.ts";
import { PartitionSkeletonCache } from "../src/facts/units/partition-cache.ts";
import { buildPartition } from "../src/facts/units/partition-build.ts";
import { assembleUnitsArtifact, runObservationPass, unitsContentDigest, type UnitsArtifact } from "../src/facts/units/units-artifact.ts";
import type { CountedRow, FileLedger } from "../src/snapshot/file-ledger.ts";
import { createSnapshot } from "../src/snapshot/snapshot.ts";
import { tempDir } from "./helpers.ts";

/**
 * Layer 4: the seat projection, the five visible buckets, and the three-state selection law.
 *
 * The property this file exists to protect is the one a conservation sum CANNOT protect. `zeroScore` is
 * `counted - seated - displaced`, so a projection that seats nothing balances perfectly — every cell just
 * becomes zero-score. So the tests below are written against the PER-NODE census, and every one of them says
 * which bucket a node landed in rather than only checking that the numbers add up.
 *
 * The fixtures run the REAL layer-3 pipeline (partition build, observation pass, envelope assembly) over a real
 * temp target, because the join under test is `node -> the id the inventory would mint -> the membership layer 3
 * wrote`. A hand-written envelope would let the test agree with a fact-id encoding that production does not use.
 */

const AST_GREP = loadAstGrep();

/**
 * Three structures. `grantAccess` and `revokeAccess` are ones the index reports; `neverIndexed` is deliberately
 * absent from the fixture's node set, so its cell is a structure NO producer observed — which is the only way
 * `structure-unobserved` can be told apart from `structure-not-in-pool`.
 */
const APP_TS = [
  "export function grantAccess() {",   // 1
  "  return true;",                    // 2
  "}",                                 // 3
  "export function revokeAccess() {",  // 4
  "  return false;",                   // 5
  "}",                                 // 6
  "export function neverIndexed() {",  // 7
  "  return 0;",                       // 8
  "}"                                  // 9
].join("\n");

/** Python's designated builder is `file-level`, so this whole file is ONE residual cell and no structure cell. */
const HANDLER_PY = [
  "def handle(request):",  // 1
  "    return request",    // 2
  ""
].join("\n");

/** `.ejs` is not a registered extension, so layer 1 never counts it and no cell exists for it. */
const PAGE_EJS = "<%= title %>\n";

/**
 * A class with a method inside it, on its own target: the ONE shape that separates "which cell does layer 3 say
 * this fact is in" from "which reference unit has the same span as this cell".
 *
 * The class is the file's only structure CELL; the method is a reference unit at depth 2, so no cell anywhere
 * carries its span. An index that reports only the method therefore observes the class's cell — and a
 * coordinate match cannot see that, which is what this fixture pins.
 */
const SERVICE_TS = [
  "export class AccessService {",  // 1
  "  grant() {",                   // 2
  "    return true;",              // 3
  "  }",                           // 4
  "}",                             // 5
  ""
].join("\n");

async function nestedTarget(): Promise<string> {
  const target = await tempDir("excavator-attribution-nested-");
  await mkdir(join(target, "src"), { recursive: true });
  await writeFile(join(target, "src", "service.ts"), SERVICE_TS);
  return target;
}

async function fixtureTarget(): Promise<string> {
  const target = await tempDir("excavator-attribution-target-");
  await mkdir(join(target, "src"), { recursive: true });
  await mkdir(join(target, "views"), { recursive: true });
  await writeFile(join(target, "src", "app.ts"), APP_TS);
  await writeFile(join(target, "src", "handler.py"), HANDLER_PY);
  await writeFile(join(target, "views", "page.ejs"), PAGE_EJS);
  return target;
}

function graphNode(node: Partial<GraphNode> & { id: string; kind: string; name: string; filePath: string; startLine: number; endLine: number }): GraphNode {
  return {
    qualifiedName: node.name,
    language: "typescript",
    startColumn: 0,
    endColumn: 0,
    ...node
  } as GraphNode;
}

/** A reader that answers the ONE query the inventory makes. Everything else throws rather than returning []. */
function readerOver(nodes: readonly GraphNode[]): GraphReader {
  const refuse = (): never => { throw new Error("the attribution fixture's reader answers nodesByKindInFiles only"); };
  return {
    nodesByKindInFiles: (kinds: string[], filePaths: string[]) => {
      const kindSet = new Set(kinds);
      const pathSet = new Set(filePaths);
      return nodes.filter((node) => kindSet.has(node.kind) && pathSet.has(node.filePath));
    },
    metadata: refuse, files: refuse, summary: refuse, representativeNodes: refuse, routeSummary: refuse,
    searchNodes: refuse, searchNodesInFiles: refuse, expand: refuse, edgesAmong: refuse,
    unresolvedForNodeIds: refuse, stats: { queries: 0, hits: 0 }, close: () => {}
  } as unknown as GraphReader;
}

interface Layer3 {
  readonly units: UnitsArtifact;
  readonly envelope: ReturnType<typeof buildProducerFactSet>;
  readonly counted: readonly CountedRow[];
  readonly target: string;
}

/** The real layer-3 pipeline over one fixture target, with the index reporting `nodes`. */
async function layer3(nodes: readonly GraphNode[], targetFactory: () => Promise<string> = fixtureTarget): Promise<Layer3> {
  const target = await targetFactory();
  const cacheDir = await tempDir("excavator-attribution-cache-");
  const { ledger } = await createSnapshot(target, 100_000, { cacheDir });
  const counted = (ledger as FileLedger).counted;
  const build = await buildPartition({
    counted,
    target,
    languages: LANGUAGE_REGISTRY,
    designation: PARTITION_DESIGNATION,
    mechanisms: MECHANISM_REGISTRY,
    astGrep: AST_GREP,
    cache: await PartitionSkeletonCache.open(cacheDir)
  });
  const inventory = functionInventory(readerOver(nodes), counted.map((row) => row.relativePath));
  const facts = inventoryObservations(inventory);
  const pass = await runObservationPass({ target, build, counted, facts });
  const units = assembleUnitsArtifact({
    build,
    mapping: pass.mapping,
    identity: { filesContentManifestDigest: "files-digest", scannerVersion: "scanner-v1", mechanismsDigest: "mechanisms-digest" },
    inheritedCompleteness: { capReached: false, skippedByCap: 0, droppedRoots: [] },
    observationsOffered: facts.length,
    lineIndexReads: pass.lineIndexReads,
    lineIndexReadFailures: pass.lineIndexReadFailures
  });
  const envelope = buildProducerFactSet({
    producer: "codegraph",
    producerVersion: FUNCTION_INVENTORY_VERSION,
    identity: {
      filesContentManifestDigest: "files-digest",
      mechanismsDigest: "mechanisms-digest",
      unitsContentDigest: unitsContentDigest(units),
      configDigest: "config-digest"
    },
    ...factsOfProducer(pass.mapping, "codegraph"),
    producerCompleteness: {}
  });
  return { units, envelope, counted, target };
}

function traced(node: GraphNode, outcome: TraceNode["outcome"], score = 0): TraceNode {
  const sourceChannel: ContributionChannel = outcome === "displaced" ? "fallback" : outcome;
  const contribution = {
    sourceChannel,
    reason: `${sourceChannel} fixture`,
    anchor: sourceChannel === "fallback" ? null : "access",
    propagationPath: [],
    rank: 1,
    normalizedContribution: score
  } as const;
  return {
    nodeId: node.id,
    nodeKind: node.kind,
    name: node.name,
    relativePath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
    outcome,
    score,
    reason: contribution.reason,
    contributions: [contribution],
    displacedBy: outcome === "displaced" ? "seat-cap" : null
  };
}

function ranTrace(pool: readonly TraceNode[], querySeedNodeIds: readonly string[] = []): RanSelectionTrace {
  return {
    status: "ran",
    pool: [...pool],
    seedCount: querySeedNodeIds.length || 1,
    querySeedNodeIds: [...querySeedNodeIds].sort(),
    budgets: { maxNodes: 180 },
    fusion: {
      method: "weighted-reciprocal-rank",
      rankConstant: RANK_CONSTANT,
      rawScoresSummedAcrossChannels: false,
      tieBreak: ["relativePath", "name", "nodeId"],
      cutoffScore: 0.01
    }
  };
}

function assemble(layer: Layer3, selections: readonly { featureKey: string; trace: FeatureSelectionTrace }[], overrides: Partial<AttributionAssemblyInput> = {}): AttributionArtifact {
  return assembleAttributionArtifact({
    units: layer.units,
    codegraph: built(layer.envelope),
    countedPaths: layer.counted.map((row) => row.relativePath),
    modules: [],
    selections,
    identity: {
      filesContentManifestDigest: "files-digest",
      mechanismsDigest: "mechanisms-digest",
      budgets: { maxFeatureNodes: 180, maxExpansionDepth: 2, maxGraphQueries: 70 },
      runIntent: { version: "run-intent-v1", features: [{ key: "f1", subject: "Account access", aliases: ["access"] }] }
    },
    ...overrides
  });
}

async function moduleTarget(): Promise<string> {
  const target = await tempDir("excavator-attribution-modules-");
  await mkdir(join(target, "active"), { recursive: true });
  await mkdir(join(target, "silent"), { recursive: true });
  await writeFile(join(target, "active", "app.ts"), APP_TS);
  await writeFile(join(target, "silent", "worker.ts"), "export function backgroundWorker() {\n  return true;\n}\n");
  return target;
}

// --- the fixture node set, one per middle state ---------------------------------------------------------------

const GRANT = graphNode({ id: "n1", kind: "function", name: "grantAccess", filePath: "src/app.ts", startLine: 1, endLine: 3 });
const REVOKE = graphNode({ id: "n2", kind: "function", name: "revokeAccess", filePath: "src/app.ts", startLine: 4, endLine: 6 });
/** The SAME coordinates as GRANT: the inventory mints `…#2` for it and both must resolve to one cell. */
const GRANT_TWIN = graphNode({ id: "n3", kind: "function", name: "grantAccess", filePath: "src/app.ts", startLine: 1, endLine: 3 });
/** A file-level-partitioned language: its seat is the file's only cell, which is a RESIDUAL one. */
const PY_HANDLE = graphNode({ id: "n4", kind: "function", name: "handle", filePath: "src/handler.py", startLine: 1, endLine: 2, language: "python" });
/** An extension layer 1 never counts, so no cell exists for it at all. */
const EJS_RENDER = graphNode({ id: "n5", kind: "function", name: "render", filePath: "views/page.ejs", startLine: 1, endLine: 1 });
/** A kind the inventory does not claim; it is a role, not a declaration. */
const ROUTE = graphNode({ id: "n6", kind: "route", name: "GET /access", filePath: "src/app.ts", startLine: 1, endLine: 1 });

/** Lives on `nestedTarget` only: a method at depth 2, whose enclosing class the index never reports. */
const SERVICE_GRANT = graphNode({ id: "n7", kind: "method", name: "grant", filePath: "src/service.ts", startLine: 2, endLine: 4 });
const MODULE_GRANT = graphNode({ id: "active\0n1", kind: "function", name: "grantAccess", filePath: "active/app.ts", startLine: 1, endLine: 3 });

const ALL_NODES = [GRANT, REVOKE, GRANT_TWIN, PY_HANDLE, EJS_RENDER, ROUTE];

// --- the projection: every retained node in exactly one visible bucket -----------------------------------------

// SEED IDENTITY IS A RECORDED ID SET, NOT A CHANNEL LABEL.
//
// `allocator.ts` puts a query seed on the `seed` channel — and then puts every node ADJACENT to a seed on the
// same channel, with reason `seed-neighbor`. So `outcome === "seed"` cannot tell "the query named this" from
// "this sits next to something the query named". Layer 5's `seeded` relation authorises reading, so getting
// that distinction wrong authorises reading a neighbour as if it had been asked for.
//
// GRANT is the query seed here; PY_HANDLE also rides the `seed` channel but is not in `querySeedNodeIds`.
test("seedCells holds the query's own seeds and not the neighbours that share their channel", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{
    featureKey: "f1",
    trace: ranTrace([
      traced(GRANT, "seed", 1000),
      traced(PY_HANDLE, "seed", 220)
    ], [GRANT.id])
  }]);
  const selection = artifact.selections[0]!;

  const seatOf = (id: string): string | undefined => selection.seats.find((seat) => seat.name === id)?.unitId;
  const grantCell = seatOf(GRANT.name);
  const neighbourCell = seatOf(PY_HANDLE.name);
  assert.ok(grantCell && neighbourCell, `both nodes must be seated for this test to mean anything: ${JSON.stringify(selection.seats.map((s) => s.name))}`);

  assert.deepEqual(selection.seedCells, [grantCell], "the query seed's cell, and only it");
  assert.ok(!selection.seedCells.includes(neighbourCell!),
    "a seed-neighbor rides the `seed` channel; reading the channel back as identity would put it here");
});

// A DISPLACED SEED HOLDS NO SEAT, SO IT AUTHORISES NO READ.
//
// `seedCells` feeds layer 5's `seeded` relation, which is a read authorisation. Publishing a cell this run
// decided not to seat would authorise reading exactly what the budget rejected.
test("a query seed that lost the budget contributes no seedCell", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{
    featureKey: "f1",
    trace: ranTrace([
      traced(GRANT, "seed", 1000),
      traced(REVOKE, "displaced")
    ], [GRANT.id, REVOKE.id])
  }]);
  const selection = artifact.selections[0]!;

  assert.ok(selection.displacements.length >= 1, "the fixture must actually displace something");

  // The guarantee is NOT "no seedCell appears among the displacements" — measured on wcp, 69 seedCells and
  // 1,577 displacement rows overlap, and correctly so: a cell holds many nodes, and `buildSelection` documents
  // that a cell holding any seat is seated even when another of its nodes lost the budget. Asserting the
  // stronger property would have been asserting a promise the design never made, which `seat-floor.test.ts`
  // already records as how a test starts lying about what is guaranteed.
  //
  // What IS guaranteed: the displaced branch never ADDS a seedCell. So a displaced query seed whose cell holds
  // no seat must be absent — which this fixture arranges by seating GRANT in a different cell.
  const seatedCells = new Set(selection.seats.map((seat) => seat.unitId));
  const displacedOnly = selection.displacements.map((row) => row.unitId).filter((cell) => !seatedCells.has(cell));
  assert.ok(displacedOnly.length >= 1, "the fixture must displace a cell that holds no seat, or it tests nothing");
  for (const cell of displacedOnly) {
    assert.ok(!selection.seedCells.includes(cell),
      `a displaced query seed whose cell won no seat must not be published as seeded: ${cell}`);
  }
  assert.ok(selection.seedCells.every((cell) => seatedCells.has(cell)),
    "and every seedCell holds a seat — the invariant the type comment relies on, asserted where it can fail");
});

test("every retained node lands in exactly one visible bucket, and each bucket has its own fixture", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{
    featureKey: "f1",
    // GRANT seated, PY_HANDLE seated in a residual cell, EJS file-not-counted, ROUTE kind-not-inventoried,
    // REVOKE displaced — five nodes, four different outcomes for the retained four.
    trace: ranTrace([
      traced(GRANT, "seed", 1000),
      traced(PY_HANDLE, "relation", 220),
      traced(EJS_RENDER, "fallback"),
      traced(ROUTE, "seed"),
      traced(REVOKE, "displaced")
    ])
  }]);
  const selection = artifact.selections[0]!;
  assert.deepEqual(selection.projection.retained, {
    nodes: 4,
    seated: 2,
    missCounts: { "envelope-unavailable": 0, "file-not-counted": 1, "kind-not-inventoried": 1, "no-matching-fact": 0 }
  });
  assert.equal(selection.projection.displaced.nodes, 1);
  assert.equal(selection.projection.displaced.seated, 1);
  // The census's own arithmetic is the check the conservation sum cannot make.
  const missed = SEAT_PROJECTION_MISSES.reduce((sum, miss) => sum + selection.projection.retained.missCounts[miss], 0);
  assert.equal(selection.projection.retained.seated + missed, selection.projection.retained.nodes);
});

test("a Python file under a file-level partition seats in its RESIDUAL cell — a residual cell is a real seat", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(PY_HANDLE, "seed", 220)]) }]);
  const seat = artifact.selections[0]!.seats.find((row) => row.relativePath === "src/handler.py");
  assert.ok(seat, `expected a seat in the python file: ${JSON.stringify(artifact.selections[0]!.seats)}`);
  assert.match(seat.unitId, /^cell:residual:/);
  const cell = layer.units.partition.find((row) => row.unitId === seat.unitId);
  assert.equal(cell?.partitionKind, "residual", "the python file's only cell is residual, and it holds a seat");
  assert.equal(artifact.selections[0]!.projection.retained.missCounts["no-matching-fact"], 0);
});

test("no-matching-fact has both its fixtures: a node with no line range, and a structure the index never reported", async () => {
  const layer = await layer3(ALL_NODES);
  // An inventoried kind in a counted file, and NO line range: `inventoryFactIdFor` mints nothing, so layer 3
  // published no fact to join against. The bucket is the same one an unpublished fact lands in, and it has to be
  // reachable — `TraceNode.startLine` is nullable precisely because the index really reports rows like this.
  const noLineRange: TraceNode = {
    nodeId: "n90", nodeKind: "function", name: "grantAccess", relativePath: "src/app.ts",
    startLine: null, endLine: null, outcome: "seed", score: 12, reason: "seed fixture",
    contributions: [{ sourceChannel: "seed", reason: "seed fixture", anchor: "access", propagationPath: [], rank: 1, normalizedContribution: 12 }],
    displacedBy: null
  };
  // The other road into the bucket: a real structure with real lines that the fixture's index never reported.
  const unreported = traced(graphNode({ id: "n91", kind: "function", name: "neverIndexed", filePath: "src/app.ts", startLine: 7, endLine: 9 }), "seed");
  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([noLineRange, unreported]) }]);
  const selection = artifact.selections[0]!;
  assert.deepEqual(selection.projection.retained, {
    nodes: 2,
    seated: 0,
    missCounts: { "envelope-unavailable": 0, "file-not-counted": 0, "kind-not-inventoried": 0, "no-matching-fact": 2 }
  });
  assert.deepEqual(selection.seats, [], "neither node reached a cell, so neither may appear as a seat");
});

test("a cell whose only observation is a NESTED structure reads as not-in-pool, not as unobserved", async () => {
  const layer = await layer3([SERVICE_GRANT], nestedTarget);
  // The premise, stated before the assertion: layer 3 filed the method's fact in the CLASS's cell, and the
  // method's own reference unit is nested, so no cell in this partition carries its span.
  const fact = layer.envelope.facts.find((row) => row.detail.name === "grant");
  assert.ok(fact && fact.membership.kind === "unit", `the fixture must produce one method fact: ${JSON.stringify(layer.envelope.facts)}`);
  const cell = layer.units.partition.find((row) => row.unitId === (fact.membership as { unitId: string }).unitId);
  assert.equal(cell?.partitionKind, "structure");
  assert.equal(cell?.unitKind, "class", "the cell is the outermost structure; the method lives inside it");
  const method = layer.units.refUnits.find((unit) => unit.unitKind === "method");
  assert.ok(method, "the builder found the method as a reference unit");
  assert.deepEqual(method.observedBy, ["codegraph"], "and the observation attached to THAT unit, not to the class");
  assert.ok(method.depth !== null && method.depth >= 2, `nested, so its span is no cell's span: depth ${method.depth}`);
  assert.notDeepEqual(method.span, cell!.span, "which is exactly what a span-tuple join loses");

  const selection = assemble(layer, [{ featureKey: "f1", trace: ranTrace([]) }]).selections[0]!;
  const reasons = selection.zeroScore.map((group) => group.reason);
  assert.ok(!reasons.includes("structure-unobserved"),
    `the index filed a fact in this file's only structure cell, so nothing here is unobserved: ${JSON.stringify(selection.zeroScore)}`);
  assert.ok(reasons.includes("structure-not-in-pool"),
    `the cell is observed and this feature never pooled it, which is a scope answer: ${JSON.stringify(selection.zeroScore)}`);
});

test("adding indexed-route facts cannot perturb allocation; only the observed zero-score label may move", async () => {
  const layer = await layer3(ALL_NODES);
  const neverIndexed = layer.units.partition
    .filter((cell) => cell.relativePath === "src/app.ts" && cell.partitionKind === "structure")
    .sort((a, b) => a.span.startByte - b.span.startByte).at(-1);
  assert.ok(neverIndexed, "the fixture must expose the unobserved neverIndexed structure cell");
  const routeFact = {
    factId: "route:src/routes.ts:1-1:GET /access",
    kind: "indexed-route" as const,
    membership: { kind: "unit" as const, unitId: neverIndexed.unitId },
    detail: { name: "GET /access", handlerResolved: true, handlerFactId: "function:src/app.ts:7-9:neverIndexed" }
  };
  const enrichedEnvelope = {
    ...layer.envelope,
    facts: [...layer.envelope.facts, routeFact].sort((a, b) => a.kind.localeCompare(b.kind) || a.factId.localeCompare(b.factId))
  };
  const selections = [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "seed", 1000)]) }];
  const before = assemble(layer, selections);
  const after = assemble(layer, selections, { codegraph: built(enrichedEnvelope) });
  const beforeSelection = before.selections[0]!;
  const afterSelection = after.selections[0]!;

  assert.deepEqual({
    seats: afterSelection.seats,
    displacements: afterSelection.displacements,
    conservation: afterSelection.conservation,
    projection: afterSelection.projection,
    modules: afterSelection.modules,
    channels: afterSelection.channels
  }, {
    seats: beforeSelection.seats,
    displacements: beforeSelection.displacements,
    conservation: beforeSelection.conservation,
    projection: beforeSelection.projection,
    modules: beforeSelection.modules,
    channels: beforeSelection.channels
  }, "the same selection trace produces the same allocation when route facts are added");

  const byReason = (artifact: AttributionArtifact): Map<ZeroScoreReason, number> => {
    const counts = new Map<ZeroScoreReason, number>();
    for (const group of artifact.selections[0]!.zeroScore) counts.set(group.reason, (counts.get(group.reason) ?? 0) + group.cells);
    return counts;
  };
  const beforeReasons = byReason(before);
  const afterReasons = byReason(after);
  for (const reason of ZERO_SCORE_REASONS.filter((value) => value !== "structure-unobserved" && value !== "structure-not-in-pool")) {
    assert.equal(afterReasons.get(reason) ?? 0, beforeReasons.get(reason) ?? 0, reason);
  }
  assert.equal((beforeReasons.get("structure-unobserved") ?? 0) - (afterReasons.get("structure-unobserved") ?? 0), 1);
  assert.equal((afterReasons.get("structure-not-in-pool") ?? 0) - (beforeReasons.get("structure-not-in-pool") ?? 0), 1);
  assert.notEqual(after.identity.channelInputs.codegraphEnvelopeDigest, before.identity.channelInputs.codegraphEnvelopeDigest,
    "the identity records the changed envelope even though the allocation is non-perturbed");
});

test("two index nodes at one coordinate join by base fact id and seat ONE cell", async () => {
  const layer = await layer3(ALL_NODES);
  const suffixed = layer.envelope.facts.filter((fact) => fact.factId.includes("#"));
  assert.equal(suffixed.length, 1, "the fixture really produces a repeat-suffixed fact id");
  const base = layer.envelope.facts.find((fact) => fact.factId === suffixed[0]!.factId.replace(/#\d+$/, ""));
  assert.ok(base, "and its un-suffixed sibling");
  assert.deepEqual(base.membership, suffixed[0]!.membership, "same coordinates, same cell — which is what makes the base join lossless");

  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "seed", 1000), traced(GRANT_TWIN, "relation", 220)]) }]);
  const selection = artifact.selections[0]!;
  assert.equal(selection.projection.retained.seated, 2, "both nodes project");
  assert.equal(selection.seats.length, 2, "one seat ROW per seating decision");
  assert.equal(new Set(selection.seats.map((seat) => seat.unitId)).size, 1, "onto one cell");
  assert.equal(selection.conservation[0]!.totals.seated, 1, "and the conservation counts CELLS, not decisions");
});

test("an unavailable envelope with a non-empty retained set puts every node in envelope-unavailable", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "seed", 1000), traced(REVOKE, "seed")]) }], {
    codegraph: unavailable("index-not-present: this run resolved no readable CodeGraph database", true)
  });
  const selection = artifact.selections[0]!;
  assert.deepEqual(selection.projection.retained.missCounts, {
    "envelope-unavailable": 2, "file-not-counted": 0, "kind-not-inventoried": 0, "no-matching-fact": 0
  });
  assert.equal(selection.seats.length, 0);
  assert.equal(artifact.identity.channelInputs.codegraphEnvelopeDigest, null, "an envelope that was not read is not in the identity");
  // Nothing was seated, so every cell is zero-score — and it says the channels had no input, not that the
  // selection never ran. The two are different facts and the reason vocabulary keeps them apart.
  assert.deepEqual([...new Set(selection.zeroScore.map((group) => group.reason))], ["channels-unavailable"]);
  assert.equal(selection.conservation[0]!.totals.zeroScore, layer.units.partition.length);
});

test("partial contribution: some cells hold a seat, some are displaced, the rest name their zero-score reason", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{
    featureKey: "f1",
    trace: ranTrace([traced(GRANT, "seed", 1000), traced(REVOKE, "displaced"), traced(PY_HANDLE, "relation", 220)])
  }]);
  const selection = artifact.selections[0]!;
  const totals = selection.conservation[0]!.totals;
  assert.equal(totals.seated, 2, "app.ts's grantAccess cell and handler.py's residual cell");
  assert.equal(totals.displaced, 1, "app.ts's revokeAccess cell lost the budget");
  assert.equal(totals.counted, layer.units.partition.length);
  assert.equal(totals.seated + totals.zeroScore + totals.displaced, totals.counted);
  const reasons = new Set(selection.zeroScore.map((group) => group.reason));
  assert.ok(reasons.has("residual-no-channel-contribution"), `expected a residual reason: ${JSON.stringify(selection.zeroScore)}`);
  assert.ok(!reasons.has("channels-unavailable"), "the channels ran, so that reason may not appear");
});

test("a seated cell is never also counted as displaced, even when both a seated and a displaced node point at it", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{
    featureKey: "f1",
    // Both nodes have the SAME coordinates, so they resolve to one cell; one is retained, one is displaced.
    trace: ranTrace([traced(GRANT, "seed", 1000), traced(GRANT_TWIN, "displaced")])
  }]);
  const selection = artifact.selections[0]!;
  assert.equal(selection.conservation[0]!.totals.seated, 1);
  assert.equal(selection.conservation[0]!.totals.displaced, 0, "seated wins the precedence, so the cell is not double-counted");
  assert.equal(selection.displacements.length, 1, "the displacement DECISION is still recorded — the row is not deleted");
});

test("every zero-score reason has a fixture: the vocabulary may not contain a state nothing can produce", async () => {
  const layer = await layer3(ALL_NODES);
  const produced = new Set<ZeroScoreReason>();
  const collect = (artifact: AttributionArtifact): void => {
    for (const selection of artifact.selections) for (const group of selection.zeroScore) produced.add(group.reason);
  };
  // Channels never ran.
  collect(assemble(layer, [{ featureKey: "f1", trace: channelUnavailable("no-graph") }]));
  // Channels ran and reached one structure: the other structure is observed but not pooled, the python file's
  // residual cell contributed nothing, and a file the index knows nothing about is unobserved.
  collect(assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "seed", 1000)]) }]));
  assert.deepEqual([...produced].sort(), [...ZERO_SCORE_REASONS].sort());
});

test("a run with no feature publishes featureCount 0 and no selection, never a fabricated one", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, []);
  assert.equal(artifact.featureCount, 0);
  assert.deepEqual(artifact.selections, []);
  assert.equal(artifact.denominator.cells, layer.units.partition.length, "the denominator is still stated");
});

// --- the refusals: each check goes red when its premise is broken ----------------------------------------------

test("an envelope from another partition generation is refused, not joined against", async () => {
  const layer = await layer3(ALL_NODES);
  const stale = { ...layer.envelope, identity: { ...layer.envelope.identity, unitsContentDigest: "a-different-generation" } };
  assert.throws(
    () => assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "seed", 1000)]) }], { codegraph: built(stale) }),
    /another partition generation|partition generation/,
    "a stale envelope must throw rather than silently seat nothing"
  );
});

test("two memberships under one base fact id are refused rather than averaged", async () => {
  const layer = await layer3(ALL_NODES);
  const twin = layer.envelope.facts.find((fact) => fact.factId.includes("#"))!;
  const forged = {
    ...layer.envelope,
    facts: layer.envelope.facts.map((fact) => fact === twin
      ? { ...fact, membership: { kind: "unit" as const, unitId: "cell:structure:0-1:src/app.ts" } }
      : fact)
  };
  assert.throws(
    () => assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "seed", 1000)]) }], { codegraph: built(forged) }),
    /two memberships/
  );
});

test("a same-generation envelope whose membership names a cell outside the partition is refused, not skipped", async () => {
  const layer = await layer3(ALL_NODES);
  // The generation check cannot see this one: the digest IS this run's, and every membership is individually
  // well-formed. What is broken is the JOIN — and the same dangling id on every fact keeps the two-memberships
  // check from firing first, which is exactly how a probe reached the silent path.
  const dangling = "cell:structure:0-1:src/nowhere.ts";
  const forged = {
    ...layer.envelope,
    facts: layer.envelope.facts.map((fact) => ({ ...fact, membership: { kind: "unit" as const, unitId: dangling } }))
  };
  assert.equal(forged.identity.unitsContentDigest, unitsContentDigest(layer.units), "same generation: the digest check passes");
  assert.equal(layer.units.partition.some((cell) => cell.unitId === dangling), false, "and no cell of this partition carries that id");

  // Silently skipping this published three contradictory answers at once: the census said one node was seated,
  // `seats` held no row, and conservation said nothing was seated. Both arms of the projection must refuse it.
  assert.throws(
    () => assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "seed", 1000)]) }], { codegraph: built(forged) }),
    /is not a cell of this run's partition/,
    "a retained node joined to a cell that does not exist must stop the artifact"
  );
  assert.throws(
    () => assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "displaced")]) }], { codegraph: built(forged) }),
    /is not a cell of this run's partition/,
    "and so must a displaced one — the displacement census counts it as projected before the cell is read"
  );
});

test("the conservation constructor refuses an imbalance, and the compressed zero-score loses no cell", async () => {
  // The constructor is a real refusal, checked directly: the artifact builder cannot reach it, because
  // `zeroScore` arrives as the complement and the seated / displaced sets are subsets of the partition. That is
  // the design — an imbalance is unconstructible here — so the guard is pinned where it CAN be exercised.
  assert.throws(() => summarizeSelection({ counted: 10, seated: 4, zeroScore: 4, displaced: 4 }), /Selection conservation is broken/);
  assert.throws(() => summarizeSelection({ counted: 10, seated: -1, zeroScore: 7, displaced: 4 }), /A conservation term/);

  // And the compression is lossless: the per-(module x language x reason) counts add back up to the sum the
  // conservation states, so publishing groups instead of rows hides no cell.
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{
    featureKey: "f1",
    trace: ranTrace([traced(GRANT, "seed", 1000), traced(REVOKE, "displaced"), traced(PY_HANDLE, "relation", 220)])
  }]);
  const selection = artifact.selections[0]!;
  assert.equal(selection.zeroScore.reduce((sum, group) => sum + group.cells, 0), selection.conservation[0]!.totals.zeroScore);
  assert.ok(selection.zeroScore.every((group) => group.cells > 0), "a zero-count group is a row with no referent");
});

test("the module census is total: a zero-signal module keeps its denominator row and receives no seat", async () => {
  const layer = await layer3([MODULE_GRANT], moduleTarget);
  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(MODULE_GRANT, "seed", 1)]) }], {
    modules: [{ id: "silent", dir: "silent" }, { id: "active", dir: "active" }]
  });
  const rows = artifact.selections[0]!.modules;
  assert.deepEqual(rows.map((row) => row.moduleId), ["active", "silent"], "module inventory order is canonical");
  assert.equal(rows[0]!.status, "seated");
  assert.ok(rows[0]!.denominatorCells > 0);
  assert.equal(rows[0]!.poolNodes, 1);
  assert.equal(rows[0]!.seatedCells, 1);
  assert.equal(rows[0]!.soleSourceSeats, 1);
  assert.equal(rows[1]!.status, "zero-signal");
  assert.ok(rows[1]!.denominatorCells > 0, "the silent module still names its semantic denominator");
  assert.equal(rows[1]!.poolNodes, 0);
  assert.equal(rows[1]!.retainedNodes, 0);
  assert.equal(rows[1]!.seatedCells, 0, "M6 gives a silent module a row, never a forced seat");
  assert.throws(
    () => assemble(layer, [], { modules: [{ id: "duplicate", dir: "active" }, { id: "duplicate", dir: "silent" }] }),
    /Duplicate CodeGraph module id/
  );

  const rootLayer = await layer3([GRANT]);
  const root = assemble(rootLayer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "seed", 1)]) }], {
    modules: [{ id: ".", dir: "" }]
  }).selections[0]!.modules;
  assert.equal(root.length, 1, "a single CodeGraph is still one inventoried module, not an empty census");
  assert.equal(root[0]!.moduleId, ".");
  assert.ok(root[0]!.denominatorCells > 0);
  assert.equal(root[0]!.poolNodes, 1);
  assert.equal(root[0]!.seatedCells, 1);
});

// --- identity ---------------------------------------------------------------------------------------------------

test("the identity is audience-free and moves when a channel weight moves", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "seed", 1000)]) }]);
  const serialized = JSON.stringify(artifact.identity);
  for (const forbidden of ["outputLanguage", "documents", "audience", "engineering", "product"]) {
    assert.ok(!serialized.includes(forbidden), `the attribution identity must not carry ${forbidden}: ${serialized}`);
  }
  assert.ok(!/"\/[A-Za-z]/.test(JSON.stringify(artifact.identity.runIntentSummary)), "no absolute target path travels in the identity");
  assert.deepEqual(artifact.identity.channels, [...SELECTION_CHANNELS]);
  assert.equal(artifact.identity.channelConfigDigest, channelConfigDigest(WEIGHTS));
  const moved = channelConfigDigest({ ...WEIGHTS, lexical: WEIGHTS.lexical + 1 });
  assert.notEqual(moved, artifact.identity.channelConfigDigest, "a changed weight must move the channel identity");
});

test("the artifact re-serializes byte-identically and its digest covers the identity", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "seed", 1000)]) }]);
  assert.equal(serializeAttributionArtifact(built(artifact)), serializeAttributionArtifact(built(artifact)));
  const moved: AttributionArtifact = { ...artifact, identity: { ...artifact.identity, mechanismsDigest: "other" } };
  assert.notEqual(attributionContentDigest(moved), attributionContentDigest(artifact));
});

// --- the selection range: the recorded kernel and the shell decide identically -----------------------------------

/** A multi-module pool with namespaced ids, so cross-module competition is exercised under one cap. */
function syntheticPool(): { nodes: any[]; edges: any[]; seeds: any[] } {
  const nodes: any[] = [];
  const edges: any[] = [];
  for (const module of ["backend", "frontend"]) {
    for (let i = 0; i < 40; i++) {
      nodes.push({
        id: `${module}${ID_SEPARATOR}n${i}`,
        kind: i % 7 === 0 ? "import" : i % 5 === 0 ? "class" : "function",
        name: i % 3 === 0 ? `syncLeaveRequest${i}` : `helper${i}`,
        filePath: `${module}/src/${i % 4 === 0 ? "crons" : "lib"}/file${i}.ts`,
        signature: `(input: Leave${i}) => void`,
        startLine: i + 1,
        endLine: i + 9
      });
    }
    for (let i = 1; i < 40; i++) {
      edges.push({ source: `${module}${ID_SEPARATOR}n${i}`, target: `${module}${ID_SEPARATOR}n${i - 1}`, kind: "calls", line: i });
      if (i % 6 === 0) edges.push({ source: `${module}${ID_SEPARATOR}n0`, target: `${module}${ID_SEPARATOR}n${i}`, kind: "calls", line: i * 2 });
    }
  }
  return { nodes, edges, seeds: [nodes[0], nodes[41]] };
}

test("the recorded kernel and the trace-free shell return byte-identical node and edge sets", () => {
  const pool = syntheticPool();
  for (const maxNodes of [12, 40, 200]) {
    const shell = allocateFeatureGraph(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], maxNodes);
    const recorded = allocateFeatureGraphRecorded(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], maxNodes);
    assert.equal(JSON.stringify({ nodes: recorded.nodes, edges: recorded.edges }), JSON.stringify(shell), `allocator at ${maxNodes}`);
  }
});

test("the trace is a partition of the pool: every candidate carries exactly one channel", () => {
  const pool = syntheticPool();
  const recorded = allocateFeatureGraphRecorded(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], 30);
  assert.equal(recorded.trace.pool.length, pool.nodes.length, "the pool is the INPUT set, not the retained one");
  assert.equal(new Set(recorded.trace.pool.map((node) => node.nodeId)).size, pool.nodes.length);
  const retained = new Set(recorded.nodes.map((node) => String(node.id)));
  for (const node of recorded.trace.pool) {
    assert.ok(SELECTION_CHANNELS.includes(node.outcome), `${node.nodeId} carries an unknown channel`);
    assert.equal(node.outcome === "displaced", !retained.has(node.nodeId), `${node.nodeId}'s channel disagrees with the retained set`);
    assert.equal(node.displacedBy === null, node.outcome !== "displaced", `${node.nodeId} must name a budget iff it was displaced`);
  }
});

test("every producer contribution carries the complete explanation contract", () => {
  const pool = syntheticPool();
  const recorded = allocateFeatureGraphRecorded(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], 30);
  for (const row of recorded.trace.pool) for (const contribution of row.contributions) {
    assert.ok(contribution.sourceChannel);
    assert.ok(contribution.reason);
    assert.ok(Array.isArray(contribution.propagationPath));
    assert.equal(contribution.anchor === null, contribution.sourceChannel === "fallback");
  }
});

/** A crowded pool where one module can consume nearly the whole cap; there is deliberately no hidden floor. */
function crowdedPool(): { nodes: any[]; edges: any[]; seeds: any[] } {
  const nodes: any[] = [];
  const edges: any[] = [];
  for (let i = 0; i < 40; i++) {
    nodes.push({ id: `frontend${ID_SEPARATOR}f${i}`, kind: "function", name: `leaveHolidayWidget${i}`, filePath: `frontend/src/leave/holiday/widget${i}.ts`, signature: "", startLine: i + 1, endLine: i + 5 });
  }
  nodes.push({ id: `backend${ID_SEPARATOR}b0`, kind: "function", name: "syncLvCompleted", filePath: "backend/src/svc/sync.ts", signature: "", startLine: 1, endLine: 9 });
  nodes.push({ id: `backend${ID_SEPARATOR}b1`, kind: "function", name: "holidayCalendar", filePath: "backend/src/svc/cal.ts", signature: "", startLine: 1, endLine: 9 });
  edges.push({ source: `backend${ID_SEPARATOR}b0`, target: `backend${ID_SEPARATOR}b1`, kind: "calls", line: 3 });
  edges.push({ source: `backend${ID_SEPARATOR}b0`, target: `backend${ID_SEPARATOR}b1`, kind: "calls", line: 4 });
  // Filler whose path carries an anchor but whose name carries none; it exercises deterministic lexical rank.
  for (let i = 2; i < 20; i++) nodes.push({ id: `backend${ID_SEPARATOR}b${i}`, kind: "function", name: `plain${i}`, filePath: `backend/src/leave/u${i}.ts`, signature: "", startLine: i, endLine: i + 3 });
  return { nodes, edges, seeds: [nodes[0]] };
}

test("the allocator never adds a hidden additive seat beyond the one cap", () => {
  const pool = crowdedPool();
  const anchors = ["leave", "holiday"];
  const recorded = allocateFeatureGraphRecorded(pool.nodes, pool.edges, pool.seeds, anchors, 16);
  assert.equal(recorded.nodes.length, 16);
  assert.equal(recorded.trace.pool.filter((node) => node.outcome !== "displaced").length, 16);
  for (const node of recorded.trace.pool) assert.equal(node.displacedBy, node.outcome === "displaced" ? "seat-cap" : null);
});

test("the preregistered fusion weights are pinned", () => {
  assert.deepEqual({ ...WEIGHTS }, {
    seed: 1,
    lexical: 1,
    derived: 1,
    relation: 1,
    convention: 1,
    fallback: 0.25
  });
});

test("every displaced candidate names the single seat cap", () => {
  const pool = syntheticPool();
  const recorded = allocateFeatureGraphRecorded(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], 20);
  const displaced = recorded.trace.pool.filter((node) => node.outcome === "displaced");
  assert.ok(displaced.length > 0, "the fixture really displaces something");
  for (const node of displaced) {
    assert.equal(node.displacedBy, "seat-cap");
    assert.ok(node.contributions.some((item) => item.sourceChannel === "fallback"));
  }
});
