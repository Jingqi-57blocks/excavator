// SOUP (software of unknown provenance) inventory: a deterministic, model-free scan of the snapshot
// boundary for third-party components declared in manifests, lockfiles and container definitions.
//
// The scan is workspace-level (bound to a snapshot, not to a feature). It reuses createSnapshot() so the
// inventory is pinned to a `snapshotId`, then runs the table-driven parsers (soup-parsers.ts) over the
// files inside the boundary. Every component carries `file:line` evidence; a component group with no
// exact version anywhere becomes a structural gap. Ordering is total and version-stable, and the digest
// excludes `createdAt`, so two runs over the same tree are byte-identical.
//
// Scope guardrails (see docs/direction.md and the SOUP plan): no purpose/description, no regulatory
// mapping, no dependency-tree/transitive resolution — those are later layers. Vertical-neutral: nothing
// here keys on any domain.

import { readFile } from "node:fs/promises";
import { createSnapshot } from "./snapshot.ts";
import type { EvidenceItem } from "./types.ts";
import { nowIso, sha256, stableJson } from "./util.ts";
import { SOUP_PARSERS } from "./soup-parsers.ts";
import type { SoupEcosystem, SoupScope, SoupSource } from "./soup-parsers.ts";

export const SOUP_VERSION = "soup-v1";
export const DEFAULT_MAX_ITEMS_PER_ECOSYSTEM = 5000;

export interface SoupEvidenceRef {
  path: string;
  line: number;
}

export interface SoupComponent {
  ecosystem: SoupEcosystem;
  name: string;
  /** Exact pinned version; null when only a constraint/`latest`/absent reference was found. */
  version: string | null;
  versionSpec?: string;
  source: SoupSource;
  scope?: SoupScope;
  evidence: SoupEvidenceRef[];
}

export interface SoupGap {
  ecosystem: SoupEcosystem;
  name: string;
  reason: "no-exact-version";
  evidence: SoupEvidenceRef[];
}

export interface SoupCoverage {
  ecosystem: SoupEcosystem;
  parserId: string;
  filesMatched: number;
  filesParsed: number;
  itemCount: number;
  truncated: boolean;
  notes: string[];
}

export interface SoupInventory {
  version: typeof SOUP_VERSION;
  snapshotId: string;
  target: string;
  createdAt: string;
  components: SoupComponent[];
  gaps: SoupGap[];
  coverage: SoupCoverage[];
  warnings: string[];
  digest: string;
}

export interface BuildSoupOptions {
  maxFiles?: number;
  maxItemsPerEcosystem?: number;
  scannerVersion?: string;
}

/** Code-point (not locale) comparison, so ordering is identical on every machine. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEvidence(a: SoupEvidenceRef, b: SoupEvidenceRef): number {
  return compareStrings(a.path, b.path) || a.line - b.line;
}

function dedupeEvidence(evidence: SoupEvidenceRef[]): SoupEvidenceRef[] {
  const byKey = new Map<string, SoupEvidenceRef>();
  for (const item of evidence) byKey.set(`${item.path}:${item.line}`, item);
  return [...byKey.values()].sort(compareEvidence);
}

const componentDedupeKey = (component: SoupComponent): string =>
  [component.ecosystem, component.name, component.version ?? "", component.versionSpec ?? "", component.source, component.scope ?? ""].join("|");

function compareComponents(a: SoupComponent, b: SoupComponent): number {
  return compareStrings(a.ecosystem, b.ecosystem)
    || compareStrings(a.name, b.name)
    || compareStrings(a.version ?? a.versionSpec ?? "", b.version ?? b.versionSpec ?? "")
    || compareStrings(a.source, b.source)
    || compareStrings(a.scope ?? "", b.scope ?? "");
}

export async function buildSoupInventory(target: string, options: BuildSoupOptions = {}): Promise<SoupInventory> {
  const cap = options.maxItemsPerEcosystem ?? DEFAULT_MAX_ITEMS_PER_ECOSYSTEM;
  const { snapshot, files } = await createSnapshot(target, undefined, options.maxFiles ?? 100_000, options.scannerVersion);

  const rawComponents: SoupComponent[] = [];
  const coverage: SoupCoverage[] = [];
  const warnings: string[] = [];

  for (const parser of SOUP_PARSERS) {
    const matched = files.filter((file) => parser.matches(file.relativePath));
    if (!matched.length) continue;
    let filesParsed = 0;
    let itemCount = 0;
    const notes: string[] = [];
    for (const file of matched.sort((a, b) => compareStrings(a.relativePath, b.relativePath))) {
      let content: string;
      try { content = await readFile(file.absolutePath, "utf8"); }
      catch { notes.push(`${file.relativePath}: could not be read; skipped`); continue; }
      let result;
      try { result = parser.parse(content); }
      catch (error) { notes.push(`${file.relativePath}: parser error (${(error as Error).message}); skipped`); continue; }
      filesParsed += 1;
      for (const note of result.notes) notes.push(`${file.relativePath}: ${note}`);
      for (const item of result.items) {
        itemCount += 1;
        rawComponents.push({
          ecosystem: parser.ecosystem,
          name: item.name,
          version: item.version,
          ...(item.versionSpec ? { versionSpec: item.versionSpec } : {}),
          source: parser.source,
          ...(item.scope ? { scope: item.scope } : {}),
          evidence: [{ path: file.relativePath, line: item.line }]
        });
      }
    }
    coverage.push({ ecosystem: parser.ecosystem, parserId: parser.id, filesMatched: matched.length, filesParsed, itemCount, truncated: false, notes });
  }

  // Merge duplicate declarations (same component seen in several files), unioning their evidence.
  const merged = new Map<string, SoupComponent>();
  for (const component of rawComponents) {
    const key = componentDedupeKey(component);
    const existing = merged.get(key);
    if (existing) existing.evidence = dedupeEvidence([...existing.evidence, ...component.evidence]);
    else merged.set(key, { ...component, evidence: dedupeEvidence(component.evidence) });
  }
  const deduped = [...merged.values()];

  // Group-level gap: a (ecosystem, name) group with no exact version anywhere is unresolved.
  const gaps = deriveGaps(deduped);

  // Honest per-ecosystem cap: truncate deterministically, flag the coverage rows, and warn — never
  // silently drop. Gaps are derived before truncation so a dropped exact version cannot invent a gap.
  const components = capComponents(deduped.sort(compareComponents), cap, coverage, warnings);

  const identity = { version: SOUP_VERSION, snapshotId: snapshot.id, target: snapshot.target, components, gaps, coverage, warnings };
  return { ...identity, createdAt: nowIso(), digest: sha256(stableJson(identity)) };
}

function deriveGaps(components: SoupComponent[]): SoupGap[] {
  const groups = new Map<string, { ecosystem: SoupEcosystem; name: string; hasExact: boolean; evidence: SoupEvidenceRef[] }>();
  for (const component of components) {
    const key = `${component.ecosystem}|${component.name}`;
    const group = groups.get(key) ?? { ecosystem: component.ecosystem, name: component.name, hasExact: false, evidence: [] };
    if (component.version !== null) group.hasExact = true;
    group.evidence.push(...component.evidence);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => !group.hasExact)
    .map((group) => ({ ecosystem: group.ecosystem, name: group.name, reason: "no-exact-version" as const, evidence: dedupeEvidence(group.evidence) }))
    .sort((a, b) => compareStrings(a.ecosystem, b.ecosystem) || compareStrings(a.name, b.name));
}

function capComponents(sorted: SoupComponent[], cap: number, coverage: SoupCoverage[], warnings: string[]): SoupComponent[] {
  const counts = new Map<SoupEcosystem, number>();
  for (const component of sorted) counts.set(component.ecosystem, (counts.get(component.ecosystem) ?? 0) + 1);
  const overflowed = new Set<SoupEcosystem>();
  for (const [ecosystem, count] of counts) if (count > cap) overflowed.add(ecosystem);
  if (!overflowed.size) return sorted;

  for (const ecosystem of [...overflowed].sort(compareStrings)) {
    warnings.push(`${ecosystem}: component count exceeded the cap of ${cap}; the list was truncated`);
    for (const row of coverage) if (row.ecosystem === ecosystem) row.truncated = true;
  }
  const kept = new Map<SoupEcosystem, number>();
  const result: SoupComponent[] = [];
  for (const component of sorted) {
    if (!overflowed.has(component.ecosystem)) { result.push(component); continue; }
    const used = kept.get(component.ecosystem) ?? 0;
    if (used >= cap) continue;
    kept.set(component.ecosystem, used + 1);
    result.push(component);
  }
  return result;
}

/**
 * Derive one evidence item per ecosystem present in the inventory, mirroring factPackEvidence: an
 * enumeration (including its coverage limits and gaps) is a fact. Evidence stores only path+line, never
 * file content. `kind: "manifest"` marks these as declared-dependency facts.
 */
export function soupEvidence(inventory: SoupInventory): EvidenceItem[] {
  const ecosystems = [...new Set(inventory.coverage.map((row) => row.ecosystem))].sort(compareStrings);
  return ecosystems.map((ecosystem) => {
    const data = {
      ecosystem,
      components: inventory.components.filter((component) => component.ecosystem === ecosystem),
      gaps: inventory.gaps.filter((gap) => gap.ecosystem === ecosystem),
      coverage: inventory.coverage.filter((row) => row.ecosystem === ecosystem)
    };
    return {
      id: `SOUP-${ecosystem}-${inventory.snapshotId.slice(0, 8)}`,
      snapshotId: inventory.snapshotId,
      kind: "manifest" as const,
      title: `SOUP inventory: ${ecosystem}`,
      reason: `enumerate every ${ecosystem} declared component inside the snapshot boundary, with its version-resolution gaps and coverage limits`,
      data,
      digest: sha256(stableJson(data))
    };
  });
}
