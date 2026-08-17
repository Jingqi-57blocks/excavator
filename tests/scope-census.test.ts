import test from "node:test";
import assert from "node:assert/strict";
import { buildScopeCensus, scopeCensusResidual, SCOPE_CENSUS_VERSION } from "../src/context/scope-census.ts";

// THE ONE PROPERTY THIS WHOLE ARTIFACT EXISTS FOR: a module that contributed NOTHING still gets a row.
//
// A real run recorded zero nodes from an entire frontend repository and no artifact said so. The reason is
// structural rather than a bug in any single check: the read-obligation denominator derives from the
// feature's own boundary, so a module outside the boundary lands in no bucket — not covered, not missing,
// simply not counted. Any table built by walking the candidate pool inherits exactly that blind spot, which
// is why every test here attacks the row set rather than the arithmetic.

const ROOTS = [
  { root: "wcp-service-v2", files: 330, nodes: 8074 },
  { root: "wcp-ui", files: 512, nodes: 6210 },
  { root: "wcp-auth", files: 41, nodes: 900 },
];

const node = (filePath: string) => ({ filePath });

test("a module the scope never touched is still a row, with zero counts", () => {
  const census = buildScopeCensus({
    roots: ROOTS,
    pool: [node("wcp-service-v2/internal/handlers/leave/service.go")],
    retained: [node("wcp-service-v2/internal/handlers/leave/service.go")],
  });

  const ui = census.rows.find((row) => row.module === "wcp-ui");
  assert.ok(ui, "the row set comes from the census, so a module holding nothing cannot vanish from it");
  assert.equal(ui.retainedNodes, 0);
  assert.equal(ui.poolNodes, 0);
  assert.equal(ui.censusNodes, 6210, "and it still carries what the census knows — that is the zero baseline");
  assert.deepEqual(ui.status, { kind: "zero-hit" });
});

// Building the table from the pool is the mistake that makes it useless. This test fails if anyone ever
// "simplifies" the row set to the modules that actually contributed.
test("the row count is the census's, not the pool's", () => {
  const census = buildScopeCensus({ roots: ROOTS, pool: [node("wcp-auth/a.go")], retained: [node("wcp-auth/a.go")] });
  assert.equal(census.summary.censusModules, 3, "three indexed modules, one of which contributed");
  assert.equal(census.summary.countedModules, 1);
  assert.equal(census.summary.zeroHitModules, 2, "and the two silent ones are the reading worth having");
});

// TWO STATES, NEVER ONE. Every coverage tool surveyed flattens "exempted by a rule" and "nobody explained
// it" into the same 0%; that is precisely where their output layer stops being useful.
test("a named rule and an unexplained gap are different states", () => {
  const census = buildScopeCensus({
    roots: ROOTS,
    pool: [node("wcp-service-v2/x.go")],
    retained: [node("wcp-service-v2/x.go")],
    exemptions: { "wcp-auth": "vendored-identity-provider" },
  });

  assert.deepEqual(census.rows.find((row) => row.module === "wcp-auth")?.status,
    { kind: "excluded-by-rule", rule: "vendored-identity-provider" }, "the rule names itself");
  assert.deepEqual(census.rows.find((row) => row.module === "wcp-ui")?.status, { kind: "zero-hit" },
    "while an unexplained module stays unexplained — an exemption is never inferred");
  assert.equal(census.summary.excludedModules, 1);
  assert.equal(census.summary.zeroHitModules, 1);
});

// The residual identity — in-toto's trailing `DISALLOW *` in the only form that is honest today. Every
// module must be counted, exempted by name, or unexplained; nothing may fall outside those three.
test("the residual balances, and names what nobody explained", () => {
  const census = buildScopeCensus({
    roots: ROOTS,
    pool: [node("wcp-service-v2/x.go")],
    retained: [node("wcp-service-v2/x.go")],
    exemptions: { "wcp-auth": "vendored-identity-provider" },
  });
  const residual = scopeCensusResidual(census);
  assert.equal(residual.balanced, true);
  assert.deepEqual(residual.unexplained, ["wcp-ui"], "the alarm names the module, not just a count");
});

// A module producing nodes while absent from the census means the census is not the superset it claims to
// be. Dropping such a row would be the fourth state this accounting forbids, so it surfaces instead.
test("a module in the pool but missing from the census is surfaced, not dropped", () => {
  const census = buildScopeCensus({
    roots: [{ root: "wcp-service-v2", files: 330, nodes: 8074 }],
    pool: [node("wcp-ui/src/App.tsx")],
    retained: [node("wcp-ui/src/App.tsx")],
  });
  const ui = census.rows.find((row) => row.module === "wcp-ui");
  assert.ok(ui, "the discrepancy is visible");
  assert.equal(ui.censusNodes, 0, "with zero census counts, so the mismatch reads as a mismatch");
  assert.equal(ui.retainedNodes, 1);
});

// Shares are integers (basis points): a float would not survive a byte-for-byte artifact comparison, which
// every frozen run digest depends on.
test("shares are integer basis points and sum to the whole", () => {
  const census = buildScopeCensus({
    roots: ROOTS,
    pool: [],
    retained: [node("wcp-service-v2/a.go"), node("wcp-service-v2/b.go"), node("wcp-service-v2/c.go"), node("wcp-ui/d.tsx")],
  });
  const shares = census.rows.map((row) => row.retainedShareBp);
  for (const share of shares) assert.equal(Number.isInteger(share), true);
  assert.equal(shares.reduce((sum, value) => sum + value, 0), 10_000);
  assert.equal(census.rows.find((row) => row.module === "wcp-ui")?.retainedShareBp, 2500);
});

test("an empty scope produces every census row at zero rather than an empty table", () => {
  const census = buildScopeCensus({ roots: ROOTS, pool: [], retained: [] });
  assert.equal(census.rows.length, 3);
  assert.equal(census.summary.retainedNodes, 0);
  assert.equal(census.summary.zeroHitModules, 3, "nothing was investigated, and the table says so plainly");
  assert.deepEqual(census.rows.map((row) => row.retainedShareBp), [0, 0, 0], "no division by zero");
});

test("rows are ordered deterministically, so the artifact is byte-stable", () => {
  const build = (roots: typeof ROOTS) => buildScopeCensus({ roots, pool: [], retained: [] }).rows.map((row) => row.module);
  assert.deepEqual(build(ROOTS), ["wcp-auth", "wcp-service-v2", "wcp-ui"]);
  assert.deepEqual(build([...ROOTS].reverse()), ["wcp-auth", "wcp-service-v2", "wcp-ui"],
    "input order must not reach the output");
  assert.equal(SCOPE_CENSUS_VERSION, "scope-census-v1");
});

// THE WIRING, not just the construction. A mechanism nothing calls is deletable with every test above still
// green — that has happened four slices in a row on this project, so the artifact path gets its own test:
// prepare must write the table, and audit must report an unexplained module as an advisory.
test("prepare writes the table and audit reports an unexplained module", async () => {
  const { prepareRun, auditRun } = await import("../src/run/run.ts");
  const { copyFixture, createCodeGraphFixture, tempDir } = await import("./helpers.ts");
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);

  // A SECOND root whose vocabulary has nothing to do with the feature, added here rather than to the shared
  // fixture so no other test's numbers move. Without it the warning branch below is dead code: the shared
  // fixture has one root that the leave vocabulary always hits, so `zeroHitModules` would be 0 forever and
  // deleting the advisory in run.ts would leave the whole suite green.
  // The file must exist in the TARGET too, not just in the graph: the census queries join `allowed_files`,
  // which is fixed from the snapshot's file set. A graph node for a path the snapshot never scanned is
  // invisible to the census — worth knowing, because it means the census baseline inherits snapshot
  // admission (a `maxFiles` truncation would quietly shrink this denominator).
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(target, "billing"), { recursive: true });
  await writeFile(join(target, "billing", "invoice.ts"), "export function renderInvoiceTotals(rows: number[]): number {\n  return rows.reduce((a, b) => a + b, 0);\n}\n", "utf8");

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(codegraph);
  db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("billing/invoice.ts", "hash", "typescript", 120, Date.now(), Date.now(), 1, "[]");
  db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("fn-billing", "function", "renderInvoiceTotals", "renderInvoiceTotals", "billing/invoice.ts", "typescript", 7, 7, 1, 40, null, "function renderInvoiceTotals", "private", 0, 0, 0, 0, "[]", "[]", null, Date.now());
  db.close();
  const { runDir } = await prepareRun({
    target, codegraph, workdir, language: "en-US", detailLevel: "standard", overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["product"] }],
    budgets: { prepareMs: 60_000, authorMs: 60_000, maxGraphQueries: 40, maxSourceWindows: 40, maxSourceCharacters: 200_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 },
  } as never);

  const written = (await readdir(join(runDir, "context"))).filter((name) => name.endsWith(".scope-census.json"));
  assert.equal(written.length, 1, "prepare writes one table per feature — the artifact path is connected");

  const census = JSON.parse(await readFile(join(runDir, "context", written[0]), "utf8")) as
    { version: string; rows: Array<{ module: string; retainedNodes: number; censusNodes: number; status: { kind: string } }>; summary: Record<string, number> };
  assert.equal(census.version, "scope-census-v1");
  assert.ok(census.rows.length > 0, "the census produced rows");
  assert.equal(census.summary.censusModules, census.summary.countedModules + census.summary.excludedModules + census.summary.zeroHitModules,
    "and the accounting balances on a real prepare, not just on synthetic input");

  // The advisory is the operator-facing half. Whether this fixture happens to have an unexplained module is
  // not the point — the point is that when it does, the finding exists and names it.
  // `billing` holds nodes the census knows and the feature never touched — so the alarm MUST fire, and this
  // assertion is unconditional. A conditional one would let the advisory be deleted without going red.
  assert.equal(census.summary.zeroHitModules >= 1, true, "the second root is unexplained by construction");
  const billing = census.rows.find((row) => row.module === "billing");
  assert.ok(billing, "and it has a row");
  assert.deepEqual(billing.status, { kind: "zero-hit" });
  assert.equal(billing.retainedNodes, 0);
  assert.ok(billing.censusNodes > 0, "with a nonzero census count — the zero baseline is real, not empty");

  const { findings } = await auditRun(runDir);
  const scopeFindings = findings.filter((finding) => /scope-census/.test(finding.message));
  assert.equal(scopeFindings.length, 1, "an unexplained module must reach the operator");
  assert.equal(scopeFindings[0].level, "warning", "advisory first: the reading is collected before it gates");
  assert.match(scopeFindings[0].message, /billing/, "the finding names the module");
  assert.match(scopeFindings[0].message, /conditional reading/, "and says the percentages are conditional");
});

// "No table" and "the table says everything is accounted for" must not look the same on disk. The first
// version of this slice wrote nothing on source-fallback runs, which is exactly the flattening the module
// argues against — review caught it, and this pins the correction.
test("a run with no graph writes an explicit unavailable record, and audit reports it", async () => {
  const { prepareRun, auditRun } = await import("../src/run/run.ts");
  const { copyFixture, tempDir } = await import("./helpers.ts");
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  // No `codegraph` and `codegraphMode: "off"`: the source-only path, where there is no census to build.
  const { runDir } = await prepareRun({
    target: await copyFixture(), workdir: await tempDir(), language: "en-US", detailLevel: "standard",
    codegraphMode: "off", overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave"], audiences: ["product"] }],
    budgets: { prepareMs: 60_000, authorMs: 60_000, maxGraphQueries: 40, maxSourceWindows: 40, maxSourceCharacters: 200_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 },
  } as never);

  const written = (await readdir(join(runDir, "context"))).filter((name) => name.endsWith(".scope-census.json"));
  assert.equal(written.length, 1, "the feature still gets a file — absence is stated, not implied by omission");
  const record = JSON.parse(await readFile(join(runDir, "context", written[0]), "utf8")) as { reason?: string; detail?: string };
  assert.equal(record.reason, "no-graph");
  assert.match(String(record.detail), /not evidence that every module was covered/,
    "and it says what the absence does NOT mean");

  const scopeFindings = (await auditRun(runDir)).findings.filter((finding) => /scope-census/.test(finding.message));
  assert.equal(scopeFindings.length, 1, "reported, not silently skipped");
  assert.match(scopeFindings[0].message, /no module accounting/);
});
