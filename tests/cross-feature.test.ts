import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { computeCrossFeatureRelationships, renderCrossFeatureSection, type CrossFeatureInput, type CrossFeatureRelationships } from "../src/cross-feature.ts";
import { prepareRun } from "../src/run.ts";
import type { FactPackCategory, FactPackItem, FeatureFactPack } from "../src/types.ts";
import { copyFixture, tempDir } from "./helpers.ts";

type ItemSeed = Partial<FactPackItem> & { category: FactPackCategory; name: string };

function factPack(items: ItemSeed[]): FeatureFactPack {
  return {
    version: "factpack-v1",
    snapshotId: "snap",
    featureKey: "k",
    items: items.map((item) => ({ filePath: "", line: 0, source: "scan", ...item })),
    coverage: [],
    warnings: []
  };
}

function feature(key: string, subject: string, files: string[], items: ItemSeed[]): CrossFeatureInput {
  return { key, subject, files, factPack: factPack(items) };
}

// service-a and service-b overlap on a file, an entity and a config key; service-c overlaps with neither.
function threeServices(): CrossFeatureInput[] {
  return [
    feature("service-b", "Service B", ["src/b.ts", "src/shared.ts"], [
      { category: "entities", name: "Order", filePath: "src/order.ts", line: 1 },
      { category: "config-keys", name: "DB_URL" }
    ]),
    feature("service-a", "Service A", ["src/a.ts", "src/shared.ts"], [
      { category: "entities", name: "Order", filePath: "src/order.ts", line: 1 },
      { category: "config-keys", name: "DB_URL" },
      { category: "config-keys", name: "A_ONLY" }
    ]),
    feature("service-c", "Service C", ["src/c.ts"], [
      { category: "entities", name: "Invoice", filePath: "src/invoice.ts", line: 5 },
      { category: "config-keys", name: "C_ONLY" }
    ])
  ];
}

test("only feature pairs with a shared signal are emitted, with sorted shared lists", () => {
  const result = computeCrossFeatureRelationships(threeServices());

  assert.equal(result.version, "cross-feature-v1");
  assert.equal(result.relationships.length, 1, "only the service-a/service-b pair shares anything");
  const [pair] = result.relationships;
  assert.equal(pair.featureA, "service-a", "the lexicographically smaller key is featureA");
  assert.equal(pair.featureB, "service-b");
  assert.deepEqual(pair.sharedFiles, ["src/shared.ts"]);
  assert.deepEqual(pair.sharedEntities, [{ name: "Order", filePath: "src/order.ts", line: 1 }]);
  assert.deepEqual(pair.sharedConfigKeys, ["DB_URL"], "A_ONLY is not shared and is excluded");
});

test("a shared file alone, a shared entity alone and a shared config key alone each emit a pair", () => {
  const fileOnly = computeCrossFeatureRelationships([
    feature("a", "A", ["src/x.ts"], []),
    feature("b", "B", ["src/x.ts"], [])
  ]);
  assert.equal(fileOnly.relationships.length, 1);
  assert.deepEqual(fileOnly.relationships[0].sharedFiles, ["src/x.ts"]);
  assert.deepEqual(fileOnly.relationships[0].sharedEntities, []);
  assert.deepEqual(fileOnly.relationships[0].sharedConfigKeys, []);

  const entityOnly = computeCrossFeatureRelationships([
    feature("a", "A", ["src/a.ts"], [{ category: "entities", name: "User", filePath: "src/user.ts", line: 3 }]),
    feature("b", "B", ["src/b.ts"], [{ category: "entities", name: "User", filePath: "src/user.ts", line: 3 }])
  ]);
  assert.equal(entityOnly.relationships.length, 1);
  assert.deepEqual(entityOnly.relationships[0].sharedEntities, [{ name: "User", filePath: "src/user.ts", line: 3 }]);

  const configOnly = computeCrossFeatureRelationships([
    feature("a", "A", ["src/a.ts"], [{ category: "config-keys", name: "API_KEY" }]),
    feature("b", "B", ["src/b.ts"], [{ category: "config-keys", name: "API_KEY" }])
  ]);
  assert.equal(configOnly.relationships.length, 1);
  assert.deepEqual(configOnly.relationships[0].sharedConfigKeys, ["API_KEY"]);
});

test("features that share nothing emit no pair", () => {
  const result = computeCrossFeatureRelationships([
    feature("a", "A", ["src/a.ts"], [{ category: "entities", name: "Order", filePath: "src/a.ts", line: 1 }, { category: "config-keys", name: "A" }]),
    feature("b", "B", ["src/b.ts"], [{ category: "entities", name: "Invoice", filePath: "src/b.ts", line: 1 }, { category: "config-keys", name: "B" }])
  ]);
  assert.deepEqual(result.relationships, []);
});

test("an entity with the same name but a different location is not shared, while a config key is shared by name only", () => {
  const result = computeCrossFeatureRelationships([
    feature("a", "A", [], [
      { category: "entities", name: "Order", filePath: "src/a/order.ts", line: 1 },
      { category: "config-keys", name: "PORT", filePath: "src/a/config.ts", line: 2 }
    ]),
    feature("b", "B", [], [
      { category: "entities", name: "Order", filePath: "src/b/order.ts", line: 9 },
      { category: "config-keys", name: "PORT", filePath: "src/b/config.ts", line: 4 }
    ])
  ]);
  assert.equal(result.relationships.length, 1, "the config key alone relates them");
  assert.deepEqual(result.relationships[0].sharedEntities, [], "same entity name at different locations is not the same entity");
  assert.deepEqual(result.relationships[0].sharedConfigKeys, ["PORT"], "a config key is keyed by name regardless of location");
});

test("entities without a location fall back to matching on name", () => {
  const result = computeCrossFeatureRelationships([
    feature("a", "A", [], [{ category: "entities", name: "Session" }]),
    feature("b", "B", [], [{ category: "entities", name: "Session" }])
  ]);
  assert.equal(result.relationships.length, 1);
  assert.deepEqual(result.relationships[0].sharedEntities, [{ name: "Session" }]);
});

test("output is deterministic and stable regardless of input feature order", () => {
  const forward = computeCrossFeatureRelationships(threeServices());
  const reversed = computeCrossFeatureRelationships([...threeServices()].reverse());
  assert.deepEqual(reversed, forward, "reordering the input must not change the output");

  const many = computeCrossFeatureRelationships([
    feature("f3", "F3", ["src/shared.ts"], []),
    feature("f1", "F1", ["src/shared.ts"], []),
    feature("f2", "F2", ["src/shared.ts"], [])
  ]);
  assert.deepEqual(
    many.relationships.map((rel) => [rel.featureA, rel.featureB]),
    [["f1", "f2"], ["f1", "f3"], ["f2", "f3"]],
    "pairs are ordered by key with the smaller key first"
  );
});

test("the notes always state the cross-module edge honesty limit and the deferred graph edges", () => {
  const result = computeCrossFeatureRelationships([]);
  assert.deepEqual(result.relationships, []);
  assert.ok(result.notes.some((note) => /cross-module/i.test(note) && /shared files, entities and config keys/i.test(note)));
  assert.ok(result.notes.some((note) => /edge relationships are deferred/i.test(note)));
});

test("the markdown section carries the matrix, the per-pair detail and the notes", () => {
  const markdown = renderCrossFeatureSection(computeCrossFeatureRelationships(threeServices()));
  assert.match(markdown, /## Cross-feature relationships/);
  assert.match(markdown, /\| Feature A \| Feature B \| Shared files \| Shared entities \| Shared config keys \|/);
  assert.match(markdown, /\| Service A \| Service B \| 1 \| 1 \| 1 \|/);
  assert.match(markdown, /### Service A ↔ Service B/);
  assert.match(markdown, /`src\/shared\.ts`/);
  assert.match(markdown, /`Order \(src\/order\.ts:1\)`/);
  assert.match(markdown, /`DB_URL`/);
  assert.match(markdown, /cross-module/i);
  assert.doesNotMatch(markdown, /A_ONLY/, "an unshared key never reaches the section");
});

test("the markdown section states honestly when no pair shares anything", () => {
  const markdown = renderCrossFeatureSection(computeCrossFeatureRelationships([
    feature("a", "A", ["src/a.ts"], []),
    feature("b", "B", ["src/b.ts"], [])
  ]));
  assert.match(markdown, /## Cross-feature relationships/);
  assert.match(markdown, /No pair of prepared features shares a file, entity or config key\./);
  assert.match(markdown, /cross-module/i);
});

test("a prepare with two or more features writes context/cross-feature.json and a shared-context section", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const { runDir } = await prepareRun({
    target,
    codegraphMode: "off",
    language: "en-US",
    detailLevel: "standard",
    workdir,
    overviewAudiences: ["engineering"],
    features: [
      { subject: "Leave requests", aliases: ["leave"], audiences: ["engineering"] },
      { subject: "Manager access", aliases: ["requireManager", "manager"], audiences: ["engineering"] }
    ],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 10, maxSourceWindows: 60, maxSourceCharacters: 160_000, maxFiles: 10_000, maxFeatureNodes: 60, maxExpansionDepth: 2 }
  });

  const artifact = JSON.parse(await readFile(join(runDir, "context", "cross-feature.json"), "utf8")) as CrossFeatureRelationships;
  assert.equal(artifact.version, "cross-feature-v1");
  assert.ok(Array.isArray(artifact.relationships));
  assert.ok(artifact.notes.some((note) => /cross-module/i.test(note)));
  for (const relationship of artifact.relationships) {
    assert.ok(relationship.featureA < relationship.featureB, "pairs keep the smaller key first");
  }

  const shared = await readFile(join(runDir, "context", "shared.md"), "utf8");
  assert.match(shared, /## Cross-feature relationships/);
});

test("a single-feature run writes no cross-feature artifact and no shared-context section", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const { runDir } = await prepareRun({
    target,
    codegraphMode: "off",
    language: "en-US",
    detailLevel: "standard",
    workdir,
    overviewAudiences: [],
    features: [{ subject: "Leave requests", aliases: ["leave"], audiences: ["engineering"] }],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 10, maxSourceWindows: 60, maxSourceCharacters: 160_000, maxFiles: 10_000, maxFeatureNodes: 60, maxExpansionDepth: 2 }
  });

  await assert.rejects(readFile(join(runDir, "context", "cross-feature.json"), "utf8"), "single-feature runs skip the artifact");
  const shared = await readFile(join(runDir, "context", "shared.md"), "utf8");
  assert.doesNotMatch(shared, /## Cross-feature relationships/);
});
