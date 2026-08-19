import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "../src/base/util.ts";
import { buildTopicCatalog, type TopicCatalogArtifact } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import {
  readTopicCatalog,
  topicCatalogDigest,
  topicCatalogProblems,
  topicsPath,
  writeTopicCatalog
} from "../src/report/topics-artifact.ts";
import { copyFixture } from "./helpers.ts";

// `plan/topics.json` is meant to be a PREMISE for the slices after this one, not a hint. Two things make it one:
// the write is once-per-epoch with a read-back, and the read re-derives every topic's id, materiality, confidence
// and digest from the row's own content — so a hand-edited catalog is a named failure rather than a plan nobody
// re-checked. This file tests exactly those two.

const FIXTURE = "topic-catalog-mini";

async function fixtureCatalog(): Promise<{ runDir: string; catalog: TopicCatalogArtifact }> {
  const runDir = await copyFixture(FIXTURE);
  return { runDir, catalog: buildTopicCatalog(await loadTopicCatalogSource(runDir)) };
}

/** Round-trip a catalog through the canonical bytes, then mutate it the way a hand edit would. */
function edited(catalog: TopicCatalogArtifact, mutate: (value: Record<string, unknown>) => void): unknown {
  const value = JSON.parse(stableJson(catalog)) as Record<string, unknown>;
  mutate(value);
  return value;
}

test("the catalog lands at plan/topics.json, next to the request record", async () => {
  assert.equal(topicsPath("/runs/r1"), join("/runs/r1", "plan", "topics.json"));
  const { runDir, catalog } = await fixtureCatalog();
  await writeTopicCatalog(runDir, catalog);
  const bytes = await readFile(topicsPath(runDir), "utf8");
  assert.equal(bytes, `${stableJson(catalog)}\n`);
});

test("writing the same catalog twice is a no-op; writing a different one for the same run is refused", async () => {
  const { runDir, catalog } = await fixtureCatalog();
  await writeTopicCatalog(runDir, catalog);
  const before = await readFile(topicsPath(runDir), "utf8");
  await writeTopicCatalog(runDir, catalog);
  assert.equal(await readFile(topicsPath(runDir), "utf8"), before);

  const drifted: TopicCatalogArtifact = { ...catalog, topics: catalog.topics.slice(1) };
  await assert.rejects(
    async () => writeTopicCatalog(runDir, drifted),
    /already records a different Topic Catalog .*the catalog is written once per epoch/
  );
  assert.equal(await readFile(topicsPath(runDir), "utf8"), before, "the refusal leaves the recorded bytes alone");
});

test("the catalog digest is a function of the whole artifact and is not a field inside it", async () => {
  const { catalog } = await fixtureCatalog();
  assert.equal(topicCatalogDigest(catalog), topicCatalogDigest(catalog));
  assert.ok(!Object.keys(catalog).includes("catalogDigest"));
  assert.notEqual(topicCatalogDigest(catalog), topicCatalogDigest({ ...catalog, snapshotId: "other" }));
});

test("a valid catalog round-trips through the reader", async () => {
  const { runDir, catalog } = await fixtureCatalog();
  await writeTopicCatalog(runDir, catalog);
  const recorded = await readTopicCatalog(runDir);
  assert.equal(stableJson(recorded), stableJson(catalog));
  assert.deepEqual(topicCatalogProblems(JSON.parse(stableJson(catalog))), []);
});

test("the reader re-derives identity: an edited title, id, materiality or confidence fails by name", async () => {
  const { catalog } = await fixtureCatalog();
  const material = catalog.topics.findIndex((topic) => topic.materiality === "material");
  assert.ok(material >= 0);

  const retitled = edited(catalog, (value) => {
    ((value.topics as Array<Record<string, unknown>>)[material]!).title = "a title someone liked better";
  });
  const retitledProblems = topicCatalogProblems(retitled);
  assert.equal(retitledProblems.length, 1);
  assert.match(retitledProblems[0]!, new RegExp(`^topics\\[${material}\\] digest ".*" is not the digest of its own content`));

  const reKeyed = edited(catalog, (value) => {
    ((value.topics as Array<Record<string, unknown>>)[material]!).canonicalKey = "route/forged";
  });
  assert.ok(topicCatalogProblems(reKeyed).some((problem) => /topicId .* is not the id its canonical key derives/.test(problem)));

  const flipped = edited(catalog, (value) => {
    ((value.topics as Array<Record<string, unknown>>)[material]!).materiality = "unobligated";
  });
  assert.ok(topicCatalogProblems(flipped).some((problem) => /materiality "unobligated" is not the material its bindings derive/.test(problem)));

  const overstated = edited(catalog, (value) => {
    const topic = (value.topics as Array<Record<string, unknown>>).find((row) => row.confidence === "unsettled")!;
    topic.confidence = "grounded";
  });
  assert.ok(topicCatalogProblems(overstated).some((problem) => /confidence "grounded" is not the unsettled its bindings derive/.test(problem)));
});

test("a dropped evidence id inside one binding is caught — the 57B-453 edit the digest exists for", async () => {
  const { catalog } = await fixtureCatalog();
  const index = catalog.topics.findIndex((topic) => topic.bindings.some((row) => row.evidenceIds.length > 1));
  assert.ok(index >= 0, "the fixture has a work item with more than one evidence id");
  const thinned = edited(catalog, (value) => {
    const topic = (value.topics as Array<Record<string, unknown>>)[index]!;
    const bindings = topic.bindings as Array<{ evidenceIds: string[] }>;
    const row = bindings.find((binding) => binding.evidenceIds.length > 1)!;
    row.evidenceIds = row.evidenceIds.slice(1);
  });
  assert.ok(topicCatalogProblems(thinned).some((problem) => /digest .* is not the digest of its own content/.test(problem)));
});

test("a malformed binding is a named problem, not a crash inside the derivation", async () => {
  const { catalog } = await fixtureCatalog();
  const index = catalog.topics.findIndex((topic) => topic.bindings.length > 0);
  const cases: Array<[string, (bindings: Array<Record<string, unknown>>) => void, RegExp]> = [
    ["not an object", (bindings) => { bindings[0] = "wi-1" as unknown as Record<string, unknown>; }, /bindings\[0\] is not a binding object/],
    ["unknown status", (bindings) => { bindings[0]!.status = "settled"; }, /bindings\[0\] status "settled" is not one of: cannot-determine, found, in_progress, not-applicable, pending, searched-not-found/],
    ["missing field", (bindings) => { delete bindings[0]!.material; }, /bindings\[0\] is missing field "material"/],
    ["extra field", (bindings) => { bindings[0]!.excerpt = "func approve()"; }, /bindings\[0\] has unknown field "excerpt"/],
    ["non-id evidence", (bindings) => { bindings[0]!.evidenceIds = [""]; }, /bindings\[0\] evidenceIds \[""\] is not an array of non-empty ids/]
  ];
  for (const [name, mutate, expected] of cases) {
    const broken = edited(catalog, (value) => {
      mutate((value.topics as Array<Record<string, unknown>>)[index]!.bindings as Array<Record<string, unknown>>);
    });
    const problems = topicCatalogProblems(broken);
    assert.ok(problems.some((problem) => expected.test(problem)), `${name}: ${problems.join("; ")}`);
  }
});

test("the facet census must cover every facet, in order, and an empty facet must carry a reason", async () => {
  const { catalog } = await fixtureCatalog();
  const dropped = edited(catalog, (value) => { value.facets = (value.facets as unknown[]).slice(1); });
  assert.ok(topicCatalogProblems(dropped).some((problem) => /facets\[0\] is "entity", not "coverage"/.test(problem)));

  const mute = edited(catalog, (value) => {
    const entity = (value.facets as Array<{ facet: string; outcome: Record<string, unknown> }>).find((row) => row.facet === "entity")!;
    entity.outcome = { state: "ledger-absent", reason: "" };
  });
  assert.ok(topicCatalogProblems(mute).some((problem) => /carries no reason; an empty facet must say which ledger was not there/.test(problem)));

  const fourthState = edited(catalog, (value) => {
    const entity = (value.facets as Array<{ facet: string; outcome: Record<string, unknown> }>).find((row) => row.facet === "entity")!;
    entity.outcome = { state: "absent" };
  });
  assert.ok(topicCatalogProblems(fourthState).some((problem) => /outcome state "absent" is not populated, ledger-absent or ledger-empty/.test(problem)));
});

test("the conservation law is re-checked on read, not trusted", async () => {
  const { catalog } = await fixtureCatalog();
  const miscounted = edited(catalog, (value) => {
    (value.obligationAccounting as Record<string, unknown>).unassigned = 3;
  });
  assert.ok(topicCatalogProblems(miscounted).some((problem) => /does not conserve: 6 assigned \+ 3 unassigned is not 6 total/.test(problem)));

  const lyingList = edited(catalog, (value) => {
    const accounting = value.obligationAccounting as Record<string, unknown>;
    accounting.assigned = 5;
    accounting.unassigned = 1;
    accounting.unassignedWorkItemIds = ["project:open-investigation"];
  });
  assert.ok(topicCatalogProblems(lyingList).some((problem) => /counts 5 assigned work items but the topics bind 6/.test(problem)));
});

test("an unknown field, a missing field and a wrong version are each named", async () => {
  const { catalog } = await fixtureCatalog();
  assert.ok(topicCatalogProblems(edited(catalog, (value) => { value.coverageRatio = 0.9; }))
    .some((problem) => /has unknown field "coverageRatio"/.test(problem)));
  assert.ok(topicCatalogProblems(edited(catalog, (value) => { delete value.knowledgeDigest; }))
    .some((problem) => /is missing field "knowledgeDigest"/.test(problem)));
  assert.ok(topicCatalogProblems(edited(catalog, (value) => { value.version = "topic-catalog-v2"; }))
    .some((problem) => /version "topic-catalog-v2" is not topic-catalog-v1/.test(problem)));
  assert.deepEqual(topicCatalogProblems("not an object"), ["is not a catalog object"]);
});

test("topics must be strictly ascending by id, so two catalogs of one epoch cannot differ by order", async () => {
  const { catalog } = await fixtureCatalog();
  const shuffled = edited(catalog, (value) => {
    const topics = value.topics as unknown[];
    value.topics = [topics[1], topics[0], ...topics.slice(2)];
  });
  assert.ok(topicCatalogProblems(shuffled).some((problem) => /does not follow .*must be strictly ascending by topic id/.test(problem)));
});

test("an unreadable or invalid file on disk is a named failure from the reader", async () => {
  const { runDir, catalog } = await fixtureCatalog();
  await writeTopicCatalog(runDir, catalog);
  await writeFile(topicsPath(runDir), "{ not json");
  await assert.rejects(async () => readTopicCatalog(runDir), /could not be read as JSON/);
  await writeFile(topicsPath(runDir), `${stableJson({ version: "topic-catalog-v1" })}\n`);
  await assert.rejects(async () => readTopicCatalog(runDir), /is not a valid Topic Catalog: .*is missing field/);
});
