import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
const CLI = join("eval", "cli.ts");
const RUN_MINI = join(import.meta.dirname, "fixtures", "run-mini");
const RUN_OBSERVE_MINI = join(import.meta.dirname, "fixtures", "run-observe-mini");
const RUN_OBSERVE_MINI_B = join(import.meta.dirname, "fixtures", "run-observe-mini-b");
const BOUNDARY_RUN_MINI = join(import.meta.dirname, "fixtures", "boundary-run-mini");
const BOUNDARY_GOLD_FAIL = join(BOUNDARY_RUN_MINI, "gold-fail.json");
const BOUNDARY_GOLD_PASS = join(BOUNDARY_RUN_MINI, "gold-pass.json");
const EXPECTED_FAIL = join(RUN_MINI, "expected-fail.json");
const EXPECTED_PASS = join(RUN_MINI, "expected-pass.json");

async function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // Wait for "close" (stdio streams drained), not "exit": larger --json payloads
  // exceed the pipe buffer and are still arriving when "exit" fires.
  const code = await new Promise<number | null>((done) => child.once("close", done));
  return { code, stdout, stderr };
}

test("diff exits 1 and prints FAIL when mustFinds are missing / forbidden hit / coverage fails", async () => {
  const { code, stdout } = await cli(["diff", "--run", RUN_MINI, "--expected", EXPECTED_FAIL]);
  assert.equal(code, 1);
  assert.match(stdout, /verdict: FAIL/);
  assert.match(stdout, /forbidden violations: 1/);
});

test("diff exits 0 and prints PASS on a clean run", async () => {
  const { code, stdout } = await cli(["diff", "--run", RUN_MINI, "--expected", EXPECTED_PASS]);
  assert.equal(code, 0);
  assert.match(stdout, /verdict: PASS/);
});

test("diff --json emits a machine-readable Diff with the documented top-level shape", async () => {
  const { code, stdout } = await cli(["diff", "--run", RUN_MINI, "--expected", EXPECTED_FAIL, "--json"]);
  assert.equal(code, 1);
  const diff = JSON.parse(stdout);
  assert.deepEqual(Object.keys(diff).sort(), ["coverageFailures", "forbiddenExempted", "forbiddenHits", "found", "missing", "summary"]);
  assert.equal(diff.summary.mustFindMissing, 2);
  assert.equal(diff.missing.every((entry: any) => typeof entry.id === "string" && typeof entry.attribution === "string"), true);
});

test("--prepare-only runs only the containment check: exit 1 when an anchor is out of scope", async () => {
  const { code, stdout } = await cli(["diff", "--run", RUN_MINI, "--expected", EXPECTED_FAIL, "--prepare-only"]);
  assert.equal(code, 1);
  assert.match(stdout, /OUT OF SCOPE/);
  assert.match(stdout, /audit-log\.ts/);
});

test("--prepare-only exits 0 when every anchor lands in the prepared horizon", async () => {
  const { code, stdout } = await cli(["diff", "--run", RUN_MINI, "--expected", EXPECTED_PASS, "--prepare-only"]);
  assert.equal(code, 0);
  assert.match(stdout, /all expected anchors land/);
});

test("extract prints Knowledge JSON to stdout", async () => {
  const { code, stdout } = await cli(["extract", "--run", RUN_MINI]);
  assert.equal(code, 0);
  const knowledge = JSON.parse(stdout);
  assert.equal(knowledge.facts.length, 7);
  assert.equal(knowledge.unknowns.length, 2);
});

test("extract --out writes Knowledge JSON to a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-extract-"));
  const out = join(dir, "knowledge.json");
  const { code } = await cli(["extract", "--run", RUN_MINI, "--out", out]);
  assert.equal(code, 0);
  const written = JSON.parse(await readFile(out, "utf8"));
  assert.equal(written.facts.length, 7);
});

test("view renders the text view of a run and exits 0", async () => {
  const { code, stdout } = await cli(["view", "--run", RUN_OBSERVE_MINI]);
  assert.equal(code, 0);
  assert.match(stdout, /=== run ===/);
  assert.match(stdout, /GAP-ATTRIBUTED/);
  assert.match(stdout, /=== time split ===/);
  assert.match(stdout, /=== process narrative ===/);
  assert.match(stdout, /reflection\/notes\.pinned/); // unknown stage+action rendered, no crash
});

test("view --json emits the RunStats top-level shape and exits 0", async () => {
  const { code, stdout } = await cli(["view", "--run", RUN_OBSERVE_MINI, "--json"]);
  assert.equal(code, 0);
  const stats = JSON.parse(stdout);
  assert.deepEqual(Object.keys(stats).sort(), [
    "anomalies", "counters", "documentSplit", "header", "narrative",
    "prepareTiming", "runDir", "searchCounters", "searches", "stages", "topGaps", "warnings"
  ]);
  assert.equal(stats.header.audit.outcome, "passed");
});

test("view exits 2 on a missing run dir and on a run dir without metrics.json", async () => {
  const missingDir = await cli(["view", "--run", join(RUN_OBSERVE_MINI, "does-not-exist")]);
  assert.equal(missingDir.code, 2);
  assert.match(missingDir.stderr, /run directory not found/);

  const noMetrics = await cli(["view", "--run", import.meta.dirname]);
  assert.equal(noMetrics.code, 2);
  assert.match(noMetrics.stderr, /metrics\.json not found/);
});

test("compare renders the A->B delta view and exits 0", async () => {
  const { code, stdout } = await cli(["compare", "--a", RUN_OBSERVE_MINI, "--b", RUN_OBSERVE_MINI_B]);
  assert.equal(code, 0);
  assert.match(stdout, /=== run comparison \(A -> B\) ===/);
  assert.match(stdout, /=== metrics delta ===/);
  assert.match(stdout, /=== knowledge delta ===/);
  // wall-clock improvement label + the two honesty caveats.
  assert.match(stdout, /total \(startedAt -> finishedAt\): 6m 10s -> 5m 0s.*\[improvement\]/);
  assert.match(stdout, /authoring: 3m 20s -> 3m 30s.*\[regression\]/);
  assert.match(stdout, /gap-attribution caveat/);
  assert.match(stdout, /NEVER by claim id/);
  // knowledge deltas.
  assert.match(stdout, /\+ svc\/audit\/log\.go:8-25/);
  assert.match(stdout, /- svc\/notify\/email\.go:5-30/);
  assert.match(stdout, /data-scope: found -> searched-not-found/);
});

test("compare --json emits the RunComparison top-level shape and exits 0", async () => {
  const { code, stdout } = await cli(["compare", "--a", RUN_OBSERVE_MINI, "--b", RUN_OBSERVE_MINI_B, "--json"]);
  assert.equal(code, 0);
  const comparison = JSON.parse(stdout);
  assert.deepEqual(Object.keys(comparison).sort(), ["a", "b", "knowledge", "metrics", "notable"]);
  assert.deepEqual(Object.keys(comparison.knowledge).sort(), ["coverage", "factAnchors", "markerDistribution", "relations", "unknowns"]);
  assert.equal(comparison.a.runId, "run-observe-mini");
  assert.equal(comparison.b.runId, "run-observe-mini-b");
  const total = comparison.metrics.flatMap((g: any) => g.metrics).find((m: any) => m.metric === "totalWallMs");
  assert.deepEqual({ delta: total.delta, pct: total.pct, assessment: total.assessment }, { delta: -70000, pct: -18.9, assessment: "improvement" });
});

test("compare exits 2 on a missing run dir and on a missing --b flag", async () => {
  const missingDir = await cli(["compare", "--a", RUN_OBSERVE_MINI, "--b", join(RUN_OBSERVE_MINI_B, "nope")]);
  assert.equal(missingDir.code, 2);
  assert.match(missingDir.stderr, /run directory not found/);

  const missingFlag = await cli(["compare", "--a", RUN_OBSERVE_MINI]);
  assert.equal(missingFlag.code, 2);
  assert.match(missingFlag.stderr, /missing required flag --b/);
});

test("boundary --run exits 1 and prints FAIL when a mustFind symbol is out of bounds", async () => {
  const { code, stdout } = await cli(["boundary", "--run", BOUNDARY_RUN_MINI, "--gold", BOUNDARY_GOLD_FAIL]);
  assert.equal(code, 1);
  assert.match(stdout, /verdict: FAIL/);
  assert.match(stdout, /\[decoy-must\]/); // CG-NODES decoy was not credited -> stays a mustFind miss
  assert.match(stdout, /covered by a source window/); // informational coverage tag rendered in run mode
});

test("boundary --run exits 0 and prints PASS when every mustFind is in bounds", async () => {
  const { code, stdout } = await cli(["boundary", "--run", BOUNDARY_RUN_MINI, "--gold", BOUNDARY_GOLD_PASS]);
  assert.equal(code, 0);
  assert.match(stdout, /verdict: PASS/);
});

test("boundary --json emits the BoundaryReport top-level shape", async () => {
  const { code, stdout } = await cli(["boundary", "--run", BOUNDARY_RUN_MINI, "--gold", BOUNDARY_GOLD_FAIL, "--json"]);
  assert.equal(code, 1);
  const report = JSON.parse(stdout);
  assert.deepEqual(Object.keys(report).sort(), ["found", "missing", "summary", "target"]);
  assert.equal(report.summary.pass, false);
});

test("boundary --nodes reads a projected node file and omits the run-only coverage field", async () => {
  const nodesFile = join(BOUNDARY_RUN_MINI, "..", "..", "..", "fixtures", "wcp-leave", "demo-run-fg-nodes.json");
  const gold = join(BOUNDARY_RUN_MINI, "..", "..", "..", "fixtures", "wcp-leave", "boundary-gold.json");
  const { code, stdout } = await cli(["boundary", "--nodes", nodesFile, "--gold", gold, "--json"]);
  assert.equal(code, 1);
  const report = JSON.parse(stdout);
  assert.equal(report.summary.mustFindMissing, 3);
  assert.equal(report.missing.every((m: any) => !("coveredBySourceWindow" in m)), true); // no evidence.json in --nodes mode
});

test("boundary same run twice is byte-identical (deterministic)", async () => {
  const a = await cli(["boundary", "--run", BOUNDARY_RUN_MINI, "--gold", BOUNDARY_GOLD_FAIL, "--json"]);
  const b = await cli(["boundary", "--run", BOUNDARY_RUN_MINI, "--gold", BOUNDARY_GOLD_FAIL, "--json"]);
  assert.equal(a.stdout, b.stdout);
});

test("boundary exits 2 on a missing --gold flag and on a missing run dir", async () => {
  const missingGold = await cli(["boundary", "--run", BOUNDARY_RUN_MINI]);
  assert.equal(missingGold.code, 2);
  assert.match(missingGold.stderr, /missing required flag --gold/);

  const missingDir = await cli(["boundary", "--run", join(BOUNDARY_RUN_MINI, "nope"), "--gold", BOUNDARY_GOLD_FAIL]);
  assert.equal(missingDir.code, 2);
  assert.match(missingDir.stderr, /run directory not found/);
});

test("help prints usage; an unknown command errors with a nonzero, non-diff exit", async () => {
  const help = await cli(["help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /extract --run/);
  assert.match(help.stdout, /view {4}--run/);
  assert.match(help.stdout, /compare --a/);
  assert.match(help.stdout, /boundary \(--run/);

  const bogus = await cli(["nope"]);
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /unknown command/);
});
