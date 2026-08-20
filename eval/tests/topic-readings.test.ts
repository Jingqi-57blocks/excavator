// Topic Catalog byte pin (57B-434 R2).
//
// `eval/golden/topics-mini.json` is the FULL BYTES of the catalog over `tests/fixtures/topic-catalog-mini`. It is
// the baseline nail for "catalog identity does not drift": R3 plans against topic ids and R6 caches against topic
// digests, so a generator change that moves an id or a digest has to be a deliberate, reviewed golden update and
// never a quiet one. A one-byte edit to the fixture moves the golden, and the test below proves it does.
//
// `eval/golden/topic-readings-{wcp,cebreo}.json` are readings of the two R0 baselines, produced by
// `npm run eval -- topic-readings --run <dir> --out <file>` against the archival run directories (which are NOT in
// this repository). They are records, not assertions about a run this suite can re-derive — so what is asserted
// here is their INTERNAL consistency: the facet census covers every facet once, the buckets sum to the topic
// count, the obligation ledger conserves, and cebreo's empty denominators read as `vacuous` rather than as a pass.
// A hand-edited number in either file breaks one of those identities.

import test from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../../tests/temp-dir.ts";
import type { RunManifest } from "../../src/base/types.ts";
import { readJson, stableJson } from "../../src/base/util.ts";
import { buildTopicCatalog } from "../../src/report/topic-catalog.ts";
import { FORBIDDEN_INPUT_PREFIXES, loadTopicCatalogSource } from "../../src/report/topic-catalog-source.ts";
import { topicsPath, writeTopicCatalog } from "../../src/report/topics-artifact.ts";
import { TOPIC_FACETS } from "../../src/report/topic-candidate.ts";
import { extractTopicReadings, TOPIC_READINGS_VERSION, type TopicReadings } from "../topic-readings.ts";

const HERE = import.meta.dirname;
const FIXTURE = join(HERE, "..", "..", "tests", "fixtures", "topic-catalog-mini");
const GOLDEN = join(HERE, "..", "golden", "topics-mini.json");
const READINGS = ["wcp", "cebreo"].map((target) => ({ target, path: join(HERE, "..", "golden", `topic-readings-${target}.json`) }));

/** The fixture's own manifest: the epoch selector every catalog load takes. */
async function fixtureManifest(runDir: string): Promise<RunManifest> {
  return readJson<RunManifest>(join(runDir, "run.json"));
}

async function fixtureCopy(): Promise<string> {
  const runDir = await tempDir("topic-catalog-");
  await cp(FIXTURE, runDir, { recursive: true });
  return runDir;
}

test("the fixture catalog is byte-identical to the checked-in golden, through the artifact writer", async () => {
  const runDir = await fixtureCopy();
  const catalog = buildTopicCatalog(await loadTopicCatalogSource(runDir, await fixtureManifest(runDir)));
  await writeTopicCatalog(runDir, catalog);
  const written = await readFile(topicsPath(runDir), "utf8");
  const golden = await readFile(GOLDEN, "utf8");
  assert.equal(written, golden, "the catalog bytes must equal the checked-in golden");
  assert.equal(Buffer.compare(Buffer.from(written), Buffer.from(golden)), 0);
});

test("a one-byte edit to the fixture moves the catalog off the golden", async () => {
  const runDir = await fixtureCopy();
  const path = join(runDir, "facts", "producers", "codegraph.json");
  const before = await readFile(path, "utf8");
  // One character of a route fact's name. A producer envelope is not covered by any digest the epoch sealed, so
  // the edit reaches the projection instead of being stopped at the loader — which is what makes it the golden's
  // test rather than the loader's.
  const after = before.replace('"name": "GET /leaves"', '"name": "GET /leavez"');
  assert.equal(after.length, before.length, "exactly one byte differs");
  assert.notEqual(after, before, "the edit must actually apply");
  await writeFile(path, after);
  const catalog = buildTopicCatalog(await loadTopicCatalogSource(runDir, await fixtureManifest(runDir)));
  const golden = await readFile(GOLDEN, "utf8");
  assert.notEqual(`${stableJson(catalog)}\n`, golden, "an edited fixture byte must not be invisible to the golden");
});

test("a fact's detail beyond its name is not part of topic identity, and the golden says so", async () => {
  // Stated as a test rather than left implied: a topic is the LEDGER ROW's identity (its factId) plus the name the
  // row carries. A producer that changed a route's registration line would mint a different factId in the same
  // breath — a real change still moves the id — but a detail field edited on its own does not, and a reader of the
  // golden must not think otherwise.
  const runDir = await fixtureCopy();
  const path = join(runDir, "facts", "producers", "codegraph.json");
  const before = await readFile(path, "utf8");
  await writeFile(path, before.replace('"registrationLine": 12', '"registrationLine": 13'));
  const catalog = buildTopicCatalog(await loadTopicCatalogSource(runDir, await fixtureManifest(runDir)));
  assert.equal(`${stableJson(catalog)}\n`, await readFile(GOLDEN, "utf8"));
});

test("the readings extractor is deterministic over one run directory", async () => {
  const runDir = await fixtureCopy();
  const first = await extractTopicReadings(runDir);
  const second = await extractTopicReadings(runDir);
  assert.equal(stableJson(first), stableJson(second));
  // And it never writes: the projection of a read-only archival run must leave no trace.
  await assert.rejects(async () => readFile(topicsPath(runDir), "utf8"), /ENOENT/);
});

test("every checked-in baseline reading is internally consistent", async () => {
  for (const { target, path } of READINGS) {
    const readings = JSON.parse(await readFile(path, "utf8")) as TopicReadings;
    assert.equal(readings.version, TOPIC_READINGS_VERSION, `${target}: version`);
    assert.deepEqual(readings.facets.map((row) => row.facet), [...TOPIC_FACETS], `${target}: one census row per facet, in order`);
    const summed = readings.facets.reduce((total, row) => total + row.material + row.obligatedNonMaterial + row.unobligated, 0);
    assert.equal(summed, readings.topics, `${target}: the three buckets must sum to the topic count`);
    assert.equal(
      readings.materiality.material + readings.materiality.obligatedNonMaterial + readings.materiality.unobligated,
      readings.topics,
      `${target}: the catalog-wide buckets must sum to the topic count`
    );
    assert.equal(
      readings.obligationAccounting.assigned + readings.obligationAccounting.unassigned,
      readings.obligationAccounting.total,
      `${target}: obligation attribution must conserve`
    );
    assert.equal(readings.obligationAccounting.unassignedWorkItemIds.length, readings.obligationAccounting.unassigned, `${target}: the unassigned list must match its count`);
    assert.equal(readings.distinctBoundWorkItems, readings.obligationAccounting.assigned, `${target}: bound work items are the assigned ones`);
    assert.ok(readings.bindings >= readings.distinctBoundWorkItems, `${target}: a work item may bind to more than one topic`);
    const confidences = Object.values(readings.confidence).reduce((total, count) => total + count, 0);
    assert.equal(confidences, readings.topics, `${target}: every topic has exactly one confidence`);
    for (const row of readings.facets) {
      if (row.state === "populated") assert.equal(row.reason, "", `${target}: a populated facet carries no reason`);
      else assert.ok(row.reason.trim() !== "", `${target}: the ${row.facet} facet is ${row.state} and must say why`);
    }
    assert.deepEqual(
      readings.namedEmptyFacets.map((row) => row.facet),
      readings.facets.filter((row) => row.state !== "populated").map((row) => row.facet),
      `${target}: the named-empty list is the non-populated census rows`
    );
    for (const readPath of readings.readPaths) {
      for (const prefix of FORBIDDEN_INPUT_PREFIXES) {
        assert.ok(!readPath.startsWith(prefix), `${target}: ${readPath} is an authoring-side input`);
      }
    }
  }
});

test("the wcp baseline reading records the 917-obligation ledger and its attribution", async () => {
  const readings = JSON.parse(await readFile(READINGS[0]!.path, "utf8")) as TopicReadings;
  assert.equal(readings.obligationAccounting.total, 917);
  assert.equal(readings.obligationAccounting.assigned, 917);
  assert.equal(readings.obligationAccounting.unassigned, 0);
  assert.equal(readings.bindings, 1988, "every obligation is bound at its own granularity, some of them twice");
  assert.equal(readings.topics, 1570);
  assert.deepEqual(readings.materiality, { material: 7, obligatedNonMaterial: 71, unobligated: 1492 });
  // The route facet's 1,434 unobligated topics are a reading of how far the obligation ledger does NOT reach.
  assert.equal(readings.facets.find((row) => row.facet === "route")!.unobligated, 1434);
  assert.match(readings.overallVerdictWithNoDispositions, /^violations: 7 problem\(s\) over 7 material topic\(s\), 0 dispositioned$/);
});

test("the cebreo baseline reading is vacuous, and vacuous does not read like a pass", async () => {
  const readings = JSON.parse(await readFile(READINGS[1]!.path, "utf8")) as TopicReadings;
  // 57B-449's reverse test: an overview-only run whose material-topic denominator is empty.
  assert.equal(readings.materiality.material, 0);
  assert.match(readings.overallVerdictWithNoDispositions, /^vacuous: the material-topic denominator is empty, so nothing was checked — /);
  assert.ok(!readings.overallVerdictWithNoDispositions.startsWith("complete"));
  for (const row of readings.facets) {
    assert.match(row.verdictWithNoDispositions, /^vacuous: /, `${row.facet} must be vacuous, never complete`);
  }
  const feature = readings.facets.find((row) => row.facet === "feature")!;
  assert.equal(feature.state, "ledger-empty");
  assert.match(feature.reason, /contract\/run-intent\.json binds no feature to this run/);
  // C#/Kotlin corpus with no CodeGraph: the route facet's absence is named, not silent.
  const route = readings.facets.find((row) => row.facet === "route")!;
  assert.equal(route.state, "ledger-absent");
  assert.match(route.reason, /facts\/producers\/codegraph\.json records status unavailable: index-not-present/);
  // Gate 10's path: the unknown/coverage facet is non-empty even on the run with no obligations at all.
  const coverage = readings.facets.find((row) => row.facet === "coverage")!;
  assert.equal(coverage.state, "populated");
  assert.ok(coverage.topics > 0);
  assert.ok(readings.unknownTopics > 0);
});
