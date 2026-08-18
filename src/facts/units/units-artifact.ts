import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactResult } from "../../base/artifact-result.ts";
import type { CoverageConservation } from "../../base/conservation.ts";
import { factKindById, factKindRegistryDigest, FACT_KIND_REGISTRY, FACT_KIND_REGISTRY_VERSION } from "../../base/fact-kind-registry.ts";
import { mechanismById, MECHANISM_REGISTRY, type MechanismId, type MechanismRegistry } from "../../base/mechanism-registry.ts";
import { PARTITION_DESIGNATION, partitionDesignationDigest, type PartitionBuilder, type PartitionDesignation } from "../../base/partition-designation.ts";
import { RowSet, type RowSetCompleteness } from "../../base/row-set.ts";
import { canonicalJson, sha256 } from "../../base/util.ts";
import type { CountedRow } from "../../snapshot/file-ledger.ts";
import {
  MEMBERSHIP_MAP_VERSION, mapObservations, partitionView,
  type MappingResult, type ObservedFact
} from "./membership-map.ts";
import type { PartitionBuildResult, PartitionCell, PartitionDegrade, PartitionLanguageRow, RefUnit } from "./partition-build.ts";
import { lineOffsetsFromBytes, type LineOffsets } from "./unit-identity.ts";

/**
 * `facts/units.json`: the two sets §一 asks layer 3 for, assembled and given one identity.
 *
 * `partition[]` is the DENOMINATOR — non-overlapping cells that tile every counted file — and `refUnits[]` is
 * the citable structure, which may nest and therefore may never be counted. Keeping them apart is not tidiness:
 * a class and its methods in one conservation sum overlap, so one artifact with one list would make the layer-4
 * three-state law arithmetically false.
 *
 * WHAT THIS ARTIFACT DOES NOT CONTAIN, and why that is its byte bound. There is no source text in it — every
 * field is an id, a byte offset, a path or a value from a closed enum — so the P18 field-level bound is
 * structural rather than enforced. What remains is the MULTIPLIER, how many rows one file may contribute, and
 * that is bounded by the builder's declared caps, which is what `bounds` publishes. Measured: before the
 * line-shape cap existed, provital's 3005 counted files produced 61,067 reference units and a 63 MB artifact,
 * the top contributors being four copies each of `tiny_mce.js` and `themes/silver/theme.js` — both comfortably
 * under the 500 KB size cap. With the cap declared the same target produces roughly 7,000. There is deliberately
 * NO total-byte ceiling: the artifact's size is linear in the corpus, and a fixed ceiling a large repository
 * would trip is a cap that lies, so the honest bounds are the per-file multiplier and the absence of content.
 *
 * The per-file records carry COUNTS, not copies. Earlier they embedded each file's cells and reference units
 * verbatim beside the flat lists, which doubled the artifact for no reader: the flat lists are the denominator
 * and the per-file record exists to say what happened to that file.
 */

export const UNITS_ARTIFACT_VERSION = "units-v1";

/** A reference unit with the producers that observed it. Empty `observedBy` is legal: the builder found it. */
export interface UnitsRefUnit extends RefUnit {
  /**
   * Producer ids, sorted and deduplicated. The empty-set ban belongs to `Membership`, not here — a structure the
   * builder found and no producer indexed is a real and common state, and calling it a violation would push the
   * artifact toward "the denominator is a count of tool observations", which is exactly what §一's fifth column
   * forbids.
   */
  readonly observedBy: readonly string[];
}

export interface UnitsFileRecord {
  readonly relativePath: string;
  readonly rootName: string;
  readonly language: string | null;
  readonly size: number | null;
  readonly builder: PartitionBuilder | null;
  readonly degraded: PartitionDegrade | null;
  readonly structureCells: number;
  readonly residualCells: number;
  /** Reference units the designated builder produced for this file. */
  readonly refUnits: number;
  /** Reference units minted from a producer's reported span because the skeleton had no node for it. */
  readonly reportedSpanUnits: number;
}

export interface UnitsIdentity {
  readonly filesContentManifestDigest: string;
  readonly scannerVersion: string;
  /** `mechanisms.json`'s own content digest: layer 3's identity includes the layer-2 ledger it read (§一). */
  readonly mechanismsDigest: string;
  readonly partitionDesignation: { readonly version: string; readonly digest: string };
  readonly factKindRegistry: { readonly version: string; readonly digest: string };
  readonly builderVersions: Readonly<Record<string, string>>;
  readonly mappingVersion: string;
}

export interface UnitsBounds {
  /** Structural: no row in this artifact carries file content, so no field of it can grow with a file. */
  readonly carriesSourceText: false;
  /** The declared caps that bound how many rows one file may contribute, read off the mechanism registry. */
  readonly builderCaps: Readonly<Record<string, { readonly maxFileBytes: number | null; readonly maxLineLength: number | null }>>;
  /** What those caps actually left, measured on this run: the worst single file. */
  readonly maxRefUnitsInOneFile: number;
  readonly maxCellsInOneFile: number;
}

export interface UnitsObservationCensus {
  readonly offered: number;
  /** Distinct builder nodes at least one producer observed. */
  readonly attachedToBuilderNode: number;
  readonly mintedRefUnits: number;
  /** Reference units two or more producers observed — the multi-producer merge, as one readable number. */
  readonly observedByAtLeastTwo: number;
  /** Structural declarations that neither attached nor minted, by reason. Visible, never dropped. */
  readonly unnormalized: Readonly<Record<string, number>>;
  /** Files opened solely to convert a reported line span into bytes, and the ones that could not be. */
  readonly lineIndexReads: number;
  readonly lineIndexReadFailures: number;
}

export interface UnitsArtifact {
  readonly version: typeof UNITS_ARTIFACT_VERSION;
  readonly identity: UnitsIdentity;
  readonly bounds: UnitsBounds;
  readonly partition: readonly PartitionCell[];
  readonly refUnits: readonly UnitsRefUnit[];
  readonly files: readonly UnitsFileRecord[];
  readonly completeness: CoverageConservation & { readonly byDegradeReason: Readonly<Record<string, number>> };
  /** Layer 1's scan completeness, INHERITED: the partition of a capped scan is a capped denominator (§四). */
  readonly inheritedCompleteness: RowSetCompleteness;
  /** The designated builder's own per-language census. Minted units are not the builder's and are not in it. */
  readonly byLanguage: readonly PartitionLanguageRow[];
  readonly observations: UnitsObservationCensus;
}

export interface UnitsAssemblyInput {
  readonly build: PartitionBuildResult;
  readonly mapping: MappingResult;
  readonly identity: Omit<UnitsIdentity, "partitionDesignation" | "factKindRegistry" | "builderVersions" | "mappingVersion">;
  readonly inheritedCompleteness: RowSetCompleteness;
  readonly observationsOffered: number;
  readonly lineIndexReads: number;
  readonly lineIndexReadFailures: number;
  readonly designation?: PartitionDesignation;
  readonly mechanisms?: MechanismRegistry;
}

export function assembleUnitsArtifact(input: UnitsAssemblyInput): UnitsArtifact {
  const designation = input.designation ?? PARTITION_DESIGNATION;
  const mechanisms = input.mechanisms ?? MECHANISM_REGISTRY;
  const observedBy = input.mapping.observedBy;
  const builderUnits = input.build.refUnits.map((unit) => withObservers(unit, observedBy));
  const mintedUnits = input.mapping.mintedRefUnits.map((unit) => withObservers(unit, observedBy));
  const refUnits = [...builderUnits, ...mintedUnits].sort((a, b) => a.refUnitId.localeCompare(b.refUnitId));
  const mintedByPath = new Map<string, number>();
  for (const unit of mintedUnits) mintedByPath.set(unit.relativePath, (mintedByPath.get(unit.relativePath) ?? 0) + 1);

  const unnormalized: Record<string, number> = {};
  for (const record of input.mapping.unnormalized) unnormalized[record.reason] = (unnormalized[record.reason] ?? 0) + 1;

  const files: UnitsFileRecord[] = input.build.files.map((file) => ({
    relativePath: file.relativePath,
    rootName: file.rootName,
    language: file.language,
    size: file.size,
    builder: file.builder,
    degraded: file.degraded,
    structureCells: file.cells.filter((cell) => cell.partitionKind === "structure").length,
    residualCells: file.cells.filter((cell) => cell.partitionKind === "residual").length,
    refUnits: file.refUnits.length,
    reportedSpanUnits: mintedByPath.get(file.relativePath) ?? 0
  }));

  return {
    version: UNITS_ARTIFACT_VERSION,
    identity: {
      ...input.identity,
      partitionDesignation: { version: designation.version, digest: partitionDesignationDigest(designation) },
      factKindRegistry: { version: FACT_KIND_REGISTRY_VERSION, digest: factKindRegistryDigest(FACT_KIND_REGISTRY) },
      builderVersions: input.build.schema.builderVersions,
      mappingVersion: MEMBERSHIP_MAP_VERSION
    },
    bounds: {
      carriesSourceText: false,
      builderCaps: builderCaps(designation, mechanisms),
      maxRefUnitsInOneFile: files.reduce((most, file) => Math.max(most, file.refUnits + file.reportedSpanUnits), 0),
      maxCellsInOneFile: files.reduce((most, file) => Math.max(most, file.structureCells + file.residualCells), 0)
    },
    partition: input.build.partition,
    refUnits,
    files,
    completeness: input.build.completeness,
    inheritedCompleteness: { ...input.inheritedCompleteness, droppedRoots: [...input.inheritedCompleteness.droppedRoots].sort() },
    byLanguage: input.build.byLanguage,
    observations: {
      offered: input.observationsOffered,
      attachedToBuilderNode: builderUnits.filter((unit) => unit.observedBy.length > 0).length,
      mintedRefUnits: mintedUnits.length,
      observedByAtLeastTwo: refUnits.filter((unit) => unit.observedBy.length >= 2).length,
      unnormalized: sortedKeys(unnormalized),
      lineIndexReads: input.lineIndexReads,
      lineIndexReadFailures: input.lineIndexReadFailures
    }
  };
}

function withObservers(unit: RefUnit, observedBy: ReadonlyMap<string, readonly string[]>): UnitsRefUnit {
  return { ...unit, observedBy: observedBy.get(unit.refUnitId) ?? [] };
}

/** The declared caps of every mechanism the designation table names as a builder. Read, never restated. */
function builderCaps(designation: PartitionDesignation, mechanisms: MechanismRegistry): Readonly<Record<string, { maxFileBytes: number | null; maxLineLength: number | null }>> {
  const ids = new Set<MechanismId>();
  for (const builder of Object.values(designation.byLanguage)) {
    if (builder.kind === "mechanism") ids.add(builder.mechanism);
  }
  const caps: Record<string, { maxFileBytes: number | null; maxLineLength: number | null }> = {};
  for (const id of [...ids].sort()) {
    const entry = mechanismById(id, mechanisms);
    caps[id] = { maxFileBytes: entry.maxFileBytes, maxLineLength: entry.maxLineLength };
  }
  return caps;
}

function sortedKeys<T>(record: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key]!;
  return out;
}

/**
 * The artifact's content identity, over everything it declares — the identity block included.
 *
 * That inclusion is the point: a designation-table change or a new mapping version moves this digest even when
 * every cell is byte-identical, because `UnitId`s from two partition generations are not comparable and a digest
 * that could not tell them apart would let a consumer bind to the wrong generation.
 */
export function unitsContentDigest(artifact: UnitsArtifact): string {
  return sha256(canonicalJson(artifact));
}

/**
 * The partition as a denominator.
 *
 * The one door: `RowSet.fromPartition` demands this artifact's identity and layer 1's completeness block, so a
 * consumer cannot assemble cells into a denominator without carrying what it is accountable to. The completeness
 * it carries is layer 1's, inherited — a capped scan produces a capped partition, and §四 makes that travel with
 * the rows rather than being looked up later.
 */
export function unitsRowSet(artifact: UnitsArtifact): RowSet {
  return RowSet.fromPartition(artifact.partition, {
    artifact: "facts/units.json",
    contentDigest: unitsContentDigest(artifact),
    producerVersion: artifact.identity.partitionDesignation.version,
    completeness: artifact.inheritedCompleteness
  });
}

/**
 * Canonical bytes: stable key order, stable row order, no wall-clock field. Two prepares must agree exactly.
 *
 * Unindented, unlike the layer-1 and layer-2 ledgers, because this artifact is large and machine-only: measured on
 * wcp, indentation alone was 4.1 MB of a 13.7 MB file.
 */
export function serializeUnitsArtifact(result: ArtifactResult<UnitsArtifact>): string {
  return `${canonicalJson(result)}\n`;
}

// --- the observation pass: line indexes for files the builder never decoded ---------------------------------

export interface ObservationPassResult {
  readonly mapping: MappingResult;
  readonly lineIndexReads: number;
  readonly lineIndexReadFailures: number;
}

/**
 * Map every observation onto the partition, reading the few extra files a reported span needs.
 *
 * The builder already published a line index for every file it DECODED, so the only reads here are for files it
 * did not: a CodeGraph node in a Python file on a Perl target, where the designated builder is `file-level` and
 * the file was never opened. Bounded by the observations rather than by the corpus — measured on provital, the
 * index knows 73 Python files — and every read is verified against layer 1's tier2 digest before its offsets are
 * used, so a file that changed since the scan yields no span instead of a plausible wrong one.
 *
 * The mapping itself stays PURE: this function's whole job is to hand it a complete line index.
 */
export async function runObservationPass(input: {
  readonly target: string;
  readonly build: PartitionBuildResult;
  readonly counted: readonly CountedRow[];
  readonly facts: readonly ObservedFact[];
}): Promise<ObservationPassResult> {
  const digestByPath = new Map<string, string>();
  for (const row of input.counted) {
    if (row.content.status === "present") digestByPath.set(row.relativePath, row.content.digest);
  }
  const partitioned = new Map(input.build.files.map((file) => [file.relativePath, file]));
  const wanted = new Set<string>();
  for (const fact of input.facts) {
    if (!factKindById(fact.kind).structuralDeclaration) continue;
    for (const anchor of fact.anchors) {
      if (anchor.endLine === null) continue;
      if (input.build.lineOffsets.has(anchor.relativePath)) continue;
      if (!partitioned.has(anchor.relativePath)) continue;
      wanted.add(anchor.relativePath);
    }
  }
  const offsets = new Map<string, LineOffsets>(input.build.lineOffsets);
  let reads = 0;
  let failures = 0;
  for (const relativePath of [...wanted].sort()) {
    const digest = digestByPath.get(relativePath);
    if (digest === undefined) { failures += 1; continue; }
    try {
      const bytes = await readFile(join(input.target, relativePath));
      reads += 1;
      // Verified against the LEDGER's digest, exactly as the builder verifies its own reads: offsets over bytes
      // that are not the counted row's bytes would produce spans that look right and point somewhere else.
      if (sha256(bytes) !== digest) { failures += 1; continue; }
      offsets.set(relativePath, lineOffsetsFromBytes(bytes));
    } catch {
      failures += 1;
    }
  }
  return {
    mapping: mapObservations(partitionView(input.build.files, offsets), input.facts),
    lineIndexReads: reads,
    lineIndexReadFailures: failures
  };
}
