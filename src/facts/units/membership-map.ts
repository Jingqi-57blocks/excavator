import { assertNever } from "../../base/artifact-result.ts";
import {
  CORPUS_MEMBERSHIP, FACT_KIND_REGISTRY, factKindById, moduleMembership, relationMembership, spanSetMembership, unitMembership,
  type FactKindEntry, type FactKindId, type FactKindRegistry, type Membership
} from "../../base/fact-kind-registry.ts";
import { mintRefUnitId, spanSize, type CanonicalSpan, type LineOffsets, type UnitKind } from "./unit-identity.ts";
import type { FilePartition, PartitionCell, RefUnit } from "./partition-build.ts";

/**
 * The ONE algorithm that turns a producer's observation into a partition membership.
 *
 * `docs/layering.md` §一 forbids a second copy of it downstream ("下游不得拥有第二份映射算法"), so every consumer
 * reads the `Membership` layer 3 wrote and nothing re-derives one from a path and a span. That is only
 * enforceable if there is exactly one place the derivation happens, and this is it: layers 4 and 5 have no
 * function to call that would give them a different answer.
 *
 * THE COORDINATE PROBLEM, measured before it was designed around. A canonical span is a half-open interval of
 * UTF-8 bytes, and NOT ONE producer in this repository reports a byte offset: `PerlSub` carries a line
 * (`src/nativegraph/types.ts`), a framework `RouteAction` carries a line, a `RecoveredRoute` carries a line and
 * an OPTIONAL end line, and only CodeGraph nodes carry both ends. So every observation arrives in line
 * coordinates and is converted here, through the line index of the same read that built the partition. A span
 * minted from a line-only observation would be a fabrication, which is why a line-only observation never mints
 * one — it maps to a cell and stops there.
 *
 * WHY LINE GRANULARITY NEEDS A STATED PREFERENCE. Two structures can share a line, and a cell boundary can fall
 * mid-line: `export function foo()` is a residual cell over `export ` plus a structure cell over the
 * declaration, both of which intersect the declaration's line. Resolving that by "the cell containing the first
 * byte of the line" would file every exported declaration in the seven-byte residual sliver in front of it —
 * measured on this repository's own source. The preference below is therefore explicit and total, and it is the
 * same one for cells and for reference units so that a fact and its unit cannot disagree.
 */

export const MEMBERSHIP_MAP_VERSION = "membership-map-v1";

/** A detail value on a fact row. Scalars only: a nested object is an unbounded field waiting to happen (P18). */
export type FactDetailValue = string | number | boolean | null;
export type FactDetail = Readonly<Record<string, FactDetailValue>>;

/**
 * Where one end of a fact sits in the source, as its producer reports it.
 *
 * `unitKind` is the producer's KIND CLAIM and is nullable on purpose: a CodeGraph `function` node claims one, a
 * recovered express route does not — the registration line declares a route, and the unit at that line is
 * whatever the file's builder found there. A null claim means "no kind constraint", never "kind unknown, guess".
 */
export interface FactAnchor {
  readonly relativePath: string;
  /** 1-based, as every producer in this repository reports it. */
  readonly startLine: number;
  /** 1-based inclusive last line, or `null` for a line-only observation. */
  readonly endLine: number | null;
  readonly unitKind: UnitKind | null;
}

/**
 * One observation, before it has a membership.
 *
 * There is no `producer` field. The fact KIND names its producer in the base registry, so a producer cannot
 * publish a fact under another producer's name and the two cannot drift apart.
 */
export interface ObservedFact {
  readonly factId: string;
  readonly kind: FactKindId;
  /** Empty for a corpus-domain fact, one for a unit fact, two or more for a relation. */
  readonly anchors: readonly FactAnchor[];
  readonly detail: FactDetail;
}

export interface MappedFact {
  readonly factId: string;
  readonly kind: FactKindId;
  readonly membership: Membership;
  readonly detail: FactDetail;
}

/**
 * Why one anchor could not be resolved to a cell. Closed, and every value is reachable — a bucket nothing can
 * produce is a bucket that lies about what can happen.
 */
export type AnchorUnmappedReason =
  /** The anchor names a path that is not a counted row of this run (a generated file, an ignored directory). */
  | "path-not-counted"
  /** Counted, but layer 1 observed no size for it, so it has no cell to belong to. */
  | "file-not-partitioned"
  /** The line index says the file does not have that line — a stale index against changed source. */
  | "line-outside-file";

export const ANCHOR_UNMAPPED_REASONS = ["file-not-partitioned", "line-outside-file", "path-not-counted"] as const satisfies readonly AnchorUnmappedReason[];

/** One anchor that did not resolve. Never dropped: a fact that vanishes takes its own absence with it. */
export interface UnmappedAnchor {
  readonly factId: string;
  readonly kind: FactKindId;
  readonly relativePath: string;
  readonly startLine: number;
  readonly reason: AnchorUnmappedReason;
}

/**
 * Why a structural declaration neither attached to a builder node nor minted one of its own.
 *
 * All four are reachable and each has a fixture: a recovered express route claims no unit kind, a gin
 * registration has no end line, a file whose bytes drifted has no line index to convert with, and a stale index
 * can report an end line past the end of the file.
 */
export type UnnormalizedReason = "no-kind-claim" | "no-end-line" | "no-line-index" | "end-line-outside-file";

export const UNNORMALIZED_REASONS = ["end-line-outside-file", "no-end-line", "no-kind-claim", "no-line-index"] as const satisfies readonly UnnormalizedReason[];

export interface UnnormalizedObservation {
  readonly factId: string;
  readonly kind: FactKindId;
  readonly relativePath: string;
  readonly startLine: number;
  readonly reason: UnnormalizedReason;
}

export interface MappingResult {
  readonly mapped: readonly MappedFact[];
  /** Facts with no membership at all — every anchor unresolved. They are published, not discarded. */
  readonly unmappable: readonly string[];
  readonly unmappedAnchors: readonly UnmappedAnchor[];
  /** `refUnitId` → the producers that observed it, sorted and deduplicated. Feeds `observedBy`. */
  readonly observedBy: ReadonlyMap<string, readonly string[]>;
  /** Reference units the builder did not produce; `normalization: "reported-span"`. Canonically ordered. */
  readonly mintedRefUnits: readonly RefUnit[];
  readonly unnormalized: readonly UnnormalizedObservation[];
}

/**
 * The partition, indexed for mapping. Built by the units artifact from one build result, so the mapper never
 * touches a file or a mechanism: it is pure over what the builder already produced.
 */
export interface PartitionView {
  fileOf(relativePath: string): FilePartition | null;
  lineOffsetsOf(relativePath: string): LineOffsets | null;
}

export function partitionView(files: readonly FilePartition[], lineOffsets: ReadonlyMap<string, LineOffsets>): PartitionView {
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  return {
    fileOf: (relativePath) => byPath.get(relativePath) ?? null,
    lineOffsetsOf: (relativePath) => lineOffsets.get(relativePath) ?? null
  };
}

/**
 * The kind CLASSES a claim is matched by, and why matching is not on the kind itself.
 *
 * CodeGraph reports `const handler = () => {}` as a `function` while the grammar calls it an `arrow_function`,
 * so exact-kind matching would refuse the single most common shape in a TypeScript codebase and mint a duplicate
 * reference unit beside the builder's own. A type is still a type and a callable a callable, so a `class`
 * observation can never attach to a function node.
 */
const KIND_CLASS: Readonly<Record<UnitKind, "type" | "callable">> = {
  "class": "type",
  "function": "callable",
  "method": "callable",
  "closure": "callable"
};

export function kindClass(unitKind: UnitKind): "type" | "callable" {
  return KIND_CLASS[unitKind];
}

type AnchorResolution =
  | { readonly status: "resolved"; readonly cell: PartitionCell; readonly file: FilePartition; readonly reportedSpan: CanonicalSpan | null; readonly lineWindow: CanonicalSpan | null }
  | { readonly status: "unmapped"; readonly reason: AnchorUnmappedReason };

/**
 * Map every observation onto the partition.
 *
 * `registry` is defaultable for the same reason `factKindById`'s is: the production table is the one answer, and a
 * fixture needs to be able to point a kind at a membership arm no v1 kind uses so that arm has a failing test
 * instead of a comment. Nothing in `src/` passes anything but the default.
 */
export function mapObservations(view: PartitionView, facts: readonly ObservedFact[], registry: FactKindRegistry = FACT_KIND_REGISTRY): MappingResult {
  const mapped: MappedFact[] = [];
  const unmappable: string[] = [];
  const unmappedAnchors: UnmappedAnchor[] = [];
  const unnormalized: UnnormalizedObservation[] = [];
  const observedBy = new Map<string, Set<string>>();
  const minted = new Map<string, RefUnit>();

  for (const fact of facts) {
    const entry = factKindById(fact.kind, registry);
    const resolutions = fact.anchors.map((anchor) => ({ anchor, resolution: resolveAnchor(view, anchor) }));
    for (const { anchor, resolution } of resolutions) {
      if (resolution.status === "unmapped") {
        unmappedAnchors.push({ factId: fact.factId, kind: fact.kind, relativePath: anchor.relativePath, startLine: anchor.startLine, reason: resolution.reason });
      }
    }
    const resolved = resolutions.filter((entry) => entry.resolution.status === "resolved") as Array<{ anchor: FactAnchor; resolution: Extract<AnchorResolution, { status: "resolved" }> }>;
    const membership = membershipOf(entry, fact, resolved);
    if (membership === null) {
      unmappable.push(fact.factId);
      continue;
    }
    mapped.push({ factId: fact.factId, kind: fact.kind, membership, detail: fact.detail });
    if (!entry.structuralDeclaration || resolved.length === 0) continue;
    normalize(entry, fact, resolved[0]!, observedBy, minted, unnormalized);
  }

  return {
    mapped: mapped.sort((a, b) => a.kind.localeCompare(b.kind) || a.factId.localeCompare(b.factId)),
    unmappable: unmappable.sort(),
    unmappedAnchors: unmappedAnchors.sort((a, b) => a.factId.localeCompare(b.factId) || a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine),
    observedBy: new Map([...observedBy.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, producers]) => [id, [...producers].sort()])),
    mintedRefUnits: [...minted.values()].sort((a, b) => a.refUnitId.localeCompare(b.refUnitId)),
    unnormalized: unnormalized.sort((a, b) => a.factId.localeCompare(b.factId) || a.startLine - b.startLine)
  };
}

/**
 * Resolve one anchor to the cell it belongs to.
 *
 * The `lineOffsets === null` branch is where a file-level partition earns its keep: the file is ONE cell over
 * `[0, size)`, so "which cell does this line belong to" has one answer without opening the file, and the answer
 * is not a guess. A multi-cell file was necessarily decoded by the builder, so it always has a line index —
 * asserted rather than turned into a fourth reason, because a reason nothing can reach is worse than a throw.
 */
function resolveAnchor(view: PartitionView, anchor: FactAnchor): AnchorResolution {
  const file = view.fileOf(anchor.relativePath);
  if (file === null) return { status: "unmapped", reason: "path-not-counted" };
  if (file.cells.length === 0) return { status: "unmapped", reason: "file-not-partitioned" };
  const offsets = view.lineOffsetsOf(anchor.relativePath);
  if (offsets === null) {
    if (file.cells.length !== 1) {
      throw new Error(`${anchor.relativePath} has ${file.cells.length} partition cells but no line index; only a decoded file can have more than one cell, so the build result and the line index disagree`);
    }
    return { status: "resolved", cell: file.cells[0]!, file, reportedSpan: null, lineWindow: null };
  }
  if (!Number.isInteger(anchor.startLine) || anchor.startLine < 1 || anchor.startLine > offsets.lineCount) {
    return { status: "unmapped", reason: "line-outside-file" };
  }
  const lineWindow: CanonicalSpan = { startByte: offsets.startOfLine(anchor.startLine), endByte: offsets.endOfLine(anchor.startLine) };
  const reportedSpan = anchor.endLine !== null && anchor.endLine >= anchor.startLine && anchor.endLine <= offsets.lineCount
    ? { startByte: lineWindow.startByte, endByte: offsets.endOfLine(anchor.endLine) }
    : null;
  // A one-cell file is answered without any preference at all: that cell IS the file. It also covers the empty
  // file, whose only line is zero bytes wide and therefore intersects nothing — the case that would otherwise
  // reach the throw below with a partition that is perfectly correct.
  const cell = file.cells.length === 1
    ? file.cells[0]!
    : preferred(file.cells.filter((candidate) => intersects(candidate.span, lineWindow)), lineWindow, (candidate) => (candidate.partitionKind === "structure" ? 0 : 1), (candidate) => candidate.unitId);
  if (!cell) {
    // Unreachable while the partition tiles `[0, size)`: a non-empty line of a multi-cell file always intersects
    // one. A throw rather than a fourth reason, because a reason nothing can produce vouches for anything.
    throw new Error(`${anchor.relativePath}: line ${anchor.startLine} intersects no partition cell, so the partition does not cover the file it was built from`);
  }
  return { status: "resolved", cell, file, reportedSpan, lineWindow };
}

/** Half-open intersection. Two spans touching end-to-start do not intersect. */
function intersects(a: CanonicalSpan, b: CanonicalSpan): boolean {
  return a.startByte < b.endByte && b.startByte < a.endByte;
}

/**
 * The stated preference among the units a line-granular anchor could mean, as a total order.
 *
 * In order: a unit that STARTS inside the anchor's line (a declaration observed at line L is one that begins at
 * line L), then the caller's own rank (structure before residual), then the smaller span (the innermost of two
 * nested units), then the id, so two runs over one file cannot disagree.
 */
function preferred<T extends { readonly span: CanonicalSpan }>(
  candidates: readonly T[],
  lineWindow: CanonicalSpan,
  rank: (candidate: T) => number,
  id: (candidate: T) => string
): T | null {
  const startsInLine = (candidate: T): number =>
    (candidate.span.startByte >= lineWindow.startByte && candidate.span.startByte < Math.max(lineWindow.endByte, lineWindow.startByte + 1) ? 0 : 1);
  return [...candidates].sort((a, b) =>
    startsInLine(a) - startsInLine(b)
    || rank(a) - rank(b)
    || spanSize(a.span) - spanSize(b.span)
    || a.span.startByte - b.span.startByte
    || id(a).localeCompare(id(b))
  )[0] ?? null;
}

/**
 * The membership for one fact, or `null` when nothing resolved.
 *
 * Exhaustive over the closed union, so a new membership kind cannot be added in the base without this function
 * failing to compile. The arity checks THROW rather than degrade: a `unit` fact with two anchors is a producer
 * bug, and answering it would hide the bug behind a membership.
 */
function membershipOf(
  entry: FactKindEntry,
  fact: ObservedFact,
  resolved: readonly { anchor: FactAnchor; resolution: Extract<AnchorResolution, { status: "resolved" }> }[]
): Membership | null {
  switch (entry.membershipKind) {
    case "corpus":
      if (fact.anchors.length > 0) throw new Error(`Fact ${JSON.stringify(fact.factId)} is of corpus-domain kind ${JSON.stringify(fact.kind)} but carries ${fact.anchors.length} anchor(s); a corpus fact has no place in the source to point at`);
      return CORPUS_MEMBERSHIP;
    case "unit":
      requireArity(fact, entry, 1, 1);
      return resolved.length ? unitMembership(resolved[0]!.resolution.cell.unitId) : null;
    case "relation":
      requireArity(fact, entry, 2, Infinity);
      // Every end that DID resolve is kept, and the ends that did not are already in `unmappedAnchors`. Dropping
      // the whole relation would erase the half we can see; inventing the missing end would be worse.
      return resolved.length ? relationMembership(resolved.map((item) => item.resolution.cell.unitId)) : null;
    case "module":
      requireArity(fact, entry, 1, 1);
      return resolved.length ? moduleMembership(resolved[0]!.resolution.cell.rootName) : null;
    case "span-set": {
      requireArity(fact, entry, 1, 1);
      if (!resolved.length) return null;
      const { resolution } = resolved[0]!;
      // The reported span's own cells when the producer gave both ends; the anchor cell alone when it gave one,
      // or when the span is zero bytes wide and therefore intersects none — an empty set is not representable.
      const span = resolution.reportedSpan;
      const covered = span === null ? [] : resolution.file.cells.filter((cell) => intersects(cell.span, span));
      const cells = covered.length ? covered : [resolution.cell];
      return spanSetMembership(cells.map((cell) => cell.unitId));
    }
    default:
      return assertNever(entry.membershipKind, "fact kind membership kind");
  }
}

function requireArity(fact: ObservedFact, entry: FactKindEntry, min: number, max: number): void {
  if (fact.anchors.length < min || fact.anchors.length > max) {
    throw new Error(`Fact ${JSON.stringify(fact.factId)} of kind ${JSON.stringify(entry.id)} declares ${JSON.stringify(entry.membershipKind)} membership, which takes ${min === max ? min : `${min}..${max}`} anchor(s); it carries ${fact.anchors.length}`);
  }
}

/**
 * Attach one structural declaration to the builder's skeleton, or mint a reference unit for it.
 *
 * The builder's skeleton is the AUTHORITY on canonical spans (§一: observers may not change the partition, and
 * by the same argument they may not restate its units). So an observation that lands on a builder node adds a
 * producer to that node's `observedBy` and nothing else; only an observation the skeleton has no node for mints
 * a unit, and that unit says so in `normalization: "reported-span"`. Two values, both reachable, no third.
 */
function normalize(
  entry: FactKindEntry,
  fact: ObservedFact,
  first: { anchor: FactAnchor; resolution: Extract<AnchorResolution, { status: "resolved" }> },
  observedBy: Map<string, Set<string>>,
  minted: Map<string, RefUnit>,
  unnormalized: UnnormalizedObservation[]
): void {
  const { anchor, resolution } = first;
  const { file, lineWindow } = resolution;
  const claim = anchor.unitKind;
  if (lineWindow !== null) {
    const candidates = file.refUnits.filter((unit) =>
      intersects(unit.span, lineWindow) && (claim === null || kindClass(unit.unitKind) === kindClass(claim)));
    const hit = preferred(candidates, lineWindow, () => 0, (unit) => unit.refUnitId);
    if (hit) {
      record(observedBy, hit.refUnitId, entry.producer);
      return;
    }
  }
  const record_ = (reason: UnnormalizedReason): void => {
    unnormalized.push({ factId: fact.factId, kind: fact.kind, relativePath: anchor.relativePath, startLine: anchor.startLine, reason });
  };
  if (claim === null) return record_("no-kind-claim");
  if (anchor.endLine === null) return record_("no-end-line");
  if (lineWindow === null) return record_("no-line-index");
  if (resolution.reportedSpan === null) return record_("end-line-outside-file");
  const refUnitId = mintRefUnitId(claim, resolution.reportedSpan, anchor.relativePath);
  if (!minted.has(refUnitId)) {
    minted.set(refUnitId, {
      refUnitId,
      relativePath: anchor.relativePath,
      rootName: file.rootName,
      unitKind: claim,
      span: resolution.reportedSpan,
      depth: null,
      normalization: "reported-span"
    });
  }
  record(observedBy, refUnitId, entry.producer);
}

function record(observedBy: Map<string, Set<string>>, refUnitId: string, producer: string): void {
  const producers = observedBy.get(refUnitId) ?? new Set<string>();
  producers.add(producer);
  observedBy.set(refUnitId, producers);
}
