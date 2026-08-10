// Loader + hand-written structural validation for expected-knowledge-v1 files.
// This is an eval-internal format, NOT a public contract and NOT in schemas/.
// Zero dependencies: the small structure checks are written by hand rather than
// pulling in Ajv (deferred with the unmerged 57b-329 branch).

import { readFileSync } from "node:fs";
import type { Marker } from "./knowledge.ts";

/** A regex pattern kept alongside its source so error messages stay readable. */
export interface Pattern {
  raw: string;
  re: RegExp;
}

export interface Anchor {
  root?: string;
  path: string;
  lines?: string;
}

export type ItemKind = "fact" | "relation" | "unknown";

export interface ExpectedItem {
  id: string;
  kind: ItemKind;
  mustFind: boolean;
  anchors: Anchor[];
  /** fact items: all must match the same claim's statement (AND). */
  statementPatterns?: Pattern[];
  /** relation items: all must match a single trace step's action (AND). */
  stepPatterns?: Pattern[];
  /** unknown items: all must match a single unknown's text (AND). */
  patterns?: Pattern[];
  /** fact items: the matching claim's marker must be in this set (if given). */
  markers?: Marker[];
}

export interface ForbiddenItem {
  id: string;
  patterns: Pattern[];
  /** A claim with one of these markers whose statement matches all patterns is a violation. */
  markers: Marker[];
  note?: string;
}

export interface CoverageExpectation {
  dimension: string;
  expect: string[];
}

export interface Expected {
  version: "expected-knowledge-v1";
  target: string;
  items: ExpectedItem[];
  forbidden: ForbiddenItem[];
  coverage: CoverageExpectation[];
}

const MARKERS: readonly Marker[] = ["fact", "verified", "inferred", "unavailable"];
const KINDS: readonly ItemKind[] = ["fact", "relation", "unknown"];
const DEFAULT_FORBIDDEN_MARKERS: readonly Marker[] = ["fact", "verified"];

class ExpectedError extends Error {}

function fail(where: string, message: string): never {
  throw new ExpectedError(`expected-knowledge invalid at ${where}: ${message}`);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) fail(where, "expected a non-empty string");
  return value;
}

function compilePattern(value: unknown, where: string): Pattern {
  const raw = requireString(value, where);
  try {
    return { raw, re: new RegExp(raw, "u") };
  } catch (error) {
    return fail(where, `not a valid u-flag regex (${(error as Error).message})`);
  }
}

function compilePatterns(value: unknown, where: string, { required }: { required: boolean }): Pattern[] | undefined {
  if (value === undefined) {
    if (required) fail(where, "is required");
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) fail(where, "expected a non-empty array");
  return value.map((entry, i) => compilePattern(entry, `${where}[${i}]`));
}

function parseMarkers(value: unknown, where: string): Marker[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) fail(where, "expected a non-empty array");
  return value.map((entry, i) => {
    const marker = requireString(entry, `${where}[${i}]`);
    if (!MARKERS.includes(marker as Marker)) fail(`${where}[${i}]`, `unknown marker "${marker}"`);
    return marker as Marker;
  });
}

function parseAnchor(value: any, where: string): Anchor {
  if (!value || typeof value !== "object") fail(where, "expected an object");
  const anchor: Anchor = { path: requireString(value.path, `${where}.path`) };
  if (value.root !== undefined) anchor.root = requireString(value.root, `${where}.root`);
  if (value.lines !== undefined) {
    const lines = requireString(value.lines, `${where}.lines`);
    if (!/\d/.test(lines)) fail(`${where}.lines`, "must contain at least one line number");
    anchor.lines = lines;
  }
  return anchor;
}

function parseItem(value: any, i: number): ExpectedItem {
  const where = `items[${i}]`;
  if (!value || typeof value !== "object") fail(where, "expected an object");
  const id = requireString(value.id, `${where}.id`);
  const kind = requireString(value.kind, `${where}.kind`);
  if (!KINDS.includes(kind as ItemKind)) fail(`${where}.kind`, `unknown kind "${kind}"`);
  if (typeof value.mustFind !== "boolean") fail(`${where}.mustFind`, "expected a boolean");

  const anchorsRaw = value.anchors ?? [];
  if (!Array.isArray(anchorsRaw)) fail(`${where}.anchors`, "expected an array");
  const anchors = anchorsRaw.map((entry: unknown, j: number) => parseAnchor(entry, `${where}.anchors[${j}]`));
  if ((kind === "fact" || kind === "relation") && anchors.length === 0) {
    fail(`${where}.anchors`, `${kind} items require at least one anchor`);
  }

  const item: ExpectedItem = { id, kind: kind as ItemKind, mustFind: value.mustFind, anchors };
  if (kind === "fact") item.statementPatterns = compilePatterns(value.statementPatterns, `${where}.statementPatterns`, { required: false });
  if (kind === "relation") item.stepPatterns = compilePatterns(value.stepPatterns, `${where}.stepPatterns`, { required: false });
  if (kind === "unknown") item.patterns = compilePatterns(value.patterns, `${where}.patterns`, { required: true });
  const markers = parseMarkers(value.markers, `${where}.markers`);
  if (markers) item.markers = markers;
  return item;
}

function parseForbidden(value: any, i: number): ForbiddenItem {
  const where = `forbidden[${i}]`;
  if (!value || typeof value !== "object") fail(where, "expected an object");
  const item: ForbiddenItem = {
    id: requireString(value.id, `${where}.id`),
    patterns: compilePatterns(value.patterns, `${where}.patterns`, { required: true })!,
    markers: parseMarkers(value.markers, `${where}.markers`) ?? [...DEFAULT_FORBIDDEN_MARKERS]
  };
  if (value.note !== undefined) item.note = requireString(value.note, `${where}.note`);
  return item;
}

function parseCoverage(value: any, i: number): CoverageExpectation {
  const where = `coverage[${i}]`;
  if (!value || typeof value !== "object") fail(where, "expected an object");
  const expect = value.expect;
  if (!Array.isArray(expect) || expect.length === 0) fail(`${where}.expect`, "expected a non-empty array");
  return {
    dimension: requireString(value.dimension, `${where}.dimension`),
    expect: expect.map((entry: unknown, j: number) => requireString(entry, `${where}.expect[${j}]`))
  };
}

/** Validate a parsed expected-knowledge object and compile every pattern. Throws on any violation. */
export function validateExpected(raw: any): Expected {
  if (!raw || typeof raw !== "object") fail("root", "expected an object");
  if (raw.version !== "expected-knowledge-v1") fail("version", `expected "expected-knowledge-v1", got ${JSON.stringify(raw.version)}`);
  const target = requireString(raw.target, "target");
  if (!Array.isArray(raw.items) || raw.items.length === 0) fail("items", "expected a non-empty array");

  const items = raw.items.map((entry: unknown, i: number) => parseItem(entry, i));
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) fail("items", `duplicate item id "${item.id}"`);
    ids.add(item.id);
  }
  const forbiddenRaw = raw.forbidden ?? [];
  if (!Array.isArray(forbiddenRaw)) fail("forbidden", "expected an array");
  const coverageRaw = raw.coverage ?? [];
  if (!Array.isArray(coverageRaw)) fail("coverage", "expected an array");

  return {
    version: "expected-knowledge-v1",
    target,
    items,
    forbidden: forbiddenRaw.map((entry: unknown, i: number) => parseForbidden(entry, i)),
    coverage: coverageRaw.map((entry: unknown, i: number) => parseCoverage(entry, i))
  };
}

/** Read and validate an expected-knowledge-v1 file from disk. */
export function loadExpected(file: string): Expected {
  return validateExpected(JSON.parse(readFileSync(file, "utf8")));
}
