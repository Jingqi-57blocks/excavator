import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { factPackEvidence, renderFactPackSection, requireFactPackV2 } from "../src/workset/factpack-view.ts";
import { v2Pack } from "./factpack-v2-fixture.ts";

function mixedPack() {
  return v2Pack([
    { category: "logic", name: "SeededRule", filePath: "src/seed.ts", line: 1, signal: "seed", relation: { kind: "seeded", basis: "explicit-seed" } },
    { category: "logic", name: "RetainedRule", filePath: "src/retained.ts", line: 2, signal: "retained" },
    { category: "logic", name: "CoLocatedSecret", filePath: "src/colocated.ts", line: 3, signal: "must-not-leak", relation: { kind: "co-located", basis: "membership-not-seated" } },
    {
      category: "logic", name: "UnjoinedSecret", filePath: "src/unjoined.ts", line: 4,
      membership: { unjoined: { reason: "scan-only" } },
      relation: { kind: "co-located", basis: "scan-only" }
    },
    {
      category: "logic", name: "CorpusSecret", filePath: "src/corpus.ts", line: 5,
      membership: { joined: { factId: "term", kind: "term-df", membership: { kind: "corpus" } } },
      relation: { kind: "not-applicable", basis: "registry-not-applicable" }
    }
  ], { featureKey: "leave" });
}

test("the model view and FACT evidence expose only seeded and retained item content", () => {
  const pack = mixedPack();
  const markdown = renderFactPackSection(pack);
  const evidence = factPackEvidence(pack);
  const serializedEvidence = JSON.stringify(evidence);

  for (const visible of ["SeededRule", "RetainedRule"]) {
    assert.match(markdown, new RegExp(visible));
    assert.match(serializedEvidence, new RegExp(visible));
  }
  for (const hidden of ["CoLocatedSecret", "UnjoinedSecret", "CorpusSecret", "must-not-leak", "src/colocated.ts"]) {
    assert.doesNotMatch(markdown, new RegExp(hidden));
    assert.doesNotMatch(serializedEvidence, new RegExp(hidden));
  }
  const data = evidence[0]!.data as { machineItemCount: number; consumableItemCount: number; items: unknown[]; relationCounts: Record<string, number> };
  assert.equal(data.machineItemCount, 5, "audit counts preserve the complete machine denominator");
  assert.equal(data.consumableItemCount, 2);
  assert.equal(data.items.length, 2);
  assert.deepEqual(data.relationCounts, { seeded: 1, retained: 1, coLocated: 2, notApplicable: 1 });
});

test("production readers reject legacy v1 and malformed or unreconciled v2 packs", () => {
  assert.throws(() => requireFactPackV2({ version: "factpack-v1", items: [], coverage: [] }, "legacy"), /invalidates legacy factpack-v1 runs.*prepare again/);
  const valid = mixedPack();
  assert.doesNotThrow(() => requireFactPackV2(valid));
  assert.throws(() => requireFactPackV2({ ...valid, relations: { ...valid.relations, total: 99 } }), /does not reconcile/);
  assert.throws(() => requireFactPackV2({ ...valid, relations: { ...valid.relations, byBasis: {} } }), /relation basis summary does not reconcile/);
  assert.throws(() => requireFactPackV2({ ...valid, coverage: [{ ...valid.coverage[0]!, itemCount: 4 }] }), /coverage category .* counts 4 items but contains 5/);
  const missingAnnotation = { ...valid, items: [{ category: "logic", name: "x", filePath: "x", line: 1, source: "graph" }] };
  assert.throws(() => requireFactPackV2(missingAnnotation), /no declared granularity/);
  const emptyJoined = {
    ...valid,
    items: valid.items.map((item, index) => index === 0 ? { ...item, membership: { joined: {} } } : item)
  };
  assert.throws(() => requireFactPackV2(emptyJoined), /invalid joined fact id/);
  const compressedRelation = {
    ...valid,
    items: valid.items.map((item, index) => index === 0 ? {
      ...item,
      membership: {
        joined: {
          factId: "link-1",
          kind: "http-link",
          membership: { kind: "relation", unitId: "cell-a" }
        }
      }
    } : item)
  };
  assert.throws(() => requireFactPackV2(compressedRelation), /relation arm requires non-empty endpoints/);
  const hiddenNotApplicable = {
    ...valid,
    items: valid.items.map((item) => item.name === "CorpusSecret" ? {
      ...item,
      relation: { kind: "co-located", basis: "membership-not-seated" }
    } : item),
    relations: {
      ...valid.relations,
      coLocated: valid.relations.coLocated + 1,
      notApplicable: valid.relations.notApplicable - 1,
      byBasis: { ...valid.relations.byBasis, "membership-not-seated": 3, "registry-not-applicable": 0 }
    }
  };
  assert.throws(() => requireFactPackV2(hiddenNotApplicable), /hides a registry-not-applicable membership/);
});

test("every automatic fact-pack consumer imports the single consumable-row gate", async () => {
  for (const file of [
    "src/assurance/authoring-packet.ts",
    "src/assurance/logic-workitems.ts",
    "src/assurance/read-obligations.ts",
    "src/context/cross-feature.ts"
  ]) {
    const source = await readFile(file, "utf8");
    assert.match(source, /consumableFactPackItems/, `${file} must consume the layer-5 view instead of raw machine rows`);
  }
});
