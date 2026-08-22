import test from "node:test";
import assert from "node:assert/strict";
import { buildTopicCatalog, type TopicCatalogArtifact } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import { lensPolicyFor, REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { materialityRequiresDisposition } from "../src/report/topic-candidate.ts";
import {
  dispositionArityProblems,
  summariseVerdict,
  validateTopicDispositions,
  TOPIC_DISPOSITION_STATES,
  type TopicDisposition
} from "../src/report/topic-disposition.ts";
import { copyFixture, manifestOf } from "./helpers.ts";

// The disposition validator is an audit rule that lands BEFORE its only real producer (R3's planner), so the
// dispositions here are written by this test. What it has to hold:
//
//   * every material topic carries exactly one of six words, and the denominator comes only from the catalog;
//   * `vacuous` (an empty denominator) is a different conclusion from `complete`, with its source written down;
//   * an unknown topic can never be rendered `not-applicable`;
//   * each state's required fields are exact, in both directions.

const FIXTURE = "topic-catalog-mini";
const LENS = lensPolicyFor("product-manager").id;

async function fixtureCatalog(): Promise<TopicCatalogArtifact> {
  const runDir = await copyFixture(FIXTURE);
  return buildTopicCatalog(await loadTopicCatalogSource(runDir, await manifestOf(runDir)));
}

function disposition(topicId: string, overrides: Partial<TopicDisposition> = {}): TopicDisposition {
  return { topicId, state: "primary", reason: "", lensPolicyId: "", ...overrides };
}

/** One `primary` disposition per material topic — the shape a complete plan produces. */
function completeSet(catalog: TopicCatalogArtifact): TopicDisposition[] {
  return catalog.topics.filter((topic) => materialityRequiresDisposition(topic.materiality)).map((topic) => disposition(topic.topicId));
}

test("six states, and no seventh", () => {
  assert.deepEqual([...TOPIC_DISPOSITION_STATES], [
    "cannot-determine", "collapsed", "not-applicable", "omitted-for-audience", "primary", "referenced"
  ]);
});

test("a complete set over a non-empty denominator concludes complete", async () => {
  const catalog = await fixtureCatalog();
  const report = validateTopicDispositions(catalog, completeSet(catalog));
  assert.deepEqual(report.overall, { conclusion: "complete", denominator: 7, dispositioned: 7 });
  assert.equal(summariseVerdict(report.overall), "complete: all 7 material topic(s) carry a disposition");
});

test("an empty denominator concludes vacuous, and says so in words a complete pass cannot borrow", async () => {
  const catalog = await fixtureCatalog();
  // The route facet holds three topics and not one of them is material: a facet-level empty denominator.
  const route = validateTopicDispositions(catalog, completeSet(catalog)).facets.find((row) => row.facet === "route")!;
  assert.equal(route.verdict.conclusion, "vacuous");
  assert.equal(route.verdict.conclusion === "vacuous" ? route.verdict.denominator : -1, 0);
  assert.match(summariseVerdict(route.verdict), /^vacuous: the material-topic denominator is empty, so nothing was checked — the route facet holds 3 topic\(s\), none of them material/);
  assert.notEqual(summariseVerdict(route.verdict), summariseVerdict({ conclusion: "complete", denominator: 0, dispositioned: 0 }));

  // An ABSENT ledger and an all-unobligated facet are both vacuous, and their sources are different sentences.
  const entity = validateTopicDispositions(catalog, completeSet(catalog)).facets.find((row) => row.facet === "entity")!;
  assert.equal(entity.verdict.conclusion, "vacuous");
  assert.match(summariseVerdict(entity.verdict), /the entity facet is empty because its ledger is absent: facts\/producers\/db-schema\.json records status unavailable/);
});

test("a catalog with no material topic at all is vacuous overall, not a pass", async () => {
  const catalog = await fixtureCatalog();
  const nonMaterial: TopicCatalogArtifact = {
    ...catalog,
    topics: catalog.topics.filter((topic) => topic.materiality !== "material"),
    materiality: { ...catalog.materiality, material: 0 }
  };
  const report = validateTopicDispositions(nonMaterial, []);
  assert.equal(report.overall.conclusion, "vacuous");
  assert.match(summariseVerdict(report.overall), /this catalog holds 15 topic\(s\) of which 0 are material, 4 obligated-non-material and 11 unobligated, over 6 work item\(s\)/);
  for (const row of report.facets) assert.equal(row.verdict.conclusion, "vacuous");
});

test("a missing disposition for a material topic is a named violation", async () => {
  const catalog = await fixtureCatalog();
  const full = completeSet(catalog);
  const report = validateTopicDispositions(catalog, full.slice(1));
  assert.equal(report.overall.conclusion, "violations");
  assert.equal(report.overall.conclusion === "violations" ? report.overall.dispositioned : -1, 6);
  assert.ok((report.overall.conclusion === "violations" ? report.overall.problems : []).some(
    (problem) => problem.includes(full[0]!.topicId) && /carries no disposition/.test(problem)
  ));
  // With nothing at all, every material topic is named — never one summary line standing in for seven.
  const empty = validateTopicDispositions(catalog, []);
  assert.equal(empty.overall.conclusion === "violations" ? empty.overall.problems.length : -1, 7);
});

test("a second disposition for one topic is a named violation", async () => {
  const catalog = await fixtureCatalog();
  const full = completeSet(catalog);
  const report = validateTopicDispositions(catalog, [...full, disposition(full[0]!.topicId, { state: "referenced" })]);
  assert.equal(report.overall.conclusion, "violations");
  assert.ok((report.overall.conclusion === "violations" ? report.overall.problems : []).some(
    (problem) => /is a second disposition for topic .*a topic carries exactly one/.test(problem)
  ));
});

test("a disposition for a topic that is not in the catalog is a named violation", async () => {
  const catalog = await fixtureCatalog();
  const report = validateTopicDispositions(catalog, [...completeSet(catalog), disposition("route:0000000000000000")]);
  assert.equal(report.overall.conclusion, "violations");
  assert.ok((report.overall.conclusion === "violations" ? report.overall.problems : []).some(
    (problem) => /names topic "route:0000000000000000", which is not in this catalog/.test(problem)
  ));
});

test("an unknown state word is a named violation, not a state the validator invents a rule for", async () => {
  const catalog = await fixtureCatalog();
  const full = completeSet(catalog);
  const report = validateTopicDispositions(catalog, [
    ...full.slice(1),
    { ...full[0]!, state: "deferred" } as unknown as TopicDisposition
  ]);
  assert.equal(report.overall.conclusion, "violations");
  const problems = report.overall.conclusion === "violations" ? report.overall.problems : [];
  assert.ok(problems.some((problem) => /state "deferred" is not one of: cannot-determine, collapsed, not-applicable, omitted-for-audience, primary, referenced/.test(problem)));
  // The row is rejected outright, so the topic it named still counts as undispositioned.
  assert.ok(problems.some((problem) => /carries no disposition/.test(problem)));
});

test("an unknown topic may never be rendered not-applicable", async () => {
  const catalog = await fixtureCatalog();
  const unknownMaterial = catalog.topics.find((topic) => topic.unknown && topic.materiality === "material")!;
  assert.equal(unknownMaterial.canonicalKey, "coverage/read-residual/not-opened");
  const report = validateTopicDispositions(catalog, completeSet(catalog).map((row) => row.topicId === unknownMaterial.topicId
    ? disposition(row.topicId, { state: "not-applicable", reason: "the run did not open these spans" })
    : row));
  assert.equal(report.overall.conclusion, "violations");
  assert.ok((report.overall.conclusion === "violations" ? report.overall.problems : []).some(
    (problem) => /is marked unknown; an undetermined subject may never be reported as provably inapplicable/.test(problem)
  ));

  // `cannot-determine` is the honest word for the same topic, and it passes.
  const honest = validateTopicDispositions(catalog, completeSet(catalog).map((row) => row.topicId === unknownMaterial.topicId
    ? disposition(row.topicId, { state: "cannot-determine", reason: "the run did not open these spans" })
    : row));
  assert.equal(honest.overall.conclusion, "complete");
});

test("field arity is per state and exact in both directions", () => {
  const registry = REPORT_POLICY_REGISTRY;
  for (const state of ["primary", "referenced", "collapsed"] as const) {
    assert.deepEqual(dispositionArityProblems(disposition("t", { state }), registry), []);
    assert.ok(dispositionArityProblems(disposition("t", { state, reason: "because" }), registry)
      .some((problem) => /carries a reason .*only not-applicable and cannot-determine may/.test(problem)));
    assert.ok(dispositionArityProblems(disposition("t", { state, lensPolicyId: LENS }), registry)
      .some((problem) => /names lens policy .*only omitted-for-audience may/.test(problem)));
  }
  for (const state of ["not-applicable", "cannot-determine"] as const) {
    assert.deepEqual(dispositionArityProblems(disposition("t", { state, reason: "measured, provably absent" }), registry), []);
    assert.ok(dispositionArityProblems(disposition("t", { state }), registry)
      .some((problem) => /carries no reason; a determination with no stated basis is a guess/.test(problem)));
  }
  assert.deepEqual(dispositionArityProblems(disposition("t", { state: "omitted-for-audience", lensPolicyId: LENS }), registry), []);
  assert.ok(dispositionArityProblems(disposition("t", { state: "omitted-for-audience", lensPolicyId: "lens.invented" }), registry)
    .some((problem) => /names lens policy "lens\.invented", which is not registered/.test(problem)));
  assert.ok(dispositionArityProblems(disposition("t", { state: "omitted-for-audience" }), registry)
    .some((problem) => /names lens policy "", which is not registered/.test(problem)));
  assert.ok(dispositionArityProblems(disposition("t", { state: "omitted-for-audience", lensPolicyId: LENS, reason: "too technical" }), registry)
    .some((problem) => /carries a reason .*the lens policy is what authorises the omission/.test(problem)));
});

test("the validator reads no count or coverage claim off the disposition document", async () => {
  const catalog = await fixtureCatalog();
  const withClaims = completeSet(catalog).map((row) => ({ ...row, coverage: "complete", materialTopics: 1 }));
  const report = validateTopicDispositions(catalog, withClaims);
  assert.equal(report.overall.conclusion, "violations");
  const problems = report.overall.conclusion === "violations" ? report.overall.problems : [];
  assert.ok(problems.some((problem) => /has unknown field "coverage"/.test(problem)));
  assert.ok(problems.some((problem) => /has unknown field "materialTopics"/.test(problem)));
  // The denominator stayed the catalog's, whatever the document claimed.
  assert.equal(report.overall.conclusion === "violations" ? report.overall.denominator : -1, 7);
});

test("a disposition document that is not an array of objects fails by name", async () => {
  const catalog = await fixtureCatalog();
  const notArray = validateTopicDispositions(catalog, { dispositions: [] });
  assert.equal(notArray.overall.conclusion, "violations");
  assert.ok((notArray.overall.conclusion === "violations" ? notArray.overall.problems : []).some(
    (problem) => /is \{"dispositions":\[\]\}, not an array of dispositions/.test(problem)
  ));
  const notObject = validateTopicDispositions(catalog, ["primary"]);
  assert.ok((notObject.overall.conclusion === "violations" ? notObject.overall.problems : []).some(
    (problem) => /dispositions\[0\] is "primary", not a disposition object/.test(problem)
  ));
});

test("problems are attributed to the facet of the topic they are about", async () => {
  const catalog = await fixtureCatalog();
  const feature = catalog.topics.find((topic) => topic.facet === "feature" && topic.materiality === "material")!;
  const report = validateTopicDispositions(catalog, completeSet(catalog).filter((row) => row.topicId !== feature.topicId));
  assert.equal(report.overall.conclusion, "violations");
  const featureVerdict = report.facets.find((row) => row.facet === "feature")!.verdict;
  assert.equal(featureVerdict.conclusion, "violations");
  const dimension = report.facets.find((row) => row.facet === "work-item-dimension")!.verdict;
  assert.equal(dimension.conclusion, "complete", "one facet's violation does not condemn another's");
});
