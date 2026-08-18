import type { ArtifactResult } from "../base/artifact-result.ts";
import {
  evaluateSeat, factKindById, membershipCells, membershipViolations,
  type Membership
} from "../base/fact-kind-registry.ts";
import type {
  CollectedFactPackItem, CollectedFeatureFactPack, FactPackItem, FactPackMembership,
  FactPackRelation, FeatureFactPack
} from "../base/types.ts";
import { stableJson } from "../base/util.ts";
import type { AttributionArtifact } from "../attribution/attribution-artifact.ts";
import { inventoryFactIdBaseOf } from "../codegraph/function-inventory.ts";
import type { ProducerFactRow, ProducerFactSet } from "../facts/envelope.ts";
import type { UnitsArtifact } from "../facts/units/units-artifact.ts";
import { unitsContentDigest } from "../facts/units/units-artifact.ts";

/** Layer 5's only inputs: collected rows, layer-3 memberships and layer-4 seats. No reader or graph is accepted. */
export interface FactPackAnnotationInput {
  readonly pack: CollectedFeatureFactPack;
  readonly attribution: ArtifactResult<AttributionArtifact>;
  readonly units: ArtifactResult<UnitsArtifact>;
  readonly producers: Readonly<Record<string, ArtifactResult<ProducerFactSet>>>;
  /** Required even though attribution-v2 cannot provide production seed identity and production passes empty. */
  readonly seedCells: ReadonlySet<string>;
}

interface KnownUnits {
  readonly cells: ReadonlySet<string>;
  readonly modules: ReadonlySet<string>;
  readonly moduleByCell: ReadonlyMap<string, string>;
}

/**
 * Annotate without changing the machine denominator. Every collected row is copied once, in the same order, and
 * receives exactly one membership outcome plus one relation outcome. Selection is read only from attribution;
 * membership is copied only from the producer envelope that minted it.
 */
export function annotateFactPack(input: FactPackAnnotationInput): FeatureFactPack {
  if (input.pack.version !== "factpack-collected-v1") {
    throw new Error(`Layer 5 expected factpack-collected-v1, got ${JSON.stringify((input.pack as { version?: unknown }).version)}`);
  }
  const known = knownUnits(input.units);
  for (const unitId of input.seedCells) {
    if (!known.cells.has(unitId)) throw new Error(`Fact-pack seed names ${JSON.stringify(unitId)}, which is not a partition cell of this run`);
  }
  const attribution = attributionContext(input.attribution, input.pack.featureKey, input.units);
  const indexes = producerIndexes(input.producers, input.units);
  const items = input.pack.items.map((item) => annotateItem(item, indexes, known, attribution.seated, input.seedCells));
  if (items.length !== input.pack.items.length) throw new Error("Fact-pack annotation changed the machine denominator");
  return {
    version: "factpack-v2",
    snapshotId: input.pack.snapshotId,
    featureKey: input.pack.featureKey,
    items,
    coverage: input.pack.coverage.map((row) => ({ ...row })),
    warnings: [...input.pack.warnings, ...attribution.warnings],
    relations: relationSummary(items)
  };
}

function annotateItem(
  item: CollectedFactPackItem,
  indexes: ReadonlyMap<string, ReadonlyMap<string, ProducerFactRow>>,
  known: KnownUnits,
  seated: ReadonlySet<string>,
  seeds: ReadonlySet<string>
): FactPackItem {
  const { join, ...core } = item;
  if (join.kind === "unjoined") {
    return {
      ...core,
      membership: { unjoined: { reason: join.reason } },
      relation: { kind: "co-located", basis: join.reason }
    };
  }

  const index = indexes.get(join.producer);
  if (index === undefined) {
    return {
      ...core,
      membership: { unjoined: { reason: "envelope-unavailable" } },
      relation: { kind: "co-located", basis: "envelope-unavailable" }
    };
  }
  const fact = index.get(join.factId);
  if (fact === undefined) {
    return {
      ...core,
      membership: { unjoined: { reason: "no-matching-fact" } },
      relation: { kind: "co-located", basis: "no-matching-fact" }
    };
  }
  validateMembership(fact, known);
  const membership: FactPackMembership = {
    joined: { factId: fact.factId, kind: fact.kind, membership: copyMembership(fact.membership) }
  };
  if (membershipCells(fact.membership).some((unitId) => seeds.has(unitId))) {
    return { ...core, membership, relation: { kind: "seeded", basis: "explicit-seed" } };
  }
  const entry = factKindById(fact.kind);
  const verdict = evaluateSeat(entry, fact.membership, seated, (cellId) => known.moduleByCell.get(cellId) ?? null);
  const relation: FactPackRelation = verdict === "member"
    ? { kind: "retained", basis: "membership-seated" }
    : verdict === "not-applicable"
      ? { kind: "not-applicable", basis: "registry-not-applicable" }
      : { kind: "co-located", basis: "membership-not-seated" };
  return { ...core, membership, relation };
}

function attributionContext(
  attribution: ArtifactResult<AttributionArtifact>,
  featureKey: string,
  units: ArtifactResult<UnitsArtifact>
): { readonly seated: ReadonlySet<string>; readonly warnings: readonly string[] } {
  if (attribution.status === "unavailable") {
    return {
      seated: new Set(),
      warnings: [`Attribution unavailable for ${featureKey}: ${attribution.cause}; no fact-pack item can be retained by a seat.`]
    };
  }
  if (attribution.status === "not-applicable") {
    return {
      seated: new Set(),
      warnings: [`Attribution not applicable for ${featureKey}: ${attribution.determination}; no fact-pack item can be retained by a seat.`]
    };
  }
  if (units.status !== "built") throw new Error("Attribution is Built while its units denominator is not Built");
  const expected = unitsContentDigest(units.value);
  if (attribution.value.identity.unitsContentDigest !== expected) {
    throw new Error(`Attribution names units generation ${JSON.stringify(attribution.value.identity.unitsContentDigest)}, but layer 5 received ${JSON.stringify(expected)}`);
  }
  const selections = attribution.value.selections.filter((selection) => selection.featureKey === featureKey);
  if (selections.length !== 1) {
    throw new Error(`Fact pack ${JSON.stringify(featureKey)} requires exactly one attribution selection, found ${selections.length}`);
  }
  const selection = selections[0]!;
  return {
    seated: new Set(selection.seats.map((seat) => seat.unitId)),
    warnings: selection.channels.status === "channel-unavailable"
      ? [`Attribution channels unavailable for ${featureKey}: ${selection.channels.cause}; no fact-pack item can be retained by a seat.`]
      : []
  };
}

function knownUnits(units: ArtifactResult<UnitsArtifact>): KnownUnits {
  if (units.status !== "built") return { cells: new Set(), modules: new Set(), moduleByCell: new Map() };
  const cells = new Set<string>();
  const modules = new Set<string>();
  const moduleByCell = new Map<string, string>();
  for (const cell of units.value.partition) {
    if (cells.has(cell.unitId)) throw new Error(`Units partition repeats ${JSON.stringify(cell.unitId)}`);
    cells.add(cell.unitId);
    modules.add(cell.rootName);
    moduleByCell.set(cell.unitId, cell.rootName);
  }
  return { cells, modules, moduleByCell };
}

function producerIndexes(
  producers: Readonly<Record<string, ArtifactResult<ProducerFactSet>>>,
  units: ArtifactResult<UnitsArtifact>
): ReadonlyMap<string, ReadonlyMap<string, ProducerFactRow>> {
  const indexes = new Map<string, ReadonlyMap<string, ProducerFactRow>>();
  const unitsDigest = units.status === "built" ? unitsContentDigest(units.value) : null;
  for (const producer of Object.keys(producers).sort()) {
    const result = producers[producer]!;
    if (result.status !== "built") continue;
    if (unitsDigest === null || result.value.identity.unitsContentDigest !== unitsDigest) {
      throw new Error(`Producer ${JSON.stringify(producer)} and layer 5 do not name the same units generation`);
    }
    const rows = new Map<string, ProducerFactRow>();
    for (const fact of result.value.facts) {
      const base = producer === "codegraph" ? inventoryFactIdBaseOf(fact.factId) : fact.factId;
      const prior = rows.get(base);
      if (prior && stableJson({ kind: prior.kind, membership: prior.membership }) !== stableJson({ kind: fact.kind, membership: fact.membership })) {
        throw new Error(`Producer ${JSON.stringify(producer)} publishes two incompatible membership rows for base fact ${JSON.stringify(base)}`);
      }
      if (!prior) rows.set(base, fact);
    }
    indexes.set(producer, rows);
  }
  return indexes;
}

function validateMembership(fact: ProducerFactRow, known: KnownUnits): void {
  if (fact.membership === undefined || typeof fact.membership !== "object") {
    throw new Error(`Fact ${JSON.stringify(fact.factId)} has no membership to transcribe`);
  }
  const violations = membershipViolations(fact.membership, { cells: known.cells, modules: known.modules });
  if (violations.length) throw new Error(`Fact ${JSON.stringify(fact.factId)} has invalid membership: ${violations.join("; ")}`);
  // Also checks that the membership shape is the one the kind registry declares. The seated set is irrelevant
  // here; this call is the single registry-owned shape check and its verdict is intentionally ignored.
  evaluateSeat(factKindById(fact.kind), fact.membership, new Set(), (cellId) => known.moduleByCell.get(cellId) ?? null);
}

function copyMembership(membership: Membership): Membership {
  switch (membership.kind) {
    case "unit": return { kind: "unit", unitId: membership.unitId };
    case "span-set": return { kind: "span-set", unitIds: [...membership.unitIds] };
    case "relation": return { kind: "relation", endpoints: [...membership.endpoints] };
    case "module": return { kind: "module", moduleId: membership.moduleId };
    case "corpus": return { kind: "corpus" };
  }
}

function relationSummary(items: readonly FactPackItem[]): FeatureFactPack["relations"] {
  const byBasis: Record<string, number> = {};
  const count = (kind: FactPackRelation["kind"]): number => items.filter((item) => item.relation.kind === kind).length;
  for (const item of items) byBasis[item.relation.basis] = (byBasis[item.relation.basis] ?? 0) + 1;
  return {
    total: items.length,
    seeded: count("seeded"),
    retained: count("retained"),
    coLocated: count("co-located"),
    notApplicable: count("not-applicable"),
    byBasis: Object.fromEntries(Object.entries(byBasis).sort(([a], [b]) => a.localeCompare(b)))
  };
}
