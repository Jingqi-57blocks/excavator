import {
  FACT_KIND_IDS, MEMBERSHIP_KINDS, evaluateSeat, factKindById,
  type FactKindId, type Membership
} from "../base/fact-kind-registry.ts";
import type { EvidenceItem, FactPackCategory, FactPackItem, FeatureFactPack } from "../base/types.ts";
import { sha256, stableJson } from "../base/util.ts";

const LOGIC_RENDER_ROWS = 120;
const FACT_PACK_CATEGORIES: readonly FactPackCategory[] = ["entrypoints", "entities", "states", "config-keys", "jobs", "external-calls", "logic"];
const FACT_PACK_METHODS = ["graph", "scan", "graph+scan", "none"] as const;
const UNJOINED_REASONS = ["kind-not-inventoried", "no-matching-fact", "envelope-unavailable", "scan-only"] as const;

/** The single consumption gate shared by model views, FACT evidence, obligations and work items. */
export function factPackItemIsConsumable(item: FactPackItem): boolean {
  return item.relation.kind === "seeded" || item.relation.kind === "retained";
}

export function consumableFactPackItems(pack: FeatureFactPack): FactPackItem[] {
  requireFactPackV2(pack, `fact pack ${JSON.stringify(pack.featureKey)}`);
  return pack.items.filter(factPackItemIsConsumable);
}

export function factPackEvidenceId(featureKey: string, category: FactPackCategory, snapshotId: string): string {
  return `FACT-${featureKey.slice(0, 10)}-${category}-${snapshotId.slice(0, 8)}`;
}

/** One evidence item per category, containing only rows the relation annotation authorizes for consumption. */
export function factPackEvidence(pack: FeatureFactPack): EvidenceItem[] {
  const consumable = consumableFactPackItems(pack);
  return pack.coverage.map((coverage) => {
    const items = consumable.filter((item) => item.category === coverage.category);
    const machineItems = pack.items.filter((item) => item.category === coverage.category);
    const data = {
      category: coverage.category,
      coverage,
      machineItemCount: machineItems.length,
      consumableItemCount: items.length,
      relationCounts: relationCounts(machineItems),
      items
    };
    return {
      id: factPackEvidenceId(pack.featureKey, coverage.category, pack.snapshotId),
      snapshotId: pack.snapshotId,
      kind: "fact" as const,
      title: `Fact pack: ${coverage.category}`,
      data,
      reason: `enumerate the seeded and retained ${coverage.category} facts authorized by the feature attribution, with the machine denominator and coverage limits kept visible`,
      digest: sha256(stableJson(data))
    };
  });
}

/** Deterministic model view. Co-located rows are represented only by counts and never by item content. */
export function renderFactPackSection(pack: FeatureFactPack, maxRowsPerCategory = 60): string {
  const consumable = consumableFactPackItems(pack);
  const rows = pack.coverage.map((coverage) => {
    const machine = pack.items.filter((item) => item.category === coverage.category);
    const visible = consumable.filter((item) => item.category === coverage.category);
    return [
      coverage.category,
      coverage.method,
      String(machine.length),
      String(visible.length),
      String(machine.filter((item) => item.relation.kind === "co-located").length),
      coverage.truncated ? "yes" : "no",
      factPackEvidenceId(pack.featureKey, coverage.category, pack.snapshotId),
      cell(coverage.note ?? "—")
    ].join(" | ");
  });
  const blocks = pack.coverage.map((coverage) => {
    const machine = pack.items.filter((item) => item.category === coverage.category);
    const categoryItems = consumable.filter((item) => item.category === coverage.category);
    const rowCap = coverage.category === "logic" ? LOGIC_RENDER_ROWS : maxRowsPerCategory;
    const shown = categoryItems.slice(0, rowCap);
    const header = `### ${coverage.category} — ${categoryItems.length} consumable of ${machine.length} machine item${machine.length === 1 ? "" : "s"}, method ${coverage.method}, evidence ${factPackEvidenceId(pack.featureKey, coverage.category, pack.snapshotId)}`;
    const empty = coverage.method === "none"
      ? "No method was available for this category in this run, so it was not enumerated; absence here is not evidence of absence in the code."
      : categoryItems.length === 0 && machine.length > 0
        ? `No item is authorized for consumption; ${machine.length} machine item${machine.length === 1 ? " is" : "s are"} retained only as co-location audit context.`
        : "No item of this category was found inside the feature boundary.";
    const body = shown.length
      ? [
        "| Name | Location | Source | Relation | Detail |",
        "|---|---|---|---|---|",
        ...shown.map((item) => `| ${cell(item.name)} | \`${cell(item.filePath)}:${item.line}${item.endLine && item.endLine !== item.line ? `-${item.endLine}` : ""}\` | ${item.source} | ${item.relation.kind} | ${cell(detailWithSignal(item))} |`)
      ].join("\n")
      : empty;
    const remainder = categoryItems.length > shown.length ? `\n\nView bound reached: ${categoryItems.length - shown.length} additional consumable row(s) are omitted from this model view and remain counted above.` : "";
    const note = coverage.truncated ? `\n\nTruncated: ${cell(coverage.note ?? "budget or cap reached")}` : "";
    return `${header}\n\n${body}${remainder}${note}`;
  });
  return `## Fact pack

Layer-5 relation view. Source digest: \`${sha256(stableJson(pack))}\`. Declared view bounds: ${maxRowsPerCategory} rows per category and ${LOGIC_RENDER_ROWS} logic rows. The authoritative machine pack is audit storage, not a model input; this view and its FACT evidence expose only seeded or retained rows. Co-located rows contribute counts only.

| Category | Method | Machine | Consumable | Co-located | Truncated | Evidence | Note |
|---|---|---:|---:|---:|---|---|---|
${rows.map((row) => `| ${row} |`).join("\n")}

Relation totals: seeded ${pack.relations.seeded}, retained ${pack.relations.retained}, co-located ${pack.relations.coLocated}, not-applicable ${pack.relations.notApplicable}.

Fact pack warnings: ${pack.warnings.length ? pack.warnings.map((warning) => cell(warning)).join(" | ") : "none"}

${blocks.join("\n\n")}`;
}

/** Production readers call this before using a persisted pack. v1 is deliberately invalid after this upgrade. */
export function requireFactPackV2(value: unknown, source = "fact pack"): asserts value is FeatureFactPack {
  if (!value || typeof value !== "object") throw new Error(`${source} is not an object`);
  const pack = value as Partial<FeatureFactPack> & { version?: unknown };
  if (pack.version !== "factpack-v2") {
    throw new Error(`${source} uses unsupported ${JSON.stringify(pack.version)}; this release invalidates legacy factpack-v1 runs, so run prepare again`);
  }
  if (typeof pack.snapshotId !== "string" || !pack.snapshotId.trim() || typeof pack.featureKey !== "string" || !pack.featureKey.trim()) {
    throw new Error(source + " has no snapshot or feature identity");
  }
  if (!Array.isArray(pack.warnings) || pack.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error(source + " warnings must be an array of strings");
  }
  if (!Array.isArray(pack.items) || !Array.isArray(pack.coverage) || !pack.relations || typeof pack.relations !== "object") {
    throw new Error(`${source} is missing the factpack-v2 items, coverage or relation summary`);
  }
  for (const [index, item] of pack.items.entries()) validateItem(item, `${source} item ${index}`);
  const counts = relationCounts(pack.items);
  const summary = pack.relations;
  if (summary.total !== pack.items.length
    || summary.seeded !== counts.seeded
    || summary.retained !== counts.retained
    || summary.coLocated !== counts.coLocated
    || summary.notApplicable !== counts.notApplicable) {
    throw new Error(`${source} relation summary does not reconcile with its ${pack.items.length} items`);
  }
  const expectedByBasis = relationBasisCounts(pack.items);
  if (!summary.byBasis || typeof summary.byBasis !== "object" || stableJson(summary.byBasis) !== stableJson(expectedByBasis)) {
    throw new Error(source + " relation basis summary does not reconcile with its items");
  }
  const covered = new Set<FactPackCategory>();
  for (const [index, coverage] of pack.coverage.entries()) {
    if (!coverage || typeof coverage !== "object") throw new Error(source + " coverage row " + index + " is not an object");
    if (!(FACT_PACK_CATEGORIES as readonly unknown[]).includes(coverage.category)) throw new Error(source + " coverage row " + index + " has unknown category " + JSON.stringify(coverage.category));
    if (covered.has(coverage.category)) throw new Error(source + " repeats coverage category " + JSON.stringify(coverage.category));
    covered.add(coverage.category);
    if (!(FACT_PACK_METHODS as readonly unknown[]).includes(coverage.method)) throw new Error(source + " coverage row " + index + " has unknown method " + JSON.stringify(coverage.method));
    if (!Number.isInteger(coverage.itemCount) || coverage.itemCount < 0) throw new Error(source + " coverage row " + index + " has invalid itemCount " + JSON.stringify(coverage.itemCount));
    if (typeof coverage.truncated !== "boolean") throw new Error(source + " coverage row " + index + " has no truncation verdict");
    const actual = pack.items.filter((item) => item.category === coverage.category).length;
    if (coverage.itemCount !== actual) throw new Error(source + " coverage category " + JSON.stringify(coverage.category) + " counts " + coverage.itemCount + " items but contains " + actual);
  }
  const coverageTotal = pack.coverage.reduce((sum, row) => sum + Number(row.itemCount), 0);
  if (coverageTotal !== pack.items.length) throw new Error(`${source} coverage counts ${coverageTotal} items but the machine pack contains ${pack.items.length}`);
}

function validateItem(item: unknown, source: string): asserts item is FactPackItem {
  if (!item || typeof item !== "object") throw new Error(`${source} is not an object`);
  const row = item as Partial<FactPackItem>;
  if (!(FACT_PACK_CATEGORIES as readonly unknown[]).includes(row.category)) throw new Error(source + " has unknown category " + JSON.stringify(row.category));
  if (typeof row.name !== "string" || !row.name.trim() || typeof row.filePath !== "string") throw new Error(source + " has no name or has an invalid file path");
  if (!Number.isInteger(row.line) || Number(row.line) < 0) throw new Error(source + " has invalid line " + JSON.stringify(row.line));
  if (row.endLine !== undefined && (!Number.isInteger(row.endLine) || row.endLine < row.line!)) throw new Error(source + " has invalid end line " + JSON.stringify(row.endLine));
  if (row.source !== "graph" && row.source !== "scan") throw new Error(source + " has unknown source " + JSON.stringify(row.source));
  if (row.granularity !== "graph-node" && row.granularity !== "source-line") throw new Error(`${source} has no declared granularity`);
  if (!row.membership || typeof row.membership !== "object" || !row.relation || typeof row.relation !== "object") {
    throw new Error(`${source} has no membership or relation annotation`);
  }
  validateMembershipAnnotation(row as FactPackItem, source);
  const membership = row.membership as { joined?: unknown; unjoined?: unknown };
  if ((membership.joined === undefined) === (membership.unjoined === undefined)) {
    throw new Error(`${source} must carry exactly one of joined or unjoined membership`);
  }
  if (!(["seeded", "retained", "co-located", "not-applicable"] as unknown[]).includes(row.relation.kind)) {
    throw new Error(`${source} has unknown relation ${JSON.stringify(row.relation.kind)}`);
  }
  if (membership.unjoined !== undefined && row.relation.kind !== "co-located") throw new Error(`${source} has no membership but claims relation ${row.relation.kind}`);
  if (membership.joined === undefined && row.relation.kind === "not-applicable") throw new Error(`${source} claims not-applicable without a registry membership`);
  if ((row.relation.kind === "seeded" || row.relation.kind === "retained") && membership.joined === undefined) {
    throw new Error(`${source} is consumable without a joined membership`);
  }
}

function validateMembershipAnnotation(row: FactPackItem, source: string): void {
  const annotation = row.membership as unknown as { joined?: unknown; unjoined?: unknown };
  const relation = row.relation as unknown as { kind?: unknown; basis?: unknown };
  if ((annotation.joined === undefined) === (annotation.unjoined === undefined)) {
    throw new Error(source + " must carry exactly one of joined or unjoined membership");
  }
  if (!(["seeded", "retained", "co-located", "not-applicable"] as unknown[]).includes(relation.kind)) {
    throw new Error(source + " has unknown relation " + JSON.stringify(relation.kind));
  }
  const expectedBasis = relation.kind === "seeded" ? "explicit-seed"
    : relation.kind === "retained" ? "membership-seated"
      : relation.kind === "not-applicable" ? "registry-not-applicable"
        : null;
  if (expectedBasis !== null && relation.basis !== expectedBasis) {
    throw new Error(source + " relation " + relation.kind + " has invalid basis " + JSON.stringify(relation.basis));
  }

  if (annotation.unjoined !== undefined) {
    const unjoined = annotation.unjoined as { reason?: unknown };
    if (!unjoined || typeof unjoined !== "object" || !(UNJOINED_REASONS as readonly unknown[]).includes(unjoined.reason)) {
      throw new Error(source + " has an invalid unjoined reason " + JSON.stringify(unjoined?.reason));
    }
    if (relation.kind !== "co-located") throw new Error(source + " has no membership but claims relation " + relation.kind);
    if (relation.basis !== unjoined.reason) throw new Error(source + " unjoined reason and co-located basis disagree");
    return;
  }

  const joined = annotation.joined as { factId?: unknown; kind?: unknown; membership?: unknown };
  if (!joined || typeof joined !== "object" || typeof joined.factId !== "string" || !joined.factId.trim()) {
    throw new Error(source + " has an invalid joined fact id");
  }
  if (!isFactKindId(joined.kind)) throw new Error(source + " has unknown joined fact kind " + JSON.stringify(joined.kind));
  validateMembership(joined.membership, source + " joined membership");
  const verdict = evaluateSeat(factKindById(joined.kind), joined.membership, new Set(), () => null);
  if (relation.kind === "co-located" && relation.basis !== "membership-not-seated") {
    throw new Error(source + " joined co-located relation has invalid basis " + JSON.stringify(relation.basis));
  }
  if (relation.kind === "co-located" && verdict === "not-applicable") {
    throw new Error(source + " hides a registry-not-applicable membership in the co-located bucket");
  }
  if (relation.kind === "not-applicable" && verdict !== "not-applicable") {
    throw new Error(source + " claims not-applicable for a seat-applicable membership");
  }
  if ((relation.kind === "seeded" || relation.kind === "retained") && verdict === "not-applicable") {
    throw new Error(source + " makes a registry-not-applicable membership consumable");
  }
}

function validateMembership(value: unknown, source: string): asserts value is Membership {
  if (!value || typeof value !== "object") throw new Error(source + " is not an object");
  const membership = value as { kind?: unknown; unitId?: unknown; unitIds?: unknown; endpoints?: unknown; moduleId?: unknown };
  if (!(MEMBERSHIP_KINDS as readonly unknown[]).includes(membership.kind)) throw new Error(source + " has unknown kind " + JSON.stringify(membership.kind));
  const id = (candidate: unknown): boolean => typeof candidate === "string" && Boolean(candidate.trim());
  const ids = (candidate: unknown): boolean => Array.isArray(candidate) && candidate.length > 0 && candidate.every(id);
  if (membership.kind === "unit" && !id(membership.unitId)) throw new Error(source + " unit arm requires a non-empty unitId");
  if (membership.kind === "span-set" && !ids(membership.unitIds)) throw new Error(source + " span-set arm requires non-empty unitIds");
  if (membership.kind === "relation" && !ids(membership.endpoints)) throw new Error(source + " relation arm requires non-empty endpoints");
  if (membership.kind === "module" && !id(membership.moduleId)) throw new Error(source + " module arm requires a non-empty moduleId");
}

function isFactKindId(value: unknown): value is FactKindId {
  return typeof value === "string" && (FACT_KIND_IDS as readonly string[]).includes(value);
}

function relationCounts(items: readonly FactPackItem[]): { seeded: number; retained: number; coLocated: number; notApplicable: number } {
  return {
    seeded: items.filter((item) => item.relation.kind === "seeded").length,
    retained: items.filter((item) => item.relation.kind === "retained").length,
    coLocated: items.filter((item) => item.relation.kind === "co-located").length,
    notApplicable: items.filter((item) => item.relation.kind === "not-applicable").length
  };
}

function relationBasisCounts(items: readonly FactPackItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.relation.basis] = (counts[item.relation.basis] ?? 0) + 1;
  return counts;
}

function detailWithSignal(item: FactPackItem): string {
  if (item.signal) return item.detail ? `${item.detail} · rescued: ${item.signal}` : `rescued: ${item.signal}`;
  return item.detail ?? "—";
}

function cell(value: string): string { return value.replace(/\s+/g, " ").trim().replaceAll("|", "\\|"); }
