import type { ArtifactResult } from "../base/artifact-result.ts";
import { summarizeCoverage, type CoverageConservation } from "../base/conservation.ts";
import { factKindById, type FactKindId, type Membership } from "../base/fact-kind-registry.ts";
import { canonicalJson, sha256 } from "../base/util.ts";
import {
  MEMBERSHIP_MAP_VERSION,
  type FactDetail, type FactDetailValue, type MappedFact, type UnmappedAnchor
} from "./units/membership-map.ts";

/**
 * `facts/producers/<producer>.json`: one layer-3 producer's fact set, in the envelope every producer shares.
 *
 * The registry (`base/artifact-registry.ts`) expects one of these per registered producer, enforced, on every
 * run — successful or failed. That is the point of P16: a tool whose envelope may be absent is a tool that can
 * sit outside the pipeline while every check stays green, so "it did not run" is a written record here and never
 * a missing file. Six of today's seven producers publish exactly such a record.
 *
 * IDENTITY. Three things are in it that were learned the hard way. `unitsContentDigest`, because a membership
 * row names partition cells and a partition from another generation is a different set of cells — a semantic
 * input outside the identity is a cache false-hit waiting to happen. `mappingVersion`, for the same reason one
 * level up: the same observations under a changed mapping algorithm are different facts. And NO FEATURE KEY,
 * which is the layer-3 identity rule in the contract's fifth column: facts are not about a feature, and an
 * envelope keyed by one is P17 in the identity.
 */

export const PRODUCER_ENVELOPE_VERSION = "producer-envelope-v1";

/**
 * The declared bound on one detail value, and the reason it is a clip rather than a refusal.
 *
 * The values that get long are verbatim source expressions — `FrontendCall.expression` and
 * `RecoveredRoute.handlerExpression` are "the argument as written" — which is exactly the shape that put a
 * 439,321-character excerpt into an `evidence.json` (P18). Refusing the value would fail a prepare over a long
 * line; dropping it silently would be the unbounded field's quieter cousin. So it is clipped deterministically
 * and the clip is SELF-DESCRIBING: the suffix states how many characters were removed, and the envelope counts
 * how many values were clipped, so no reader mistakes a clipped value for the whole one.
 */
export const FACT_DETAIL_MAX_CHARS = 200;

export interface ProducerFactRow {
  readonly factId: string;
  readonly kind: FactKindId;
  /** Written once, here, by layer 3. Downstream associates by this and never re-derives one (§一). */
  readonly membership: Membership;
  readonly detail: FactDetail;
}

export interface ProducerFactSetIdentity {
  readonly filesContentManifestDigest: string;
  readonly mechanismsDigest: string;
  readonly unitsContentDigest: string;
  readonly producer: string;
  readonly producerVersion: string;
  /** The producer's configuration and mode, digested. A mode outside the identity is a stale cache hit. */
  readonly configDigest: string;
  readonly mappingVersion: string;
}

export interface ProducerFactSet {
  readonly version: typeof PRODUCER_ENVELOPE_VERSION;
  readonly producer: string;
  readonly identity: ProducerFactSetIdentity;
  readonly facts: readonly ProducerFactRow[];
  /**
   * Anchors that resolved to no partition cell, with the reason. The visible bucket the contract's "membership
   * unmapped" requirement names: a fact whose anchor is outside the counted corpus is neither dropped nor given
   * a membership it does not have.
   */
  readonly membershipUnmapped: readonly UnmappedAnchor[];
  /** Fact ids with no membership at all — every anchor unresolved. Published, so the loss is countable. */
  readonly unmappableFactIds: readonly string[];
  /** The coverage axis over OBSERVATIONS: total offered, counted seated in a membership, excluded unmappable. */
  readonly completeness: CoverageConservation & {
    readonly byKind: Readonly<Record<string, number>>;
    readonly detailMaxChars: number;
    readonly detailClipped: number;
  };
  /** The producer's own completeness record — caps, query limits, warning counts. Scalars only, by type. */
  readonly producerCompleteness: FactDetail;
}

export interface ProducerFactSetInput {
  readonly producer: string;
  readonly producerVersion: string;
  readonly identity: Omit<ProducerFactSetIdentity, "producer" | "producerVersion" | "mappingVersion">;
  readonly mapped: readonly MappedFact[];
  readonly unmappedAnchors: readonly UnmappedAnchor[];
  readonly unmappableFactIds: readonly string[];
  readonly producerCompleteness: FactDetail;
}

/**
 * Assemble one producer's envelope from the mapping result.
 *
 * The producer of each fact is READ FROM THE KIND REGISTRY rather than taken on the caller's word, and a fact
 * belonging to another producer throws. Without that, one producer's envelope could publish another's facts and
 * the per-producer accounting the contract rests on would be a naming convention.
 */
export function buildProducerFactSet(input: ProducerFactSetInput): ProducerFactSet {
  let clipped = 0;
  const facts: ProducerFactRow[] = input.mapped.map((fact) => {
    const owner = factKindById(fact.kind).producer;
    if (owner !== input.producer) {
      throw new Error(`Producer ${JSON.stringify(input.producer)} published fact ${JSON.stringify(fact.factId)} of kind ${JSON.stringify(fact.kind)}, which the fact-kind registry assigns to ${JSON.stringify(owner)}`);
    }
    const detail: Record<string, FactDetailValue> = {};
    for (const key of Object.keys(fact.detail).sort()) {
      const value = fact.detail[key]!;
      if (typeof value === "string" && value.length > FACT_DETAIL_MAX_CHARS) {
        clipped += 1;
        detail[key] = `${value.slice(0, FACT_DETAIL_MAX_CHARS)}…+${value.length - FACT_DETAIL_MAX_CHARS}c`;
        continue;
      }
      detail[key] = value;
    }
    return { factId: fact.factId, kind: fact.kind, membership: fact.membership, detail };
  });
  const byKind: Record<string, number> = {};
  for (const fact of facts) byKind[fact.kind] = (byKind[fact.kind] ?? 0) + 1;
  const total = facts.length + input.unmappableFactIds.length;
  return {
    version: PRODUCER_ENVELOPE_VERSION,
    producer: input.producer,
    identity: {
      ...input.identity,
      producer: input.producer,
      producerVersion: input.producerVersion,
      mappingVersion: MEMBERSHIP_MAP_VERSION
    },
    facts: facts.sort((a, b) => a.kind.localeCompare(b.kind) || a.factId.localeCompare(b.factId)),
    membershipUnmapped: [...input.unmappedAnchors].sort((a, b) => a.factId.localeCompare(b.factId) || a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine),
    unmappableFactIds: [...input.unmappableFactIds].sort(),
    completeness: Object.assign(
      summarizeCoverage({ total, counted: facts.length, excluded: input.unmappableFactIds.length }),
      { byKind: sortedKeys(byKind), detailMaxChars: FACT_DETAIL_MAX_CHARS, detailClipped: clipped }
    ),
    producerCompleteness: sortedKeys(input.producerCompleteness)
  };
}

/**
 * One producer's share of a whole-run mapping result.
 *
 * The mapper runs ONCE over every observation, because `observedBy` is a merge across producers and a per-producer
 * pass could not see the other producers' observations of the same unit. Splitting the result afterwards is what
 * lets each producer still publish its own envelope, and the split is by the fact kind's REGISTERED producer, so
 * it agrees with `buildProducerFactSet`'s own check by construction.
 */
export function factsOfProducer(mapping: {
  readonly mapped: readonly MappedFact[];
  readonly unmappedAnchors: readonly UnmappedAnchor[];
  readonly unmappable: readonly string[];
}, producer: string): {
  readonly mapped: readonly MappedFact[];
  readonly unmappedAnchors: readonly UnmappedAnchor[];
  readonly unmappableFactIds: readonly string[];
} {
  const owns = (kind: FactKindId): boolean => factKindById(kind).producer === producer;
  const unmappableOf = new Map(mapping.unmappedAnchors.map((anchor) => [anchor.factId, anchor.kind]));
  return {
    mapped: mapping.mapped.filter((fact) => owns(fact.kind)),
    unmappedAnchors: mapping.unmappedAnchors.filter((anchor) => owns(anchor.kind)),
    unmappableFactIds: mapping.unmappable.filter((factId) => {
      const kind = unmappableOf.get(factId);
      // A fact with no membership has every anchor in `unmappedAnchors`, so its kind is always resolvable there.
      // A corpus fact can never be unmappable (it has no anchor), which is why there is no other source to try.
      return kind !== undefined && owns(kind);
    })
  };
}

function sortedKeys<T>(record: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key]!;
  return out;
}

/** The envelope's own content digest, over the declared fields. Recorded by whoever binds to this producer. */
export function producerFactSetDigest(factSet: ProducerFactSet): string {
  return sha256(canonicalJson(factSet));
}

/**
 * The envelope's canonical bytes: stable key order, stable row order, no wall-clock field. Two prepares over an
 * unchanged tree produce identical bytes, which is only checkable if nothing records "now".
 *
 * Unindented for the same reason `facts/units.json` is: measured on wcp, the codegraph envelope is 3.3 MB indented
 * over 6,000-odd fact rows, and nothing reads it by eye.
 */
export function serializeProducerFactSet(result: ArtifactResult<ProducerFactSet>): string {
  return `${canonicalJson(result)}\n`;
}
