import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportRequest } from "../src/base/types.ts";
import type { AttributionArtifact, AttributionSelection } from "../src/attribution/attribution-artifact.ts";
import { canonicalJson } from "../src/base/util.ts";
import { prepareRun } from "../src/run/run.ts";
import { assertCorpusSealed, materializeCorpus, type CorpusPin } from "./intent-baseline/corpus.ts";
import { diffBaseline, renderDiff } from "./intent-baseline/compare.ts";
import { projectBaseline } from "./intent-baseline/projection.ts";

/**
 * The pinned-intent baseline, run against a frozen corpus.
 *
 * Opt-in because it needs a local clone of the target; everything that can be asserted without one lives in
 * `tests/intent-baseline.test.ts` and runs unconditionally. Beyond the missing-source case, EVERY failure here
 * is fatal: a baseline harness that skips a root, falls back to the working tree, or writes a passing result it
 * could not verify is reporting a clean comparison over bytes nobody chose.
 */

const FIXTURES = join(import.meta.dirname, "intent-baseline", "fixtures");
const EXPECTED = join(import.meta.dirname, "intent-baseline", "expected");
const WRITE = process.argv.includes("--write-baseline");

interface Fixture {
  corpus: CorpusPin;
  language: string;
  codegraphMode: "auto" | "off";
  budgets: ReportRequest["budgets"];
  features: Array<{ subject: string; aliases: string[] }>;
  arm?: "no-graph";
  anchors: Array<{ routeFactId: string; handlerCell: string; handlerName: string; module: string }>;
  moduleClasses: {
    hold: Array<{ module: string; why: string }>;
    stayEmpty: Array<{ module: string; why: string; poolNodes: { full: number; ablated: number } }>;
    notPinned: Record<string, string>;
  };
}

function moduleRow(selection: AttributionSelection, dir: string): AttributionSelection["modules"][number] {
  const row = selection.modules.find((module) => module.dir === dir);
  assert.ok(row, `module ${dir} has no census row; the module inventory moved and the classification is stale`);
  return row;
}

/** Every cell this arm placed anywhere — seated or displaced. "Out of the selection" means in neither. */
function placedCells(selection: AttributionSelection): Set<string> {
  return new Set([...selection.seats.map((seat) => seat.unitId), ...selection.displacements.map((row) => row.unitId)]);
}

async function runFixture(name: string): Promise<void> {
  const fixture = JSON.parse(await readFile(join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
  // Stable per-fixture path, not a fresh mkdtemp: `materializeCorpus` reuses an intact corpus, and a new
  // directory every run would rebuild every navigation index from scratch.
  const corpusDir = join(tmpdir(), `excavator-corpus-${name}`);
  await materializeCorpus(fixture.corpus, corpusDir, fixture.codegraphMode === "auto");

  const workdir = await mkdtemp(join(tmpdir(), `excavator-baseline-${name}-`));
  const { runDir } = await prepareRun({
    target: corpusDir,
    workdir,
    language: fixture.language,
    detailLevel: "standard",
    codegraphMode: fixture.codegraphMode,
    overviewAudiences: [],
    features: fixture.features.map((feature) => ({ ...feature, audiences: ["product"] as const })),
    budgets: fixture.budgets
  } as ReportRequest);

  const artifact = (JSON.parse(await readFile(join(runDir, "attribution", "attribution.json"), "utf8")) as { status: string; value: AttributionArtifact });
  assert.equal(artifact.status, "built", "a pinned corpus must produce a built attribution");
  const value = artifact.value;

  // Seal FIRST: every assertion below is about a selection over specific bytes, and is meaningless if the bytes
  // are not the pinned ones.
  assertCorpusSealed(fixture.corpus, value.identity.filesContentManifestDigest);

  // The no-graph arm asserts the SHAPE of unavailability instead of an ablation contrast: with no index there is
  // no pool to ablate, and what needs pinning is that "the producer was unavailable" stays distinguishable from
  // "the query matched nothing". Every later recall channel is measured against that distinction.
  if (fixture.arm === "no-graph") {
    for (const selection of value.selections) {
      assert.equal(selection.channels.status, "channel-unavailable", "the no-graph arm must report unavailability, not an empty run");
      assert.equal((selection.channels as { cause?: string }).cause, "no-graph");
      assert.deepEqual(selection.seats, [], "no graph, no seats");
      assert.deepEqual([...selection.seedCells], [], "no graph, no query seeds");
      assert.deepEqual(selection.displacements, [], "nothing can be displaced from an empty pool");
      for (const group of selection.zeroScore) {
        assert.equal(group.reason, "channels-unavailable",
          "every zero-score cell must say the channels were unavailable — `structure-unobserved` would blame the corpus for a missing tool");
      }
      for (const row of selection.conservation) {
        assert.equal(row.totals.seated, 0);
        assert.equal(row.totals.displaced, 0);
        assert.equal(row.totals.zeroScore, row.totals.counted, "with no channels the whole denominator is zero-score, and it still balances");
      }
    }
    await pinProjection(name, value);
    return;
  }

  const [full, ablated] = [...value.selections].sort((a, b) => a.featureKey.localeCompare(b.featureKey));
  assert.ok(full && ablated, "both arms ran");

  // --- structural invariants, re-checked on real data rather than trusted from unit fixtures ---------------
  for (const selection of [full, ablated]) {
    const seated = new Set(selection.seats.map((seat) => seat.unitId));
    for (const cell of selection.seedCells) assert.ok(seated.has(cell), `seedCell ${cell} holds no seat`);
    for (const row of selection.conservation) {
      assert.equal(row.totals.zeroScore, row.totals.counted - row.totals.seated - row.totals.displaced,
        `conservation does not balance for ${row.unitKind}`);
    }
  }

  const fullSel = full.featureKey.includes("消融") ? ablated : full;
  const ablSel = fullSel === full ? ablated : full;

  // --- LAYER B: the assertions S4 is measured against. Code, not JSON — `--write-baseline` cannot absorb them.
  const fullPlaced = placedCells(fullSel);

  // gold is real: every anchor IS placed under the full vocabulary. Without this the flip below would be
  // satisfied by an anchor that was never reachable at all, which measures nothing.
  for (const anchor of fixture.anchors) {
    assert.ok(fullPlaced.has(anchor.handlerCell),
      `anchor ${anchor.handlerName} is not selected under the full vocabulary; it is not a valid gold anchor`);
  }
  // FLIP SET — FLIPPED BY S4. These anchors were absent under the ablation because the vocabulary bridge was
  // removed; the route channel now reaches them from a stated hypothesis instead of from a word.
  //
  // "Placed" is not the assertion. The decisive channel must be `route`, and no lexical-family channel may be
  // claiming the seat: otherwise a re-rank that happens to reach the anchor would read as the structural channel
  // having worked, and the gap this slice exists to close would look closed while still being open.
  const ablSeatByCell = new Map(ablSel.seats.map((seat) => [seat.unitId, seat]));
  for (const anchor of fixture.anchors) {
    const seat = ablSeatByCell.get(anchor.handlerCell);
    assert.ok(seat, `anchor ${anchor.handlerName} is not seated under the ablation; the route channel did not recall it`);
    assert.equal(seat.channel, "route", `anchor ${anchor.handlerName} was seated by ${seat.channel}, not by the structural channel`);
    // The property is "no WORD claimed this seat", not "exactly one channel did". Written first as a list of
    // exclusions (`!== "route"`), which made the second structural channel read as contamination the moment S5
    // landed and crossrepo corroborated the same handlers. Naming the structural set states the intent instead:
    // two structural channels agreeing is evidence, and a lexical one appearing is the gap closing itself.
    const structural = new Set(["route", "crossrepo", "fallback"]);
    const lexicalFamily = seat.contributions.map((row) => row.sourceChannel).filter((channel) => !structural.has(channel));
    assert.deepEqual(lexicalFamily, [],
      `anchor ${anchor.handlerName} also carries ${lexicalFamily.join(", ")}; a word is claiming it, so it stops measuring the vocabulary gap`);
  }
  // SEED PURITY, ASSERTED AT THE WIRING. The unit tripwire covers the allocator's contract, but the corruption
  // this guards against lives one level up: `context.ts` could pass the recalled nodes as allocator `seeds`, and
  // every unit test would stay green while `seedCells` silently grew to include nodes the query never named —
  // which layer 5 would then publish as `seeded`, authorising reads nobody asked for.
  for (const anchor of fixture.anchors) {
    assert.ok(!ablSel.seedCells.includes(anchor.handlerCell),
      `anchor ${anchor.handlerName} appears in seedCells; it was recalled by a hypothesis, not named by the query, and layer 5 reads seedCells as the latter`);
  }

  // And the recall itself must be visible where a reader looks: the module that owns the anchors says so.
  for (const anchor of fixture.anchors) {
    assert.equal(moduleRow(ablSel, anchor.module).recall.route, "contributed",
      `${anchor.module} seats a route-recalled anchor but its receipt does not say the channel contributed`);
  }
  // HOLD and STAY-EMPTY are asserted on BOTH arms, because that is what the fixture claims about them and
  // because the full arm is where a noisy channel does its damage: S4 could push wcp-ui's four seats out, or
  // seat wcp-auth's /consent/approve, entirely within the full arm — the ablated-only version of these two
  // loops would stay green, and the byte difference would be absorbed by the S4 author's own `--write-baseline`.
  for (const [armName, selection] of [["full", fullSel], ["ablated", ablSel]] as const) {
    // HOLD SET — seated today, must STILL be seated after S4. S4 flips the flip set, never this one.
    for (const hold of fixture.moduleClasses.hold) {
      assert.equal(moduleRow(selection, hold.module).status, "seated",
        `hold-set module ${hold.module} lost its seats in the ${armName} arm`);
    }
    // STAY-EMPTY SET — empty today, must STAY empty. The false-positive tripwire: turning these green means the
    // new channel is admitting on the word rather than on the capability.
    //
    // ASSERTED ON THE THREE QUANTITIES, NOT ON `status`. This used to read `status === "zero-signal"`, which is
    // exactly `seated === 0 && poolNodes === 0 && denominatorCells > 0` (see the derivation in
    // attribution-artifact.ts). That single literal cannot describe wcp_review_service, which is `zero-signal`
    // under ablation but `candidates-no-seat` in the full arm — its one lexical hit enters the pool and loses
    // scoring. Both readings are zero seats, and the difference between them is not what this set is about.
    //
    // Naming the quantities directly is what the literal was standing in for, so nothing is given up: `poolNodes`
    // is declared PER ARM in the fixture and pinned exactly, which is strictly more than the literal could say —
    // it holds wcp_review_service to pool exactly 1 in the full arm, so a channel that widened its admission
    // there would go red even though its status literal would not move. The declaration is required rather than
    // optional: an optional expectation is one a future entry silently omits.
    for (const empty of fixture.moduleClasses.stayEmpty) {
      const row = moduleRow(selection, empty.module);
      assert.equal(row.seatedCells, 0,
        `stay-empty module ${empty.module} gained seats in the ${armName} arm`);
      assert.equal(row.poolNodes, empty.poolNodes[armName],
        `stay-empty module ${empty.module} changed its ${armName}-arm pool admission; the fixture declares ${empty.poolNodes[armName]} and this set's whole claim is about what is allowed in`);
      // The literal also carried `denominatorCells > 0`. Without it, a module that fell out of the denominator
      // entirely would satisfy every count above by vanishing rather than by staying empty.
      assert.ok(row.denominatorCells > 0,
        `stay-empty module ${empty.module} left the denominator in the ${armName} arm; zero seats then proves nothing`);
    }
  }

  await pinProjection(name, value, fixture.anchors.length);
}

/** Write or verify the byte baseline. Both arms end here; only the arm-specific assertions above differ. */
async function pinProjection(name: string, value: AttributionArtifact, anchors = 0): Promise<void> {
  const projection = projectBaseline(value);
  const expectedPath = join(EXPECTED, `${name}.projection.json`);
  if (WRITE) {
    await writeFile(expectedPath, `${JSON.stringify(projection, null, 2)}\n`);
    console.log(`wrote baseline: ${expectedPath}`);
    return;
  }
  const expected = JSON.parse(await readFile(expectedPath, "utf8"));
  const diffs = diffBaseline(expected, projection);
  assert.equal(diffs.length, 0, `the pinned selection moved:\n${renderDiff(diffs)}`);
  assert.equal(canonicalJson(expected), canonicalJson(projection));
  console.log(`${name}: ${anchors} anchors held, baseline byte-identical`);
}

const names = ["wcp-leave", "angels-pizza-nograph"];
for (const name of names) {
  const pin = JSON.parse(await readFile(join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
  if (!process.env[pin.corpus.sourceEnv]) {
    console.log(JSON.stringify({ skipped: true, reason: `Set ${pin.corpus.sourceEnv} to run the pinned-intent baseline.` }, null, 2));
    process.exit(0);
  }
}
for (const name of names) await runFixture(name);
