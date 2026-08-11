import test from "node:test";
import assert from "node:assert/strict";
import type { ReportRequest, SearchReceiptCorpus } from "../src/types.ts";
import { createSnapshot, scanFiles } from "../src/snapshot.ts";
import { SCANNER_VERSION_V1 } from "../src/scanner-versions.ts";
import { sourceSearch } from "../src/source.ts";
import { prepareRun, searchSourceEvidence } from "../src/run.ts";
import { copyFixture, tempDir } from "./helpers.ts";

// A golden fixture copied from the real cebreo/unmc MAUI target (samples manually vetted to carry no
// credentials; nuget.g.props had machine-specific temp paths scrubbed to /tmp/nuget-packages): the
// .feature/.xaml/.csproj/.plist/.props/.txt the v2 boundary now scans,
// plus a non-whitelisted .svg (census text) and a 1x1 .png (census binary). Assertions are pinned to
// the real manifest, census counts and Gherkin line numbers — no synthetic hand-authored values.
const FIXTURE = "compliance-s0b/unmc-sample";

test("v2 scans the real UI/build/doc files that v1 excluded", async () => {
  const target = await copyFixture(FIXTURE);
  const v2 = (await scanFiles(target)).map((file) => file.relativePath).sort();
  assert.deepEqual(v2, [
    "AppRetirement.feature",
    "Entitlements.plist",
    "ShortButtonPress.txt",
    "SupportTestingLabel.xaml",
    "UNMC.Shared.csproj",
    "nuget.g.props"
  ].sort());

  // The same files were entirely outside the v1 boundary: real proof of the capability gap S0b closes.
  const v1 = await scanFiles(target, 100_000, SCANNER_VERSION_V1);
  assert.deepEqual(v1, [], "none of the sampled MAUI files were scannable under v1");
});

test("the boundary census counts the non-whitelisted svg (text) and png (binary) exactly", async () => {
  const target = await copyFixture(FIXTURE);
  const { snapshot, unscanned } = await createSnapshot(target);
  assert.deepEqual(snapshot.boundaryCensus, { unscannedText: { ".svg": 1 }, unscannedBinary: 1, manifestTruncated: false });
  assert.deepEqual([...unscanned].sort((a, b) => a.relativePath.localeCompare(b.relativePath)), [
    { relativePath: "appicon.svg", extension: ".svg", kind: "text" },
    { relativePath: "separatorline.png", extension: ".png", kind: "binary" }
  ]);
});

test("Scenario: lines in the real .feature are now searchable at their true line numbers", async () => {
  const target = await copyFixture(FIXTURE);
  const files = await scanFiles(target);
  const matches = await sourceSearch(files, ["^\\s*Scenario:"], { regex: true });
  const scenarios = matches.filter((match) => match.file.relativePath === "AppRetirement.feature").map((match) => match.line).sort((a, b) => a - b);
  assert.deepEqual(scenarios, [5, 20], "both Gherkin scenarios are matched at their real lines");
});

test("a XAML control name is searchable in the real .xaml", async () => {
  const target = await copyFixture(FIXTURE);
  const files = await scanFiles(target);
  const matches = await sourceSearch(files, ["SupportTestingLabel"], {});
  assert.ok(matches.some((match) => match.file.relativePath === "SupportTestingLabel.xaml"), "the control name resolves inside the XAML body");
});

test("a search receipt carries the corpus block, and path prefixes scope the census", async () => {
  const target = await copyFixture(FIXTURE);
  const workdir = await tempDir();
  const request: ReportRequest = {
    target, workdir, language: "zh-CN", detailLevel: "standard",
    overviewAudiences: ["engineering"], features: [],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 20, maxSourceWindows: 20, maxSourceCharacters: 60_000, maxFiles: 10_000, maxFeatureNodes: 20, maxExpansionDepth: 2 }
  };
  const { runDir } = await prepareRun(request);

  // Whole-snapshot search: the census surfaces the non-whitelisted .svg (text) and .png (binary).
  const wide = await searchSourceEvidence(runDir, ["Scenario"], "compliance: gherkin scenarios", {});
  const wideCorpus = wide.corpus as SearchReceiptCorpus;
  assert.equal(wideCorpus.scannerVersion, "git-aware-source-boundary-v2");
  assert.equal(wideCorpus.unscannedTextInScope, 1);
  assert.equal(wideCorpus.unscannedBinaryInScope, 1);
  assert.deepEqual(wideCorpus.unscannedTextExtensions, { ".svg": 1 });

  // Scoping to the .feature excludes the .svg/.png from the census: an honest, scoped not-found reach.
  const scoped = await searchSourceEvidence(runDir, ["Scenario"], "compliance: scoped", { pathPrefixes: ["AppRetirement.feature"] });
  const scopedCorpus = scoped.corpus as SearchReceiptCorpus;
  assert.equal(scopedCorpus.unscannedTextInScope, 0);
  assert.equal(scopedCorpus.unscannedBinaryInScope, 0);
});
