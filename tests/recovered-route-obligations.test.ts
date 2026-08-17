import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readObligations, RECOVERED_ROUTE_DENOMINATOR_ASSURANCE_GENERATION } from "../src/assurance/read-obligations.ts";
import { recoveredRouteObligations } from "../src/crossrepo/crossrepo-artifact.ts";
import { reconcileReadCoverage } from "../src/assurance/read-coverage.ts";
import type { EvidenceItem, FeatureFactPack } from "../src/base/types.ts";

// THE FOURTH DENOMINATOR SOURCE, judged by replaying a real run rather than by waiting for the next one.
//
// An express registration whose handler is an inline closure resolves to no named function, so the third
// source (cross-repo link → handler) enumerates none of them. Measured on the real target: two v1 files hold
// 16 registrations, 9 decision-bearing, 719 accountable lines that NO source enumerated — and because a file
// with no obligation contributes to no bucket, every window opened there was invisible to BOTH sides of the
// funnel. Run #1 opened 9 windows on those files and its report stated none of the rules in them; nothing in
// the four-bucket ledger could see either half of that.
//
// The fixture is run #1's own frozen evidence plus the registrations re-derived from the same target (its
// artifact predates the field). Replaying it makes the historical loss countable and pins the distribution,
// so this is a regression floor rather than a claim about a future run.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "recovered-routes", "run1-replay.json");

interface Replay {
  featureKey: string;
  registrations: Array<{ module: string; method: string; path: string; file: string; line: number; endLine: number; framework: string }>;
  windows: EvidenceItem[];
}

function replay(): Replay {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Replay;
}

/**
 * The SHIPPED construction, not a copy of it. An earlier version of this file mirrored the filter by hand;
 * two mutations proved what that is worth — deleting the qualified-path match, and disconnecting the whole
 * fourth source from freeze, both left the suite green. A test that re-implements the thing it tests can
 * only ever agree with itself.
 */
function recoveredSource(data: Replay, factPack: FeatureFactPack) {
  return recoveredRouteObligations({ registrations: data.registrations }, { [data.featureKey]: factPack as never }) ?? [];
}

function pack(data: Replay): FeatureFactPack {
  const files = [...new Set(data.registrations.map((entry) => `${entry.module}/${entry.file}`))];
  return {
    version: "factpack-v1", snapshotId: "replay", featureKey: data.featureKey, coverage: [], warnings: [],
    items: files.map((filePath, index) => ({ category: "logic", name: `anchor${index}`, filePath, line: 1, endLine: 1 })),
  } as unknown as FeatureFactPack;
}

test("the generation constant is the next one, so a run frozen under 7 keeps its denominator", () => {
  assert.equal(RECOVERED_ROUTE_DENOMINATOR_ASSURANCE_GENERATION, 8);
});

test("registrations with an inline handler become obligations of their own kind", () => {
  const data = replay();
  const factPack = pack(data);
  const artifact = readObligations([factPack], [], null, null, null, recoveredSource(data, factPack));
  const recovered = artifact.obligations.filter((obligation) => obligation.kind === "recovered-route-handler");

  assert.equal(recovered.length, 16, "the two v1 express files' registrations");
  assert.equal(recovered.filter((obligation) => !obligation.excluded).length, 16, "all counted — none is a bare declaration");
  assert.equal(artifact.summary.recoveredRouteSource?.added, 16);
  assert.ok(recovered.every((obligation) => obligation.tier === 2 && obligation.gated === false),
    "advisory like every supplement before it: it widens what is counted, and gates nothing");
  // The route carries the vocabulary a mounted express path loses: locally these are `/`, `/approve`, `/:id`.
  assert.ok(recovered.every((obligation) => obligation.route && obligation.name.endsWith(obligation.route)));
  assert.ok(recovered.some((obligation) => obligation.name === "POST /leaves"), "the v1 leave creation");
});

// The historical loss, decomposed. Before this source, all of it read as nothing at all.
test("replaying run #1 puts every registration in a bucket, and the distribution is pinned", () => {
  const data = replay();
  const factPack = pack(data);
  const artifact = readObligations([factPack], [], null, null, null, recoveredSource(data, factPack));
  const report = reconcileReadCoverage({ obligations: artifact.obligations, evidence: data.windows });

  const items = report.items.filter((item) => item.id.includes(":recovered-route-handler:"));
  assert.equal(items.length, 16, "no fourth state: every registration reconciles");
  const byStatus = (status: string): number => items.filter((item) => item.status === status).length;
  assert.deepEqual(
    { covered: byStatus("covered"), partial: byStatus("partial"), notOpened: byStatus("not-opened"), cannotDetermine: byStatus("cannot-determine") },
    { covered: 7, partial: 3, notOpened: 6, cannotDetermine: 0 },
    "run #1's real distribution over the 16 registrations",
  );
  assert.equal(items.filter((item) => item.openedWindows.length > 0 && item.consumedBy.length === 0).length, 10,
    "opened and cited by nothing — the half of the loss that is NOT a read-miss");
});

// The specific instance that motivated the slice, and the correction it forced: the failure here was not
// "never read". `POST /leaves` at 149-239 holds the v1 creation rules (`hours > 8`, `holiday_type === 2`)
// and run #1 opened it fully — then stated none of them. Calling that a read-miss would have sent the next
// slice after the wrong bucket, which is why the distribution is machine-judged rather than assumed.
test("the v1 creation rules were READ and unstated, while another 208-line handler was never opened", () => {
  const data = replay();
  const factPack = pack(data);
  const artifact = readObligations([factPack], [], null, null, null, recoveredSource(data, factPack));
  const report = reconcileReadCoverage({ obligations: artifact.obligations, evidence: data.windows });

  const creation = report.items.find((item) => item.name === "POST /leaves");
  assert.ok(creation, "the v1 leave creation is in the denominator at all — before this source it was not");
  assert.equal(creation.status, "covered");
  assert.equal(creation.consumedBy.length, 0, "read in full, cited by no claim: a consume-miss, now countable");

  const detail = report.items.find((item) => item.name === "GET /leaves/:id");
  assert.equal(detail?.status, "not-opened");
  assert.equal(detail?.uncoveredLines, 208, "and a genuine read-miss of 208 lines, equally invisible before");
});

// A denominator that renamed or re-kinded what it already had would break every frozen run's digest.
test("the fourth source only adds — existing obligations keep their id and kind", () => {
  const data = replay();
  const factPack = pack(data);
  const before = readObligations([factPack], [], null, null, null);
  const after = readObligations([factPack], [], null, null, null, recoveredSource(data, factPack));

  const kinds = new Map(before.obligations.map((obligation) => [obligation.id, obligation.kind]));
  for (const [id, kind] of kinds) {
    assert.equal(after.obligations.find((obligation) => obligation.id === id)?.kind, kind, `${id} changed kind`);
  }
  assert.equal(after.obligations.length, before.obligations.length + 16);
  assert.equal(after.summary.counted, before.summary.counted + 16);
});

test("a registration with no end line contributes nothing rather than a span-less obligation", () => {
  const data = replay();
  const factPack = pack(data);
  const spanless = recoveredSource(data, factPack).map((entry) => ({ ...entry, endLine: entry.startLine - 1 }));
  const artifact = readObligations([factPack], [], null, null, null, spanless.filter((entry) => entry.endLine >= entry.startLine));
  assert.equal(artifact.obligations.filter((obligation) => obligation.kind === "recovered-route-handler").length, 0,
    "a span that cannot be reconciled would sit in cannot-determine forever");
});

// THE WIRING, not just the construction. The first version of this file tested a hand-copied mirror of the
// filter, and two mutations showed what that buys: deleting the qualified-path match, and disconnecting the
// fourth source from freeze entirely, both left the whole suite green. So this asserts the path from a
// frozen artifact to a frozen denominator — the thing a user actually gets.
test("freeze turns an artifact's registrations into obligations end to end", async () => {
  const { writeJson } = await import("../src/base/util.ts");
  const { freezeRun, prepareRun } = await import("../src/run/run.ts");
  const { copyFixture, disposeAllWorkItems, tempDir } = await import("./helpers.ts");
  const { readFile } = await import("node:fs/promises");

  const target = await copyFixture("residual-target");
  const workdir = await tempDir();
  const { runDir } = await prepareRun({
    target, workdir, language: "en-US", detailLevel: "standard", overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave"], audiences: ["product"] }],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 20, maxSourceCharacters: 400_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 },
  } as never);

  // A minimal cross-repo artifact whose only content is a registration inside the feature's boundary.
  const factPackPath = join(runDir, "context", "features");
  const { readdirSync } = await import("node:fs");
  const packFile = readdirSync(factPackPath).find((name) => name.endsWith(".factpack.json"))!;
  const factPack = JSON.parse(await readFile(join(factPackPath, packFile), "utf8")) as { items: Array<{ filePath: string }> };
  const boundaryFile = factPack.items[0]?.filePath;
  assert.ok(boundaryFile, "the fixture must put at least one file in the boundary");

  await writeJson(join(runDir, "context", "crossrepo-links.json"), {
    version: "crossrepo-artifact-v1", snapshotId: "s", modules: [], clients: [], links: [],
    unresolved: [], ambiguous: [], candidates: [], routeRecovery: [], unrecoveredRoutes: [], warnings: [],
    registrations: [{ module: "", method: "POST", path: "/leaves", file: boundaryFile, line: 1, endLine: 4, framework: "express" }],
  });

  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);

  const frozen = JSON.parse(await readFile(join(runDir, "coverage", "read-obligations.json"), "utf8")) as {
    obligations: Array<{ kind: string; name: string; route?: string }>;
    summary: { recoveredRouteSource?: { added: number } };
  };
  const recovered = frozen.obligations.filter((obligation) => obligation.kind === "recovered-route-handler");
  assert.equal(recovered.length, 1, "the registration reached the frozen denominator");
  assert.equal(recovered[0].name, "POST /leaves");
  assert.equal(recovered[0].route, "/leaves", "the route rides along, or anchor annotation has nothing to match");
  assert.equal(frozen.summary.recoveredRouteSource?.added, 1);
});
