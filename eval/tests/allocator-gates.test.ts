import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { allocateFeatureGraphRecorded } from "../../src/attribution/allocator.ts";
import { NO_RECALL } from "../../src/attribution/allocator.ts";
import { WEIGHTS } from "../../src/attribution/selection-trace.ts";
import { loadAllocatorProjectionFixture } from "../allocator-fixture.ts";
import { loadAllocatorPreregistration } from "../allocator-preregistration.ts";
import { loadAllocatorReplacementMeasurements, validateAllocatorReplacementMeasurements } from "../allocator-replacement-metrics.ts";
import { loadPrunePool } from "../prune-replay.ts";

const ROOT = join(import.meta.dirname, "..", "fixtures", "allocator");
const PREREG = loadAllocatorPreregistration(join(ROOT, "preregistration-v1.json"));

test("M1: paired three-run prepare cost stays within the preregistered 20 percent gate", () => {
  const metrics = loadAllocatorReplacementMeasurements(join(ROOT, "replacement-measurements-v1.json"));
  assert.deepEqual(validateAllocatorReplacementMeasurements(metrics, PREREG), []);
  assert.equal(metrics.allGatesPass, true);
  assert.ok(metrics.kernel.relativeOverhead < 0, "the full-pool replacement kernel is faster than legacy");
  assert.ok(metrics.sequentialDiagnostic.cases.some((row) => !row.thresholdPass), "the drift-triggering batch remains visible");
});

function measure(caseId: string, options: Parameters<typeof allocateFeatureGraphRecorded>[6] = {}) {
  const spec = PREREG.cases.find((row) => row.id === caseId)!;
  const pool = loadPrunePool(spec.poolFile);
  const projection = loadAllocatorProjectionFixture(spec.projectionFile);
  const allocation = allocateFeatureGraphRecorded(pool.nodes, pool.edges, pool.seeds, pool.anchorTerms, spec.budget.maxNodes, NO_RECALL, options);
  const unitByNode = new Map(projection.rows.map((row) => [row.nodeId, row.unitId] as const));
  const selectedUnits = new Set(allocation.nodes.map((row) => unitByNode.get(String(row.id))).filter((id): id is string => typeof id === "string"));
  return { spec, allocation, projection, unitByNode, selectedUnits };
}

function soleSourceUnits(result: ReturnType<typeof measure>): Set<string> {
  const units = new Set<string>();
  const selected = new Set(result.allocation.nodes.map((row) => String(row.id)));
  for (const row of result.allocation.trace.pool) {
    if (!selected.has(row.nodeId)) continue;
    if (row.contributions.filter((item) => item.sourceChannel !== "fallback").length !== 1) continue;
    const unitId = result.unitByNode.get(row.nodeId);
    if (unitId) units.add(unitId);
  }
  return units;
}

test("M2: sole-source seats are measured across three capabilities, two targets and their languages", () => {
  const targets = new Set<string>();
  const languages = new Set<string>();
  for (const caseId of PREREG.gates.M2.cases) {
    const result = measure(caseId);
    targets.add(result.spec.target);
    for (const language of result.spec.languages) languages.add(language);
    assert.ok(soleSourceUnits(result).size > 0, `${caseId}: no sole-source UnitId`);
  }
  assert.equal(targets.size, 2);
  assert.ok(languages.has("go") && languages.has("javascript") && languages.has("vue"));
});

test("M3: every named frozen UnitId anchor remains seated", () => {
  for (const caseId of PREREG.gates.M2.cases) {
    const result = measure(caseId);
    for (const anchor of result.spec.anchors) assert.ok(result.selectedUnits.has(anchor.unitId), `${caseId}: lost ${anchor.id} ${anchor.unitId}`);
  }
});

test("M4: replacement is not an unexplained strict subset of legacy v0", () => {
  for (const caseId of PREREG.gates.M2.cases) {
    const result = measure(caseId);
    const old = new Set(result.spec.legacy.seatedUnitIds);
    const strictSubset = result.selectedUnits.size < old.size && [...result.selectedUnits].every((id) => old.has(id));
    const soleSourceGain = soleSourceUnits(result).size > 0;
    assert.equal(strictSubset && !soleSourceGain, false, `${caseId}: strict v0 subset without sole-source gain`);
  }
});

test("M5: document-frequency and derived expansion remove no frozen anchor", () => {
  for (const caseId of PREREG.gates.M2.cases) {
    const enabled = measure(caseId);
    for (const options of [{ documentFrequency: false }, { derivedTerms: false }, { documentFrequency: false, derivedTerms: false }]) {
      const disabled = measure(caseId, options);
      for (const anchor of enabled.spec.anchors) {
        if (disabled.selectedUnits.has(anchor.unitId)) assert.ok(enabled.selectedUnits.has(anchor.unitId), `${caseId}: expansion removed ${anchor.id}`);
      }
    }
  }
});

test("M7: lexical weight seat changes carry an exact contribution counter", () => {
  for (const caseId of PREREG.gates.M2.cases) {
    const before = measure(caseId);
    const after = measure(caseId, { weights: { ...WEIGHTS, lexical: PREREG.gates.M7.perturbation.to } });
    const beforeNodes = new Set(before.allocation.nodes.map((row) => String(row.id)));
    const afterNodes = new Set(after.allocation.nodes.map((row) => String(row.id)));
    const gained = [...afterNodes].filter((id) => !beforeNodes.has(id)).sort();
    const lost = [...beforeNodes].filter((id) => !afterNodes.has(id)).sort();
    assert.equal(gained.length, lost.length, `${caseId}: seat conservation under perturbation`);
    const contribution = (row: (typeof before.allocation.trace.pool)[number]): number =>
      row.contributions.find((item) => item.sourceChannel === "lexical")?.normalizedContribution ?? 0;
    const counters = gained.filter((id) => {
      const a = before.allocation.trace.pool.find((row) => row.nodeId === id)!;
      const b = after.allocation.trace.pool.find((row) => row.nodeId === id)!;
      return contribution(b) > contribution(a);
    });
    assert.equal(counters.length, gained.length, `${caseId}: every gained seat must name the perturbed lexical counter`);
    if (lost.length) assert.ok(counters.length > 0, `${caseId}: displaced seats have no ranked counter-candidate`);
  }
});

test("M6: zero-signal and alias-deletion fixtures preserve the declared module census without forced seats", () => {
  for (const fixture of PREREG.gates.M6.fixtures) {
    const pool = loadPrunePool(fixture.poolFile);
    const projection = loadAllocatorProjectionFixture(fixture.projectionFile);
    const allocation = allocateFeatureGraphRecorded(pool.nodes, pool.edges, pool.seeds, pool.anchorTerms, 250, NO_RECALL);
    const poolModules = new Set(projection.rows.map((row) => row.moduleId).filter(Boolean));
    assert.ok([...poolModules].every((moduleId) => fixture.expectedModules.includes(moduleId)), `${fixture.id}: undeclared module`);
    const selectedModules = new Set(allocation.nodes.map((row) => String(row.id).split("\0", 1)[0]));
    for (const moduleId of fixture.expectedModules) {
      if (!poolModules.has(moduleId)) assert.ok(!selectedModules.has(moduleId), `${fixture.id}: silent module ${moduleId} received a forced seat`);
    }
    if (fixture.id === "wcp-zero-signal") assert.equal(allocation.nodes.length, 0);
  }
});
