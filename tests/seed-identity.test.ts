import test from "node:test";
import assert from "node:assert/strict";
import { built, unavailable } from "../src/base/artifact-result.ts";
import { seedCellsByFeature } from "../src/attribution/seed-identity.ts";
import type { AttributionArtifact } from "../src/attribution/attribution-artifact.ts";

// THE L4 -> L5 SEED JOIN, AND ITS TOTALITY.
//
// `workset-stage.ts` throws when a requested feature key has no seed set, and that throw is a live tripwire for
// "a feature silently lost its working set". This function is what feeds it, so the property that matters is
// not "the right cells come through" alone — it is that EVERY requested key gets an entry on every path,
// including the ones where attribution has nothing to say. A short map turns a meaningful throw into an
// unrelated crash; a missing key lets a feature vanish.

function artifactWith(selections: Array<{ featureKey: string; seedCells: string[] }>): AttributionArtifact {
  return { selections: selections.map((row) => ({ ...row })) } as unknown as AttributionArtifact;
}

test("built attribution hands each feature the cells layer 4 published", () => {
  const result = seedCellsByFeature(
    built(artifactWith([
      { featureKey: "leave", seedCells: ["cell:structure:0-10:a.ts", "cell:structure:11-20:b.ts"] },
      { featureKey: "billing", seedCells: [] }
    ])),
    ["leave", "billing"]
  );
  assert.deepEqual([...result.get("leave")!].sort(), ["cell:structure:0-10:a.ts", "cell:structure:11-20:b.ts"]);
  assert.equal(result.get("billing")!.size, 0, "a feature that seated no query seed gets an empty set, not an absence");
});

test("an unavailable attribution still yields an explicit empty set for every requested key", () => {
  const result = seedCellsByFeature(unavailable("no partition to seat anything in", false), ["leave", "billing"]);
  assert.deepEqual([...result.keys()].sort(), ["billing", "leave"], "every requested key is present");
  for (const key of ["leave", "billing"]) {
    assert.equal(result.get(key)!.size, 0, `${key} gets a written empty set rather than nothing`);
  }
});

test("a key attribution never mentioned is still present, and a key nobody requested is not invented", () => {
  const result = seedCellsByFeature(
    built(artifactWith([{ featureKey: "leave", seedCells: ["cell:structure:0-10:a.ts"] }])),
    ["leave", "never-selected"]
  );
  assert.equal(result.get("never-selected")!.size, 0, "requested but unselected: empty set, key present");
  assert.deepEqual([...result.keys()].sort(), ["leave", "never-selected"], "the requested set decides the keys, not the artifact");
});
