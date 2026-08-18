import type {
  FactPackCategory, FactPackCoverage, FactPackItem, FactPackRelation, FeatureFactPack
} from "../src/base/types.ts";

export type FactPackItemSeed = Partial<FactPackItem> & Pick<FactPackItem, "category" | "name">;

/** A compact, valid v2 row for consumer tests that are not themselves testing layer-5 attribution. */
export function v2Item(seed: FactPackItemSeed): FactPackItem {
  const filePath = seed.filePath ?? "fixture.ts";
  const line = seed.line ?? 1;
  const item: FactPackItem = {
    category: seed.category,
    name: seed.name,
    filePath,
    line,
    source: seed.source ?? "graph",
    granularity: seed.granularity ?? "graph-node",
    membership: seed.membership ?? {
      joined: {
        factId: `function:${filePath}:${line}-${seed.endLine ?? line}:${seed.name}`,
        kind: "indexed-function",
        membership: { kind: "unit", unitId: "fixture-cell" }
      }
    },
    relation: seed.relation ?? { kind: "retained", basis: "membership-seated" }
  };
  if (seed.endLine !== undefined) item.endLine = seed.endLine;
  if (seed.detail !== undefined) item.detail = seed.detail;
  if (seed.rank !== undefined) item.rank = seed.rank;
  if (seed.signal !== undefined) item.signal = seed.signal;
  return item;
}

export function v2Pack(
  seeds: readonly FactPackItemSeed[],
  options: {
    featureKey?: string;
    snapshotId?: string;
    coverage?: readonly FactPackCoverage[];
    warnings?: readonly string[];
  } = {}
): FeatureFactPack {
  const items = seeds.map(v2Item);
  const coverage = options.coverage
    ? options.coverage.map((row) => ({ ...row }))
    : coverageFor(items);
  const byBasis: Record<string, number> = {};
  for (const item of items) byBasis[item.relation.basis] = (byBasis[item.relation.basis] ?? 0) + 1;
  const count = (kind: FactPackRelation["kind"]): number => items.filter((item) => item.relation.kind === kind).length;
  return {
    version: "factpack-v2",
    snapshotId: options.snapshotId ?? "snap",
    featureKey: options.featureKey ?? "fixture",
    items,
    coverage,
    warnings: [...(options.warnings ?? [])],
    relations: {
      total: items.length,
      seeded: count("seeded"),
      retained: count("retained"),
      coLocated: count("co-located"),
      notApplicable: count("not-applicable"),
      byBasis: Object.fromEntries(Object.entries(byBasis).sort(([a], [b]) => a.localeCompare(b)))
    }
  };
}

function coverageFor(items: readonly FactPackItem[]): FactPackCoverage[] {
  const categories = [...new Set(items.map((item) => item.category))].sort() as FactPackCategory[];
  return categories.map((category) => {
    const rows = items.filter((item) => item.category === category);
    const sources = new Set(rows.map((item) => item.source));
    return {
      category,
      method: sources.size > 1 ? "graph+scan" : sources.has("graph") ? "graph" : "scan",
      itemCount: rows.length,
      truncated: false
    };
  });
}
