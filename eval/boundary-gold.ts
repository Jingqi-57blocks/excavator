// Loader + hand-written structural validation for boundary-gold-v1 files.
// Mirrors expected.ts in spirit: an eval-internal, per-fixture data format (NOT a
// public contract, NOT in schemas/), validated by hand rather than pulling in a
// schema dependency; this eval layer follows Core's dependency-whitelist discipline.
//
// A boundary gold pins which material feature nodes MUST land inside the feature
// graph node set (the output of pruneFeatureGraph). Each item's anchors are OR:
// a node satisfying any one anchor puts the item in-bounds. Anchor path matching
// reuses diff.ts's three-form `pathMatches` so boundary and knowledge-diff share
// exactly one anchor path semantics; name is an exact node-name match; lines fall
// back to overlap only when an item has no single node name (broad windows).

import { readFileSync } from "node:fs";

export interface BoundaryAnchor {
  path: string;
  /** Exact match against a node's name (preferred, most stable). */
  name?: string;
  /** Line window, used only when no `name` applies: overlaps a node's [startLine, endLine]. */
  lines?: string;
}

export interface BoundaryGoldItem {
  id: string;
  /** true: the node set MUST contain a match (gate); false: informational only. */
  mustFind: boolean;
  /** OR semantics: any one matching anchor puts the item in-bounds. */
  anchors: BoundaryAnchor[];
  note?: string;
}

export interface BoundaryGold {
  version: "boundary-gold-v1";
  target: string;
  items: BoundaryGoldItem[];
}

class BoundaryGoldError extends Error {}

function fail(where: string, message: string): never {
  throw new BoundaryGoldError(`boundary-gold invalid at ${where}: ${message}`);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) fail(where, "expected a non-empty string");
  return value;
}

function parseAnchor(value: any, where: string): BoundaryAnchor {
  if (!value || typeof value !== "object") fail(where, "expected an object");
  const anchor: BoundaryAnchor = { path: requireString(value.path, `${where}.path`) };
  if (value.name !== undefined) anchor.name = requireString(value.name, `${where}.name`);
  if (value.lines !== undefined) {
    const lines = requireString(value.lines, `${where}.lines`);
    if (!/\d/.test(lines)) fail(`${where}.lines`, "must contain at least one line number");
    anchor.lines = lines;
  }
  return anchor;
}

function parseItem(value: any, i: number): BoundaryGoldItem {
  const where = `items[${i}]`;
  if (!value || typeof value !== "object") fail(where, "expected an object");
  const id = requireString(value.id, `${where}.id`);
  if (typeof value.mustFind !== "boolean") fail(`${where}.mustFind`, "expected a boolean");
  if (!Array.isArray(value.anchors) || value.anchors.length === 0) fail(`${where}.anchors`, "expected a non-empty array");
  const anchors = value.anchors.map((entry: unknown, j: number) => parseAnchor(entry, `${where}.anchors[${j}]`));
  const item: BoundaryGoldItem = { id, mustFind: value.mustFind, anchors };
  if (value.note !== undefined) item.note = requireString(value.note, `${where}.note`);
  return item;
}

/** Validate a parsed boundary-gold object. Throws on any structural violation. */
export function validateBoundaryGold(raw: any): BoundaryGold {
  if (!raw || typeof raw !== "object") fail("root", "expected an object");
  if (raw.version !== "boundary-gold-v1") fail("version", `expected "boundary-gold-v1", got ${JSON.stringify(raw.version)}`);
  const target = requireString(raw.target, "target");
  if (!Array.isArray(raw.items) || raw.items.length === 0) fail("items", "expected a non-empty array");

  const items = raw.items.map((entry: unknown, i: number) => parseItem(entry, i));
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) fail("items", `duplicate item id "${item.id}"`);
    ids.add(item.id);
  }
  return { version: "boundary-gold-v1", target, items };
}

/** Read and validate a boundary-gold-v1 file from disk. */
export function loadBoundaryGold(file: string): BoundaryGold {
  return validateBoundaryGold(JSON.parse(readFileSync(file, "utf8")));
}
