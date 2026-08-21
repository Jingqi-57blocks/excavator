// The canonical-projection RULES, on their own — no run, no golden, no assemble.
//
// `eval/report-canonical.ts` outlives the section path: `eval/unit-assemble-canonical.ts` reuses
// `canonicalAssembleProjection` and its six substitution rules rather than restating them, which is why the unit
// path's golden depends on exactly the same folding. Both of the properties below were pinned only inside
// `eval/tests/assemble-golden.test.ts`, whose whole file retires with the section golden — so they are re-scaffolded
// here, where nothing about them depends on a section ever having been drafted.
//
// They are the two directions the projection can silently fail in:
//
//   * a rule eats something STABLE — a bare date, a bare clock time, a non-Z instant, an id-shaped string the run's
//     catalog does not hold, ordinary prose — and the golden then hides a real change behind a placeholder;
//   * two catalog ids fold to ONE placeholder, and a swap between the two evidence records stops moving the golden.
//     That one is a named refusal rather than a collapse, and this asserts the refusal by its message.
//
// `canonicalizeText` is called with a hand-built identity on purpose: these are statements about the rules, not
// about any run, and a fixture that first had to assemble something would be testing the assembler again.

import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeText, type VolatileIdentity } from "../report-canonical.ts";

test("the substitution rules leave stable content alone", () => {
  const identity: VolatileIdentity = {
    runId: "run-2026_01_02_03_04-overview-aaaaaaaa-bbbbbbbb-cccccccc",
    snapshotId: "0123456789abcdef0123",
    targetPath: "/tmp/excavator-test-AbCdEf",
    targetName: "excavator-test-AbCdEf",
    evidencePlaceholders: { "S-1111111111": "<EVIDENCE source src/a.ts:1-3>", "S-2222222222": "<EVIDENCE source src/b.ts:4-6>" }
  };
  const input = [
    "run: run-2026_01_02_03_04-overview-aaaaaaaa-bbbbbbbb-cccccccc",
    "snapshot: 0123456789abcdef0123",
    "started: 2026-01-02T03:04:05.678Z",
    "cited: S-1111111111 and S-2222222222 and S-1111111111",
    "not in this catalog: S-9999999999",
    "release date 2026-01-02 and daily cutoff 03:04:05 and local stamp 2026-01-02T03:04:05",
    "第 1 节记录当前状态。 The snapshot digest column header stays."
  ].join("\n");
  const { text, applied } = canonicalizeText(input, identity);
  const fired = Object.fromEntries(applied.map((rule) => [rule.name, rule.replacements]));

  // Positive: the volatile forms went.
  assert.deepEqual(fired, { "evidence-id": 3, "run-id": 1, "snapshot-id": 1, "target-path": 0, "target-name": 0, "iso-instant": 1 });
  assert.ok(text.includes("run: <RUN-ID>"));
  assert.ok(text.includes("snapshot: <SNAPSHOT-ID>"));
  assert.ok(text.includes("started: <TIMESTAMP>"));

  // Negative: nothing stable was eaten.
  assert.ok(text.includes("release date 2026-01-02 and daily cutoff 03:04:05 and local stamp 2026-01-02T03:04:05"), "a bare date, a bare time and a non-Z instant are not instants");
  assert.ok(text.includes("not in this catalog: S-9999999999"), "an id-shaped string outside the run's catalog is left alone");
  assert.ok(text.includes("第 1 节记录当前状态。 The snapshot digest column header stays."), "prose survives verbatim");
  // Two distinct ids keep distinct placeholders, so a swap between them would still diff.
  assert.ok(text.includes("cited: <EVIDENCE source src/a.ts:1-3> and <EVIDENCE source src/b.ts:4-6> and <EVIDENCE source src/a.ts:1-3>"));
});

test("two catalog ids that describe the same evidence fail by name instead of collapsing", () => {
  const identity: VolatileIdentity = {
    runId: "run-x", snapshotId: "snap-x", targetPath: "/tmp/x", targetName: "x",
    evidencePlaceholders: { "S-aaaaaaaaaa": "<EVIDENCE source src/a.ts:1-3>", "S-bbbbbbbbbb": "<EVIDENCE source src/a.ts:1-3>" }
  };
  assert.throws(() => canonicalizeText("S-aaaaaaaaaa and S-bbbbbbbbbb", identity),
    /report canonical: evidence ids S-aaaaaaaaaa and S-bbbbbbbbbb both appear in the projection and both describe <EVIDENCE source src\/a.ts:1-3>/);
});
