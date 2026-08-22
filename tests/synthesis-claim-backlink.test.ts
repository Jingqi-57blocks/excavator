import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SectionClaim } from "../src/base/types.ts";
import { exists } from "../src/base/util.ts";
import { AUTHORING_UNIT_KINDS } from "../src/report/plan-proposal.ts";
import {
  auditSynthesisBacklink,
  auditSynthesisBacklinkFromDisk,
  requiresChildClaimBacklink,
  summariseSynthesisBacklink
} from "../src/report/synthesis-claim-backlink.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import { draftUnit, type UnitDraftInput } from "../src/report/unit-draft.ts";
import { readUnitLedger } from "../src/report/unit-ledger.ts";
import { unitClaimsDigest, validateUnitClaims, type UnitSummary } from "../src/report/unit-output.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import { plannedRun, unitDraftFor, type PlannedRun } from "./unit-fixture.ts";

/**
 * R5a - a synthesis may re-state its children's facts and may not mint one of its own.
 *
 * WHAT WAS UNCHECKED BEFORE. R4b made "a synthesis writes from child summaries only" a type fact on the INPUT side:
 * the proposal has no `topicIds` field for a synthesis, the packet's synthesis arm has no evidence map at all, and
 * the renderer refuses a synthesis handed a topic dossier. Nothing looked at what it WROTE — `draftUnit` runs
 * `validateUnitClaims` (per-claim shape only) and the grounding audit reads a synthesis as `vacuous` because it
 * reaches no material obligation. So a synthesis claim citing an evidence id no child ever cited passed every gate.
 *
 * The negative fixture below is that exact claim, and it is refused at the collect barrier by name, with the claim
 * id and the offending evidence id, with the receipt left in place so a corrected re-draft is collected.
 *
 * The run this suite uses is the sample target's zero-material shape: one appendix child under one synthesis root.
 * That is the second baseline's shape (cebreo), so "the check works on a single-appendix-child document" is measured
 * here rather than assumed.
 */

let shared: Promise<PlannedRun> | null = null;
function run(): Promise<PlannedRun> { return (shared ??= plannedRun(["product"])); }

function synthesisOf(planned: PlannedRun): string {
  const unitId = planned.view.collectionOrder.find((id) => planned.view.byId.get(id)!.kind === "synthesis");
  assert.ok(unitId, "the planned run must have a synthesis root");
  return unitId!;
}

function childrenOf(planned: PlannedRun): readonly string[] {
  return [...planned.view.byId.get(synthesisOf(planned))!.childUnitIds];
}

/** A legal draft for one unit with the claims a test chose, and a summary that digests exactly them. */
async function draftWithClaims(planned: PlannedRun, unitId: string, claims: readonly SectionClaim[]): Promise<UnitDraftInput> {
  const base = await unitDraftFor(planned, unitId);
  const unit = planned.view.byId.get(unitId)!;
  return {
    ...base,
    claims,
    summary: { ...(base.summary as UnitSummary), claimsDigest: unitClaimsDigest(validateUnitClaims(unit.unitId, unit.documentId, claims)) }
  };
}

function claim(id: string, overrides: Partial<SectionClaim> = {}): SectionClaim {
  return { id, marker: "fact", statement: `${id} 记录当前状态。`, evidenceIds: [], confidence: "high", ...overrides };
}

// --- ① which kinds are held to their children --------------------------------------------------------

test("only a synthesis has its claims traced back to children, and every kind says so", () => {
  assert.deepEqual(AUTHORING_UNIT_KINDS.map((kind) => [kind, requiresChildClaimBacklink(kind)]), [
    ["appendix", false],
    ["bridge", false],
    ["leaf", false],
    ["synthesis", true]
  ]);
});

test("auditing a non-synthesis unit is a named refusal, not a check that quietly passes", async () => {
  const planned = await run();
  const leafish = childrenOf(planned)[0]!;
  const unit = planned.view.byId.get(leafish)!;
  assert.throws(() => auditSynthesisBacklink({ unit, claims: [], children: [] }),
    /is a appendix, which writes from its own topics; only a synthesis has its claims traced back to children/);
});

test("a permitted set built from the wrong children is refused rather than used", async () => {
  const planned = await run();
  const unit = planned.view.byId.get(synthesisOf(planned))!;
  assert.throws(() => auditSynthesisBacklink({ unit, claims: [], children: [{ childUnitId: "not::a::child", claims: [] }] }),
    /writes from children \[.*\] but its claims were checked against \[not::a::child\]; a permitted set built from the wrong children is a different rule/);
});

// --- ② the happy path: reusing a child's id is re-stating a child's fact -----------------------------

test("a synthesis reusing a child's evidence id collects, and the audit reads `complete`", async () => {
  const planned = await run();
  const synthesis = synthesisOf(planned);
  for (const childUnitId of childrenOf(planned)) {
    await checkpointUnit(planned.runDir, await draftWithClaims(planned, childUnitId, [claim(`C-${childUnitId}`, { evidenceIds: [planned.evidenceId] })]));
  }
  await checkpointUnit(planned.runDir, await draftWithClaims(planned, synthesis, [claim("C-synthesis", { evidenceIds: [planned.evidenceId] })]));
  const ledger = await readUnitLedger(planned.runDir, planned.manifest.id);
  assert.ok(ledger.units.some((row) => row.unitId === synthesis), "the synthesis is recorded");

  const result = await auditSynthesisBacklinkFromDisk(planned.runDir, planned.view.byId.get(synthesis)!);
  assert.equal(result.verdict.conclusion, "complete");
  assert.deepEqual([...result.referenced], [`evidenceIds:${planned.evidenceId}`]);
  assert.deepEqual([...result.violations], []);
  assert.match(summariseSynthesisBacklink(result), /^complete: every one of the 1 evidence\/trace id\(s\) synthesis unit .* is cited by one of its 1 child unit\(s\)/);
});

// --- ③ the negative fixture: a new id is a new fact -------------------------------------------------

test("a synthesis citing an evidence id no child cites is refused by name at collect, and the receipt stays", async () => {
  // Its OWN run: the happy-path test above already collected the shared run's synthesis, and a refusal has to be
  // measured on a synthesis that is not in the ledger yet.
  const planned = await plannedRun(["product"]);
  const synthesis = synthesisOf(planned);
  for (const childUnitId of childrenOf(planned)) {
    await checkpointUnit(planned.runDir, await draftWithClaims(planned, childUnitId, [claim(`C-${childUnitId}`, { evidenceIds: [planned.evidenceId] })]));
  }
  // A REAL frozen record of this run, just not one any child of this synthesis cited. That is the honest shape of
  // the failure: the id resolves against `evidence.json`, so nothing else in the pipeline would have complained.
  const catalog = JSON.parse(await readFile(join(planned.runDir, "evidence.json"), "utf8")) as { evidence: { id: string }[] };
  const stolen = catalog.evidence.map((item) => item.id).find((id) => id !== planned.evidenceId);
  assert.ok(stolen, "the run must hold a second frozen evidence record for this fixture to be about a real id");
  await draftUnit(planned.runDir, await draftWithClaims(planned, synthesis, [claim("C-invented", { evidenceIds: [stolen!] })]));
  await assert.rejects(collectUnits(planned.runDir), (error: Error) => {
    assert.match(error.message, new RegExp(`Unit "${synthesis}" cannot be collected: violations:`));
    assert.ok(error.message.includes("C-invented"), "the refusal names the offending claim");
    assert.ok(error.message.includes(stolen!), "and the offending id");
    assert.match(error.message, /a synthesis may re-state a child's fact by reusing the child's own id, and a new id is a new fact it is not allowed to add/);
    assert.match(error.message, /Move the fact into the child that owns it, or cite that child's own id/);
    return true;
  });
  assert.equal(await exists(unitPaths(planned.runDir, synthesis).receipt), true, "the receipt stays, so a corrected draft can be collected");
  const ledger = await readUnitLedger(planned.runDir, planned.manifest.id);
  assert.ok(!ledger.units.some((row) => row.unitId === synthesis), "a refused synthesis is not recorded");

  // And the corrected re-draft collects: there is no permanently ruined state.
  await draftUnit(planned.runDir, await draftWithClaims(planned, synthesis, [claim("C-invented", { evidenceIds: [planned.evidenceId] })]));
  const collected = await collectUnits(planned.runDir);
  assert.deepEqual(collected.collected.map((receipt) => receipt.unitId), [synthesis]);
});

test("a trace id is checked the same way an evidence id is", async () => {
  const planned = await run();
  const unit = planned.view.byId.get(synthesisOf(planned))!;
  const child = childrenOf(planned)[0]!;
  const result = auditSynthesisBacklink({
    unit,
    claims: [claim("C-1", { traceIds: ["T-child"] }), claim("C-2", { traceIds: ["T-invented"] })],
    children: [{ childUnitId: child, claims: [claim("C-child", { traceIds: ["T-child"] })] }]
  });
  assert.equal(result.verdict.conclusion, "violations");
  assert.deepEqual(result.violations.map((row) => [row.claimId, row.field, row.id]), [["C-2", "traceIds", "T-invented"]]);
  assert.match(result.violations[0]!.problem, /cites trace id "T-invented", which none of its children/);
});

test("an evidence id a child cites under traceIds does not license citing it as evidence", async () => {
  const planned = await run();
  const unit = planned.view.byId.get(synthesisOf(planned))!;
  const child = childrenOf(planned)[0]!;
  const result = auditSynthesisBacklink({
    unit,
    claims: [claim("C-1", { evidenceIds: ["X-1"] })],
    children: [{ childUnitId: child, claims: [claim("C-child", { traceIds: ["X-1"] })] }]
  });
  assert.equal(result.verdict.conclusion, "violations", "the two ledgers are two id spaces; a trace id is not an evidence id");
});

// --- ④ the three states, and no fourth ---------------------------------------------------------------

test("a synthesis citing nothing reads `vacuous` with its source, never `complete`", async () => {
  const planned = await run();
  const unit = planned.view.byId.get(synthesisOf(planned))!;
  const child = childrenOf(planned)[0]!;
  const children = [{ childUnitId: child, claims: [claim("C-child", { evidenceIds: ["E-1"] })] }];

  const noClaims = auditSynthesisBacklink({ unit, claims: [], children });
  assert.equal(noClaims.verdict.conclusion, "vacuous");
  assert.ok(summariseSynthesisBacklink(noClaims).startsWith("vacuous: "));
  assert.match(summariseSynthesisBacklink(noClaims), /records no claim at all, so no id of its own can have left its children's/);

  const noIds = auditSynthesisBacklink({ unit, claims: [claim("C-1")], children });
  assert.equal(noIds.verdict.conclusion, "vacuous");
  assert.match(summariseSynthesisBacklink(noIds), /cite no evidence and no trace id, so nothing had to be traced back to a child \(its children cite 1\)/);
  assert.ok(!summariseSynthesisBacklink(noIds).startsWith("complete"), "an empty citation set is not a clean bill of health");
});

test("every violation is listed by id and never capped", async () => {
  const planned = await run();
  const unit = planned.view.byId.get(synthesisOf(planned))!;
  const child = childrenOf(planned)[0]!;
  const many = Array.from({ length: 40 }, (_, index) => claim(`C-${index}`, { evidenceIds: [`E-invented-${index}`] }));
  const result = auditSynthesisBacklink({ unit, claims: many, children: [{ childUnitId: child, claims: [] }] });
  assert.equal(result.verdict.conclusion, "violations");
  assert.equal(result.violations.length, 40);
  assert.equal(result.verdict.conclusion === "violations" ? result.verdict.claimIds.length : 0, 40);
});
