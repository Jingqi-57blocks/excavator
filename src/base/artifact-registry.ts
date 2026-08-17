import { sha256, stableJson } from "../core/util.ts";

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
    schemaId: "mechanisms-ledger-v1",
    validatorVersion: "mechanisms-ledger-validator-v1",
    enforced: false,
    enforcementNote: "The layer-2 ledger is not built yet; registered now so the slot exists before the producer does."
  },
  {
    id: "facts.units",
    layer: 3,
    title: "Reference units and the canonical attribution partition",
    pathTemplate: "facts/units.json",
    cardinality: "run",
    schemaId: "units-v1",
    validatorVersion: "units-validator-v1",
    enforced: false,
    enforcementNote: "Units and the partition builder are not built yet; the slot is registered so layer 4 has a declared denominator source."
  },
  {
    id: "attribution.attribution",
    layer: 4,
    title: "Per-unit attribution outcome with seat conservation",
    pathTemplate: "attribution/attribution.json",
    cardinality: "run",
    schemaId: "attribution-v1",
    validatorVersion: "attribution-validator-v1",
    enforced: false,
    enforcementNote: "Attribution records do not exist yet; today's seating happens inside context preparation with no artifact."
  },
  {
    id: "workset.fact-pack",
    layer: 5,
    title: "Per-feature fact pack",
    pathTemplate: "context/features/{feature}.factpack.json",
    cardinality: "per-feature",
    schemaId: "factpack-v1",
    validatorVersion: "factpack-validator-v1",
    enforced: true,
    enforcementNote: "Written for every feature at prepare today; instance-level enforcement is what keeps one feature's pack from covering another's."
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
    schemaId: "overview-census-v1",
    validatorVersion: "overview-census-validator-v1",
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
    enforced: false,
    enforcementNote: "Reading is authorised implicitly today; the ReadSpec artifact lands with the layer 5/6 slice."
  },
  {
    id: "obligation.declarations",
    layer: 6,
    title: "Obligation declarations with residual rows for unprobed candidates",
    pathTemplate: "obligations/declarations.json",
    cardinality: "run",
    schemaId: "obligation-declarations-v1",
    validatorVersion: "obligation-declarations-validator-v1",
    enforced: false,
    enforcementNote: "Today's equivalent is the work-item plan plus the read-obligation denominator, which are not yet a declaration artifact."
  },
  {
    id: "investigation.evidence-catalog",
    layer: 7,
    title: "Evidence catalog (append until freeze)",
    pathTemplate: "evidence.json",
    cardinality: "append-stream",
    schemaId: "evidence-catalog-v1",
    validatorVersion: "evidence-catalog-validator-v1",
    enforced: true,
    enforcementNote: "Exists from prepare onward and is digest-bound to the manifest; its stream identity is registered so freeze can pin the cutoff."
  },
  {
    id: "investigation.timeline",
    layer: 7,
    title: "Run timeline (append until freeze, hash-chained)",
    pathTemplate: "timeline.jsonl",
    cardinality: "append-stream",
    schemaId: "timeline-v1",
    validatorVersion: "timeline-validator-v1",
    enforced: true,
    enforcementNote: "Written from the first prepare event onward; the chain plus a continuous sequence is its verification, not byte determinism."
  },
  {
    id: "freeze.sealed-knowledge",
    layer: 8,
    title: "Sealed knowledge record for one epoch",
    pathTemplate: "knowledge.json",
    cardinality: "epoch",
    schemaId: "knowledge-v1",
    validatorVersion: "knowledge-validator-v1",
    enforced: false,
    enforcementNote: "Only exists after freeze; enforcing it at every audit would fail every investigation still in progress. Freeze checks it directly."
  }
];

const PRODUCERS: ProducerEntry[] = ([
  ["codegraph", "CodeGraph index queries", "The index is optional by design; its envelope is not written yet, so absence cannot be a finding."],
  ["native-graph", "Native tree-sitter graph for languages the index misses", "Runs as a separate command today and produces no run-scoped envelope."],
  ["framework", "Framework convention recovery (routes, components)", "Runs as a separate command today and produces no run-scoped envelope."],
  ["db-schema", "Database schema discovery", "Runs as a separate command today and produces no run-scoped envelope."],
  ["crossrepo", "Cross-repository HTTP link resolution", "Produces context/crossrepo-links.json only for multi-module targets; the uniform envelope is not built yet."],
  ["probe", "Decision probes and condition extraction", "Produces boundary functions and condition inventories, not yet a producer envelope."],
  ["vocabulary", "In-repository term frequency", "Computed inline during context preparation with no envelope."]
] as const).map(([id, title, note]) => ({
  id,
  layer: 3 as const,
  title,
  pathTemplate: "facts/producers/{producer}.json",
  cardinality: "per-producer" as const,
  schemaId: "producer-envelope-v1",
  validatorVersion: "producer-envelope-validator-v1",
  enforced: false,
  enforcementNote: note
}));

export const ARTIFACT_REGISTRY: ArtifactRegistry = {
  version: "artifact-registry-v1",
  slots: SLOTS,
  producers: PRODUCERS,
  checks: [
    { family: "coverage-conservation", version: "v1" },
    { family: "contract-instances", version: "v1" },
    { family: "boundary-identity", version: "v1" }
  ]
};

/** Digest over the registry's declared content. A registry change is a contract change, and this says so. */
export function registryDigest(registry: ArtifactRegistry): string {
  return sha256(stableJson(registry));
}
