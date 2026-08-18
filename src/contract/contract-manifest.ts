import type { ArtifactRegistry, InstanceCardinality, RegistryEntry } from "../base/artifact-registry.ts";
import { registryDigest } from "../base/artifact-registry.ts";
import { PARTITION_DESIGNATION, PARTITION_DESIGNATION_VERSION, partitionDesignationDigest } from "../base/partition-designation.ts";
import { sha256, stableJson } from "../base/util.ts";
import type { Requirements, RunIntent } from "./bound-run-contract.ts";

/**
 * `contract-manifest.json`: which artifact INSTANCES this run is expected to produce.
 *
 * The signature is the guardrail. `deriveContractManifest` takes the registry and the two contract inputs and
 * nothing else — there is no parameter through which an actual artifact could enter, so the expectation can
 * only be derived forward. `expected` = registry x contract inputs (feature keys come from `run-intent.json`,
 * never from a directory listing of what was written).
 */

export interface ExpectedInstance {
  slotId: string;
  layer: number;
  /** `run`, a feature key, a producer id, a stream id, or `epoch-0`. */
  instanceKey: string;
  /** Run-directory-relative path with placeholders resolved. */
  path: string;
  cardinality: InstanceCardinality;
  schemaId: string;
  validatorVersion: string;
  enforced: boolean;
}

export interface ContractManifest {
  version: "contract-manifest-v2";
  registryVersion: string;
  registryDigest: string;
  runIntentDigest: string;
  requirementsDigest: string;
  /**
   * The partition schema generation this run is bound to, and the designation table it was derived from.
   *
   * v2 adds it, and the reason is the one §一 gives for making a builder change an EPOCH rather than a refinement:
   * `UnitId`s are not comparable across generations, so "the expected instance set" is not the whole contract a
   * run's layer-3 artifacts have to be read under. An archived run verifies against the contract IT recorded, and
   * without this a run prepared under one designation table would verify against another's ids with nothing to
   * detect it. The digest moves when any language is retargeted or a builder's algorithm changes.
   */
  partitionDesignation: { version: string; digest: string };
  expected: ExpectedInstance[];
  checks: Array<{ family: string; version: string }>;
  digest: string;
}

export function deriveContractManifest(registry: ArtifactRegistry, runIntent: RunIntent, requirements: Requirements): ContractManifest {
  const expected: ExpectedInstance[] = [];
  for (const slot of registry.slots) expected.push(...expandSlot(slot, runIntent, registry));
  for (const producer of registry.producers) {
    expected.push(instance(producer, producer.id, producer.pathTemplate.replaceAll("{producer}", producer.id)));
  }
  expected.sort((a, b) => a.layer - b.layer || a.slotId.localeCompare(b.slotId) || a.instanceKey.localeCompare(b.instanceKey));
  const unsigned: Omit<ContractManifest, "digest"> = {
    version: "contract-manifest-v2",
    registryVersion: registry.version,
    registryDigest: registryDigest(registry),
    runIntentDigest: runIntent.digest,
    requirementsDigest: requirements.digest,
    partitionDesignation: { version: PARTITION_DESIGNATION_VERSION, digest: partitionDesignationDigest(PARTITION_DESIGNATION) },
    expected,
    checks: [...registry.checks].sort((a, b) => a.family.localeCompare(b.family))
  };
  return { ...unsigned, digest: contractManifestDigest(unsigned) };
}

/**
 * The manifest's self-digest, from its own recorded fields. Exported because layer 8 must RECOMPUTE it: the
 * instance audit reads `expected` out of the run and short-circuits on an empty or all-unenforced list, so a
 * truncated `contract-manifest.json` would silently turn the whole check into a pass. Signing the record is
 * only useful if someone verifies the signature, and this is the one formula both sides use.
 */
export function contractManifestDigest(manifest: Omit<ContractManifest, "digest">): string {
  const { digest: _recorded, ...unsigned } = manifest as ContractManifest;
  return sha256(stableJson(unsigned));
}

function expandSlot(slot: RegistryEntry, runIntent: RunIntent, registry: ArtifactRegistry): ExpectedInstance[] {
  switch (slot.cardinality) {
    case "run":
      return [instance(slot, "run", slot.pathTemplate)];
    case "per-feature":
      // The feature keys come from the contract input. A run with two features expects two instances, so a
      // slot satisfied by feature A can never stand in for feature B.
      return runIntent.features.map((feature) => instance(slot, feature.key, slot.pathTemplate.replaceAll("{feature}", feature.key)));
    case "per-producer":
      return registry.producers.map((producer) => instance(slot, producer.id, slot.pathTemplate.replaceAll("{producer}", producer.id)));
    case "append-stream":
      // The stream identity IS the instance; freeze registers its cutoff sequence and tail digest against it.
      return [instance(slot, slot.pathTemplate, slot.pathTemplate)];
    case "epoch":
      // Only epoch 0 is expected today: freeze produces it, and later supplements append further epochs.
      return [instance(slot, "epoch-0", slot.pathTemplate)];
  }
}

function instance(entry: RegistryEntry, instanceKey: string, path: string): ExpectedInstance {
  return {
    slotId: entry.id,
    layer: entry.layer,
    instanceKey,
    path,
    cardinality: entry.cardinality,
    schemaId: entry.schemaId,
    validatorVersion: entry.validatorVersion,
    enforced: entry.enforced
  };
}
