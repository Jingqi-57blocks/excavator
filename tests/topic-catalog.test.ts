import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "../src/base/util.ts";
import { buildTopicCatalog, TOPIC_CATALOG_VERSION, materialTopics } from "../src/report/topic-catalog.ts";
import {
  FORBIDDEN_INPUT_PREFIXES,
  loadTopicCatalogSource,
  PROJECTED_PRODUCERS
} from "../src/report/topic-catalog-source.ts";
import { TOPIC_FACETS } from "../src/report/topic-candidate.ts";
import { copyFixture, manifestOf } from "./helpers.ts";

// The Topic Catalog over `tests/fixtures/topic-catalog-mini`, a six-work-item run built so every load-bearing
// number below can be derived BY HAND from the fixture rather than read back off the generator:
//
//   * 6 work items: two `decision-function` (material, found) that are the SAME function name in two different
//     files, one `api-entrypoints` (non-material) reached through the ledger's hash-only feature scope, one
//     project-scoped `open-investigation` at `cannot-determine`, one `logic-disposition` at `searched-not-found`,
//     and one project-scoped `literal-secrets` (found, non-material) that NO facet but its dimension family
//     claims — so dropping that projection breaks the conservation law, not merely a count.
//   * 2 bound features, 1 cross-feature relationship, 2 resolved cross-repo links over 2 module pairs, plus one
//     unresolved and one ambiguous outbound call.
//   * 3 route facts (2 indexed with the same route name at two paths, 1 recovered) and 2 facts of kinds no facet
//     claims. `db-schema` is `unavailable`, exactly as every real run records it.
//   * 4 read obligations, whose residual is 2 covered / 1 not-opened / 1 partial — and the partial one names no
//     work item, so a residual topic with rows and no bindings is in the fixture on purpose.
//   * `sections/`, `claims/`, `context/authoring/`, `reports/` and `prompts/` each hold a sentinel string, and so
//     do a work item's hypothesis and an evidence excerpt. None may reach the catalog.

const FIXTURE = "topic-catalog-mini";
const LEAVE = "leave-1a2b3c4d5e";
const PROMO = "promo-9f8e7d6c5b";

const SENTINELS = ["SECTIONS", "CLAIMS", "AUTHORING", "REPORTS", "PROMPTS", "HYPOTHESIS", "EVIDENCE"]
  .map((where) => `EXCAVATOR-TOPIC-SENTINEL-${where}`);

async function fixtureCatalog() {
  const runDir = await copyFixture(FIXTURE);
  const source = await loadTopicCatalogSource(runDir, await manifestOf(runDir));
  return { runDir, source, catalog: buildTopicCatalog(source) };
}

async function editJson(runDir: string, relative: string, mutate: (value: Record<string, unknown>) => void): Promise<void> {
  const path = join(runDir, relative);
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeFile(path, `${stableJson(value)}\n`);
}

test("the catalog reads the knowledge side only — every authoring-side directory stays unopened", async () => {
  const { source } = await fixtureCatalog();
  assert.deepEqual([...source.readPaths], [
    "context/boundary-functions.json",
    "context/cross-feature.json",
    "context/crossrepo-links.json",
    "contract/run-intent.json",
    "coverage/read-obligations.json",
    "coverage/read-residual.json",
    "facts/producers/codegraph.json",
    "facts/producers/crossrepo.json",
    "facts/producers/db-schema.json",
    "knowledge.json",
    "workitems.json"
  ]);
  for (const path of source.readPaths) {
    for (const prefix of FORBIDDEN_INPUT_PREFIXES) {
      assert.ok(!path.startsWith(prefix), `${path} is under the forbidden prefix ${prefix}`);
    }
  }
  // Exactly one envelope per projected producer, so adding a producer to the projection without a facet for its
  // facts is visible here too.
  assert.equal(source.producers.size, PROJECTED_PRODUCERS.length);
});

test("no sentinel byte from prose, an excerpt or a draft survives into the catalog", async () => {
  const { catalog } = await fixtureCatalog();
  const bytes = stableJson(catalog);
  for (const sentinel of SENTINELS) assert.ok(!bytes.includes(sentinel), `${sentinel} reached the catalog`);
  // Work-item prose is read and deliberately dropped: the binding carries ids, a dimension and a status.
  assert.ok(!bytes.includes("hypothesis"));
  assert.ok(!bytes.includes("searchScope"));
});

test("every facet has a census row, populated or named-empty, in the declared order", async () => {
  const { catalog } = await fixtureCatalog();
  assert.equal(catalog.version, TOPIC_CATALOG_VERSION);
  assert.deepEqual(catalog.facets.map((row) => row.facet), [...TOPIC_FACETS]);
  assert.deepEqual(catalog.facets.map((row) => [row.facet, row.outcome.state]), [
    ["coverage", "populated"],
    ["entity", "ledger-absent"],
    ["external-system", "populated"],
    ["feature", "populated"],
    ["route", "populated"],
    ["work-item-dimension", "populated"]
  ]);
  const entity = catalog.facets.find((row) => row.facet === "entity")!.outcome;
  assert.equal(entity.state, "ledger-absent");
  assert.match(
    entity.state === "ledger-absent" ? entity.reason : "",
    /facts\/producers\/db-schema\.json records status unavailable: policy: not-run-scoped/,
    "an absent facet quotes the producer's own cause instead of reporting zero rows"
  );
});

test("the per-facet topic counts and the three materiality buckets are the fixture's own numbers", async () => {
  const { catalog } = await fixtureCatalog();
  assert.deepEqual(catalog.facets.map((row) => [row.facet, row.outcome.state === "populated" ? row.outcome.topics : 0, row.materiality]), [
    // 3 residual statuses + 2 non-found determinations + 3 boundary blind files + 2 unresolved cross-repo calls
    ["coverage", 10, { material: 3, obligatedNonMaterial: 1, unobligated: 6 }],
    ["entity", 0, { material: 0, obligatedNonMaterial: 0, unobligated: 0 }],
    ["external-system", 2, { material: 0, obligatedNonMaterial: 0, unobligated: 2 }],
    ["feature", 2, { material: 2, obligatedNonMaterial: 0, unobligated: 0 }],
    ["route", 3, { material: 0, obligatedNonMaterial: 0, unobligated: 3 }],
    ["work-item-dimension", 5, { material: 2, obligatedNonMaterial: 3, unobligated: 0 }]
  ]);
  assert.equal(catalog.topics.length, 22);
  assert.deepEqual(catalog.materiality, { material: 7, obligatedNonMaterial: 4, unobligated: 11 });
  assert.equal(materialTopics(catalog).length, 7);
  // Every fact is either a topic or counted as unmapped; there is no third place for one to go.
  assert.deepEqual(catalog.factRouting, {
    mapped: 3,
    unmapped: [
      { producer: "codegraph", kind: "indexed-function", facts: 1 },
      { producer: "crossrepo", kind: "http-link", facts: 1 }
    ]
  });
});

test("obligation attribution conserves: every work item is bound by a topic or named unassigned", async () => {
  const { catalog } = await fixtureCatalog();
  assert.deepEqual(catalog.obligationAccounting, { total: 6, assigned: 6, unassigned: 0, unassignedWorkItemIds: [] });
  // The dimension family is the only claim on `project:literal-secrets`, which is what makes this law load-bearing.
  const dimensionOnly = catalog.topics.filter((topic) => topic.bindings.some((row) => row.workItemId === "project:literal-secrets"));
  assert.deepEqual(dimensionOnly.map((topic) => topic.canonicalKey), ["work-item-dimension/project/literal-secrets"]);
  const bound = new Set(catalog.topics.flatMap((topic) => topic.bindings.map((row) => row.workItemId)));
  assert.equal(bound.size, catalog.obligationAccounting.assigned);
  assert.equal(catalog.obligationAccounting.assigned + catalog.obligationAccounting.unassigned, catalog.obligationAccounting.total);
});

test("a material work item's evidence ids are answerable from the catalog alone, byte for byte", async () => {
  const { runDir, catalog } = await fixtureCatalog();
  const workItemId = `feature:${LEAVE}:logic:approve@svc/leave/approve.go:10`;
  const ledger = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as { items: Array<{ id: string; evidenceIds: string[]; traceIds: string[] }> };
  const recorded = ledger.items.find((item) => item.id === workItemId)!;
  const bindings = catalog.topics.flatMap((topic) => topic.bindings.filter((row) => row.workItemId === workItemId));
  assert.ok(bindings.length >= 2, "this obligation belongs to more than one topic, which is allowed and intended");
  for (const binding of bindings) {
    assert.deepEqual(binding.evidenceIds, recorded.evidenceIds);
    assert.deepEqual(binding.traceIds, recorded.traceIds);
  }
  // The ids stay attached to the obligation: no topic carries a flattened bag of every id it touched.
  const flattened = catalog.topics.map((topic) => Object.keys(topic));
  for (const keys of flattened) assert.ok(!keys.includes("evidenceIds"), "a topic-level id bag is exactly what 57B-453 cost");
});

test("the same route name at two paths mints two topics; the fixture's collapse guard holds", async () => {
  const { catalog } = await fixtureCatalog();
  const named = catalog.topics.filter((topic) => topic.facet === "route" && topic.title === "GET /leaves");
  assert.equal(named.length, 2, "the two indexed routes carry the same route name at two different paths");
  assert.equal(new Set(named.map((topic) => topic.topicId)).size, 2);
  assert.deepEqual(named.map((topic) => topic.canonicalKey).sort(), [
    "route/codegraph/route:svc-v2/internal/handlers/legacy/router.go:12-12:GET /leaves",
    "route/codegraph/route:svc/routes/leave.js:12-12:GET /leaves"
  ]);
  // Three route topics in all: the recovered route describes the same URL again, from another producer's ledger,
  // and is deliberately NOT merged with the indexed one — merging would be a graph computation, not a de-dup.
  assert.equal(catalog.topics.filter((topic) => topic.facet === "route").length, 3);
  assert.deepEqual(
    catalog.topics.filter((topic) => topic.facet === "route").map((topic) => topic.kind).sort(),
    ["indexed-route", "indexed-route", "recovered-route"]
  );
});

test("an unknown-marked topic is visible, and a determined one is not marked", async () => {
  const { catalog } = await fixtureCatalog();
  const notOpened = catalog.topics.find((topic) => topic.canonicalKey === "coverage/read-residual/not-opened")!;
  assert.equal(notOpened.unknown, true);
  assert.equal(notOpened.materiality, "material", "an unread material obligation is a material topic that is also unknown");
  const covered = catalog.topics.find((topic) => topic.canonicalKey === "coverage/read-residual/covered")!;
  assert.equal(covered.unknown, false);
  assert.equal(covered.completeness.residualRows, 2);
  const partial = catalog.topics.find((topic) => topic.canonicalKey === "coverage/read-residual/partial")!;
  assert.equal(partial.materiality, "unobligated");
  assert.equal(partial.completeness.residualRows, 1, "a residual row that names no work item still shows in the denominator");
  assert.equal(partial.completeness.boundWorkItems, 0);
  // Nine: two residual statuses that are not `covered`, the `cannot-determine` determination, the three boundary
  // blind files, the two unresolved cross-repo calls, and the project-scoped `open-investigation` family whose
  // one obligation is undetermined.
  assert.deepEqual(catalog.topics.filter((topic) => topic.unknown).map((topic) => topic.canonicalKey).sort(), [
    "coverage/boundary-scan/files-without-candidates/svc/a/dup.go",
    "coverage/boundary-scan/files-without-candidates/svc/b/dup.go",
    "coverage/boundary-scan/files-without-candidates/svc/leave/util.go",
    "coverage/crossrepo-call/ambiguous/ui/ui/src/api/shared.ts:9:GET",
    "coverage/crossrepo-call/unresolved/ui/ui/src/api/legacy.ts:3:DELETE",
    "coverage/determination/cannot-determine",
    "coverage/read-residual/not-opened",
    "coverage/read-residual/partial",
    "work-item-dimension/project/open-investigation"
  ]);
  // A `searched-not-found` determination is NOT an unknown: the run looked and wrote down what it found.
  const searched = catalog.topics.find((topic) => topic.canonicalKey === "coverage/determination/searched-not-found")!;
  assert.equal(searched.unknown, false);
  assert.equal(searched.confidence, "qualified");
});

test("both spellings of a feature scope attribute to the bound key, and an unbound one is refused", async () => {
  const { catalog } = await fixtureCatalog();
  const promo = catalog.topics.find((topic) => topic.canonicalKey === `feature/${PROMO}`)!;
  // `feature:9f8e7d6c5b` (hash only) and `feature:promo-9f8e7d6c5b` (full key) are both in the fixture ledger.
  assert.deepEqual(promo.bindings.map((row) => row.workItemId).sort(), [
    "feature:9f8e7d6c5b:api-entrypoints",
    `feature:${PROMO}:logic:rank@svc/promo/rank.go:5`
  ].sort());
  assert.deepEqual(promo.relationIds, [`cross-feature:${LEAVE}|${PROMO}`]);

  const runDir = await copyFixture(FIXTURE);
  await editJson(runDir, "workitems.json", (value) => {
    (value.items as Array<{ scope: string }>)[0]!.scope = "feature:not-a-bound-key";
  });
  await assert.rejects(async () => buildTopicCatalog(await loadTopicCatalogSource(runDir, await manifestOf(runDir))), /names no feature in contract\/run-intent\.json/);
});

test("the projection is deterministic: two builds over one run directory agree byte for byte", async () => {
  const runDir = await copyFixture(FIXTURE);
  const first = buildTopicCatalog(await loadTopicCatalogSource(runDir, await manifestOf(runDir)));
  const second = buildTopicCatalog(await loadTopicCatalogSource(runDir, await manifestOf(runDir)));
  assert.equal(stableJson(first), stableJson(second));
});

test("an unfrozen or unsealed run is refused by name rather than projected", async () => {
  const missing = await copyFixture(FIXTURE);
  await rm(join(missing, "knowledge.json"));
  await assert.rejects(async () => loadTopicCatalogSource(missing, await manifestOf(missing)), /knowledge\.json is missing from .*cannot be projected/);

  const noFreezeTime = await copyFixture(FIXTURE);
  await editJson(noFreezeTime, "knowledge.json", (value) => { value.frozenAt = ""; });
  await assert.rejects(async () => loadTopicCatalogSource(noFreezeTime, await manifestOf(noFreezeTime)), /carries no frozenAt; the run is not frozen/);

  const noEpoch = await copyFixture(FIXTURE);
  await editJson(noEpoch, "knowledge.json", (value) => { delete value.epoch; });
  await assert.rejects(async () => loadTopicCatalogSource(noEpoch, await manifestOf(noEpoch)), /carries no usable epoch number \(undefined\)/);

  // A negative epoch is refused HERE, naming the file, rather than downstream by the path mapping's own generic
  // message: this loader promises that every failure names what was being projected and from where.
  const negativeEpoch = await copyFixture(FIXTURE);
  await editJson(negativeEpoch, "knowledge.json", (value) => { value.epoch = -1; });
  await assert.rejects(async () => loadTopicCatalogSource(negativeEpoch, await manifestOf(negativeEpoch)),
    /knowledge\.json carries no usable epoch number \(-1\); an unsealed record cannot be projected/);

  const wrongVersion = await copyFixture(FIXTURE);
  await editJson(wrongVersion, "knowledge.json", (value) => { value.version = "knowledge-v2"; });
  await assert.rejects(async () => loadTopicCatalogSource(wrongVersion, await manifestOf(wrongVersion)), /is version "knowledge-v2", not knowledge-v1/);
});

test("a ledger the epoch sealed and something later edited fails by name", async () => {
  const editedWorkItems = await copyFixture(FIXTURE);
  await editJson(editedWorkItems, "workitems.json", (value) => {
    (value.items as Array<{ status: string }>)[0]!.status = "cannot-determine";
  });
  await assert.rejects(async () => loadTopicCatalogSource(editedWorkItems, await manifestOf(editedWorkItems)), /workitems\.json does not match the workitemsDigest sealed in knowledge\.json/);

  const editedObligations = await copyFixture(FIXTURE);
  await editJson(editedObligations, "coverage/read-obligations.json", (value) => {
    (value.summary as { lines: number }).lines = 999;
  });
  await assert.rejects(async () => loadTopicCatalogSource(editedObligations, await manifestOf(editedObligations)), /coverage\/read-obligations\.json does not match the digest sealed/);

  const editedBoundary = await copyFixture(FIXTURE);
  await editJson(editedBoundary, "context/boundary-functions.json", (value) => { value.graphAvailable = false; });
  await assert.rejects(async () => loadTopicCatalogSource(editedBoundary, await manifestOf(editedBoundary)), /context\/boundary-functions\.json does not match the digest sealed/);
});

test("a required ledger that is gone is a named failure, never an empty facet", async () => {
  for (const relative of ["coverage/read-obligations.json", "coverage/read-residual.json", "context/boundary-functions.json", "contract/run-intent.json", "workitems.json", "facts/producers/db-schema.json"]) {
    const runDir = await copyFixture(FIXTURE);
    await rm(join(runDir, relative));
    await assert.rejects(
      async () => loadTopicCatalogSource(runDir, await manifestOf(runDir)),
      new RegExp(`${relative.replace(/[/.]/g, "\\$&")} is missing from`),
      `${relative} must fail by name`
    );
  }
});

test("an optional ledger is checked in both directions — a digest with no file, and a file with no digest", async () => {
  const fileGone = await copyFixture(FIXTURE);
  await rm(join(fileGone, "context/cross-feature.json"));
  await assert.rejects(async () => loadTopicCatalogSource(fileGone, await manifestOf(fileGone)), /declares a digest for context\/cross-feature\.json but the file is gone/);

  const digestGone = await copyFixture(FIXTURE);
  await editJson(digestGone, "knowledge.json", (value) => { delete value.crossRepoLinksDigest; });
  await assert.rejects(async () => loadTopicCatalogSource(digestGone, await manifestOf(digestGone)), /context\/crossrepo-links\.json exists but knowledge\.json declares no digest for it/);
});

test("a binding may only name evidence and traces the epoch sealed", async () => {
  const strayEvidence = await copyFixture(FIXTURE);
  await editJson(strayEvidence, "workitems.json", (value) => {
    (value.items as Array<{ evidenceIds: string[] }>)[0]!.evidenceIds.push("S-not-sealed");
  });
  await assert.rejects(async () => loadTopicCatalogSource(strayEvidence, await manifestOf(strayEvidence)), /binds evidence "S-not-sealed", which knowledge\.json did not seal/);

  const strayTrace = await copyFixture(FIXTURE);
  await editJson(strayTrace, "workitems.json", (value) => {
    (value.items as Array<{ traceIds: string[] }>)[0]!.traceIds.push("T-not-sealed");
  });
  await assert.rejects(async () => loadTopicCatalogSource(strayTrace, await manifestOf(strayTrace)), /binds trace "T-not-sealed", which knowledge\.json did not seal/);
});

test("a facet whose ledger is present but holds no row says so differently from one whose ledger is absent", async () => {
  const noFeature = await copyFixture(FIXTURE);
  await editJson(noFeature, "contract/run-intent.json", (value) => { value.features = []; });
  // Every work item must move to the project scope too: a feature-scoped obligation with no bound feature key is
  // the OTHER named failure, and this test is about the empty-ledger reading, not about that one.
  await editJson(noFeature, "workitems.json", (value) => {
    for (const item of value.items as Array<{ scope: string }>) item.scope = "project";
  });
  const catalog = buildTopicCatalog(await loadTopicCatalogSource(noFeature, await manifestOf(noFeature)));
  const feature = catalog.facets.find((row) => row.facet === "feature")!.outcome;
  assert.equal(feature.state, "ledger-empty");
  assert.match(feature.state === "ledger-empty" ? feature.reason : "", /contract\/run-intent\.json binds no feature to this run/);
  const entity = catalog.facets.find((row) => row.facet === "entity")!.outcome;
  assert.equal(entity.state, "ledger-absent");
  assert.notEqual(feature.state, entity.state, "an empty ledger and an absent ledger are two different statements");
});

test("a built producer envelope with facts populates its facet — the arm the schema producer has yet to reach", async () => {
  // No registered fact kind belongs to `db-schema` today, so every real run records the envelope as unavailable.
  // This rewrites it to a BUILT envelope so the mint-from-facts arm of the entity projection is exercised rather
  // than shipped untested; the fact kind is borrowed, and the assertion is about the projection, not the producer.
  const runDir = await copyFixture(FIXTURE);
  const codegraph = JSON.parse(await readFile(join(runDir, "facts/producers/codegraph.json"), "utf8")) as { value: { facts: unknown[]; producer: string } };
  await writeFile(join(runDir, "facts/producers/db-schema.json"), `${stableJson({
    status: "built",
    value: { ...codegraph.value, producer: "db-schema", facts: [codegraph.value.facts[2]] }
  })}\n`);
  const catalog = buildTopicCatalog(await loadTopicCatalogSource(runDir, await manifestOf(runDir)));
  const entity = catalog.facets.find((row) => row.facet === "entity")!;
  assert.deepEqual(entity.outcome, { state: "populated", topics: 1 });
  const topic = catalog.topics.find((row) => row.facet === "entity")!;
  assert.equal(topic.source.ledger, "facts/producers/db-schema.json");
  assert.equal(topic.materiality, "unobligated");
  assert.equal(catalog.factRouting.mapped, 4);
});

test("an empty built envelope is a ledger-empty facet, not an absent one", async () => {
  const runDir = await copyFixture(FIXTURE);
  await writeFile(join(runDir, "facts/producers/db-schema.json"), `${stableJson({
    status: "built",
    value: { version: "producer-envelope-v1", producer: "db-schema", identity: {}, facts: [], membershipUnmapped: [], unmappableFactIds: [], completeness: { total: 0, counted: 0, excluded: 0, unexplained: 0, byKind: {}, detailMaxChars: 200, detailClipped: 0 }, producerCompleteness: {} }
  })}\n`);
  const catalog = buildTopicCatalog(await loadTopicCatalogSource(runDir, await manifestOf(runDir)));
  const entity = catalog.facets.find((row) => row.facet === "entity")!.outcome;
  assert.equal(entity.state, "ledger-empty");
  assert.match(entity.state === "ledger-empty" ? entity.reason : "", /was built and holds no fact/);
});
