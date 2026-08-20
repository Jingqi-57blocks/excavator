import test from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { parsePlanProposal, type PlanProposal, type ProposedUnit, type ProposedUnitTopic } from "../src/report/plan-proposal.ts";
import { FULL_OBLIGATION_SCOPE } from "../src/report/obligation-scope.ts";
import {
  OWNERSHIP_FACET_PRIORITY,
  deriveObligationOwnership,
  documentOwnership,
  ownershipProblems,
  ownershipUnitsOfProposal,
  summariseObligationOwnership,
  unitTopicRole
} from "../src/report/plan-obligation-conservation.ts";
import { validatePlan, type PlanValidationReport } from "../src/report/plan-validation.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { AUTHORING_UNIT_KINDS } from "../src/report/plan-proposal.ts";
import { TOPIC_FACETS } from "../src/report/topic-candidate.ts";
import type { TopicCatalogArtifact } from "../src/report/topic-catalog.ts";
import type { ReportRequestsArtifact } from "../src/report/report-requests-artifact.ts";
import { miniRun, type MiniRun } from "./plan-fixture.ts";

/**
 * R5a - one owner per material obligation per document (`plan-obligation-conservation.ts`).
 *
 * The mini fixture is the right bench because it has the exact shape the wcp baseline has and no other: each of its
 * three material obligations binds a coverage topic AND a feature topic AND a work-item-dimension topic, and the
 * fixture plan gives each facet its own leaf. So three owning units of one document reach all three obligations,
 * and topic-granular deduplication would change nothing at all — measured on wcp, that is 1,858 owed instances
 * against 847 distinct obligations per document, which is why ownership had to be obligation-granular.
 *
 * Every proposal a negative fixture builds goes through `parsePlanProposal` first, so it comes through the same door
 * a model's bytes would.
 */

const OVERVIEW = "overview-product";
const LEAF_FEATURE = `${OVERVIEW}::leaf::feature`;
const LEAF_COVERAGE = `${OVERVIEW}::leaf::coverage`;
const LEAF_DIMENSION = `${OVERVIEW}::leaf::work-item-dimension`;
const APPENDIX = `${OVERVIEW}::appendix::coverage`;
const SYNTHESIS = `${OVERVIEW}::synthesis::document`;

/** The three material obligations of the fixture, and the facet of each topic that binds them. */
const FOUND_TWO_EVIDENCE = "feature:leave-1a2b3c4d5e:logic:approve@svc/leave/approve.go:10";
const SEARCHED_NOT_FOUND = "feature:promo-9f8e7d6c5b:logic:rank@svc/promo/rank.go:5";

let mini: MiniRun | null = null;
async function fixture(): Promise<MiniRun> {
  return (mini ??= await miniRun());
}

function parsedProposal(raw: unknown): PlanProposal {
  const result = parsePlanProposal(raw);
  assert.equal(result.proposal !== null, true, `the proposal must parse: ${result.problems.join("; ")}`);
  return result.proposal!;
}

function validate(catalog: TopicCatalogArtifact, requests: ReportRequestsArtifact, proposal: PlanProposal): PlanValidationReport {
  if (mini === null) throw new Error("validate() needs the mini fixture: await fixture() before calling it");
  return validatePlan({
    catalog,
    requests,
    proposal,
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    evidence: mini.evidenceById,
    reach: mini.reach,
    epochCoverage: mini.epochCoverage
  });
}

/** Whole-topic references: these fixtures test OWNERSHIP, so every scope is `all` unless a test says otherwise. */
function whole(topicIds: readonly string[]): readonly ProposedUnitTopic[] {
  return topicIds.map((topicId) => ({ topicId, obligationScope: FULL_OBLIGATION_SCOPE }));
}

function raw(proposal: PlanProposal): Record<string, unknown> {
  return JSON.parse(stableJson(proposal)) as Record<string, unknown>;
}

/** The topic ids one unit of the fixture plan names. */
function topicsOfUnit(proposal: PlanProposal, unitId: string): readonly string[] {
  const unit = proposal.units.find((row) => row.unitId === unitId);
  assert.ok(unit, `the fixture plan must hold ${unitId}`);
  return unit!.kind === "synthesis" ? [] : unit!.topics.map((topic) => topic.topicId);
}

/** The fixture plan's units for one document, with a replacement set for that document. */
function withDocumentUnits(proposal: PlanProposal, documentId: string, units: readonly ProposedUnit[]): unknown[] {
  return [...proposal.units.filter((unit) => unit.documentId !== documentId), ...units]
    .sort((a, b) => a.unitId.localeCompare(b.unitId))
    .map((unit) => JSON.parse(stableJson(unit)) as unknown);
}

// --- ① the pinned facet priority ------------------------------------------------------------------------

test("the ownership facet priority is a permutation of TOPIC_FACETS, so no facet can be unranked or ranked twice", () => {
  assert.deepEqual([...OWNERSHIP_FACET_PRIORITY].sort((a, b) => a.localeCompare(b)), [...TOPIC_FACETS],
    "every facet is ranked exactly once; a duplicated member passes both type checks and would silently reorder owners");
  assert.equal(OWNERSHIP_FACET_PRIORITY[0], "feature", "a feature topic is the subject a reader came for");
  assert.equal(OWNERSHIP_FACET_PRIORITY[OWNERSHIP_FACET_PRIORITY.length - 1], "coverage",
    "a coverage topic is a statement about the run, not about the obligation, so it owns only when nothing else does");
});

test("every unit kind declares a topic role, and only leaf and appendix own", () => {
  assert.deepEqual(AUTHORING_UNIT_KINDS.map((kind) => [kind, unitTopicRole(kind)]), [
    ["appendix", "owning"],
    ["bridge", "referencing"],
    ["leaf", "owning"],
    ["synthesis", "topic-free"]
  ]);
});

// --- ② the owner of a cross-facet obligation -------------------------------------------------------------

test("an obligation bound to a feature, a dimension and a coverage topic is owned by the FEATURE leaf", async () => {
  const { catalog, requests } = await fixture();
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  // The premise this test stands on: three owning units of ONE document each reach the obligation.
  const binding = catalog.topics.filter((topic) => topic.bindings.some((row) => row.workItemId === FOUND_TWO_EVIDENCE));
  assert.deepEqual(binding.map((topic) => topic.facet).sort(), ["coverage", "feature", "work-item-dimension"]);

  const ownership = deriveObligationOwnership(catalog, ownershipUnitsOfProposal(proposal.units));
  const document = documentOwnership(ownership, OVERVIEW);
  const owner = document.ownerByObligation.get(FOUND_TWO_EVIDENCE);
  assert.ok(owner, "the obligation must have an owner row");
  assert.equal(owner!.ownerUnitId, LEAF_FEATURE);
  assert.equal(owner!.ownerTopicFacet, "feature");
  assert.deepEqual([...owner!.reachedByUnitIds], [LEAF_COVERAGE, LEAF_DIMENSION, LEAF_FEATURE].sort((a, b) => a.localeCompare(b)),
    "all three units reach it; exactly one owns it");
  assert.deepEqual(ownershipProblems(ownership), [], "one owner per obligation is not a violation, it is the rule");
});

test("every unit gets an owned count, the counts conserve, and the three leaves no longer owe the same rows", async () => {
  const { catalog, requests } = await fixture();
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const document = documentOwnership(deriveObligationOwnership(catalog, ownershipUnitsOfProposal(proposal.units)), OVERVIEW);
  assert.equal(document.reachedObligations, 3, "the document reaches all three material obligations");
  assert.deepEqual(document.ownedByUnit, [
    { unitId: APPENDIX, kind: "appendix", role: "owning", owned: 0 },
    { unitId: LEAF_COVERAGE, kind: "leaf", role: "owning", owned: 0 },
    { unitId: LEAF_FEATURE, kind: "leaf", role: "owning", owned: 3 },
    { unitId: LEAF_DIMENSION, kind: "leaf", role: "owning", owned: 0 },
    { unitId: SYNTHESIS, kind: "synthesis", role: "topic-free", owned: 0 }
  ].sort((a, b) => a.unitId.localeCompare(b.unitId)), "a unit that owns nothing is a visible zero, not an absent row");
  assert.equal(document.ownedByUnit.reduce((total, row) => total + row.owned, 0), document.reachedObligations);
  assert.deepEqual(document.unowned, []);
  assert.match(summariseObligationOwnership(document), /^document overview-product: 3 material obligation\(s\) reachable, 3 with an owner, 0 owned by none;/);
});

test("with no feature leaf, the same-facet tie-break is ascending topic id", async () => {
  const { catalog, requests } = await fixture();
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  // SEARCHED_NOT_FOUND binds TWO coverage topics. Drop every other owning unit of the document and the choice is
  // between them alone — which is the only place the second half of the rule is observable.
  const coverageTopics = topicsOfUnit(proposal, LEAF_COVERAGE);
  const ownership = deriveObligationOwnership(catalog, [
    { unitId: LEAF_COVERAGE, documentId: OVERVIEW, kind: "leaf", topics: whole(coverageTopics) }
  ]);
  const owner = documentOwnership(ownership, OVERVIEW).ownerByObligation.get(SEARCHED_NOT_FOUND);
  assert.ok(owner);
  assert.equal(owner!.ownerTopicFacet, "coverage");
  const candidates = catalog.topics
    .filter((topic) => topic.facet === "coverage" && topic.bindings.some((row) => row.workItemId === SEARCHED_NOT_FOUND))
    .map((topic) => topic.topicId)
    .sort((a, b) => a.localeCompare(b));
  assert.equal(candidates.length, 2, "the fixture must offer two coverage topics for this obligation");
  assert.equal(owner!.ownerTopicId, candidates[0], "ties inside one facet go to the lower topic id");
});

// --- ③ the uniqueness rule, and the bridge that is allowed to reference ---------------------------------

test("two OWNING units of one document holding the same obligation is a named partition violation", async () => {
  const { catalog, requests } = await fixture();
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const featureTopics = topicsOfUnit(proposal, LEAF_FEATURE);
  const second: ProposedUnit = { kind: "leaf", unitId: `${OVERVIEW}::leaf::feature-again`, documentId: OVERVIEW, title: "Feature topics, again", topics: whole(featureTopics) };
  const units = [
    ...proposal.units.filter((unit) => unit.documentId === OVERVIEW && unit.kind !== "synthesis"),
    second,
    {
      kind: "synthesis" as const,
      unitId: SYNTHESIS,
      documentId: OVERVIEW,
      title: `${OVERVIEW} synthesis`,
      childUnitIds: [...proposal.units.filter((unit) => unit.documentId === OVERVIEW && unit.kind !== "synthesis").map((unit) => unit.unitId), second.unitId].sort((a, b) => a.localeCompare(b))
    }
  ];
  const report = validate(catalog, requests, parsedProposal({ ...raw(proposal), units: withDocumentUnits(proposal, OVERVIEW, units) }));
  assert.equal(report.overall.conclusion, "violations");
  const problems = report.overall.conclusion === "violations" ? report.overall.problems : [];
  // R5b replaces R5a's "at most one owning unit per topic" with the stronger law: the owning units' scopes must
  // PARTITION the topic's bindings. Two units at scope `all` therefore double-cover every binding, and the
  // violation names the obligation ids and both units rather than only the topic.
  const named = problems.filter((problem) => problem.includes("inside the scope of more than one OWNING unit"));
  const boundFeatureTopics = featureTopics.filter((topicId) => catalog.topics.find((topic) => topic.topicId === topicId)!.bindings.length > 0);
  assert.equal(named.length, boundFeatureTopics.length, "every doubly-covered topic is named, not just the first");
  assert.ok(named.some((problem) => problem.includes(`${OVERVIEW}::leaf::feature + ${OVERVIEW}::leaf::feature-again`)), named.join(" | "));
  assert.ok(named.every((problem) => problem.includes("a bridge may reference a topic another unit owns, a second owning unit may not")));
});

test("a BRIDGE naming a topic another unit owns is legal, and owns nothing", async () => {
  const { catalog, requests } = await fixture();
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const featureTopics = topicsOfUnit(proposal, LEAF_FEATURE);
  assert.ok(featureTopics.length >= 2, "a bridge needs at least two topics, and the fixture's feature leaf has them");
  const bridge: ProposedUnit = { kind: "bridge", unitId: `${OVERVIEW}::bridge::features`, documentId: OVERVIEW, title: "How the two features relate", topics: whole(featureTopics) };
  const leaves = proposal.units.filter((unit) => unit.documentId === OVERVIEW && unit.kind !== "synthesis");
  const units = [
    ...leaves,
    bridge,
    {
      kind: "synthesis" as const,
      unitId: SYNTHESIS,
      documentId: OVERVIEW,
      title: `${OVERVIEW} synthesis`,
      childUnitIds: [...leaves.map((unit) => unit.unitId), bridge.unitId].sort((a, b) => a.localeCompare(b))
    }
  ];
  const report = validate(catalog, requests, parsedProposal({ ...raw(proposal), units: withDocumentUnits(proposal, OVERVIEW, units) }));
  assert.equal(report.overall.conclusion, "complete", report.overall.conclusion === "violations" ? report.overall.problems.join("; ") : "");
  const document = documentOwnership(report.ownership, OVERVIEW);
  assert.equal(document.ownedByUnit.find((row) => row.unitId === bridge.unitId)!.owned, 0);
  assert.equal(document.ownedByUnit.find((row) => row.unitId === bridge.unitId)!.role, "referencing");
  assert.equal(document.ownerByObligation.get(FOUND_TWO_EVIDENCE)!.ownerUnitId, LEAF_FEATURE, "the bridge does not take ownership by naming the topic");
});

test("an obligation only referencing units reach is owned by nobody, and that is a named violation", async () => {
  const { catalog } = await fixture();
  const featureTopics = catalog.topics.filter((topic) => topic.facet === "feature").map((topic) => topic.topicId).sort((a, b) => a.localeCompare(b));
  const ownership = deriveObligationOwnership(catalog, [
    { unitId: "doc::bridge::only", documentId: "doc", kind: "bridge", topics: whole(featureTopics) }
  ]);
  const document = documentOwnership(ownership, "doc");
  assert.equal(document.obligations.length, 0);
  assert.equal(document.unowned.length, document.reachedObligations);
  assert.ok(document.reachedObligations > 0, "the bridge does reach the obligations; nothing owns them");
  const problems = ownershipProblems(ownership);
  assert.equal(problems.length, document.unowned.length, "every unowned obligation is named, never counted");
  assert.ok(problems.every((problem) => problem.includes("is reached by unit(s) doc::bridge::only and owned by none of them")), problems.join(" | "));
});

// --- ④ same source: validation and the recorded plan see one ownership ----------------------------------

test("ownership is per document and never shared across them", async () => {
  const { catalog, requests } = await fixture();
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const ownership = deriveObligationOwnership(catalog, ownershipUnitsOfProposal(proposal.units));
  assert.deepEqual(ownership.documents.map((row) => row.documentId), ["feature-leave-product", "overview-engineering", "overview-product"]);
  for (const document of ownership.documents) {
    const owner = document.ownerByObligation.get(FOUND_TWO_EVIDENCE);
    assert.ok(owner, `${document.documentId} reaches the obligation and must own it itself`);
    assert.equal(owner!.documentId, document.documentId);
    assert.ok(owner!.ownerUnitId.startsWith(`${document.documentId}::`), owner!.ownerUnitId);
  }
});

test("a document with no ownership row is a named refusal, never an empty one that reads as `owns nothing`", async () => {
  const { catalog, requests } = await fixture();
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const ownership = deriveObligationOwnership(catalog, ownershipUnitsOfProposal(proposal.units));
  assert.throws(() => documentOwnership(ownership, "no-such-document"),
    /ownership derivation has no row for document "no-such-document"; it holds 3 document\(s\)/);
});
