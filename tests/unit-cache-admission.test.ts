/**
 * The v2 unit record and the admission's own derivation, as values (R6b).
 *
 * TWO THINGS ARE PINNED HERE, and both are about what cannot be omitted.
 *
 *   1. THE THREE NEW FIELDS ARE REQUIRED. A receipt or a ledger row without an author, without the identity of the
 *      packet it was written from, or without saying whether it was written or admitted, is refused BY NAME. That is
 *      the difference between a cache that can be audited and one whose records look identical whether a model wrote
 *      the unit or a cache handed it over.
 *   2. A DRIFTED CANDIDATE CAN ONLY TAKE REUSE AWAY. The invalidation plan decides identity; the byte verification
 *      can downgrade a `reusable` verdict to a rebuild and can never create one. The conservation over the three
 *      buckets is asserted rather than reported, and a `reusable` entry with no verification at all is a named throw
 *      instead of an admission on bytes nobody checked.
 *
 * The candidate side here is the RECORDED-DIGEST form — the one a re-planned run on disk actually has, where the plan
 * the candidate was drafted under is gone and its ledger row's digest is the whole of what is knowable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { UNIT_RECEIPT_VERSION, parseUnitReceipt } from "../src/report/unit-receipt.ts";
import { UNIT_LEDGER_VERSION, unitLedgerProblems, type CollectedUnit, type UnitLedger } from "../src/report/unit-ledger.ts";
import { describeProvenance, type UnitAuthorship, type UnitProvenance } from "../src/report/unit-provenance.ts";
import {
  deriveUnitAdmissionPlan,
  outcomeOfUnattemptedIntent,
  summariseAdmission,
  type CandidateLedgerRow,
  type UnitAdmissionIntent
} from "../src/report/unit-cache-admission.ts";
import { describeCandidateSource, deriveUnitCachePlan, type CandidateIdentity, type CandidateSource } from "../src/report/unit-cache-plan.ts";
import { identityFixture, plannedIdentities, type PlanState } from "./unit-cache-identity-fixture.ts";
import type { IdentityFixture } from "./unit-cache-identity-fixture.ts";

const DIGEST = "a".repeat(64);
const OTHER = "b".repeat(64);
const AUTHOR: UnitAuthorship = { kind: "model-free", generator: "unit-cache-admission-test" };
const FRESH: UnitProvenance = { kind: "fresh" };
const ADMITTED: UnitProvenance = {
  kind: "cache-admitted",
  source: { knowledgeEpoch: 0, planCatalogDigest: OTHER, packetIdentityDigest: DIGEST, contentDigest: DIGEST, claimsDigest: DIGEST, summaryDigest: DIGEST }
};

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: UNIT_RECEIPT_VERSION, runId: "run-1", knowledgeEpoch: 0, planCatalogDigest: DIGEST,
    unitId: "u::1", documentId: "overview-product", kind: "appendix", draftedAt: "2026-08-20T00:00:00.000Z",
    revision: false, authorship: AUTHOR, packetIdentityDigest: DIGEST, provenance: FRESH,
    contentDigest: DIGEST, claimsDigest: DIGEST, summaryDigest: DIGEST, evidenceIds: [], traceIds: [],
    ...overrides
  };
}

function row(overrides: Partial<CollectedUnit> = {}): CollectedUnit {
  return {
    unitId: "u::1", documentId: "overview-product", kind: "appendix", knowledgeEpoch: 0,
    planCatalogDigest: DIGEST, collectedAt: "2026-08-20T00:00:00.000Z", revision: false,
    authorship: AUTHOR, packetIdentityDigest: DIGEST, provenance: FRESH,
    contentDigest: DIGEST, claimsDigest: DIGEST, summaryDigest: DIGEST, timelineSequence: 4, ...overrides
  };
}

function ledger(units: readonly CollectedUnit[]): UnitLedger {
  return { version: UNIT_LEDGER_VERSION, runId: "run-1", units };
}

test("a v2 receipt without an author, an identity or a provenance is refused by name", () => {
  assert.deepEqual(parseUnitReceipt(receipt()).problems, []);
  assert.deepEqual(parseUnitReceipt(receipt({ provenance: ADMITTED })).problems, []);

  for (const field of ["authorship", "packetIdentityDigest", "provenance"] as const) {
    const { [field]: _dropped, ...without } = receipt();
    const parsed = parseUnitReceipt(without);
    assert.equal(parsed.receipt, null, field);
    assert.ok(parsed.problems.some((problem) => problem === `is missing field ${JSON.stringify(field)}`), `${field}: ${parsed.problems.join("; ")}`);
  }
  // A v1 receipt is not a v2 receipt with three fields missing; it is a record from a build with no cache provenance.
  assert.ok(parseUnitReceipt(receipt({ version: "unit-receipt-v1" })).problems.some((problem) => /is not unit-receipt-v2/.test(problem)));

  // The author: a closed union, a non-empty name, and no untrimmed spelling — two spellings would be two identities.
  assert.ok(parseUnitReceipt(receipt({ authorship: { kind: "opus" } })).problems.some((problem) => /authorship kind "opus" is not one of: model-family, model-free/.test(problem)));
  assert.ok(parseUnitReceipt(receipt({ authorship: { kind: "model-family", family: "" } })).problems.some((problem) => /authorship family "" is not a non-empty name/.test(problem)));
  assert.ok(parseUnitReceipt(receipt({ authorship: { kind: "model-family", family: " opus" } })).problems.some((problem) => /without surrounding whitespace/.test(problem)));
  assert.ok(parseUnitReceipt(receipt({ authorship: { kind: "model-free", generator: "g", family: "g" } })).problems.some((problem) => /authorship has unknown field "family"/.test(problem)));

  // The provenance: two arms, and the admitted one must name the row it came from, whole.
  assert.ok(parseUnitReceipt(receipt({ provenance: { kind: "reused" } })).problems.some((problem) => /provenance kind "reused" is not one of: cache-admitted, fresh/.test(problem)));
  assert.ok(parseUnitReceipt(receipt({ provenance: { kind: "cache-admitted" } })).problems.some((problem) => /provenance source undefined is not the ledger row this admission came from/.test(problem)));
  assert.ok(parseUnitReceipt(receipt({ provenance: { kind: "fresh", source: {} } })).problems.some((problem) => /provenance has unknown field "source"/.test(problem)));
  const { packetIdentityDigest: _gone, ...partial } = ADMITTED.source;
  assert.ok(parseUnitReceipt(receipt({ provenance: { kind: "cache-admitted", source: partial } })).problems
    .some((problem) => /provenance source is missing field "packetIdentityDigest"/.test(problem)));
  assert.ok(parseUnitReceipt(receipt({ provenance: { kind: "cache-admitted", source: { ...ADMITTED.source, contentDigest: "short" } } })).problems
    .some((problem) => /provenance source contentDigest "short" is not a sha256 digest/.test(problem)));
  assert.ok(parseUnitReceipt(receipt({ packetIdentityDigest: "nope" })).problems.some((problem) => /packetIdentityDigest "nope" is not a sha256 digest/.test(problem)));

  // And the sentence a reading prints tells the two arms apart.
  assert.equal(describeProvenance(FRESH), "written for this record");
  assert.match(describeProvenance(ADMITTED), /^admitted from a unit verified at knowledge epoch 0 under plan bbbbbbbbbbbbbbbb, identity aaaaaaaaaaaaaaaa$/);
});

test("a v2 ledger row carries the same three terms, and the file is refused without them", () => {
  assert.deepEqual(unitLedgerProblems(ledger([row()]), "run-1"), []);
  assert.deepEqual(unitLedgerProblems(ledger([row({ provenance: ADMITTED })]), "run-1"), []);
  for (const field of ["authorship", "packetIdentityDigest", "provenance"] as const) {
    const { [field]: _dropped, ...without } = row();
    const problems = unitLedgerProblems({ ...ledger([]), units: [without] }, "run-1");
    assert.ok(problems.some((problem) => problem === `units[0] is missing field ${JSON.stringify(field)}`), `${field}: ${problems.join("; ")}`);
  }
  assert.ok(unitLedgerProblems({ ...ledger([row()]), version: "unit-ledger-v1" }, "run-1").some((problem) => /is not unit-ledger-v2/.test(problem)));
  assert.ok(unitLedgerProblems(ledger([row({ provenance: { kind: "cache-admitted" } as UnitProvenance })]), "run-1")
    .some((problem) => /units\[0\] provenance source undefined is not the ledger row/.test(problem)));
});

/** The candidate set of one plan state, as the recorded digests a re-planned run on disk would hold. */
function recordedCandidates(fix: IdentityFixture, state: PlanState, digestOf: (unitId: string, digest: string) => string): readonly CandidateIdentity[] {
  return plannedIdentities(fix, state).flatMap((planned) => (planned.derivation === "children-unavailable" ? [] : [{
    form: "recorded-digest" as const,
    unitId: planned.identity.unitId,
    documentId: planned.identity.documentId,
    kind: planned.identity.kind,
    digest: digestOf(planned.identity.unitId, planned.identity.digest),
    recordedBy: "the ledger row collected at 2026-08-20T00:00:00.000Z under plan aaaaaaaaaaaaaaaa"
  }]));
}

function priorRun(digests: readonly string[]): CandidateSource {
  return { origin: "prior-verified-units", runId: "run-1", knowledgeEpoch: 0, planCatalogDigests: digests };
}

test("a candidate known only by its recorded digest decides reuse the same way, and says so when it differs", async () => {
  const fix = await identityFixture();
  const planned = plannedIdentities(fix, fix.base);
  const same = deriveUnitCachePlan({ planned, candidates: recordedCandidates(fix, fix.base, (_unitId, digest) => digest), candidateSource: priorRun([DIGEST]) });
  assert.deepEqual(same.entries.filter((entry) => entry.status !== "reusable"), [],
    "the same recorded digests must make every planned unit reusable, synthesis roots included");
  assert.ok(same.entries.length >= 4, `the fixture must plan several units: ${same.entries.length}`);

  const moved = deriveUnitCachePlan({
    planned,
    candidates: recordedCandidates(fix, fix.base, (unitId, digest) => (unitId.endsWith("::appendix::coverage") ? OTHER : digest)),
    candidateSource: priorRun([DIGEST])
  });
  const rebuilt = moved.entries.filter((entry) => entry.status === "rebuild");
  assert.ok(rebuilt.length >= 1, "the appendix whose recorded digest moved must be rebuilt");
  for (const entry of rebuilt) {
    if (entry.status !== "rebuild") continue;
    if (entry.reason.cause === "child-not-reusable") continue;
    assert.equal(entry.reason.cause, "recorded-identity-differs");
    assert.match(entry.reason.statement, /the plan that candidate was drafted under is no longer on disk, so which sections moved cannot be named from the digest alone/);
  }
  // Both conservation equations still hold over a candidate set of the other form.
  assert.deepEqual(moved.conservation.statements[0], `planned = reusable + rebuild + new: ${moved.conservation.plannedUnits} = ${moved.conservation.reusable} + ${moved.conservation.rebuild} + ${moved.conservation.new}`);
});

test("a candidate set can come from more than one superseded plan, and an empty one still names its plans", () => {
  assert.match(describeCandidateSource(priorRun([DIGEST]), 3), /^3 prior verified unit\(s\) offered by run run-1, knowledge epoch 0, plan catalog a{64}$/);
  assert.match(describeCandidateSource(priorRun([DIGEST, OTHER]), 4), /2 superseded plan catalogs a{64}, b{64}$/);
  assert.throws(() => deriveUnitCachePlan({ planned: [], candidates: [], candidateSource: priorRun([]) }),
    /names prior verified units of run "run-1" but the candidate set is empty/);
});

test("drift downgrades a reusable verdict and can never create one; a reusable with no verification is refused", async () => {
  const fix = await identityFixture();
  const planned = plannedIdentities(fix, fix.base);
  const plan = deriveUnitCachePlan({ planned, candidates: recordedCandidates(fix, fix.base, (_unitId, digest) => digest), candidateSource: priorRun([DIGEST]) });
  const reusable = plan.entries.filter((entry) => entry.status === "reusable").map((entry) => entry.unitId);
  assert.ok(reusable.length >= 2, "the fixture must offer at least two reusable units");
  const drifted = reusable[0]!;

  const ledgerRows: readonly CandidateLedgerRow[] = [
    ...reusable.map((unitId) => ({
      unitId,
      documentId: "overview-product",
      kind: "leaf" as const,
      knowledgeEpoch: 0,
      planCatalogDigest: DIGEST,
      packetIdentityDigest: DIGEST,
      disposition: unitId === drifted
        ? { state: "offered" as const, verification: { state: "drifted" as const, problems: ["content digests to c… but its ledger row promises a…"] } }
        : { state: "offered" as const, verification: { state: "verified" as const } }
    })),
    {
      unitId: "u::from-another-epoch",
      documentId: "overview-product",
      kind: "leaf" as const,
      knowledgeEpoch: 9,
      planCatalogDigest: DIGEST,
      packetIdentityDigest: DIGEST,
      disposition: { state: "excluded" as const, cause: "other-epoch" as const, statement: "collected at knowledge epoch 9" }
    }
  ];
  const admission = deriveUnitAdmissionPlan({
    runId: "run-1", knowledgeEpoch: 0, planCatalogDigest: OTHER, authorship: "model-free generator test", plan, ledgerRows
  });
  const intentOf = (unitId: string): UnitAdmissionIntent => {
    const intent = admission.intents.find((row_) => row_.unit.unitId === unitId);
    if (!intent) throw new Error(`the admission plan holds no intent for ${unitId}`);
    return intent;
  };
  assert.equal(intentOf(drifted).intent, "rebuild");
  const downgraded = intentOf(drifted);
  assert.equal(downgraded.intent === "rebuild" ? downgraded.cause : "", "candidate-drift");
  assert.match(downgraded.intent === "rebuild" ? downgraded.statement : "", /has the identity its candidate recorded \([0-9a-f]{16}\) but its artifacts on disk are no longer the verified ones: content digests to /);
  for (const unitId of reusable.slice(1)) assert.equal(intentOf(unitId).intent, "admit", unitId);

  // The account: three buckets over the planned units, and every ledger row placed.
  assert.deepEqual(admission.account.statements, [
    `planned = admit + rebuild + new: ${plan.conservation.plannedUnits} = ${reusable.length - 1} + ${plan.conservation.rebuild + 1} + ${plan.conservation.new}`,
    `ledger rows = offered as candidates + excluded: ${ledgerRows.length} = ${reusable.length} + 1`
  ]);
  assert.equal(admission.cachePlan, plan, "the intents are this invalidation plan's buckets, not a second opinion");
  assert.match(summariseAdmission(admission.account, ["admissible", "to rebuild", "new"]), /planned unit\(s\): \d+ admissible, \d+ to rebuild, \d+ new; \d+ of \d+ prior ledger row\(s\) offered as candidates$/);

  // A reusable entry with no verification recorded is a named throw: nothing is admitted on bytes nobody checked.
  assert.throws(() => deriveUnitAdmissionPlan({
    runId: "run-1", knowledgeEpoch: 0, planCatalogDigest: OTHER, authorship: "model-free generator test", plan, ledgerRows: []
  }), /is reusable but no candidate verification was recorded for it; a draft may not be re-entered on bytes nobody checked/);
});

test("an unattempted intent maps to exactly one outcome, and an admit intent may not be reported without being attempted", () => {
  const unit = { unitId: "u::1", documentId: "overview-product", kind: "leaf" as const };
  assert.deepEqual(outcomeOfUnattemptedIntent({ intent: "rebuild", unit, cause: "identity-differs", statement: "it moved" }),
    { outcome: "fell-to-rebuild", unit, cause: "identity-differs", statement: "it moved" });
  assert.deepEqual(outcomeOfUnattemptedIntent({ intent: "new", unit, statement: "no candidate" }),
    { outcome: "skipped-new", unit, statement: "no candidate" });
  assert.throws(() => outcomeOfUnattemptedIntent({ intent: "admit", unit, identityDigest: DIGEST, statement: "admissible" }),
    /is intended for admission, so its outcome is whatever draft and collect say; it cannot be reported without being attempted/);
});
