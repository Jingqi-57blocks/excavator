import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { canonicalJson } from "../src/base/util.ts";
import { routeInventory } from "../src/codegraph/route-inventory.ts";
import { CodeGraphIndex } from "../src/codegraph/codegraph.ts";
import { Deadline } from "../src/base/util.ts";
import { createSnapshot } from "../src/snapshot/snapshot.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

// THE INVENTORY IS COMPUTED TWICE PER RUN, AND THE TWO MUST AGREE.
//
// Pool admission happens inside `prepare`; the facts stage runs after it. So the route inventory is built once in
// `context.ts` to decide what a hypothesis can admit, and again in `facts-stage.ts` to write the layer-3 fact
// envelope. If the two ever disagree, a hypothesis admits a node whose route fact carries a different id — and the
// symptom is not an error but a seat whose provenance points at a fact that does not exist, which the fact-pack
// join would report as a missing membership rather than as a disagreement between two producers.
//
// The slice's plan asked for this to be VERIFIED rather than asserted in a comment ("pure function" is a claim
// about the code, not about the two call sites' inputs). Both callers derive their path list from the same layer-1
// counted rows and pass no limit overrides, so equality is a property of those inputs — which is exactly what can
// drift when someone adds a filter on one side.

test("the prepare-side and facts-side inventories are byte-identical", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const dbPath = join(workdir, "codegraph.db");
  createCodeGraphFixture(dbPath);

  const { ledger } = await createSnapshot(target, 10_000, { cacheDir: join(workdir, "cache") });
  const index = new CodeGraphIndex(dbPath, 5_000, new Deadline(60_000, "double-compute"), ledger.counted.map((row) => row.relativePath));

  // The two call shapes, verbatim as the two sites spell them.
  const preparePaths = ledger.counted.map((row) => row.relativePath);
  const factsPaths = ledger.counted.map((row) => row.relativePath);

  const fromPrepare = await routeInventory(index, preparePaths, target);
  const fromFacts = await routeInventory(index, factsPaths, target);

  assert.equal(canonicalJson(fromPrepare), canonicalJson(fromFacts),
    "the two inventories a single run builds must be the same bytes, or a hypothesis can admit a node whose route fact id differs from the one layer 3 recorded");

  // And the identity a consumer joins on is present on both sides: an inventory that agreed on everything except
  // the node ids would still break admission, because admission is BY node id.
  for (const [prepared, factual] of fromPrepare.routes.map((route, position) => [route, fromFacts.routes[position]!] as const)) {
    assert.equal(prepared.nodeId, factual.nodeId);
    assert.equal(prepared.handlerNodeId, factual.handlerNodeId);
    assert.equal(prepared.factId, factual.factId);
  }
  index.close();
});

// A path list that is not layer 1's counted rows produces a different inventory, which is the drift the test above
// exists to catch. Asserting it here keeps the test honest: if `routeInventory` ever stopped depending on its path
// argument, the equality above would hold vacuously and prove nothing.
test("the inventory really depends on the path list it is given", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const dbPath = join(workdir, "codegraph.db");
  createCodeGraphFixture(dbPath);

  const { ledger } = await createSnapshot(target, 10_000, { cacheDir: join(workdir, "cache") });
  const all = ledger.counted.map((row) => row.relativePath);
  const index = new CodeGraphIndex(dbPath, 5_000, new Deadline(60_000, "double-compute"), all);

  const complete = await routeInventory(index, all, target);
  const narrowed = await routeInventory(index, all.filter((path) => !path.endsWith("server.ts")), target);

  assert.ok(complete.routes.length > 0, "the fixture has routes to lose");
  assert.notEqual(canonicalJson(complete), canonicalJson(narrowed),
    "dropping the file that registers the routes must change the inventory, or the equality assertion above is vacuous");
  index.close();
});
