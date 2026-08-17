import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { buildOverviewCensus, overviewCensusResidual, untouchedExtensions, OVERVIEW_CENSUS_VERSION } from "../src/context/overview-census.ts";
import type { OverviewCensus } from "../src/context/overview-census.ts";
import type { ReportRequest } from "../src/base/types.ts";
import { prepareRun } from "../src/run/run.ts";
import { exists, stableJson } from "../src/base/util.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

// THE PROPERTY THIS ARTIFACT EXISTS FOR, ONE LAYER UP FROM `scope-census.test.ts`: the denominator is the
// SNAPSHOT, not the graph census.
//
// Measured on a real Perl target: CodeGraph held 12,399 nodes across javascript/python/xml and ZERO in Perl,
// while the snapshot had scanned 1,422 Perl files. A row set taken from `GraphSummary.roots` — which is the
// correct source for a feature, whose scope is built by searching the graph — would not have given those
// files a zero row. It would not have given them a row at all. Every test here attacks the row set.

const SNAPSHOT = [
  "lib/ZMS/Shop.pm",
  "lib/ZMS/Cart.pm",
  "lib/ZMS/Order.pm",
  "js/app.js",
  "js/cart.js",
  "index.js",
];
const INDEXED = new Set(["js/app.js", "js/cart.js", "index.js"]);

const census = (overrides: Partial<Parameters<typeof buildOverviewCensus>[0]> = {}) =>
  buildOverviewCensus({ sourcePaths: SNAPSHOT, indexedPaths: INDEXED, namedPaths: [], readPaths: [], ...overrides });

test("a module the index does not cover is still a row, with its snapshot count intact", () => {
  const table = census({ namedPaths: ["js/app.js"], readPaths: ["js/app.js"] });

  const perl = table.rows.find((row) => row.module === "lib");
  assert.ok(perl, "the row set comes from the snapshot, so a language CodeGraph cannot index cannot vanish");
  assert.equal(perl.snapshotFiles, 3, "and it carries what the snapshot scanned — that is the zero baseline");
  assert.equal(perl.indexedFiles, 0);
  assert.equal(perl.namedFiles, 0);
  assert.equal(perl.readFiles, 0);
  assert.deepEqual(perl.status, { kind: "zero-hit" }, "nobody explained the absence, so it is the alarm state");
});

// This test fails if anyone ever "simplifies" the row set to the modules the graph knows.
test("the row count is the snapshot's, not the index's", () => {
  const table = census({ indexedPaths: new Set(["js/app.js"]) });
  assert.equal(table.summary.censusModules, 3, "lib, js and the top level — regardless of what was indexed");
  assert.equal(table.summary.snapshotFiles, 6);
  assert.equal(table.summary.indexedFiles, 1);
  assert.equal(table.summary.unindexedFiles, 5);
});

// Named and read are different strengths of evidence. One column holding their sum would let a name-level
// mention in the representative-node evidence be reported as if the code had been opened.
test("a module named but never opened is counted, and says so in two separate columns", () => {
  const table = census({ namedPaths: ["lib/ZMS/Shop.pm"] });
  const perl = table.rows.find((row) => row.module === "lib");
  assert.deepEqual(perl?.status, { kind: "counted" });
  assert.equal(perl?.namedFiles, 1);
  assert.equal(perl?.readFiles, 0, "named is not read");
  assert.equal(table.summary.readFiles, 0);
});

test("a module opened but never named is counted too", () => {
  const table = census({ readPaths: ["lib/ZMS/Cart.pm"] });
  const perl = table.rows.find((row) => row.module === "lib");
  assert.deepEqual(perl?.status, { kind: "counted" });
  assert.equal(perl?.namedFiles, 0);
  assert.equal(perl?.readFiles, 1);
});

test("an exemption must name its rule, and moves the module out of the alarm state", () => {
  const table = census({ readPaths: ["js/app.js"], exemptions: { lib: "vendored-third-party" } });
  const perl = table.rows.find((row) => row.module === "lib");
  assert.deepEqual(perl?.status, { kind: "excluded-by-rule", rule: "vendored-third-party" });
  assert.equal(table.summary.zeroHitModules, 1, "the top level is still unexplained");
  assert.equal(table.summary.excludedModules, 1);
});

test("the residual identity balances, and lists exactly the unexplained modules", () => {
  const table = census({ readPaths: ["js/app.js"] });
  const residual = overviewCensusResidual(table);
  assert.equal(residual.balanced, true);
  assert.deepEqual(residual.unexplained, [".", "lib"], "the top-level file and the whole Perl tree");
  assert.equal(table.summary.zeroHitModules, residual.unexplained.length);
});

test("rows are sorted and the table is byte-stable under input reordering", () => {
  const forward = census({ namedPaths: ["js/app.js", "lib/ZMS/Shop.pm"], readPaths: ["js/cart.js"] });
  const shuffled = buildOverviewCensus({
    sourcePaths: [...SNAPSHOT].reverse(),
    indexedPaths: INDEXED,
    namedPaths: ["lib/ZMS/Shop.pm", "js/app.js"],
    readPaths: ["js/cart.js"],
  });
  assert.deepEqual(forward.rows.map((row) => row.module), [".", "js", "lib"], "sorted, so the artifact is diffable");
  assert.equal(stableJson(forward), stableJson(shuffled), "same inputs in any order must produce the same bytes");
  assert.equal(forward.version, OVERVIEW_CENSUS_VERSION);
});

// The key-domain lesson from the feature census: the SQL root convention reports a top-level file under `.`,
// and returning the filename instead would split one module across two rows.
test("a top-level source file belongs to module \".\", never to itself", () => {
  const table = census({ readPaths: ["index.js"] });
  const top = table.rows.find((row) => row.module === ".");
  assert.ok(top, "a top-level file must not become its own module");
  assert.equal(top.snapshotFiles, 1);
  assert.equal(top.readFiles, 1);
  assert.equal(table.rows.some((row) => row.module === "index.js"), false);
});

test("the same file arriving from several evidence items counts once", () => {
  const table = census({ readPaths: ["js/app.js", "./js/app.js", "js\\app.js"] });
  assert.equal(table.rows.find((row) => row.module === "js")?.readFiles, 1, "path forms normalize to one file");
  assert.equal(table.summary.readFiles, 1);
});

// The snapshot is supposed to be the superset. If it ever is not, the discrepancy must be visible rather than
// dropped — the same rule the feature census applies to pool-only modules.
test("a module read but absent from the snapshot still gets a row, with a zero denominator", () => {
  const table = census({ readPaths: ["generated/schema.ts"] });
  const orphan = table.rows.find((row) => row.module === "generated");
  assert.ok(orphan, "silently dropping it would hide a real inconsistency");
  assert.equal(orphan.snapshotFiles, 0);
  assert.equal(orphan.readFiles, 1);
});

// Unlike the feature census there is no "unavailable" state to represent: the snapshot alone supplies the row
// set, so a source-only run gets a real table rather than an explanation of why there is none.
test("a run with no index at all still produces a full table", () => {
  const table = census({ indexedPaths: new Set(), readPaths: ["lib/ZMS/Shop.pm"] });
  assert.equal(table.summary.censusModules, 3);
  assert.equal(table.summary.indexedFiles, 0);
  assert.equal(table.summary.unindexedFiles, table.summary.snapshotFiles);
  assert.equal(overviewCensusResidual(table).balanced, true);
});

// THE READING MODULE ROWS CANNOT GIVE. On the target that motivated this artifact, 2,757 of 2,760 source
// files sit under one top-level directory, so the Perl half and the JavaScript that IS read share a single row
// and that row reads `counted`. Without the extension dimension the run would report no gap at all.
test("a language the overview never touched is named, even when its module row reads counted", () => {
  const table = census({ namedPaths: ["js/app.js"], readPaths: ["js/app.js"] });
  const untouched = untouchedExtensions(table);
  assert.deepEqual(untouched.map((row) => row.extension), [".pm"], "the Perl tree is invisible to the module rows here");
  assert.equal(untouched[0].snapshotFiles, 3);
  assert.equal(untouched[0].indexedFiles, 0);
});

test("a module row can read counted while one of its languages is entirely untouched", () => {
  const table = buildOverviewCensus({
    sourcePaths: ["app/Shop.pm", "app/Cart.pm", "app/main.js"],
    indexedPaths: new Set(["app/main.js"]),
    namedPaths: ["app/main.js"],
    readPaths: ["app/main.js"],
  });
  assert.deepEqual(table.rows.map((row) => [row.module, row.status.kind]), [["app", "counted"]], "one module, and it is counted");
  assert.deepEqual(overviewCensusResidual(table).unexplained, [], "so the module residual reports nothing");
  assert.deepEqual(untouchedExtensions(table).map((row) => `${row.extension}:${row.snapshotFiles}`), [".pm:2"], "the extension row is the only place the gap appears");
});

test("a language that was named but never opened does not count as untouched", () => {
  const table = census({ namedPaths: ["lib/ZMS/Shop.pm"] });
  assert.deepEqual(untouchedExtensions(table).map((row) => row.extension), [".js"], "only .js is neither named nor read");
});

test("extension is read from the basename, and an extensionless file lands in a visible bucket", () => {
  const table = buildOverviewCensus({
    sourcePaths: ["lib/ZMS-1.4/Shop.pm", "bin/runner"],
    indexedPaths: new Set(),
    namedPaths: [],
    readPaths: [],
  });
  assert.deepEqual(table.byExtension.map((row) => row.extension), ["", ".pm"], "a dot in a directory name is not an extension");
  assert.equal(table.byExtension.find((row) => row.extension === "")?.snapshotFiles, 1);
});

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function overviewOnlyRequest(features: ReportRequest["features"] = []): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features, budgets: BUDGETS };
}

// THE GAP THIS SLICE CLOSES. An overview-only run has no feature keys, so the per-feature census loop wrote
// nothing at all and the run was silent about module coverage — for the one document that claims to describe
// the whole project.
test("an overview-only run writes the module accounting at prepare", async () => {
  const { runDir } = await prepareRun(await overviewOnlyRequest());
  const path = join(runDir, "context", "overview-census.json");
  assert.equal(await exists(path), true, "a run with zero features must still account for its modules");

  const table = JSON.parse(await readFile(path, "utf8")) as OverviewCensus;
  assert.equal(table.version, OVERVIEW_CENSUS_VERSION);
  assert.ok(table.rows.length > 0, "the table is built from the snapshot, which is never empty");
  assert.equal(overviewCensusResidual(table).balanced, true);
  assert.equal(table.summary.snapshotFiles > 0, true);
});

// Why a feature named "overview" cannot overwrite this file. The protection is NOT the chosen filename — it
// is that every feature artifact carries a 10-character content hash of its subject and aliases, so no
// feature key is ever a bare word. Pinning the real mechanism, because the filename alone would be a
// coincidence someone could later "tidy up".
test("a feature named \"overview\" cannot collide with the overview accounting", async () => {
  const { runDir } = await prepareRun(await overviewOnlyRequest([{ subject: "overview", aliases: [], audiences: ["product"] }]));
  assert.equal(await exists(join(runDir, "context", "overview-census.json")), true);

  const featureArtifacts = (await readdir(join(runDir, "context"))).filter((name) => name.endsWith(".scope-census.json"));
  assert.deepEqual(featureArtifacts.map((name) => /^overview-[0-9a-f]{10}\.scope-census\.json$/.test(name)), [true], "the feature key is slug + content hash, never a bare subject");
});
