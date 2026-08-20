import test from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import {
  assertDistinctUnitPathKeys, assertUsableUnitId, UNIT_ID_MAX_LENGTH, UNIT_LEDGER_FILENAME,
  UNIT_PATH_KEY_PATTERN, unitLedgerPath, unitPathKey, unitPaths
} from "../src/report/unit-paths.ts";

/**
 * A unit id is a string a MODEL wrote, and this slice turns it into a directory name.
 *
 * `parsePlanProposal` requires only that a unit id be a non-empty string, and the ids a real plan carries hold
 * `::`. So the untrusted-string-to-path step is the first thing this slice has to get right, and it is a
 * path-traversal question, not a formatting one. Two properties are tested here: hostile shapes are refused BY
 * NAME before anything is written, and two distinct ids can never share one directory - including on the
 * case-insensitive, Unicode-normalizing filesystem this repository is developed on.
 */

const RUN = "/tmp/excavator-runs/run-1";

const NUL = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);

test("a unit id that could escape its directory is refused by name, before any encoding", () => {
  const refusals: Array<[string, RegExp]> = [
    ["", /is blank; a unit id names a directory inside the run/],
    ["   ", /is blank; a unit id names a directory inside the run/],
    ["../../etc/passwd", /contains a path separator; a unit id is one path segment, never a path/],
    ["..", /is a filesystem-relative name, not a unit id/],
    [".", /is a filesystem-relative name, not a unit id/],
    ["a..b", /contains a path traversal segment/],
    ["/absolute", /contains a path separator/],
    ["windows\\path", /contains a path separator/],
    ["C:relative", /starts with a drive-relative prefix/],
    ["a::b", /starts with a drive-relative prefix/],
    ["nul", /is the Windows reserved device name "NUL"/],
    ["COM1.md", /is the Windows reserved device name "COM1"/],
    [" leading", /begins or ends with a dot or a space/],
    ["trailing ", /begins or ends with a dot or a space/],
    ["trailing.", /begins or ends with a dot or a space/],
    [`with${NUL}nul`, /contains a control character \(0x00 at index 4\)/],
    [`with${NEWLINE}newline`, /contains a control character \(0x0a at index 4\)/],
    ["x".repeat(UNIT_ID_MAX_LENGTH + 1), new RegExp(`is ${UNIT_ID_MAX_LENGTH + 1} characters; a unit id is capped at ${UNIT_ID_MAX_LENGTH}`)]
  ];
  for (const [unitId, expected] of refusals) {
    assert.throws(() => assertUsableUnitId(unitId), expected, `assertUsableUnitId accepted ${JSON.stringify(unitId)}`);
    assert.throws(() => unitPathKey(unitId), expected, `unitPathKey accepted ${JSON.stringify(unitId)}`);
    assert.throws(() => unitPaths(RUN, unitId), expected, `unitPaths accepted ${JSON.stringify(unitId)}`);
  }
});

test("the ids a real plan carries encode to one safe ASCII segment, and the id is still readable in it", () => {
  const key = unitPathKey("overview-product::appendix::coverage");
  assert.match(key, UNIT_PATH_KEY_PATTERN);
  assert.match(key, /^overview-product-appendix-coverage-[0-9a-f]{16}$/);
  // The colon a real unit id carries never reaches the filesystem: on Windows it is a drive/stream separator.
  assert.equal(key.includes(":"), false);
  assert.equal(unitPathKey("x".repeat(UNIT_ID_MAX_LENGTH)).length <= 48 + 1 + 16, true);
});

test("every path a unit occupies is derived from the run directory it was handed and stays inside it", () => {
  const paths = unitPaths(RUN, "overview-product::appendix::coverage");
  for (const path of [paths.dir, paths.content, paths.claims, paths.summary, paths.receipt, paths.historyDir]) {
    assert.ok(path.startsWith(`${RUN}${sep}`), path);
  }
  assert.equal(paths.dir, join(RUN, "units", paths.key));
  assert.deepEqual(
    [paths.content, paths.claims, paths.summary, paths.receipt].map((path) => path.slice(paths.dir.length + 1)),
    ["content.md", "claims.json", "summary.json", "receipt.json"]
  );
  // 57B-452: the same unit id under a different run directory resolves into that directory, nothing recorded.
  const moved = unitPaths("/tmp/excavator-runs/copy-1", "overview-product::appendix::coverage");
  assert.equal(moved.key, paths.key);
  assert.equal(moved.content, join("/tmp/excavator-runs/copy-1", "units", paths.key, "content.md"));
});

/**
 * The collapse fixture, and the instrument test that goes with it.
 *
 * `ab::b` and `ab__b` are two units. Under a slug-only encoding - the design this module rejected - they land in
 * ONE directory, and two units sharing one set of artifacts is one unit wearing two identities: every row count
 * downstream still balances, which is exactly why nothing else would notice. The guard is checked in both
 * directions: it FIRES on the weak encoder (so the check is known to work) and it stays silent on the real one
 * (so the real one is known to avoid the collapse). The last two entries are one word in NFC and in NFD, the
 * pair a normalizing filesystem folds together.
 */
const COLLAPSE_FIXTURE = [
  "ab::b", "ab__b", "ab  b",
  "XY::A", "xy::a",
  "café::topic", "café::topic"
];

test("the slug-only encoder collapses distinct unit ids, and the guard says so by name", () => {
  const slugOnly = (unitId: string): string => unitId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  assert.throws(() => assertDistinctUnitPathKeys(COLLAPSE_FIXTURE, slugOnly),
    /both encode to the directory "ab-b"; two units in one directory is one unit wearing two identities/);
});

test("the real encoder keeps every id in the collapse fixture apart, case and Unicode form included", () => {
  assertDistinctUnitPathKeys(COLLAPSE_FIXTURE, unitPathKey);
  const keys = COLLAPSE_FIXTURE.map(unitPathKey);
  assert.equal(new Set(keys).size, COLLAPSE_FIXTURE.length);
  // Lowercase ASCII only, so neither case folding nor NFC/NFD can fold two of these names together.
  for (const key of keys) {
    assert.match(key, UNIT_PATH_KEY_PATTERN);
    assert.equal(key, key.toLowerCase());
    assert.equal(key, key.normalize("NFC"));
  }
  // The two that slug identically differ in the half that carries the identity.
  assert.notEqual(unitPathKey("ab::b"), unitPathKey("ab__b"));
  assert.equal(unitPathKey("ab::b").split("-").slice(0, -1).join("-"), unitPathKey("ab__b").split("-").slice(0, -1).join("-"));
});

test("the guard accepts a repeated id - the same unit twice is one directory, which is not a collision", () => {
  assertDistinctUnitPathKeys(["ab::b", "ab::b"], unitPathKey);
});

test("the collect-written ledger cannot be shadowed by an encoded unit directory", () => {
  // The ledger sits beside the per-unit directories; a key can never contain a dot, so no unit id can claim it.
  assert.equal(UNIT_PATH_KEY_PATTERN.test(UNIT_LEDGER_FILENAME), false);
  assert.equal(unitLedgerPath(RUN), join(RUN, "units", UNIT_LEDGER_FILENAME));
  for (const unitId of ["collected.json", "collected", "COLLECTED.JSON", "units"]) {
    assert.notEqual(unitPathKey(unitId), UNIT_LEDGER_FILENAME);
  }
});
