import test from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_REGISTRY, registryDigest, type ArtifactRegistry } from "../src/base/artifact-registry.ts";
import { materializeBoundRunContract, type BoundRunContractInput } from "../src/contract/bound-run-contract.ts";
import { deriveContractManifest } from "../src/contract/contract-manifest.ts";
import type { BudgetConfig, ReportRequest } from "../src/base/types.ts";
import { stableJson } from "../src/base/util.ts";

/**
 * The bound contract is materialized from three external inputs BEFORE any producer runs, and the expected
 * artifact set is derived from the base registry rather than from what a run happened to produce. Deriving it
 * from results is what made "a frozen envelope is missing" a tautology.
 */

const budgets: BudgetConfig = {
  prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50,
  maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2
};

function request(): ReportRequest {
  return {
    target: "/tmp/target",
    language: "zh-CN",
    detailLevel: "detailed",
    workdir: "/tmp/work",
    overviewAudiences: ["product"],
    features: [{ subject: "请假管理", aliases: ["leave", "annual"], audiences: ["engineering"] }],
    budgets
  };
}

function input(overrides: Partial<BoundRunContractInput> = {}): BoundRunContractInput {
  return {
    request: request(),
    features: [{ key: "leave-abc1234567", subject: "请假管理", aliases: ["annual", "leave"] }],
    documents: [
      { id: "overview-product", kind: "overview", audience: "product", featureKey: null },
      { id: "feature-leave-abc1234567-engineering", kind: "feature", audience: "engineering", featureKey: "leave-abc1234567" }
    ],
    ...overrides
  };
}

test("the run intent records the feature subject with sorted aliases and the run budgets", () => {
  const contract = materializeBoundRunContract(input({
    features: [{ key: "leave-abc1234567", subject: "请假管理", aliases: ["leave", "annual", "leave"] }]
  }));
  assert.equal(contract.runIntent.version, "run-intent-v1");
  assert.deepEqual(contract.runIntent.features, [{ key: "leave-abc1234567", subject: "请假管理", aliases: ["annual", "leave"] }],
    "query aliases are sorted and de-duplicated, so the same intent has one spelling");
  assert.deepEqual(contract.runIntent.budgets, budgets);
  assert.deepEqual(contract.runIntent.documents, ["feature-leave-abc1234567-engineering", "overview-product"]);
});

test("alias order in the request cannot change the contract bytes", () => {
  const ascending = materializeBoundRunContract(input({ features: [{ key: "k", subject: "s", aliases: ["a", "b", "c"] }] }));
  const descending = materializeBoundRunContract(input({ features: [{ key: "k", subject: "s", aliases: ["c", "b", "a"] }] }));
  assert.equal(stableJson(ascending), stableJson(descending));
  assert.equal(ascending.runIntent.digest, descending.runIntent.digest);
});

test("requirements carry one row per requested document plus the run-level row, and no feature row for an overview-only run", () => {
  const withFeature = materializeBoundRunContract(input());
  const featureRows = withFeature.requirements.rows.filter((row) => row.scope === "feature");
  assert.equal(featureRows.length, 1);
  assert.equal(featureRows[0].featureKey, "leave-abc1234567");
  assert.ok(withFeature.requirements.rows.some((row) => row.scope === "run"), "a run-level requirement exists even with features");

  const overviewOnly = materializeBoundRunContract(input({
    features: [],
    documents: [{ id: "overview-product", kind: "overview", audience: "product", featureKey: null }]
  }));
  assert.deepEqual(overviewOnly.requirements.rows.filter((row) => row.scope === "feature"), []);
  assert.ok(overviewOnly.requirements.rows.length >= 2, "an overview-only run still receives run-level requirements");
  assert.ok(overviewOnly.requirements.rows.every((row) => row.id.startsWith("REQ-")));
});

test("the same input materializes byte-identical contract artifacts", () => {
  const first = materializeBoundRunContract(input());
  const second = materializeBoundRunContract(input());
  assert.equal(stableJson(first), stableJson(second));
  const firstManifest = deriveContractManifest(ARTIFACT_REGISTRY, first.runIntent, first.requirements);
  const secondManifest = deriveContractManifest(ARTIFACT_REGISTRY, second.runIntent, second.requirements);
  assert.equal(Buffer.compare(Buffer.from(stableJson(firstManifest)), Buffer.from(stableJson(secondManifest))), 0);
});

test("adding or removing a registry entry moves the expected instance set", () => {
  const contract = materializeBoundRunContract(input());
  const baseline = deriveContractManifest(ARTIFACT_REGISTRY, contract.runIntent, contract.requirements);

  const extended: ArtifactRegistry = {
    ...ARTIFACT_REGISTRY,
    slots: [...ARTIFACT_REGISTRY.slots, {
      id: "attribution.probe-slot", layer: 4, title: "probe", pathTemplate: "attribution/probe.json",
      cardinality: "run", schemaId: "probe-v1", validatorVersion: "probe-validator-v1",
      enforced: false, enforcementNote: "test-only slot"
    }]
  };
  const withExtra = deriveContractManifest(extended, contract.runIntent, contract.requirements);
  assert.equal(withExtra.expected.length, baseline.expected.length + 1);
  assert.ok(withExtra.expected.some((instance) => instance.slotId === "attribution.probe-slot"));
  assert.notEqual(withExtra.digest, baseline.digest, "a registry change is a contract change");
  assert.notEqual(registryDigest(extended), registryDigest(ARTIFACT_REGISTRY));

  const reduced: ArtifactRegistry = { ...ARTIFACT_REGISTRY, slots: ARTIFACT_REGISTRY.slots.filter((slot) => slot.layer !== 8) };
  const withoutFreeze = deriveContractManifest(reduced, contract.runIntent, contract.requirements);
  assert.ok(withoutFreeze.expected.length < baseline.expected.length);
  assert.equal(withoutFreeze.expected.filter((instance) => instance.layer === 8).length, 0);
});

test("the expected instance set is per-feature where the artifact is per-feature", () => {
  const twoFeatures = materializeBoundRunContract(input({
    features: [
      { key: "leave-aaaaaaaaaa", subject: "请假", aliases: [] },
      { key: "payroll-bbbbbbbbbb", subject: "薪酬", aliases: [] }
    ],
    documents: [
      { id: "feature-leave-aaaaaaaaaa-engineering", kind: "feature", audience: "engineering", featureKey: "leave-aaaaaaaaaa" },
      { id: "feature-payroll-bbbbbbbbbb-engineering", kind: "feature", audience: "engineering", featureKey: "payroll-bbbbbbbbbb" }
    ]
  }));
  const manifest = deriveContractManifest(ARTIFACT_REGISTRY, twoFeatures.runIntent, twoFeatures.requirements);
  const factPacks = manifest.expected.filter((instance) => instance.slotId === "workset.fact-pack");
  assert.deepEqual(factPacks.map((instance) => instance.instanceKey).sort(), ["leave-aaaaaaaaaa", "payroll-bbbbbbbbbb"],
    "a slot being satisfied by feature A must not cover feature B");
  assert.ok(factPacks.every((instance) => instance.path.includes(instance.instanceKey)));
  const censuses = manifest.expected.filter((instance) => instance.slotId === "workset.scope-census");
  assert.equal(censuses.length, 2);
});

test("the manifest is derived from the registry and the contract inputs only", () => {
  const contract = materializeBoundRunContract(input());
  const manifest = deriveContractManifest(ARTIFACT_REGISTRY, contract.runIntent, contract.requirements);
  assert.equal(manifest.registryDigest, registryDigest(ARTIFACT_REGISTRY));
  assert.equal(manifest.runIntentDigest, contract.runIntent.digest);
  assert.equal(manifest.requirementsDigest, contract.requirements.digest);
  assert.equal(deriveContractManifest.length, 3, "the signature cannot accept an actual-artifact argument");
});
