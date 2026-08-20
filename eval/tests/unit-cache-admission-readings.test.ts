// Unit cache ADMISSION readings of the two R0 baselines (57B-434 R6b).
//
// `eval/golden/unit-cache-admission-readings-{wcp,cebreo}.json` are produced by
// `npm run eval -- unit-cache-admission-readings --run <dir> --out <file>` against the archival run directories
// (which are NOT in this repository). They are records, not assertions about a run this suite can re-derive, so what
// is asserted here is their internal consistency plus the one property this reading exists to establish:
//
//   * THE TWO CANDIDATE FORMS AGREE, BUCKET FOR BUCKET, in every scenario on both targets. A re-planned run on disk
//     holds only the identity DIGEST its ledger row recorded — the plan the candidate was drafted under is gone — so
//     the production comparison is digest against digest. Deriving the same plan from whole identities and from
//     recorded digests must place every unit identically; the extractor throws if it ever does not, and these rows
//     are the record that it did not.
//   * AND THE COST OF THAT FORM IS MEASURED RATHER THAN ASSUMED: on wcp's content perturbation, four units are
//     rebuilt either way, and the whole-identity form can name the sections that moved for all four while the
//     recorded-digest form can name them for none. That is the whole difference, and it is a REASON, never a bucket.
//
// The admitted / fell-to-rebuild / skipped-new account is NOT measured here and cannot be: an archival run authored
// no unit, so no candidate's bytes exist to verify. That account is exercised end to end on real run directories in
// `tests/unit-cache-admission-e2e.test.ts`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UNIT_PACKET_FORBIDDEN_INPUT_PREFIXES } from "../../src/report/unit-packet-source.ts";
import { UNIT_CACHE_ADMISSION_READINGS_VERSION, type AdmissionScenarioReading, type UnitAdmissionReadings } from "../unit-cache-admission-readings.ts";

const HERE = import.meta.dirname;
const READINGS = ["wcp", "cebreo"].map((target) => ({ target, path: join(HERE, "..", "golden", `unit-cache-admission-readings-${target}.json`) }));

const SCENARIOS = ["unchanged", "second-audience-document", "content-change-smallest-topic"] as const;

async function readings(path: string): Promise<UnitAdmissionReadings> {
  return JSON.parse(await readFile(path, "utf8")) as UnitAdmissionReadings;
}

function scenarioOf(row: UnitAdmissionReadings, name: string): AdmissionScenarioReading {
  const scenario = row.scenarios.find((entry) => entry.scenario === name);
  assert.ok(scenario, `the reading must hold the ${name} scenario`);
  return scenario!;
}

test("every checked-in admission reading is internally consistent and its two candidate forms agree", async () => {
  for (const { target, path } of READINGS) {
    const row = await readings(path);
    assert.equal(row.version, UNIT_CACHE_ADMISSION_READINGS_VERSION, `${target}: version`);
    assert.match(row.authorship, /^model-free generator /, `${target}: a deterministic projection is not a model family`);
    assert.match(row.bytesNotVerified, /none of them is an admission$/, `${target}: the reading must say where it stops`);
    assert.ok(row.candidateUnits <= row.plannedUnits && row.candidateUnits > 0, `${target}: ${row.candidateUnits} of ${row.plannedUnits}`);
    assert.deepEqual(row.scenarios.map((scenario) => scenario.scenario), [...SCENARIOS], `${target}: the scenario set is fixed`);

    for (const scenario of row.scenarios) {
      assert.ok(scenario.perturbation.trim() !== "", `${target}: ${scenario.scenario} must state what it changed`);
      const outcome = scenario.outcome;
      if (outcome.state === "not-applicable") {
        assert.ok(outcome.reason.trim() !== "", `${target}: ${scenario.scenario} must say why it does not apply`);
        continue;
      }
      // THE PROPERTY: one equality decides reuse, whichever form the candidate is in.
      assert.equal(outcome.bucketsAgree, true, `${target}: ${scenario.scenario}`);
      assert.deepEqual(outcome.fromRecordedDigests, outcome.fromWholeIdentities,
        `${target}: ${scenario.scenario} - a candidate known only by its recorded digest must land in the same bucket`);

      const buckets = outcome.fromRecordedDigests;
      const named = [...buckets.reusable, ...buckets.rebuild, ...buckets.new];
      assert.equal(new Set(named).size, named.length, `${target}: ${scenario.scenario} - one unit, one bucket`);
      assert.equal(named.length, outcome.plannedUnits, `${target}: ${scenario.scenario} - every planned unit of THIS scenario is placed`);
      assert.equal(buckets.reusable.length + buckets.rebuild.length + buckets.retired.length, row.candidateUnits,
        `${target}: ${scenario.scenario} - every candidate is accounted for`);

      // The causes are the ones each form CAN give, and neither may give the other's.
      for (const entry of outcome.rebuildCauses) {
        assert.ok(entry.units > 0, `${target}: ${scenario.scenario} - a cause with no unit is not a reading`);
        if (entry.form === "whole-identities") {
          assert.notEqual(entry.cause, "recorded-identity-differs", `${target}: a whole identity can always name what moved`);
        } else {
          assert.notEqual(entry.cause, "identity-changed", `${target}: a recorded digest cannot diff sections it does not hold`);
        }
      }
      const recorded = outcome.rebuildsNamingSections.find((entry) => entry.form === "recorded-digests");
      assert.equal(recorded?.units, 0, `${target}: ${scenario.scenario} - a digest cannot name a section`);
      const whole = outcome.rebuildsNamingSections.find((entry) => entry.form === "whole-identities");
      assert.ok((whole?.units ?? 0) <= buckets.rebuild.length, `${target}: ${scenario.scenario}`);
    }

    for (const readPath of row.readPaths) {
      for (const prefix of UNIT_PACKET_FORBIDDEN_INPUT_PREFIXES) {
        assert.ok(!readPath.startsWith(prefix), `${target}: ${readPath} is an authoring-side input`);
      }
    }
  }
});

test("the wcp reading: 36 candidates, a reused second audience, and the measured cost of a digest-only candidate", async () => {
  const row = await readings(READINGS[0]!.path);
  assert.equal(row.plannedUnits, 40);
  assert.equal(row.candidateUnits, 36, "the four document roots have no identity on an archival run");

  const unchanged = scenarioOf(row, "unchanged").outcome;
  if (unchanged.state !== "derived") throw new Error("the unchanged scenario always applies");
  assert.equal(unchanged.fromRecordedDigests.reusable.length, 36);
  assert.deepEqual(unchanged.fromRecordedDigests.rebuild, []);

  const second = scenarioOf(row, "second-audience-document").outcome;
  if (second.state !== "derived") throw new Error("wcp can express a second audience");
  assert.equal(second.plannedUnits, 50, "the added document brings its own units");
  assert.equal(second.fromRecordedDigests.reusable.length, 36, "a second audience rewrites nothing");
  assert.equal(second.fromRecordedDigests.new.length, 14);

  // The one legitimate difference between the two forms, as numbers: four rebuilds either way, four explanations
  // that can name sections against none.
  const content = scenarioOf(row, "content-change-smallest-topic").outcome;
  if (content.state !== "derived") throw new Error("wcp holds a material topic");
  assert.equal(content.fromRecordedDigests.rebuild.length, 4);
  assert.equal(content.fromRecordedDigests.reusable.length, 32);
  assert.deepEqual(content.rebuildCauses, [
    { form: "whole-identities", cause: "identity-changed", units: 4 },
    { form: "recorded-digests", cause: "recorded-identity-differs", units: 4 }
  ]);
  assert.deepEqual(content.rebuildsNamingSections, [
    { form: "whole-identities", units: 4 },
    { form: "recorded-digests", units: 0 }
  ]);
});

test("the cebreo reading is the zero-material shape: 2 units, 1 candidate, the topic perturbation named", async () => {
  const row = await readings(READINGS[1]!.path);
  assert.equal(row.plannedUnits, 2);
  assert.equal(row.candidateUnits, 1);
  const unchanged = scenarioOf(row, "unchanged").outcome;
  if (unchanged.state !== "derived") throw new Error("the unchanged scenario always applies");
  assert.deepEqual(unchanged.fromRecordedDigests.reusable, ["overview-product::appendix::coverage"]);
  assert.deepEqual(unchanged.fromRecordedDigests.new, ["overview-product::synthesis::document"]);
  const content = scenarioOf(row, "content-change-smallest-topic").outcome;
  assert.equal(content.state, "not-applicable");
  if (content.state !== "not-applicable") throw new Error("cebreo holds no material topic");
  assert.match(content.reason, /no material topic with a binding/);
});
