import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256 } from "../src/base/util.ts";
import {
  confidenceOf,
  materialityOf,
  materialityRequiresDisposition,
  mintTopicCandidate,
  statusDetermination,
  topicCandidateDigest,
  topicIdOf,
  TOPIC_CONFIDENCES,
  TOPIC_FACETS,
  TOPIC_MATERIALITIES,
  WORK_ITEM_STATUSES,
  type MintTopicInput,
  type TopicObligationBinding
} from "../src/report/topic-candidate.ts";

// The identity contract of a topic, tested at the unit it is derived in. Two properties carry the whole slice:
// the id is a function of (facet, canonical key) and of nothing volatile, and the key always carries whatever
// distinguishes the row — a same-name/different-path pair is the case that would otherwise collapse into one
// topic and still balance every count it was checked against (57B-395's identity-collapse lesson).

function binding(overrides: Partial<TopicObligationBinding> = {}): TopicObligationBinding {
  return {
    workItemId: "wi-1",
    dimension: "decision-function",
    status: "found",
    material: true,
    evidenceIds: ["S-2", "S-1"],
    traceIds: [],
    ...overrides
  };
}

function mint(overrides: Partial<MintTopicInput> = {}) {
  return mintTopicCandidate({
    facet: "route",
    kind: "indexed-route",
    canonicalKey: "route/codegraph/route:svc/a.go:1-1:GET /x",
    title: "GET /x",
    source: { ledger: "facts/producers/codegraph.json", rowId: "route:svc/a.go:1-1:GET /x" },
    bindings: [],
    relationIds: [],
    ledgerUnknown: false,
    residualRows: 0,
    uncoveredLines: 0,
    ...overrides
  });
}

test("a topic id is a pure function of facet and canonical key, and nothing else", () => {
  assert.equal(topicIdOf("route", "k"), topicIdOf("route", "k"));
  assert.equal(topicIdOf("route", "k"), `route:${sha256(canonicalJson(["route", "k"])).slice(0, 16)}`);
  // The facet is inside the hash as well as the prefix, so two facets cannot mint the same suffix for one key.
  assert.notEqual(topicIdOf("route", "k").slice(6), topicIdOf("entity", "k").slice(7));
  for (const facet of TOPIC_FACETS) assert.ok(topicIdOf(facet, "k").startsWith(`${facet}:`));
  assert.throws(() => topicIdOf("route", "   "), /cannot be minted from an empty canonical key/);
});

test("the same symbol name in two files mints two topics — identity does not collapse on the name", () => {
  const a = mint({ canonicalKey: "route/codegraph/route:svc/leave/approve.go:10-10:GET /x", title: "GET /x" });
  const b = mint({ canonicalKey: "route/codegraph/route:svc/holiday/approve.go:10-10:GET /x", title: "GET /x" });
  assert.notEqual(a.topicId, b.topicId);
  assert.notEqual(a.digest, b.digest);
  // Same title, same facet, same kind: the path in the key is the only thing keeping them apart.
  assert.equal(a.title, b.title);
});

test("the digest covers every field, so any edited byte moves it", () => {
  const topic = mint({ bindings: [binding()], residualRows: 1, uncoveredLines: 4 });
  const { digest, ...rest } = topic;
  assert.equal(digest, topicCandidateDigest(rest));
  assert.notEqual(digest, topicCandidateDigest({ ...rest, title: `${rest.title} ` }));
  assert.notEqual(digest, topicCandidateDigest({ ...rest, completeness: { ...rest.completeness, uncoveredLines: 5 } }));
  assert.notEqual(digest, topicCandidateDigest({
    ...rest,
    bindings: [{ ...rest.bindings[0]!, evidenceIds: ["S-1", "S-2"] }]
  }), "a reordered evidence list is a different binding, not the same one");
});

test("a binding copies its evidence and trace ids verbatim — order is the ledger's, not the catalog's", () => {
  const topic = mint({ bindings: [binding({ evidenceIds: ["S-9", "S-3", "S-9"], traceIds: ["T-2", "T-1"] })] });
  assert.deepEqual(topic.bindings[0]!.evidenceIds, ["S-9", "S-3", "S-9"]);
  assert.deepEqual(topic.bindings[0]!.traceIds, ["T-2", "T-1"]);
});

test("bindings are ordered by work item id, and a work item may not bind twice", () => {
  const topic = mint({ bindings: [binding({ workItemId: "wi-b" }), binding({ workItemId: "wi-a" })] });
  assert.deepEqual(topic.bindings.map((row) => row.workItemId), ["wi-a", "wi-b"]);
  assert.throws(
    () => mint({ bindings: [binding({ workItemId: "wi-a" }), binding({ workItemId: "wi-a" })] }),
    /binds work item "wi-a" twice/
  );
});

test("materiality is exactly three buckets, derived from the bindings and from nothing else", () => {
  assert.deepEqual([...TOPIC_MATERIALITIES], ["material", "obligated-non-material", "unobligated"]);
  assert.equal(materialityOf([]), "unobligated");
  assert.equal(materialityOf([binding({ material: false })]), "obligated-non-material");
  assert.equal(materialityOf([binding({ material: false }), binding({ workItemId: "wi-2", material: true })]), "material");
  assert.equal(mint({ bindings: [] }).materiality, "unobligated");
});

test("only the material bucket owes a disposition, and the other two are still counted", () => {
  assert.equal(materialityRequiresDisposition("material"), true);
  assert.equal(materialityRequiresDisposition("obligated-non-material"), false);
  assert.equal(materialityRequiresDisposition("unobligated"), false);
});

test("the runtime status list is pinned to the base union in both directions", () => {
  // `satisfies` blocks a phantom member and the module's own `_everyStatusListed` line blocks an omitted one, so
  // this only has to prove the list is the one the classifier accepts — every member must classify.
  for (const status of WORK_ITEM_STATUSES) assert.ok(["determined", "undetermined", "open"].includes(statusDetermination(status)));
  assert.equal(WORK_ITEM_STATUSES.length, 6);
});

test("every work item status lands in one of three determinations", () => {
  assert.equal(statusDetermination("found"), "determined");
  assert.equal(statusDetermination("searched-not-found"), "determined");
  assert.equal(statusDetermination("not-applicable"), "determined");
  assert.equal(statusDetermination("cannot-determine"), "undetermined");
  assert.equal(statusDetermination("pending"), "open");
  assert.equal(statusDetermination("in_progress"), "open");
});

test("confidence separates an unbound topic from a settled one", () => {
  assert.deepEqual([...TOPIC_CONFIDENCES], ["grounded", "qualified", "unbound", "unsettled"]);
  assert.equal(confidenceOf([]), "unbound");
  assert.equal(confidenceOf([binding()]), "grounded");
  assert.equal(confidenceOf([binding({ status: "searched-not-found" })]), "qualified");
  assert.equal(confidenceOf([binding({ status: "cannot-determine" })]), "unsettled");
  assert.equal(confidenceOf([binding({ status: "pending" })]), "unsettled");
  assert.equal(confidenceOf([binding(), binding({ workItemId: "wi-2", status: "pending" })]), "unsettled");
});

test("a topic is unknown when its ledger row is unknown OR any bound obligation is undetermined", () => {
  assert.equal(mint({ bindings: [binding()] }).unknown, false);
  assert.equal(mint({ bindings: [binding()], ledgerUnknown: true }).unknown, true);
  assert.equal(mint({ bindings: [binding({ status: "cannot-determine" })] }).unknown, true);
  assert.equal(mint({ bindings: [binding({ status: "pending" })] }).unknown, true);
  // A determination is not an unknown: "we looked and it is not there" is an answer.
  assert.equal(mint({ bindings: [binding({ status: "searched-not-found" })] }).unknown, false);
});

test("completeness reports its own denominator, including when the denominator is zero", () => {
  const unread = mint({ bindings: [binding(), binding({ workItemId: "wi-2", status: "pending" })], residualRows: 2, uncoveredLines: 17 });
  assert.deepEqual(unread.completeness, { boundWorkItems: 2, settledWorkItems: 1, residualRows: 2, uncoveredLines: 17 });
  const noObligation = mint({ bindings: [] });
  assert.deepEqual(noObligation.completeness, { boundWorkItems: 0, settledWorkItems: 0, residualRows: 0, uncoveredLines: 0 });
});

test("relation ids are de-duplicated and sorted, so two identical topics cannot differ by byte", () => {
  assert.deepEqual(mint({ relationIds: ["L-2", "L-1", "L-2"] }).relationIds, ["L-1", "L-2"]);
});
