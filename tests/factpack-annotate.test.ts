import test from "node:test";
import assert from "node:assert/strict";
import { built, unavailable, type ArtifactResult } from "../src/base/artifact-result.ts";
import type { CollectedFeatureFactPack } from "../src/base/types.ts";
import type { AttributionArtifact } from "../src/attribution/attribution-artifact.ts";
import type { ProducerFactRow, ProducerFactSet } from "../src/facts/envelope.ts";
import type { UnitsArtifact } from "../src/facts/units/units-artifact.ts";
import { unitsContentDigest } from "../src/facts/units/units-artifact.ts";
import { annotateFactPack } from "../src/workset/factpack-annotate.ts";
import { stableJson } from "../src/base/util.ts";

const FEATURE = "leave";

function units(...ids: string[]): UnitsArtifact {
  return {
    version: "units-v1",
    identity: { test: "identity" },
    bounds: {},
    partition: ids.map((unitId, index) => ({
      unitId,
      relativePath: `src/${unitId}.ts`,
      rootName: index === 2 ? "service-b" : "service-a",
      partitionKind: "structure",
      unitKind: "function",
      span: { byteStart: index * 10, byteEnd: index * 10 + 9, startLine: 1, endLine: 1 }
    })),
    refUnits: [], files: [], completeness: {}, inheritedCompleteness: {}, byLanguage: [], observations: {}
  } as unknown as UnitsArtifact;
}

function attribution(unitsValue: UnitsArtifact, seats: string[], featureKey = FEATURE): ArtifactResult<AttributionArtifact> {
  return built({
    version: "attribution-v2",
    identity: { unitsContentDigest: unitsContentDigest(unitsValue) },
    selections: [{ featureKey, seats: seats.map((unitId) => ({ unitId })), channels: { status: "ran" } }]
  } as unknown as AttributionArtifact);
}

function producer(unitsValue: UnitsArtifact, name: string, facts: ProducerFactRow[]): ArtifactResult<ProducerFactSet> {
  return built({
    version: "producer-envelope-v1",
    producer: name,
    identity: { producer: name, unitsContentDigest: unitsContentDigest(unitsValue) },
    facts
  } as unknown as ProducerFactSet);
}

function fact(factId: string, kind: ProducerFactRow["kind"], membership: ProducerFactRow["membership"]): ProducerFactRow {
  return { factId, kind, membership, detail: {} };
}

function pack(items: CollectedFeatureFactPack["items"]): CollectedFeatureFactPack {
  return {
    version: "factpack-collected-v1",
    snapshotId: "snap",
    featureKey: FEATURE,
    items,
    coverage: [{ category: "logic", method: "graph+scan", itemCount: items.length, truncated: false }],
    warnings: []
  };
}

function graphItem(name: string, producerName: string, factId: string): CollectedFeatureFactPack["items"][number] {
  return {
    category: "logic", name, filePath: `src/${name}.ts`, line: 1, source: "graph",
    granularity: "graph-node", join: { kind: "fact", producer: producerName, factId }
  };
}

test("layer 5 preserves the denominator and assigns exactly one membership and relation to every row", () => {
  const unitsValue = units("cell-a", "cell-b", "cell-c");
  const inputPack = pack([
    graphItem("retained", "codegraph", "f-a"),
    graphItem("seeded", "codegraph", "f-b"),
    graphItem("relation", "crossrepo", "link-1"),
    graphItem("corpus", "vocabulary", "term-1"),
    { category: "logic", name: "scan", filePath: "src/scan.ts", line: 2, source: "scan", granularity: "source-line", join: { kind: "unjoined", reason: "scan-only" } },
    graphItem("missing-envelope", "ast", "ast-1")
  ]);
  const result = annotateFactPack({
    pack: inputPack,
    units: built(unitsValue),
    attribution: attribution(unitsValue, ["cell-a", "cell-c"]),
    producers: {
      codegraph: producer(unitsValue, "codegraph", [
        fact("f-a", "indexed-function", { kind: "unit", unitId: "cell-a" }),
        fact("f-b", "indexed-function", { kind: "unit", unitId: "cell-b" })
      ]),
      crossrepo: producer(unitsValue, "crossrepo", [fact("link-1", "http-link", { kind: "relation", endpoints: ["cell-a", "cell-c"] })]),
      vocabulary: producer(unitsValue, "vocabulary", [fact("term-1", "term-df", { kind: "corpus" })]),
      ast: unavailable("not produced")
    },
    seedCells: new Set(["cell-b"])
  });

  assert.equal(result.version, "factpack-v2");
  assert.equal(result.items.length, inputPack.items.length, "annotation must never narrow the machine denominator");
  assert.deepEqual(result.items.map((item) => item.name), inputPack.items.map((item) => item.name), "order is unchanged");
  assert.deepEqual(result.items.map((item) => item.relation.kind), ["retained", "seeded", "retained", "not-applicable", "co-located", "co-located"]);
  assert.deepEqual(result.items[2]!.membership, {
    joined: { factId: "link-1", kind: "http-link", membership: { kind: "relation", endpoints: ["cell-a", "cell-c"] } }
  }, "relation membership is transcribed verbatim and any seated endpoint retains it");
  assert.deepEqual(result.items[4]!.membership, { unjoined: { reason: "scan-only" } });
  assert.deepEqual(result.items[5]!.membership, { unjoined: { reason: "envelope-unavailable" } });
  assert.deepEqual(result.relations, {
    total: 6, seeded: 1, retained: 2, coLocated: 2, notApplicable: 1,
    byBasis: { "envelope-unavailable": 1, "explicit-seed": 1, "membership-seated": 2, "registry-not-applicable": 1, "scan-only": 1 }
  });
});

test("the same layer-3 and layer-4 inputs produce byte-identical v2 packs", () => {
  const unitsValue = units("cell-a");
  const input = {
    pack: pack([graphItem("f", "codegraph", "function:x")]),
    units: built(unitsValue),
    attribution: attribution(unitsValue, ["cell-a"]),
    producers: { codegraph: producer(unitsValue, "codegraph", [fact("function:x#2", "indexed-function", { kind: "unit", unitId: "cell-a" })]) },
    seedCells: new Set<string>()
  };
  assert.equal(stableJson(annotateFactPack(input)), stableJson(annotateFactPack(input)));
  assert.equal(annotateFactPack(input).items[0]!.membership.joined?.factId, "function:x#2", "the CodeGraph base-id join preserves the producer's published fact id");
});

test("an indexed route is retained through its own fact and the handler cell it belongs to", () => {
  const unitsValue = units("handler-cell");
  const route = graphItem("POST /v2/leaves", "codegraph", "route:routes.go:12-12:POST /v2/leaves");
  const result = annotateFactPack({
    pack: pack([route]),
    units: built(unitsValue),
    attribution: attribution(unitsValue, ["handler-cell"]),
    producers: {
      codegraph: producer(unitsValue, "codegraph", [
        fact("route:routes.go:12-12:POST /v2/leaves", "indexed-route", { kind: "unit", unitId: "handler-cell" })
      ])
    },
    seedCells: new Set()
  });
  assert.deepEqual(result.items[0]!.membership, {
    joined: {
      factId: "route:routes.go:12-12:POST /v2/leaves",
      kind: "indexed-route",
      membership: { kind: "unit", unitId: "handler-cell" }
    }
  });
  assert.deepEqual(result.items[0]!.relation, { kind: "retained", basis: "membership-seated" });
});

test("a join miss is written as co-located instead of dropping the row", () => {
  const unitsValue = units("cell-a");
  const result = annotateFactPack({
    pack: pack([graphItem("missing", "codegraph", "missing-id")]),
    units: built(unitsValue),
    attribution: attribution(unitsValue, ["cell-a"]),
    producers: { codegraph: producer(unitsValue, "codegraph", []) },
    seedCells: new Set()
  });
  assert.deepEqual(result.items[0]!.membership, { unjoined: { reason: "no-matching-fact" } });
  assert.deepEqual(result.items[0]!.relation, { kind: "co-located", basis: "no-matching-fact" });
});

test("a written attribution channel failure is transcribed into the fact-pack view", () => {
  const unitsValue = units("cell-a");
  const unavailableChannels = built({
    version: "attribution-v2",
    identity: { unitsContentDigest: unitsContentDigest(unitsValue) },
    selections: [{
      featureKey: FEATURE,
      seats: [],
      channels: { status: "channel-unavailable", cause: "no-graph" }
    }]
  } as unknown as AttributionArtifact);
  const result = annotateFactPack({
    pack: pack([graphItem("f", "codegraph", "f")]),
    units: built(unitsValue),
    attribution: unavailableChannels,
    producers: { codegraph: producer(unitsValue, "codegraph", [fact("f", "indexed-function", { kind: "unit", unitId: "cell-a" })]) },
    seedCells: new Set()
  });
  assert.equal(result.items[0]!.relation.kind, "co-located");
  assert.deepEqual(result.warnings, [
    "Attribution channels unavailable for leave: no-graph; no fact-pack item can be retained by a seat."
  ]);
});

test("annotation fails closed on stale generations, dangling memberships, illegal shapes and invalid seeds", () => {
  const unitsValue = units("cell-a");
  const base = {
    pack: pack([graphItem("f", "codegraph", "f")]),
    units: built(unitsValue),
    attribution: attribution(unitsValue, ["cell-a"]),
    producers: { codegraph: producer(unitsValue, "codegraph", [fact("f", "indexed-function", { kind: "unit", unitId: "cell-a" })]) },
    seedCells: new Set<string>()
  };

  assert.equal(base.attribution.status, "built");
  if (base.attribution.status !== "built") throw new Error("test setup expected built attribution");
  const staleAttribution = built({ ...base.attribution.value, identity: { ...base.attribution.value.identity, unitsContentDigest: "stale" } });
  assert.throws(() => annotateFactPack({ ...base, attribution: staleAttribution }), /names units generation .* but layer 5 received/);
  const dangling = { codegraph: producer(unitsValue, "codegraph", [fact("f", "indexed-function", { kind: "unit", unitId: "absent" })]) };
  assert.throws(() => annotateFactPack({ ...base, producers: dangling }), /not a partition cell/);
  const illegal = { codegraph: producer(unitsValue, "codegraph", [fact("f", "indexed-function", { kind: "relation", endpoints: ["cell-a"] })]) };
  assert.throws(() => annotateFactPack({ ...base, producers: illegal }), /declares "unit" membership/);
  assert.throws(() => annotateFactPack({ ...base, seedCells: new Set(["absent"]) }), /not a partition cell/);
  assert.throws(() => annotateFactPack({ ...base, attribution: attribution(unitsValue, ["cell-a"], "other") }), /exactly one attribution selection/);
});
