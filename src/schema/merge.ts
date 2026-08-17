/**
 * Merge per-source parser results into one framework-neutral SchemaExtraction.
 *
 * Each parser sees only its own source (SQL dump, migrations, models, gorm). This step canonicalizes
 * them into a single physical schema WITHOUT ever converting a type across vocabularies (see types.ts):
 *
 *   - Tables are grouped by physical name; columns are unioned by name. Two gorm structs that resolve to
 *     the same table, or a table described by both a migration and the SQL dump, collapse into one
 *     TableSchema whose provenance preserves every contributing declaration.
 *   - When the SAME column is described by several sources, the rendered type comes from the source
 *     closest to the physical DDL — authority order `sql-dump > sequelize-migration > sequelize-model >
 *     gorm`. Overridden facts are not lost: every source's declaration stays in the column's provenance.
 *   - Disagreements are surfaced, not hidden — a column present in one source but absent from another
 *     that also describes the table, and a same-vocabulary type-family mismatch, each become a warning.
 *     This is a defensibility feature: the report can show where the sources diverge.
 *   - Relationship targets carried as a Go type name or a model reference are resolved to physical table
 *     names using the tables' own declarations; an unresolvable target is kept verbatim with a warning.
 *
 * Deterministic: tables sorted by name, columns in authoritative-source order then appended, relationships
 * sorted and de-duplicated. Zero npm deps, zero model calls.
 */

import type {
  ColumnSchema,
  Declaration,
  ParserResult,
  RelationshipSchema,
  SchemaExtraction,
  SchemaSource,
  SchemaWarning,
  TableSchema,
  UniqueKey,
} from "./types.ts";

/** One source's parser output plus the SchemaSource that identifies it. */
export interface MergeInput {
  source: SchemaSource;
  result: ParserResult;
}

export interface MergeMeta {
  target: string;
  gitHead?: string;
}

/** Type-authority: lower rank = closer to physical DDL = wins the rendered type. Unknown formats rank last. */
const AUTHORITY: Record<string, number> = {
  "sql-dump": 0,
  "sequelize-migration": 1,
  "sequelize-model": 2,
  gorm: 3,
};

function rankOf(format: string): number {
  return AUTHORITY[format] ?? 99;
}

/** A table contributed by one source, tagged with its authority rank, stable sequence, and source id. */
interface TableEntry {
  table: TableSchema;
  rank: number;
  seq: number;
  sourceId: string;
}

export function mergeSchemas(inputs: MergeInput[], meta: MergeMeta): SchemaExtraction {
  const warnings: SchemaWarning[] = [];
  for (const input of inputs) warnings.push(...input.result.warnings);

  // Index every table by physical name, tagged with authority for later ordering.
  const byName = new Map<string, TableEntry[]>();
  let seq = 0;
  for (const input of inputs) {
    const rank = rankOf(input.source.format);
    for (const table of input.result.tables) {
      const entry: TableEntry = { table, rank, seq: seq++, sourceId: input.source.id };
      const list = byName.get(table.name);
      if (list) list.push(entry);
      else byName.set(table.name, [entry]);
    }
  }

  const tables: TableSchema[] = [];
  for (const name of [...byName.keys()].sort(cmp)) {
    tables.push(mergeTableGroup(name, byName.get(name)!.slice().sort(byAuthority), warnings));
  }

  const relationships = mergeRelationships(inputs, tables, warnings);

  return {
    target: meta.target,
    ...(meta.gitHead !== undefined ? { gitHead: meta.gitHead } : {}),
    sources: inputs.map((i) => i.source),
    tables,
    relationships,
    unsupported: [],
    warnings,
  };
}

function byAuthority(a: TableEntry, b: TableEntry): number {
  return a.rank - b.rank || a.seq - b.seq;
}

/** A single column occurrence across sources, carrying who declared it. */
interface ColOccurrence {
  col: ColumnSchema;
  sourceId: string;
}

function mergeTableGroup(name: string, entries: TableEntry[], warnings: SchemaWarning[]): TableSchema {
  const contributingSources = new Set(entries.map((e) => e.sourceId));

  // Column order: authoritative source's order first, then names newly seen in lower-authority sources.
  const order: string[] = [];
  const occurrences = new Map<string, ColOccurrence[]>();
  for (const entry of entries) {
    for (const col of entry.table.columns) {
      let list = occurrences.get(col.name);
      if (!list) {
        list = [];
        occurrences.set(col.name, list);
        order.push(col.name);
      }
      list.push({ col, sourceId: entry.sourceId });
    }
  }

  // Primary key: the authoritative source's non-empty PK wins.
  const primaryKey = entries.find((e) => e.table.primaryKey.length > 0)?.table.primaryKey ?? [];

  const columns: ColumnSchema[] = order.map((colName) => {
    const occ = occurrences.get(colName)!;
    const authoritative = occ[0].col; // occurrences pushed in authority order
    const merged: ColumnSchema = {
      name: colName,
      type: authoritative.type,
      typeVocabulary: authoritative.typeVocabulary,
      provenance: occ.flatMap((o) => o.col.provenance),
    };
    // Non-type facts: authoritative wins, but an undeclared fact is filled from the next source that states it.
    const nullable = firstDefined(occ, (c) => c.nullable);
    if (nullable !== undefined) merged.nullable = nullable;
    const def = firstDefined(occ, (c) => c.default);
    if (def !== undefined) merged.default = def;
    const auto = firstDefined(occ, (c) => c.autoIncrement);
    if (auto !== undefined) merged.autoIncrement = auto;
    if (authoritative.nameDerived) merged.nameDerived = true;
    if (primaryKey.includes(colName)) merged.inPrimaryKey = true;

    flagTypeConflict(name, colName, occ, warnings);
    flagPresenceMismatch(name, colName, occ, contributingSources, warnings);
    return merged;
  });

  return {
    name,
    columns,
    primaryKey,
    uniqueKeys: dedupeUniqueKeys(entries.flatMap((e) => e.table.uniqueKeys)),
    declarations: entries.flatMap((e) => e.table.declarations),
    ...(firstTableDescription(entries) !== undefined ? { description: firstTableDescription(entries) } : {}),
  };
}

function firstDefined<T>(occ: ColOccurrence[], pick: (c: ColumnSchema) => T | undefined): T | undefined {
  for (const o of occ) {
    const v = pick(o.col);
    if (v !== undefined) return v;
  }
  return undefined;
}

function firstTableDescription(entries: TableEntry[]): string | undefined {
  for (const e of entries) if (e.table.description !== undefined) return e.table.description;
  return undefined;
}

/** Within a single type vocabulary, more than one type family for the same column is a real conflict. */
function flagTypeConflict(table: string, column: string, occ: ColOccurrence[], warnings: SchemaWarning[]): void {
  const familiesByVocab = new Map<string, Set<string>>();
  for (const o of occ) {
    const set = familiesByVocab.get(o.col.typeVocabulary) ?? new Set<string>();
    set.add(typeFamily(o.col.type));
    familiesByVocab.set(o.col.typeVocabulary, set);
  }
  for (const [vocab, families] of familiesByVocab) {
    if (families.size > 1) {
      warnings.push({
        kind: "type-conflict",
        message: `column ${table}.${column} has conflicting ${vocab} types: ${[...families].sort().join(" vs ")}`,
        evidence: occ.flatMap((o) => o.col.provenance).map((p) => ({ file: p.file, line: p.line })),
      });
    }
  }
}

/** A column absent from a source that otherwise describes the table is worth surfacing (not fabricated). */
function flagPresenceMismatch(table: string, column: string, occ: ColOccurrence[], contributing: Set<string>, warnings: SchemaWarning[]): void {
  const declaring = new Set(occ.map((o) => o.sourceId));
  if (declaring.size >= contributing.size) return;
  const missing = [...contributing].filter((s) => !declaring.has(s)).sort();
  warnings.push({
    kind: "column-presence-mismatch",
    message: `column ${table}.${column} declared by [${[...declaring].sort().join(", ")}] but not [${missing.join(", ")}]`,
    evidence: occ.flatMap((o) => o.col.provenance).map((p) => ({ file: p.file, line: p.line })),
  });
}

/** Coarse type family for same-vocabulary comparison: drop pointer/slice markers, display width, and modifiers. */
function typeFamily(type: string): string {
  return type
    .replace(/^[[\]*\s]+/, "")
    .split("(")[0]
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
}

function dedupeUniqueKeys(keys: UniqueKey[]): UniqueKey[] {
  const seen = new Set<string>();
  const out: UniqueKey[] = [];
  for (const key of keys) {
    const id = `${key.name ?? ""}|${key.columns.join(",")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out;
}

function mergeRelationships(inputs: MergeInput[], tables: TableSchema[], warnings: SchemaWarning[]): RelationshipSchema[] {
  // Map a declaration symbol (Go struct name, model name) → physical table name; keep identity for real names.
  const symbolToPhysical = new Map<string, string>();
  const physicalNames = new Set(tables.map((t) => t.name));
  for (const table of tables) {
    for (const decl of table.declarations) {
      if (decl.symbol && !symbolToPhysical.has(decl.symbol)) symbolToPhysical.set(decl.symbol, table.name);
    }
  }

  const resolveTarget = (raw: string, provenance: Declaration[]): string => {
    if (physicalNames.has(raw)) return raw;
    const mapped = symbolToPhysical.get(raw);
    if (mapped !== undefined) return mapped;
    warnings.push({
      kind: "relationship-target-unresolved",
      message: `relationship target ${raw} did not resolve to a physical table; kept verbatim`,
      evidence: provenance.map((p) => ({ file: p.file, line: p.line })),
    });
    return raw;
  };

  const merged = new Map<string, RelationshipSchema>();
  for (const input of inputs) {
    for (const rel of input.result.relationships) {
      const resolved: RelationshipSchema = {
        ...rel,
        toTable: resolveTarget(rel.toTable, rel.provenance),
        provenance: [...rel.provenance],
      };
      if (resolved.joinTable !== undefined && symbolToPhysical.has(resolved.joinTable)) {
        resolved.joinTable = symbolToPhysical.get(resolved.joinTable)!;
      }
      const id = relationshipKey(resolved);
      const existing = merged.get(id);
      if (existing) existing.provenance.push(...resolved.provenance);
      else merged.set(id, resolved);
    }
  }

  return [...merged.values()].sort(
    (a, b) =>
      cmp(a.fromTable, b.fromTable) ||
      cmp(a.toTable, b.toTable) ||
      cmp(a.kind, b.kind) ||
      cmp(a.joinTable ?? "", b.joinTable ?? ""),
  );
}

function relationshipKey(r: RelationshipSchema): string {
  return [r.kind, r.fromTable, r.toTable, r.fromColumns.join(","), r.toColumns.join(","), r.joinTable ?? ""].join("|");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
