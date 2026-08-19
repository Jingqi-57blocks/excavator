import { sha256, stableJson } from "./util.ts";

/**
 * The static registry of layer artifacts and layer-3 producers.
 *
 * It exists so the expected artifact set can be derived FORWARD — from the base plus the contract inputs —
 * rather than backward from whatever a run happened to produce. Backward derivation is what made "a required
 * envelope is missing" a tautology: the expectation was read off the results, so results could never
 * contradict it, and a whole tool could sit outside the pipeline without any check going red.
 *
 * Two properties are load-bearing:
 *
 *  - `enforced` is stated explicitly on every entry, and is `false` for most of them today. A registry that
 *    claimed enforcement it does not have would be worse than no registry: freeze would report a clean
 *    envelope set for artifacts that do not exist. Each entry says in `enforcementNote` what it is waiting on.
 *  - `cardinality` registers to the INSTANCE, not just the family. A run with two features expects two fact
 *    packs; without instance cardinality, feature A's pack satisfies the slot and feature B's whole working
 *    set can vanish unnoticed.
 */

export type InstanceCardinality =
  /** Exactly one instance per run. */
  | "run"
  /** One instance per feature key in `run-intent.json`. */
  | "per-feature"
  /** One instance per registered layer-3 producer. */
  | "per-producer"
  /** One append-until-freeze stream; the instance registers the stream identity, cutoff and tail digest. */
  | "append-stream"
  /** One instance per sealed epoch; epoch 0 is the first freeze. */
  | "epoch";

export interface RegistryEntry {
  /** Stable dotted id, `<layer-name>.<artifact>`; it is what a finding names, so it never changes silently. */
  id: string;
  layer: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  title: string;
  /** Run-directory-relative path; `{feature}` and `{producer}` are the only placeholders. */
  pathTemplate: string;
  cardinality: InstanceCardinality;
  schemaId: string;
  validatorVersion: string;
  /** Whether a missing instance is a finding TODAY. Explicit, never inferred from the artifact's existence. */
  enforced: boolean;
  /** Why it is enforced, or what it waits on. Required, so an unenforced slot is a decision, not an oversight. */
  enforcementNote: string;
}

export interface ProducerEntry extends RegistryEntry {
  layer: 3;
  cardinality: "per-producer";
}

export interface ArtifactRegistry {
  version: string;
  slots: RegistryEntry[];
  producers: ProducerEntry[];
  /** Check families the contract expects layer 8 to run, with their versions. */
  checks: Array<{ family: string; version: string }>;
}

const SLOTS: RegistryEntry[] = [
  {
    id: "boundary.files-ledger",
    layer: 1,
    title: "File ledger: every root-discovery candidate in exactly one bucket",
    pathTemplate: "ledger/files.json",
    cardinality: "run",
    schemaId: "files-ledger-v1",
    validatorVersion: "files-ledger-validator-v1",
    enforced: true,
    enforcementNote: "Produced by every prepare; it is the denominator every later layer inherits, so its absence is never tolerable."
  },
  {
    id: "mechanism.mechanisms-ledger",
    layer: 2,
    title: "Mechanism ledger: (row x mechanism) coverage with declared CoverageDomain and UnitKind",
    pathTemplate: "ledger/mechanisms.json",
    cardinality: "run",
    schemaId: "mechanisms-ledger-v2",
    validatorVersion: "mechanisms-ledger-validator-v2",
    enforced: true,
    enforcementNote: "Written by every prepare from the layer-1 counted rows plus the base language/mechanism registries; without it, which mechanism could look at which language is invisible again."
  },
  {
    id: "facts.units",
    layer: 3,
    title: "Reference units and the canonical attribution partition",
    pathTemplate: "facts/units.json",
    cardinality: "run",
    schemaId: "units-v1",
    validatorVersion: "units-validator-v1",
    enforced: true,
    enforcementNote: "Written by every prepare from the layer-1 counted rows and the designated partition builders, and written as an Unavailable record when a designated builder could not run or preparation failed earlier; there is no path through prepare that leaves it absent."
  },
  {
    id: "attribution.attribution",
    layer: 4,
    title: "Per-unit attribution outcome with seat conservation",
    pathTemplate: "attribution/attribution.json",
    cardinality: "run",
    schemaId: "attribution-v3",
    validatorVersion: "attribution-validator-v2",
    enforced: true,
    enforcementNote: "Written by every prepare from the selector's own channel trace and the layer-3 memberships, and written as an Unavailable record when there was no partition to seat anything in; a run with no feature writes it with featureCount 0 rather than omitting it."
  },
  {
    id: "workset.fact-pack",
    layer: 5,
    title: "Per-feature fact pack",
    pathTemplate: "context/features/{feature}.factpack.json",
    cardinality: "per-feature",
    schemaId: "factpack-v2",
    validatorVersion: "factpack-validator-v2",
    enforced: true,
    enforcementNote: "Written for every feature after layer-4 attribution; every machine row carries a copied layer-3 membership or a written unjoined reason plus a seeded/retained/co-located/not-applicable relation."
  },
  {
    id: "workset.scope-census",
    layer: 5,
    title: "Per-feature module x language scope census",
    pathTemplate: "context/{feature}.scope-census.json",
    cardinality: "per-feature",
    schemaId: "scope-census-v2",
    validatorVersion: "scope-census-validator-v2",
    enforced: true,
    enforcementNote: "Written for every feature at prepare today, including the explicit 'no census could be built' record."
  },
  {
    id: "workset.overview-census",
    layer: 5,
    title: "Overview module accounting, produced unconditionally",
    pathTemplate: "context/overview-census.json",
    cardinality: "run",
    schemaId: "overview-census-v2",
    validatorVersion: "overview-census-validator-v2",
    enforced: true,
    enforcementNote: "Written unconditionally at prepare, including on overview-only runs; that unconditional shape is the whole point of the artifact."
  },
  {
    id: "workset.read-specs",
    layer: 5,
    title: "ReadSpec set: path, span, reason and budget authorisation, without source text",
    pathTemplate: "workset/read-specs.json",
    cardinality: "run",
    schemaId: "read-specs-v1",
    validatorVersion: "read-specs-validator-v1",
    enforced: true,
    enforcementNote: "Written by every prepare as a pure authorization artifact; it contains path, span, reason and budget but never source bytes or evidence identity."
  },
  {
    id: "obligation.declarations",
    layer: 6,
    title: "Obligation declarations with residual rows for unprobed candidates",
    pathTemplate: "obligations/declarations.json",
    cardinality: "run",
    schemaId: "obligation-declarations-v1",
    validatorVersion: "obligation-declarations-validator-v1",
    enforced: true,
    enforcementNote: "Written by every prepare from requirements, workset, mechanisms and units; an unavailable probe becomes an individual residual rather than disappearing."
  },
  {
    id: "investigation.evidence-catalog",
    layer: 7,
    title: "Evidence catalog (append until freeze)",
    pathTemplate: "evidence.json",
    cardinality: "append-stream",
    schemaId: "evidence-catalog-v2-bounded-shards",
    validatorVersion: "evidence-catalog-validator-v2",
    enforced: true,
    enforcementNote: "Exists from prepare onward; every kind passes the same scalar/record bound, immutable content store and shard cap, while a single-writer tail checkpoint lets freeze pin the cutoff without per-append full rewrites."
  },
  {
    id: "investigation.read-results",
    layer: 7,
    title: "ReadSpec executions and obligation dispositions",
    pathTemplate: "investigation/results.json",
    cardinality: "run",
    schemaId: "read-execution-v1",
    validatorVersion: "read-execution-validator-v1",
    enforced: true,
    enforcementNote: "Written by every prepare after layer 6; each ReadSpec has one source, empty or unavailable result, each decision-reading has a positive, negative or pending disposition, and every probe-unavailable residual remains named."
  },
  {
    id: "investigation.timeline",
    layer: 7,
    title: "Run timeline (append until freeze, hash-chained)",
    pathTemplate: "timeline.jsonl",
    cardinality: "append-stream",
    schemaId: "timeline-v1",
    validatorVersion: "timeline-validator-v2-tail-checkpoint",
    enforced: true,
    enforcementNote: "Written from the first prepare event onward through the shared single writer; the chain, tail checkpoint and continuous sequence are its verification, not byte determinism."
  },
  {
    id: "freeze.sealed-knowledge",
    layer: 8,
    title: "Sealed knowledge record for one epoch",
    pathTemplate: "knowledge.json",
    cardinality: "epoch",
    schemaId: "knowledge-v1",
    validatorVersion: "knowledge-validator-v2-epoch-chain",
    enforced: false,
    enforcementNote: "The pre-run contract seeds epoch 0 at knowledge.json. Freeze audits the dynamic N>0 chain under knowledge/epochs because those instances do not exist until justified supplements are sealed."
  }
];

/**
 * The seven layer-3 producers, all enforced.
 *
 * `enforced: true` does NOT mean each producer runs — five of the seven publish a written `Unavailable` record
 * today. It means the ENVELOPE must exist, which is the whole of P16: a tool whose envelope may be absent can sit
 * outside the pipeline with every check green. `src/run/facts-stage.ts` is what makes the flag honest: it produces
 * all seven on the success path and all seven on the failure path, so there is no prepare that leaves one out.
 *
 * Each note says what the envelope SAYS today, not what the producer aspires to. The `vocabulary` note used to
 * claim "in-repository term frequency, computed inline during context preparation" — measured: nothing in this
 * repository computes a document frequency anywhere, and the terms `tokenize` is given all come from the
 * operator's own run-intent subject and aliases. A registry that describes a mechanism that does not exist is
 * worse than one that says nothing, because freeze reports a clean envelope set over it.
 */
const PRODUCERS: ProducerEntry[] = ([
  ["codegraph", "CodeGraph index queries: the whole-corpus callable and route inventory",
    "Written by every prepare. Built when the run resolved a readable index, otherwise Unavailable{index-not-present} — the index is optional by design, and which of the two happened is now a record instead of a missing file."],
  ["native-graph", "Native tree-sitter graph for languages the index misses",
    "Written by every prepare as Unavailable{policy: not-run-scoped}: the builder runs as its own command and writes outside the run directory, so this run has no fact set from it."],
  ["framework", "Framework convention recovery (routes, components)",
    "Written by every prepare as Unavailable{policy: not-run-scoped}: convention recovery runs as its own command and writes outside the run directory."],
  ["db-schema", "Database schema discovery",
    "Written by every prepare as Unavailable{policy: not-run-scoped}: schema discovery runs as its own command and writes outside the run directory."],
  ["crossrepo", "Cross-repository HTTP link resolution: call sites, recovered routes and the links between them",
    "Written by every prepare. NotApplicable{single-module} only when the complete layer-1 ledger census has exactly one target root. Multiple roots proceed only when the resolver inputs and scan are available; a cap, dropped root, read failure or missing resolver input is Unavailable."],
  ["probe", "Decision probes and condition extraction",
    "Written by every prepare as Unavailable{policy: feature-scoped-today}: probes run per feature inside context preparation, and a layer-3 fact set may not be keyed by a feature."],
  ["vocabulary", "In-repository term frequency",
    "Written by every prepare as Unavailable{not-implemented}: no document frequency is computed anywhere in this engine. The previous note claimed it was computed inline during context preparation, which was not true of any code path."]
] as const).map(([id, title, note]) => ({
  id,
  layer: 3 as const,
  title,
  pathTemplate: "facts/producers/{producer}.json",
  cardinality: "per-producer" as const,
  schemaId: "producer-envelope-v1",
  validatorVersion: "producer-envelope-validator-v1",
  enforced: true,
  enforcementNote: note
}));

export const ARTIFACT_REGISTRY: ArtifactRegistry = {
  version: "artifact-registry-v1",
  slots: SLOTS,
  producers: PRODUCERS,
  checks: [
    { family: "coverage-conservation", version: "v1" },
    { family: "contract-instances", version: "v1" },
    { family: "boundary-identity", version: "v1" },
    { family: "not-applicable-premises", version: "v1" },
    { family: "investigation-closure", version: "v1" }
  ]
};

/** Digest over the registry's declared content. A registry change is a contract change, and this says so. */
export function registryDigest(registry: ArtifactRegistry): string {
  return sha256(stableJson(registry));
}
