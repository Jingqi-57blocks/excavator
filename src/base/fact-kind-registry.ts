import { ARTIFACT_REGISTRY } from "./artifact-registry.ts";
import { assertNever } from "./artifact-result.ts";
import { sha256, stableJson } from "./util.ts";

/**
 * What a fact BELONGS to, and the one place that decides whether that belonging is a seat.
 *
 * `docs/layering.md` §一 ("事实的成员资格是一个闭合联合") settles two things this file makes structural. First,
 * membership is not a cell id: `MatchedLink` (`src/crossrepo/link-match.ts:41`) really has two ends in two
 * modules, a class spans several method cells plus residual, and a corpus-domain term frequency has no cell to
 * pick at all. Picking one end contaminates seeded / retained / co-located — a backend route seated while its
 * frontend caller is not would read as co-located and be dropped, which is P17 replayed at another granularity.
 * Second, the SEAT RULE travels with the kind, declared here in the base, because a rule chosen by the consumer
 * is a second semantic table in the consumer — exactly what "downstream may not own a second mapping algorithm"
 * forbids. `evaluateSeat` is the only judge; there is no second one to disagree with it.
 *
 * Why this is NOT part of `mechanism-registry.ts`: that registry's digest is layer 2's ledger identity. A purely
 * layer-3 semantic change (a new fact kind, a corrected seat rule) would move the layer-2 ledger's bytes for no
 * layer-2 reason, and the two tables change on different clocks. They stay separate registries.
 *
 * The empty-set ban is a CONSTRUCTOR property, not a comment: `{span-set, []}` and `{relation, []}` would both
 * evaluate to `not-member` under a vacuous quantifier and to `member` under the other, so a producer that had
 * nothing to say could publish either answer by accident. The constructors refuse them.
 */

export const FACT_KIND_REGISTRY_VERSION = "fact-kind-registry-v1";

/**
 * What a fact or a reference unit belongs to. Closed, no optional fields, no legal empty set.
 *
 * Every id in every arm except `module` is a partition `UnitId` — a cell of `units.json.partition`, which is
 * what a seat is awarded to. A reference unit is never an endpoint: `refUnits[]` may nest, so it is not a
 * denominator and cannot hold a seat (§四 分母法则).
 */
export type Membership =
  | { readonly kind: "unit"; readonly unitId: string }
  | { readonly kind: "span-set"; readonly unitIds: readonly string[] }
  | { readonly kind: "relation"; readonly endpoints: readonly string[] }
  | { readonly kind: "module"; readonly moduleId: string }
  | { readonly kind: "corpus" };

export type MembershipKind = Membership["kind"];

export const MEMBERSHIP_KINDS = ["unit", "span-set", "relation", "module", "corpus"] as const;

/**
 * How a membership becomes a seat. Closed, and paired with a membership kind by `LEGAL_PAIRINGS` below.
 *
 * `all-covered` has no production kind in v1. It is in the union because it is contract vocabulary (§一 names
 * all four), and a rule that only appears once a kind needs it is a rule invented under deadline.
 */
export type SeatRule = "any-endpoint" | "all-covered" | "anchor-cell" | "not-applicable";

/** The three-state answer. `not-applicable` is a WRITTEN state — never a null threaded through a fact pack. */
export type SeatVerdict = "member" | "not-member" | "not-applicable";

/**
 * Which seat rule each membership kind may be paired with, checked at load.
 *
 * The table exists because `evaluateSeat`'s inputs decide what is COMPUTABLE, not taste: `all-covered` over a
 * `module` membership would need every cell of that module, and the judge is handed only the seated set plus a
 * cell → module resolver. A pairing the judge cannot honestly answer must be unrepresentable in the registry
 * rather than answered with a guess.
 */
const LEGAL_PAIRINGS: Record<MembershipKind, readonly SeatRule[]> = {
  "unit": ["anchor-cell"],
  "span-set": ["all-covered"],
  "relation": ["any-endpoint"],
  "module": ["any-endpoint"],
  "corpus": ["not-applicable"]
};

export const FACT_KIND_IDS = [
  "db-table",
  "frontend-call",
  "http-link",
  "indexed-function",
  "indexed-route",
  "recovered-route",
  "term-df"
] as const;

export type FactKindId = typeof FACT_KIND_IDS[number];

export interface FactKindEntry {
  readonly id: FactKindId;
  /** Says what the kind is; read by whoever reads a fact envelope. */
  readonly title: string;
  /** The layer-3 producer that may emit it. Cross-checked against the artifact registry's producer set. */
  readonly producer: string;
  /** The only membership shape this kind may carry. A producer handing another shape is refused by the judge. */
  readonly membershipKind: MembershipKind;
  readonly seatRule: SeatRule;
  /**
   * Whether the fact is an observation OF A DECLARATION (a class / function / method the producer saw declared),
   * which is what makes it eligible to normalise onto a partition builder's skeleton node instead of minting a
   * reference unit of its own. Required, never optional: a flag that may be omitted is a flag the next kind
   * forgets, and the normalisation rule then silently splits into two behaviours.
   */
  readonly structuralDeclaration: boolean;
}

export interface FactKindRegistry {
  readonly version: string;
  readonly kinds: readonly FactKindEntry[];
}

const KINDS: readonly FactKindEntry[] = [
  {
    id: "indexed-function",
    title: "A function or method the CodeGraph index has a node for",
    producer: "codegraph",
    membershipKind: "unit",
    seatRule: "anchor-cell",
    structuralDeclaration: true
  },
  {
    id: "indexed-route",
    title: "An indexed route, filed at its source-verified handler or visibly at the registration line",
    producer: "codegraph",
    membershipKind: "unit",
    seatRule: "anchor-cell",
    structuralDeclaration: false
  },
  {
    id: "recovered-route",
    title: "A route recovered from framework convention or a route table",
    producer: "crossrepo",
    membershipKind: "unit",
    seatRule: "anchor-cell",
    structuralDeclaration: true
  },
  {
    id: "frontend-call",
    title: "An outbound HTTP call site found in frontend code",
    producer: "crossrepo",
    membershipKind: "unit",
    seatRule: "anchor-cell",
    structuralDeclaration: false
  },
  {
    // The two-ended one, and the reason the union exists: the call sits in one module and the route in another.
    // `any-endpoint` is what keeps the edge visible when only the backend half was seated.
    id: "http-link",
    title: "A resolved HTTP link between a caller and a route in another module",
    producer: "crossrepo",
    membershipKind: "relation",
    seatRule: "any-endpoint",
    structuralDeclaration: false
  },
  {
    // The entity/table kind. A physical table is not a code unit, so `structuralDeclaration` is FALSE: normalising
    // it would either attach a table to whatever class or function happens to sit on the declaring line, or mint a
    // reference unit for a `createTable(` call. It is filed at its declaration the way `indexed-route` is filed at
    // its registration line — the anchor says WHERE the table is declared, not that the anchor IS the table.
    //
    // One anchor, and the anchor is the declaration closest to physical DDL (`mergeSchemas` orders a table's
    // declarations by that authority). A table declared in several places — a migration and a gorm model, often in
    // two repositories — therefore seats on one of them; the others are counted in the producer's own completeness
    // as `tableDeclarationsBeyondAnchor` rather than left to be inferred from a silence.
    id: "db-table",
    title: "A physical database table recovered from a migration, ORM model or SQL dump",
    producer: "db-schema",
    membershipKind: "unit",
    seatRule: "anchor-cell",
    structuralDeclaration: false
  },
  {
    // Corpus domain: there is no cell to pick, so the seat question does not apply. It is answered, not skipped.
    id: "term-df",
    title: "In-repository document frequency of one term over the whole corpus",
    producer: "vocabulary",
    membershipKind: "corpus",
    seatRule: "not-applicable",
    structuralDeclaration: false
  }
];

export const FACT_KIND_REGISTRY: FactKindRegistry = { version: FACT_KIND_REGISTRY_VERSION, kinds: KINDS };

// --- membership constructors: the only doors, and each one refuses an empty set ------------------------------

export function unitMembership(unitId: string): Membership {
  return { kind: "unit", unitId: requireId("unit", unitId) };
}

export function spanSetMembership(unitIds: readonly string[]): Membership {
  return { kind: "span-set", unitIds: canonicalIds("span-set", unitIds) };
}

/**
 * A relation's endpoints, canonically sorted and deduplicated.
 *
 * Sorting is safe precisely because the membership carries no direction: which end is the caller and which the
 * route is a property of the FACT, recorded in the producer's own payload. Putting direction in the membership
 * would hand the consumer a second semantic table to read the endpoints with.
 */
export function relationMembership(endpoints: readonly string[]): Membership {
  return { kind: "relation", endpoints: canonicalIds("relation", endpoints) };
}

export function moduleMembership(moduleId: string): Membership {
  return { kind: "module", moduleId: requireId("module", moduleId) };
}

/** The corpus membership. A frozen value, because it has no fields to get wrong. */
export const CORPUS_MEMBERSHIP: Membership = Object.freeze({ kind: "corpus" as const });

function requireId(kind: string, id: string): string {
  if (!id.trim()) throw new Error(`A ${kind} membership requires a non-empty id`);
  return id;
}

function canonicalIds(kind: string, ids: readonly string[]): readonly string[] {
  for (const id of ids) requireId(kind, id);
  const unique = [...new Set(ids)].sort();
  if (!unique.length) {
    throw new Error(`A ${kind} membership may not be empty: an empty set answers the seat question both ways depending on the quantifier, so a producer with nothing to say would publish an accident`);
  }
  return unique;
}

// --- the one judge ------------------------------------------------------------------------------------------

/**
 * The ONLY seat judgement in the engine.
 *
 * Layer 5 calls this and nothing else, so a second semantics of "is this fact in the working set" is not
 * expressible: there is no rule argument to pass and no fact-kind switch to write. A membership whose shape
 * disagrees with its kind's declaration throws rather than being judged under a rule that was written for a
 * different shape — that mismatch is a producer bug, and answering it would hide the bug behind a verdict.
 *
 * `moduleOfCell` answers "which module is this SEATED cell in"; layer 3 puts `CountedRow.rootName` on every
 * partition row precisely so this resolver exists without anyone re-deriving a module from a path.
 */
export function evaluateSeat(
  entry: FactKindEntry,
  membership: Membership,
  seatedCellIds: ReadonlySet<string>,
  moduleOfCell: (cellId: string) => string | null
): SeatVerdict {
  if (membership.kind !== entry.membershipKind) {
    throw new Error(`Fact kind ${JSON.stringify(entry.id)} declares ${JSON.stringify(entry.membershipKind)} membership but was handed ${JSON.stringify(membership.kind)}`);
  }
  switch (entry.seatRule) {
    case "not-applicable":
      return "not-applicable";
    case "anchor-cell": {
      if (membership.kind !== "unit") throw pairingBug(entry, membership);
      return seatedCellIds.has(membership.unitId) ? "member" : "not-member";
    }
    case "all-covered": {
      if (membership.kind !== "span-set") throw pairingBug(entry, membership);
      return membership.unitIds.every((id) => seatedCellIds.has(id)) ? "member" : "not-member";
    }
    case "any-endpoint": {
      if (membership.kind === "relation") {
        return membership.endpoints.some((id) => seatedCellIds.has(id)) ? "member" : "not-member";
      }
      if (membership.kind !== "module") throw pairingBug(entry, membership);
      for (const cellId of seatedCellIds) {
        if (moduleOfCell(cellId) === membership.moduleId) return "member";
      }
      return "not-member";
    }
    default:
      return assertNever(entry.seatRule, "fact kind seat rule");
  }
}

/** Unreachable while `validateFactKindRegistry` runs at load; it names the pairing so the cause is findable. */
function pairingBug(entry: FactKindEntry, membership: Membership): Error {
  return new Error(`Fact kind ${JSON.stringify(entry.id)} pairs seat rule ${JSON.stringify(entry.seatRule)} with membership ${JSON.stringify(membership.kind)}, which the legal-pairing table forbids`);
}

export function factKindById(id: FactKindId, registry: FactKindRegistry = FACT_KIND_REGISTRY): FactKindEntry {
  const entry = registry.kinds.find((kind) => kind.id === id);
  if (!entry) throw new Error(`Fact kind ${JSON.stringify(id)} is not registered`);
  return entry;
}

/**
 * Every partition cell a membership names, in the order the membership states them.
 *
 * `module` and `corpus` name none, and that is not an omission: a module id is not a cell, and a corpus fact has
 * no place in the source to point at. Exported because "which cells did layer 3 file this fact in" is a question
 * consumers ask, and the alternative — a `switch` at each call site — is a second reader of a closed union that
 * stops agreeing with this one the day the union grows an arm.
 */
export function membershipCells(membership: Membership): readonly string[] {
  switch (membership.kind) {
    case "unit": return [membership.unitId];
    case "span-set": return membership.unitIds;
    case "relation": return membership.endpoints;
    case "module": return [];
    case "corpus": return [];
    default: return assertNever(membership, "membership");
  }
}

/**
 * Every id in a membership that does not resolve to something this run actually has.
 *
 * A dangling `unitId` is the failure this catches, and it is silent by nature: a fact whose membership names a
 * cell that was never minted is simply never seated, so every conservation law still balances and the fact
 * vanishes from the working set with no record. Reported as a list rather than thrown, because the caller
 * decides whether an unmappable fact is a finding or a visible `membershipUnmapped` row.
 */
export function membershipViolations(
  membership: Membership,
  known: { readonly cells: ReadonlySet<string>; readonly modules: ReadonlySet<string> }
): string[] {
  const dangling = (ids: readonly string[]): string[] =>
    ids.filter((id) => !known.cells.has(id)).map((id) => `${membership.kind} membership names ${JSON.stringify(id)}, which is not a partition cell of this run`);
  switch (membership.kind) {
    case "unit":
    case "span-set":
    case "relation": return dangling(membershipCells(membership));
    case "module":
      return known.modules.has(membership.moduleId)
        ? []
        : [`module membership names ${JSON.stringify(membership.moduleId)}, which is not a module of this run`];
    case "corpus": return [];
    default: return assertNever(membership, "membership");
  }
}

/**
 * The load-time counter-tripwire.
 *
 * Two failures it has to be able to state: a kind whose seat rule cannot be evaluated for its membership shape
 * (the judge would have to guess), and a kind naming a producer that has no envelope slot (its facts would have
 * nowhere to be published, so nothing downstream could ever read them).
 */
export function validateFactKindRegistry(registry: FactKindRegistry): void {
  const producers = new Set(ARTIFACT_REGISTRY.producers.map((producer) => producer.id));
  const seen = new Set<string>();
  for (const entry of registry.kinds) {
    if (seen.has(entry.id)) throw new Error(`Fact kind ${JSON.stringify(entry.id)} is registered twice`);
    seen.add(entry.id);
    if (!entry.title.trim()) throw new Error(`Fact kind ${JSON.stringify(entry.id)} declares no title`);
    if (!producers.has(entry.producer)) {
      throw new Error(`Fact kind ${JSON.stringify(entry.id)} names producer ${JSON.stringify(entry.producer)}, which has no layer-3 envelope slot in the artifact registry`);
    }
    const legal = LEGAL_PAIRINGS[entry.membershipKind];
    if (!legal.includes(entry.seatRule)) {
      throw new Error(`Fact kind ${JSON.stringify(entry.id)} pairs ${JSON.stringify(entry.membershipKind)} membership with seat rule ${JSON.stringify(entry.seatRule)}; legal rules for that shape are ${legal.join(", ")}`);
    }
  }
  for (const id of FACT_KIND_IDS) {
    if (!seen.has(id)) throw new Error(`Fact kind id ${JSON.stringify(id)} is declared in FACT_KIND_IDS but has no registry entry`);
  }
}

validateFactKindRegistry(FACT_KIND_REGISTRY);

/** Digest over the declared content. A new kind or a corrected seat rule moves it; layer 3 records it. */
export function factKindRegistryDigest(registry: FactKindRegistry = FACT_KIND_REGISTRY): string {
  return sha256(stableJson(registry));
}
