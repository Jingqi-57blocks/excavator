import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tempDirSync } from "../../tests/temp-dir.ts";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { attributionExitCode, buildAttributionReport, loadAttributionGolden } from "../read-attribution.ts";

// This gate guards a MEASUREMENT, so it has to be able to fail in the direction that matters: a labelling
// that stops separating real misses from co-located noise, or that stops pointing at the files a human said
// were worth reading. A gate that only ever agrees with the current implementation proves nothing.

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "..", "golden", "read-attribution-wcp-leave.json");
const ANCHORS = ["请假管理", "leave", "请假", "leaves"];

function withGolden(mutate: (golden: Record<string, unknown>) => void): string {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;
  mutate(golden);
  const path = join(tempDirSync("attr-"), "golden.json");
  writeFileSync(path, JSON.stringify(golden));
  return path;
}

test("the shipped labelling clears both pre-registered purity floors", () => {
  const report = buildAttributionReport(GOLDEN, ANCHORS);
  assert.ok(report.strong.pass, `strong ${report.strong.trueMiss}/${report.strong.total}`);
  assert.ok(report.unclassified.pass, `unclassified ${report.unclassified.noise}/${report.unclassified.total}`);
  assert.equal(attributionExitCode(report), 0);
});

// The check that shows the instrument would change a decision, not just report differently.
test("the old reading pointed at noise-dominated files and the strong reading does not", () => {
  const report = buildAttributionReport(GOLDEN, ANCHORS);
  assert.ok(report.decisionDifferential.oldNoiseInTop5 >= 2, "there was something to fix");
  assert.equal(report.decisionDifferential.strongNoiseInTop5, 0);
  assert.deepEqual(report.decisionDifferential.missingRequired, [], "the clusters a human judged real must surface");
  assert.ok(report.decisionDifferential.pass);
});

test("the partitions cover every adjudicated obligation — the gate cannot be passed by dropping items", () => {
  const golden = loadAttributionGolden(GOLDEN);
  const report = buildAttributionReport(GOLDEN, ANCHORS);
  assert.equal(report.strong.total + report.unclassified.total, golden.items.length);
});

// A vocabulary that matched nothing would put every real miss in the unclassified partition.
test("a labelling that classifies nothing fails the gate", () => {
  const report = buildAttributionReport(GOLDEN, ["zzz-nothing-matches"]);
  assert.ok(!report.decisionDifferential.pass, "with nothing labelled, the strong top-5 loses the required clusters");
  assert.equal(attributionExitCode(report), 1);
});

test("a labelling that calls everything relevant fails on the unclassified floor", () => {
  // `a` matches nothing structurally, but marking every item retained does: the strong partition then
  // swallows the noise and the unclassified partition becomes empty.
  const path = withGolden((golden) => {
    for (const item of golden.items as Array<{ kind: string }>) item.kind = "decision-function";
  });
  const report = buildAttributionReport(path, ANCHORS);
  assert.equal(report.unclassified.total, 0);
  assert.ok(!report.unclassified.pass, "an empty unclassified partition cannot satisfy a noise floor");
  assert.equal(attributionExitCode(report), 1);
});

test("real misses the labelling could not place are counted, because that is the cost of the split", () => {
  const report = buildAttributionReport(GOLDEN, ANCHORS);
  assert.ok(report.leakedTrueMisses > 0, "the honest number is not zero, and the advisory says to read that partition per file");
});

test("a golden with no pre-registered thresholds is rejected rather than run against nothing", () => {
  const path = withGolden((golden) => { delete (golden as { preRegistered?: unknown }).preRegistered; });
  assert.throws(() => loadAttributionGolden(path), /no pre-registered thresholds/);
});

test("a golden of the wrong version is rejected rather than half-read", () => {
  const path = withGolden((golden) => { golden.version = "read-attribution-v99"; });
  assert.throws(() => loadAttributionGolden(path), /unsupported golden version/);
});
