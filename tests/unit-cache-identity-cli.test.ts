import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { UNIT_PACKET_FORBIDDEN_INPUT_PREFIXES } from "../src/report/unit-packet-source.ts";
import { UNIT_CACHE_IDENTITY_VERSION } from "../src/report/unit-cache-identity.ts";
import { loadRunUnitIdentities, rowUnitId } from "../src/report/unit-cache-identity-source.ts";
import { plannedRun } from "./unit-fixture.ts";

/**
 * R6a - `excavator unit-cache-identity`: the read-only identity reading of one planned run.
 *
 * It runs over a REAL run directory rather than an in-memory plan, which is what makes it worth having: the loader
 * has to open the same files the packet renderer opens and no others, and the command has to say something rather
 * than nothing for a synthesis whose children nobody has collected yet.
 */

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

interface CliUnitRow {
  readonly unit: string;
  readonly kind: string;
  readonly identityDigest?: string;
  readonly identity?: string;
  readonly reason?: string;
  readonly sections?: readonly { readonly heading: string; readonly digest: string }[];
}

test("unit-cache-identity prints one row per planned unit, twice with the same bytes, and reads no authoring artifact", async () => {
  const run = await plannedRun();
  const first = await cli(["unit-cache-identity", "--run", run.runDir, "--authorship", "model-free:fixture-plan"]);
  assert.equal(first.code, 0, first.stderr);
  const again = await cli(["unit-cache-identity", "--run", run.runDir, "--authorship", "model-free:fixture-plan"]);
  assert.equal(again.stdout, first.stdout, "a reading of the same run is the same bytes: it computes, it does not sample");

  const reading = JSON.parse(first.stdout) as { units: readonly CliUnitRow[]; readPaths: readonly string[]; authorship: string; knowledgeEpoch: number };
  assert.equal(reading.authorship, "model-free generator fixture-plan");
  assert.equal(reading.units.length, run.view.units.length, "every planned unit is accounted for, identified or named");
  for (const row of reading.units) {
    if (row.identity === "unavailable") {
      assert.equal(row.kind, "synthesis", `${row.unit}: only a synthesis can be waiting for its children`);
      assert.match(row.reason!, /not collected for knowledge epoch/);
      continue;
    }
    assert.match(row.identityDigest!, /^[0-9a-f]{64}$/, row.unit);
    assert.ok(row.sections!.length > 1, `${row.unit}: the sections are what a rebuild reason is made of`);
  }
  // The unit path's forbidden inputs are forbidden here too: this is the same loader.
  for (const path of reading.readPaths) {
    for (const prefix of UNIT_PACKET_FORBIDDEN_INPUT_PREFIXES) {
      assert.ok(!path.startsWith(prefix), `${path} is an authoring-side input`);
    }
  }
  // And the in-process reading is the same one, so the command is not a second derivation.
  const loaded = await loadRunUnitIdentities(run.runDir, { kind: "model-free", generator: "fixture-plan" });
  assert.deepEqual(loaded.rows.map(rowUnitId), reading.units.map((row) => row.unit));
  for (const identified of loaded.rows) {
    if (identified.state !== "identified") continue;
    assert.equal(identified.identity.version, UNIT_CACHE_IDENTITY_VERSION);
    assert.equal(reading.units.find((row) => row.unit === identified.identity.unitId)!.identityDigest, identified.identity.digest);
  }
});

test("unit-cache-identity refuses to guess an author", async () => {
  const run = await plannedRun();
  const missing = await cli(["unit-cache-identity", "--run", run.runDir]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /--authorship/);
  const malformed = await cli(["unit-cache-identity", "--run", run.runDir, "--authorship", "whoever"]);
  assert.notEqual(malformed.code, 0);
  assert.match(malformed.stderr, /must be model-family:<name> or model-free:<name>/);
  const empty = await cli(["unit-cache-identity", "--run", run.runDir, "--authorship", "model-family:"]);
  assert.notEqual(empty.code, 0);
  assert.match(empty.stderr, /must be model-family:<name> or model-free:<name>/);
});

test("unit-cache-identity --help prints usage and runs nothing", async () => {
  const help = await cli(["unit-cache-identity", "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /unit-cache-identity --run <dir> --authorship/);
  assert.match(help.stdout, /normalized/);
});
