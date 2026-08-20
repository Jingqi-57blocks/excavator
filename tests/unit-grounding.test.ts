import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InvestigationWorkItem, SectionClaim, WorkItemStatus } from "../src/base/types.ts";
import { exists } from "../src/base/util.ts";
import type { PlanCatalogUnit } from "../src/report/plan-artifacts.ts";
import type { MaterialObligationTopics } from "../src/report/plan-obligation-conservation.ts";
import { auditUnitGrounding, summariseUnitGrounding } from "../src/report/unit-grounding-audit.ts";
import { assertReachMatchesAccounting, readUnitGrounding, readUnitGroundingForRun } from "../src/report/unit-grounding-reading.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import { readUnitLedger } from "../src/report/unit-ledger.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import {
  MINI_FOUND_ONE_EVIDENCE, MINI_FOUND_TWO_EVIDENCE, MINI_SEARCHED_NOT_FOUND,
  claimFor, materialisedRun, miniPlan, unitDraftWithClaims, type MaterialisedRun, type MiniPlan
} from "./unit-grounding-fixture.ts";

/**
 * R4b - the unit grounding audit: gate 1b, evaluated the moment a unit is completed.
 *
 * The rules are the section path's (`section-audit.ts`), ported without a change of strength, and the negative
 * fixtures below are one per rule. What is NEW is that they run at unit completion instead of document completion:
 * 57B-453 measured 28% mis-grounded obligations sitting invisible behind `audit --document`'s "work-item coverage
 * was not evaluated", and this is the window that closes.
 *
 * Two things this suite deliberately does NOT assert, because R4b cannot keep the promise: that an obligation is
 * disposed of exactly once across a document (R5 owns primary ownership), and anything about an output budget (no
 * authority for one exists yet).
 */

const LEAF_FEATURE = "overview-product::leaf::feature";
const LEAF_DIMENSION = "overview-product::leaf::work-item-dimension";
const APPENDIX = "overview-product::appendix::coverage";
const SYNTHESIS = "overview-product::synthesis::document";

let sharedMini: Promise<MiniPlan> | null = null;
function mini(): Promise<MiniPlan> { return (sharedMini ??= miniPlan()); }

function auditWith(plan: MiniPlan, unitId: string, claims: readonly SectionClaim[], workItems = plan.workItems) {
  return auditUnitGrounding({ unit: plan.unitsById.get(unitId)!, obligations: plan.obligations, workItems, claims });
}

/** Claims that ground the mini fixture's three material obligations, each by its own status's rule. */
function groundingClaims(): SectionClaim[] {
  return [
    claimFor("C-1", MINI_FOUND_TWO_EVIDENCE, { evidenceIds: ["S-bbbbbbbbbb"] }),
    claimFor("C-2", MINI_FOUND_ONE_EVIDENCE, { evidenceIds: ["S-cccccccccc"] }),
    claimFor("C-3", MINI_SEARCHED_NOT_FOUND, { marker: "verified", evidenceIds: ["S-eeeeeeeeee"] })
  ];
}

// --- (1) the happy path, per status ------------------------------------------------------------------

test("a unit that grounds every reachable material obligation reads `complete`", async () => {
  const plan = await mini();
  const result = auditWith(plan, LEAF_FEATURE, groundingClaims());
  assert.equal(result.verdict.conclusion, "complete");
  assert.deepEqual([...result.reachable].sort(), [MINI_FOUND_ONE_EVIDENCE, MINI_FOUND_TWO_EVIDENCE, MINI_SEARCHED_NOT_FOUND].sort());
  assert.equal(result.grounded.length, 3);
  assert.deepEqual([...result.openOriginExempt], []);
  assert.equal(result.groundingDenominator, 3);
  assert.match(summariseUnitGrounding(result), /^complete: unit overview-product::leaf::feature grounds all 3 material obligation\(s\) it owes \(0 open-origin exempt, 3 reachable\)$/);
});

test("a `found` obligation may be grounded by its trace id instead of its evidence id", async () => {
  const plan = await mini();
  const claims = groundingClaims();
  claims[0] = claimFor("C-1", MINI_FOUND_TWO_EVIDENCE, { evidenceIds: [], traceIds: ["T-1111111111"] });
  assert.equal(auditWith(plan, LEAF_FEATURE, claims).verdict.conclusion, "complete");
});

// --- (2) one negative fixture per rule ---------------------------------------------------------------

test("a material obligation with no linked claim is a named violation", async () => {
  const plan = await mini();
  const claims = groundingClaims().slice(1);
  const result = auditWith(plan, LEAF_FEATURE, claims);
  assert.equal(result.verdict.conclusion, "violations");
  assert.deepEqual(result.verdict.conclusion === "violations" ? [...result.verdict.obligationIds] : [], [MINI_FOUND_TWO_EVIDENCE]);
  assert.match(result.ungrounded[0]!.problem, /is represented by no claim of unit "overview-product::leaf::feature"/);
});

test("a `found` obligation whose claim reuses neither its evidence nor its trace is a named violation", async () => {
  const plan = await mini();
  const claims = groundingClaims();
  // S-dddddddddd is a real frozen record - it just belongs to a DIFFERENT obligation. This is 57B-453's measured
  // failure exactly: the author cited a window that covers the function but is not the one bound to it.
  claims[0] = claimFor("C-1", MINI_FOUND_TWO_EVIDENCE, { evidenceIds: ["S-dddddddddd"], traceIds: ["T-9999999999"] });
  const result = auditWith(plan, LEAF_FEATURE, claims);
  assert.equal(result.verdict.conclusion, "violations");
  assert.match(result.ungrounded[0]!.problem, /has no linked claim that reuses one of ITS OWN evidence ids or one of ITS OWN trace ids in unit/);
});

test("a `searched-not-found` obligation needs a linked verified claim citing its search receipt", async () => {
  const plan = await mini();
  const claims = groundingClaims();
  claims[2] = claimFor("C-3", MINI_SEARCHED_NOT_FOUND, { marker: "fact", evidenceIds: ["S-eeeeeeeeee"] });
  assert.match(auditWith(plan, LEAF_FEATURE, claims).ungrounded[0]!.problem, /has no linked claim marked `verified` that reuses one of its own evidence ids \(its search receipt\)/);
  claims[2] = claimFor("C-3", MINI_SEARCHED_NOT_FOUND, { marker: "verified", evidenceIds: ["S-dddddddddd"] });
  assert.equal(auditWith(plan, LEAF_FEATURE, claims).verdict.conclusion, "violations", "a verified claim citing another obligation's receipt is not grounding");
});

test("an unresolved obligation needs a linked unavailable or verified claim", () => {
  for (const status of ["cannot-determine", "not-applicable"] as const) {
    const bench = synthetic(status);
    assert.match(auditUnitGrounding({ ...bench, claims: [claimFor("C", "W-1", { marker: "fact" })] }).ungrounded[0]!.problem,
      /has no linked claim marked `unavailable` or `verified`/);
    for (const marker of ["unavailable", "verified"] as const) {
      assert.equal(auditUnitGrounding({ ...bench, claims: [claimFor("C", "W-1", { marker })] }).verdict.conclusion, "complete", `${status} accepts ${marker}`);
    }
  }
});

test("an open determination needs a linked claim and nothing more - the section path's own strength, not more", () => {
  for (const status of ["pending", "in_progress"] as const) {
    const bench = synthetic(status);
    assert.equal(auditUnitGrounding({ ...bench, claims: [claimFor("C", "W-1", { marker: "fact" })] }).verdict.conclusion, "complete");
    assert.equal(auditUnitGrounding({ ...bench, claims: [] }).verdict.conclusion, "violations");
  }
});

// --- (3) the three states, and the fourth that does not exist ---------------------------------------

test("a unit that reaches no material obligation reads `vacuous` with its source, never `complete`", async () => {
  const plan = await mini();
  for (const unitId of [APPENDIX, SYNTHESIS]) {
    const result = auditWith(plan, unitId, []);
    assert.equal(result.verdict.conclusion, "vacuous", `${unitId}`);
    assert.equal(result.reachable.length, 0);
    const line = summariseUnitGrounding(result);
    assert.ok(line.startsWith("vacuous: "), line);
    assert.ok(!line.startsWith("complete"), "a vacuous unit must not render with the complete wording");
  }
  assert.match(summariseUnitGrounding(auditWith(plan, SYNTHESIS, [])), /names no topic — it writes from its children's summaries/);
  assert.match(summariseUnitGrounding(auditWith(plan, APPENDIX, [])), /appendix unit .* names 7 topic\(s\), none of which binds a material obligation/);
});

// --- (4) the open-origin bucket: the denominator fork this slice closes ------------------------------

test("an open-origin material obligation lands in a counted, named bucket - exempt, not silently dropped", () => {
  const bench = synthetic("found", { origin: "open" });
  const result = auditUnitGrounding({ ...bench, claims: [] });
  assert.equal(result.verdict.conclusion, "vacuous", "the only reachable obligation is exempt, so nothing was owed");
  assert.equal(result.groundingDenominator, 0);
  assert.match(summariseUnitGrounding(result), /every one of them carries origin "open" in this run's obligation ledger, which the grounding denominator has always excluded/);
  assert.deepEqual([...result.openOriginExempt], [{ workItemId: "W-1", dimension: "decision-function", status: "found" }]);
  assert.deepEqual([...result.ungrounded], [], "an exempt obligation is not a violation");
  assert.deepEqual([...result.reachable], ["W-1"], "and it is still IN the denominator's reach list, not deleted from it");

  // The paired case is what makes the exemption a branch rather than a coincidence: the SAME input with the
  // ledger's own `origin: "default"` is a violation.
  const paired = auditUnitGrounding({ ...synthetic("found", { origin: "default" }), claims: [] });
  assert.equal(paired.verdict.conclusion, "violations");
  assert.deepEqual([...paired.openOriginExempt], []);
});

test("a mixed unit conserves: reachable = grounded + open-origin exempt + ungrounded", () => {
  const bench = synthetic("found");
  const second: InvestigationWorkItem = { ...bench.workItems.get("W-1")!, id: "W-2", origin: "open" };
  const third: InvestigationWorkItem = { ...bench.workItems.get("W-1")!, id: "W-3" };
  const workItems = new Map([...bench.workItems, ["W-2", second], ["W-3", third]]);
  const obligations: MaterialObligationTopics[] = [
    ...bench.obligations,
    { workItemId: "W-2", dimension: second.dimension, topicIds: ["T-topic"], binding: { workItemId: "W-2", dimension: second.dimension, status: second.status, material: true, evidenceIds: second.evidenceIds, traceIds: [] } },
    { workItemId: "W-3", dimension: third.dimension, topicIds: ["T-topic"], binding: { workItemId: "W-3", dimension: third.dimension, status: third.status, material: true, evidenceIds: third.evidenceIds, traceIds: [] } }
  ];
  const result = auditUnitGrounding({ unit: bench.unit, obligations, workItems, claims: [claimFor("C", "W-1", { evidenceIds: ["E-1"] })] });
  assert.equal(result.reachable.length, 3);
  assert.equal(result.grounded.length + result.openOriginExempt.length + result.ungrounded.length, 3);
  assert.deepEqual(result.openOriginExempt.map((row) => row.workItemId), ["W-2"]);
  assert.deepEqual(result.ungrounded.map((row) => row.workItemId), ["W-3"]);
});

// --- (5) the lookup is same-ledger equality, and it fails closed ------------------------------------

test("an obligation with no row in this run's ledger is fatal, not quietly ungrounded", () => {
  const bench = synthetic("found");
  assert.throws(() => auditUnitGrounding({ ...bench, workItems: new Map(), claims: [] }),
    /reaches material obligation "W-1", which this run's workitems.json does not hold; the topic catalog and the obligation ledger disagree/);
});

test("a binding that disagrees with its own ledger row is fatal, and the message prints both sides", () => {
  const bench = synthetic("found");
  const drifted = new Map(bench.workItems);
  drifted.set("W-1", { ...bench.workItems.get("W-1")!, status: "cannot-determine", evidenceIds: ["E-9"] });
  assert.throws(() => auditUnitGrounding({ ...bench, workItems: drifted, claims: [] }), (error: Error) => {
    assert.match(error.message, /is recorded differently by the topic catalog and by workitems.json/);
    assert.match(error.message, /the binding records status "found", the ledger "cannot-determine"/);
    assert.match(error.message, /the binding records evidenceIds \[E-1\], the ledger \[E-9\]/);
    return true;
  });
});

// --- (6) collect is where it runs, and a refusal is never permanent ---------------------------------

let sharedRun: Promise<MaterialisedRun> | null = null;
function run(): Promise<MaterialisedRun> { return (sharedRun ??= materialisedRun()); }

function dimensionUnit(materialised: MaterialisedRun): PlanCatalogUnit {
  const unitId = materialised.view.collectionOrder.find((id) => id.endsWith("::leaf::work-item-dimension"));
  assert.ok(unitId, "the materialised run must have a work-item-dimension leaf");
  return materialised.view.byId.get(unitId!)!;
}

test("collect refuses a unit that leaves a material obligation ungrounded, names it, and leaves the receipt", async () => {
  const materialised = await run();
  const unit = dimensionUnit(materialised);
  // Links both obligations but cites the wrong evidence for the `found` one and the wrong marker for the other -
  // exactly the two failures a real author makes.
  const wrong: SectionClaim[] = [
    claimFor("C-found", materialised.foundWorkItemId, { evidenceIds: [] }),
    claimFor("C-unresolved", materialised.unresolvedWorkItemId, { marker: "fact" })
  ];
  await draftUnit(materialised.runDir, await unitDraftWithClaims(materialised, unit.unitId, wrong));
  await assert.rejects(collectUnits(materialised.runDir), (error: Error) => {
    assert.match(error.message, new RegExp(`Unit "${unit.unitId}" cannot be collected: violations:`));
    assert.ok(error.message.includes(materialised.foundWorkItemId), "the refusal names the ungrounded obligation");
    assert.ok(error.message.includes(materialised.unresolvedWorkItemId));
    assert.match(error.message, /its receipt is left in place/);
    return true;
  });
  assert.equal(await exists(unitPaths(materialised.runDir, unit.unitId).receipt), true, "the receipt stays, so a corrected draft can be collected");
  const ledger = await readUnitLedger(materialised.runDir, materialised.manifest.id);
  assert.deepEqual(ledger.units.map((row) => row.unitId), [], "a refused unit is not recorded");
});

test("the corrected re-draft collects, and there is no permanently ruined state", async () => {
  const materialised = await run();
  const unit = dimensionUnit(materialised);
  const right: SectionClaim[] = [
    claimFor("C-found", materialised.foundWorkItemId, { evidenceIds: [materialised.foundEvidenceId] }),
    claimFor("C-unresolved", materialised.unresolvedWorkItemId, { marker: "unavailable" })
  ];
  await draftUnit(materialised.runDir, await unitDraftWithClaims(materialised, unit.unitId, right));
  const collected = await collectUnits(materialised.runDir);
  assert.deepEqual(collected.collected.map((receipt) => receipt.unitId), [unit.unitId]);
  const ledger = await readUnitLedger(materialised.runDir, materialised.manifest.id);
  assert.deepEqual(ledger.units.map((row) => row.unitId), [unit.unitId]);
});

test("a unit that reaches no material obligation still collects - vacuous is not a failure", async () => {
  const materialised = await run();
  const appendix = materialised.view.collectionOrder.find((unitId) => materialised.view.byId.get(unitId)!.kind === "appendix")!;
  const result = await checkpointUnit(materialised.runDir, await unitDraftWithClaims(materialised, appendix, []));
  assert.ok(result.collected.collected.some((receipt) => receipt.unitId === appendix));
});

// --- (7) the run-level reading: one denominator, and the fifth bucket visible -----------------------

test("the run-level reading reads the plan's own accounting and matches it field for field", async () => {
  const materialised = await run();
  const reading = await readUnitGroundingForRun(materialised.runDir);
  assert.deepEqual(reading.accounting, materialised.view.planCatalog.obligationAccounting,
    "the reading does not compute a second accounting; it reads the recorded one");
  assert.equal(reading.accounting.inUnits + reading.accounting.waived + reading.accounting.unplaced + reading.accounting.undispositioned,
    reading.accounting.materialObligations, "the four buckets conserve");
  assert.deepEqual([...reading.openOriginExempt], [], "this run has no open-origin material obligation");
  assert.equal(reading.units.length + reading.unwritten.length, materialised.view.units.length,
    "every planned unit is either audited or named as unwritten");
  assert.ok(reading.unwritten.length > 0, "units nobody has written are named, not counted as clean");
  assert.match(reading.summary, /material obligation\(s\).*in units.*open-origin and exempt from grounding/);
});

test("the reachability check is a same-source assertion, and a tampered accounting fails it", async () => {
  const materialised = await run();
  const accounting = materialised.view.planCatalog.obligationAccounting;
  assertReachMatchesAccounting(materialised.view, accounting);
  assert.throws(() => assertReachMatchesAccounting(materialised.view, { ...accounting, inUnits: accounting.inUnits - 1 }),
    /does not match its own lists/);
});

test("the reading is a read: it writes nothing into the run", async () => {
  const materialised = await run();
  const before = await readFile(join(materialised.runDir, "run.json"), "utf8");
  await readUnitGrounding(materialised.runDir, materialised.view);
  assert.equal(await readFile(join(materialised.runDir, "run.json"), "utf8"), before);
});

/**
 * A hand-built audit bench: one unit, one topic, one material obligation of the status under test.
 *
 * Pure inputs, because the audit is a pure function and the statuses the mini fixture does not carry
 * (`cannot-determine`, `not-applicable`, `pending`, `in_progress`) have to be exercised somewhere. The binding and
 * the ledger row are built from ONE literal so they cannot silently disagree - the disagreement is what the
 * negative fixture above constructs deliberately.
 */
function synthetic(status: WorkItemStatus, overrides: Partial<InvestigationWorkItem> = {}): {
  unit: PlanCatalogUnit;
  obligations: readonly MaterialObligationTopics[];
  workItems: ReadonlyMap<string, InvestigationWorkItem>;
} {
  const item: InvestigationWorkItem = {
    id: "W-1",
    dimension: "decision-function",
    scope: "feature:x",
    hypothesis: "h",
    status,
    material: true,
    requiredFor: ["doc"],
    evidenceIds: ["E-1"],
    traceIds: [],
    origin: "default",
    ...overrides
  };
  return {
    unit: { unitId: "doc::leaf::x", documentId: "doc", kind: "leaf", title: "x", topics: [{ topicId: "T-topic", topicDigest: "0".repeat(64) }], childUnitIds: [] },
    obligations: [{
      workItemId: item.id,
      dimension: item.dimension,
      topicIds: ["T-topic"],
      binding: { workItemId: item.id, dimension: item.dimension, status: item.status, material: item.material, evidenceIds: item.evidenceIds, traceIds: item.traceIds }
    }],
    workItems: new Map([[item.id, item]])
  };
}
