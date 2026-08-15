import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDenominatorReport, denominatorExitCode, parseMust } from "../read-denominator.ts";

// The fixture is not synthetic: it is the real prepare output of WCP's 请假管理 feature, trimmed to the
// leave handler files and to the `logic` category the denominator actually consumes. Span data has no
// "invented wording" failure mode — a start line either matches the source or it does not — so a byte
// extraction of a real run is the right shape of fixture here, and it keeps CI free of the target repo.
//
// It pins the miss this slice was built for: `Creation` at service.go:56 carries the attachment rule at
// line 73, sat between two enumerated obligations, and belonged to no obligation at all.

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wcp-leave");
const SERVICE = "wcp-service-v2/internal/handlers/leave/service.go";

test("the second source adds obligations without losing a single one the first source had", () => {
  const report = buildDenominatorReport(FIXTURE, []);
  assert.equal(report.secondSourceAvailable, true);
  assert.deepEqual(report.lost, [], "non-regression: nothing counted before may stop being counted");
  assert.ok(report.after.counted > report.before.counted, `denominator must widen (${report.before.counted} → ${report.after.counted})`);
  assert.ok((report.secondSource?.added ?? 0) > 0);
  assert.equal(denominatorExitCode(report), 0);
});

test("both rule-bearing functions in the measured gap enter the counted denominator", () => {
  const report = buildDenominatorReport(FIXTURE, [
    { path: SERVICE, line: 56 },
    { path: SERVICE, line: 136 },
  ]);
  assert.deepEqual(report.must.map((entry) => entry.satisfied), [true, true], "a single example can be satisfied by coincidence; two cannot as easily");
  assert.equal(report.must[0].obligation?.name, "Creation");
  assert.equal(report.must[0].obligation?.kind, "boundary-decision-function");
  assert.equal(report.must[0].obligation?.tier, 2);
  assert.equal(report.must[1].obligation?.name, "Demand");
});

test("the attachment rule's own line is inside a counted obligation, not merely its function's start", () => {
  const report = buildDenominatorReport(FIXTURE, [{ path: SERVICE, line: 73 }]);
  assert.equal(report.must[0].satisfied, true);
  assert.equal(report.must[0].obligation?.name, "Creation");
});

test("the enumeration gap the miss lived in is reported as closed", () => {
  const report = buildDenominatorReport(FIXTURE, []);
  const gap = report.gapsClosed.find((entry) => entry.path === SERVICE && entry.from <= 56 && entry.to >= 136);
  assert.ok(gap, `expected the 54-275 gap to be closed, got ${JSON.stringify(report.gapsClosed.filter((g) => g.path === SERVICE))}`);
});

test("a line no obligation covers fails the command, so the gate can actually go red", () => {
  const report = buildDenominatorReport(FIXTURE, [{ path: SERVICE, line: 999999 }]);
  assert.equal(report.must[0].satisfied, false);
  assert.equal(denominatorExitCode(report), 1);
});

test("a run without the boundary artifact reports the first source alone rather than failing", () => {
  const report = buildDenominatorReport(join(FIXTURE, "..", "does-not-exist"), []);
  assert.equal(report.secondSourceAvailable, false);
  assert.deepEqual(report.lost, []);
  assert.equal(denominatorExitCode(report), 0);
});

test("--must parsing keeps the line separate from a path that contains slashes", () => {
  assert.deepEqual(parseMust("a/b/c.go:42"), { path: "a/b/c.go", line: 42 });
  assert.throws(() => parseMust("a/b/c.go"), /--must expects/);
  assert.throws(() => parseMust("a/b/c.go:0"), /--must expects/);
});
