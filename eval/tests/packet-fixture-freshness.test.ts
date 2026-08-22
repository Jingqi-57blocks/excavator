// Are the checked-in packet fixtures still what the CURRENT renderer produces?
//
// This exists because of a blind spot the packet-readings tests cannot cover. Those tests assert byte numbers
// over frozen fixture bytes. `eval/packet-readings.ts` mirrors exactly one renderer predicate — "a block renders
// a fact category iff one of its work items maps to it" — and if the renderer's SELECTION logic changes, the
// mirror and the renderer disagree while both still agree with the frozen packet, so nothing goes red. Measured:
// a `.filter(...)` dropped into `renderFacts`'s category selection leaves packet-readings.test.ts fully green.
//
// The rot happens between the renderer and the mirror, so the assertion has to sit there: re-render each fixture
// packet from that fixture's own artifacts with the real `buildAuthoringPacket` and compare bytes. A renderer
// change now either updates the fixtures deliberately or turns this red.
//
// Scope, stated plainly: this covers the FIXTURES, not real runs. A fixture packet was rendered with no condition
// inventory and no reading-boundary input, so re-rendering it needs only run.json / workitems.json /
// evidence.json / traces.json / the fact pack, all of which are on disk. When these fixtures were captured, a real
// run's packet also depended on the condition inventory and on the reading-boundary input, whose `annotated` flag
// freeze passed from memory without persisting it — so the same check could not be run against a real run directory
// without recovering that flag. 57B-480 retired the freeze-time write entirely, so there is no longer a real run to
// compare against at all: these fixtures ARE the corpus, and this test pins the renderer against them. The guard
// below refuses to pretend otherwise: if a fixture ever grows a condition inventory, this test fails rather than
// silently re-rendering with the wrong arguments.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocumentPlan, EvidenceItem, FeatureFactPack, InvestigationPlan, RunManifest, TraceCatalog } from "../../src/base/types.ts";
import { buildAuthoringPacket, featureKeyOf } from "../../src/report/authoring-packet.ts";
import { requireFactPackV2 } from "../../src/workset/factpack-view.ts";

const FIXTURES = ["packet-twin-overviews", "packet-feature-blocks", "packet-feature-factpack"];

function read<T>(dir: string, rel: string): T {
  const path = join(dir, rel);
  assert.ok(existsSync(path), `${rel} must exist in ${dir}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

test("every checked-in fixture packet is byte-identical to what the current renderer produces", () => {
  for (const name of FIXTURES) {
    const dir = join(import.meta.dirname, "fixtures", name);
    const manifest = read<RunManifest>(dir, "run.json");
    const plan = read<InvestigationPlan>(dir, "workitems.json");
    const catalog = read<{ evidence: EvidenceItem[] }>(dir, "evidence.json");
    const traces = read<TraceCatalog>(dir, "traces.json");
    const evidenceById = new Map(catalog.evidence.map((item) => [item.id, item]));

    // The two optional inputs these fixtures were rendered without. If one ever appears, the re-render below
    // would be comparing against a packet built from MORE than it passes, so refuse instead of passing wrongly.
    assert.equal(existsSync(join(dir, "coverage", "condition-inventory.json")), false,
      `${name} grew a condition inventory; the re-render must pass it to buildAuthoringPacket or this check is comparing the wrong bytes`);
    assert.equal(existsSync(join(dir, "coverage", "read-obligations.json")), false,
      `${name} grew read obligations; the re-render must pass the reading-boundary input or this check is comparing the wrong bytes`);

    const factPacks: Record<string, FeatureFactPack> = {};
    for (const document of manifest.documents) {
      if (document.kind !== "feature") continue;
      const key = featureKeyOf(document);
      const path = join(dir, "context", "features", `${key}.factpack.json`);
      if (!existsSync(path)) continue;
      const pack = JSON.parse(readFileSync(path, "utf8")) as unknown;
      requireFactPackV2(pack, `${name} ${key}.factpack.json`);
      factPacks[key] = pack;
    }

    assert.ok(manifest.documents.length > 0, `${name} must plan at least one document`);
    for (const document of manifest.documents as DocumentPlan[]) {
      const checkedIn = readFileSync(join(dir, "context", "authoring", `${document.id}.md`));
      const rendered = Buffer.from(buildAuthoringPacket(document, plan, evidenceById, traces, factPacks, undefined, undefined, manifest.knowledgeEpoch), "utf8");
      // Same-length divergence is the common case when a fixture is edited in place, and printing two identical
      // numbers sends the reader looking for a size difference that does not exist. Say which kind of difference
      // it is: measured on a same-length mutation injected into a checked-in packet, the old wording read
      // "produces 1198 bytes, the checked-in packet is 1198".
      const shape = rendered.length === checkedIn.length
        ? `the current renderer and the checked-in packet differ in CONTENT, not in length (both are ${rendered.length} bytes)`
        : `the current renderer produces ${rendered.length} bytes, the checked-in packet is ${checkedIn.length}`;
      assert.equal(rendered.equals(checkedIn), true,
        `${name}/${document.id}: ${shape}. `
        + "Re-generate the fixture packet and move the pinned digests and byte numbers in packet-readings.test.ts to the new output.\n"
        + `--- rendered ---\n${rendered.toString("utf8")}\n--- checked in ---\n${checkedIn.toString("utf8")}`);
    }
  }
});
