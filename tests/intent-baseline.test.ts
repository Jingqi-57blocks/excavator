import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ATTRIBUTION_ARTIFACT_VERSION } from "../src/attribution/attribution-artifact.ts";
import { CONTRIBUTION_CHANNELS, SELECTION_CHANNELS, SELECTION_TRACE_VERSION } from "../src/attribution/selection-trace.ts";
import { RUN_INTENT_VERSION } from "../src/contract/bound-run-contract.ts";
import { canonicalJson } from "../src/base/util.ts";
import { diffBaseline } from "./intent-baseline/compare.ts";
import { EXCLUDED, projectBaseline } from "./intent-baseline/projection.ts";

const FIXTURES = join(import.meta.dirname, "intent-baseline", "fixtures");

// THE S4 TRIPWIRE, IN THE UNCONDITIONAL SUITE.
//
// Everything else in this slice needs a target repository and only runs under `npm run test:intent-baseline`.
// This block does not, and that is the point: the author of S4 will be adding "route" to the channel set on
// some machine that may have no wcp checkout at all, and they must still be told that a pinned baseline exists
// and which polarities they are allowed to move.
//
// It asserts today's values, so it goes red the moment S4 lands — mechanically, without anyone remembering.
test("adding a recall channel forces the pinned baseline to be revisited", () => {
  assert.deepEqual([...CONTRIBUTION_CHANNELS], ["seed", "route", "crossrepo", "lexical", "derived", "relation", "convention", "fallback"],
    "The next channel goes here. You are its author: re-pin tests/intent-baseline/expected/ with "
    + "--write-baseline, and flip ONLY the flip-set assertions in tests/intent-baseline-smoke.ts. The hold-set and "
    + "stay-empty-set polarities are not yours to move — turning those green means the new channel is admitting "
    + "noise, not recalling. (S4 added \"route\" and S5 \"crossrepo\"; each flipped only its own flip set.)");
  assert.equal(ATTRIBUTION_ARTIFACT_VERSION, "attribution-v5", "the next channel bumps this; re-pin the baseline with it");
  assert.equal(SELECTION_TRACE_VERSION, "selection-trace-v5", "the next channel bumps this; re-pin the baseline with it");
});

// THE PINNED FILES MUST BE RE-PINNED, NOT JUST THE TEST ABOVE.
//
// Layer A forces the S4 author to open this file. It does not force them to re-measure `expected/`, and that gap
// is the whole difference between a tripwire and a note: change the channel list and the two version strings,
// `npm test` goes green again, and a baseline still claiming `attribution-v3` with no `route` channel merges to
// main. The next person with a corpus gets a five-thousand-line diff and blames their own change.
//
// So the pinned files are checked against the live constants, with no corpus required. `SELECTION_CHANNELS` and
// not `CONTRIBUTION_CHANNELS`: the artifact records the seventh, `displaced`, which is an outcome rather than a
// producer.
test("the pinned baselines were measured on the current artifact and channel versions", async () => {
  for (const name of ["wcp-leave", "angels-pizza-nograph"]) {
    const pinned = JSON.parse(await readFile(join(import.meta.dirname, "intent-baseline", "expected", `${name}.projection.json`), "utf8")) as {
      identity: { version: string; channels: string[]; runIntentVersion: string };
    };
    assert.equal(pinned.identity.version, ATTRIBUTION_ARTIFACT_VERSION,
      `${name} was pinned on a different artifact version — re-run \`npm run test:intent-baseline -- --write-baseline\` and review the field-level diff`);
    assert.deepEqual(pinned.identity.channels, [...SELECTION_CHANNELS],
      `${name} was pinned on a different channel set — re-pin it, and check that only the flip set moved`);
    assert.equal(pinned.identity.runIntentVersion, RUN_INTENT_VERSION,
      `${name} was pinned on a different run-intent version — the v1 to v2 bump had to be re-pinned by hand, and this is what makes the next one go red instead`);
  }
});

// The ablation must stay an ablation. If someone "fixes" a failing run by editing the ablated alias list, the
// contrast stops being a controlled experiment and the flip assertions start measuring two unrelated queries.
test("the ablated intent differs from the full intent by exactly the dropped term", async () => {
  const fixture = JSON.parse(await readFile(join(FIXTURES, "wcp-leave.json"), "utf8")) as {
    features: Array<{ subject: string; aliases: string[] }>; ablation: { drops: string[] };
  };
  const [full, ablated] = fixture.features;
  assert.ok(full && ablated, "the fixture carries both arms");

  const fullSet = new Set(full.aliases);
  const ablatedSet = new Set(ablated.aliases);
  for (const alias of ablatedSet) assert.ok(fullSet.has(alias), `ablated alias ${alias} is not in the full set; this is no longer an ablation`);
  const dropped = [...fullSet].filter((alias) => !ablatedSet.has(alias)).sort();
  assert.deepEqual(dropped, [...fixture.ablation.drops].sort(), "the dropped terms are exactly the ones the fixture declares");

  for (const alias of [...fullSet, ...ablatedSet]) {
    assert.match(alias, /^[\x20-\x7e]+$/, `alias ${alias} is not ASCII; cross-language variants were ruled out as a degenerate instrument`);
  }
});

// A comparator that cannot see a change is worse than no comparator: it reports a clean baseline over a moved
// selection. Each mutation below is a real failure mode of this engine, and each must be visible.
test("the comparator sees every single-point mutation of a projection", () => {
  const base = {
    identity: { version: "attribution-v3", channels: ["seed"] },
    denominator: { unitKind: "partition-cell", cells: 10 },
    selections: [{
      featureKey: "f",
      channels: { status: "ran", byChannel: { seed: 2, lexical: 1 } },
      seats: [{ unitId: "cell:a", factId: "fact:a", channel: "seed", rootName: "r" }],
      displaced: ["cell:b"],
      seedCells: ["cell:a"],
      zeroScore: [{ reason: "structure-unobserved", cells: 3 }],
      projection: { retained: { nodes: 1, seated: 1 } },
      modules: [{ moduleId: "m1", status: "seated" }, { moduleId: "m2", status: "zero-signal" }],
      conservation: [{ unitKind: "partition-cell", totals: { counted: 10, seated: 1, displaced: 1, zeroScore: 8 } }]
    }]
  };
  const mutate = (fn: (copy: typeof base) => void): typeof base => {
    const copy = JSON.parse(JSON.stringify(base)) as typeof base;
    fn(copy);
    return copy;
  };

  const mutations: Array<[string, typeof base]> = [
    ["module status flipped", mutate((c) => { c.selections[0]!.modules[1]!.status = "seated"; })],
    ["a seat deleted", mutate((c) => { c.selections[0]!.seats = []; })],
    ["a channel count changed", mutate((c) => { c.selections[0]!.channels.byChannel.seed = 3; })],
    ["a whole selection deleted", mutate((c) => { c.selections = []; })],
    ["a module row deleted", mutate((c) => { c.selections[0]!.modules = [c.selections[0]!.modules[0]!]; })],
    ["seedCells naming an unseated cell", mutate((c) => { c.selections[0]!.seedCells = ["cell:zzz"]; })]
  ];
  for (const [name, mutated] of mutations) {
    assert.ok(diffBaseline(base, mutated).length > 0, `the comparator must see: ${name}`);
  }
  assert.equal(diffBaseline(base, JSON.parse(JSON.stringify(base))).length, 0, "and must see nothing when nothing moved");
});

// Determinism of the projection itself, independent of any run: same input, same bytes. Without this a baseline
// mismatch could be the projection's own instability rather than a real movement.
test("the projection is a pure function of the artifact", async () => {
  const fixture = JSON.parse(await readFile(join(FIXTURES, "synthetic-artifact.json"), "utf8"));
  assert.equal(canonicalJson(projectBaseline(fixture)), canonicalJson(projectBaseline(fixture)));
});

// The exclusion list is data so it can be read; it is also the only legitimate way to leave a field out.
test("every excluded field states why it is excluded", () => {
  const entries = Object.entries(EXCLUDED);
  assert.ok(entries.length > 0);
  for (const [field, reason] of entries) {
    assert.ok(reason.length > 30, `${field} needs a real reason, not a label`);
  }
});
