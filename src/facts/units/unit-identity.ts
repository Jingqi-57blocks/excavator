/**
 * The two unit identities of layer 3, and the byte arithmetic they are stated in.
 *
 * A CANONICAL SPAN is a half-open interval of UTF-8 BYTE offsets, `[startByte, endByte)`. Line numbers were
 * rejected for two independent reasons, and either one alone would be enough: two structures can share a line
 * (minified JavaScript), so line granularity cannot structurally guarantee non-overlap; and the completeness
 * arithmetic of §四's three-state law has to add up to layer 1's tier1 `size`, which is a byte count. An empty
 * file is `[0, 0)` — a real interval, not a missing one.
 *
 * THE INSTRUMENT WAS VERIFIED BEFORE IT WAS USED, and it did not say what its own types say. `@ast-grep/napi`
 * 0.45.1 declares `Pos.index` as "byte offset of the position" (`types/sgnode.d.ts:28`). Measured against a
 * fixture of Chinese comment text plus an emoji: a 52-byte / 42-UTF-16-unit source reports a root range ending
 * at index 42, and slicing by those indices is correct with `String.prototype.slice` and garbage with
 * `Buffer.subarray`. **`index` is UTF-16 code units.** So every offset that enters a canonical span goes through
 * `utf8OffsetMap` first, and `tests/unit-identity.test.ts` pins the conversion against Node's own encoder. Had
 * this been assumed rather than measured, every span on every file containing one non-ASCII byte would have been
 * wrong — silently, and consistently enough to look right.
 *
 * ENCODING puts the path LAST and splits on the first three colons only, so a path may contain any character
 * (colons included) with no ambiguity and no escaping scheme to get wrong:
 *
 *     RefUnitId: ref:<unit-kind>:<startByte>-<endByte>:<relativePath>
 *     UnitId:    cell:<partition-kind>:<startByte>-<endByte>:<relativePath>
 *
 * NEITHER carries a producer — there is no producer parameter on either constructor, so "the denominator is a
 * count of tool observations" is not expressible. And neither is a content hash: 226 of provital's 3005 counted
 * files are byte-identical to another path (83 groups, the largest 22 empty `__init__.py` files), so a
 * content-addressed identity would collapse those groups while every conservation law still balanced. The path
 * component is what makes them distinct, structurally; the snapshot binding is not repeated per row but travels
 * once, in `units.json`'s identity block (`filesContentManifestDigest`).
 */

/** The reference-unit vocabulary, v1. A nested structure gets one of these; the partition does not. */
export const UNIT_KINDS = ["class", "function", "method", "closure"] as const;
export type UnitKind = typeof UNIT_KINDS[number];

/**
 * The partition-cell vocabulary, v1. `structure` is a cell the designated builder found; `residual` is what is
 * left of the file. A language with no designated builder has residual cells only — and the REASON lives in the
 * per-file record, never in the id, because a reason in an id would make the id move when the reason does.
 */
export const PARTITION_KINDS = ["structure", "residual"] as const;
export type PartitionKind = typeof PARTITION_KINDS[number];

/** A half-open interval of UTF-8 byte offsets. `[0, 0)` is the empty file, and it is a legal span. */
export interface CanonicalSpan {
  readonly startByte: number;
  readonly endByte: number;
}

export function canonicalSpan(startByte: number, endByte: number): CanonicalSpan {
  requireOffset("startByte", startByte);
  requireOffset("endByte", endByte);
  if (endByte < startByte) throw new Error(`A canonical span may not run backwards: [${startByte}, ${endByte})`);
  return { startByte, endByte };
}

function requireOffset(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`A canonical span offset must be a non-negative integer; ${name} is ${value}`);
}

export function spanSize(span: CanonicalSpan): number {
  return span.endByte - span.startByte;
}

/** Half-open, so two spans touching end-to-start (`[0,5)` and `[5,9)`) do NOT overlap. */
export function spansOverlap(a: CanonicalSpan, b: CanonicalSpan): boolean {
  return a.startByte < b.endByte && b.startByte < a.endByte;
}

export function compareSpans(a: CanonicalSpan, b: CanonicalSpan): number {
  return a.startByte - b.startByte || a.endByte - b.endByte;
}

// --- the two id constructors: no producer parameter exists, so no producer can enter an id -------------------

export function mintRefUnitId(unitKind: UnitKind, span: CanonicalSpan, relativePath: string): string {
  return `ref:${unitKind}:${span.startByte}-${span.endByte}:${requirePath(relativePath)}`;
}

export function mintUnitId(partitionKind: PartitionKind, span: CanonicalSpan, relativePath: string): string {
  return `cell:${partitionKind}:${span.startByte}-${span.endByte}:${requirePath(relativePath)}`;
}

function requirePath(relativePath: string): string {
  if (!relativePath.trim()) throw new Error("A unit id requires the target-relative path of the file it is in; without it two byte-identical files collapse to one id");
  if (relativePath.startsWith("/")) throw new Error(`A unit id takes a target-RELATIVE path; got ${JSON.stringify(relativePath)}`);
  return relativePath;
}

export type UnitNamespace = "ref" | "cell";

export interface ParsedUnitId {
  readonly namespace: UnitNamespace;
  /** A `UnitKind` for `ref`, a `PartitionKind` for `cell`; both validated against their closed set. */
  readonly kind: string;
  readonly span: CanonicalSpan;
  readonly relativePath: string;
}

/**
 * The inverse of the two constructors, and the reason the encoding puts the path last.
 *
 * Splitting on the FIRST THREE colons and taking the remainder as the path means a path containing a colon
 * round-trips exactly, with no escaping. Throwing rather than returning null is deliberate: every id this parses
 * was minted by the constructors above, so a malformed one means a consumer built an id by hand — which is the
 * thing that must not be possible to do quietly.
 */
export function parseUnitId(id: string): ParsedUnitId {
  const first = id.indexOf(":");
  const second = id.indexOf(":", first + 1);
  const third = id.indexOf(":", second + 1);
  if (first < 0 || second < 0 || third < 0) throw new Error(`Malformed unit id ${JSON.stringify(id)}: expected <namespace>:<kind>:<start>-<end>:<path>`);
  const namespace = id.slice(0, first);
  const kind = id.slice(first + 1, second);
  const range = id.slice(second + 1, third);
  const relativePath = id.slice(third + 1);
  if (namespace !== "ref" && namespace !== "cell") throw new Error(`Malformed unit id ${JSON.stringify(id)}: unknown namespace ${JSON.stringify(namespace)}`);
  const legal: readonly string[] = namespace === "ref" ? UNIT_KINDS : PARTITION_KINDS;
  if (!legal.includes(kind)) throw new Error(`Malformed unit id ${JSON.stringify(id)}: ${JSON.stringify(kind)} is not one of ${legal.join(", ")}`);
  const match = /^(\d+)-(\d+)$/.exec(range);
  if (!match) throw new Error(`Malformed unit id ${JSON.stringify(id)}: ${JSON.stringify(range)} is not a byte range`);
  if (!relativePath) throw new Error(`Malformed unit id ${JSON.stringify(id)}: no path component`);
  return { namespace, kind, span: canonicalSpan(Number(match[1]), Number(match[2])), relativePath };
}

// --- UTF-16 -> UTF-8, because the parser counts in the other unit ------------------------------------------

export interface Utf8OffsetMap {
  /** The UTF-8 byte offset of a UTF-16 code-unit index. `source.length` maps to the total byte length. */
  byteOffsetOf(utf16Index: number): number;
  /** The source's length in UTF-8 bytes. */
  readonly byteLength: number;
}

/**
 * A UTF-16-index → UTF-8-byte-offset map for one source string.
 *
 * The ASCII fast path is not an optimisation detail, it is most of the corpus: when the byte length equals the
 * UTF-16 length the two coordinate systems are identical and no table is built at all. For anything else a table
 * is built in one pass, because the alternative — `Buffer.byteLength(source.slice(0, i))` per query — is O(n) per
 * node and quadratic over a file with many declarations.
 *
 * The last line is a SELF-CHECK against Node's own encoder. A converter that is wrong is worse than none: it
 * would produce plausible spans that silently point a few bytes off, and every downstream assertion about
 * non-overlap and completeness would still pass.
 */
export function utf8OffsetMap(source: string): Utf8OffsetMap {
  const byteLength = Buffer.byteLength(source, "utf8");
  if (byteLength === source.length) {
    return {
      byteLength,
      byteOffsetOf: (index) => {
        requireIndex(index, source.length);
        return index;
      }
    };
  }
  const table = new Uint32Array(source.length + 1);
  /** UTF-16 indexes that sit between the two halves of a surrogate pair: not a character boundary at all. */
  const split = new Set<number>();
  let bytes = 0;
  let i = 0;
  while (i < source.length) {
    table[i] = bytes;
    const codePoint = source.codePointAt(i)!;
    if (codePoint <= 0x7f) { bytes += 1; i += 1; continue; }
    if (codePoint <= 0x7ff) { bytes += 2; i += 1; continue; }
    // A lone surrogate is 3 bytes too: Node encodes it as the U+FFFD replacement, and the self-check below is
    // what proves this branch agrees with the encoder rather than merely looking like it should.
    if (codePoint <= 0xffff) { bytes += 3; i += 1; continue; }
    bytes += 4;
    split.add(i + 1);
    table[i + 1] = bytes;
    i += 2;
  }
  table[source.length] = bytes;
  if (bytes !== byteLength) {
    throw new Error(`The UTF-8 offset map disagrees with Node's encoder (${bytes} vs ${byteLength} bytes); every span derived from it would be wrong by a plausible-looking amount`);
  }
  return {
    byteLength,
    byteOffsetOf: (index) => {
      requireIndex(index, source.length);
      if (split.has(index)) throw new Error(`UTF-16 index ${index} falls inside a surrogate pair, so it is not a byte boundary and cannot begin or end a canonical span`);
      return table[index]!;
    }
  };
}

function requireIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index > length) {
    throw new Error(`UTF-16 index ${index} is outside the source (0..${length})`);
  }
}

// --- lines -> bytes, because every producer in this repository reports lines --------------------------------

/**
 * One file's line boundaries in UTF-8 byte offsets, 1-based lines.
 *
 * It exists because of a measured asymmetry: canonical spans are byte intervals, and NOT ONE producer in this
 * repository reports a byte offset. `PerlSub` carries a line, a framework `RouteAction` carries a line, a
 * `RecoveredRoute` carries a line and sometimes an end line, and only CodeGraph nodes carry both. So every
 * observation enters the partition through a line→byte conversion, and this is the one that performs it.
 *
 * Built from the BYTES, not from the decoded string: a newline is one byte in UTF-8 and the offsets have to be
 * the file's own, so counting `\n` in the buffer is both the simplest and the only correct way to do it.
 */
export interface LineOffsets {
  readonly byteLength: number;
  readonly lineCount: number;
  /** Byte offset of the first byte of line `line`. Throws outside `1..lineCount`. */
  startOfLine(line: number): number;
  /** Byte offset just past line `line`, its newline included. Throws outside `1..lineCount`. */
  endOfLine(line: number): number;
}

export function lineOffsetsFromBytes(bytes: Uint8Array): LineOffsets {
  const starts: number[] = [0];
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0x0a && index + 1 < bytes.length) starts.push(index + 1);
  }
  const byteLength = bytes.length;
  const lineCount = starts.length;
  const require = (line: number): number => {
    if (!Number.isInteger(line) || line < 1 || line > lineCount) {
      throw new Error(`Line ${line} is outside the file (1..${lineCount})`);
    }
    return line;
  };
  return {
    byteLength,
    lineCount,
    startOfLine: (line) => starts[require(line) - 1]!,
    endOfLine: (line) => (require(line) === lineCount ? byteLength : starts[line]!)
  };
}
