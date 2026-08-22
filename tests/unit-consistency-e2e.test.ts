/**
 * R7c end to end, model-free, on real runs: the gap is REAL, the checker closes it, and the repair converges.
 *
 * WHY THIS FILE EXISTS BESIDE THE VALUE-LEVEL TESTS. `tests/unit-consistency.test.ts` proves each class fires on
 * the shape it is about. What it cannot prove is the premise the whole slice stands on: that the shape SURVIVES
 * every gate a unit already passes. So every defect here is drafted and collected through `checkpointUnit` — the
 * real draft and the real collect barrier, with the summary agreement check, the output budget, the grounding audit
 * and the synthesis backlink check all running — and the run is then assembled with the real `assemble --units`.
 * A `checkpointUnit` that returns is the proof: the gates said yes.
 *
 * THE DOUBLE-DIRECTION PROOF for the unknown-overclaim vacuum is the second test. A `fact` claim linked to an
 * obligation this run recorded `cannot-determine` is collected, and `audit --units` — the read-only rerun of the
 * grounding verdict — reports the owning unit COMPLETE. Both gates green, the document asserting as settled a
 * thing the ledger says nobody could settle. Then the checker names it, with the unit.
 *
 * ANCESTORS ARE LOAD-BEARING, ASSERTED BY REMOVING THEM. Repairing only the leaf and leaving its parent alone is
 * the "smaller repair set" a reviewer would ask for, and it does not produce a smaller repair — it produces a run
 * whose synthesis records child digests of a summary that no longer exists, which the checker refuses by name.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { SectionClaim } from "../src/base/types.ts";
import { CONTENTS_ANCHOR } from "../src/report/unit-assembly.ts";
import { unitDocumentCompanionPaths, unitDocumentReportPath } from "../src/report/unit-assembly-paths.ts";
import { checkRunConsistency } from "../src/report/unit-consistency-source.ts";
import { readUnitGroundingForRun } from "../src/report/unit-grounding-reading.ts";
import { readUnitLedger } from "../src/report/unit-ledger.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import { assembleUnits } from "../src/run/stages/unit-assemble-stage.ts";
import { collectedRun } from "./unit-assembly-fixture.ts";
import {
  FIRST_DOCUMENT,
  SECOND_DOCUMENT,
  admissionRun,
  authorEveryUnit,
  recordPlan,
  requestSecondDocument,
  withExtraLeaf
} from "./unit-cache-admission-fixture.ts";
import {
  SETTLED_OBLIGATION_ID,
  UNANSWERED_OBLIGATION_IDS,
  assembledConsistencyRun,
  repairUnits,
  type ConsistencyRun,
  type UnitDraftOverride
} from "./unit-consistency-fixture.ts";

const DOCUMENT = "overview-product";
const APPENDIX = `${DOCUMENT}::appendix::coverage`;
const COVERAGE_LEAF = `${DOCUMENT}::leaf::coverage`;
const OWNER_LEAF = `${DOCUMENT}::leaf::work-item-dimension`;
const ROOT = `${DOCUMENT}::synthesis::document`;

async function cli(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/cli.ts", ...args], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((done) => child.once("exit", done));
  return { code, stdout, stderr };
}

/** Every collected unit's ledger row, by unit id — the record a "was this redrawn?" question is answered from. */
async function ledgerRows(run: ConsistencyRun): Promise<Map<string, string>> {
  const ledger = await readUnitLedger(run.runDir, run.manifest.id);
  return new Map(ledger.units.map((row) => [row.unitId, JSON.stringify(row)]));
}

// --- (1) the clean run -------------------------------------------------------------------------------

test("a clean assembled run has no finding, an empty repair set, and five established preconditions", async () => {
  const run = await assembledConsistencyRun();
  const reading = await checkRunConsistency(run.runDir);
  assert.deepEqual(reading.result.findings, []);
  assert.deepEqual(reading.repair.targets, []);
  assert.deepEqual(reading.preconditions.map((row) => `${row.name}/${row.authority}`), [
    "plan-in-force/inherited",
    "every-unit-collected/inherited",
    "ledger-promise-intact/inherited",
    "assembled-deliverable-current/asserted-here",
    "child-summary-digests-current/asserted-here"
  ]);
  // Zero findings and nothing to check are two sentences in the same reading, which is the whole point of the union.
  const statements = reading.result.readings.map((row) => row.statement);
  assert.ok(statements.some((line) => line.startsWith("checked: ")), statements.join("\n"));
  assert.ok(statements.some((line) => line.startsWith("vacuous: ")), statements.join("\n"));
  // The defective coverage arms of this run are ROUTED, not repaired: the repair set above is empty while the
  // account below owes rows.
  assert.ok(reading.repair.coverage.some((row) => row.route.route === "owed-outside-unit-authoring"),
    JSON.stringify(reading.repair.coverage.map((row) => `${row.state}/${row.route.route}`)));

  // Deterministic: two checks of one run are one byte sequence.
  assert.equal(JSON.stringify(reading), JSON.stringify(await checkRunConsistency(run.runDir)));
});

// --- (2) the unknown-overclaim vacuum, both directions ------------------------------------------------

test("a fact claim on a cannot-determine obligation passes collect AND the grounding audit, and the checker names it", async () => {
  const workItemId = UNANSWERED_OBLIGATION_IDS[0];
  const overclaim: SectionClaim = {
    id: "F-overclaim",
    marker: "fact",
    statement: `义务 ${workItemId} 的处理已确认在 24 小时内完成。`,
    workItemIds: [workItemId],
    evidenceIds: [],
    confidence: "high",
    status: "verified"
  };
  // DIRECTION ONE — the gap exists. `assembledConsistencyRun` returning at all means `checkpointUnit` accepted the
  // draft: the summary agreement check, the output budget, the grounding audit and the collect barrier all said yes.
  const run = await assembledConsistencyRun({ [OWNER_LEAF]: { extraClaims: [overclaim] } });
  const grounding = await readUnitGroundingForRun(run.runDir);
  const owner = grounding.units.find((row) => row.unitId === OWNER_LEAF)!;
  assert.equal(owner.verdict.conclusion, "complete",
    "the owning unit still grounds every obligation it owns: the required `unavailable` claim is there, and nothing forbids the `fact` claim beside it");
  assert.deepEqual(grounding.units.filter((row) => row.verdict.conclusion === "violations"), []);

  // DIRECTION TWO — the checker closes it, and names the unit.
  const reading = await checkRunConsistency(run.runDir);
  const findings = reading.result.findings.filter((finding) => finding.kind === "unknown-overclaim");
  assert.equal(findings.length, 1, JSON.stringify(reading.result.findings.map((row) => row.statement)));
  assert.deepEqual(findings[0]!.unitIds, [OWNER_LEAF]);
  assert.match(findings[0]!.statement, new RegExp(`links it to obligation ${workItemId}, which this run's ledger records as "cannot-determine"`));
  // And the repair set is that unit plus the synthesis written from it — nothing else.
  assert.deepEqual(reading.repair.targets.map((target) => target.unitId), [OWNER_LEAF, ROOT]);
});

// --- (3) the other four classes, injected on a real run ------------------------------------------------

test("a drift, a contradiction, two unresolvable references and two policy violations all survive collect", async () => {
  const overrides: Record<string, UnitDraftOverride> = {
    [APPENDIX]: {
      content: `## appendix\n\n见 [下文](#nowhere-at-all)。\n`,
      terminology: [{ term: "Tenant", meaning: "一个付费客户" }],
      extraClaims: [{ id: "U-settled", marker: "unavailable", statement: "无法判定。", workItemIds: [SETTLED_OBLIGATION_ID], reason: "not determinable here" }]
    },
    [COVERAGE_LEAF]: {
      content: `## coverage\n\n<a id="${CONTENTS_ANCHOR}"></a>\n\n修复建议见附录，请将超时下调。\n`,
      terminology: [{ term: "tenant", meaning: "一个数据库 schema" }],
      extraClaims: [{ id: "F-settled", marker: "fact", statement: "事实已确认。", workItemIds: [SETTLED_OBLIGATION_ID], evidenceIds: [] }]
    }
  };
  const run = await assembledConsistencyRun(overrides);
  // Collect and the grounding audit are both green on this run: every defect below is invisible to them.
  assert.deepEqual((await readUnitGroundingForRun(run.runDir)).units.filter((row) => row.verdict.conclusion === "violations"), []);

  const reading = await checkRunConsistency(run.runDir);
  const found = reading.result.findings;
  const statements = found.map((row) => `${row.kind}: ${row.statement}`).join("\n");
  assert.deepEqual([...new Set(found.map((row) => row.kind))].sort(), [
    "cross-unit-contradiction", "dangling-reference", "policy-violation", "terminology-drift"
  ], statements);

  const drift = found.find((row) => row.kind === "terminology-drift")!;
  assert.deepEqual(drift.unitIds, [APPENDIX, COVERAGE_LEAF]);
  const contradiction = found.find((row) => row.kind === "cross-unit-contradiction")!;
  assert.deepEqual(contradiction.unitIds, [APPENDIX, COVERAGE_LEAF]);
  assert.match(contradiction.statement, new RegExp(`both asserts and disclaims obligation ${SETTLED_OBLIGATION_ID}`));
  const references = found.filter((row) => row.kind === "dangling-reference");
  // Ascending by statement: the duplicate-anchor sentence starts with "assembled document", the link one with "unit".
  assert.deepEqual(references.map((row) => row.unitIds), [[COVERAGE_LEAF], [APPENDIX]], statements);
  const policy = found.filter((row) => row.kind === "policy-violation");
  assert.deepEqual(policy.map((row) => row.unitIds), [[COVERAGE_LEAF]], statements);
  assert.match(policy[0]!.statement, /tells the reader what to do and nothing negates it/);

  // The repair set is the two defective units and the synthesis written from them; the owner leaf is untouched.
  assert.deepEqual(reading.repair.targets.map((target) => target.unitId), [APPENDIX, COVERAGE_LEAF, ROOT]);
  assert.ok(!reading.repair.targets.some((target) => target.unitId === OWNER_LEAF));
  assert.deepEqual(reading.repair.conservation.statements, [
    `every finding's units are in the repair set: ${found.length} finding(s) naming 2 unit(s), all present`,
    "the repair set is inside the plan: 3 = 2 named + 1 written-from, of 4 planned unit(s)"
  ]);
});

test("an evidence id in visible prose violates the product lens, and the engineering lens does not carry that rule", async () => {
  const run = await assembledConsistencyRun({ [COVERAGE_LEAF]: { content: `## coverage\n\n证据 EVIDENCE_ID 记录当前状态。\n` } });
  // The id is substituted per run: it is minted by prepare, so it cannot be a constant in this file.
  const patched = `## coverage\n\n证据 ${run.evidenceId} 记录当前状态。\n`;
  await repairUnits(run, [COVERAGE_LEAF, ROOT], { [COVERAGE_LEAF]: { content: patched } });
  const reading = await checkRunConsistency(run.runDir);
  const policy = reading.result.findings.filter((finding) => finding.kind === "policy-violation");
  assert.equal(policy.length, 1, JSON.stringify(reading.result.findings.map((row) => row.statement)));
  assert.deepEqual(policy[0]!.unitIds, [COVERAGE_LEAF]);
  assert.match(policy[0]!.statement, /whose product-manager lens keeps implementation identifiers in evidence/);
});

test("a run with no recorded chapter contract still checks, and only the chapter class goes vacuous", async () => {
  // The denominator is the run's own requirement rows. When they are not there — a run prepared before the
  // contract generation, or a document added through the request-append door, which grows plan/requests.json and
  // never the contract — the honest reading is "this run fixed no chapter count for these bytes". Refusing would
  // produce no reading for ANY document of the run, and defaulting to zero would report every chapter it holds as
  // an excess: a deliverable declared badly broken because one input was missing.
  const run = await assembledConsistencyRun();
  await rm(join(run.runDir, "contract", "requirements.json"));
  const reading = await checkRunConsistency(run.runDir);
  assert.deepEqual(reading.result.findings, [], "a missing contract is not a defect in the deliverable");
  const row = reading.result.readings.find((entry) => entry.kind === "chapter-contract")!;
  assert.equal(row.objects.state, "vacuous");
  assert.match(row.statement, /records no template-section requirement row/u);
  // The other five classes are unaffected: one absent input must not blind the whole checker.
  assert.equal(reading.result.readings.length, 6);
  assert.ok(reading.result.readings.filter((entry) => entry.kind !== "chapter-contract").every((entry) => entry.statement.length > 0));
});

test("a second audience appended to a shipped run still checks, through the real append and re-plan doors", async () => {
  // The epic's headline case, end to end. `request-append` grows `plan/requests.json`; `contract/requirements.json`
  // was written once by prepare and does not grow with it, so the appended document has no recorded chapter
  // contract. Measured here rather than argued: the run really does end up with 2 requested documents and 1 in the
  // contract. A checker that refused that document would produce no reading for EITHER of them.
  const run = await admissionRun();
  await authorEveryUnit(run);
  await requestSecondDocument(run);
  const revised = await recordPlan(run, "two-documents", withExtraLeaf(FIRST_DOCUMENT));
  await authorEveryUnit(revised);
  await assembleUnits(revised.runDir, "write");

  const contract = JSON.parse(await readFile(join(revised.runDir, "contract", "requirements.json"), "utf8")) as { rows: Array<{ documentId: string | null }> };
  const recorded = new Set(contract.rows.map((row) => row.documentId).filter((id): id is string => id !== null));
  assert.deepEqual([...recorded], [FIRST_DOCUMENT], "the contract is written once and the append door does not grow it");

  const reading = await checkRunConsistency(revised.runDir);
  assert.deepEqual(reading.result.documents, [SECOND_DOCUMENT, FIRST_DOCUMENT].sort());
  const rows = new Map(reading.result.readings.filter((row) => row.kind === "chapter-contract").map((row) => [row.documentId, row]));
  assert.equal(rows.get(FIRST_DOCUMENT)!.objects.state, "examined", "the document the contract recorded is held to it");
  assert.equal(rows.get(SECOND_DOCUMENT)!.objects.state, "vacuous", "the appended document has no recorded chapter contract");
  assert.match(rows.get(SECOND_DOCUMENT)!.statement, /records no template-section requirement row/u);
  assert.deepEqual(reading.result.findings.filter((finding) => finding.kind === "chapter-contract"), []);
  // Both documents still get all six class readings: one absent input must not blind the checker.
  assert.equal(reading.result.readings.length, 12);
});

// --- (4) the repair loop -----------------------------------------------------------------------------

test("repairing exactly the repair set clears the checker, and no unit outside it is redrawn", async () => {
  const drifted: Record<string, UnitDraftOverride> = {
    [APPENDIX]: { terminology: [{ term: "Tenant", meaning: "一个付费客户" }] },
    [COVERAGE_LEAF]: { terminology: [{ term: "Tenant", meaning: "一个数据库 schema" }] }
  };
  const run = await assembledConsistencyRun(drifted);
  const before = await checkRunConsistency(run.runDir);
  assert.deepEqual(before.result.findings.map((row) => row.kind), ["terminology-drift"]);
  const repairSet = before.repair.targets.map((target) => target.unitId);
  assert.deepEqual(repairSet, [APPENDIX, COVERAGE_LEAF, ROOT]);

  const rowsBefore = await ledgerRows(run);
  // The canned repair: both units agree on the term. Nothing else about either draft changes.
  const agreed = { term: "Tenant", meaning: "一个付费客户" };
  await repairUnits(run, repairSet, {
    [APPENDIX]: { terminology: [agreed] },
    [COVERAGE_LEAF]: { terminology: [agreed] }
  });
  const after = await checkRunConsistency(run.runDir);
  assert.deepEqual(after.result.findings, [], "the repair converges: the checker goes to zero");
  assert.deepEqual(after.repair.targets, []);

  // ZERO REDRAW outside the set, read off the ledger rather than claimed: the owner leaf's row is byte-identical.
  const rowsAfter = await ledgerRows(run);
  assert.equal(rowsAfter.get(OWNER_LEAF), rowsBefore.get(OWNER_LEAF),
    "a unit no finding named must not be rewritten; its ledger row is the record of whether it was");
  for (const unitId of repairSet) {
    assert.notEqual(rowsAfter.get(unitId), rowsBefore.get(unitId), `${unitId} was in the repair set and must have been rewritten`);
  }
});

test("dropping the ancestors from the repair set does not make it smaller — it makes the run uncheckable", async () => {
  const run = await assembledConsistencyRun({
    [APPENDIX]: { terminology: [{ term: "Tenant", meaning: "一个付费客户" }] },
    [COVERAGE_LEAF]: { terminology: [{ term: "Tenant", meaning: "一个数据库 schema" }] }
  });
  // A third meaning, so BOTH named units move and the refusal has to name both children rather than one.
  const agreed = { term: "Tenant", meaning: "一个租户：付费客户在系统中的表示" };
  // The falsification: repair the two NAMED units and leave the synthesis written from them alone. The synthesis's
  // recorded childSummaryDigests now point at summaries that no longer exist.
  await repairUnits(run, [APPENDIX, COVERAGE_LEAF], { [APPENDIX]: { terminology: [agreed] }, [COVERAGE_LEAF]: { terminology: [agreed] } });
  await assert.rejects(
    () => checkRunConsistency(run.runDir),
    (error: Error) => {
      assert.match(error.message, /collected units disagree about what their children said/);
      for (const child of [APPENDIX, COVERAGE_LEAF]) {
        assert.match(error.message, new RegExp(`unit ${ROOT} records child ${child} at summary digest`));
      }
      return true;
    }
  );
  // And repairing the ancestor too clears it: the state is recoverable, never a run that is broken for good.
  await repairUnits(run, [ROOT]);
  assert.deepEqual((await checkRunConsistency(run.runDir)).result.findings, []);
});

// --- (5) the board tripwires -------------------------------------------------------------------------

test("one edited byte in a collected summary is refused by name, and re-collecting the unit clears it", async () => {
  const run = await assembledConsistencyRun();
  const paths = unitPaths(run.runDir, APPENDIX);
  const summary = JSON.parse(await readFile(paths.summary, "utf8")) as { keyStatements: string[] };
  summary.keyStatements = [`${summary.keyStatements[0]!}。`];
  await writeFile(paths.summary, `${JSON.stringify(summary, null, 2)}\n`);
  await assert.rejects(() => checkRunConsistency(run.runDir), /has summary digesting to .*but its ledger row promises/);
  await repairUnits(run, [APPENDIX, ROOT]);
  assert.deepEqual((await checkRunConsistency(run.runDir)).result.findings, []);
});

test("a deliverable that is absent, and one that no longer matches the plan, get two different refusals", async () => {
  const run = await assembledConsistencyRun();
  const reportPath = join(run.runDir, ...unitDocumentReportPath(DOCUMENT).split("/"));
  const original = await readFile(reportPath, "utf8");
  await writeFile(reportPath, `${original}\n<!-- edited by hand -->\n`);
  await assert.rejects(() => checkRunConsistency(run.runDir), /assembled artifact\(s\) on disk are not the bytes this plan and these collected units produce/);
  await rm(reportPath);
  await assert.rejects(() => checkRunConsistency(run.runDir), /assembled artifact\(s\) are not on disk: reports\/overview-product\.md/);
  await assembleUnits(run.runDir, "write");
  assert.deepEqual((await checkRunConsistency(run.runDir)).result.findings, []);
});

test("a hand-edited claims companion is caught too: the check covers every assembled artifact, not only the documents", async () => {
  // The companions carry the claim rows and the trace rows a reader follows. Before the check covered them they
  // were the one file on this path nothing re-verified: the ledger promise check compares each UNIT's artifacts,
  // and a companion is written by assembly out of all of them.
  const run = await assembledConsistencyRun();
  const companion = join(run.runDir, ...unitDocumentCompanionPaths(DOCUMENT).claims.split("/"));
  const rows = JSON.parse(await readFile(companion, "utf8")) as { claims: Array<{ claim: { statement: string } }> };
  rows.claims[0]!.claim.statement = "手改过的断言。";
  await writeFile(companion, `${JSON.stringify(rows)}\n`);
  await assert.rejects(
    () => checkRunConsistency(run.runDir),
    /assembled artifact\(s\) on disk are not the bytes this plan and these collected units produce: reports\/companions\/overview-product\.unit-claims\.json/
  );
  await assembleUnits(run.runDir, "write");
  assert.deepEqual((await checkRunConsistency(run.runDir)).result.findings, []);
});

// --- (6) the command --------------------------------------------------------------------------------

test("the command prints the reading and exits 1 exactly when there is a finding", async () => {
  const clean = await assembledConsistencyRun();
  const green = await cli(["unit-consistency", "--run", clean.runDir]);
  assert.equal(green.code, 0, green.stderr);
  const reading = JSON.parse(green.stdout) as { result: { findings: unknown[] }; lines: string[] };
  assert.deepEqual(reading.result.findings, []);
  assert.ok(reading.lines.some((line) => line.startsWith("nothing to repair:")), reading.lines.join("\n"));

  const defective = await assembledConsistencyRun({
    [APPENDIX]: { terminology: [{ term: "Tenant", meaning: "客户" }] },
    [COVERAGE_LEAF]: { terminology: [{ term: "Tenant", meaning: "schema" }] }
  });
  const red = await cli(["unit-consistency", "--run", defective.runDir]);
  assert.equal(red.code, 1, red.stdout);
  const lines = (JSON.parse(red.stdout) as { lines: string[] }).lines;
  assert.ok(lines.some((line) => line.startsWith(`terminology-drift [${APPENDIX}, ${COVERAGE_LEAF}]:`)), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("re-draft and re-collect exactly these 3 unit(s)")), lines.join("\n"));

  // A run that was never assembled is a named refusal, not a silent pass.
  const unassembled = await cli(["unit-consistency", "--run", join(clean.runDir, "..", "does-not-exist")]);
  assert.equal(unassembled.code, 1);
});

// --- (7) the second-shape run: zero material obligations everywhere -----------------------------------

test("the zero-material run checks clean, and its vacuous classes name why they had nothing", async () => {
  // The shape the epic's second target has: every work item `not-applicable` and non-material, so the plan holds
  // one appendix and one synthesis and every coverage denominator is empty. The checker must still run all five
  // classes and report vacuous WITH ITS SOURCE rather than a zero that reads like a pass.
  const run = await collectedRun();
  await assembleUnits(run.runDir, "write");
  const reading = await checkRunConsistency(run.runDir);
  assert.deepEqual(reading.result.findings, []);
  assert.deepEqual(reading.repair.targets, []);
  assert.equal(reading.result.readings.length, 6);
  const vacuous = reading.result.readings.filter((row) => row.objects.state === "vacuous").map((row) => row.kind);
  assert.deepEqual(vacuous, ["terminology-drift", "unknown-overclaim", "cross-unit-contradiction", "dangling-reference"],
    reading.result.readings.map((row) => row.statement).join("\n"));
  for (const row of reading.result.readings) {
    if (row.objects.state !== "vacuous") continue;
    assert.ok(row.objects.reason.length > 30, `${row.kind} must say WHY it had nothing: ${row.objects.reason}`);
  }
  // Gate 10's vacuous statements reach the routes with their source visible, and none of them is a repair.
  assert.ok(reading.repair.coverage.some((row) => row.state === "vacuous" && row.route.route === "nothing-owed"));
  assert.ok(reading.repair.coverage.every((row) => row.route.route !== "owed-outside-unit-authoring")
    || reading.repair.targets.length === 0);
});
