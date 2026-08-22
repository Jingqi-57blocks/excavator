import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tempDirSync } from "../../tests/temp-dir.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCrossRepoReport, crossRepoExitCode, loadCrossRepoGold } from "../crossrepo.ts";

// The fixture is a byte extraction of a real run's link artifact, trimmed to the gold pairs plus thirty
// other links. Link records are coordinates — a path and a line either match the source or they do not —
// so a real extraction is the right fixture here, and it keeps CI independent of the target repository.
//
// A gate that cannot go red is decoration, so every check below is exercised in both directions.
//
// The mechanism tests below deliberately load gold WITHOUT floors. The fixture is a trimmed artifact, so
// the real target's floors already fail on it — and an exit-code assertion that would hold even with the
// mechanism deleted proves nothing. Floors have their own tests; these ones must reflect only the
// mechanism under test.

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD = join(HERE, "..", "fixtures", "wcp-crossrepo", "crossrepo-gold.json");
const ARTIFACT = join(HERE, "fixtures", "wcp-crossrepo", "crossrepo-links.json");

function withArtifact(mutate: (artifact: Record<string, unknown>) => void): string {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as Record<string, unknown>;
  mutate(artifact);
  const path = join(tempDirSync("xr-gate-"), "crossrepo-links.json");
  writeFileSync(path, JSON.stringify(artifact));
  return path;
}

test("every hand-verified link is found, pointing at the same backend", () => {
  // Fixture-scale floors: the fixture is a trimmed artifact and its summary now says so honestly, so the
  // full target's floors do not apply to it. The real floors are exercised against the real run.
  const report = buildCrossRepoReport(ARTIFACT, goldWithFloors(FIXTURE_FLOORS), 0);
  const missed = report.gold.filter((entry) => entry.status !== "found");
  assert.deepEqual(missed, [], `gold must be fully found: ${JSON.stringify(missed)}`);
  assert.equal(crossRepoExitCode(report), 0);
});

test("a link that vanishes fails the gate", () => {
  const path = withArtifact((artifact) => {
    const links = artifact.links as Array<{ from: { path: string } }>;
    artifact.links = links.filter((link) => link.from.path !== "src/pages/leave/leave-service.ts");
  });
  const report = buildCrossRepoReport(path, goldWithFloors(undefined), 0);
  assert.ok(report.gold.some((entry) => entry.status === "missing"));
  assert.equal(crossRepoExitCode(report), 1);
});

test("a link that points at the wrong backend fails the gate, and says what it got", () => {
  const path = withArtifact((artifact) => {
    const links = artifact.links as Array<{ from: { path: string; line: number }; to: { module: string; route: string } }>;
    const target = links.find((link) => link.from.line === 176);
    if (target) target.to = { ...target.to, module: "wcp-service", route: "POST /leaves" };
  });
  const report = buildCrossRepoReport(path, goldWithFloors(undefined), 0);
  const wrong = report.gold.find((entry) => entry.status === "wrong-target");
  assert.ok(wrong, "a link redirected to another backend must fail");
  assert.match(wrong.actual ?? "", /wcp-service POST \/leaves/);
  assert.equal(crossRepoExitCode(report), 1);
});

test("a link whose handler changed underneath it fails the gate", () => {
  const path = withArtifact((artifact) => {
    const links = artifact.links as Array<{ from: { line: number }; to: { handlerExpression: string } }>;
    const target = links.find((link) => link.from.line === 176);
    if (target) target.to.handlerExpression = "e.CatchError(leave.SomethingElse)";
  });
  const report = buildCrossRepoReport(path, goldWithFloors(undefined), 0);
  assert.ok(report.gold.some((entry) => entry.status === "wrong-target"));
});

// The direction a resolver fails when it becomes too eager: it "helpfully" matches a call the backend
// does not serve, and a real product bug stops being visible.
test("silencing a known non-link fails the gate too", () => {
  const path = withArtifact((artifact) => {
    const links = artifact.links as Array<Record<string, unknown>>;
    links.push({
      id: "xrl:invented",
      kind: "http-route",
      from: { module: "wcp-ui", path: "src/api/personalInformationApi.ts", line: 158, method: "PATCH", baseKey: "appRunnerApi", expression: "", routePath: "/v2/employee/:p1/personal-information" },
      to: { module: "wcp-service-v2", path: "internal/handlers/handlers.go", line: 1, route: "GET /v2/employee/:employee_id/personal-information", localPath: "", prefixComposed: true, handlerExpression: "x" },
      resolution: "static", confidence: "confirmed", rule: "R1", evidenceIds: ["a", "b"],
    });
  });
  const report = buildCrossRepoReport(path, goldWithFloors(undefined), 0);
  const silenced = report.mustUnresolved.find((entry) => entry.status === "now-linked");
  assert.ok(silenced, "a call the backend does not serve must stay unresolved");
  assert.equal(crossRepoExitCode(report), 1);
});

test("a link that carries no evidence pair fails the gate — an unverifiable link is not a link", () => {
  const path = withArtifact((artifact) => {
    const links = artifact.links as Array<{ evidenceIds: string[] }>;
    links[0].evidenceIds = ["only-one"];
  });
  const report = buildCrossRepoReport(path, goldWithFloors(undefined), 0);
  assert.equal(report.unboundLinks.length, 1);
  assert.equal(crossRepoExitCode(report), 1);
});

// Ten checked pairs say nothing about the precision of the other several hundred links.
test("the review sample excludes gold, is bounded, and is the same every time", () => {
  const gold = loadCrossRepoGold(GOLD);
  const first = buildCrossRepoReport(ARTIFACT, gold, 5);
  const second = buildCrossRepoReport(ARTIFACT, gold, 5);
  assert.equal(first.sample.length, 5);
  assert.deepEqual(first.sample, second.sample, "no seed to remember means the same links come up for review");
  const goldPaths = new Set(gold.links.map((entry) => `${entry.from.path}:${entry.from.line}`));
  for (const entry of first.sample) {
    assert.ok(!goldPaths.has(entry.from.split(" ")[0]), `sample must not re-offer gold: ${entry.from}`);
  }
});

// Gold pins ten links in six frontend files; the real target has hundreds across dozens. A regression that
// drops a whole client — or a whole backend's route table — can leave every gold pair standing. Measured on
// the real artifact: 365 links across 32 files, of which gold covers 6. The floors are what notices.
//
// The floors read the ARRAYS, never `summary`: the summary is the guarded component's report of itself, and
// an artifact whose summary and arrays disagree would sail straight through a floor that trusted it.

/** A gold file with these floors, scaled to the trimmed fixture rather than the full target. */
function goldWithFloors(floors: Record<string, unknown> | undefined): ReturnType<typeof loadCrossRepoGold> {
  const gold = JSON.parse(readFileSync(GOLD, "utf8")) as Record<string, unknown>;
  if (floors) gold.floors = floors; else delete gold.floors;
  const path = join(tempDirSync("xr-gold-"), "gold.json");
  writeFileSync(path, JSON.stringify(gold));
  return loadCrossRepoGold(path);
}

const FIXTURE_FLOORS = { calls: 45, routes: 480, linked: 35 };

test("an intact artifact clears its floors", () => {
  const report = buildCrossRepoReport(ARTIFACT, goldWithFloors(FIXTURE_FLOORS), 0);
  assert.deepEqual(report.floorFailures, []);
  assert.equal(crossRepoExitCode(report), 0);
});

// THE shape this slice exists for: every gold pair survives, and most of the target's links do not.
test("a collapse that leaves gold intact still fails the gate", () => {
  const goldPaths = new Set(loadCrossRepoGold(GOLD).links.map((entry) => entry.from.path));
  const path = withArtifact((artifact) => {
    const links = artifact.links as Array<{ from: { path: string } }>;
    artifact.links = links.filter((link) => goldPaths.has(link.from.path));
  });
  const report = buildCrossRepoReport(path, goldWithFloors(FIXTURE_FLOORS), 0);
  assert.deepEqual(report.gold.filter((entry) => entry.status !== "found"), [], "gold is untouched — that is the point");
  assert.ok(report.floorFailures.some((failure) => failure.startsWith("linked")), `expected a linked floor breach, got ${JSON.stringify(report.floorFailures)}`);
  assert.equal(crossRepoExitCode(report), 1);
});

// The attack the first version of this gate fell for: keep the arrays small, keep the summary big.
test("an artifact whose summary flatters itself does not fool the floors", () => {
  const path = withArtifact((artifact) => {
    (artifact.links as unknown[]) = (artifact.links as unknown[]).slice(0, 5);
    artifact.summary = { calls: 411, routes: 508, static: 365, framework: 0, unresolved: 36, ambiguous: 4, weak: 6 };
  });
  const report = buildCrossRepoReport(path, goldWithFloors(FIXTURE_FLOORS), 0);
  assert.ok(report.floorFailures.length > 0, "the floors must read the arrays, not the self-report");
  assert.equal(crossRepoExitCode(report), 1);
});

test("a backend whose route table vanishes trips the routes floor", () => {
  const path = withArtifact((artifact) => {
    const recovery = artifact.routeRecovery as Array<{ recovered: number }>;
    for (const entry of recovery) entry.recovered = 0;
  });
  const report = buildCrossRepoReport(path, goldWithFloors(FIXTURE_FLOORS), 0);
  assert.ok(report.floorFailures.some((failure) => failure.startsWith("routes")));
  assert.equal(crossRepoExitCode(report), 1);
});

test("a gold file with no floors declared simply has no floor check", () => {
  const report = buildCrossRepoReport(ARTIFACT, goldWithFloors(undefined), 0);
  assert.deepEqual(report.floorFailures, []);
  assert.equal(crossRepoExitCode(report), 0);
});

// A floor a typo can silence is not a floor, and the moment that matters is the next re-measurement.
test("a mistyped floor key or a non-numeric floor is rejected at load, not skipped at check", () => {
  assert.throws(() => goldWithFloors({ callz: 999999 }), /unknown floor "callz"/);
  assert.throws(() => goldWithFloors({ calls: "380" }), /must be a finite number/);
  assert.throws(() => goldWithFloors({ calls: Number.NaN }), /must be a finite number/);
  assert.doesNotThrow(() => goldWithFloors({ ...FIXTURE_FLOORS, note: "why these numbers" }));
});

test("a gold file of the wrong version is rejected rather than half-read", () => {
  const path = join(tempDirSync("xr-gold-"), "gold.json");
  writeFileSync(path, JSON.stringify({ version: "crossrepo-gold-v99", links: [] }));
  assert.throws(() => loadCrossRepoGold(path), /unsupported gold version/);
});
