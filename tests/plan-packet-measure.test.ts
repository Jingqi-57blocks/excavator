import test from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE, documentBudgetRow, type PlanBudgetTable } from "../src/report/plan-budget.ts";
import { derivePlanArtifacts } from "../src/report/plan-artifacts.ts";
import {
  costBytes,
  maximalChildSummary,
  measurePlanPackets,
  packetMeasurementProblems,
  summariseUnitCost,
  unitOverBudgetProblem,
  type UnitPacketMeasureInputs
} from "../src/report/plan-packet-measure.ts";
import { deriveObligationOwnership, documentOwnership, ownershipUnitsOfProposal } from "../src/report/plan-obligation-conservation.ts";
import { parsePlanProposal, type PlanProposal } from "../src/report/plan-proposal.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { childSummaryBlockBytes, renderUnitPacket, topicDossier, unitPacketBytes } from "../src/report/unit-packet.ts";
import { validatePlan } from "../src/report/plan-validation.ts";
import { miniRun, type MiniRun } from "./plan-fixture.ts";

// THE MEASURE, AND THE TRIPWIRE THAT KEEPS IT ATTACHED TO WHAT IT MEASURES (57B-434 R5b).
//
// R4b's plan-time budget check measured a PROXY — the canonical bytes of a unit's topic rows — and on the wcp R0
// baseline it was out by about 9x: one feature leaf's topic rows are ~220 KB and its packet is 1,993,499 B, because
// the packet also renders the evidence bodies the obligations bind. Eight units passed a check they exceeded, and
// nothing went red because nothing ever put the two numbers next to each other.
//
// So the pre-check IS the renderer now, and the identity is asserted per unit here (over the mini fixture, in both
// its undivided and divided shapes) and per unit in the checked-in baseline readings
// (`eval/tests/unit-packet-readings.test.ts`, field `precheckBytes`). Perturbing anything in the packet's
// composition moves both numbers together or fails this test.

let mini: MiniRun | null = null;
async function fixture(): Promise<MiniRun> {
  return (mini ??= await miniRun());
}

function measureInputs(run: MiniRun, budgetTable: PlanBudgetTable = PLAN_BUDGET_TABLE): UnitPacketMeasureInputs {
  return {
    catalog: run.catalog,
    requests: run.requests,
    registry: REPORT_POLICY_REGISTRY,
    budgetTable,
    evidence: run.evidenceById,
    reach: run.reach
  };
}

function parsed(raw: unknown): PlanProposal {
  const result = parsePlanProposal(raw);
  assert.equal(result.proposal !== null, true, `the proposal must parse: ${result.problems.join("; ")}`);
  return result.proposal!;
}

// --- (1) the same-source tripwire ---------------------------------------------------------------------

test("every renderable unit's measured bytes ARE the bytes its packet renders to — the same composition, not two", async () => {
  const run = await fixture();
  const proposal = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const inputs = measureInputs(run);
  const measurement = measurePlanPackets(inputs, proposal);
  const artifacts = derivePlanArtifacts({ catalog: run.catalog, requests: run.requests, proposal, budgetTable: PLAN_BUDGET_TABLE });
  const ownership = deriveObligationOwnership(run.catalog, ownershipUnitsOfProposal(proposal.units));
  const topicsById = new Map(run.catalog.topics.map((topic) => [topic.topicId, topic]));

  assert.equal(measurement.units.length, proposal.units.length, "every unit is measured; none is skipped");
  let rendered = 0;
  for (const row of measurement.units) {
    const unit = artifacts.planCatalog.units.find((entry) => entry.unitId === row.unitId)!;
    if (unit.kind === "synthesis") {
      assert.equal(row.cost.state, "bounded", `${row.unitId}: a synthesis has no packet at plan time, so it is bounded`);
      continue;
    }
    assert.equal(row.cost.state, "rendered", `${row.unitId}`);
    const input = {
      planCatalog: artifacts.planCatalog,
      facets: run.catalog.facets,
      dag: artifacts.dag,
      requests: run.requests,
      registry: REPORT_POLICY_REGISTRY,
      unitId: unit.unitId,
      dossier: topicDossier(unit, topicsById, run.evidenceById),
      ownership: documentOwnership(ownership, unit.documentId),
      reach: run.reach,
      byteLimit: documentBudgetRow(artifacts.planCatalog.budget, unit.documentId).perUnitInputBytes,
      overBudget: "refuse" as const
    };
    const packet = renderUnitPacket(input);
    assert.equal(packet.limitations.length, 0, `${row.unitId} must fit its bound on this fixture`);
    assert.equal(costBytes(row.cost), packet.bytes, `${row.unitId}: the measured bytes must BE the rendered bytes`);
    assert.equal(unitPacketBytes(input), packet.bytes, `${row.unitId}: and so must the exported measure`);
    rendered += 1;
  }
  assert.ok(rendered >= 9, "the mini fixture must actually exercise several renderable units");
  assert.deepEqual([...measurement.overBudgetUnitIds], [], "nothing on this fixture is over budget");
  assert.deepEqual(packetMeasurementProblems(measurement), []);

  // Per document, the measured total IS the per-unit numbers summed — one arithmetic, not two.
  for (const document of measurement.documents) {
    const units = measurement.units.filter((row) => row.documentId === document.documentId);
    assert.equal(document.bytes, units.reduce((total, row) => total + costBytes(row.cost), 0), document.documentId);
    assert.equal(document.overBy, 0, document.documentId);
  }
});

test("the measurement is deterministic: the same plan measures to the same bytes twice", async () => {
  const run = await fixture();
  const proposal = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const inputs = measureInputs(run);
  assert.equal(stableJson(measurePlanPackets(inputs, proposal)), stableJson(measurePlanPackets(inputs, proposal)));
});

// --- (2) the synthesis arm: bounded by the declared summary allowance ----------------------------------

test("a synthesis is bounded by children x the declared summary allowance, rendered as a worst case", async () => {
  const run = await fixture();
  const proposal = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const measurement = measurePlanPackets(measureInputs(run), proposal);
  const synthesis = measurement.units.find((row) => row.kind === "synthesis")!;
  assert.equal(synthesis.cost.state, "bounded");
  if (synthesis.cost.state !== "bounded") return;
  const allowance = measurement.documents.find((row) => row.documentId === synthesis.documentId)!.budget;
  assert.equal(synthesis.cost.perChildBytes, allowance.perUnitSummaryBytes);
  assert.ok(synthesis.cost.children >= 2, "the fixture's synthesis has several children");
  // The arithmetic is exact by construction: the worst case IS a render, over children padded to the allowance.
  assert.equal(synthesis.cost.bytes, synthesis.cost.fixedBytes + synthesis.cost.children * synthesis.cost.perChildBytes);
  assert.match(summariseUnitCost(synthesis), /bounded \(\d+ x \d+ \+ \d+\)/);
});

test("the worst-case child summary renders to exactly the declared allowance, and the padding is solved not guessed", () => {
  for (const bytes of [4_096, 8_192, 16_384]) {
    const summary = maximalChildSummary("doc::leaf::x", "doc", "leaf", bytes);
    assert.equal(childSummaryBlockBytes(summary), bytes, `a ${bytes}-byte allowance must pad to exactly ${bytes}`);
  }
  // A bound smaller than the smallest possible block cannot be met: the minimum is used, and the resulting overrun
  // is reported like any other rather than pretended away.
  const tiny = maximalChildSummary("doc::leaf::x", "doc", "leaf", 1);
  assert.ok(childSummaryBlockBytes(tiny) > 1);
});

test("a summary allowance too large for the input budget makes the synthesis a NAMED plan failure, with its arithmetic", async () => {
  const run = await fixture();
  // Every other number is the real one; only the summary allowance moves. A synthesis whose children could each
  // hand it 300 KB cannot fit a 786,432-byte input budget, and that is the arithmetic the message prints.
  const inflated: PlanBudgetTable = {
    version: "plan-budget-test-summary-inflated",
    allowances: Object.fromEntries(Object.entries(PLAN_BUDGET_TABLE.allowances)
      .map(([key, allowance]) => [key, { ...allowance, perUnitOutputBytes: 400_000, perUnitSummaryBytes: 300_000 }]))
  };
  const proposal = buildFixturePlan(run.catalog, run.requests, inflated);
  const report = validatePlan({ ...measureInputs(run, inflated), proposal });
  assert.equal(report.overall.conclusion, "violations");
  const problems = report.overall.conclusion === "violations" ? report.overall.problems : [];
  assert.ok(problems.some((problem) =>
    /^synthesis unit .* would be handed up to \d+ bytes — \d+ fixed plus \d+ child summar\(ies\) at the declared 300000-byte bound each — which is \d+ byte\(s\) over the 786432-byte per-unit input budget/.test(problem)),
    problems.join(" | "));
  assert.ok(problems.some((problem) => /give this synthesis fewer children \(an intermediate synthesis level\), or lower the summary bound deliberately/.test(problem)));
  // A synthesis is never divided: the splitter's job is obligations, and a synthesis has none.
  assert.ok(problems.every((problem) => !/divide its obligations/.test(problem)));
});

// --- (3) the three-state reading: an unmeasurable plan says so, and never reads as fine ------------------

test("a plan with structural problems is NOT measured, says why, and cannot read as `every packet fits`", async () => {
  const run = await fixture();
  const base = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const broken = parsed({
    ...JSON.parse(stableJson(base)) as Record<string, unknown>,
    units: base.units.filter((unit) => unit.documentId !== "overview-engineering").map((unit) => JSON.parse(stableJson(unit)) as unknown)
  });
  const report = validatePlan({ ...measureInputs(run), proposal: broken });
  assert.equal(report.overall.conclusion, "violations");
  assert.equal(report.packets.state, "not-measured");
  if (report.packets.state !== "not-measured") return;
  assert.match(report.packets.reason, /^this plan has \d+ problem\(s\) that must be fixed before its packets can be rendered, so no byte measurement was taken: /);
  // The empty set is never read as complete: an unmeasured plan always sits beside problems.
  assert.ok(report.problems.length > 0);
});

test("the over-budget sentence is ONE sentence, shared by the validator and the splitter", async () => {
  const run = await fixture();
  const tiny: PlanBudgetTable = {
    version: "plan-budget-test-tiny",
    allowances: Object.fromEntries(Object.entries(PLAN_BUDGET_TABLE.allowances)
      .map(([key]) => [key, { perUnitInputBytes: 4_096, totalInputBytes: 4_096, perUnitOutputBytes: 2_048, perUnitSummaryBytes: 512 }]))
  };
  const proposal = buildFixturePlan(run.catalog, run.requests, tiny);
  const measurement = measurePlanPackets(measureInputs(run, tiny), proposal);
  const over = measurement.units.filter((row) => row.overBy > 0);
  assert.ok(over.length > 0, "a 4 KiB per-unit budget must overflow on a real catalog");
  for (const row of over) {
    assert.ok(packetMeasurementProblems(measurement).includes(unitOverBudgetProblem(row)),
      `${row.unitId}: the validator and the splitter must print the same sentence, not two descriptions of one overrun`);
  }
  const leaf = over.find((row) => row.cost.state === "rendered")!;
  assert.match(unitOverBudgetProblem(leaf), /divide its obligations across more units — nothing here truncates a packet to fit/);
});
