import test from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_REGISTRY, registryDigest } from "../src/base/artifact-registry.ts";

/**
 * The registry pins the contract's OWN list, not whatever the registry happens to contain.
 *
 * Execution point 2 of `docs/layering.md` §二 is "the artifact registry covers the eight layers' slots and every
 * layer-3 producer, and freeze verifies them one by one". The registry exists and freeze verifies it — but until
 * this file, nothing said the registry had to keep covering all eight layers or naming all seven producers.
 * Deleting the layer-6 slot, or quietly dropping `vocabulary` from the producer list, made no check go red:
 * the manifest is derived from the registry, and the audit is derived from the manifest, so an omission removes
 * the expectation along with the artifact. That is the P16 shape ("a tool sits outside the pipeline and nothing
 * is reachable to notice") reappearing one level up, and the only cure is a list written down somewhere the
 * registry cannot derive it from.
 *
 * The seven producers are the ones the contract's layer-3 row names: codegraph index, native-graph, framework
 * pack, db-schema, crossrepo, probe, and in-repository term frequency (vocabulary).
 */

/** Named by `docs/layering.md` §一, layer 3. Sorted, and compared as a set — order here is not the contract. */
const CONTRACT_PRODUCERS = ["codegraph", "crossrepo", "db-schema", "framework", "native-graph", "probe", "vocabulary"];

test("every one of the eight layers has at least one registered artifact slot", () => {
  const byLayer = new Map<number, string[]>();
  for (const slot of ARTIFACT_REGISTRY.slots) {
    byLayer.set(slot.layer, [...(byLayer.get(slot.layer) ?? []), slot.id]);
  }
  const uncovered = [1, 2, 3, 4, 5, 6, 7, 8].filter((layer) => !(byLayer.get(layer) ?? []).length);
  assert.deepEqual(uncovered, [],
    `a layer with no slot has no expectation, so its whole artifact can be absent without a finding; covered: ${JSON.stringify([...byLayer].sort())}`);
});

test("the producer set is exactly the seven the contract names — no more, no fewer", () => {
  assert.deepEqual(ARTIFACT_REGISTRY.producers.map((producer) => producer.id).sort(), CONTRACT_PRODUCERS);
  for (const producer of ARTIFACT_REGISTRY.producers) {
    assert.equal(producer.layer, 3, `${producer.id} is a layer-3 producer by definition`);
    assert.equal(producer.cardinality, "per-producer", `${producer.id} must register to the instance`);
  }
});

test("slot ids are unique, and every slot states its enforcement rather than implying it", () => {
  const ids = ARTIFACT_REGISTRY.slots.map((slot) => slot.id);
  assert.deepEqual(ids.length, new Set(ids).size, `two slots with one id make a finding ambiguous: ${JSON.stringify(ids)}`);
  const producerIds = ARTIFACT_REGISTRY.producers.map((producer) => producer.id);
  assert.deepEqual(producerIds.length, new Set(producerIds).size);
  for (const entry of [...ARTIFACT_REGISTRY.slots, ...ARTIFACT_REGISTRY.producers]) {
    assert.match(entry.id, /^[a-z0-9.-]+$/, `${entry.id} is what a finding names, so it stays greppable`);
    assert.ok(entry.pathTemplate.trim(), `${entry.id} declares no path`);
    assert.ok(entry.schemaId.trim() && entry.validatorVersion.trim(), `${entry.id} declares no schema or validator version`);
    assert.equal(typeof entry.enforced, "boolean");
    assert.ok(entry.enforcementNote.trim(),
      `${entry.id} must say why it is enforced or what it waits on; an unenforced slot has to be a decision, not an oversight`);
  }
});

test("a placeholder in a path template is one of the two the manifest can resolve", () => {
  for (const entry of [...ARTIFACT_REGISTRY.slots, ...ARTIFACT_REGISTRY.producers]) {
    const placeholders = [...entry.pathTemplate.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    for (const placeholder of placeholders) {
      assert.ok(["feature", "producer"].includes(placeholder),
        `${entry.id} uses {${placeholder}}, which nothing expands, so its instance path would keep the brace`);
    }
    if (entry.cardinality === "per-feature") assert.ok(placeholders.includes("feature"), `${entry.id} is per-feature yet its path does not vary by feature`);
    if (entry.cardinality === "per-producer") assert.ok(placeholders.includes("producer"), `${entry.id} is per-producer yet its path does not vary by producer`);
  }
});

test("the registry digest moves when the registry does — a registry change is a contract change", () => {
  const before = registryDigest(ARTIFACT_REGISTRY);
  const after = registryDigest({
    ...ARTIFACT_REGISTRY,
    producers: ARTIFACT_REGISTRY.producers.filter((producer) => producer.id !== "vocabulary")
  });
  assert.notEqual(before, after, "dropping a producer must not leave the recorded contract identity untouched");
});
