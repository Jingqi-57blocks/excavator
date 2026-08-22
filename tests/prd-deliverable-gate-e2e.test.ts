/**
 * THE PRD WORD-FORM RULES ON A REAL RUN, THROUGH THE REAL COMMANDS (57B-500).
 *
 * WHAT THIS ADDS TO `tests/prd-deliverable-checks.test.ts`, which exercises the same rules over values. Two things
 * a value-level test cannot say:
 *
 *   1. THE DEFECT SURVIVES EVERY GATE IN FRONT OF THIS ONE. The prose is drafted and collected through
 *      `checkpointUnit`, so the claim-binding audit, the output budget, the grounding audit and the promised-digest
 *      checks all see it first. A rule whose defect is caught earlier needs no gate of its own; these are not.
 *   2. THE SEVERITY IS THE EXIT CODE. `error` and `warning` are only worth the word if the command really exits 1
 *      on one and 0 on the other, and that lives in `src/cli.ts`, not in the checker.
 *
 * The run is a PRD FEATURE request over `tests/fixtures/sample-target` — the same shape
 * `tests/unit-prd-intent.test.ts` proves reaches a deliverable — prepared once and re-drafted per scenario, because
 * prepare, freeze and plan are the expensive part and none of them is what is under test.
 *
 * ZERO MODEL CALLS: the plan is the fixture plan and every unit's prose is written here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EvidenceItem, ReportRequest } from "../src/base/types.ts";
import { normalizeSection } from "../src/report/checkpoint.ts";
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import { collectedUnitsFor, readUnitLedger } from "../src/report/unit-ledger.ts";
import { unitClaimsDigest, unitContentDigest, validateUnitClaims, UNIT_SUMMARY_VERSION, type UnitSummary } from "../src/report/unit-output.ts";
import { compareUnitIds } from "../src/report/unit-paths.ts";
import { checkRunConsistency } from "../src/report/unit-consistency-source.ts";
import { freezeRun, prepareRun } from "../src/run/run.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { assembleUnits } from "../src/run/stages/unit-assemble-stage.ts";
import { chapterOrdinalsFor, chapteredBody, chapteredProse } from "./fixture-chapters.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "./helpers.ts";
import { planViewOf, unitClaims, UNIT_BUDGETS } from "./unit-fixture.ts";

async function cli(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/cli.ts", ...args], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((done) => child.on("close", (code) => done({ code, stdout, stderr })));
}

/** A prepared, disposed, frozen, planned PRD feature run. Nothing is drafted yet. */
async function prdRun(): Promise<{ runDir: string; evidenceId: string }> {
  const target = await copyFixture();
  const workdir = await tempDir("excavator-prd-wordform-");
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  const request: ReportRequest = {
    target, codegraph, workdir, language: "zh-CN", detailLevel: "standard",
    overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["prd"] }],
    budgets: UNIT_BUDGETS
  };
  const { runDir } = await prepareRun(request);
  await disposeAllWorkItems(runDir);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, true, JSON.stringify(frozen.findings));
  await planRun(runDir, { mode: "fixture" }, { kind: "record" });
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  return { runDir, evidenceId: (catalog.evidence.find((item) => item.kind === "source") ?? catalog.evidence[0]!).id };
}

/**
 * Draft and collect every unit in the plan's order, then assemble. The first unit's first chapter carries `body`.
 *
 * The chapters come from `chapteredBody` for the reason that helper states: an injection that dropped the unit's
 * chapters would trip the chapter contract as well, and the finding under test would arrive buried in noise the
 * fixture made itself.
 */
async function authorAndAssemble(run: { runDir: string; evidenceId: string }, body: string): Promise<void> {
  let first = true;
  for (const unitId of (await planViewOf(run.runDir)).collectionOrder) {
    const view = await planViewOf(run.runDir);
    const unit = view.byId.get(unitId)!;
    const ordinals = await chapterOrdinalsFor(run.runDir, view, unit);
    const content = first && body !== ""
      ? chapteredBody(unit, ordinals, `${unit.unitId} 记录当前状态。\`事实\`\n\n${body}`)
      : chapteredProse(unit, ordinals);
    first = false;
    const claims = unitClaims(unit, run.evidenceId);
    const ledger = await readUnitLedger(run.runDir, view.runId);
    const collected = new Map(collectedUnitsFor(ledger, view.knowledgeEpoch, view.planCatalogDigest).map((row) => [row.unitId, row]));
    const summary: UnitSummary = {
      version: UNIT_SUMMARY_VERSION,
      unitId,
      documentId: unit.documentId,
      kind: unit.kind,
      coveredTopicIds: unit.topics.map((topic) => topic.topicId).sort((a, b) => a.localeCompare(b)),
      keyStatements: [`${unit.title} 的当前状态已记录。`],
      unknowns: [],
      terminology: [],
      contentDigest: unitContentDigest(normalizeSection(content, unit.title)),
      claimsDigest: unitClaimsDigest(validateUnitClaims(unitId, unit.documentId, claims)),
      childSummaryDigests: [...unit.childUnitIds].sort(compareUnitIds).map((childUnitId) => {
        const row = collected.get(childUnitId);
        if (!row) throw new Error(`fixture cannot summarise ${unitId}: its child ${childUnitId} is not collected`);
        return { childUnitId, summaryDigest: row.summaryDigest };
      })
    };
    await checkpointUnit(run.runDir, {
      unitId, content, claims, summary,
      authorship: { kind: "model-free", generator: "prd-wordform-e2e" },
      provenance: { kind: "fresh" }
    });
  }
  const assembled = await assembleUnits(run.runDir, "write");
  assert.equal(assembled.written, true);
}

const RUN = await prdRun();

test("a compliant prd deliverable checks clean, and the class reads examined with its denominator", async () => {
  await authorAndAssemble(RUN, "员工提交请假申请后，页面显示「提交成功」并刷新列表。`事实`");
  const reading = await checkRunConsistency(RUN.runDir);
  assert.deepEqual(reading.result.findings, [], reading.result.findings.map((row) => row.statement).join("\n"));
  const row = reading.result.readings.find((entry) => entry.kind === "prd-deliverable")!;
  assert.equal(row.objects.state, "examined", row.statement);
  assert.match(row.statement, /covering \d+ visible prose line\(s\)/u);
});

test("the storage-schema tripwire reports on a real prd run and the command still exits 0", async () => {
  await authorAndAssemble(RUN, "员工姓名字段为 varchar(100) NOT NULL。`事实`");
  const result = await cli(["unit-consistency", "--run", RUN.runDir]);
  const lines = (JSON.parse(result.stdout) as { lines: string[] }).lines;
  assert.ok(lines.some((line) => line.startsWith("warning prd-deliverable [")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("varchar")), lines.join("\n"));
  // THE WHOLE POINT OF THE SEVERITY: a rule decided by a word list reports and does not stop a pipeline.
  assert.equal(result.code, 0, result.stdout);
  // It is still located and still repairable — a tripwire is not a whisper.
  assert.ok(lines.some((line) => line.startsWith("re-draft and re-collect exactly these")), lines.join("\n"));
});

test("acceptance residue, an AC id and a malformed anchor are gates: the command exits 1 and names the unit", async () => {
  await authorAndAssemble(RUN, [
    "- [ ] 用户提交请假申请后可以看到「提交成功」。`事实`",
    "",
    "AC-001 审批人可以驳回请假申请。`事实`",
    "",
    "- FR-1 员工可以撤回未审批的申请。`事实`"
  ].join("\n"));
  const result = await cli(["unit-consistency", "--run", RUN.runDir]);
  assert.equal(result.code, 1, result.stdout);
  const lines = (JSON.parse(result.stdout) as { lines: string[] }).lines;
  const errors = lines.filter((line) => line.startsWith("error prd-deliverable ["));
  assert.equal(errors.length, 3, lines.join("\n"));
  assert.ok(errors.every((line) => /\[feature-[a-z0-9-]+-prd::/u.test(line)), errors.join("\n"));
  assert.ok(errors.some((line) => line.includes("acceptance checkbox line(s)")), errors.join("\n"));
  assert.ok(errors.some((line) => line.includes("AC-001")), errors.join("\n"));
  assert.ok(errors.some((line) => line.includes("FR-1 is not one of the two trace-anchor shapes")), errors.join("\n"));
});
