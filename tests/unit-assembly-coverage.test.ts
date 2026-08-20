import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { coverageStatement, type CoverageStatement } from "../src/investigation/coverage-statement.ts";
import { armShipsBecause, shippedCoverageArms } from "../src/report/unit-assembly-coverage.ts";
import { UNIT_COVERAGE_COMPANION_PATH } from "../src/report/unit-assembly-paths.ts";
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import { assembleUnits } from "../src/run/stages/unit-assemble-stage.ts";
import { collectedRun } from "./unit-assembly-fixture.ts";
import { planViewOf, unitDraftFor } from "./unit-fixture.ts";

// ASSEMBLY SHIPS EVERY ARM, AND THAT IS NOW A TYPE'S JOB (57B-434 R7c prerequisite).
//
// Before the arm split, `unit-assembly-source.ts` argued in six lines of prose why it must not refuse to assemble a
// run whose coverage statement is in the `violations` arm — an arm that held both a plan legitimately waiving a
// topic and an unread residual. That paragraph existed because the arm NAME pulled its author toward a gate three
// times. Prose cannot be run; these two tests can. The first pins one clause per arm with `assertNever` behind it,
// so a fifth arm cannot be added without answering the question. The second is the property that matters: a run
// whose coverage is DEFECTIVE assembles, and the defect is legible in the placed companion.

const LEDGER = "coverage/read-obligations.json";

function statementOf(arm: CoverageStatement["state"]): CoverageStatement {
  switch (arm) {
    case "complete":
      return coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 4, counted: 4 }, entries: [] });
    case "vacuous":
      return coverageStatement({ subject: "rows", denominator: { state: "absent", ledger: LEDGER, reason: "the file is not there" }, entries: [] });
    case "withheld":
      return coverageStatement({
        subject: "rows",
        denominator: { state: "present", ledger: LEDGER, rows: 4, counted: 1 },
        entries: [{ kind: "waived-by-state", rows: 3, ids: [], detail: "disposition omitted-for-audience" }]
      });
    case "defective":
      return coverageStatement({
        subject: "rows",
        denominator: { state: "present", ledger: LEDGER, rows: 4, counted: 1 },
        entries: [{ kind: "unread-residual", rows: 3, ids: [], detail: "no window covers them" }]
      });
  }
}

test("every arm has its own reason to be shipped, and no two share one", () => {
  const arms = ["complete", "vacuous", "withheld", "defective"] as const;
  const reasons = arms.map((arm) => {
    const statement = statementOf(arm);
    assert.equal(statement.state, arm, `the fixture must actually build the ${arm} arm`);
    return armShipsBecause(statement);
  });
  assert.equal(new Set(reasons).size, arms.length, "a shared clause means two arms were not actually distinguished");
  for (const reason of reasons) assert.ok(reason.trim().length > 0);
  // The two that matter: a withheld statement owes nothing, and a defective one owes and still ships.
  assert.match(reasons[2]!, /nobody owes them/);
  assert.match(reasons[3]!, /must still be readable/);
  assert.match(reasons[3]!, /repair set belongs to the cross-unit checker/);
  // An unregistered arm is a named throw, not a silent empty clause.
  assert.throws(
    () => armShipsBecause({ subject: "rows", ledger: LEDGER, state: "invented" } as unknown as CoverageStatement),
    /Unhandled coverage statement state state/
  );
  // The titled reading keeps the input's order and carries each statement's arm.
  const titled = shippedCoverageArms(arms.map((arm) => ({ title: `t-${arm}`, statement: statementOf(arm) })));
  assert.deepEqual(titled.map((row) => [row.title, row.state]), arms.map((arm) => [`t-${arm}`, arm]));
});

test("a run whose coverage is defective still assembles, and the defect is legible in the placed companion", async () => {
  const run = await collectedRun();
  // A real defect through the real door: the root unit re-drafted with an unknown it states about itself. That is
  // `stated-unknown`, a debt this run owes, and the only path to it is a collected unit's own summary.
  const order = run.view.collectionOrder;
  const root = order[order.length - 1]!;
  const unknown = "how the promotion window is chosen is not recorded";
  const view = await planViewOf(run.runDir);
  await checkpointUnit(run.runDir, await unitDraftFor({ ...run, view }, root, { unknowns: [unknown] }));

  // FALSIFICATION: make assembly refuse on the defective arm and this line is where it fails.
  const result = await assembleUnits(run.runDir, "write");
  const arms = result.coverageCompanion.arms;
  const defective = arms.filter((arm) => arm.state === "defective");
  assert.equal(defective.length, 1, `the fixture must reach the defective arm: ${arms.map((arm) => `${arm.state} ${arm.title}`).join(" | ")}`);
  assert.match(defective[0]!.title, /Written units/);
  assert.match(defective[0]!.shippedBecause, /must still be readable/);
  // Every statement the companion holds got an arm: nothing was skipped on the way through.
  assert.equal(arms.length, new Set(arms.map((arm) => arm.title)).size);
  assert.ok(arms.every((arm) => arm.shippedBecause.trim() !== ""));

  // And the debt is in the bytes a reader gets, under the defective wording rather than the covered one.
  const coverage = await readFile(join(run.runDir, ...UNIT_COVERAGE_COMPANION_PATH.split("/")), "utf8");
  const line = coverage.split("\n").find((row) => row.startsWith("defective: ") && row.includes("collected units"));
  assert.ok(line, coverage.split("\n").filter((row) => row.includes("collected units")).join("\n"));
  assert.ok(coverage.includes("unknowns the written units state about themselves"), coverage);
  assert.ok(coverage.includes(unknown), "the unknown itself reaches the reader, not just its count");
});
