import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  COVERAGE_ENTRY_CATEGORIES,
  COVERAGE_ENTRY_KINDS,
  COVERAGE_KIND_CATEGORY,
  COVERAGE_STATEMENT_PREFIXES,
  VACUOUS_SOURCES,
  coverageEntry,
  coverageEntryCategory,
  coverageEntrySentence,
  coverageStatement,
  coverageStatementEntries,
  coverageStatementSentence,
  determinedNegativeSentence,
  readsAsCovered,
  renderCoverageStatement,
  rowsOf,
  type CoverageEntry,
  type CoverageStatement
} from "../src/investigation/coverage-statement.ts";

// THE WORDING AUTHORITY, TESTED AS AN AUTHORITY. 57B-449 and 57B-456 were both a boolean read two ways: an
// `unread === 0` that was true of an empty ledger AND of a fully-read one, so the same sentence served both. What
// has to hold here is not "the arms exist" but that the WRONG arm is unreachable — an empty denominator, a
// displacement and an absent ledger must not be able to produce the covered wording no matter how a caller asks.
//
// AND SINCE THE ARM SPLIT, a second authority is under test: which entry kinds are DECISIONS and which are DEBTS.
// The old single `violations` arm held both, and two consecutive consumers read the arm name as a defect gate. The
// tests below therefore assert the category table is total, that it is LOAD-BEARING (moving one row moves an arm),
// and that a defective statement carries its withheld entries instead of dropping them.

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, "..", "src", "investigation", "coverage-statement.ts");

const LEDGER = "coverage/read-obligations.json";

function unread(rows: number, ids: readonly string[] = []): CoverageEntry {
  const entry = coverageEntry("unread-residual", rows, ids, "test fixture");
  assert.ok(entry, "the fixture only ever asks for a non-zero entry");
  return entry;
}

function waived(rows: number, detail = "omitted-for-audience"): CoverageEntry {
  const entry = coverageEntry("waived-by-state", rows, [], detail);
  assert.ok(entry);
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

// THE VOCABULARY BOUNDARY, as a source guard. `TopicDispositionVerdict` and plan validation keep `violations` for a
// conclusion that is entirely defects and that `plan-gate.ts` really does refuse a plan on. This union may not take
// that word back for something that also holds legitimate exits.
test("no arm of this union is called `violations`, and no sentence prints that word as a prefix", () => {
  const source = readFileSync(MODULE, "utf8");
  assert.doesNotMatch(source, /state: "violations"/, "the arm name the split removed may not come back");
  assert.doesNotMatch(source, /"violations:"/, "the prefix belongs to the other union's vocabulary");
  assert.ok(!Object.values(COVERAGE_STATEMENT_PREFIXES).some((prefix) => prefix.startsWith("violations")));
});

// --- the category table: total, closed, and load-bearing -------------------------------------------------------

test("every entry kind has exactly one category and the table holds nothing else", () => {
  assert.equal(Object.keys(COVERAGE_KIND_CATEGORY).length, COVERAGE_ENTRY_KINDS.length, "a table row for a kind that does not exist is a row nothing enforces");
  for (const kind of COVERAGE_ENTRY_KINDS) {
    const category = coverageEntryCategory(kind);
    assert.ok(COVERAGE_ENTRY_CATEGORIES.includes(category), `${kind} has no category`);
    assert.equal(category, COVERAGE_KIND_CATEGORY[kind], "the reading and the table must be one thing");
  }
  // Both sides are non-empty: a table that had drifted to all-defective or all-withheld would make the arm split
  // decorative while every assertion below still passed.
  const withheld = COVERAGE_ENTRY_KINDS.filter((kind) => coverageEntryCategory(kind) === "withheld");
  const defective = COVERAGE_ENTRY_KINDS.filter((kind) => coverageEntryCategory(kind) === "defective");
  assert.deepEqual([...withheld], ["ledger-excluded", "waived-by-state", "grounding-exempt"], "the three recorded exercises of discretion, in kind order");
  assert.equal(defective.length, COVERAGE_ENTRY_KINDS.length - withheld.length);
  // Every unknown-shaped kind is a debt: "nobody could settle it" is never "somebody decided".
  for (const kind of ["cannot-determine", "open-determination", "unknown-topic", "stated-unknown"] as const) {
    assert.equal(coverageEntryCategory(kind), "defective", `${kind} is an unresolved unknown, not a decision`);
  }
});

// THE FALSIFICATION for "the table is承重": move `waived-by-state` to the defective side and this arm changes.
test("a statement of nothing but recorded decisions takes the withheld arm", () => {
  const statement = coverageStatement({
    subject: "material obligations",
    denominator: { state: "present", ledger: "plan/catalog.json accounting", rows: 847, counted: 48 },
    entries: [waived(799, "disposition omitted-for-audience")]
  });
  assert.equal(statement.state, "withheld", "a plan omitting a topic for an audience is a decision, not a defect");
  assert.equal(readsAsCovered(statement), false, "withheld is still outside covered");
  assert.equal(statement.state === "withheld" && statement.withheld.length, 1);
  assert.equal(statement.state === "withheld" && statement.conservation.excluded, 799);
  const sentence = coverageStatementSentence(statement);
  assert.ok(sentence.startsWith(COVERAGE_STATEMENT_PREFIXES.withheld), sentence);
  assert.ok(!sentence.includes(COVERAGE_STATEMENT_PREFIXES.defective), "a decision may not be printed as a defect");
});

test("one defective entry decides the arm, and the withheld entries ride along instead of being dropped", () => {
  const statement = coverageStatement({
    subject: "read obligations",
    denominator: { state: "present", ledger: LEDGER, rows: 946, counted: 900 },
    entries: [unread(19), waived(27, "declared out of scope")]
  });
  assert.equal(statement.state, "defective");
  const defective = statement.state === "defective" ? statement : null;
  assert.deepEqual(defective!.defects.map((entry) => entry.kind), ["unread-residual"]);
  assert.deepEqual(defective!.withheld.map((entry) => entry.kind), ["waived-by-state"], "a defective statement still says what was withheld");
  // The conservation is over the SUM OF THE TWO LISTS: a row lost between the partition and an arm is a residue.
  assert.equal(defective!.conservation.excluded, 46);
  assert.equal(rowsOf(defective!.defects) + rowsOf(defective!.withheld), defective!.conservation.excluded);
  assert.equal(defective!.conservation.unexplained, 0);
  // And the rendering carries both lists, defects first.
  const lines = renderCoverageStatement(statement, 0);
  assert.equal(coverageStatementEntries(statement).length, 2);
  assert.ok(lines[1]!.includes("no source window covers"), lines[1]);
  assert.ok(lines[2]!.includes("a plan disposition took OUT"), lines[2]);
});

// --- the four arms, and which inputs can reach them ------------------------------------------------------------

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
  assert.deepEqual(coverageStatementEntries(statement), []);
});

// The 57B-456 acceptance, at the constructor: a displacement cannot be argued into the covered arm.
test("displacement cannot reach the covered arm, whatever the caller asks for", () => {
  for (const displaced of [1, 247]) {
    const statement = coverageStatement({
      subject: "authorized reads",
      denominator: { state: "present", ledger: "knowledge.json closure", rows: 473, counted: 473 - displaced },
      entries: [coverageEntry("displaced-by-budget", displaced, [], "a ceiling this run recorded")]
    });
    assert.equal(statement.state, "defective", `${displaced} displaced read(s) must not read as covered`);
    assert.equal(readsAsCovered(statement), false);
    assert.equal(statement.state === "defective" && statement.defects[0]!.kind, "displaced-by-budget");
    assert.deepEqual(statement.state === "defective" ? statement.withheld : null, [], "nothing was withheld here, and the empty list is stated rather than absent");
  }
});

test("a waived material obligation is a counted exit and still not covered", () => {
  const statement = coverageStatement({
    subject: "material obligations",
    denominator: { state: "present", ledger: "plan/catalog.json accounting", rows: 847, counted: 48 },
    entries: [coverageEntry("waived-by-state", 799, [], "omitted-for-audience on two feature topics")]
  });
  assert.equal(statement.state, "withheld");
  assert.equal(statement.state === "withheld" && statement.conservation.excluded, 799);
  assert.equal(readsAsCovered(statement), false);
});

// --- the arithmetic is the base constructor's, and a residue is refused ---------------------------------------

test("the three-state law holds and an unexplained residue is refused rather than published", () => {
  const balanced = coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 10, counted: 6 }, entries: [unread(4)] });
  assert.equal(balanced.state, "defective");
  assert.deepEqual(
    balanced.state === "defective" ? { total: balanced.conservation.total, counted: balanced.conservation.counted, excluded: balanced.conservation.excluded, unexplained: balanced.conservation.unexplained } : null,
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
  // The residue message names BOTH lists, so a partition bug is diagnosable from the throw alone.
  assert.throws(
    () => coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 20, counted: 6 }, entries: [unread(4), waived(3)] }),
    /1 defective and 1 withheld named entry\/entries/
  );
});

test("a zero-row entry is absent, never a listed nothing", () => {
  assert.equal(coverageEntry("unread-residual", 0, [], "nothing"), undefined);
  const statement = coverageStatement({
    subject: "rows",
    denominator: { state: "present", ledger: LEDGER, rows: 3, counted: 3 },
    entries: [coverageEntry("unread-residual", 0, [], "nothing"), undefined]
  });
  assert.equal(statement.state, "complete", "a zero entry must not turn a covered statement into a violated one");
});

test("an entry either lists every row it accounts for or lists none", () => {
  assert.throws(() => coverageEntry("unread-residual", 3, ["a"], "partial"), /names 1 id\(s\) for 3 row\(s\)/);
  assert.throws(() => coverageEntry("unread-residual", -1, [], "negative"), /non-negative integer/);
  assert.throws(() => coverageEntry("unread-residual", 2, [], "   "), /must say where its 2 row\(s\) came from/);
});

// --- the sentences ---------------------------------------------------------------------------------------------

test("the four prefixes are pairwise non-substring, so 'never covered' can be asserted", () => {
  const values = Object.values(COVERAGE_STATEMENT_PREFIXES);
  assert.equal(values.length, 4, "one prefix per arm, and the table is `satisfies Record<CoverageStatement[\"state\"], string>`");
  assert.equal(new Set(values).size, values.length);
  for (const a of values) {
    for (const b of values) {
      if (a === b) continue;
      assert.ok(!a.includes(b), `${JSON.stringify(a)} must not contain ${JSON.stringify(b)}: a test asserting the absence of one would pass over the other`);
    }
  }
});

// The negative law R7a set, extended to the two new arms: neither may borrow the covered vocabulary, and neither
// may print another arm's prefix. Written as a loop over one statement per arm so a fifth arm has to join it.
test("no arm outside complete uses covered-family wording, and each sentence carries only its own prefix", () => {
  const byArm: Record<CoverageStatement["state"], CoverageStatement> = {
    complete: coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 5, counted: 5 }, entries: [] }),
    vacuous: coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 0, counted: 0 }, entries: [] }),
    withheld: coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 9, counted: 4 }, entries: [waived(5)] }),
    defective: coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 9, counted: 4 }, entries: [unread(3), waived(2)] })
  };
  for (const [arm, statement] of Object.entries(byArm) as [CoverageStatement["state"], CoverageStatement][]) {
    assert.equal(statement.state, arm, `the constructor must reach ${arm} from this input`);
    const sentence = coverageStatementSentence(statement);
    assert.ok(sentence.startsWith(COVERAGE_STATEMENT_PREFIXES[arm]), sentence);
    for (const [other, prefix] of Object.entries(COVERAGE_STATEMENT_PREFIXES)) {
      if (other === arm) continue;
      assert.ok(!sentence.includes(prefix), `the ${arm} sentence must not contain the ${other} prefix: ${sentence}`);
    }
    if (arm === "complete") continue;
    // THE FALSIFICATION: hand-writing a covered-family clause into either new arm reddens here.
    assert.doesNotMatch(sentence, /\bcovered\b/i, `${arm} may not use the covered vocabulary: ${sentence}`);
    assert.doesNotMatch(sentence, /\bcomplete\b/i, `${arm} may not use the complete vocabulary: ${sentence}`);
    assert.equal(readsAsCovered(statement), false);
  }
});

// The entry sentences are what the split promised NOT to move: the arms changed, the twelve bullets did not. The
// table below is the pre-split text, copied from the code as it stood before the split.
const FROZEN_ENTRY_SENTENCES: Record<string, string> = {
  "unread-residual": "2 rows: read obligations no source window covers — nothing is known about what they would have shown (d)",
  "ledger-excluded": "2 rows: rows the ledger removed from its OWN counted denominator before anything was measured, so they are neither read nor unread (d)",
  "displaced-by-budget": "2 rows: authorized reads a ceiling THIS RUN RECORDED pushed out before they happened — they were never attempted, so nothing was learned or ruled out by them (d)",
  "waived-by-state": "2 rows: material obligations a plan disposition took OUT of this document — a decision the plan is allowed to make, and one this document does not answer for (d)",
  "claimed-but-unplaced": "2 rows: material obligations a placing disposition claims are covered and no unit writes (d)",
  "undispositioned": "2 rows: material obligations in no unit whose topics carry no readable disposition at all (d)",
  "owned-by-no-unit": "2 rows: material obligations this document reaches and no unit of it grounds (d)",
  "grounding-exempt": "2 rows: material obligations exempt from the grounding check, so nothing verifies that the document states them (d)",
  "cannot-determine": "2 rows: obligations the investigation could not determine — the question was asked and left open (d)",
  "open-determination": "2 rows: obligations still pending or in progress, so no determination exists for them yet (d)",
  "unknown-topic": "2 rows: catalog topics carrying an unknown — an unread residual span or an undetermined obligation (d)",
  "stated-unknown": "2 rows: unknowns the written units state about themselves (d)"
};

test("every entry kind has its own sentence, no two are the same, and none moved a byte in the split", () => {
  const sentences = COVERAGE_ENTRY_KINDS.map((kind) => coverageEntrySentence({ kind, rows: 2, ids: [], detail: "d" }));
  assert.equal(new Set(sentences).size, COVERAGE_ENTRY_KINDS.length, "a shared sentence is a merged concept");
  for (const sentence of sentences) assert.ok(sentence.includes("2 rows"), sentence);
  assert.deepEqual(Object.keys(FROZEN_ENTRY_SENTENCES).sort(), [...COVERAGE_ENTRY_KINDS].sort(), "the frozen table must cover exactly today's kinds");
  for (const kind of COVERAGE_ENTRY_KINDS) {
    assert.equal(coverageEntrySentence({ kind, rows: 2, ids: [], detail: "d" }), FROZEN_ENTRY_SENTENCES[kind], `the ${kind} sentence moved; the arm split does not license an entry rewording`);
  }
  // The closed switch: an unregistered kind is a named throw, not a silent empty string.
  assert.throws(
    () => coverageEntrySentence({ kind: "invented-kind" as CoverageEntry["kind"], rows: 1, ids: [], detail: "d" }),
    /Unhandled coverage entry kind state/
  );
});

// 57B-456's second acceptance: "a ceiling pushed the read out" and "the read happened and found nothing" are
// opposite facts and must not share a phrase a reader could take for the other.
test("displacement and a determined negative are distinguishable in wording", () => {
  const displaced = coverageEntrySentence({ kind: "displaced-by-budget", rows: 247, ids: [], detail: "recorded ceiling" });
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
    coverageEntry("waived-by-state", 2, [], "b"),
    coverageEntry("unread-residual", 3, [], "a"),
    coverageEntry("displaced-by-budget", 1, [], "c")
  ];
  const build = (order: readonly (CoverageEntry | undefined)[]) => renderCoverageStatement(
    coverageStatement({ subject: "rows", denominator: { state: "present", ledger: LEDGER, rows: 10, counted: 4 }, entries: order }),
    5
  ).join("\n");
  assert.equal(build([...entries].reverse()), build(entries));
  // And the order is the KIND order within each list, not arrival order, so two runs read the same way round.
  const rendered = build(entries);
  assert.ok(rendered.indexOf("read obligations no source window covers") < rendered.indexOf("pushed out before they happened"));
  // The withheld entry follows both defects: a reader sees what is owed before what was decided.
  assert.ok(rendered.indexOf("pushed out before they happened") < rendered.indexOf("a plan disposition took OUT"));
});

test("a statement must name its subject and the one ledger its denominator came from", () => {
  assert.throws(() => coverageStatement({ subject: "  ", denominator: { state: "present", ledger: LEDGER, rows: 1, counted: 1 }, entries: [] }), /must name what it counts/);
  assert.throws(() => coverageStatement({ subject: "rows", denominator: { state: "present", ledger: " ", rows: 1, counted: 1 }, entries: [] }), /must name the one ledger/);
  assert.throws(() => coverageStatement({ subject: "rows", denominator: { state: "absent", ledger: LEDGER, reason: "" }, entries: [] }), /must say why/);
});
