import type { FactPackItem, FeatureFactPack } from "./types.ts";

/**
 * Deterministic cross-feature relationships.
 *
 * For every unordered pair of prepared features this computes the signals they share, by pure set
 * intersection over data already persisted at prepare time — feature scope files and the feature
 * fact pack. No model is involved and nothing is framework-specific: the input is generic scope and
 * fact-pack data, so the same code serves any target.
 *
 * The honesty limit is stated in `notes`: a multi-module target produces no cross-module CodeGraph
 * edges by design (see `src/codegraph-set.ts`), so relationships are limited to shared files,
 * entities and config keys. Single-graph call/reference edge relationships are deferred, not included.
 */

/** One prepared feature's inputs: its stable key, display subject, scope files and fact pack. */
export interface CrossFeatureInput {
  key: string;
  subject: string;
  files: string[];
  factPack: FeatureFactPack;
}

/** A shared entity, keyed by name plus location; location is absent only when the fact carried none. */
export interface SharedEntity {
  name: string;
  filePath?: string;
  line?: number;
}

export interface CrossFeatureRelationship {
  featureA: string;
  featureB: string;
  subjectA: string;
  subjectB: string;
  sharedFiles: string[];
  sharedEntities: SharedEntity[];
  sharedConfigKeys: string[];
}

export interface CrossFeatureRelationships {
  version: "cross-feature-v1";
  relationships: CrossFeatureRelationship[];
  notes: string[];
}

const CROSS_MODULE_NOTE =
  "Cross-module CodeGraph edges are not represented: a multi-module target produces no cross-module graph edges by design, so these relationships are limited to shared files, entities and config keys.";
const GRAPH_EDGE_NOTE =
  "Single-graph call/reference edge relationships are deferred; every relationship here comes from a shared file, entity or config key, never from a graph edge.";

/** The markdown detail lists cap at this many items and point to the JSON for the remainder. */
const MAX_LIST = 25;

/**
 * Compute the shared-signal relationship for every unordered feature pair.
 *
 * Output is deterministic and stable: features are ordered by key, pairs are emitted in that order
 * with the lexicographically smaller key first, and every shared list is sorted. Only pairs with at
 * least one shared signal are emitted.
 */
export function computeCrossFeatureRelationships(features: CrossFeatureInput[]): CrossFeatureRelationships {
  const sorted = [...features].sort((a, b) => compare(a.key, b.key));
  const relationships: CrossFeatureRelationship[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      const sharedFiles = intersectFiles(a.files, b.files);
      const sharedEntities = intersectEntities(a.factPack, b.factPack);
      const sharedConfigKeys = intersectConfigKeys(a.factPack, b.factPack);
      if (!sharedFiles.length && !sharedEntities.length && !sharedConfigKeys.length) continue;
      relationships.push({
        featureA: a.key,
        featureB: b.key,
        subjectA: a.subject,
        subjectB: b.subject,
        sharedFiles,
        sharedEntities,
        sharedConfigKeys
      });
    }
  }
  return { version: "cross-feature-v1", relationships, notes: [CROSS_MODULE_NOTE, GRAPH_EDGE_NOTE] };
}

/** Render the relationships as a compact matrix plus per-pair detail, for the shared context markdown. */
export function renderCrossFeatureSection(data: CrossFeatureRelationships): string {
  const notes = data.notes.map((note) => `- ${note}`).join("\n");
  const intro = `## Cross-feature relationships

Deterministic shared-signal relationships between the prepared features, computed from the feature scopes and fact packs by set intersection (no model involved). This is context material, not an audited claim; the complete machine-readable data is \`context/cross-feature.json\`.`;
  if (!data.relationships.length) {
    return `${intro}

No pair of prepared features shares a file, entity or config key.

${notes}`;
  }
  const rows = data.relationships.map((rel) =>
    `| ${cell(rel.subjectA)} | ${cell(rel.subjectB)} | ${rel.sharedFiles.length} | ${rel.sharedEntities.length} | ${rel.sharedConfigKeys.length} |`
  );
  const details = data.relationships.map((rel) => `### ${cell(rel.subjectA)} ↔ ${cell(rel.subjectB)}

- Shared files: ${renderList(rel.sharedFiles.map((file) => codeCell(file)))}
- Shared entities: ${renderList(rel.sharedEntities.map((entity) => codeCell(entityLabel(entity))))}
- Shared config keys: ${renderList(rel.sharedConfigKeys.map((key) => codeCell(key)))}`);
  return `${intro}

| Feature A | Feature B | Shared files | Shared entities | Shared config keys |
|---|---|---:|---:|---:|
${rows.join("\n")}

${details.join("\n\n")}

${notes}`;
}

function intersectFiles(a: string[], b: string[]): string[] {
  const other = new Set(b.map(normalizePath));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of a.map(normalizePath)) {
    if (other.has(value) && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result.sort(compare);
}

function intersectEntities(a: FeatureFactPack, b: FeatureFactPack): SharedEntity[] {
  const other = new Set(entities(b).map(entityKey));
  const seen = new Set<string>();
  const result: SharedEntity[] = [];
  for (const item of entities(a)) {
    const key = entityKey(item);
    if (!other.has(key) || seen.has(key)) continue;
    seen.add(key);
    const filePath = normalizePath(item.filePath ?? "");
    result.push(filePath ? { name: item.name, filePath, line: item.line } : { name: item.name });
  }
  return result.sort(
    (x, y) => compare(x.name, y.name) || compare(x.filePath ?? "", y.filePath ?? "") || (x.line ?? 0) - (y.line ?? 0)
  );
}

function intersectConfigKeys(a: FeatureFactPack, b: FeatureFactPack): string[] {
  const other = new Set(configKeys(b));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of configKeys(a)) {
    if (!other.has(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result.sort(compare);
}

function entities(pack: FeatureFactPack): FactPackItem[] {
  return pack.items.filter((item) => item.category === "entities");
}

function configKeys(pack: FeatureFactPack): string[] {
  return pack.items.filter((item) => item.category === "config-keys").map((item) => item.name);
}

/** Entities collapse by name plus location; a fact without a file path falls back to the name alone. */
function entityKey(item: FactPackItem): string {
  const filePath = normalizePath(item.filePath ?? "");
  return filePath ? `${item.name}\u0000${filePath}\u0000${item.line}` : item.name;
}

function entityLabel(entity: SharedEntity): string {
  return entity.filePath ? `${entity.name} (${entity.filePath}:${entity.line})` : entity.name;
}

function renderList(values: string[]): string {
  if (!values.length) return "—";
  if (values.length <= MAX_LIST) return values.join(", ");
  return `${values.slice(0, MAX_LIST).join(", ")}, +${values.length - MAX_LIST} more (see context/cross-feature.json)`;
}

/** Code-unit ordering, not locale ordering: the same inputs must produce the same bytes anywhere. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function cell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
}

function codeCell(value: string): string {
  return `\`${cell(value)}\``;
}
