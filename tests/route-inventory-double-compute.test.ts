import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inventoryPathsOf } from "../src/codegraph/route-inventory.ts";
import { prepareRun } from "../src/run/run.ts";
import type { ReportRequest } from "../src/base/types.ts";
import type { ProducerFactSet } from "../src/facts/envelope.ts";
import type { ArtifactResult } from "../src/base/artifact-result.ts";
import type { AttributionArtifact } from "../src/attribution/attribution-artifact.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

// THE INVENTORY IS BUILT TWICE PER RUN, AND THE TWO MUST DESCRIBE THE SAME ROUTES.
//
// Pool admission happens inside `prepare`; the facts stage runs after it and writes the layer-3 envelope. So a
// route the prepare side admitted must be a route the envelope records — otherwise a seat's provenance points at a
// fact that does not exist, and the fact-pack join reports a missing membership, blamed on the wrong producer with
// nothing red at commit time.
//
// AN EARLIER VERSION OF THIS FILE DID NOT TEST THAT. It re-wrote both call shapes locally and compared them, which
// verifies that a pure function is deterministic — something never in doubt. Its own comment named the drift vector
// it could not see: "someone adds a filter on one side". A `.filter(...)` in `facts-stage.ts` would have left it
// green. The fix was structural first — both sites now take their path list from `inventoryPathsOf`, so there is no
// second list to compose — and the assertion below is bound to the real artifacts of a real run rather than to a
// re-enactment of them.

const BUDGETS = { prepareMs: 60_000, authorMs: 60_000, maxGraphQueries: 60, maxSourceWindows: 40, maxSourceCharacters: 150_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

test("every route the prepare side matched exists as a fact in the envelope the facts side wrote", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);

  // The fixture registers `GET /leave` with `requireManager` and `listLeave`; the hypothesis names it by shape, so
  // the prepare-side inventory is genuinely consulted and genuinely matches.
  const { runDir } = await prepareRun({
    target, workdir, codegraph, language: "en-US", detailLevel: "standard",
    overviewAudiences: [],
    features: [{
      subject: "Leave management",
      aliases: ["leave", "manager"],
      audiences: ["product"],
      profile: { possibleEntrypoints: [{ method: "GET", pathPattern: "/leave", origin: "user" }] }
    }],
    budgets: BUDGETS
  } as ReportRequest);

  const attribution = JSON.parse(await readFile(join(runDir, "attribution", "attribution.json"), "utf8")) as { value: AttributionArtifact };
  const producer = JSON.parse(await readFile(join(runDir, "facts", "producers", "codegraph.json"), "utf8")) as ArtifactResult<ProducerFactSet>;
  assert.equal(producer.status, "built", "the facts stage wrote an envelope");
  if (producer.status !== "built") return;

  const envelopeRouteFactIds = new Set(producer.value.facts.filter((fact) => fact.kind === "indexed-route").map((fact) => fact.factId));
  assert.ok(envelopeRouteFactIds.size > 0, "the fixture has indexed routes, or this test proves nothing");

  const selection = attribution.value.selections[0]!;
  assert.equal(selection.channels.status, "ran");
  if (selection.channels.status !== "ran") return;
  const recall = selection.channels.recall.route;
  assert.equal(recall.status, "ran", "the hypothesis was carried into the run, so the channel ran");
  if (recall.status !== "ran") return;

  const matched = recall.hypotheses.flatMap((row): readonly string[] => row.matchedRouteFactIds);
  assert.ok(matched.length > 0,
    "the prepare-side inventory matched the hypothesis; a zero here means the two sides never met and the assertion below would be vacuous");

  // THE ASSERTION. Both sides are real: `matched` came from the inventory built during prepare, and
  // `envelopeRouteFactIds` from the one the facts stage wrote. A filter on either side breaks this.
  for (const factId of matched) {
    assert.ok(envelopeRouteFactIds.has(factId),
      `the prepare side matched route fact ${factId}, which the layer-3 envelope does not contain — the two inventories a single run built describe different routes`);
  }
});

// And the supplier really is the ledger's counted rows, so "both sides share it" means something specific.
test("the shared supplier returns the ledger's counted rows and nothing else", () => {
  const ledger = { counted: [{ relativePath: "b.ts" }, { relativePath: "a.ts" }] };
  assert.deepEqual(inventoryPathsOf(ledger), ["b.ts", "a.ts"],
    "order and content come from the ledger; the inventory sorts and de-duplicates internally, so neither caller may pre-shape the list");
});
