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
  channelConfigDigest, channelUnavailable, SELECTION_CHANNELS, WEIGHTS,
  type FeatureSelectionTrace, type RanSelectionTrace, type TraceNode
} from "../src/attribution/selection-trace.ts";
import { pruneFeatureGraph, pruneFeatureGraphRecorded } from "../src/attribution/feature-prune.ts";
import { pruneFeatureGraphWithModuleFloor, pruneFeatureGraphWithModuleFloorRecorded } from "../src/attribution/prune-module-floor.ts";
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
  return {
    nodeId: node.id,
    nodeKind: node.kind,
    name: node.name,
    relativePath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
    outcome,
    score,
    reason: outcome === "rescue" ? "anchor-token access" : "",
    displacedBy: outcome === "displaced" ? "stage1-cut" : null
  };
}

function ranTrace(pool: readonly TraceNode[]): RanSelectionTrace {
  return {
    status: "ran",
    pool: [...pool],
    seedCount: 1,
    budgets: { maxNodes: 180, rescueQuota: 14 },
    stage1CutScore: 220,
    floorDecisions: [{ decision: "no-op-single-module", moduleCount: 1 }]
  };
}

function assemble(layer: Layer3, selections: readonly { featureKey: string; trace: FeatureSelectionTrace }[], overrides: Partial<AttributionAssemblyInput> = {}): AttributionArtifact {
  return assembleAttributionArtifact({
    units: layer.units,
    codegraph: built(layer.envelope),
    countedPaths: layer.counted.map((row) => row.relativePath),
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

const ALL_NODES = [GRANT, REVOKE, GRANT_TWIN, PY_HANDLE, EJS_RENDER, ROUTE];

// --- the projection: every retained node in exactly one visible bucket -----------------------------------------

test("every retained node lands in exactly one visible bucket, and each bucket has its own fixture", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{
    featureKey: "f1",
    // GRANT seated, PY_HANDLE seated in a residual cell, EJS file-not-counted, ROUTE kind-not-inventoried,
    // REVOKE displaced — five nodes, four different outcomes for the retained four.
    trace: ranTrace([
      traced(GRANT, "stage1", 1000),
      traced(PY_HANDLE, "rescue", 220),
      traced(EJS_RENDER, "backfill"),
      traced(ROUTE, "stage1"),
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
  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(PY_HANDLE, "stage1", 220)]) }]);
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
    startLine: null, endLine: null, outcome: "stage1", score: 12, reason: "", displacedBy: null
  };
  // The other road into the bucket: a real structure with real lines that the fixture's index never reported.
  const unreported = traced(graphNode({ id: "n91", kind: "function", name: "neverIndexed", filePath: "src/app.ts", startLine: 7, endLine: 9 }), "stage1");
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

test("two index nodes at one coordinate join by base fact id and seat ONE cell", async () => {
  const layer = await layer3(ALL_NODES);
  const suffixed = layer.envelope.facts.filter((fact) => fact.factId.includes("#"));
  assert.equal(suffixed.length, 1, "the fixture really produces a repeat-suffixed fact id");
  const base = layer.envelope.facts.find((fact) => fact.factId === suffixed[0]!.factId.replace(/#\d+$/, ""));
  assert.ok(base, "and its un-suffixed sibling");
  assert.deepEqual(base.membership, suffixed[0]!.membership, "same coordinates, same cell — which is what makes the base join lossless");

  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "stage1", 1000), traced(GRANT_TWIN, "rescue", 220)]) }]);
  const selection = artifact.selections[0]!;
  assert.equal(selection.projection.retained.seated, 2, "both nodes project");
  assert.equal(selection.seats.length, 2, "one seat ROW per seating decision");
  assert.equal(new Set(selection.seats.map((seat) => seat.unitId)).size, 1, "onto one cell");
  assert.equal(selection.conservation[0]!.totals.seated, 1, "and the conservation counts CELLS, not decisions");
});

test("an unavailable envelope with a non-empty retained set puts every node in envelope-unavailable", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "stage1", 1000), traced(REVOKE, "stage1")]) }], {
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
    trace: ranTrace([traced(GRANT, "stage1", 1000), traced(REVOKE, "displaced"), traced(PY_HANDLE, "rescue", 220)])
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
    trace: ranTrace([traced(GRANT, "stage1", 1000), traced(GRANT_TWIN, "displaced")])
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
  collect(assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "stage1", 1000)]) }]));
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
    () => assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "stage1", 1000)]) }], { codegraph: built(stale) }),
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
    () => assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "stage1", 1000)]) }], { codegraph: built(forged) }),
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
    () => assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "stage1", 1000)]) }], { codegraph: built(forged) }),
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
    trace: ranTrace([traced(GRANT, "stage1", 1000), traced(REVOKE, "displaced"), traced(PY_HANDLE, "rescue", 220)])
  }]);
  const selection = artifact.selections[0]!;
  assert.equal(selection.zeroScore.reduce((sum, group) => sum + group.cells, 0), selection.conservation[0]!.totals.zeroScore);
  assert.ok(selection.zeroScore.every((group) => group.cells > 0), "a zero-count group is a row with no referent");
});

// --- identity ---------------------------------------------------------------------------------------------------

test("the identity is audience-free and moves when a channel weight moves", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "stage1", 1000)]) }]);
  const serialized = JSON.stringify(artifact.identity);
  for (const forbidden of ["outputLanguage", "documents", "audience", "engineering", "product"]) {
    assert.ok(!serialized.includes(forbidden), `the attribution identity must not carry ${forbidden}: ${serialized}`);
  }
  assert.ok(!/"\/[A-Za-z]/.test(JSON.stringify(artifact.identity.runIntentSummary)), "no absolute target path travels in the identity");
  assert.deepEqual(artifact.identity.channels, [...SELECTION_CHANNELS]);
  assert.equal(artifact.identity.channelConfigDigest, channelConfigDigest(WEIGHTS));
  const moved = channelConfigDigest({ ...WEIGHTS, nameTokenExact: WEIGHTS.nameTokenExact + 1 });
  assert.notEqual(moved, artifact.identity.channelConfigDigest, "a changed weight must move the channel identity");
});

test("the artifact re-serializes byte-identically and its digest covers the identity", async () => {
  const layer = await layer3(ALL_NODES);
  const artifact = assemble(layer, [{ featureKey: "f1", trace: ranTrace([traced(GRANT, "stage1", 1000)]) }]);
  assert.equal(serializeAttributionArtifact(built(artifact)), serializeAttributionArtifact(built(artifact)));
  const moved: AttributionArtifact = { ...artifact, identity: { ...artifact.identity, mechanismsDigest: "other" } };
  assert.notEqual(attributionContentDigest(moved), attributionContentDigest(artifact));
});

// --- the selection range: the recorded kernel and the shell decide identically -----------------------------------

/** A multi-module pool with namespaced ids, so the module floor really runs rather than short-circuiting. */
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
    const shell = pruneFeatureGraph(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], maxNodes);
    const recorded = pruneFeatureGraphRecorded(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], maxNodes);
    assert.equal(JSON.stringify({ nodes: recorded.nodes, edges: recorded.edges }), JSON.stringify(shell), `global prune at ${maxNodes}`);

    const floorShell = pruneFeatureGraphWithModuleFloor(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], maxNodes);
    const floorRecorded = pruneFeatureGraphWithModuleFloorRecorded(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], maxNodes);
    assert.equal(JSON.stringify({ nodes: floorRecorded.nodes, edges: floorRecorded.edges }), JSON.stringify(floorShell), `module floor at ${maxNodes}`);
  }
});

test("the trace is a partition of the pool: every candidate carries exactly one channel", () => {
  const pool = syntheticPool();
  const recorded = pruneFeatureGraphWithModuleFloorRecorded(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], 30);
  assert.equal(recorded.trace.pool.length, pool.nodes.length, "the pool is the INPUT set, not the retained one");
  assert.equal(new Set(recorded.trace.pool.map((node) => node.nodeId)).size, pool.nodes.length);
  const retained = new Set(recorded.nodes.map((node) => String(node.id)));
  for (const node of recorded.trace.pool) {
    assert.ok(SELECTION_CHANNELS.includes(node.outcome), `${node.nodeId} carries an unknown channel`);
    assert.equal(node.outcome === "displaced", !retained.has(node.nodeId), `${node.nodeId}'s channel disagrees with the retained set`);
    assert.equal(node.displacedBy === null, node.outcome !== "displaced", `${node.nodeId} must name a budget iff it was displaced`);
  }
});

test("the module floor records a decision per module, including the ones that add nothing", () => {
  const pool = syntheticPool();
  const recorded = pruneFeatureGraphWithModuleFloorRecorded(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], 30);
  const decisions = recorded.trace.floorDecisions;
  assert.equal(decisions.length, 2, "two modules, two decisions");
  for (const decision of decisions) assert.equal(decision.decision, "module-evaluated");
  assert.deepEqual(decisions.map((decision) => decision.decision === "module-evaluated" ? decision.moduleId : null), ["backend", "frontend"]);

  // A single-module pool is the OTHER empty operation, and it is written rather than left as an empty list.
  const single = pruneFeatureGraphWithModuleFloorRecorded(
    pool.nodes.filter((node) => String(node.id).startsWith("backend")),
    pool.edges.filter((edge) => String(edge.source).startsWith("backend") && String(edge.target).startsWith("backend")),
    [pool.nodes[0]], ["leave"], 30
  );
  assert.deepEqual(single.trace.floorDecisions, [{ decision: "no-op-single-module", moduleCount: 1 }]);
});

/**
 * A pool where the floor really adds something: the frontend's rescue candidates carry BOTH anchors (name signal
 * at its 440 cap) and crowd the shared quota, while the backend's `syncLvCompleted` — the 57B-377 node, by name —
 * scores 340 and is displaced globally but rescued when its own module is pruned alone.
 */
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
  // Filler whose PATH carries an anchor but whose NAME carries none: it outranks b0 in Stage 1 without ever
  // becoming a rescue candidate, which is what pushes b0 out of the module-local Stage-1 cut and into rescue.
  for (let i = 2; i < 20; i++) nodes.push({ id: `backend${ID_SEPARATOR}b${i}`, kind: "function", name: `plain${i}`, filePath: `backend/src/leave/u${i}.ts`, signature: "", startLine: i, endLine: i + 3 });
  return { nodes, edges, seeds: [nodes[0]] };
}

test("a floored node's outcome is module-floor, not displaced — the channel census stays a partition", () => {
  const pool = crowdedPool();
  const anchors = ["leave", "holiday"];
  const recorded = pruneFeatureGraphWithModuleFloorRecorded(pool.nodes, pool.edges, pool.seeds, anchors, 16);
  const backendId = `backend${ID_SEPARATOR}b0`;
  const decision = recorded.trace.floorDecisions.find((row) => row.decision === "module-evaluated" && row.moduleId === "backend");
  assert.ok(decision && decision.decision === "module-evaluated" && decision.added.includes(backendId),
    `the floor must record which node it added: ${JSON.stringify(recorded.trace.floorDecisions)}`);
  assert.equal(recorded.nodes.length, 17, "the floor is additive: one node back beyond the 16-node cap");

  const floored = recorded.trace.pool.find((node) => node.nodeId === backendId)!;
  assert.equal(floored.outcome, "module-floor", "the node the floor recovered may not still read as displaced");
  assert.equal(floored.displacedBy, null, "and it lost no budget in the end");
  assert.equal(recorded.trace.pool.filter((node) => node.outcome === "module-floor").length, 1);
  // The un-floored global prune is what it was: the shell over the same kernel returns the same bytes.
  assert.equal(
    JSON.stringify({ nodes: recorded.nodes, edges: recorded.edges }),
    JSON.stringify(pruneFeatureGraphWithModuleFloor(pool.nodes, pool.edges, pool.seeds, anchors, 16))
  );
});

test("the channel weights are the values they had before they were table-ised — this slice moved them, not tuned them", () => {
  // Pinned one by one rather than by digest, because the claim being protected is "every value is unchanged",
  // and a digest golden says only "something moved" while a reviewer still has to go and find what.
  assert.deepEqual({ ...WEIGHTS }, {
    stage1Seed: 1000,
    stage1DirectlyConnected: 120,
    stage1PathTerm: 220,
    stage1NameTerm: 160,
    stage1SignatureTerm: 80,
    stage1CommonPenalty: -180,
    stage1TestBonus: 20,
    nameTokenExact: 220,
    nameSubstring: 160,
    abbrevTokenExact: 220,
    nameSignalCap: 440,
    bridgePerNeighbor: 60,
    bridgeMaxMultiplicity: 3,
    schedulerBonus: 80,
    rescueQuotaMin: 8,
    rescueQuotaMax: 24,
    rescueQuotaFraction: 0.08
  });
});

test("a displaced rescue candidate names the rescue quota, and a never-scored node names the stage-1 cut", () => {
  const pool = syntheticPool();
  const recorded = pruneFeatureGraphRecorded(pool.nodes, pool.edges, pool.seeds, ["leave", "request"], 20);
  const displaced = recorded.trace.pool.filter((node) => node.outcome === "displaced");
  assert.ok(displaced.length > 0, "the fixture really displaces something");
  const byQuota = displaced.filter((node) => node.displacedBy === "rescue-quota");
  const byCut = displaced.filter((node) => node.displacedBy === "stage1-cut");
  assert.ok(byQuota.length > 0, `expected a rescue-quota displacement: ${JSON.stringify(displaced.map((node) => [node.nodeId, node.score, node.displacedBy]))}`);
  assert.ok(byCut.length > 0, "expected a stage1-cut displacement");
  for (const node of byQuota) assert.ok(node.score > 0, "a node that lost the rescue quota had a positive signal");
  for (const node of byCut) assert.equal(node.reason, "", "a node that was never a rescue candidate states no rescue reason");
});
