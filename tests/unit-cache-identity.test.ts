import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256 } from "../src/base/util.ts";
import { FULL_OBLIGATION_SCOPE } from "../src/report/obligation-scope.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { documentOwnership } from "../src/report/plan-obligation-conservation.ts";
import { parsePlanProposal, type PlanProposal, type ProposedUnit } from "../src/report/plan-proposal.ts";
import { planCatalogDigest } from "../src/report/plan-artifacts.ts";
import { intentPolicyFor, lensPolicyFor, REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import {
  IDENTITY_NORMALIZED_HEADER_LABELS,
  IDENTITY_NORMALIZED_VALUE,
  composeUnitPacketMarkdown,
  renderUnitPacket,
  topicDossier,
  unitPacketBytes
} from "../src/report/unit-packet.ts";
import { buildReportRequestsArtifact } from "../src/report/report-requests-artifact.ts";
import { MINI_DOCUMENTS } from "./plan-fixture.ts";
import {
  UNIT_CACHE_IDENTITY_VERSION,
  UNIT_OUTPUT_CONTRACT,
  identitySectionDifferences,
  identityTermDifferences,
  unitIdentityOf,
  unitIdentitySections,
  unitIdentityView
} from "../src/report/unit-cache-identity.ts";
import { describeAuthorship } from "../src/report/unit-provenance.ts";
import {
  BRIDGE_UNIT,
  COVERAGE_TOPIC,
  DIMENSION_TOPIC,
  FEATURE_TOPIC,
  FIXTURE_AUTHORSHIP,
  MIGRATING_OBLIGATION,
  OVERVIEW_PRODUCT,
  identityFixture,
  identityInput,
  identityOf,
  planStateOf,
  stateOverCatalog,
  topicOf,
  withDocument,
  withLensVersion,
  withTopicTitle,
  withoutBinding,
  type IdentityFixture,
  type PlanState
} from "./unit-cache-identity-fixture.ts";

/**
 * R6a - the cache identity of one authoring unit (`unit-identity.ts`).
 *
 * The one thing this file exists to stop is a WRONG KEY: an identity that says "the same" when the packet an author
 * would be handed has moved. Two failure directions, and only one of them is survivable. Over-invalidation costs a
 * rewrite. Under-invalidation admits a draft written against inputs that no longer exist — and R6b will admit on
 * this key, so a collapse here is a silent stale document.
 *
 * So the tests below are mostly NEGATIVE: pairs of units, or pairs of plan states, that a hand-written key list
 * (the epic's own sketch: epoch + topic digests + audience + policy + budget) would call identical, asserted to
 * have DIFFERENT identities. The scope pair is the sharpest: same topic ids, same topic digests, same request
 * fields, same everything the sketch enumerates - and one of them must not be reusable as the other.
 *
 * Nothing here writes into a fixture. Every perturbation is a value: a topic title, a topic's binding set, a
 * recorded request added, a lens version bumped, an epoch bumped.
 */

let shared: Promise<IdentityFixture> | null = null;
function fixture(): Promise<IdentityFixture> { return (shared ??= identityFixture()); }

/** Every unit of a plan state, ascending. */
function unitIds(state: PlanState): readonly string[] {
  return state.planCatalog.units.map((unit) => unit.unitId);
}

/** The lines two renderings disagree on, by index. */
function differingLines(left: string, right: string): readonly { readonly index: number; readonly left: string; readonly right: string }[] {
  const a = left.split("\n");
  const b = right.split("\n");
  assert.equal(a.length, b.length, "the identity view must not add or remove a line: it is the same composition");
  const rows: { index: number; left: string; right: string }[] = [];
  for (const [index, line] of a.entries()) {
    if (line !== b[index]) rows.push({ index, left: line, right: b[index]! });
  }
  return rows;
}

// --- (1) the normalized line list is closed, and it is what the two views disagree on -------------------

test("the normalized header label list is exactly three plan-global digests, and nothing else", () => {
  assert.deepEqual([...IDENTITY_NORMALIZED_HEADER_LABELS], ["topics catalog digest", "plan catalog digest", "recorded requests digest"],
    "a fourth normalized line is a planning-level decision: it decides what a cache may consider unchanged");
  assert.equal(new Set(IDENTITY_NORMALIZED_HEADER_LABELS).size, 3, "a duplicated member would pass both type checks and normalize one line twice");
});

test("every renderable unit's identity view differs from its packet in EXACTLY the three declared lines", async () => {
  const { base } = await fixture();
  let checked = 0;
  for (const unitId of unitIds(base)) {
    const input = identityInput(await fixture(), base, unitId);
    const packet = composeUnitPacketMarkdown(input, "packet");
    const identity = composeUnitPacketMarkdown(input, "identity");
    const rows = differingLines(packet, identity);
    assert.deepEqual(rows.map((row) => row.left.split(":")[0]!.replace("- ", "")), [...IDENTITY_NORMALIZED_HEADER_LABELS],
      `${unitId}: the identity view may only normalize the three declared lines, in place`);
    for (const row of rows) {
      assert.ok(row.right.endsWith(IDENTITY_NORMALIZED_VALUE), `${unitId}: line ${row.index} must be normalized, not removed`);
    }
    // The packet an author reads never contains the placeholder, and the plan-global digests are each printed once.
    assert.equal(packet.includes(IDENTITY_NORMALIZED_VALUE), false, `${unitId}: a real packet must carry the real digests`);
    for (const label of IDENTITY_NORMALIZED_HEADER_LABELS) {
      assert.equal(packet.split("\n").filter((line) => line.startsWith(`- ${label}: `)).length, 1,
        `${unitId}: ${label} must appear exactly once, or normalizing it would leave a copy behind`);
    }
    // AND NO PLAN-GLOBAL DIGEST VALUE SURVIVES ANYWHERE IN THE VIEW. The line diff above catches a normalization
    // nobody declared; this catches the other direction — a renderer that starts printing one of these three
    // digests a SECOND time, in a line of its own or inside a sentence, would make every unit of the run depend on
    // every other change to the run again, and the second-audience equality below would be the only thing to
    // notice. Two of the three are printed elsewhere in this codebase's artifacts, so this is not hypothetical.
    for (const digest of [base.planCatalog.topicsDigest, planCatalogDigest(base.planCatalog), base.planCatalog.requestsDigest]) {
      assert.equal(identity.includes(digest), false,
        `${unitId}: the identity view still carries the plan-global digest ${digest.slice(0, 12)}…, so a change anywhere in the plan or the request set moves it`);
    }
    // The epoch is NOT normalized: a re-freeze must invalidate every unit of the run.
    assert.ok(identity.includes(`- knowledge epoch: ${base.planCatalog.knowledgeEpoch} (digest ${base.planCatalog.knowledgeDigest})`),
      `${unitId}: the identity view keeps the epoch verbatim`);
    checked += 1;
  }
  assert.equal(checked, 16, "the fixture must cover all four unit kinds across three documents, bridge included");
});

test("the packet view is byte-identical to what the renderer and the budget pre-check produce", async () => {
  const { base } = await fixture();
  for (const unitId of unitIds(base)) {
    const input = identityInput(await fixture(), base, unitId);
    const composed = composeUnitPacketMarkdown(input, "packet");
    assert.equal(composed, renderUnitPacket(input).markdown, `${unitId}: the exposed composition IS the packet`);
    assert.equal(Buffer.byteLength(composed, "utf8"), unitPacketBytes(input), `${unitId}: and it is what the pre-check measures`);
  }
});

// --- (2) the identity record itself --------------------------------------------------------------------

test("an identity carries the output contract, the authorship and one section per heading of its view", async () => {
  const fix = await fixture();
  const unitId = `${OVERVIEW_PRODUCT}::leaf::feature`;
  const identity = identityOf(fix, fix.base, unitId);
  assert.equal(identity.version, UNIT_CACHE_IDENTITY_VERSION);
  assert.deepEqual(identity.terms.contract, UNIT_OUTPUT_CONTRACT, "the claims/summary/receipt schema versions are part of the key");
  assert.deepEqual(identity.terms.authorship, FIXTURE_AUTHORSHIP);
  assert.equal(identity.terms.request.documentId, OVERVIEW_PRODUCT, "and THIS document's recorded request row, which the packet does not print in full");
  // The terms are a CLOSED list, and every member is per-document or per-build: a plan-global member here would put
  // back the coupling the three normalized header lines exist to remove.
  assert.deepEqual(Object.keys(identity.terms).sort(), ["authorship", "contract", "request"]);
  assert.equal(describeAuthorship(FIXTURE_AUTHORSHIP), "model-free generator fixture-plan");
  const view = unitIdentityView(identityInput(fix, fix.base, unitId));
  assert.equal(identity.viewBytes, Buffer.byteLength(view, "utf8"));
  const headings = view.split("\n").filter((line) => line.startsWith("## "));
  assert.equal(identity.sections.length, headings.length + 1, "one section per heading plus the header above the first one");
  assert.deepEqual(identity.sections.slice(1).map((section) => section.heading), headings);
  assert.equal(identity.sections[0]!.heading, "(packet header)");
  assert.deepEqual(identity.sections.map((section) => section.ordinal), identity.sections.map((_, index) => index + 1));
  // Same values, same digest, twice — and the digest is over the view, not over the record.
  assert.equal(identityOf(fix, fix.base, unitId).digest, identity.digest);
  assert.equal(identity.digest, sha256(canonicalJson({ version: UNIT_CACHE_IDENTITY_VERSION, terms: identity.terms, view })));
});

test("an authorship with an empty name is a named refusal, not an anonymous identity", async () => {
  const fix = await fixture();
  const input = identityInput(fix, fix.base, `${OVERVIEW_PRODUCT}::appendix::coverage`);
  assert.throws(() => unitIdentityOf(input, { kind: "model-family", family: "  " }), /must name who would have written the draft/);
  assert.throws(() => unitIdentityOf(input, { kind: "model-free", generator: "" }), /must name who would have written the draft/);
  // Two authors, one packet: not the same identity. A draft one family wrote is not a verified answer for another.
  const a = unitIdentityOf(input, { kind: "model-family", family: "family-a" });
  const b = unitIdentityOf(input, { kind: "model-family", family: "family-b" });
  const free = unitIdentityOf(input, { kind: "model-free", generator: "family-a" });
  assert.notEqual(a.digest, b.digest, "two model families are two authors");
  assert.notEqual(a.digest, free.digest, "and a model-free generator is not a model family with the same name");
  // Two spellings of one author would be two identities: a cache miss that reads as a real change. Core refuses it
  // rather than trimming silently — `src/cli.ts` trims at the boundary, where the shell put the space.
  assert.throws(() => unitIdentityOf(input, { kind: "model-family", family: " family-a" }), /nor one with surrounding whitespace is a name/);
});

test("a moved request BOUNDARY for the same document is a different identity, even when the packet is byte-identical", async () => {
  const fix = await fixture();
  // The same documentId, the same audience, intent, language and detail budget — and a different feature key, so
  // the request's knowledge boundary (`scope`/`scopeIds`) moved. The fixture plan does not divide by scope, so the
  // PACKET is byte-identical: the header prints the audience and the intent, never the boundary. Without the
  // recorded request row in the terms, this reads as reusable.
  const moved = buildReportRequestsArtifact(MINI_DOCUMENTS.map((document) => document.documentId === "feature-leave-product"
    ? { ...document, featureKey: "promo-9f8e7d6c5b" }
    : document));
  const state = stateOverCatalog(fix.run, "boundary-moved", fix.base.catalog, moved);
  const unitId = "feature-leave-product::leaf::feature";
  assert.equal(unitIdentityView(identityInput(fix, state, unitId)), unitIdentityView(identityInput(fix, fix.base, unitId)),
    "the premise: the rendered packet cannot see the boundary move at all");
  const before = identityOf(fix, fix.base, unitId);
  const after = identityOf(fix, state, unitId);
  assert.notEqual(after.digest, before.digest, "a unit written for one feature is not a verified answer for another");
  assert.deepEqual(identitySectionDifferences(before, after), [], "and no section moved, which is why the terms have to be compared too");
  const terms = identityTermDifferences(before, after);
  assert.equal(terms.length, 1, terms.join(" | "));
  assert.match(terms[0]!, /^recorded request for feature-leave-product: /);
  // Every OTHER document is untouched: the row is per document, so this is not the plan-global coupling again.
  for (const other of unitIds(fix.base).filter((row) => !row.startsWith("feature-leave-product"))) {
    assert.equal(identityOf(fix, state, other).digest, identityOf(fix, fix.base, other).digest, other);
  }
});

// --- (3) IDENTITY COLLAPSE: what a hand-written key list would fold together ----------------------------

/**
 * The key the epic sketched, spelled out here on purpose.
 *
 * It is the enumeration this slice REFUSED to build: epoch, the unit's topics and their digests, the audience, the
 * intent, the language, the detail budget and the policy digests. The tests below use it to show what it folds
 * together — it is not used anywhere in `src/`.
 */
function sketchedKey(state: PlanState, unitId: string): string {
  const unit = state.planCatalog.units.find((row) => row.unitId === unitId)!;
  const record = state.requests.requests.find((row) => row.documentId === unit.documentId)!.request;
  const lens = lensPolicyFor(record.audience, REPORT_POLICY_REGISTRY);
  const intent = intentPolicyFor(record.intent, REPORT_POLICY_REGISTRY);
  return canonicalJson({
    knowledgeEpoch: state.planCatalog.knowledgeEpoch,
    knowledgeDigest: state.planCatalog.knowledgeDigest,
    kind: unit.kind,
    topics: unit.topics.map((topic) => [topic.topicId, topic.topicDigest]),
    audience: record.audience,
    intent: record.intent,
    language: record.language,
    detailBudget: record.detailBudget,
    lens: lens.digest,
    intentPolicy: intent.digest
  });
}

/** A proposal for `overview-product` with a replacement unit set; the other documents keep the generated shape. */
function proposalFor(fix: IdentityFixture, units: readonly ProposedUnit[]): PlanProposal {
  const generated = buildFixturePlan(fix.base.catalog, fix.run.requests, PLAN_BUDGET_TABLE);
  const all = [...generated.units.filter((unit) => unit.documentId !== OVERVIEW_PRODUCT), ...units]
    .sort((a, b) => a.unitId.localeCompare(b.unitId));
  const parsed = parsePlanProposal({
    ...JSON.parse(canonicalJson(generated)) as Record<string, unknown>,
    units: all.map((unit) => JSON.parse(canonicalJson(unit)) as unknown)
  });
  if (!parsed.proposal) throw new Error(`the fixture proposal does not parse: ${parsed.problems.join("; ")}`);
  return parsed.proposal;
}

function whole(topicIds: readonly string[]): readonly { readonly topicId: string; readonly obligationScope: typeof FULL_OBLIGATION_SCOPE }[] {
  return topicIds.map((topicId) => ({ topicId, obligationScope: FULL_OBLIGATION_SCOPE }));
}

/** The `overview-product` units every collapse fixture below shares: the two non-feature leaves and the appendix. */
function sharedUnits(fix: IdentityFixture): readonly ProposedUnit[] {
  const facetTopics = (facet: string, material: boolean): readonly string[] => fix.base.catalog.topics
    .filter((topic) => topic.facet === facet && (material ? topic.materiality === "material" : topic.materiality !== "material"))
    .map((topic) => topic.topicId)
    .sort((a, b) => a.localeCompare(b));
  return [
    { kind: "leaf", unitId: `${OVERVIEW_PRODUCT}::leaf::coverage`, documentId: OVERVIEW_PRODUCT, title: "Material coverage topics", topics: whole(facetTopics("coverage", true)) },
    { kind: "leaf", unitId: `${OVERVIEW_PRODUCT}::leaf::work-item-dimension`, documentId: OVERVIEW_PRODUCT, title: "Material work-item-dimension topics", topics: whole(facetTopics("work-item-dimension", true)) },
    { kind: "appendix", unitId: `${OVERVIEW_PRODUCT}::appendix::coverage`, documentId: OVERVIEW_PRODUCT, title: "Coverage and unknowns", topics: whole(facetTopics("coverage", false)) }
  ];
}

function synthesisOver(children: readonly string[]): ProposedUnit {
  return {
    kind: "synthesis",
    unitId: `${OVERVIEW_PRODUCT}::synthesis::document`,
    documentId: OVERVIEW_PRODUCT,
    title: `${OVERVIEW_PRODUCT} synthesis`,
    childUnitIds: [...children].sort((a, b) => a.localeCompare(b))
  };
}

test("two parts of one DIVIDED topic have different identities, and the sketched key folds them into one", async () => {
  const fix = await fixture();
  const featureTopics = fix.base.catalog.topics.filter((topic) => topic.facet === "feature").sort((a, b) => a.topicId.localeCompare(b.topicId));
  assert.equal(featureTopics.length, 2, "the fixture needs two feature topics so both parts can name the same pair");
  const bindingsOf = (topicId: string): readonly string[] => topicOf(fix.base.catalog, topicId).bindings.map((binding) => binding.workItemId).sort((a, b) => a.localeCompare(b));
  const part = (suffix: string, index: number): ProposedUnit => ({
    kind: "leaf",
    unitId: `${OVERVIEW_PRODUCT}::leaf::feature#i-${suffix}`,
    documentId: OVERVIEW_PRODUCT,
    title: `Material feature topics — part: ${suffix}`,
    topics: featureTopics.map((topic) => ({ topicId: topic.topicId, obligationScope: { kind: "work-items" as const, workItemIds: [bindingsOf(topic.topicId)[index]!] } }))
  });
  const [partA, partB] = [part("aaaaaaaaaaaa", 0), part("bbbbbbbbbbbb", 1)];
  const shared = sharedUnits(fix);
  const state = planStateOf(fix.run, "divided", fix.base.catalog, fix.run.requests,
    proposalFor(fix, [...shared, partA, partB, synthesisOver([...shared.map((unit) => unit.unitId), partA.unitId, partB.unitId])]));

  const rowA = state.planCatalog.units.find((unit) => unit.unitId === partA.unitId)!;
  const rowB = state.planCatalog.units.find((unit) => unit.unitId === partB.unitId)!;
  // The premise: everything the sketched key names is identical, and only the scope differs.
  assert.deepEqual(rowA.topics.map((topic) => [topic.topicId, topic.topicDigest]), rowB.topics.map((topic) => [topic.topicId, topic.topicDigest]));
  assert.equal(sketchedKey(state, partA.unitId), sketchedKey(state, partB.unitId),
    "the epic's key sketch cannot tell the two parts apart — this is the collapse, measured");
  assert.notEqual(canonicalJson(rowA.topics.map((topic) => topic.obligationScope)), canonicalJson(rowB.topics.map((topic) => topic.obligationScope)));

  const identityA = identityOf(fix, state, partA.unitId);
  const identityB = identityOf(fix, state, partB.unitId);
  assert.notEqual(identityA.digest, identityB.digest,
    "one part's verified draft would be admitted as the other's: the scope is what makes them two units");
  const differences = identitySectionDifferences(identityA, identityB);
  assert.ok(differences.length > 0 && differences.some((row) => row.includes("Obligations bound to this unit's topics")), differences.join(" | "));
});

test("the SAME part id carrying a DIFFERENT scope is a different identity — the collapse with nothing else left to tell them apart", async () => {
  const fix = await fixture();
  const featureTopics = fix.base.catalog.topics.filter((topic) => topic.facet === "feature").sort((a, b) => a.topicId.localeCompare(b.topicId));
  const bindingsOf = (topicId: string): readonly string[] => topicOf(fix.base.catalog, topicId).bindings.map((binding) => binding.workItemId).sort((a, b) => a.localeCompare(b));
  // Two parts, and two states that SWAP their scopes. The ids are stable across the two states on purpose: a
  // division rung whose component is the leading dimension keeps a part's id when its bucket membership changes
  // (`plan-unit-split.ts` derives the `dimension` component from `group[0]`), so "same unit id, different scope" is
  // a state a real re-division reaches — and it is the one case where nothing outside the scope distinguishes the
  // two. If the scope were not in the key, one part's verified draft would be admitted as the other's.
  const part = (suffix: string, index: number): ProposedUnit => ({
    kind: "leaf",
    unitId: `${OVERVIEW_PRODUCT}::leaf::feature#d-${suffix}`,
    documentId: OVERVIEW_PRODUCT,
    title: "Material feature topics — part",
    topics: featureTopics.map((topic) => ({ topicId: topic.topicId, obligationScope: { kind: "work-items" as const, workItemIds: [bindingsOf(topic.topicId)[index]!] } }))
  });
  const shared = sharedUnits(fix);
  const stateFor = (label: string, firstIndex: number): PlanState => {
    const first = part("alpha", firstIndex);
    const second = part("beta", firstIndex === 0 ? 1 : 0);
    return planStateOf(fix.run, label, fix.base.catalog, fix.run.requests,
      proposalFor(fix, [...shared, first, second, synthesisOver([...shared.map((unit) => unit.unitId), first.unitId, second.unitId])]));
  };
  const straight = stateFor("scopes-straight", 0);
  const swapped = stateFor("scopes-swapped", 1);
  const alpha = `${OVERVIEW_PRODUCT}::leaf::feature#d-alpha`;

  const rowStraight = straight.planCatalog.units.find((unit) => unit.unitId === alpha)!;
  const rowSwapped = swapped.planCatalog.units.find((unit) => unit.unitId === alpha)!;
  assert.deepEqual(rowStraight.topics.map((topic) => [topic.topicId, topic.topicDigest]), rowSwapped.topics.map((topic) => [topic.topicId, topic.topicDigest]),
    "same unit, same topics, same topic digests");
  assert.equal(sketchedKey(straight, alpha), sketchedKey(swapped, alpha),
    "the epic's key sketch is IDENTICAL across the swap — same epoch, same topics, same audience, same policy, same unit id");
  assert.notEqual(canonicalJson(rowStraight.topics.map((topic) => topic.obligationScope)), canonicalJson(rowSwapped.topics.map((topic) => topic.obligationScope)));
  assert.notEqual(identityOf(fix, straight, alpha).digest, identityOf(fix, swapped, alpha).digest,
    "the obligation scope is what makes these two different units of work, and the identity must say so");
});

test("adding a HIGHER-priority owning unit moves the identity of a sibling that never named its topic", async () => {
  const fix = await fixture();
  const featureTopics = fix.base.catalog.topics.filter((topic) => topic.facet === "feature").map((topic) => topic.topicId).sort((a, b) => a.localeCompare(b));
  const shared = sharedUnits(fix);
  const bridge: ProposedUnit = { kind: "bridge", unitId: BRIDGE_UNIT, documentId: OVERVIEW_PRODUCT, title: "How the features relate", topics: whole(featureTopics) };
  const featureLeaf: ProposedUnit = { kind: "leaf", unitId: `${OVERVIEW_PRODUCT}::leaf::feature`, documentId: OVERVIEW_PRODUCT, title: "Material feature topics", topics: whole(featureTopics) };
  // Before: only a REFERENCING unit names the feature topics, so the dimension leaf owns the obligation.
  const before = planStateOf(fix.run, "owner-is-dimension", fix.base.catalog, fix.run.requests,
    proposalFor(fix, [...shared, bridge, synthesisOver([...shared.map((unit) => unit.unitId), bridge.unitId])]));
  // After: a feature LEAF is added — the same obligation, a higher facet priority, a different owner.
  const after = planStateOf(fix.run, "owner-is-feature", fix.base.catalog, fix.run.requests,
    proposalFor(fix, [...shared, bridge, featureLeaf, synthesisOver([...shared.map((unit) => unit.unitId), bridge.unitId, featureLeaf.unitId])]));

  const dimension = `${OVERVIEW_PRODUCT}::leaf::work-item-dimension`;
  assert.equal(documentOwnership(before.ownership, OVERVIEW_PRODUCT).ownerByObligation.get(MIGRATING_OBLIGATION)!.ownerUnitId, dimension);
  assert.equal(documentOwnership(after.ownership, OVERVIEW_PRODUCT).ownerByObligation.get(MIGRATING_OBLIGATION)!.ownerUnitId, `${OVERVIEW_PRODUCT}::leaf::feature`);
  // The sibling's OWN plan row did not move by a byte, and it names no feature topic at all.
  const rowBefore = before.planCatalog.units.find((unit) => unit.unitId === dimension)!;
  const rowAfter = after.planCatalog.units.find((unit) => unit.unitId === dimension)!;
  assert.equal(canonicalJson(rowBefore), canonicalJson(rowAfter), "the perturbation is the DOCUMENT's unit set, not this unit's row");
  assert.equal(sketchedKey(before, dimension), sketchedKey(after, dimension), "the sketched key cannot see a sibling appearing — this is the second collapse");
  assert.notEqual(identityOf(fix, before, dimension).digest, identityOf(fix, after, dimension).digest,
    "what this unit owes changed, so its packet changed, so its identity must change");
  const differences = identitySectionDifferences(identityOf(fix, before, dimension), identityOf(fix, after, dimension));
  assert.ok(differences.some((row) => row.includes("Ownership and scope")), differences.join(" | "));
});

test("a lens policy digest moves every unit of the documents that read through it, and no others", async () => {
  const fix = await fixture();
  const bumped = withLensVersion(REPORT_POLICY_REGISTRY, "product-manager", "lens-v9-fixture");
  const moved: string[] = [];
  const held: string[] = [];
  for (const unitId of unitIds(fix.base)) {
    const before = identityOf(fix, fix.base, unitId).digest;
    const after = identityOf(fix, fix.base, unitId, { registry: bumped }).digest;
    (before === after ? held : moved).push(unitId);
  }
  assert.deepEqual(moved.filter((unitId) => !unitId.startsWith("overview-product") && !unitId.startsWith("feature-leave-product")), [],
    "only the documents whose audience resolves to the bumped lens may move");
  assert.deepEqual(held, unitIds(fix.base).filter((unitId) => unitId.startsWith("overview-engineering")),
    "and every one of those documents' units moves, synthesis included");
});

test("an epoch bump moves EVERY unit's identity: the epoch line is not normalized", async () => {
  const fix = await fixture();
  const reFrozen = { ...fix.base.planCatalog, knowledgeEpoch: fix.base.planCatalog.knowledgeEpoch + 1 };
  for (const unitId of unitIds(fix.base)) {
    assert.notEqual(identityOf(fix, fix.base, unitId).digest, identityOf(fix, fix.base, unitId, { planCatalog: reFrozen }).digest,
      `${unitId}: a re-freeze invalidates everything; nothing written against epoch N answers for epoch N+1`);
  }
});

// --- (4) INSENSITIVITY: the three normalized lines are what makes reuse possible at all ----------------

test("adding a second-audience document leaves every existing unit's identity view byte-identical", async () => {
  const fix = await fixture();
  const second = stateOverCatalog(fix.run, "second-audience", fix.base.catalog, withDocument(fix.run.requests, {
    documentId: "feature-leave-engineering",
    kind: "feature",
    audience: "engineering",
    featureKey: "leave-1a2b3c4d5e",
    detailLevel: "standard",
    language: "en-US"
  }));
  assert.equal(second.planCatalog.units.length, fix.base.planCatalog.units.length + 5, "the new document brings its own units");
  assert.notEqual(second.planCatalog.requestsDigest, fix.base.planCatalog.requestsDigest, "and it does move the plan-global digests");
  for (const unitId of unitIds(fix.base)) {
    assert.equal(unitIdentityView(identityInput(fix, second, unitId)), unitIdentityView(identityInput(fix, fix.base, unitId)),
      `${unitId}: byte for byte, or the second audience would rewrite the first one's documents`);
    assert.equal(identityOf(fix, second, unitId).digest, identityOf(fix, fix.base, unitId).digest, unitId);
  }
  // The falsification, run here rather than described: WITHOUT the normalization the equality is false. The packet
  // view of the same two states differs precisely because the three plan-global digest lines moved.
  const sample = `${OVERVIEW_PRODUCT}::leaf::feature`;
  const rows = differingLines(composeUnitPacketMarkdown(identityInput(fix, fix.base, sample), "packet"), composeUnitPacketMarkdown(identityInput(fix, second, sample), "packet"));
  assert.deepEqual(rows.map((row) => row.left.split(":")[0]!.replace("- ", "")), ["plan catalog digest", "recorded requests digest"],
    "the un-normalized packet differs in exactly the plan-global lines; that is what excluding them buys");
});

test("one topic's dossier is the same bytes in every document that reads it", async () => {
  const fix = await fixture();
  const topicsById = new Map(fix.base.catalog.topics.map((topic) => [topic.topicId, topic]));
  const dossiers = ["overview-product", "overview-engineering", "feature-leave-product"].map((documentId) => {
    const unit = fix.base.planCatalog.units.find((row) => row.unitId === `${documentId}::leaf::feature`)!;
    const dossier = topicDossier(unit, topicsById, fix.run.evidenceById);
    if (dossier.source !== "topics") throw new Error("a leaf's dossier is its topics");
    return canonicalJson({ topics: dossier.topics, evidence: [...dossier.evidence.keys()].sort((a, b) => a.localeCompare(b)) });
  });
  assert.equal(new Set(dossiers).size, 1, "the same topic dossier serves every document: R6b reuses it, it does not re-derive it per audience");
});

// --- (5) the two perturbation shapes are DIFFERENT, and that is the point ------------------------------

test("a binding-preserving content change moves only the units that name the topic; a binding-set change moves owners too", async () => {
  const fix = await fixture();
  const content = stateOverCatalog(fix.run, "content", withTopicTitle(fix.base.catalog, FEATURE_TOPIC, "Leave approval (perturbed title)"), fix.run.requests);
  const bindings = stateOverCatalog(fix.run, "bindings", withoutBinding(fix.base.catalog, FEATURE_TOPIC, MIGRATING_OBLIGATION), fix.run.requests);

  const movedUnder = (state: PlanState): readonly string[] => unitIds(fix.base)
    .filter((unitId) => identityOf(fix, state, unitId).digest !== identityOf(fix, fix.base, unitId).digest)
    .sort((a, b) => a.localeCompare(b));

  // (a) The content change: the topic's binding set, its ownership and every other topic are untouched.
  assert.equal(canonicalJson(topicOf(content.catalog, FEATURE_TOPIC).bindings), canonicalJson(topicOf(fix.base.catalog, FEATURE_TOPIC).bindings));
  assert.equal(documentOwnership(content.ownership, OVERVIEW_PRODUCT).ownerByObligation.get(MIGRATING_OBLIGATION)!.ownerUnitId, `${OVERVIEW_PRODUCT}::leaf::feature`);
  assert.deepEqual(movedUnder(content), [
    "feature-leave-product::leaf::feature",
    "overview-engineering::leaf::feature",
    BRIDGE_UNIT,
    "overview-product::leaf::feature"
  ].sort((a, b) => a.localeCompare(b)), "only the units that NAME the topic: the leaves that own it and the bridge that references it");

  // (b) The binding-set change: the obligation's owner moves to the dimension leaf of every document.
  assert.equal(documentOwnership(bindings.ownership, OVERVIEW_PRODUCT).ownerByObligation.get(MIGRATING_OBLIGATION)!.ownerUnitId, `${OVERVIEW_PRODUCT}::leaf::work-item-dimension`);
  const movedByBindings = movedUnder(bindings);
  for (const documentId of ["overview-product", "overview-engineering", "feature-leave-product"]) {
    assert.ok(movedByBindings.includes(`${documentId}::leaf::work-item-dimension`),
      `${documentId}: the dimension leaf never named ${FEATURE_TOPIC}, and its identity must still move — it now OWNS an obligation it used to stub`);
    assert.ok(movedByBindings.includes(`${documentId}::leaf::coverage`),
      `${documentId}: the coverage leaf's stub row names a different owner now`);
    assert.equal(canonicalJson(bindings.planCatalog.units.find((unit) => unit.unitId === `${documentId}::leaf::work-item-dimension`)!),
      canonicalJson(fix.base.planCatalog.units.find((unit) => unit.unitId === `${documentId}::leaf::work-item-dimension`)!),
      `${documentId}: and its own plan row did not change at all`);
  }
  // The two perturbation shapes are not interchangeable: the second moves strictly more, and the difference is the
  // OWNERSHIP environment. A suite that only tested the first would assert the epic's literal and miss this.
  assert.ok(movedByBindings.length > movedUnder(content).length + 2, `${movedByBindings.length} vs ${movedUnder(content).length}`);
  assert.deepEqual(unitIds(fix.base).filter((unitId) => !movedByBindings.includes(unitId)), [
    "feature-leave-product::appendix::coverage",
    "feature-leave-product::synthesis::document",
    "overview-engineering::appendix::coverage",
    "overview-engineering::synthesis::document",
    "overview-product::appendix::coverage",
    "overview-product::synthesis::document"
  ], "only the appendices — and the SYNTHESIS units, whose identity is their children's verified summaries and therefore does not move at all");
  // THAT is why the child rule is load-bearing rather than decorative: under both perturbations every synthesis's
  // own identity is byte-identical to its candidate's, because the summaries it would be written from are the ones
  // the candidate holds. Comparing digests alone would reuse a parent whose children were all rewritten.
  for (const state of [content, bindings]) {
    for (const unitId of unitIds(fix.base).filter((row) => row.endsWith("::synthesis::document"))) {
      assert.equal(identityOf(fix, state, unitId).digest, identityOf(fix, fix.base, unitId).digest,
        `${state.label}: ${unitId} — a synthesis identity computed from stale verified summaries is EQUAL, which is what \`tests/unit-cache-plan.test.ts\` refuses to reuse`);
    }
  }
  // Both perturbations keep the coverage and dimension topics themselves untouched, which is what makes the
  // difference above attributable to ownership rather than to a second content change.
  for (const state of [content, bindings]) {
    for (const topicId of [DIMENSION_TOPIC, COVERAGE_TOPIC]) {
      assert.equal(topicOf(state.catalog, topicId).digest, topicOf(fix.base.catalog, topicId).digest, `${state.label}: ${topicId} is untouched`);
    }
  }
});

test("the section split covers the whole view: a changed digest always has a changed section", async () => {
  const fix = await fixture();
  const content = stateOverCatalog(fix.run, "content", withTopicTitle(fix.base.catalog, FEATURE_TOPIC, "Leave approval (perturbed title)"), fix.run.requests);
  for (const unitId of unitIds(fix.base)) {
    const before = identityOf(fix, fix.base, unitId);
    const after = identityOf(fix, content, unitId);
    const differences = identitySectionDifferences(before, after);
    assert.equal(differences.length > 0, before.digest !== after.digest,
      `${unitId}: a digest that moved with no section naming it would be an unexplainable rebuild`);
  }
  // And the split itself is a partition of the view's lines: every `## ` line is a heading, nothing else is.
  const view = unitIdentityView(identityInput(fix, fix.base, `${OVERVIEW_PRODUCT}::appendix::coverage`));
  const sections = unitIdentitySections(view);
  assert.deepEqual(sections.slice(1).map((section) => section.heading), view.split("\n").filter((line) => line.startsWith("## ")));
  // Every heading line, plus the newline on each side of it, is what the split takes out of the stream.
  assert.equal(sections.reduce((total, section) => total + section.bytes, 0) + sections.slice(1).reduce((total, section) => total + Buffer.byteLength(section.heading, "utf8") + 2, 0),
    Buffer.byteLength(view, "utf8"), "the sections plus their heading lines are the whole view, with nothing between them");
});
