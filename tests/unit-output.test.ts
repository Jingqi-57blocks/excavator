import test from "node:test";
import assert from "node:assert/strict";
import type { SectionClaim } from "../src/base/types.ts";
import { canonicalJson, sha256 } from "../src/base/util.ts";
import {
  parseUnitSummary, unitClaimsDigest, unitContentDigest, unitSummaryAgreementProblems, unitSummaryDigest,
  validateUnitClaims, UNIT_SUMMARY_VERSION, type UnitSummary, type UnitSummaryExpectation
} from "../src/report/unit-output.ts";
import { parseUnitReceipt, UNIT_RECEIPT_VERSION } from "../src/report/unit-receipt.ts";
import { collectedUnitsFor, unitLedgerProblems, withCollectedUnit, UNIT_LEDGER_VERSION, type CollectedUnit, type UnitLedger } from "../src/report/unit-ledger.ts";

/**
 * The unit output contract, as pure functions: what a summary, a claims sidecar, a receipt and the ledger must
 * be, and what every shape that is not that gets called.
 *
 * The summary is REQUIRED output, so its failures are draft-time failures, and each one has to be reachable and
 * named. Nothing here touches disk - the end-to-end fixture in `unit-authoring.test.ts` is where these refusals
 * are exercised through the real command.
 */

const DIGEST = "a".repeat(64);

function summary(overrides: Partial<UnitSummary> = {}): UnitSummary {
  return {
    version: UNIT_SUMMARY_VERSION,
    unitId: "overview-product::leaf::route",
    documentId: "overview-product",
    kind: "leaf",
    coveredTopicIds: ["route:1111111111111111", "route:2222222222222222"],
    keyStatements: ["The route layer is recorded."],
    unknowns: [],
    terminology: [],
    contentDigest: DIGEST,
    claimsDigest: "b".repeat(64),
    childSummaryDigests: [],
    ...overrides
  };
}

function expectation(overrides: Partial<UnitSummaryExpectation> = {}): UnitSummaryExpectation {
  return {
    unitId: "overview-product::leaf::route",
    documentId: "overview-product",
    kind: "leaf",
    topicIds: ["route:1111111111111111", "route:2222222222222222"],
    contentDigest: DIGEST,
    claimsDigest: "b".repeat(64),
    childSummaryDigests: [],
    ...overrides
  };
}

test("a legal summary parses, and agrees with the plan row and the bytes beside it", () => {
  const parsed = parseUnitSummary(summary());
  assert.deepEqual(parsed.problems, []);
  assert.ok(parsed.summary);
  assert.deepEqual(unitSummaryAgreementProblems(parsed.summary, expectation()), []);
  // The digest is over the canonical form, so key order in the file cannot move it.
  assert.equal(unitSummaryDigest(parsed.summary), sha256(canonicalJson(summary())));
});

test("a summary missing any required field, or carrying an unknown one, is a named parse failure", () => {
  for (const field of Object.keys(summary())) {
    const without = { ...summary() } as Record<string, unknown>;
    delete without[field];
    const parsed = parseUnitSummary(without);
    assert.equal(parsed.summary, null, `a summary without ${field} parsed`);
    assert.ok(parsed.problems.some((problem) => problem.includes(`is missing field ${JSON.stringify(field)}`)),
      `${field}: ${parsed.problems.join("; ")}`);
  }
  const extra = parseUnitSummary({ ...summary(), coverage: "98%" });
  assert.equal(extra.summary, null);
  assert.ok(extra.problems.some((problem) => problem.includes('has unknown field "coverage"')), extra.problems.join("; "));
});

test("a summary that states nothing, or states a blank thing, is refused", () => {
  assert.ok(parseUnitSummary(summary({ keyStatements: [] })).problems.some((problem) => /keyStatements is empty; a unit that states nothing has not been written/.test(problem)));
  assert.ok(parseUnitSummary(summary({ keyStatements: ["  "] })).problems.some((problem) => /keyStatements .* is not an array of non-empty strings/.test(problem)));
  assert.ok(parseUnitSummary(summary({ unknowns: [""] })).problems.some((problem) => /unknowns .* is not an array of non-empty strings/.test(problem)));
  // `unknowns` may be EMPTY, but the field is always present: "none" is stated, never absent.
  assert.deepEqual(parseUnitSummary(summary({ unknowns: [] })).problems, []);
});

test("terminology and child digests carry exactly their two fields, ascending, with real digests", () => {
  assert.ok(parseUnitSummary(summary({ terminology: [{ term: "leave", meaning: "" }] })).problems.some((problem) => /terminology\[0\] meaning/.test(problem)));
  assert.ok(parseUnitSummary(summary({ terminology: [{ term: "leave", meaning: "x", note: "y" } as never] })).problems.some((problem) => /terminology\[0\] has fields meaning, note, term/.test(problem)));
  assert.ok(parseUnitSummary(summary({ childSummaryDigests: [{ childUnitId: "b", summaryDigest: "short" }] })).problems.some((problem) => /summaryDigest "short" is not a sha256 digest/.test(problem)));
  assert.ok(parseUnitSummary(summary({
    childSummaryDigests: [{ childUnitId: "b", summaryDigest: DIGEST }, { childUnitId: "a", summaryDigest: DIGEST }]
  })).problems.some((problem) => /does not follow "b"; the rows must be strictly ascending/.test(problem)));
});

test("coveredTopicIds must be the plan's topics exactly - a subset is the silent narrowing this check exists for", () => {
  const short = parseUnitSummary(summary({ coveredTopicIds: ["route:1111111111111111"] }));
  assert.ok(short.summary);
  const problems = unitSummaryAgreementProblems(short.summary, expectation());
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /covers topic\(s\) \[route:1111111111111111\] but the plan gives this unit \[route:1111111111111111, route:2222222222222222\]; a summary covers its unit's topics exactly/);

  const extra = parseUnitSummary(summary({ coveredTopicIds: ["route:1111111111111111", "route:2222222222222222", "route:3333333333333333"] }));
  assert.ok(extra.summary);
  assert.equal(unitSummaryAgreementProblems(extra.summary, expectation()).length, 1);
  // An unsorted list never even gets that far: two identical summaries would otherwise differ by byte.
  assert.ok(parseUnitSummary(summary({ coveredTopicIds: ["route:2222222222222222", "route:1111111111111111"] }))
    .problems.some((problem) => /is not sorted and de-duplicated/.test(problem)));
});

test("a digest that does not match prints both sides, and a mismatched unit or kind is named", () => {
  const parsed = parseUnitSummary(summary({ contentDigest: "c".repeat(64) }));
  assert.ok(parsed.summary);
  assert.match(unitSummaryAgreementProblems(parsed.summary, expectation())[0]!,
    new RegExp(`records contentDigest c{64} but the content beside it digests to a{64}`));
  const other = parseUnitSummary(summary({ unitId: "overview-product::leaf::other", kind: "appendix" }));
  assert.ok(other.summary);
  const problems = unitSummaryAgreementProblems(other.summary, expectation());
  assert.ok(problems.some((problem) => /names unit "overview-product::leaf::other", but it is the summary of/.test(problem)));
  assert.ok(problems.some((problem) => /declares kind "appendix", but the plan records "leaf"/.test(problem)));
});

test("a synthesis summary must reference exactly the children the ledger recorded", () => {
  const parsed = parseUnitSummary(summary({
    kind: "synthesis",
    coveredTopicIds: [],
    childSummaryDigests: [{ childUnitId: "overview-product::appendix::coverage", summaryDigest: DIGEST }]
  }));
  assert.ok(parsed.summary);
  const expected = expectation({ kind: "synthesis", topicIds: [], childSummaryDigests: [] });
  assert.match(unitSummaryAgreementProblems(parsed.summary, expected)[0]!, /records child summaries .* but its collected children are \[\]/);
  assert.deepEqual(unitSummaryAgreementProblems(parsed.summary, { ...expected, childSummaryDigests: parsed.summary.childSummaryDigests }), []);
});

test("the claims sidecar reuses the section path's per-claim rules and refuses a duplicate claim id", () => {
  const claim: SectionClaim = { id: "C-1", marker: "fact", statement: "recorded", evidenceIds: ["E-1"] };
  const file = validateUnitClaims("u::1", "overview-product", [claim]);
  assert.deepEqual(file, { version: "unit-claims-v1", unitId: "u::1", documentId: "overview-product", claims: [claim] });
  assert.equal(unitClaimsDigest(file), sha256(canonicalJson(file)));
  // An EMPTY list is legal, and still produces a sidecar - so claimsDigest always describes a file on disk.
  assert.deepEqual(validateUnitClaims("u::1", "overview-product", []).claims, []);
  assert.throws(() => validateUnitClaims("u::1", "overview-product", [{ ...claim, statement: "" }]), /Invalid claim in unit u::1/);
  assert.throws(() => validateUnitClaims("u::1", "overview-product", [claim, claim]), /states claim id "C-1" twice/);
});

test("content digest is the digest of the normalized bytes, not of the author's input", () => {
  assert.equal(unitContentDigest("## Title\n\nbody\n"), sha256("## Title\n\nbody\n"));
  assert.notEqual(unitContentDigest("## Title\n\nbody\n"), unitContentDigest("## Title\n\nbody"));
});

test("a receipt without an epoch is refused - the field is required, unlike the section receipt's", () => {
  const receipt = {
    version: UNIT_RECEIPT_VERSION, runId: "run-1", knowledgeEpoch: 0, planCatalogDigest: DIGEST,
    unitId: "u::1", documentId: "overview-product", kind: "appendix", draftedAt: "2026-08-20T00:00:00.000Z",
    revision: false, contentDigest: DIGEST, claimsDigest: DIGEST, summaryDigest: DIGEST,
    evidenceIds: [], traceIds: []
  };
  assert.deepEqual(parseUnitReceipt(receipt).problems, []);
  const { knowledgeEpoch, ...withoutEpoch } = receipt;
  const parsed = parseUnitReceipt(withoutEpoch);
  assert.equal(parsed.receipt, null);
  assert.ok(parsed.problems.some((problem) => /is missing field "knowledgeEpoch"/.test(problem)), parsed.problems.join("; "));
  assert.ok(parseUnitReceipt({ ...receipt, knowledgeEpoch: null }).problems.some((problem) => /a unit receipt always records the epoch it was drafted from/.test(problem)));
  assert.ok(parseUnitReceipt({ ...receipt, kind: "chapter" }).problems.some((problem) => /kind "chapter" is not one of: appendix, bridge, leaf, synthesis/.test(problem)));
});

test("the ledger is per-epoch and per-plan: a row from another epoch is not a collection of this one", () => {
  const row = (overrides: Partial<CollectedUnit> = {}): CollectedUnit => ({
    unitId: "u::1", documentId: "overview-product", kind: "appendix", knowledgeEpoch: 0,
    planCatalogDigest: DIGEST, collectedAt: "2026-08-20T00:00:00.000Z", revision: false,
    contentDigest: DIGEST, claimsDigest: DIGEST, summaryDigest: DIGEST, timelineSequence: 12, ...overrides
  });
  const ledger: UnitLedger = { version: UNIT_LEDGER_VERSION, runId: "run-1", units: [row(), row({ unitId: "u::2", knowledgeEpoch: 1 })] };
  assert.deepEqual(unitLedgerProblems(ledger, "run-1"), []);
  assert.deepEqual(collectedUnitsFor(ledger, 0, DIGEST).map((unit) => unit.unitId), ["u::1"]);
  assert.deepEqual(collectedUnitsFor(ledger, 0, "c".repeat(64)).map((unit) => unit.unitId), []);
  // A revision REPLACES its row rather than appending a twin, and the rows stay ascending.
  const revised = withCollectedUnit(ledger, row({ revision: true, timelineSequence: 20 }));
  assert.equal(revised.units.filter((unit) => unit.unitId === "u::1").length, 1);
  assert.deepEqual(revised.units.map((unit) => unit.unitId), ["u::1", "u::2"]);
  assert.equal(revised.units[0]!.timelineSequence, 20);
  assert.ok(unitLedgerProblems({ ...ledger, runId: "run-2" }, "run-1").some((problem) => /is not this run's "run-1"/.test(problem)));
  assert.ok(unitLedgerProblems({ ...ledger, units: [row({ unitId: "u::2" }), row()] }, "run-1").some((problem) => /must be strictly ascending by unit id/.test(problem)));
});

/**
 * The collate-equal pair, on the two places an identity order is load-bearing.
 *
 * `"café"` in NFC and in NFD are two distinct strings that `localeCompare` calls equal, and `unit-paths.test.ts`
 * certifies them as two legitimate units with two distinct directories. Sorting with a collator and then
 * demanding "strictly ascending" from that same collator produced a file its own reader refuses - a run bricked
 * by bytes collect itself wrote - and a synthesis over two such children could never produce an acceptable
 * summary. Both are now one total comparator, and these are the fixtures that say so.
 */
const NFC_ID = "café::topic";
const NFD_ID = "café::topic";

test("a ledger holding a collate-equal pair round-trips through its own validator", () => {
  assert.equal(NFC_ID.localeCompare(NFD_ID), 0, "the fixture only means something while the collator calls these equal");
  assert.notEqual(NFC_ID, NFD_ID);
  const row = (unitId: string): CollectedUnit => ({
    unitId, documentId: "overview-product", kind: "leaf", knowledgeEpoch: 0,
    planCatalogDigest: DIGEST, collectedAt: "2026-08-20T00:00:00.000Z", revision: false,
    contentDigest: DIGEST, claimsDigest: DIGEST, summaryDigest: DIGEST, timelineSequence: 4
  });
  // Inserted in the order a collator would LEAVE UNCHANGED (it returns 0, and `sort` is stable) but that the
  // total order forbids, so both halves of the fix are load-bearing: the writer's sort and the reader's check.
  const written = withCollectedUnit(withCollectedUnit({ version: UNIT_LEDGER_VERSION, runId: "run-1", units: [] }, row(NFC_ID)), row(NFD_ID));
  assert.deepEqual(written.units.map((unit) => unit.unitId), [NFD_ID, NFC_ID], "the writer must impose the total order, not preserve insertion order");
  assert.equal(written.units.length, 2);
  assert.deepEqual(unitLedgerProblems(written, "run-1"), [],
    "collect must not be able to write a ledger that every later read refuses");
});

test("a synthesis over a collate-equal pair of children can state a summary Core accepts", () => {
  const digests = [NFC_ID, NFD_ID].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((childUnitId) => ({ childUnitId, summaryDigest: DIGEST }));
  const parsed = parseUnitSummary(summary({ kind: "synthesis", coveredTopicIds: [], childSummaryDigests: digests }));
  assert.deepEqual(parsed.problems, [], "the order draft derives must be the order the parser accepts");
  assert.ok(parsed.summary);
  assert.deepEqual(unitSummaryAgreementProblems(parsed.summary, expectation({ kind: "synthesis", topicIds: [], childSummaryDigests: digests })), []);
});
