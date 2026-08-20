// The IN-REPO nail under every identity digest this repository checks in (57B-434 R6c).
//
// WHY IT EXISTS. `eval/golden/unit-cache-identity-readings-{wcp,cebreo}.json` are projections of ARCHIVAL run
// directories that are not in this repository, so nothing in CI can recompute their 37 `identityDigest` values —
// and for one slice nothing did: R6b bumped the receipt schema while that version was part of the identity key, the
// checked-in digests became numbers the code cannot produce, and the whole suite stayed green because the baseline
// test only checked that a digest LOOKED like 64 hex characters. The gap was never "recomputing is expensive"; it
// was "the input is not here".
//
// So the reading is split, and this file is the half whose input IS here: `projectUnitIdentityReadings` takes
// values, `tests/fixtures/topic-catalog-mini` is a frozen run in the repository, and the golden below is the WHOLE
// reading recomputed and compared byte for byte on every `npm test`. One change to the identity formula — a field
// dropped from the terms, a line stopped being normalized, a section split moved — and this goes red in the same
// batch as the change rather than three slices later.
//
// THE GENERAL LAW, of which this file is one half: a digest may be checked into a golden only if CI can recompute it
// from an input in this repository, or the contract version it was minted under is recorded beside it and pinned to
// the code's own constant. A digest with neither is 64 characters nothing is asserting.
//
// REGENERATING IT, when a reviewed change to the identity or the packet renderer moves it (verified to reproduce
// the checked-in bytes exactly, from the repository root):
//
//   node --experimental-strip-types --input-type=module-typescript --eval '
//     import { writeFileSync } from "node:fs";
//     import { stableJson } from "./src/base/util.ts";
//     import { MINI_DOCUMENTS, miniRun } from "./tests/plan-fixture.ts";
//     import { projectUnitIdentityReadings } from "./eval/unit-cache-identity-readings.ts";
//     const run = await miniRun();
//     writeFileSync("eval/golden/unit-cache-identity-readings-mini.json",
//       `${stableJson(projectUnitIdentityReadings({ catalog: run.catalog, documents: MINI_DOCUMENTS, evidenceById: run.evidenceById, reach: run.reach, epochCoverage: run.epochCoverage }))}\n`);
//   '
//
// WHAT THIS FIXTURE DOES NOT COVER, stated so nobody reads it as covering everything: the mini plan retires no unit
// and every one of its six scenarios applies, so the `retired` bucket and the `not-applicable` arm are read on the
// two baselines and asserted in `tests/unit-cache-plan.test.ts`. A synthesis has no identity here either — this
// projection has no collected summaries, exactly like an archival run — and the synthesis arm of the identity lives
// in `tests/unit-cache-identity.test.ts`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256, stableJson } from "../../src/base/util.ts";
import { UNIT_IDENTITY_KEY_VERSIONS } from "../../src/report/unit-cache-identity.ts";
import { MINI_DOCUMENTS, miniRun } from "../../tests/plan-fixture.ts";
import {
  UNIT_CACHE_IDENTITY_READINGS_VERSION,
  projectUnitIdentityReadings,
  type ScenarioReading,
  type UnitIdentityProjection
} from "../unit-cache-identity-readings.ts";

const GOLDEN = join(import.meta.dirname, "..", "golden", "unit-cache-identity-readings-mini.json");

/** The reading of the mini fixture, through the same projection the two baseline goldens are produced by. */
async function projection(): Promise<UnitIdentityProjection> {
  const run = await miniRun();
  return projectUnitIdentityReadings({
    catalog: run.catalog,
    documents: MINI_DOCUMENTS,
    evidenceById: run.evidenceById,
    reach: run.reach,
    epochCoverage: run.epochCoverage
  });
}

function derived(readings: UnitIdentityProjection, scenario: string): ScenarioReading["outcome"] & { readonly state: "derived" } {
  const row = readings.scenarios.find((entry) => entry.scenario === scenario);
  if (!row) throw new Error(`the mini reading holds no ${scenario} scenario`);
  if (row.outcome.state !== "derived") throw new Error(`the mini fixture must be able to derive ${scenario}: ${row.outcome.reason}`);
  return row.outcome;
}

/**
 * THE FORMULA WITNESS: the mini fixture's identity digests, as one value, AT THE MOMENT the two ARCHIVAL readings
 * in `eval/golden/unit-cache-identity-readings-{wcp,cebreo}.json` were generated.
 *
 * It is the answer to the one thing a recorded version list cannot do. Those two files hold 37 digests whose inputs
 * are not in this repository, so nothing can recompute them — and a build constant can reach the identity through
 * the VIEW (the packet version in its first line, the policy content digests) or through the request row, without
 * any name in `UNIT_IDENTITY_KEY_VERSIONS` moving. Measured, both ways: bumping `unit-packet-v3` and bumping
 * `legacy-request-mapping-v1` each moved every identity while a version-only pin stayed green. So the pin is not
 * the staleness detector; THIS is. Any change that moves an identity at all moves the fixture's digests, and then
 * the two archival records are stale by construction: regenerate them from their archival run directories, or say
 * in the same batch that they no longer describe this code.
 *
 * It over-triggers in exactly one direction — editing the mini FIXTURE moves it without invalidating anything — and
 * that is the safe direction: a deliberate fixture change re-pins one constant, in the open.
 */
const FORMULA_WITNESS = "c07ca4c4af3178d50be501842ec556c02f4ab0edef5ebec508c4f8b9c3baeac2";

test("the two archival readings were minted by the formula this in-repo fixture still witnesses", async () => {
  const readings = await projection();
  const witness = sha256(canonicalJson(readings.identified.map((row) => [row.unitId, row.identityDigest])));
  assert.equal(witness, FORMULA_WITNESS,
    "the identity formula has moved since eval/golden/unit-cache-identity-readings-{wcp,cebreo}.json were generated, so their 37 identityDigest values are numbers this code can no longer produce: re-generate both from their archival run directories and re-pin this witness in the same batch");
});

test("the mini fixture's whole identity reading is byte-identical to the checked-in golden", async () => {
  const readings = await projection();
  const golden = await readFile(GOLDEN, "utf8");
  assert.equal(`${stableJson(readings)}\n`, golden,
    "every identity digest, section split and bucket of this reading is recomputed here; a golden that no longer matches means the identity formula moved, and that update is a deliberate reviewed one or a regression");
  assert.equal(Buffer.compare(Buffer.from(`${stableJson(readings)}\n`), Buffer.from(golden)), 0);
});

test("the reading is deterministic, and the golden's contract is the one this build keys on", async () => {
  const first = await projection();
  const second = await projection();
  assert.equal(stableJson(first), stableJson(second), "two projections of one frozen fixture are one byte sequence");
  const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as UnitIdentityProjection;
  assert.equal(golden.version, UNIT_CACHE_IDENTITY_READINGS_VERSION);
  assert.deepEqual(golden.contract, UNIT_IDENTITY_KEY_VERSIONS,
    "the digests in this golden were minted under these versions; a bump to any of them must re-mint the file in the same batch");
});

test("the fixture still exercises what this nail is for: identities, both perturbation shapes, and conservation", async () => {
  // Fail closed on the INSTRUMENT, not just on the numbers. A byte comparison stays green against a regenerated
  // golden, so a fixture that quietly stopped planning identifiable units — or stopped being able to perturb a
  // topic — would leave a green test asserting nothing. These premises are what make the bytes above mean something.
  const readings = await projection();
  assert.ok(readings.identified.length >= 10, `${readings.identified.length} identified unit(s) is too few to key anything on`);
  assert.equal(new Set(readings.identified.map((row) => row.identityDigest)).size, readings.identified.length,
    "two units with one identity is the collapse the identity exists to prevent");
  for (const scenario of readings.scenarios) {
    assert.equal(scenario.outcome.state, "derived", `${scenario.scenario} must apply on this fixture, or the golden records a reading of nothing`);
  }
  // The two perturbation shapes are still DIFFERENT here: a binding-set change moves ownership and therefore
  // siblings, a content change cannot. If these ever agree, the fixture stopped covering the distinction R6a exists
  // to record, whatever the golden says.
  const content = derived(readings, "content-change-owner-topic");
  const bindings = derived(readings, "binding-dropped-owner-topic");
  assert.ok(content.rebuild.length > 0, "a content change on an owning topic must invalidate the units that name it");
  assert.ok(bindings.rebuild.length + bindings.retired.length > content.rebuild.length + content.retired.length,
    `a binding-set change must invalidate strictly more: ${bindings.rebuild.length} rebuilt + ${bindings.retired.length} retired against ${content.rebuild.length} + ${content.retired.length}`);
  for (const scenario of [content, bindings, derived(readings, "unchanged"), derived(readings, "first-run")]) {
    assert.deepEqual(scenario.conservation, [
      `planned = reusable + rebuild + new: ${scenario.plannedUnits} = ${scenario.reusable.length} + ${scenario.rebuild.length} + ${scenario.new.length}`,
      `candidates = reusable + rebuild + retired: ${scenario.candidateUnits} = ${scenario.reusable.length} + ${scenario.rebuild.length} + ${scenario.retired.length}`
    ]);
  }
});
