// Golden byte pin for the CROSS-UNIT CONSISTENCY CHECKER's judgement sentences (57B-434 R7c), on the model-free
// chain: prepare -> dispose (two obligations left `cannot-determine`) -> freeze -> plan -> draft every unit ->
// collect -> assemble --units -> unit-consistency.
//
// WHAT THIS PIN IS FOR, and it is not the same thing as the class tests. `tests/unit-consistency.test.ts` asserts
// that each class fires; this file freezes WHAT THE ARTIFACT SAYS — the vacuous reasons, the finding sentences, the
// repair reasons, the "why no collect gate catches this" clauses and the coverage routes. Those are the product of
// the slice: an operator acts on the sentence, not on a boolean. A reworded reason that quietly stops naming the
// obligation, or a repair reason that stops explaining why an ancestor is load-bearing, moves this golden.
//
// WHY IT IS PINNED ON A SYNTHETIC FIXTURE AND SAYS SO. The epic's two R0 baselines hold SECTION drafts — nothing
// has ever authored a unit into either of them — so there is no archival run with unit prose, unit claims or unit
// summaries to check for cross-unit consistency. Same shape as `unit-assemble-golden.test.ts`, and it buys the
// property the two archival identity readings cannot have: the input is IN THIS REPOSITORY, so CI recomputes every
// sentence below on every run.
//
// REGENERATING IT, when a reviewed change moves it (verified to reproduce the checked-in bytes exactly, from the
// repository root):
//
//   node --experimental-strip-types --input-type=module-typescript --eval '
//     import { writeFileSync } from "node:fs";
//     import { stableJson } from "./src/base/util.ts";
//     import { consistencyScenarioProjection } from "./eval/unit-consistency-scenarios.ts";
//     writeFileSync("eval/golden/unit-consistency-readings.json", `${stableJson(await consistencyScenarioProjection())}\n`);
//   '

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "../../src/base/util.ts";
import { checkRunConsistency } from "../../src/report/unit-consistency-source.ts";
import { assembledConsistencyRun, type ConsistencyRun } from "../../tests/unit-consistency-fixture.ts";
import { consistencyScenarioProjection } from "../unit-consistency-scenarios.ts";
import {
  UNIT_CONSISTENCY_READINGS_VERSION,
  projectConsistencyReadings,
  volatileLiterals,
  type ConsistencyReadingsProjection,
  type VolatileRunIdentity
} from "../unit-consistency-readings.ts";

const APPENDIX = "overview-product::appendix::coverage";
const COVERAGE_LEAF = "overview-product::leaf::coverage";
const ROOT = "overview-product::synthesis::document";

function identityOf(run: ConsistencyRun): VolatileRunIdentity {
  return {
    runId: run.view.runId,
    planCatalogDigest: run.view.planCatalogDigest,
    sourceEvidenceId: run.evidenceId,
    evidenceIds: run.view.frozenEvidenceIds
  };
}

const GOLDEN = join(import.meta.dirname, "..", "golden", "unit-consistency-readings.json");

const golden = await readFile(GOLDEN, "utf8");
const projection = await consistencyScenarioProjection();

test("the whole consistency reading of six scenarios is byte-identical to the checked-in golden", () => {
  assert.equal(`${stableJson(projection)}\n`, golden,
    "every vacuous reason, finding sentence, repair reason and coverage route of this slice is recomputed here; a golden that no longer matches means one of those sentences moved, and that update is a deliberate reviewed one or a regression");
  assert.equal(Buffer.compare(Buffer.from(`${stableJson(projection)}\n`), Buffer.from(golden)), 0);
});

test("two independent runs of the fixture project to the same canonical reading", async () => {
  const second = await consistencyScenarioProjection();
  assert.equal(stableJson(second), stableJson(projection), "the projection must not carry a run id, a digest or an evidence id");
  assert.equal(stableJson(second), stableJson(JSON.parse(golden) as ConsistencyReadingsProjection));
});

test("every substitution rule that must fire fires, and nothing volatile survives", async () => {
  const fired = Object.fromEntries(projection.applied.map((rule) => [rule.name, rule.replacements]));
  for (const name of ["run-id", "plan-catalog-digest", "plan-catalog-digest-16", "source-evidence-id"]) {
    assert.ok((fired[name] ?? 0) > 0, `rule ${name} must fire (fired ${JSON.stringify(fired)})`);
  }
  // Fail closed on the INSTRUMENT: a run's own volatile literals must not appear anywhere in the projection.
  const run = await assembledConsistencyRun({});
  const reading = await checkRunConsistency(run.runDir);
  const one = projectConsistencyReadings([{ scenario: "probe", injected: "nothing", reading, volatile: identityOf(run) }]);
  const text = stableJson(one);
  for (const literal of volatileLiterals(identityOf(run))) {
    assert.ok(!text.includes(literal), `the projection must not contain ${literal}`);
  }
  assert.ok(!text.includes(run.runDir), "no absolute path may reach the reading");
});

test("the golden is a reading, not a stub: it holds the sentences this slice exists to produce", () => {
  assert.equal(projection.version, UNIT_CONSISTENCY_READINGS_VERSION);
  assert.deepEqual(projection.scenarios.map((row) => row.scenario), [
    "clean", "unknown-overclaim", "terminology-drift", "contradiction-references-and-policy", "repaired", "identifier-in-prose"
  ]);
  for (const fragment of [
    // the three-state discipline, both arms, in the artifact
    "vacuous: terminology-drift had no object to check",
    "checked: unknown-overclaim over",
    // each class's own sentence
    "which this run's ledger records as \\\"cannot-determine\\\"",
    "both asserts and disclaims obligation",
    "holds neither as an explicit anchor nor as a heading a renderer would slug to it",
    "so every link to it lands on whichever copy the plan's order put first",
    "tells the reader what to do and nothing negates it",
    "puts evidence id <SOURCE-EVIDENCE-ID> in the visible prose",
    "defines term \\\"tenant\\\" with 2 different meanings",
    // the repair contract
    "no collect gate catches this because",
    "makes the run uncollectable at this unit's next collect",
    "there is no whole-document rewrite to ask for",
    "nothing to repair: the checker found no cross-unit defect",
    // gate 10 routed rather than repaired
    "owed-outside-unit-authoring",
    "re-drafting a unit cannot pay it"
  ]) {
    assert.ok(golden.includes(fragment), `the golden must contain ${JSON.stringify(fragment)}`);
  }
  // Neither a percentage nor a combined coverage figure ever reaches a reading of this run.
  assert.ok(!/\d+%/.test(golden), "no consistency reading states a percentage");
  // The convergence scenario is genuinely empty, and the drift one genuinely is not.
  const repaired = projection.scenarios.find((row) => row.scenario === "repaired")!.reading as { result: { findings: unknown[] }; repair: { targets: unknown[] } };
  const drifted = projection.scenarios.find((row) => row.scenario === "terminology-drift")!.reading as { result: { findings: unknown[] }; repair: { targets: unknown[] } };
  assert.deepEqual(repaired.result.findings, []);
  assert.deepEqual(repaired.repair.targets, []);
  assert.equal(drifted.result.findings.length, 1);
  assert.equal(drifted.repair.targets.length, 3, `${APPENDIX}, ${COVERAGE_LEAF} and ${ROOT}`);
});
