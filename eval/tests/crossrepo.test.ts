import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCrossRepoReport, crossRepoExitCode, loadCrossRepoGold } from "../crossrepo.ts";

// The fixture is a byte extraction of a real run's link artifact, trimmed to the gold pairs plus thirty
// other links. Link records are coordinates — a path and a line either match the source or they do not —
// so a real extraction is the right fixture here, and it keeps CI independent of the target repository.
//
// A gate that cannot go red is decoration, so every check below is exercised in both directions.

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD = join(HERE, "..", "fixtures", "wcp-crossrepo", "crossrepo-gold.json");
const ARTIFACT = join(HERE, "fixtures", "wcp-crossrepo", "crossrepo-links.json");

function withArtifact(mutate: (artifact: Record<string, unknown>) => void): string {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as Record<string, unknown>;
  mutate(artifact);
  const path = join(mkdtempSync(join(tmpdir(), "xr-gate-")), "crossrepo-links.json");
  writeFileSync(path, JSON.stringify(artifact));
  return path;
}

test("every hand-verified link is found, pointing at the same backend", () => {
  const report = buildCrossRepoReport(ARTIFACT, loadCrossRepoGold(GOLD), 0);
  const missed = report.gold.filter((entry) => entry.status !== "found");
  assert.deepEqual(missed, [], `gold must be fully found: ${JSON.stringify(missed)}`);
  assert.equal(crossRepoExitCode(report), 0);
});

test("a link that vanishes fails the gate", () => {
  const path = withArtifact((artifact) => {
    const links = artifact.links as Array<{ from: { path: string } }>;
    artifact.links = links.filter((link) => link.from.path !== "src/pages/leave/leave-service.ts");
  });
  const report = buildCrossRepoReport(path, loadCrossRepoGold(GOLD), 0);
  assert.ok(report.gold.some((entry) => entry.status === "missing"));
  assert.equal(crossRepoExitCode(report), 1);
});

test("a link that points at the wrong backend fails the gate, and says what it got", () => {
  const path = withArtifact((artifact) => {
    const links = artifact.links as Array<{ from: { path: string; line: number }; to: { module: string; route: string } }>;
    const target = links.find((link) => link.from.line === 176);
    if (target) target.to = { ...target.to, module: "wcp-service", route: "POST /leaves" };
  });
  const report = buildCrossRepoReport(path, loadCrossRepoGold(GOLD), 0);
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
  const report = buildCrossRepoReport(path, loadCrossRepoGold(GOLD), 0);
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
  const report = buildCrossRepoReport(path, loadCrossRepoGold(GOLD), 0);
  const silenced = report.mustUnresolved.find((entry) => entry.status === "now-linked");
  assert.ok(silenced, "a call the backend does not serve must stay unresolved");
  assert.equal(crossRepoExitCode(report), 1);
});

test("a link that carries no evidence pair fails the gate — an unverifiable link is not a link", () => {
  const path = withArtifact((artifact) => {
    const links = artifact.links as Array<{ evidenceIds: string[] }>;
    links[0].evidenceIds = ["only-one"];
  });
  const report = buildCrossRepoReport(path, loadCrossRepoGold(GOLD), 0);
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
test("a collapse that leaves gold intact still fails the gate", () => {
  const gold = loadCrossRepoGold(GOLD);
  assert.ok(gold.floors?.calls && gold.floors.routes && gold.floors.linked, "this target declares floors");

  const path = withArtifact((artifact) => {
    const summary = artifact.summary as Record<string, number>;
    // Every gold pair survives; a whole client's calls do not.
    summary.calls = 40;
    summary.static = 30;
  });
  const report = buildCrossRepoReport(path, gold, 0);
  assert.deepEqual(report.gold.filter((entry) => entry.status !== "found"), [], "gold is untouched — that is the point");
  assert.ok(report.floorFailures.some((failure) => failure.startsWith("calls")), `expected a calls floor breach, got ${JSON.stringify(report.floorFailures)}`);
  assert.ok(report.floorFailures.some((failure) => failure.startsWith("linked")));
  assert.equal(crossRepoExitCode(report), 1);
});

test("a backend whose route table vanishes trips the routes floor", () => {
  const path = withArtifact((artifact) => {
    (artifact.summary as Record<string, number>).routes = 90;
  });
  const report = buildCrossRepoReport(path, loadCrossRepoGold(GOLD), 0);
  assert.ok(report.floorFailures.some((failure) => failure.startsWith("routes")));
  assert.equal(crossRepoExitCode(report), 1);
});

test("a gold file with no floors declared simply has no floor check", () => {
  const goldPath = join(mkdtempSync(join(tmpdir(), "xr-gold-")), "gold.json");
  const gold = JSON.parse(readFileSync(GOLD, "utf8")) as Record<string, unknown>;
  delete gold.floors;
  writeFileSync(goldPath, JSON.stringify(gold));
  const report = buildCrossRepoReport(ARTIFACT, loadCrossRepoGold(goldPath), 0);
  assert.deepEqual(report.floorFailures, []);
  assert.equal(crossRepoExitCode(report), 0);
});

test("a gold file of the wrong version is rejected rather than half-read", () => {
  const path = join(mkdtempSync(join(tmpdir(), "xr-gold-")), "gold.json");
  writeFileSync(path, JSON.stringify({ version: "crossrepo-gold-v99", links: [] }));
  assert.throws(() => loadCrossRepoGold(path), /unsupported gold version/);
});
