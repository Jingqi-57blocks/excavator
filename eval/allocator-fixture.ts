import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { inventoryFactIdBaseOf, inventoryFactIdFor } from "../src/codegraph/function-inventory.ts";
import { canonicalJson, sha256 } from "../src/base/util.ts";
import { unitsContentDigest } from "../src/facts/units/units-artifact.ts";
import type { UnitsArtifact } from "../src/facts/units/units-artifact.ts";
import { loadPrunePool } from "./prune-replay.ts";

export const ALLOCATOR_FIXTURE_VERSION = "allocator-fixture-v1";

export interface AllocatorProjectionRow {
  nodeId: string;
  nodeKind: string;
  name: string;
  relativePath: string;
  startLine: number | null;
  endLine: number | null;
  moduleId: string;
  language: string | null;
  factId: string | null;
  unitId: string | null;
  partitionKind: "structure" | "residual" | null;
}

export interface AllocatorProjectionFixture {
  version: typeof ALLOCATOR_FIXTURE_VERSION;
  poolDigest: string;
  unitsContentDigest: string;
  rows: AllocatorProjectionRow[];
}

interface Built<T> { status: "built"; value: T }

function builtValue<T>(path: string): T {
  const artifact = JSON.parse(readFileSync(path, "utf8")) as Partial<Built<T>>;
  if (artifact.status !== "built" || artifact.value === undefined) throw new Error(`${path} is not a Built artifact`);
  return artifact.value;
}

/**
 * Freeze the old selector's candidate pool against the canonical partition it was measured with.
 * This is eval-only: production continues to consume the layer artifacts through their normal boundary.
 */
export function buildAllocatorProjectionFixture(runDir: string, poolFile: string): AllocatorProjectionFixture {
  const pool = loadPrunePool(poolFile);
  const units = builtValue<UnitsArtifact>(`${runDir}/facts/units.json`);
  const envelope = builtValue<{
    facts: Array<{ factId: string; detail?: { language?: string }; membership: { kind: string; unitId?: string } }>;
  }>(`${runDir}/facts/producers/codegraph.json`);
  const counted = builtValue<{ counted: Array<{ relativePath: string }> }>(`${runDir}/ledger/files.json`);

  const countedPaths = new Set(counted.counted.map((row) => row.relativePath));
  const cells = new Map(units.partition.map((cell) => [cell.unitId, cell]));
  const facts = new Map<string, { factId: string; language: string | null; unitId: string }>();
  for (const fact of envelope.facts) {
    if (fact.membership.kind !== "unit" || typeof fact.membership.unitId !== "string") continue;
    const base = inventoryFactIdBaseOf(fact.factId);
    const row = { factId: base, language: fact.detail?.language ?? null, unitId: fact.membership.unitId };
    const previous = facts.get(base);
    if (previous && previous.unitId !== row.unitId) throw new Error(`fact base ${base} maps to two partition cells`);
    facts.set(base, row);
  }

  const rows = pool.nodes.map((node): AllocatorProjectionRow => {
    const nodeId = String(node.id);
    const relativePath = String(node.filePath ?? "");
    const separator = nodeId.indexOf("\0");
    const factBase = countedPaths.has(relativePath) ? inventoryFactIdFor({
      kind: String(node.kind ?? ""),
      filePath: relativePath,
      startLine: Number.isInteger(node.startLine) ? Number(node.startLine) : null,
      endLine: Number.isInteger(node.endLine) ? Number(node.endLine) : null,
      name: String(node.name ?? "")
    }) : null;
    const fact = factBase === null ? undefined : facts.get(factBase);
    const cell = fact ? cells.get(fact.unitId) : undefined;
    if (fact && !cell) throw new Error(`pool node ${nodeId} maps to missing partition cell ${fact.unitId}`);
    return {
      nodeId,
      nodeKind: String(node.kind ?? ""),
      name: String(node.name ?? ""),
      relativePath,
      startLine: Number.isInteger(node.startLine) ? Number(node.startLine) : null,
      endLine: Number.isInteger(node.endLine) ? Number(node.endLine) : null,
      moduleId: separator < 0 ? "" : nodeId.slice(0, separator),
      language: fact?.language ?? null,
      factId: fact?.factId ?? null,
      unitId: fact?.unitId ?? null,
      partitionKind: cell?.partitionKind ?? null
    };
  }).sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  return {
    version: ALLOCATOR_FIXTURE_VERSION,
    poolDigest: sha256(readFileSync(poolFile)),
    unitsContentDigest: unitsContentDigest(units),
    rows
  };
}

export function writeAllocatorProjectionFixture(path: string, fixture: AllocatorProjectionFixture): void {
  writeFileSync(path, gzipSync(Buffer.from(`${canonicalJson(fixture)}\n`, "utf8")));
}

export function loadAllocatorProjectionFixture(path: string): AllocatorProjectionFixture {
  const fixture = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as AllocatorProjectionFixture;
  if (fixture.version !== ALLOCATOR_FIXTURE_VERSION || !Array.isArray(fixture.rows)) throw new Error(`invalid allocator fixture: ${path}`);
  return fixture;
}
