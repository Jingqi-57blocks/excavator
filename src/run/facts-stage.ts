import { join } from "node:path";
import { built, unavailable, type ArtifactResult, type NotApplicable, type Unavailable } from "../base/artifact-result.ts";
import { ARTIFACT_REGISTRY } from "../base/artifact-registry.ts";
import { LANGUAGE_REGISTRY } from "../base/language-registry.ts";
import { MECHANISM_REGISTRY, type MechanismAvailabilityMap } from "../base/mechanism-registry.ts";
import { PARTITION_DESIGNATION } from "../base/partition-designation.ts";
import { atomicWrite, Deadline, sha256, stableJson } from "../base/util.ts";
import { CodeGraphIndex, type GraphReader } from "../codegraph/codegraph.ts";
import { CodeGraphSet } from "../codegraph/codegraph-set.ts";
import { FUNCTION_INVENTORY_LIMIT, FUNCTION_INVENTORY_VERSION, functionInventory, INVENTORY_NODE_KINDS, inventoryObservations } from "../codegraph/function-inventory.ts";
import {
  CROSSREPO_FACTS_VERSION, crossRepoCompleteness, crossRepoConfigDigest, crossRepoDetermination, crossRepoObservations,
  type CrossRepoModule
} from "../crossrepo/crossrepo-facts.ts";
import type { CrossRepoScan } from "../crossrepo/crossrepo-scan.ts";
import { buildProducerFactSet, factsOfProducer, serializeProducerFactSet, type ProducerFactSet } from "../facts/envelope.ts";
import { loadAstGrep } from "../facts/probe/condition-extract.ts";
import type { FactDetail, MappingResult, ObservedFact } from "../facts/units/membership-map.ts";
import { PartitionSkeletonCache } from "../facts/units/partition-cache.ts";
import { buildPartition, designatedBuilderGate } from "../facts/units/partition-build.ts";
import {
  assembleUnitsArtifact, runObservationPass, serializeUnitsArtifact, unitsContentDigest, type UnitsArtifact
} from "../facts/units/units-artifact.ts";
import type { FileLedger } from "../snapshot/file-ledger.ts";

/**
 * Layer 3, wired into prepare: build `facts/units.json`, then one envelope per registered producer.
 *
 * It lives in the orchestration layer for the same reason `mechanism-availability.ts` does — deciding WHICH
 * producers a run has is not a layer-3 question, and letting layer 3 ask would give it an upward reach into every
 * tool. Layer 3 gets its inputs handed to it: the counted rows, the layer-2 ledger's digest, the availability map,
 * and whatever the run resolved for the index and the module set.
 *
 * THE INVARIANT THAT MAKES `enforced` HONEST: this stage produces all eight records unconditionally, on the
 * success path and on the failure path alike (`unavailableFactsStage`), and one writer puts them on disk. The
 * registry may therefore say a missing envelope is a finding, which is what turns P16 — a tool sitting outside
 * the pipeline with no check going red — into a check.
 *
 * THE ORDER IS FORCED, and it is worth naming because it looks like it could be relaxed: the observation pass
 * needs the partition (a membership names cells), and every envelope's identity needs `unitsContentDigest` (a
 * membership row is only meaningful against one partition generation). So: partition, observations, units digest,
 * envelopes. A producer envelope written before the units digest existed would be an envelope that cannot say
 * which cells its facts point at.
 */

/** Every registered layer-3 producer id, so a new producer cannot be added without an envelope decision here. */
const PRODUCER_IDS: readonly string[] = ARTIFACT_REGISTRY.producers.map((producer) => producer.id);

/**
 * The inventory's own query budget.
 *
 * `nodesByKindInFiles` batches the file list 300 at a time, so a 3,000-file target costs ten queries per module
 * database. 400 is therefore generous by two orders of magnitude, and it is separate from the caller's
 * `--max-graph-queries` on purpose: layer 3's enumeration must not consume the budget a feature was given, or the
 * inventory's completeness would depend on how many queries a feature happened to run — a feature-shaped input to
 * a layer whose identity may not contain a feature key.
 */
const INVENTORY_QUERY_BUDGET = 400;

export interface FactsStageResult {
  readonly units: ArtifactResult<UnitsArtifact>;
  /** One entry per registered producer. Checked against the registry before anything is written. */
  readonly producers: Readonly<Record<string, ArtifactResult<ProducerFactSet>>>;
  readonly warnings: readonly string[];
}

export interface FactsStageInput {
  readonly target: string;
  readonly ledger: FileLedger;
  /** `ledger/mechanisms.json`'s content digest, so layer 3's identity names the layer-2 ledger it read (§一). */
  readonly mechanismsDigest: string;
  readonly availability: MechanismAvailabilityMap;
  /** The single-database path this run resolved, if any. */
  readonly codegraphPath: string | undefined;
  /** The per-module databases this run resolved, if any. Presence of this decides single database vs. set. */
  readonly codegraphModules: ReadonlyArray<{ readonly id: string; readonly dir: string; readonly path: string }> | undefined;
  /** The index's own content digest, part of the codegraph producer's configuration identity. */
  readonly codegraphDigest: string | null | undefined;
  readonly crossRepoScan: CrossRepoScan | null;
  /**
   * The project cache directory, or `null` to run without a cache.
   *
   * Not optional. Production always has one, so a parameter that could be omitted would let a test exercise a path
   * production never takes — slice 1's false green, exactly.
   */
  readonly cacheDir: string | null;
}

/**
 * What a producer contributed, or why it contributed nothing.
 *
 * A union rather than a pair of nullable locals: the envelope is assembled after the units digest exists, and
 * "observed, so there is a configuration digest and a completeness record" has to be inseparable from "did not
 * observe, so there is an envelope instead". Two `let`s would let one be set without the other.
 */
type ProducerPlan =
  | { readonly status: "observed"; readonly producerVersion: string; readonly configDigest: string; readonly completeness: FactDetail }
  | { readonly status: "absent"; readonly envelope: Unavailable | NotApplicable };

export async function buildFactsStage(input: FactsStageInput): Promise<FactsStageResult> {
  const warnings: string[] = [];
  const counted = input.ledger.counted;
  const inheritedCompleteness = {
    capReached: input.ledger.completeness.capReached,
    skippedByCap: input.ledger.completeness.skippedByCap,
    droppedRoots: input.ledger.completeness.droppedRoots
  };

  // The ONE place availability enters the partition story. If a counted file's designated builder cannot run, the
  // whole envelope is `Unavailable` — never a quietly coarser partition, which would make the denominator a
  // function of which optional binding loaded (§一, "分区由指定构建器产出，观察者不得改分区").
  const gate = designatedBuilderGate(counted, input.availability, LANGUAGE_REGISTRY, PARTITION_DESIGNATION);
  if (gate) return allUnavailable(gate, gate.cause, gate.retryable);

  const build = await buildPartition({
    counted,
    target: input.target,
    languages: LANGUAGE_REGISTRY,
    designation: PARTITION_DESIGNATION,
    mechanisms: MECHANISM_REGISTRY,
    astGrep: loadAstGrep(),
    cache: await PartitionSkeletonCache.open(input.cacheDir)
  });

  // --- the observers, each contributing observations and its own plan ---------------------------------------
  const facts: ObservedFact[] = [];
  const codegraph = collectCodegraph(input, facts, warnings);
  const modules: CrossRepoModule[] = (input.codegraphModules ?? []).map((module) => ({ id: module.id, dir: module.dir }));
  const crossrepo = collectCrossRepo(input, modules, facts, inheritedCompleteness);

  // --- one mapping pass over EVERY observation, then the artifact -------------------------------------------
  // One pass and not one per producer, because `observedBy` is a merge across producers: a per-producer pass could
  // not see that the index and the route recovery are looking at the same function.
  const pass = await runObservationPass({ target: input.target, build, counted, facts });
  const units = assembleUnitsArtifact({
    build,
    mapping: pass.mapping,
    identity: {
      filesContentManifestDigest: input.ledger.contentManifestDigest,
      scannerVersion: input.ledger.scannerVersion,
      mechanismsDigest: input.mechanismsDigest
    },
    inheritedCompleteness,
    observationsOffered: facts.length,
    lineIndexReads: pass.lineIndexReads,
    lineIndexReadFailures: pass.lineIndexReadFailures
  });
  const envelopeIdentity = {
    filesContentManifestDigest: input.ledger.contentManifestDigest,
    mechanismsDigest: input.mechanismsDigest,
    unitsContentDigest: unitsContentDigest(units)
  };

  const producers: Record<string, ArtifactResult<ProducerFactSet>> = {
    // Policy skips, spelled the way §四 requires: no consumer branches on "we chose not to", so it is a cause on
    // `Unavailable` rather than a fourth state. Each says what would have to change, not merely that it is absent.
    "probe": unavailable("policy: decision probes run per feature inside context preparation today, so there is no run-scoped, feature-free fact set to publish", false),
    "vocabulary": unavailable("not-implemented: no in-repository term frequency is computed anywhere in this engine today", false),
    "native-graph": unavailable("policy: not-run-scoped — the native tree-sitter graph runs as its own command and writes outside the run directory", true),
    "framework": unavailable("policy: not-run-scoped — framework convention recovery runs as its own command and writes outside the run directory", true),
    "db-schema": unavailable("policy: not-run-scoped — schema discovery runs as its own command and writes outside the run directory", true),
    "codegraph": envelopeFor("codegraph", codegraph, pass.mapping, envelopeIdentity),
    "crossrepo": envelopeFor("crossrepo", crossrepo, pass.mapping, envelopeIdentity)
  };
  return { units: built(units), producers: requireEveryProducer(producers), warnings };
}

function envelopeFor(
  producer: string,
  plan: ProducerPlan,
  mapping: MappingResult,
  identity: { readonly filesContentManifestDigest: string; readonly mechanismsDigest: string; readonly unitsContentDigest: string }
): ArtifactResult<ProducerFactSet> {
  if (plan.status === "absent") return plan.envelope;
  return built(buildProducerFactSet({
    producer,
    producerVersion: plan.producerVersion,
    identity: { ...identity, configDigest: plan.configDigest },
    ...factsOfProducer(mapping, producer),
    producerCompleteness: plan.completeness
  }));
}

/** Enumerate the index's structural declarations, or record why this run has none. */
function collectCodegraph(input: FactsStageInput, facts: ObservedFact[], warnings: string[]): ProducerPlan {
  const graph = openGraph(input, warnings);
  if (graph === null) {
    return { status: "absent", envelope: unavailable("index-not-present: this run resolved no readable CodeGraph database, so no indexed function could be enumerated", true) };
  }
  try {
    const inventory = functionInventory(graph.reader, input.ledger.counted.map((row) => row.relativePath));
    if (inventory.completeness.truncated) {
      warnings.push(`the CodeGraph function inventory hit its ${inventory.completeness.limit}-node ceiling; nodes past it are unknown rather than absent`);
    }
    facts.push(...inventoryObservations(inventory));
    return {
      status: "observed",
      producerVersion: FUNCTION_INVENTORY_VERSION,
      configDigest: sha256(stableJson({
        inventoryVersion: FUNCTION_INVENTORY_VERSION,
        nodeKinds: INVENTORY_NODE_KINDS,
        limit: FUNCTION_INVENTORY_LIMIT,
        index: graph.identity,
        // The index's content is an INPUT to these facts, so it belongs in the producer's identity: the same
        // corpus indexed twice can yield two different fact sets, and a digest that cannot tell them apart is
        // the semantic-input-outside-the-identity failure the contract's fifth column names.
        indexDigest: input.codegraphDigest ?? null
      })),
      completeness: {
        filesQueried: inventory.completeness.filesQueried,
        limit: inventory.completeness.limit,
        returned: inventory.completeness.returned,
        truncated: inventory.completeness.truncated,
        withoutLineRange: inventory.completeness.withoutLineRange
      }
    };
  } catch (error) {
    return { status: "absent", envelope: unavailable(`the CodeGraph function inventory failed: ${(error as Error).message}`, true) };
  } finally {
    graph.reader.close();
  }
}

/** Turn the run's cross-repo scan into observations, or record the determination that there are none. */
function collectCrossRepo(
  input: FactsStageInput,
  modules: readonly CrossRepoModule[],
  facts: ObservedFact[],
  ledgerCompleteness: { readonly capReached: boolean; readonly skippedByCap: number; readonly droppedRoots: readonly string[] }
): ProducerPlan {
  const verdict = crossRepoDetermination({
    modules: input.codegraphModules ? modules : null,
    resolverAvailable: input.availability.crossrepo.status === "available",
    scan: input.crossRepoScan,
    ledgerCompleteness
  });
  if (verdict !== null) return { status: "absent", envelope: verdict };
  const scan = input.crossRepoScan!;  // `crossRepoDetermination` returns Unavailable for a null scan
  facts.push(...crossRepoObservations(scan, modules));
  return {
    status: "observed",
    producerVersion: CROSSREPO_FACTS_VERSION,
    configDigest: crossRepoConfigDigest(modules, scan),
    completeness: crossRepoCompleteness(scan)
  };
}

/**
 * The failure-path stage: the same eight records, every one of them written.
 *
 * A prepare that never reached layer 3 still owes the contract eight envelopes, because the registry says a
 * missing one is a finding and a run directory that simply lacks them is the P12 shape the envelope union exists
 * to remove. The cause travels from the phase that failed, so the record says what was not reached.
 */
export function unavailableFactsStage(cause: string, retryable: boolean): FactsStageResult {
  return allUnavailable(unavailable(cause, retryable), cause, retryable);
}

function allUnavailable(units: Unavailable, producerCause: string, retryable: boolean): FactsStageResult {
  const producers: Record<string, ArtifactResult<ProducerFactSet>> = {};
  for (const id of PRODUCER_IDS) {
    // Without a partition there are no cells, so there is no membership any fact could carry. Publishing facts
    // with no membership would leave the association to be re-derived downstream from a path and a span, which is
    // the one thing §一 forbids the consumer to own.
    producers[id] = unavailable(`no partition to attach facts to — ${producerCause}`, retryable);
  }
  return { units, producers, warnings: [] };
}

/** Every registered producer has an entry, checked before a byte is written rather than trusted. */
function requireEveryProducer(producers: Readonly<Record<string, ArtifactResult<ProducerFactSet>>>): Readonly<Record<string, ArtifactResult<ProducerFactSet>>> {
  const missing = PRODUCER_IDS.filter((id) => !(id in producers));
  if (missing.length) throw new Error(`the facts stage produced no envelope for registered producer(s) ${missing.join(", ")}; every layer-3 producer's envelope is enforced`);
  const extra = Object.keys(producers).filter((id) => !PRODUCER_IDS.includes(id));
  if (extra.length) throw new Error(`the facts stage produced envelope(s) for unregistered producer(s) ${extra.join(", ")}`);
  return producers;
}

interface OpenedGraph {
  readonly reader: GraphReader;
  /** What was opened, for the producer's configuration identity: a set of module databases is not one database. */
  readonly identity: Readonly<Record<string, string | readonly string[]>>;
}

/**
 * Open a reader over whatever index this run resolved, or `null`.
 *
 * A fresh reader with its own budget: the context builder closes its own before returning, and drawing on a spent
 * budget would make the inventory's completeness depend on how many queries a feature happened to run — a
 * feature-shaped input to a layer whose identity may not contain a feature key.
 */
function openGraph(input: FactsStageInput, warnings: string[]): OpenedGraph | null {
  const deadline = new Deadline(60_000, "layer-3 function inventory");
  const allowed = input.ledger.counted.map((row) => row.relativePath);
  if (input.codegraphModules?.length) {
    try {
      const reader = new CodeGraphSet(
        input.codegraphModules.map((module) => ({ module: { id: module.id, dir: module.dir }, path: module.path })),
        allowed, INVENTORY_QUERY_BUDGET, deadline
      );
      return { reader, identity: { kind: "module-set", modules: input.codegraphModules.map((module) => module.id).sort() } };
    } catch (error) {
      warnings.push(`the layer-3 function inventory could not open the per-module CodeGraph databases: ${(error as Error).message}`);
      return null;
    }
  }
  if (!input.codegraphPath) return null;
  try {
    return {
      reader: new CodeGraphIndex(input.codegraphPath, INVENTORY_QUERY_BUDGET, deadline, allowed),
      identity: { kind: "single", path: input.codegraphPath }
    };
  } catch (error) {
    warnings.push(`the layer-3 function inventory could not open the CodeGraph database: ${(error as Error).message}`);
    return null;
  }
}

/** Write the eight files. One writer, so the success and failure paths cannot lay out the directory differently. */
export async function writeFactsStage(runDir: string, stage: FactsStageResult): Promise<void> {
  await atomicWrite(join(runDir, "facts", "units.json"), serializeUnitsArtifact(stage.units));
  for (const id of [...PRODUCER_IDS].sort()) {
    await atomicWrite(join(runDir, "facts", "producers", `${id}.json`), serializeProducerFactSet(stage.producers[id]!));
  }
}
