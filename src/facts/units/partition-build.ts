import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNever, unavailable, type Unavailable } from "../../base/artifact-result.ts";
import { summarizeCoverage, type CoverageConservation } from "../../base/conservation.ts";
import { corpusResolver, LANGUAGE_REGISTRY, type CorpusResolver, type LanguageRegistry } from "../../base/language-registry.ts";
import {
  mechanismById,
  type MechanismAvailabilityMap, type MechanismId, type MechanismRegistry
} from "../../base/mechanism-registry.ts";
import {
  designatedBuilder, PARTITION_DESIGNATION, partitionDesignationDigest,
  type PartitionBuilder, type PartitionDesignation
} from "../../base/partition-designation.ts";
import { sha256, stableJson } from "../../base/util.ts";
import type { CountedRow } from "../../snapshot/file-ledger.ts";
import type { AstGrepApi } from "../probe/condition-extract.ts";
import { astPartitionLanguage, extractAstSkeleton, flattenSkeleton, type AstStructureNode } from "./ast-partition.ts";
import {
  canonicalSpan, compareSpans, mintRefUnitId, mintUnitId, spanSize, spansOverlap,
  type CanonicalSpan, type UnitKind
} from "./unit-identity.ts";

/**
 * Layer 3's canonical partition: every counted file divided into non-overlapping cells, with nothing left over.
 *
 * The two invariants of §四's three-state law — cells do not overlap, and their union is exactly `[0, size)` — are
 * enforced HERE, at construction, by `assembleFileCells`. Not asserted in a test, not checked by an auditor
 * afterwards: a partition that does not partition cannot be built. That matters because the failure is silent by
 * nature. Two overlapping cells double-count a file in the layer-4 denominator while every conservation sum still
 * balances inside the partition rows, and a gap under-counts it the same way; §一's measurement of collapsed
 * identities is the same class of bug and it took a byte-level census on a real target to see it.
 *
 * WHAT DEGRADATION IS, AND WHAT IT IS NOT. Every reason in `PartitionDegrade` is decided by the CONTENT or by
 * what layer 1 recorded about the content — never by which tool happens to be installed. That separation is the
 * point of §一's ruling, and it is structural here: nothing in this module reads a `MechanismAvailability`. The
 * availability question is answered once, for the whole envelope, by `designatedBuilderGate` below, and if it
 * answers `Unavailable` the builder never runs at all. So "the partition got coarser because ast-grep was
 * missing" is not a state this file can produce.
 *
 * A degraded file still gets a COMPLETE partition — one residual cell over its whole size — with the reason in
 * its per-file record. The one exception is a file layer 1 never observed a size for: there is no interval to
 * state, so it gets no cell and lands in the completeness block's `excluded` bucket instead of getting a made-up
 * span. Both are visible; neither is a lie about coverage.
 */

/** The reason one file's partition is coarser than its designated builder would have produced. */
export type PartitionDegrade =
  /** The language's designated builder IS file level. Not a failure — a declared granularity (§一). */
  | { readonly reason: "no-designated-builder"; readonly language: string }
  /** A mechanism builder is designated but its adapter does not resolve this extension (`.mts`, `.cts`). */
  | { readonly reason: "builder-extension-not-declared"; readonly mechanism: MechanismId; readonly extension: string }
  /** Past the builder's declared size bound; the same row is `no-mechanism` in `mechanisms.json`. */
  | { readonly reason: "size-cap"; readonly mechanism: MechanismId; readonly maxFileBytes: number; readonly size: number }
  /** The parser refused these bytes. Content-determined: the same content fails the same way. */
  | { readonly reason: "parse-failed"; readonly mechanism: MechanismId }
  /** The bytes could not be read now, although layer 1 read them. `code` is the errno, never a message. */
  | { readonly reason: "content-read-failed"; readonly code: string }
  /** What is on disk is not what the ledger accounted for, so no span over it would be about the counted row. */
  | { readonly reason: "content-drift" }
  /**
   * Layer 1 counted the row but holds no content digest for it (`absent{read-failed}`), so drift cannot be ruled
   * out. Distinct from `content-drift`, which is a comparison that was made and failed — claiming a comparison
   * that never happened is exactly the lying bucket this vocabulary exists to avoid.
   */
  | { readonly reason: "ledger-content-absent" }
  /** The bytes are not valid UTF-8, so a byte span over the DECODED text would not be a span over the file. */
  | { readonly reason: "content-not-utf8"; readonly ledgerBytes: number; readonly decodedBytes: number }
  /** Layer 1 admitted a row this corpus registry cannot assign a language to, so no builder can be designated. */
  | { readonly reason: "corpus-unregistered"; readonly extension: string }
  /** Layer 1 observed no size at all. The only reason that yields NO cell: there is no interval to state. */
  | { readonly reason: "size-unobserved" };

export type PartitionDegradeReason = PartitionDegrade["reason"];

export const PARTITION_DEGRADE_REASONS = [
  "builder-extension-not-declared",
  "content-drift",
  "content-not-utf8",
  "content-read-failed",
  "corpus-unregistered",
  "ledger-content-absent",
  "no-designated-builder",
  "parse-failed",
  "size-cap",
  "size-unobserved"
] as const satisfies readonly PartitionDegradeReason[];

/** One cell of the canonical partition: a row of the layer-4 denominator. */
export interface PartitionCell {
  readonly unitId: string;
  readonly relativePath: string;
  /** Layer 1's `CountedRow.rootName`, carried so `evaluateSeat`'s module resolver needs no path re-parsing. */
  readonly rootName: string;
  readonly partitionKind: "structure" | "residual";
  /** The builder's unit kind for a structure cell, `null` for residual. Never part of the id. */
  readonly unitKind: UnitKind | null;
  readonly span: CanonicalSpan;
}

/** One reference unit: a structure that may nest, and therefore may never be a denominator row. */
export interface RefUnit {
  readonly refUnitId: string;
  readonly relativePath: string;
  readonly rootName: string;
  readonly unitKind: UnitKind;
  readonly span: CanonicalSpan;
  /** 1 for an outermost structure; the cell over it has the same span. */
  readonly depth: number;
  /**
   * Where the span came from. Binary and required, with no third value: the builder's skeleton is the AUTHORITY
   * on canonical spans, and an observation that could not be normalised onto it says so rather than being
   * quietly filed as if the builder had produced it.
   */
  readonly normalization: "builder-node" | "reported-span";
}

export interface FilePartition {
  readonly relativePath: string;
  readonly rootName: string;
  /** `null` when the corpus registry cannot name a language for the row. */
  readonly language: string | null;
  /** Layer 1's observed size in bytes, `null` when it observed none. */
  readonly size: number | null;
  readonly builder: PartitionBuilder | null;
  readonly degraded: PartitionDegrade | null;
  readonly cells: readonly PartitionCell[];
  readonly refUnits: readonly RefUnit[];
}

export interface PartitionLanguageRow {
  readonly language: string;
  readonly files: number;
  readonly structureCells: number;
  readonly residualCells: number;
  readonly refUnits: number;
  /** Degrade reason → file count, for this language. Sorted keys; only non-zero reasons appear. */
  readonly degraded: Readonly<Record<string, number>>;
}

export interface PartitionBuildResult {
  /**
   * The partition schema generation. `UnitId`s are not comparable across it, which is why it is the designation
   * table's version and digest rather than a version this file keeps: retargeting one language's builder changes
   * every id that language produces.
   */
  readonly schema: {
    readonly designationVersion: string;
    readonly designationDigest: string;
    readonly builderVersions: Readonly<Record<string, string>>;
  };
  readonly files: readonly FilePartition[];
  /** The denominator, canonically ordered. Every counted file with an observed size is completely covered. */
  readonly partition: readonly PartitionCell[];
  readonly refUnits: readonly RefUnit[];
  /**
   * The coverage axis over FILES: `total` counted rows, `counted` of them partitioned, `excluded` the ones with
   * no observed size. `byDegradeReason` is a separate tally over every degraded file, partitioned or not — the
   * two numbers answer different questions and adding them would answer neither.
   */
  readonly completeness: CoverageConservation & { readonly byDegradeReason: Readonly<Record<string, number>> };
  readonly byLanguage: readonly PartitionLanguageRow[];
}

export interface PartitionBuildInput {
  readonly counted: readonly CountedRow[];
  /** Absolute target root. Layer 1 stores `relative(target, absolutePath)`, so `join` is its exact inverse. */
  readonly target: string;
  /**
   * All three tables are REQUIRED, not defaulted, for the reason `buildMechanismLedger` states: the result
   * records the designation digest as part of its own schema identity, so a builder that fell back to the
   * module's own tables would publish a digest for declarations it did not apply.
   */
  readonly languages: LanguageRegistry;
  readonly designation: PartitionDesignation;
  readonly mechanisms: MechanismRegistry;
  /**
   * The ast-grep binding, or `null` when it could not be loaded.
   *
   * `null` is legal ONLY for a corpus with no file designated to it — which is exactly what
   * `designatedBuilderGate` establishes before this runs. Passing `null` with such a file present throws, because
   * the alternative is this module inventing a degrade reason out of an availability fact, and that is the
   * conflation §一 forbids.
   */
  readonly astGrep: AstGrepApi | null;
}

/**
 * Whether every designated builder this corpus needs is available for this run.
 *
 * The ONLY place availability enters the partition story, and it decides the WHOLE envelope: `Unavailable` when a
 * counted file's designated builder cannot run, `null` (proceed) otherwise. A target with no TypeScript at all is
 * unaffected by a missing ast-grep — the builder's absence is harmless when nothing was designated to it — which
 * is why this is computed from the corpus rather than from the availability map alone.
 */
export function designatedBuilderGate(
  counted: readonly CountedRow[],
  availability: MechanismAvailabilityMap,
  languages: LanguageRegistry = LANGUAGE_REGISTRY,
  designation: PartitionDesignation = PARTITION_DESIGNATION
): Unavailable | null {
  const corpus = corpusResolver(languages);
  const blocked = new Map<MechanismId, { files: number; cause: string }>();
  for (const row of counted) {
    const language = corpus.languageOf(basenameOf(row.relativePath), row.extension);
    if (language === null) continue;
    const builder = designatedBuilder(language, designation);
    if (builder.kind !== "mechanism") continue;
    const state = availability[builder.mechanism];
    if (state.status !== "unavailable") continue;
    const entry = blocked.get(builder.mechanism) ?? { files: 0, cause: state.cause };
    entry.files += 1;
    blocked.set(builder.mechanism, entry);
  }
  if (blocked.size === 0) return null;
  const detail = [...blocked.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mechanism, entry]) => `${mechanism} (${entry.files} counted file(s)): ${entry.cause}`)
    .join("; ")
  ;
  // Retryable: the dependency is a native binding, so the same inputs on a repaired machine really can succeed.
  return unavailable(`designated partition builder unavailable — ${detail}`, true);
}

/**
 * Assemble one file's cells from its top-level structure spans, and refuse anything that is not a partition.
 *
 * Exported because the two checks below are the ones §四 rests on, and a check with no failing fixture is a
 * comment: a test hands this function overlapping spans and a span past the end of the file and watches it throw.
 * The structural guarantee that ast-grep's outermost nodes cannot overlap (see `ast-partition.ts`) is what makes
 * these checks cheap rather than redundant — they catch the day the guarantee stops holding.
 */
export function assembleFileCells(
  relativePath: string,
  rootName: string,
  structures: readonly { readonly unitKind: UnitKind; readonly span: CanonicalSpan }[],
  size: number
): PartitionCell[] {
  const sorted = [...structures].sort((a, b) => compareSpans(a.span, b.span));
  const cells: PartitionCell[] = [];
  let cursor = 0;
  for (const structure of sorted) {
    const { startByte, endByte } = structure.span;
    if (endByte > size) {
      throw new Error(`Partition of ${relativePath} is not within the file: structure span [${startByte}, ${endByte}) ends past size ${size}`);
    }
    if (startByte < cursor) {
      throw new Error(`Partition of ${relativePath} overlaps: structure span [${startByte}, ${endByte}) starts before the previous cell ended at ${cursor}`);
    }
    if (startByte > cursor) cells.push(cell(relativePath, rootName, "residual", null, canonicalSpan(cursor, startByte)));
    cells.push(cell(relativePath, rootName, "structure", structure.unitKind, structure.span));
    cursor = endByte;
  }
  // The trailing residual, and — when there are no structures at all — the whole file. An empty file gets `[0,0)`:
  // a real cell over a real (empty) interval, so a counted row is never absent from the denominator.
  if (cursor < size || cells.length === 0) cells.push(cell(relativePath, rootName, "residual", null, canonicalSpan(cursor, size)));
  verifyFilePartition(relativePath, cells, size);
  return cells;
}

function cell(relativePath: string, rootName: string, partitionKind: "structure" | "residual", unitKind: UnitKind | null, span: CanonicalSpan): PartitionCell {
  return { unitId: mintUnitId(partitionKind, span, relativePath), relativePath, rootName, partitionKind, unitKind, span };
}

/**
 * The three-state law for one file, as arithmetic that has to close: no overlap, no gap, no duplicate id.
 *
 * Exported so it has a failing fixture and so the units artifact can re-run it over cells it assembled itself.
 * Reached from `assembleFileCells` the gap branch cannot fire — that function builds the residuals — and a check
 * that can only ever pass is a check that vouches for whatever it is pointed at. A caller assembling cells from
 * two sources is exactly where a gap comes from, and this is the door it goes through.
 */
export function verifyFilePartition(relativePath: string, cells: readonly PartitionCell[], size: number): void {
  let covered = 0;
  for (let i = 0; i < cells.length; i++) {
    covered += spanSize(cells[i]!.span);
    if (i > 0 && spansOverlap(cells[i - 1]!.span, cells[i]!.span)) {
      throw new Error(`Partition of ${relativePath} overlaps between ${cells[i - 1]!.unitId} and ${cells[i]!.unitId}`);
    }
  }
  if (covered !== size) {
    throw new Error(`Partition of ${relativePath} does not cover the file: ${cells.length} cell(s) span ${covered} of ${size} bytes`);
  }
  const ids = new Set(cells.map((entry) => entry.unitId));
  if (ids.size !== cells.length) throw new Error(`Partition of ${relativePath} mints ${cells.length - ids.size} duplicate cell id(s)`);
}

/** How a row is classified before any byte is read; only `read` needs the file. */
type Plan =
  | { readonly step: "degraded"; readonly degraded: PartitionDegrade; readonly builder: PartitionBuilder | null; readonly language: string | null; readonly size: number | null }
  | { readonly step: "read"; readonly builder: PartitionBuilder; readonly mechanism: MechanismId; readonly astLanguage: string; readonly language: string; readonly size: number; readonly digest: string };

export async function buildPartition(input: PartitionBuildInput): Promise<PartitionBuildResult> {
  const corpus = corpusResolver(input.languages);
  const plans = input.counted.map((row) => ({ row, plan: planFor(row, corpus, input.designation, input.mechanisms) }));
  const needsBinding = plans.some(({ plan }) => plan.step === "read");
  if (needsBinding && input.astGrep === null) {
    throw new Error("buildPartition was handed no ast-grep binding while a counted file designates it; the run's builder gate (designatedBuilderGate) must answer Unavailable before the builder is invoked, never degrade the file");
  }
  const files = await mapWithLimit(plans, 16, async ({ row, plan }) => resolveFile(row, plan, input));

  const partition = files.flatMap((file) => file.cells).sort((a, b) => a.unitId.localeCompare(b.unitId));
  const refUnits = files.flatMap((file) => file.refUnits).sort((a, b) => a.refUnitId.localeCompare(b.refUnitId));
  const partitioned = files.filter((file) => file.cells.length > 0).length;
  const byDegradeReason: Record<string, number> = {};
  for (const reason of PARTITION_DEGRADE_REASONS) {
    const count = files.filter((file) => file.degraded?.reason === reason).length;
    if (count > 0) byDegradeReason[reason] = count;
  }
  const designatedMechanisms = new Set(Object.values(input.designation.byLanguage)
    .filter((builder) => builder.kind === "mechanism")
    .map((builder) => builder.mechanism));
  return {
    schema: {
      designationVersion: input.designation.version,
      designationDigest: partitionDesignationDigest(input.designation),
      builderVersions: Object.fromEntries([...designatedMechanisms].sort()
        .map((mechanism) => [mechanism, mechanismById(mechanism, input.mechanisms).version]))
    },
    files: [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    partition,
    refUnits,
    completeness: Object.assign(
      summarizeCoverage({ total: input.counted.length, counted: partitioned, excluded: files.length - partitioned }),
      { byDegradeReason }
    ),
    byLanguage: censusByLanguage(files)
  };
}

/**
 * Classify one row without touching its bytes.
 *
 * The order is the honest part, and it is the same ordering `verdictFor` uses in the layer-2 ledger: a declared
 * granularity is decided before a size bound, and a size bound before anything that needs the content. So a
 * `.pm` file is `no-designated-builder` whatever its size, and a 700 KB `.ts` file is `size-cap` whether or not
 * its bytes are readable.
 */
function planFor(row: CountedRow, corpus: CorpusResolver, designation: PartitionDesignation, mechanisms: MechanismRegistry): Plan {
  const size = observedSize(row);
  const language = corpus.languageOf(basenameOf(row.relativePath), row.extension);
  if (language === null) {
    return { step: "degraded", degraded: { reason: "corpus-unregistered", extension: row.extension }, builder: null, language: null, size };
  }
  const builder = designatedBuilder(language, designation);
  if (builder.kind === "file-level") {
    return { step: "degraded", degraded: { reason: "no-designated-builder", language }, builder, language, size };
  }
  const astLanguage = astPartitionLanguage(row.extension);
  if (astLanguage === null) {
    return { step: "degraded", degraded: { reason: "builder-extension-not-declared", mechanism: builder.mechanism, extension: row.extension }, builder, language, size };
  }
  if (size === null) {
    return { step: "degraded", degraded: { reason: "size-unobserved" }, builder, language, size };
  }
  const maxFileBytes = mechanismById(builder.mechanism, mechanisms).maxFileBytes;
  if (maxFileBytes !== null && size > maxFileBytes) {
    return { step: "degraded", degraded: { reason: "size-cap", mechanism: builder.mechanism, maxFileBytes, size }, builder, language, size };
  }
  if (row.content.status !== "present") {
    return { step: "degraded", degraded: { reason: "ledger-content-absent" }, builder, language, size };
  }
  return { step: "read", builder, mechanism: builder.mechanism, astLanguage, language, size, digest: row.content.digest };
}

async function resolveFile(row: CountedRow, plan: Plan, input: PartitionBuildInput): Promise<FilePartition> {
  if (plan.step === "degraded") return degradedFile(row, plan.language, plan.size, plan.builder, plan.degraded);

  let bytes: Buffer;
  try {
    bytes = await readFile(join(input.target, row.relativePath));
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "unknown";
    return degradedFile(row, plan.language, plan.size, plan.builder, { reason: "content-read-failed", code });
  }
  // Compared against the LEDGER's digest, not against a size: the ledger's tier2 hash is what the snapshot
  // identity anchors on, so equality here is what makes every span below a span over the counted row.
  if (sha256(bytes) !== plan.digest) return degradedFile(row, plan.language, plan.size, plan.builder, { reason: "content-drift" });
  const source = bytes.toString("utf8");
  const decodedBytes = Buffer.byteLength(source, "utf8");
  if (decodedBytes !== bytes.length) {
    // Invalid UTF-8 came back as replacement characters, so offsets into the decoded text no longer index the
    // file. Every span would be plausible and wrong, which is the failure mode a bucket exists to prevent.
    return degradedFile(row, plan.language, plan.size, plan.builder, { reason: "content-not-utf8", ledgerBytes: bytes.length, decodedBytes });
  }
  const skeleton = extractAstSkeleton(input.astGrep!, plan.astLanguage, source);
  if (skeleton.status === "parse-failed") {
    return degradedFile(row, plan.language, plan.size, plan.builder, { reason: "parse-failed", mechanism: plan.mechanism });
  }
  if (skeleton.byteLength !== plan.size) {
    throw new Error(`${row.relativePath}: the ledger recorded ${plan.size} bytes and the verified content decodes to ${skeleton.byteLength}; the partition's completeness arithmetic has nothing to close against`);
  }
  // A named grammar node always spans at least one byte, so a zero-width structure means the parser handed back
  // something this builder cannot express as a cell. It lands in the parser's bucket rather than being dropped.
  const nodes = flattenSkeleton(skeleton.topLevel);
  if (nodes.some((node) => spanSize(node.span) === 0)) {
    return degradedFile(row, plan.language, plan.size, plan.builder, { reason: "parse-failed", mechanism: plan.mechanism });
  }
  return {
    relativePath: row.relativePath,
    rootName: row.rootName,
    language: plan.language,
    size: plan.size,
    builder: plan.builder,
    degraded: null,
    cells: assembleFileCells(row.relativePath, row.rootName, skeleton.topLevel, plan.size),
    refUnits: nodes.map((node) => refUnitOf(row, node))
  };
}

function refUnitOf(row: CountedRow, node: AstStructureNode): RefUnit {
  return {
    refUnitId: mintRefUnitId(node.unitKind, node.span, row.relativePath),
    relativePath: row.relativePath,
    rootName: row.rootName,
    unitKind: node.unitKind,
    span: node.span,
    depth: node.depth,
    normalization: "builder-node"
  };
}

/**
 * A degraded file: one residual cell over the whole size, with the reason recorded.
 *
 * `size-unobserved` is the single reason that yields no cell. Layer 1 recorded no bytes for the row, so the only
 * available spans would be invented — and a `[0, 0)` cell for a file of unknown length would claim the file is
 * empty. It appears in `completeness.excluded` instead, which is where a reader looks for "not covered".
 */
function degradedFile(row: CountedRow, language: string | null, size: number | null, builder: PartitionBuilder | null, degraded: PartitionDegrade): FilePartition {
  return {
    relativePath: row.relativePath,
    rootName: row.rootName,
    language,
    size,
    builder,
    degraded,
    cells: size === null ? [] : assembleFileCells(row.relativePath, row.rootName, [], size),
    refUnits: []
  };
}

/** The size layer 1 observed, or `null`. Exhaustive over its tier1 union, the same way layer 2 reads it. */
function observedSize(row: CountedRow): number | null {
  switch (row.tier1.status) {
    case "sampled": return row.tier1.size;
    case "stat-only": return row.tier1.size;
    case "unsampled": return null;
    default: return assertNever(row.tier1, "counted row tier1 shape");
  }
}

/** Layer 1 normalises every relative path to forward slashes, so the basename is a slice. */
function basenameOf(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

function censusByLanguage(files: readonly FilePartition[]): PartitionLanguageRow[] {
  const rows = new Map<string, { files: number; structureCells: number; residualCells: number; refUnits: number; degraded: Record<string, number> }>();
  for (const file of files) {
    const key = file.language ?? "unregistered";
    const row = rows.get(key) ?? { files: 0, structureCells: 0, residualCells: 0, refUnits: 0, degraded: {} };
    row.files += 1;
    row.structureCells += file.cells.filter((entry) => entry.partitionKind === "structure").length;
    row.residualCells += file.cells.filter((entry) => entry.partitionKind === "residual").length;
    row.refUnits += file.refUnits.length;
    if (file.degraded) row.degraded[file.degraded.reason] = (row.degraded[file.degraded.reason] ?? 0) + 1;
    rows.set(key, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([language, row]) => ({ language, ...row }));
}

/** Bounded-parallel map, preserving input order. 3000 unbounded `readFile`s exhaust the descriptor table. */
async function mapWithLimit<In, Out>(items: readonly In[], limit: number, work: (item: In) => Promise<Out>): Promise<Out[]> {
  const out = new Array<Out>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The partition's content identity.
 *
 * It covers the schema block, so changing the designation table moves it even when every byte of every cell is
 * the same — which is the point: `UnitId`s from two generations are not comparable, and a digest that could not
 * tell them apart would let a cache hand back the wrong generation's partition.
 */
export function partitionContentDigest(result: PartitionBuildResult): string {
  return sha256(stableJson({
    schema: result.schema,
    partition: result.partition,
    refUnits: result.refUnits,
    completeness: result.completeness,
    byLanguage: result.byLanguage,
    files: result.files
  }));
}
