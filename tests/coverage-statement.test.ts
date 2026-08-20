import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  COVERAGE_STATEMENT_PREFIXES,
  COVERAGE_VIOLATION_KINDS,
  VACUOUS_SOURCES,
  coverageStatement,
  coverageStatementSentence,
  coverageViolation,
  coverageViolationSentence,
  determinedNegativeSentence,
  readsAsCovered,
  renderCoverageStatement,
  type CoverageViolation
} from "../src/investigation/coverage-statement.ts";

// THE WORDING AUTHORITY, TESTED AS AN AUTHORITY. 57B-449 and 57B-456 were both a boolean read two ways: an
// `unread === 0` that was true of an empty ledger AND of a fully-read one, so the same sentence served both. What
// has to hold here is not "the arms exist" but that the WRONG arm is unreachable — an empty denominator, a
// displacement and an absent ledger must not be able to produce the covered wording no matter how a caller asks.

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, "..", "src", "investigation", "coverage-statement.ts");

const LEDGER = "coverage/read-obligations.json";

function unread(rows: number, ids: readonly string[] = []): CoverageViolation {
  const entry = coverageViolation("unread-residual", rows, ids, "test fixture");
  assert.ok(entry, "the fixture only ever asks for a non-zero entry");
  return entry;
}

// --- the union has no boolean, and cannot grow one by accident -------------------------------------------------

test("there is no pass/fail boolean anywhere in the rule", () => {
  const source = readFileSync(MODULE, "utf8");
  // `readsAsCovered` is a DERIVED predicate for tests; a stored one is the shape both defects exploited.
  assert.doesNotMatch(source, /\bpassed\b\s*[:?]/, "a `passed` field is the exact shape 57B-449 and 57B-456 both read two ways");
  assert.doesNotMatch(source, /readonly (ok|pass|passed|covered|complete)\s*[:?]\s*boolean/);
  assert.ok(source.includes("assertNever(entry.kind"), "the kind switch is closed");
  assert.ok(source.includes("assertNever(statement,"), "the arm switch is closed");
  assert.doesNotMatch(source, /\bdefault:/, "an exhaustive switch with a `default` arm is not exhaustive");
});

// --- the three arms, and which inputs can reach them ----------------------------------------------------------

test("an absent ledger is vacuous, names its source, and can never be covered", () => {
  const statement = coverageStatement({
    subject: "read obligations",
    denominator: { state: "absent", ledger: LEDGER, reason: "the file is gone" },
    // Even with no entries at all — the shape a caller would use for a clean run — absence wins.
    entries: []
  });
  assert.equal(statement.state, "vacuous");
  assert.equal(statement.state === "vacuous" && statement.source, "ledger-absent");
  assert.equal(readsAsCovered(statement), false);
  assert.ok(!coverageStatementSentence(statement).includes(COVERAGE_STATEMENT_PREFIXES.complete));
});

test("an empty ledger is vacuous too, and its sentence is not the absent one — 57B-449", () => {
  const empty = coverageStatement({ subject: "read obligations", denominator: { state: "present", ledger: LEDGER, rows: 0, counted: 0 }, entries: [] });
  const absent = coverageStatement({ subject: "read obligations", denominator: { state: "absent", ledger: LEDGER, reason: "the file is gone" }, entries: [] });
  assert.equal(empty.state === "vacuous" && empty.source, "ledger-empty");
  assert.equal(absent.state === "vacuous" && absent.source, "ledger-absent");
  // The falsification the issue names: merging the two into one sentence. This assertion is what reddens.
  assert.notEqual(coverageStatementSentence(empty), coverageStatementSentence(absent));
  for (const source of VACUOUS_SOURCES) {
    const sentence = source === "ledger-empty" ? coverageStatementSentence(empty) : coverageStatementSentence(absent);
    assert.ok(sentence.includes(source), `${source} names itself in its own sentence`);
    assert.ok(!sentence.includes(VACUOUS_SOURCES.find((other) => other !== source)!), `${source} does not name the other`);
  }
});

test("a non-empty denominator with nothing withheld is the ONLY way to reach covered", () => {
  const statement = coverageStatement({ subject: "read obligations", denominator: { state: "present", ledger: LEDGER, rows: 946, counted: 946 }, entries: [] });
  assert.equal(statement.state, "complete");
  assert.equal(readsAsCovered(statement), true);
  assert.equal(statement.state === "complete" && statement.conservation.unexplained, 0);
});

// The 57B-456 acceptance, at the constructor: a displacement cannot be argued into the covered arm.
test("displacement cannot reach the covered arm, whatever the caller asks for", () => {
  for (const displaced of [1, 247]) {
    const statement = coverageStatement({
      subject: "authorized reads",
      denominator: { state: "present", ledger: "knowledge.json closure", rows: 473, counted: 473 - displaced },
      entries: [coverageViolation("displaced-by-budget", displaced, [], "a ceiling this run recorded")]
    });
    assert.equal(statement.state, "violations", `${displaced} displaced read(s) must not read as covered`);
    assert.equal(readsAsCovered(statement), false);
    assert.equal(statement.state === "violations" && statement.entries[0]!.kind, "displaced-by-budget");
  }
});

test("a waived material obligation is a counted exit and still not covered", () => {
  const statement = coverageStatement({
    subject: "material obligations",
    denominator: { state: "present", ledger: "plan/catalog.json accounting", rows: 847, counted: 48 },
    entries: [coverageViolation("waived-by-state", 799, [], "omitted-for-audience on two feature topics")]
  });
  assert.equal(statement.state, "violations");
  assert.equal(statement.state === "violations" && statement.conservation.excluded, 799);
});

// --- the arithmetic is the base constructor's, and a residue is refused ---------------------------------------

test("the three-state law holds and an unexplained residue is refused rather than published", () => {
  const balanced = coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 10, counted: 6 }, entries: [unread(4)] });
  assert.equal(balanced.state, "violations");
  assert.deepEqual(
    balanced.state === "violations" ? { total: balanced.conservation.total, counted: balanced.conservation.counted, excluded: balanced.conservation.excluded, unexplained: balanced.conservation.unexplained } : null,
    { total: 10, counted: 6, excluded: 4, unexplained: 0 }
  );
  assert.throws(
    () => coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 10, counted: 6 }, entries: [unread(2)] }),
    /does not conserve.*leaving 2 in no bucket/s,
    "a row in no bucket is the silent loss the whole module exists to prevent"
  );
  assert.throws(
    () => coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 10, counted: 8 }, entries: [unread(4)] }),
    /Coverage conservation is impossible/,
    "double counting is refused by the base constructor, not re-implemented here"
  );
});

test("a zero-row entry is absent, never a listed nothing", () => {
  assert.equal(coverageViolation("unread-residual", 0, [], "nothing"), undefined);
  const statement = coverageStatement({
    subject: "rows",
    denominator: { state: "present", ledger: LEDGER, rows: 3, counted: 3 },
    entries: [coverageViolation("unread-residual", 0, [], "nothing"), undefined]
  });
  assert.equal(statement.state, "complete", "a zero entry must not turn a covered statement into a violated one");
});

test("an entry either lists every row it accounts for or lists none", () => {
  assert.throws(() => coverageViolation("unread-residual", 3, ["a"], "partial"), /names 1 id\(s\) for 3 row\(s\)/);
  assert.throws(() => coverageViolation("unread-residual", -1, [], "negative"), /non-negative integer/);
  assert.throws(() => coverageViolation("unread-residual", 2, [], "   "), /must say where its 2 row\(s\) came from/);
});

// --- the sentences ---------------------------------------------------------------------------------------------

test("the three prefixes are pairwise non-substring, so 'never covered' can be asserted", () => {
  const values = Object.values(COVERAGE_STATEMENT_PREFIXES);
  assert.equal(new Set(values).size, values.length);
  for (const a of values) {
    for (const b of values) {
      if (a === b) continue;
      assert.ok(!a.includes(b), `${JSON.stringify(a)} must not contain ${JSON.stringify(b)}: a test asserting the absence of one would pass over the other`);
    }
  }
});

test("every violation kind has its own sentence, and no two are the same", () => {
  const sentences = COVERAGE_VIOLATION_KINDS.map((kind) => coverageViolationSentence({ kind, rows: 2, ids: [], detail: "d" }));
  assert.equal(new Set(sentences).size, COVERAGE_VIOLATION_KINDS.length, "a shared sentence is a merged concept");
  for (const sentence of sentences) assert.ok(sentence.includes("2 rows"), sentence);
  // The closed switch: an unregistered kind is a named throw, not a silent empty string.
  assert.throws(
    () => coverageViolationSentence({ kind: "invented-kind" as CoverageViolation["kind"], rows: 1, ids: [], detail: "d" }),
    /Unhandled coverage violation kind state/
  );
});

// 57B-456's second acceptance: "a ceiling pushed the read out" and "the read happened and found nothing" are
// opposite facts and must not share a phrase a reader could take for the other.
test("displacement and a determined negative are distinguishable in wording", () => {
  const displaced = coverageViolationSentence({ kind: "displaced-by-budget", rows: 247, ids: [], detail: "recorded ceiling" });
  const negative = determinedNegativeSentence(41);
  assert.ok(displaced.includes("never attempted"), displaced);
  assert.ok(negative.includes("READ AND SETTLED NEGATIVELY"), negative);
  // Neither sentence may contain the other's distinguishing phrase, in either direction.
  assert.ok(!displaced.includes("SETTLED NEGATIVELY"));
  assert.ok(!negative.includes("never attempted"));
  assert.ok(!negative.includes("displaced"), "a determined negative is knowledge, not a gap");
});

test("a bounded id list still states the full size it was cut from", () => {
  const statement = coverageStatement({
    subject: "rows",
    denominator: { state: "present", ledger: LEDGER, rows: 9, counted: 4 },
    entries: [unread(5, ["e", "d", "c", "b", "a"])]
  });
  const lines = renderCoverageStatement(statement, 2);
  assert.ok(lines[1]!.includes("5 rows"), lines[1]);
  assert.ok(lines[2]!.includes("`a`, `b`"), lines[2]);
  assert.ok(lines[2]!.includes("… 3 more id(s) not listed here"), lines[2]);
  // A zero bound never hides the count, only the ids.
  const bounded = renderCoverageStatement(statement, 0);
  assert.ok(bounded[1]!.includes("5 rows"));
  assert.ok(bounded[2]!.includes("5 id(s) not listed here"));
  assert.throws(() => renderCoverageStatement(statement, -1), /non-negative integer/);
});

test("two statements over the same counts render the same bytes, whatever order the entries arrive in", () => {
  const entries = [
    coverageViolation("waived-by-state", 2, [], "b"),
    coverageViolation("unread-residual", 3, [], "a"),
    coverageViolation("displaced-by-budget", 1, [], "c")
  ];
  const build = (order: readonly (CoverageViolation | undefined)[]) => renderCoverageStatement(
    coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 10, counted: 4 }, entries: order }),
    5
  ).join("\n");
  assert.equal(build([...entries].reverse()), build(entries));
  // And the order is the KIND order, not arrival order, so two runs read the same way round.
  const rendered = build(entries);
  assert.ok(rendered.indexOf("read obligations no source window covers") < rendered.indexOf("pushed out before they happened"));
});

test("a statement must name its subject and the one ledger its denominator came from", () => {
  assert.throws(() => coverageStatement({ subject: "  ", denominator: { state: "present", ledger: LEDGER, rows: 1, counted: 1 }, entries: [] }), /must name what it counts/);
  assert.throws(() => coverageStatement({ subject: "rows", denominator: { state: "present", ledger: " ", rows: 1, counted: 1 }, entries: [] }), /must name the one ledger/);
  assert.throws(() => coverageStatement({ subject: "rows", denominator: { state: "absent", ledger: LEDGER, reason: "" }, entries: [] }), /must say why/);
});
