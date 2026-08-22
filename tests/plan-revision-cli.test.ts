/**
 * `excavator plan --revise` and `excavator request-append` at the command line.
 *
 * WHY THESE TWO NEED A CLI TEST OF THEIR OWN, when the mechanics are covered elsewhere: both are MODE FLAGS, and
 * the failure mode of a mode flag is not a wrong answer — it is the wrong mode, silently. `parseArgs` hands a flag
 * the next non-`--` token as its value, so `--revise yes` arrives as a VALUE rather than as the bare flag, and a
 * guard that only compares it to `"true"` falls through to the recording path: the revise is dropped and the
 * operator is told to use `--revise`. That is exactly the shape this repo already refuses for `--units`, and it is
 * only reachable through argv — no in-process test of the stage can see it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readReportRequests } from "../src/report/report-requests-artifact.ts";
import { plannedRun } from "./unit-fixture.ts";

async function cli(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/cli.ts", ...args], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((done) => child.once("exit", done));
  return { code, stdout, stderr };
}

test("--revise is a bare flag: a value for it is refused rather than dropping the revise", async () => {
  const run = await plannedRun(["product"]);
  const withValue = await cli(["plan", "--run", run.runDir, "--fixture-plan", "--revise", "yes", "--reason", "why"]);
  assert.equal(withValue.code, 1, withValue.stdout);
  assert.match(withValue.stderr, /excavator plan takes --revise as a bare flag; .*yes.* is not a value it accepts/);

  // And the two halves of the flag are refused apart: no reason is a plan replaced for reasons nobody recorded, and
  // a reason with no --revise is a caller who believes they are superseding a plan and is not.
  const noReason = await cli(["plan", "--run", run.runDir, "--fixture-plan", "--revise"]);
  assert.equal(noReason.code, 1);
  assert.match(noReason.stderr, /Missing --reason \(a plan revision states why the plan it supersedes was replaced\)/);
  const noRevise = await cli(["plan", "--run", run.runDir, "--fixture-plan", "--reason", "why"]);
  assert.equal(noRevise.code, 1);
  assert.match(noRevise.stderr, /--reason applies to --revise; a plain `plan` records the first revision of this epoch and supersedes nothing/);
});

test("append then revise, at the command line: the revision block reports what it superseded and where it went", async () => {
  const run = await plannedRun(["product"]);
  const appended = await cli(["request-append", "--run", run.runDir, "--kind", "overview", "--audience", "engineering", "--detail", "standard", "--language", "zh-CN"]);
  assert.equal(appended.code, 0, appended.stderr);
  const appendedOut = JSON.parse(appended.stdout) as { documents: string[]; next: string };
  assert.deepEqual(appendedOut.documents, ["overview-engineering", "overview-product"]);
  assert.match(appendedOut.next, /run `excavator plan --run <run> --fixture-plan --revise --reason <why>` before drafting/);

  const revised = await cli(["plan", "--run", run.runDir, "--fixture-plan", "--revise", "--reason", "a second audience was requested"]);
  assert.equal(revised.code, 0, revised.stderr);
  const out = JSON.parse(revised.stdout) as {
    revision: { planRevision: number; previousPlanCatalogDigest: string; reason: string; archived: { catalog: string; dag: string }; succession: string[] };
  };
  assert.equal(out.revision.planRevision, 1);
  assert.match(out.revision.previousPlanCatalogDigest, /^[0-9a-f]{64}$/);
  assert.equal(out.revision.reason, "a second audience was requested");
  assert.equal(out.revision.archived.catalog, `${run.runDir}/plan/revisions/epoch-0/revision-0/catalog.json`);
  assert.deepEqual(out.revision.succession, [`revision 1 supersedes revision 0 (${out.revision.previousPlanCatalogDigest})`]);

  // A repeat of the same revise supersedes nothing now, and says so instead of recording revision 2.
  const again = await cli(["plan", "--run", run.runDir, "--fixture-plan", "--revise", "--reason", "again"]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /nothing is superseded, so no revision is recorded/);
});

test("the append door pairs --kind with --feature-key in both directions, and checks the key against the run", async () => {
  // This run investigated no feature at all, which is the case where a boundary refusal is easiest to get wrong:
  // an empty bound-key list must read as "this run investigated no feature", never as a key that matched nothing.
  const run = await plannedRun(["product"]);
  const noKey = await cli(["request-append", "--run", run.runDir, "--kind", "feature", "--audience", "product", "--detail", "standard", "--language", "zh-CN"]);
  assert.equal(noKey.code, 1);
  assert.match(noKey.stderr, /Missing --feature-key \(a feature document is written against exactly one feature key from contract\/run-intent\.json\)/);

  const unknownKey = await cli(["request-append", "--run", run.runDir, "--kind", "feature", "--audience", "product", "--detail", "standard", "--language", "zh-CN", "--feature-key", "leave"]);
  assert.equal(unknownKey.code, 1);
  // The CLI prints the refusal as JSON, so the message's own quotes arrive escaped.
  assert.match(unknownKey.stderr, /names feature key \\"leave\\", which contract\/run-intent\.json does not bind \(this run investigated: no feature\)/);

  const withKey = await cli(["request-append", "--run", run.runDir, "--kind", "overview", "--audience", "engineering", "--detail", "standard", "--language", "zh-CN", "--feature-key", "leave"]);
  assert.equal(withKey.code, 1);
  assert.match(withKey.stderr, /--feature-key \\"leave\\" was given for --kind overview; the project scope is not addressed by feature/);
  assert.equal((await readReportRequests(run.runDir)).requests.length, 1, "no refusal appended anything");
});
