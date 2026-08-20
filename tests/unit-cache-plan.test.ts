import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256, stableJson } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { FULL_OBLIGATION_SCOPE } from "../src/report/obligation-scope.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { parsePlanProposal, type PlanProposal, type ProposedUnit } from "../src/report/plan-proposal.ts";
import {
  UNIT_CACHE_PLAN_VERSION,
  describeCandidateSource,
  deriveUnitCachePlan,
  type CandidateSource,
  type PlannedUnitIdentity,
  type UnitCacheEntry,
  type UnitCachePlan
} from "../src/report/unit-cache-plan.ts";
import type { UnitAuthorship, UnitIdentity } from "../src/report/unit-cache-identity.ts";
import {
  BRIDGE_UNIT,
  FEATURE_TOPIC,
  MIGRATING_OBLIGATION,
  OVERVIEW_PRODUCT,
  identityFixture,
  identityOf,
  planStateOf,
  plannedIdentities,
  stateOverCatalog,
  topicOf,
  withDocument,
  withoutDocument,
  withTopicTitle,
  withoutBinding,
  type IdentityFixture,
  type PlanState
} from "./unit-cache-identity-fixture.ts";

/**
 * R6a - the invalidation plan (`unit-cache-plan.ts`): four buckets, both conservation equations, and the reasons.
 *
 * THE TWO SCENARIOS ARE BOTH HERE ON PURPOSE. The epic's acceptance is written for a binding-PRESERVING change
 * ("rebuild the leaf that names the topic, its ancestors, and the bridge that references it"), and that shape is
 * asserted id by id below. But a BINDING-SET change moves ownership, and then a sibling unit that never named the
 * perturbed topic has to be rebuilt as well — asserted id by id too, and deliberately next to the first one so the
 * two readings can be compared. Testing only the first would confirm the premise the epic was written under and
 * never check the claim under the load that breaks it, which is 57B-466's mistake.
 *
 * THE SHARPEST TEST IN THIS FILE is the synthesis one. Under both perturbations a synthesis's own identity is
 * BYTE-IDENTICAL to its candidate's, because it is written from the summaries the candidate holds. A cache that
 * compared digests would reuse a document root whose every child had been rewritten. The plan calls it `rebuild`
 * and names the child.
 */

let shared: Promise<IdentityFixture> | null = null;
function fixture(): Promise<IdentityFixture> { return (shared ??= identityFixture()); }

const SOURCE_DIGEST = "a".repeat(64);

function priorRun(fix: IdentityFixture): CandidateSource {
  return {
    origin: "prior-verified-units",
    runId: fix.base.planCatalog.runId,
    knowledgeEpoch: fix.base.planCatalog.knowledgeEpoch,
    planCatalogDigest: SOURCE_DIGEST
  };
}

/** The candidates: every unit of the base state whose identity could be computed. */
function candidatesOf(fix: IdentityFixture): readonly UnitIdentity[] {
  return plannedIdentities(fix, fix.base).flatMap((row) => (row.derivation === "children-unavailable" ? [] : [row.identity]));
}

function planBetween(fix: IdentityFixture, state: PlanState): UnitCachePlan {
  return deriveUnitCachePlan({ planned: plannedIdentities(fix, state), candidates: candidatesOf(fix), candidateSource: priorRun(fix) });
}

function ids(entries: readonly UnitCacheEntry[], status: UnitCacheEntry["status"]): readonly string[] {
  return entries.filter((entry) => entry.status === status).map((entry) => entry.unitId);
}

function entryOf(plan: UnitCachePlan, unitId: string): UnitCacheEntry {
  const entry = plan.entries.find((row) => row.unitId === unitId);
  assert.ok(entry, `the plan must hold an entry for ${unitId}`);
  return entry!;
}

/** Every bucket, checked against both equations — the same check the derivation asserts, read from the outside. */
function assertConserves(plan: UnitCachePlan): void {
  const { conservation } = plan;
  assert.equal(conservation.reusable + conservation.rebuild + conservation.new, conservation.plannedUnits, canonicalJson(conservation));
  assert.equal(conservation.reusable + conservation.rebuild + conservation.retired, conservation.candidateUnits, canonicalJson(conservation));
  assert.deepEqual(conservation.statements, [
    `planned = reusable + rebuild + new: ${conservation.plannedUnits} = ${conservation.reusable} + ${conservation.rebuild} + ${conservation.new}`,
    `candidates = reusable + rebuild + retired: ${conservation.candidateUnits} = ${conservation.reusable} + ${conservation.rebuild} + ${conservation.retired}`
  ]);
  assert.equal(plan.entries.length, conservation.plannedUnits);
  assert.equal(plan.retired.length, conservation.retired);
}

// --- (1) the identity case: nothing changed, so nothing is rebuilt -------------------------------------

test("the same plan against its own verified units is entirely reusable, and both equations hold", async () => {
  const fix = await fixture();
  const plan = planBetween(fix, fix.base);
  assert.equal(plan.version, UNIT_CACHE_PLAN_VERSION);
  assertConserves(plan);
  assert.equal(plan.conservation.reusable, 16);
  assert.deepEqual(ids(plan.entries, "rebuild"), []);
  assert.deepEqual(ids(plan.entries, "new"), []);
  assert.deepEqual([...plan.retired], []);
  assert.match(plan.candidateStatement, /16 prior verified unit\(s\) offered by run /);
  // Deterministic: same values, same bytes.
  assert.equal(stableJson(plan), stableJson(planBetween(fix, fix.base)));
});

// --- (2) the second audience: the reason the three digest lines are normalized at all ------------------

test("adding a second-audience document reuses every existing unit and brings its own units in as new", async () => {
  const fix = await fixture();
  const second = stateOverCatalog(fix.run, "second-audience", fix.base.catalog, withDocument(fix.run.requests, {
    documentId: "feature-leave-engineering",
    kind: "feature",
    audience: "engineering",
    featureKey: "leave-1a2b3c4d5e",
    detailLevel: "standard",
    language: "en-US"
  }));
  const plan = planBetween(fix, second);
  assertConserves(plan);
  assert.equal(plan.conservation.reusable, 16);
  assert.deepEqual(ids(plan.entries, "rebuild"), []);
  assert.deepEqual(ids(plan.entries, "new"), [
    "feature-leave-engineering::appendix::coverage",
    "feature-leave-engineering::leaf::coverage",
    "feature-leave-engineering::leaf::feature",
    "feature-leave-engineering::leaf::work-item-dimension",
    "feature-leave-engineering::synthesis::document"
  ]);
  assert.deepEqual([...plan.retired], [], "no existing document is retired by asking for another one");
  const fresh = entryOf(plan, "feature-leave-engineering::leaf::feature");
  assert.equal(fresh.status === "new" && fresh.reason.startsWith("no candidate holds unit "), true, canonicalJson(fresh));
});

// --- (3) scenario (a): a binding-PRESERVING content change --------------------------------------------

test("a topic content change rebuilds the units that name it, the bridge that references it and their ancestors — and nothing else", async () => {
  const fix = await fixture();
  const state = stateOverCatalog(fix.run, "content", withTopicTitle(fix.base.catalog, FEATURE_TOPIC, "Leave approval (perturbed title)"), fix.run.requests);
  const plan = planBetween(fix, state);
  assertConserves(plan);
  assert.deepEqual(ids(plan.entries, "rebuild"), [
    "feature-leave-product::leaf::feature",
    "feature-leave-product::synthesis::document",
    "overview-engineering::leaf::feature",
    "overview-engineering::synthesis::document",
    BRIDGE_UNIT,
    "overview-product::leaf::feature",
    "overview-product::synthesis::document"
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "the leaves that own the topic, the bridge that references it, and the three document roots");
  assert.deepEqual(ids(plan.entries, "new"), []);
  assert.deepEqual([...plan.retired], []);
  assert.equal(plan.conservation.reusable, 9);

  // The leaf's reason names the sections of ITS OWN identity view that moved.
  const leaf = entryOf(plan, `${OVERVIEW_PRODUCT}::leaf::feature`);
  assert.equal(leaf.status, "rebuild");
  if (leaf.status !== "rebuild" || leaf.reason.cause !== "identity-changed") throw new Error(canonicalJson(leaf));
  assert.ok(leaf.reason.changedSections.some((section) => section.includes("Obligations bound to this unit's topics")), leaf.reason.changedSections.join(" | "));
  assert.notEqual(leaf.identityDigest, leaf.candidateIdentityDigest);

  // The bridge grounds nothing and still moves: it prints the topic's digest and title.
  const bridge = entryOf(plan, BRIDGE_UNIT);
  assert.equal(bridge.status === "rebuild" && bridge.reason.cause === "identity-changed", true, canonicalJson(bridge));
});

test("a synthesis whose identity is byte-identical to its candidate is STILL rebuilt when a child moved", async () => {
  const fix = await fixture();
  const state = stateOverCatalog(fix.run, "content", withTopicTitle(fix.base.catalog, FEATURE_TOPIC, "Leave approval (perturbed title)"), fix.run.requests);
  const root = `${OVERVIEW_PRODUCT}::synthesis::document`;
  // The premise, measured: the identity a synthesis computes from the candidate children's verified summaries is
  // EQUAL to the candidate's own. Comparing digests alone would call this reusable.
  assert.equal(identityOf(fix, state, root).digest, identityOf(fix, fix.base, root).digest);
  const entry = entryOf(planBetween(fix, state), root);
  assert.equal(entry.status, "rebuild");
  if (entry.status !== "rebuild" || entry.reason.cause !== "child-not-reusable") throw new Error(canonicalJson(entry));
  assert.deepEqual([...entry.reason.blockingChildUnitIds], [BRIDGE_UNIT, `${OVERVIEW_PRODUCT}::leaf::feature`]);
  assert.match(entry.reason.statement, /the verified summaries its candidate identity would be measured against are stale/);
  assert.equal(entry.identityDigest, "", "a synthesis over moved children has no identity worth recording");
});

// --- (4) scenario (b): a binding-SET change, which moves OWNERSHIP -------------------------------------

test("dropping one binding rebuilds siblings that never named the topic: the owner moved, so their packets moved", async () => {
  const fix = await fixture();
  const state = stateOverCatalog(fix.run, "bindings", withoutBinding(fix.base.catalog, FEATURE_TOPIC, MIGRATING_OBLIGATION), fix.run.requests);
  const plan = planBetween(fix, state);
  assertConserves(plan);
  assert.deepEqual(ids(plan.entries, "reusable"), [
    "feature-leave-product::appendix::coverage",
    "overview-engineering::appendix::coverage",
    "overview-product::appendix::coverage"
  ], "only the three appendices survive a binding-set change: everything else's ownership environment moved");
  assert.equal(plan.conservation.rebuild, 13);
  assert.deepEqual(ids(plan.entries, "new"), []);
  assert.deepEqual([...plan.retired], []);

  // The sibling: it names no feature topic, its own plan row is unchanged, and it is rebuilt because it now OWNS
  // an obligation it used to render as a stub — with the evidence that comes with owning it.
  const sibling = entryOf(plan, `${OVERVIEW_PRODUCT}::leaf::work-item-dimension`);
  if (sibling.status !== "rebuild" || sibling.reason.cause !== "identity-changed") throw new Error(canonicalJson(sibling));
  assert.ok(sibling.reason.changedSections.some((section) => section.includes("Ownership and scope")), sibling.reason.changedSections.join(" | "));
  assert.ok(sibling.reason.changedSections.some((section) => section.includes("Evidence bound to the obligations this unit writes")),
    sibling.reason.changedSections.join(" | "));
  assert.equal(topicOf(state.catalog, FEATURE_TOPIC).bindings.some((binding) => binding.workItemId === MIGRATING_OBLIGATION), false);

  // And the two scenarios are NOT the same reading: 13 rebuilt here against 7 for the content change.
  const content = planBetween(fix, stateOverCatalog(fix.run, "content", withTopicTitle(fix.base.catalog, FEATURE_TOPIC, "Leave approval (perturbed title)"), fix.run.requests));
  assert.equal(content.conservation.rebuild, 7);
  assert.ok(plan.conservation.rebuild > content.conservation.rebuild + 5,
    `a binding-set change invalidates strictly more than a content change: ${plan.conservation.rebuild} vs ${content.conservation.rebuild}`);
});

// --- (5) a division: part ids are content-derived, so a re-division is new + retired -------------------

test("dividing a topic across two parts retires the undivided unit and brings the parts in as new", async () => {
  const fix = await fixture();
  const featureTopics = fix.base.catalog.topics.filter((topic) => topic.facet === "feature").sort((a, b) => a.topicId.localeCompare(b.topicId));
  const bindingsOf = (topicId: string): readonly string[] => topicOf(fix.base.catalog, topicId).bindings.map((binding) => binding.workItemId).sort((a, b) => a.localeCompare(b));
  const part = (suffix: string, index: number): ProposedUnit => ({
    kind: "leaf",
    unitId: `${OVERVIEW_PRODUCT}::leaf::feature#i-${suffix}`,
    documentId: OVERVIEW_PRODUCT,
    title: `Material feature topics — part: ${suffix}`,
    topics: featureTopics.map((topic) => ({ topicId: topic.topicId, obligationScope: { kind: "work-items" as const, workItemIds: [bindingsOf(topic.topicId)[index]!] } }))
  });
  const [partA, partB] = [part("aaaaaaaaaaaa", 0), part("bbbbbbbbbbbb", 1)];
  const generated = buildFixturePlan(fix.base.catalog, fix.run.requests, PLAN_BUDGET_TABLE);
  const kept = fix.base.planCatalog.units
    .filter((unit) => unit.documentId === OVERVIEW_PRODUCT && unit.kind !== "synthesis" && unit.unitId !== `${OVERVIEW_PRODUCT}::leaf::feature`)
    .map((unit) => ({ kind: unit.kind, unitId: unit.unitId, documentId: unit.documentId, title: unit.title, topics: unit.topics.map((topic) => ({ topicId: topic.topicId, obligationScope: topic.obligationScope })) } as ProposedUnit));
  const children = [...kept.map((unit) => unit.unitId), partA.unitId, partB.unitId].sort((a, b) => a.localeCompare(b));
  const units = [
    ...generated.units.filter((unit) => unit.documentId !== OVERVIEW_PRODUCT),
    ...kept,
    partA,
    partB,
    { kind: "synthesis" as const, unitId: `${OVERVIEW_PRODUCT}::synthesis::document`, documentId: OVERVIEW_PRODUCT, title: `${OVERVIEW_PRODUCT} synthesis`, childUnitIds: children }
  ].sort((a, b) => a.unitId.localeCompare(b.unitId));
  const parsed = parsePlanProposal({ ...JSON.parse(canonicalJson(generated)) as Record<string, unknown>, units: units.map((unit) => JSON.parse(canonicalJson(unit)) as unknown) });
  if (!parsed.proposal) throw new Error(parsed.problems.join("; "));
  const divided = planStateOf(fix.run, "divided", fix.base.catalog, fix.run.requests, parsed.proposal as PlanProposal);

  const plan = planBetween(fix, divided);
  assertConserves(plan);
  assert.deepEqual(ids(plan.entries, "new"), [partA.unitId, partB.unitId].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    "a part id is derived from its content, so a division is new units rather than a renamed one");
  assert.deepEqual(plan.retired.map((row) => row.unitId), [`${OVERVIEW_PRODUCT}::leaf::feature`],
    "and the undivided unit is retired, accounted for rather than deleted");
  // The document root is rebuilt, and the reason names the CHILDREN rather than the missing summaries: a child that
  // is not reusable is the stronger statement, and it is the one the epic's rule is written as.
  const root = entryOf(plan, `${OVERVIEW_PRODUCT}::synthesis::document`);
  if (root.status !== "rebuild" || root.reason.cause !== "child-not-reusable") throw new Error(canonicalJson(root));
  assert.deepEqual([...root.reason.blockingChildUnitIds], [
    BRIDGE_UNIT,
    `${OVERVIEW_PRODUCT}::leaf::coverage`,
    partA.unitId,
    partB.unitId,
    `${OVERVIEW_PRODUCT}::leaf::work-item-dimension`
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

// --- (5b) the TERMS half of the key: same packet, different terms is a rebuild, never a refusal -------

test("a candidate written by another model family is rebuilt with the authorship named, not refused as unexplained", async () => {
  const fix = await fixture();
  const prior: UnitAuthorship = { kind: "model-family", family: "prior-family" };
  // Same plan, same packets, a different author. Every section of every identity view is byte-identical, so the
  // ONLY thing that moved is a term — and before the terms were compared this threw for every unit at once,
  // reporting a section-coverage bug that did not exist. A switch of model family and any bump of
  // `unit-claims-v1` / `unit-summary-v1` / `unit-receipt-v1` are exactly the cases the digest carries them for.
  const plan = deriveUnitCachePlan({
    planned: plannedIdentities(fix, fix.base),
    candidates: plannedIdentities(fix, fix.base, fix.summaries, prior).flatMap((row) => (row.derivation === "children-unavailable" ? [] : [row.identity])),
    candidateSource: priorRun(fix)
  });
  assertConserves(plan);
  assert.equal(plan.conservation.reusable, 0, "nothing another family wrote is a verified answer here");
  assert.equal(plan.conservation.rebuild, 16);
  const leaf = entryOf(plan, `${OVERVIEW_PRODUCT}::leaf::feature`);
  if (leaf.status !== "rebuild" || leaf.reason.cause !== "identity-changed") throw new Error(canonicalJson(leaf));
  assert.deepEqual([...leaf.reason.changedSections], [], "no section moved: the packet is the same packet");
  assert.deepEqual([...leaf.reason.changedTerms], ["authorship: model family prior-family -> model-free generator fixture-plan"]);
  assert.match(leaf.reason.statement, /differs from its candidate in 1 term\(s\) it was written under/);
});

test("a candidate recorded under an older output contract is rebuilt with the contract named", async () => {
  const fix = await fixture();
  const unitId = `${OVERVIEW_PRODUCT}::appendix::coverage`;
  const identity = identityOf(fix, fix.base, unitId);
  // What R6b will read off disk after a schema bump: a stored identity whose contract is last version's. Its digest
  // is whatever was stored — that is the point of a stored key — so it is synthetic here on purpose.
  const stale: UnitIdentity = {
    ...identity,
    terms: { ...identity.terms, contract: { ...identity.terms.contract, claimsVersion: "unit-claims-v0" as typeof identity.terms.contract.claimsVersion } },
    digest: sha256("a candidate recorded under unit-claims-v0")
  };
  const plan = deriveUnitCachePlan({
    planned: [{ derivation: "own-inputs", identity }],
    candidates: [stale],
    candidateSource: priorRun(fix)
  });
  assertConserves(plan);
  const entry = entryOf(plan, unitId);
  if (entry.status !== "rebuild" || entry.reason.cause !== "identity-changed") throw new Error(canonicalJson(entry));
  assert.equal(entry.reason.changedTerms.length, 1, entry.reason.changedTerms.join(" | "));
  assert.match(entry.reason.changedTerms[0]!, /^output contract: /);
  assert.match(entry.reason.changedTerms[0]!, /unit-claims-v0/);
});

// --- (6) the first run: an empty candidate set is a reading, not an anomaly ----------------------------

test("a parent whose children are reusable but whose summaries could not be read is rebuilt, never reused", async () => {
  const fix = await fixture();
  const leafId = `${OVERVIEW_PRODUCT}::leaf::feature`;
  const leaf = identityOf(fix, fix.base, leafId);
  const root = identityOf(fix, fix.base, `${OVERVIEW_PRODUCT}::synthesis::document`);
  const plan = deriveUnitCachePlan({
    planned: [
      { derivation: "own-inputs", identity: leaf },
      {
        derivation: "children-unavailable",
        unitId: root.unitId,
        documentId: root.documentId,
        kind: root.kind,
        childUnitIds: [leafId],
        reason: "the candidate's summary sidecar for this child could not be read"
      }
    ],
    candidates: [leaf, root],
    candidateSource: priorRun(fix)
  });
  assertConserves(plan);
  assert.deepEqual(ids(plan.entries, "reusable"), [leafId], "the child itself is unchanged");
  const parent = entryOf(plan, root.unitId);
  if (parent.status !== "rebuild" || parent.reason.cause !== "children-unavailable") throw new Error(canonicalJson(parent));
  assert.match(parent.reason.statement, /could not be read/);
});

test("a first run reads as all new with `0 prior verified units` and the reason it is empty", async () => {
  const fix = await fixture();
  const source: CandidateSource = { origin: "no-prior-verified-units", reason: "this run has collected no authoring unit for this epoch and plan" };
  const plan = deriveUnitCachePlan({ planned: plannedIdentities(fix, fix.base), candidates: [], candidateSource: source });
  assertConserves(plan);
  assert.equal(plan.conservation.new, 16);
  assert.equal(plan.conservation.reusable, 0);
  assert.equal(plan.candidateStatement, "0 prior verified units: this run has collected no authoring unit for this epoch and plan");
  for (const entry of plan.entries) {
    assert.equal(entry.status, "new");
    if (entry.status !== "new") throw new Error(canonicalJson(entry));
    assert.match(entry.reason, /0 prior verified units: this run has collected no authoring unit/);
  }
  assert.equal(describeCandidateSource(source, 0), plan.candidateStatement);
});

test("a candidate set and its declared source must agree, in both directions and with a reason", async () => {
  const fix = await fixture();
  const planned = plannedIdentities(fix, fix.base);
  assert.throws(() => deriveUnitCachePlan({ planned, candidates: [], candidateSource: priorRun(fix) }),
    /An empty set has to be declared as one|candidate set is empty/);
  assert.throws(() => deriveUnitCachePlan({ planned, candidates: candidatesOf(fix), candidateSource: { origin: "no-prior-verified-units", reason: "none" } }),
    /declares no prior verified units but 16 candidate\(s\) were handed in/);
  assert.throws(() => deriveUnitCachePlan({ planned, candidates: [], candidateSource: { origin: "no-prior-verified-units", reason: "   " } }),
    /must say WHY it is empty/);
});

// --- (7) a plan whose units are retired wholesale -----------------------------------------------------

test("a document dropped from the recorded requests retires its units and rebuilds nothing", async () => {
  const fix = await fixture();
  const state = stateOverCatalog(fix.run, "one-document-dropped", fix.base.catalog, withoutDocument(fix.run.requests, "feature-leave-product"));
  const plan = deriveUnitCachePlan({ planned: plannedIdentities(fix, state), candidates: candidatesOf(fix), candidateSource: priorRun(fix) });
  assertConserves(plan);
  assert.deepEqual(plan.retired.map((row) => row.unitId), [
    "feature-leave-product::appendix::coverage",
    "feature-leave-product::leaf::coverage",
    "feature-leave-product::leaf::feature",
    "feature-leave-product::leaf::work-item-dimension",
    "feature-leave-product::synthesis::document"
  ]);
  assert.deepEqual(ids(plan.entries, "rebuild"), [], "the documents that remain are untouched by the one that left");
  assert.deepEqual(ids(plan.entries, "new"), []);
  assert.equal(plan.conservation.reusable, 11);
});

// --- (8) the shape refusals: a caller may not smuggle an identity past the children rule ---------------

test("only a synthesis may be identified from child summaries, and a synthesis may not be identified any other way", async () => {
  const fix = await fixture();
  const leaf = identityOf(fix, fix.base, `${OVERVIEW_PRODUCT}::leaf::feature`);
  const root = identityOf(fix, fix.base, `${OVERVIEW_PRODUCT}::synthesis::document`);
  assert.throws(() => deriveUnitCachePlan({
    planned: [{ derivation: "own-inputs", identity: root }],
    candidates: [root],
    candidateSource: priorRun(fix)
  }), /a synthesis is written from its children's verified summaries/);
  assert.throws(() => deriveUnitCachePlan({
    planned: [{ derivation: "candidate-children-summaries", identity: leaf, childUnitIds: [] }],
    candidates: [leaf],
    candidateSource: priorRun(fix)
  }), /only a synthesis is written from child summaries/);
});

test("a child nobody planned, a duplicated unit and an unorderable cycle are all named refusals", async () => {
  const fix = await fixture();
  const leaf = identityOf(fix, fix.base, `${OVERVIEW_PRODUCT}::leaf::feature`);
  const root = identityOf(fix, fix.base, `${OVERVIEW_PRODUCT}::synthesis::document`);
  assert.throws(() => deriveUnitCachePlan({
    planned: [{ derivation: "candidate-children-summaries", identity: root, childUnitIds: ["nobody::leaf::planned"] }],
    candidates: [root],
    candidateSource: priorRun(fix)
  }), /which the planned identity map does not hold/);
  assert.throws(() => deriveUnitCachePlan({
    planned: [{ derivation: "own-inputs", identity: leaf }, { derivation: "own-inputs", identity: leaf }],
    candidates: [leaf],
    candidateSource: priorRun(fix)
  }), /holds unit .* twice; a unit with two identities has none/);
  assert.throws(() => deriveUnitCachePlan({
    planned: [{ derivation: "own-inputs", identity: leaf }],
    candidates: [leaf, leaf],
    candidateSource: priorRun(fix)
  }), /holds unit .* twice; which verified draft would be reused/);
  const cycle: readonly PlannedUnitIdentity[] = [
    { derivation: "children-unavailable", unitId: "doc::synthesis::a", documentId: "doc", kind: "synthesis", childUnitIds: ["doc::synthesis::b"], reason: "no summary" },
    { derivation: "children-unavailable", unitId: "doc::synthesis::b", documentId: "doc", kind: "synthesis", childUnitIds: ["doc::synthesis::a"], reason: "no summary" }
  ];
  assert.throws(() => deriveUnitCachePlan({ planned: cycle, candidates: [], candidateSource: { origin: "no-prior-verified-units", reason: "first run" } }),
    /cannot order 2 unit\(s\)/);
});
