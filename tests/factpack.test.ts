import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { FACT_PACK_CATEGORIES, buildFactPack, factPackEvidence, factPackEvidenceId } from "../src/factpack.ts";
import { CodeGraphIndex } from "../src/codegraph.ts";
import { SourceReader } from "../src/source.ts";
import { scanFiles } from "../src/snapshot.ts";
import { buildContexts } from "../src/context.ts";
import { prepareRun } from "../src/run.ts";
import { Deadline, stableJson } from "../src/util.ts";
import type { EvidenceItem, FactPackCategory, FeatureFactPack, GraphNode, ReportRequest } from "../src/types.ts";
import { copyFixture, createCodeGraphFixture, createCodeGraphSchema, insertGraphFile, insertGraphNode, tempDir } from "./helpers.ts";

const BOUNDARY_SOURCES: Record<string, string> = {
  "src/api/leave-routes.ts": `import { Hono } from "hono";
export const app = new Hono();
const router = app;
app.get("/leave", listLeave);
app.post("/leave/:id/approve", approveLeave);
router.delete("/leave/:id", cancelLeave);
`,
  "src/models/leave-request.ts": `export class LeaveRequest {
  id: string;
  employeeId: string;
  status: LeaveStatus;
  hours: number;
}
`,
  "src/models/leave-status.ts": `export enum LeaveStatus {
  Pending = "pending",
  Approved = "approved",
  Cancelled = "cancelled",
}
export const DEFAULT_LEAVE_STATE = LeaveStatus.Pending;
`,
  "src/leave-config.ts": `export const port = Number(process.env.LEAVE_PORT ?? 3000);
export const mailFrom = process.env.MAIL_FROM;
export const region = config.get("leave.region");
export const smtpHost = process.env.SMTP_HOST ?? process.env.MAIL_HOST;
`,
  "src/jobs/leave-reminder.ts": `import cron from "node-cron";
cron.schedule("0 9 * * 1", sendLeaveReminders);
setInterval(pollPendingLeave, 60000);
`,
  "src/leave-notify.ts": `import nodemailer from "nodemailer";
export async function notifyApprover(payload: unknown) {
  await fetch("https://example.test/leave-webhook", { method: "POST" });
}
`
};

interface Boundary {
  target: string;
  workdir: string;
  files: Awaited<ReturnType<typeof scanFiles>>;
  paths: string[];
  reader: SourceReader;
  graph: CodeGraphIndex | null;
  nodes: GraphNode[];
}

async function scannedBoundary(sources: Record<string, string>): Promise<Boundary> {
  const target = await tempDir();
  const workdir = await tempDir();
  for (const [relativePath, content] of Object.entries(sources)) {
    await mkdir(join(target, relativePath, ".."), { recursive: true });
    await writeFile(join(target, relativePath), content);
  }
  const files = await scanFiles(target);
  return {
    target,
    workdir,
    files,
    paths: files.map((file) => file.relativePath),
    reader: new SourceReader({ target, snapshotId: "snapshot-fact-pack", cacheDir: join(workdir, "cache"), maxWindows: 20, maxCharacters: 100_000 }),
    graph: null,
    nodes: []
  };
}

async function boundary(withGraph: boolean): Promise<Boundary> {
  const scope = await scannedBoundary(BOUNDARY_SOURCES);
  if (!withGraph) return scope;
  const { workdir, paths } = scope;

  const dbPath = join(workdir, "codegraph.db");
  const db: DatabaseSync = createCodeGraphSchema(dbPath);
  insertGraphFile(db, "src/api/leave-routes.ts");
  insertGraphFile(db, "src/models/leave-request.ts");
  insertGraphFile(db, "src/models/leave-status.ts");
  insertGraphNode(db, { id: "route-leave", kind: "route", name: "GET /leave", filePath: "src/api/leave-routes.ts", startLine: 4, endLine: 4, signature: "app.get(\"/leave\", listLeave)" });
  insertGraphNode(db, { id: "model-leave", kind: "class", name: "LeaveRequest", filePath: "src/models/leave-request.ts", startLine: 1, endLine: 6, signature: "class LeaveRequest" });
  insertGraphNode(db, { id: "enum-leave", kind: "enum", name: "LeaveStatus", filePath: "src/models/leave-status.ts", startLine: 1, endLine: 5, signature: "enum LeaveStatus" });
  db.close();
  const graph = new CodeGraphIndex(dbPath, 40, new Deadline(30_000, "fact pack test"), paths);
  return { ...scope, graph, nodes: graph.searchNodes(["leave"], 50) };
}

function pack(scope: Boundary, limits?: { maxItemsPerCategory?: number; maxEntityWindows?: number }): Promise<FeatureFactPack> {
  return buildFactPack({
    snapshotId: "snapshot-fact-pack",
    featureKey: "leave-management-abc123",
    nodes: scope.nodes,
    boundaryFiles: scope.paths,
    files: scope.files,
    graph: scope.graph,
    sourceReader: scope.reader,
    limits
  });
}

function items(factPack: FeatureFactPack, category: FactPackCategory): Array<{ name: string; location: string; source: string }> {
  return factPack.items.filter((item) => item.category === category).map((item) => ({ name: item.name, location: `${item.filePath}:${item.line}`, source: item.source }));
}

function coverage(factPack: FeatureFactPack, category: FactPackCategory) {
  return factPack.coverage.find((entry) => entry.category === category)!;
}

test("a fact pack enumerates every category inside the boundary and prefers the graph over a scanned line", async () => {
  const scope = await boundary(true);
  const factPack = await pack(scope);
  scope.graph?.close();

  assert.equal(factPack.version, "factpack-v1");
  assert.deepEqual(factPack.coverage.map((entry) => entry.category), FACT_PACK_CATEGORIES);

  assert.deepEqual(items(factPack, "entrypoints"), [
    { name: "GET /leave", location: "src/api/leave-routes.ts:4", source: "graph" },
    { name: "app.post /leave/:id/approve", location: "src/api/leave-routes.ts:5", source: "scan" },
    { name: "router.delete /leave/:id", location: "src/api/leave-routes.ts:6", source: "scan" }
  ]);
  assert.equal(coverage(factPack, "entrypoints").method, "graph+scan");

  const entity = factPack.items.find((item) => item.category === "entities");
  assert.equal(entity?.name, "LeaveRequest");
  assert.equal(entity?.filePath, "src/models/leave-request.ts");
  assert.equal(entity?.detail, "id: string; employeeId: string; status: LeaveStatus; hours: number");
  assert.equal(coverage(factPack, "entities").method, "graph");

  assert.deepEqual(items(factPack, "states"), [
    { name: "LeaveStatus", location: "src/models/leave-status.ts:1", source: "graph" },
    { name: "const DEFAULT_LEAVE_STATE =", location: "src/models/leave-status.ts:6", source: "scan" }
  ]);

  assert.deepEqual(items(factPack, "config-keys").map((item) => item.name), ["LEAVE_PORT", "MAIL_FROM", "leave.region", "MAIL_HOST", "SMTP_HOST"]);
  assert.deepEqual(items(factPack, "jobs").map((item) => item.location), [
    "src/jobs/leave-reminder.ts:1",
    "src/jobs/leave-reminder.ts:2",
    "src/jobs/leave-reminder.ts:3"
  ]);
  const schedule = factPack.items.find((item) => item.category === "jobs" && item.line === 2);
  assert.equal(schedule?.detail, `cron.schedule("0 9 * * 1", sendLeaveReminders);`, "two patterns matching one line describe one job, not two");
  assert.deepEqual(items(factPack, "external-calls").map((item) => `${item.name} @${item.location}`), [
    "nodemailer @src/leave-notify.ts:1",
    "notifyApprover @src/leave-notify.ts:2",
    "fetch https://example.test/leave-webhook @src/leave-notify.ts:3"
  ]);
  assert.deepEqual(factPack.warnings, []);
  assert.ok(factPack.coverage.every((entry) => !entry.truncated));
});

test("a fact pack without CodeGraph scans what it can and reports the graph-only category as unavailable", async () => {
  const scope = await boundary(false);
  const factPack = await pack(scope);

  assert.deepEqual(
    factPack.coverage.map((entry) => [entry.category, entry.method]),
    [["entrypoints", "scan"], ["entities", "none"], ["states", "scan"], ["config-keys", "scan"], ["jobs", "scan"], ["external-calls", "scan"]]
  );
  assert.equal(coverage(factPack, "entities").itemCount, 0);
  assert.deepEqual(items(factPack, "entrypoints").map((item) => item.name), ["app.get /leave", "app.post /leave/:id/approve", "router.delete /leave/:id"]);
  assert.ok(factPack.items.every((item) => item.source === "scan"));
});

test("the same snapshot and scope build a byte-identical fact pack", async () => {
  const scope = await boundary(true);
  const first = await pack(scope);
  const second = await pack(scope);
  scope.graph?.close();
  assert.equal(stableJson(first), stableJson(second));
});

test("a cap is reported through coverage, a note and a warning instead of silence", async () => {
  const scope = await boundary(true);
  const starved = await pack(scope, { maxItemsPerCategory: 1 });

  const entrypoints = coverage(starved, "entrypoints");
  assert.equal(entrypoints.itemCount, 1);
  assert.equal(entrypoints.truncated, true);
  assert.match(entrypoints.note ?? "", /source scan returned the maximum 1 matches/);
  assert.ok(starved.warnings.some((warning) => /Fact pack category entrypoints is incomplete: source scan returned the maximum 1 matches/.test(warning)));

  // Four scanned config lines carry five keys, so the item cap binds after the scan.
  const capped = await pack(scope, { maxItemsPerCategory: 4 });
  scope.graph?.close();
  const configKeys = coverage(capped, "config-keys");
  assert.equal(configKeys.itemCount, 4);
  assert.equal(configKeys.truncated, true);
  assert.match(configKeys.note ?? "", /item cap 4 reached; 1 further config-keys item was dropped/);
  assert.equal(coverage(capped, "entities").truncated, false, "a category inside its cap must not be marked truncated");
});

test("entity field windows stay inside their own budget and say so", async () => {
  const scope = await boundary(true);
  const factPack = await pack(scope, { maxEntityWindows: 0 });
  scope.graph?.close();

  const entities = coverage(factPack, "entities");
  assert.equal(entities.itemCount, 1, "the entity is still enumerated when its field window is not opened");
  assert.equal(entities.truncated, true);
  assert.match(entities.note ?? "", /entity field windows capped at 0; 1 later entities carry only their graph signature/);
  assert.equal(factPack.items.find((item) => item.category === "entities")?.detail, "class LeaveRequest");
});

test("a config key used in several places is enumerated once and keeps its occurrence count", async () => {
  const scope = await scannedBoundary({
    "src/config.ts": "export const mailFrom = process.env.MAIL_FROM;\n",
    "src/mailer.ts": "const from = process.env.MAIL_FROM;\nconst host = process.env.MAIL_HOST;\n"
  });
  const factPack = await pack(scope);
  const keys = factPack.items.filter((item) => item.category === "config-keys");

  assert.deepEqual(keys.map((item) => `${item.name}@${item.filePath}:${item.line}`), ["MAIL_FROM@src/config.ts:1", "MAIL_HOST@src/mailer.ts:2"]);
  assert.match(keys[0].detail ?? "", /\(\+1 further occurrence\)$/);
});

test("every category carries one derived evidence item, including the empty ones", async () => {
  const scope = await boundary(false);
  const factPack = await pack(scope);
  const evidence = factPackEvidence(factPack);

  assert.deepEqual(evidence.map((item) => item.id), FACT_PACK_CATEGORIES.map((category) => `FACT-leave-mana-${category}-snapshot`));
  assert.ok(evidence.every((item) => item.kind === "derived" && item.snapshotId === "snapshot-fact-pack"));
  const entities = evidence.find((item) => item.id.includes("-entities-"))!;
  assert.deepEqual((entities.data as { items: unknown[] }).items, [], "an empty category is still stated as a fact");
});

test("the sample target's fact pack enumerates its Hono route and reports the empty categories honestly", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const db = join(workdir, "codegraph.db");
  createCodeGraphFixture(db);
  const request: ReportRequest = {
    target,
    codegraph: db,
    language: "zh-CN",
    detailLevel: "detailed",
    workdir,
    overviewAudiences: [],
    features: [{ subject: "请假管理", aliases: ["leave", "holiday"], audiences: ["engineering"] }],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 60, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 60, maxExpansionDepth: 2 }
  };
  const result = await buildContexts(request);
  const [key, factPack] = [...result.prepared.featureFactPacks.entries()][0];

  assert.deepEqual(items(factPack, "entrypoints"), [{ name: "GET /leave", location: "src/server.ts:5", source: "graph" }]);
  assert.deepEqual(
    factPack.coverage.map((entry) => [entry.category, entry.itemCount, entry.truncated]),
    [["entrypoints", 1, false], ["entities", 0, false], ["states", 0, false], ["config-keys", 0, false], ["jobs", 0, false], ["external-calls", 0, false]]
  );
  assert.ok(result.prepared.featureScopes.get(key)!.files.includes("src/LeavePanel.vue"), "the Vue entry file is inside the boundary the pack was built from");

  const evidenceIds = new Set(result.prepared.evidence.map((item) => item.id));
  for (const category of FACT_PACK_CATEGORIES) assert.ok(evidenceIds.has(factPackEvidenceId(key, category, factPack.snapshotId)), `missing fact pack evidence for ${category}`);
});

test("prepare writes the fact pack as JSON, as a markdown section and as per-category evidence", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const { runDir, manifest } = await prepareRun({
    target,
    codegraphMode: "off",
    language: "zh-CN",
    detailLevel: "detailed",
    workdir,
    overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["engineering"] }],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 10, maxSourceWindows: 70, maxSourceCharacters: 160_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  });
  const key = manifest.documents[0].id.replace(/^feature-/, "").replace(/-engineering$/, "");

  const factPack = JSON.parse(await readFile(join(runDir, "context", "features", `${key}.factpack.json`), "utf8")) as FeatureFactPack;
  assert.equal(factPack.version, "factpack-v1");
  assert.equal(factPack.featureKey, key);
  assert.equal(factPack.snapshotId, manifest.snapshot?.id);
  assert.deepEqual(factPack.coverage.map((entry) => entry.category), FACT_PACK_CATEGORIES);
  assert.ok(factPack.items.every((item) => item.filePath && item.line > 0 && item.name && ["graph", "scan"].includes(item.source)));
  assert.deepEqual(items(factPack, "entrypoints"), [{ name: "app.get /leave", location: "src/server.ts:5", source: "scan" }]);

  const context = await readFile(join(runDir, "context", "features", `${key}.md`), "utf8");
  assert.match(context, /## Authoring inventory/);
  assert.match(context, /## Fact pack/);
  assert.match(context, new RegExp(`### entrypoints — 1 item, method scan, evidence ${factPackEvidenceId(key, "entrypoints", factPack.snapshotId)}`));
  assert.match(context, /\| app\.get \/leave \| `src\/server\.ts:5` \| scan \|/);
  assert.match(context, /### jobs — 0 items, method scan/);
  assert.match(context, /### entities — 0 items, method none[\s\S]*?absence here is not evidence of absence in the code/);
  assert.match(context, new RegExp(`context/features/${key}\\.factpack\\.json`));

  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  const factEvidence = catalog.evidence.filter((item) => item.id.startsWith("FACT-"));
  assert.equal(factEvidence.length, 6);
  assert.ok(factEvidence.every((item) => item.kind === "derived" && item.snapshotId === manifest.snapshot?.id));
});

test("detailed feature prompts require item-by-item fact pack coverage; overview prompts do not", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const { runDir, manifest } = await prepareRun({
    target,
    codegraphMode: "off",
    language: "zh-CN",
    detailLevel: "detailed",
    workdir,
    overviewAudiences: ["engineering"],
    features: [{ subject: "Leave management", aliases: ["leave"], audiences: ["engineering"] }],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 10, maxSourceWindows: 70, maxSourceCharacters: 160_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  });
  const featureDocument = manifest.documents.find((document) => document.kind === "feature")!;
  const key = featureDocument.id.replace(/^feature-/, "").replace(/-engineering$/, "");
  const prompt = await readFile(join(runDir, "prompts", `${featureDocument.id}.md`), "utf8");

  assert.match(prompt, /## Fact pack/);
  assert.match(prompt, new RegExp(`context/features/${key}\\.factpack\\.json`));
  assert.match(prompt, /must cover every fact pack item of the matching category/);
  assert.match(prompt, /explicitly counted group/);
  assert.match(prompt, /Cite the category's `FACT-\*` evidence id/);
  assert.match(prompt, /truncated must be reported as incomplete/);

  const overviewPrompt = await readFile(join(runDir, "prompts", "overview-engineering.md"), "utf8");
  assert.ok(!/fact pack/i.test(overviewPrompt), "an overview has no feature fact pack to enumerate");
});
