/**
 * R7c - the repair set (`unit-repair-set.ts`): exact, conserving, and NOT driven by the coverage account.
 *
 * THE SHARPEST TEST IN THIS FILE is `stated-unknown`. It is a `defective` coverage kind whose ids are UNIT IDS —
 * the units whose summary states an unknown about themselves — so it is the one entry a repair set built from the
 * defective arm would swallow, and swallowing it would mean "you are being redrawn for having been honest". The
 * test asserts those units stay out. The narrowing is stated in the module header with the per-kind reasoning; here
 * it is asserted.
 *
 * EXACTNESS IS ASSERTED AS SET EQUALITY, id for id, both directions — a repair set that names one unit too many is
 * a defect of the same kind as one that names one too few, and only equality catches both.
 *
 * THE TWO CONSERVATION EQUATIONS are exercised from the outside where they are reachable (a finding naming a unit
 * the plan does not hold) and their statements are compared byte for byte, so a silently reworded account moves
 * this test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  coverageEntry,
  coverageStatement,
  type CoverageEntry,
  type CoverageStatement
} from "../src/investigation/coverage-statement.ts";
import type { TitledCoverageStatement } from "../src/report/coverage-companion.ts";
import type { ConsistencyFinding } from "../src/report/unit-consistency.ts";
import {
  UNIT_REPAIR_SET_VERSION,
  coverageRepairRoute,
  deriveUnitRepairPlan,
  type RepairPlanUnit,
  type UnitRepairPlan
} from "../src/report/unit-repair-set.ts";

const DOCUMENT = "overview-product";
const LEAF_A = `${DOCUMENT}::leaf::a`;
const LEAF_B = `${DOCUMENT}::leaf::b`;
const MID = `${DOCUMENT}::synthesis::mid`;
const ROOT = `${DOCUMENT}::synthesis::document`;
const APPENDIX = `${DOCUMENT}::appendix::coverage`;

/** A three-level plan: two leaves under a mid synthesis, that plus an appendix under the root. */
const PLAN: readonly RepairPlanUnit[] = [
  { unitId: LEAF_A, documentId: DOCUMENT, kind: "leaf", childUnitIds: [] },
  { unitId: LEAF_B, documentId: DOCUMENT, kind: "leaf", childUnitIds: [] },
  { unitId: APPENDIX, documentId: DOCUMENT, kind: "appendix", childUnitIds: [] },
  { unitId: MID, documentId: DOCUMENT, kind: "synthesis", childUnitIds: [LEAF_A, LEAF_B] },
  { unitId: ROOT, documentId: DOCUMENT, kind: "synthesis", childUnitIds: [APPENDIX, MID] }
];

function drift(unitIds: readonly string[]): ConsistencyFinding {
  return {
    kind: "terminology-drift",
    documentId: DOCUMENT,
    unitIds: [...unitIds],
    severity: "error",
    statement: `document ${DOCUMENT} defines term "tenant" with 2 different meanings`,
    term: "tenant",
    definitions: unitIds.map((unitId) => ({ unitId, term: "tenant", meaning: unitId }))
  };
}

function overclaim(unitId: string): ConsistencyFinding {
  return {
    kind: "unknown-overclaim",
    documentId: DOCUMENT,
    unitIds: [unitId],
    severity: "error",
    statement: `unit ${unitId} states claim F-1 as "fact" on an unanswered obligation`,
    claimId: "F-1",
    marker: "fact",
    workItemId: "project:unanswered",
    workItemStatus: "cannot-determine"
  };
}

function derive(findings: readonly ConsistencyFinding[], coverage: readonly TitledCoverageStatement[] = []): UnitRepairPlan {
  return deriveUnitRepairPlan({ planned: PLAN, findings, coverage });
}

function ids(plan: UnitRepairPlan): readonly string[] {
  return plan.targets.map((target) => target.unitId);
}

/** A statement over a present denominator carrying exactly the given entries. */
function statementWith(entries: readonly (CoverageEntry | undefined)[], counted = 4): CoverageStatement {
  return coverageStatement({
    subject: "material obligations",
    denominator: { state: "present", ledger: "a synthetic ledger", rows: 10, counted },
    entries
  });
}

// --- exactness ----------------------------------------------------------------------------------------

test("a finding on one leaf repairs that leaf and every unit written from it, and nothing else", () => {
  const plan = derive([overclaim(LEAF_A)]);
  assert.equal(plan.version, UNIT_REPAIR_SET_VERSION);
  // Ascending by unit id, which puts `synthesis::document` before `synthesis::mid`.
  assert.deepEqual(ids(plan), [LEAF_A, ROOT, MID]);
  // Exact in both directions: the sibling leaf and the appendix are NOT redrawn.
  assert.deepEqual(PLAN.map((unit) => unit.unitId).filter((unitId) => !ids(plan).includes(unitId)).sort(), [APPENDIX, LEAF_B].sort());
  assert.equal(plan.targets[0]!.reason.cause, "named-by-finding");
  const named = plan.targets[0]!.reason;
  assert.deepEqual(named.cause === "named-by-finding" ? named.findingKinds : null, ["unknown-overclaim"]);
  assert.match(named.cause === "named-by-finding" ? named.statements[0]! : "", /no collect gate catches this because both grounding gates ask whether a satisfying claim EXISTS/);
  const mid = plan.targets.find((target) => target.unitId === MID)!;
  assert.equal(mid.reason.cause, "written-from-a-repaired-unit");
  assert.deepEqual(mid.reason.cause === "written-from-a-repaired-unit" ? mid.reason.viaChildUnitIds : null, [LEAF_A]);
  assert.match(mid.reason.cause === "written-from-a-repaired-unit" ? mid.reason.statement : "", /makes the run uncollectable at this unit's next collect/);
});

test("a finding naming two units repairs both, and the parent's reason names both children", () => {
  const plan = derive([drift([LEAF_A, LEAF_B])]);
  assert.deepEqual(ids(plan), [LEAF_A, LEAF_B, ROOT, MID]);
  const mid = plan.targets.find((target) => target.unitId === MID)!;
  assert.deepEqual(mid.reason.cause === "written-from-a-repaired-unit" ? mid.reason.viaChildUnitIds : null, [LEAF_A, LEAF_B]);
});

test("two classes naming one unit give it one target row carrying both, in the union's order", () => {
  const plan = derive([overclaim(LEAF_A), drift([LEAF_A, LEAF_B])]);
  assert.deepEqual(ids(plan), [LEAF_A, LEAF_B, ROOT, MID]);
  const leaf = plan.targets[0]!.reason;
  assert.deepEqual(leaf.cause === "named-by-finding" ? leaf.findingKinds : null, ["terminology-drift", "unknown-overclaim"]);
  assert.equal(leaf.cause === "named-by-finding" ? leaf.statements.length : 0, 2);
});

test("a finding on the root repairs only the root: there is nothing above it", () => {
  assert.deepEqual(ids(derive([overclaim(ROOT)])), [ROOT]);
});

test("no finding is an empty repair set with the action saying so, not a rewrite", () => {
  const plan = derive([]);
  assert.deepEqual(plan.targets, []);
  assert.equal(plan.action, "nothing to repair: the checker found no cross-unit defect, so no unit needs to be written again");
  assert.deepEqual(plan.conservation.statements, [
    "every finding's units are in the repair set: 0 finding(s) naming 0 unit(s), all present",
    "the repair set is inside the plan: 0 = 0 named + 0 written-from, of 5 planned unit(s)"
  ]);
});

test("the action names units and offers no whole-document rewrite", () => {
  const plan = derive([overclaim(LEAF_A)]);
  assert.match(plan.action, /re-draft and re-collect exactly these 3 unit\(s\)/);
  assert.match(plan.action, /there is no whole-document rewrite to ask for/);
  for (const unitId of ids(plan)) assert.ok(plan.action.includes(unitId), `the action must name ${unitId}`);
});

// --- conservation --------------------------------------------------------------------------------------

test("both equations are stated with their counts, and they add up", () => {
  const plan = derive([drift([LEAF_A, LEAF_B])]);
  assert.deepEqual(plan.conservation, {
    findings: 1,
    namedUnits: 2,
    ancestors: 2,
    plannedUnits: 5,
    statements: [
      "every finding's units are in the repair set: 1 finding(s) naming 2 unit(s), all present",
      "the repair set is inside the plan: 4 = 2 named + 2 written-from, of 5 planned unit(s)"
    ]
  });
  assert.equal(plan.conservation.namedUnits + plan.conservation.ancestors, plan.targets.length);
});

test("a finding naming a unit the plan does not hold is a named refusal, not a dropped row", () => {
  assert.throws(
    () => derive([overclaim(`${DOCUMENT}::leaf::gone`)]),
    /names unit "overview-product::leaf::gone", which the plan now in force does not hold/
  );
});

test("a finding naming no unit at all is refused as the checker's own failure", () => {
  assert.throws(() => derive([drift([])]), /names no unit, so it cannot be repaired by anyone/);
});

test("a plan holding one unit twice is refused before anything is derived", () => {
  assert.throws(
    () => deriveUnitRepairPlan({ planned: [...PLAN, PLAN[0]!], findings: [], coverage: [] }),
    /holds "overview-product::leaf::a" twice/
  );
});

// --- the coverage account is routed, never seeded -----------------------------------------------------

test("a withheld-only run has an empty repair set and its rows are declared unrepairable", () => {
  const withheld = statementWith([coverageEntry("waived-by-state", 6, [], "disposition omitted-for-audience")], 4);
  assert.equal(withheld.state, "withheld");
  const plan = derive([], [{ title: "Material obligations: where the plan puts them", statement: withheld }]);
  assert.deepEqual(plan.targets, []);
  assert.deepEqual(plan.coverage.map((row) => row.route.route), ["withheld-by-a-recorded-decision"]);
  assert.match(plan.coverage[0]!.route.clause, /left this answer's scope by a decision this run recorded; a repair set may never contain them/);
});

test("a defective run has an empty repair set too, and the debt is routed with its kinds", () => {
  const defective = statementWith([
    coverageEntry("unread-residual", 3, [], "3 unread line(s) across them"),
    coverageEntry("waived-by-state", 2, [], "disposition not-applicable")
  ], 5);
  assert.equal(defective.state, "defective");
  const plan = derive([], [{ title: "Read obligations: which have a source window", statement: defective }]);
  assert.deepEqual(plan.targets, [], "no coverage arm seeds a repair: every defective kind is owed by the reading, the ledger's determinations or the plan");
  const route = plan.coverage[0]!.route;
  assert.equal(route.route, "owed-outside-unit-authoring");
  assert.deepEqual(route.route === "owed-outside-unit-authoring" ? route.kinds : null, ["unread-residual"],
    "the withheld entries riding along on a defective statement are not part of its debt");
  assert.equal(route.route === "owed-outside-unit-authoring" ? route.owedRows : null, 3);
});

test("a stated-unknown entry names units and NONE of them enters the repair set", () => {
  // The one defective kind whose ids are unit ids. A repair set built from the defective arm would redraw a unit
  // for stating an unknown about itself, and the only way a redraw removes the row is by deleting the statement.
  const stated = coverageStatement({
    subject: "collected units",
    denominator: { state: "present", ledger: "units/collected.json", rows: 5, counted: 3 },
    entries: [coverageEntry("stated-unknown", 2, [LEAF_A, LEAF_B], "3 unknown statement(s) across them")]
  });
  assert.equal(stated.state, "defective");
  assert.deepEqual(stated.state === "defective" ? stated.defects[0]!.ids : null, [LEAF_A, LEAF_B]);
  const plan = derive([], [{ title: "Written units: which state an unknown about themselves", statement: stated }]);
  assert.deepEqual(plan.targets, []);
  assert.deepEqual(ids(plan), []);
});

test("all four arms are routed, and complete and vacuous both read as nothing owed", () => {
  const complete = statementWith([], 10);
  const vacuous = coverageStatement({
    subject: "read obligations",
    denominator: { state: "absent", ledger: "coverage/read-obligations.json", reason: "this run minted none" },
    entries: []
  });
  assert.equal(complete.state, "complete");
  assert.equal(vacuous.state, "vacuous");
  assert.deepEqual(
    [complete, vacuous].map((statement) => coverageRepairRoute(statement).route),
    ["nothing-owed", "nothing-owed"]
  );
  // The two clauses are DIFFERENT sentences: "every row accounted for" and "no denominator at all" are not one fact.
  assert.notEqual(coverageRepairRoute(complete).clause, coverageRepairRoute(vacuous).clause);
  const withheld = statementWith([coverageEntry("ledger-excluded", 1, [], "declaration-only")], 9);
  const defective = statementWith([coverageEntry("undispositioned", 1, ["project:x"], "a topic carrying no readable disposition")], 9);
  assert.deepEqual(
    [withheld, defective].map((statement) => coverageRepairRoute(statement).route),
    ["withheld-by-a-recorded-decision", "owed-outside-unit-authoring"]
  );
});

test("the plan is deterministic: the same values twice are the same bytes", () => {
  const coverage: readonly TitledCoverageStatement[] = [
    { title: "a", statement: statementWith([coverageEntry("displaced-by-budget", 2, [], "a recorded ceiling")], 8) }
  ];
  const findings = [overclaim(LEAF_A), drift([LEAF_B, APPENDIX])];
  assert.equal(JSON.stringify(derive(findings, coverage)), JSON.stringify(derive(findings, coverage)));
});
