import test from "node:test";
import assert from "node:assert/strict";
import { buildCrossRepoArtifact, mintCrossRepoEvidence, resolvedHandlers } from "../src/crossrepo/crossrepo-artifact.ts";
import { reconcileReadCoverage } from "../src/assurance/read-coverage.ts";
import type { CrossRepoScan } from "../src/crossrepo/crossrepo-scan.ts";
import type { ReadObligation } from "../src/assurance/read-obligations.ts";

function scanWith(links: CrossRepoScan["links"]): CrossRepoScan {
  return {
    version: "crossrepo-links-v1",
    modules: ["wcp-service-v2", "wcp-ui"],
    clients: ["httpClient"],
    links,
    unresolved: [],
    ambiguous: [],
    candidates: [],
    routeRecovery: [],
    registrations: [],
    unrecoveredRoutes: [],
    summary: { calls: links.length, static: links.length, framework: 0, unresolved: 0, ambiguous: 0, weak: 0, routes: 1 },
    warnings: [],
  };
}

const LINK: CrossRepoScan["links"][number] = {
  from: { module: "wcp-ui", path: "src/api/leaveApi.ts", line: 214, method: "POST", baseKey: "appRunnerApi", expression: "`${appRunnerApi}/v2/leaves`", routePath: "/v2/leaves" },
  to: { module: "wcp-service-v2", path: "internal/handlers/handlers.go", line: 98, route: "POST /v2/leaves", localPath: "", prefixComposed: true, handlerExpression: "e.CatchError(leave.Creation)" },
  resolution: "static",
  confidence: "confirmed",
  rule: "R1",
};

// THE failure this test exists to prevent: read coverage counts every `source` evidence item as a window
// somebody opened. Minting link ends as source would mark each resolved handler span as read without any
// reading having happened — the resolver would quietly forge the metric it was built to support.
test("link evidence is derived, so resolving a route never counts as reading it", () => {
  const { evidence } = mintCrossRepoEvidence(scanWith([LINK]), "snap-1", false);
  assert.equal(evidence.length, 2);
  assert.deepEqual([...new Set(evidence.map((item) => item.kind))], ["derived"]);

  const obligation: ReadObligation = {
    id: "feature:leave:boundary-fn:Creation@internal/handlers/handlers.go:90",
    kind: "boundary-decision-function",
    featureKey: "leave",
    name: "Creation",
    path: "wcp-service-v2/internal/handlers/handlers.go",
    startLine: 90,
    endLine: 120,
    lines: 31,
    tier: 2,
    gated: false,
  };
  const report = reconcileReadCoverage({ obligations: [obligation], evidence });
  assert.equal(report.items[0].status, "not-opened", "the handler span is still unread, and the report must say so");
  assert.deepEqual(report.items[0].openedWindows, [], "no link evidence may be mistaken for an opened window");
  assert.equal(report.items[0].openedLines, 0);
});

test("each link binds exactly two evidence records, naming the file and line at both ends", () => {
  const { evidence, byLink } = mintCrossRepoEvidence(scanWith([LINK]), "snap-1", false);
  const artifact = buildCrossRepoArtifact(scanWith([LINK]), "snap-1", { evidence, byLink }, false);
  const [fromId, toId] = artifact.links[0].evidenceIds;
  const from = evidence.find((item) => item.id === fromId);
  const to = evidence.find((item) => item.id === toId);
  assert.equal(from?.path, "wcp-ui/src/api/leaveApi.ts");
  assert.equal(from?.startLine, 214);
  assert.equal(to?.path, "wcp-service-v2/internal/handlers/handlers.go");
  assert.equal(to?.startLine, 98);
  assert.equal(from?.snapshotId, "snap-1", "evidence is snapshot-bound like every other record");
  assert.ok(from?.digest && to?.digest);
});

test("minting is deterministic: the same scan yields byte-identical evidence and ids", () => {
  const first = mintCrossRepoEvidence(scanWith([LINK]), "snap-1", false);
  const second = mintCrossRepoEvidence(scanWith([LINK]), "snap-1", false);
  assert.equal(JSON.stringify(first.evidence), JSON.stringify(second.evidence));
  assert.deepEqual([...first.byLink.entries()], [...second.byLink.entries()]);
});

test("two calls to the same handler resolve one handler, not two", () => {
  const second: CrossRepoScan["links"][number] = { ...LINK, from: { ...LINK.from, line: 300, path: "src/pages/Apply.tsx" } };
  const artifact = buildCrossRepoArtifact(scanWith([LINK, second]), "snap-1", mintCrossRepoEvidence(scanWith([LINK, second]), "snap-1", false), false);
  assert.equal(artifact.links.length, 2);
  assert.deepEqual(resolvedHandlers(artifact).map((handler) => `${handler.path}:${handler.line}`), ["internal/handlers/handlers.go:98"]);
});

// evidence.json is a durable artifact, and a URL literal can carry a token. Copying source text into it
// verbatim would route around the redaction pipeline every other evidence path goes through.
test("source text minted into evidence goes through redaction when the run asked for it", () => {
  const withSecret: CrossRepoScan["links"][number] = {
    ...LINK,
    from: { ...LINK.from, expression: "`${api}/v2/leaves?token=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789`" },
  };
  const { evidence } = mintCrossRepoEvidence(scanWith([withSecret]), "snap-1", true);
  const call = evidence.find((item) => item.id.startsWith("XR-call-"));
  const expression = String((call?.data as { expression?: string })?.expression ?? "");
  assert.ok(!expression.includes("ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"), `the token must not survive into evidence: ${expression}`);
  assert.ok(expression.includes("/v2/leaves"), "the path itself is still legible");

  // And with redaction off — the default, since a local run records a workspace the operator already has —
  // the URL is recorded as written. The two modes must be distinguishable, never silently the same.
  const plain = mintCrossRepoEvidence(scanWith([withSecret]), "snap-1", false).evidence.find((item) => item.id.startsWith("XR-call-"));
  assert.match(String((plain?.data as { expression?: string })?.expression ?? ""), /ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789/);
});

// THE TEST ABOVE PASSED WHILE THE ARTIFACT LEAKED, which is the whole lesson: it asked about the evidence
// twin, and this module writes source text to TWO places. `context/crossrepo-links.json` kept the token
// verbatim on a run that had asked for redaction, and nothing could catch it — a structured artifact's
// digest is self-consistent whatever it holds, so the audit's re-derivation never applies to it.
//
// So this asserts the SURFACES, by serialising everything the module produces and asking one question of
// the whole output. A third writer added later is covered without anyone remembering to extend a list.
test("no surface this module writes disagrees with the run's mode", () => {
  const TOKEN = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";
  const withSecret: CrossRepoScan["links"][number] = {
    ...LINK,
    from: { ...LINK.from, expression: `\`\${api}/v2/leaves?token=${TOKEN}\`` },
    // Both fields NAME the credential. The redactor is name-driven by design — `handle(req, "ghp_…")`
    // mentions nothing sensitive and is deliberately left alone — so a probe without a name would pass
    // here while proving nothing about the plumbing.
    to: { ...LINK.to, handlerExpression: `auth({ token: "${TOKEN}" })` },
  };

  for (const [redact, expectation] of [[true, "absent"], [false, "present"]] as const) {
    const scan = scanWith([withSecret]);
    const binding = mintCrossRepoEvidence(scan, "snap-1", redact);
    const everything = JSON.stringify([binding.evidence, buildCrossRepoArtifact(scan, "snap-1", binding, redact)]);
    assert.equal(everything.includes(TOKEN), expectation === "present",
      `redact=${redact}: the token is ${everything.includes(TOKEN) ? "present" : "absent"} across evidence AND artifact`);
  }
});

test("an empty scan produces an artifact with no links and no evidence, not a crash", () => {
  const binding = mintCrossRepoEvidence(scanWith([]), "snap-1", false);
  const artifact = buildCrossRepoArtifact(scanWith([]), "snap-1", binding, false);
  assert.deepEqual(artifact.links, []);
  assert.deepEqual(binding.evidence, []);
});
