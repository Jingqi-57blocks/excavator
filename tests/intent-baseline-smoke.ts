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
    stayEmpty: Array<{ module: string; why: string }>;
    notPinned: Record<string, string>;
  };
}

function moduleRow(selection: AttributionSelection, dir: string): { status: string } {
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
  const ablPlaced = placedCells(ablSel);

  // gold is real: every anchor IS placed under the full vocabulary. Without this the flip below would be
  // satisfied by an anchor that was never reachable at all, which measures nothing.
  for (const anchor of fixture.anchors) {
    assert.ok(fullPlaced.has(anchor.handlerCell),
      `anchor ${anchor.handlerName} is not selected under the full vocabulary; it is not a valid gold anchor`);
  }
  // FLIP SET — absent today, and absent BECAUSE the vocabulary bridge was removed. S4's route channel must seat
  // these. Still passing after S4 means S4 did not do its job.
  for (const anchor of fixture.anchors) {
    assert.ok(!ablPlaced.has(anchor.handlerCell),
      `anchor ${anchor.handlerName} survived the ablation; expansion reached it, so it does not measure the lexical gap. `
      + `When S4 flips this, do not stop at "it is placed": assert the seat's channel is "route", or a lexical `
      + `re-rank that happens to reach the anchor would read as the structural channel having worked.`);
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
    // STAY-EMPTY SET — empty today, must STAY empty after S4. The false-positive tripwire: turning these green
    // means the new channel is admitting on the word rather than on the capability.
    for (const empty of fixture.moduleClasses.stayEmpty) {
      assert.equal(moduleRow(selection, empty.module).status, "zero-signal",
        `stay-empty module ${empty.module} gained signal in the ${armName} arm`);
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
