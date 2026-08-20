import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type { InvestigationPlan, RunManifest } from "../src/base/types.ts";
import { updateWorkItems } from "../src/run/run.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";

export async function tempDir(prefix = "excavator-test-"): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

/**
 * Dispose every work item as `not-applicable` with a reason so a synthetic run satisfies the freeze
 * gate (all required items disposed, no `found` material flow needing a trace). Routes through
 * `updateWorkItems`, which keeps `checklist.json` in sync, so the disposed run also audits clean.
 */
export async function disposeAllWorkItems(runDir: string): Promise<void> {
  const plan = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as InvestigationPlan;
  await updateWorkItems(runDir, plan.items.map((item) => ({
    id: item.id,
    status: "not-applicable" as const,
    material: false,
    reason: "Out of scope for the synthetic fixture snapshot."
  })));
}

/**
 * Put a validated plan in place after freeze, so authoring can start.
 *
 * The plan is derived from the run's own catalog by `buildFixturePlan` and goes through the same validator a
 * model's proposal has to pass — so no test depends on a model for its preconditions, and the authoring
 * precondition is exercised rather than bypassed.
 */
export async function installFixturePlan(runDir: string): Promise<void> {
  await planRun(runDir, { mode: "fixture" });
}

/**
 * One run's manifest, off disk.
 *
 * Every load that projects a knowledge epoch takes the manifest — it is what selects WHICH epoch — so tests read
 * the run's own `run.json` rather than building a manifest beside it. A hand-built one would let a test project an
 * epoch the run on disk is not at, which is the exact confusion the required parameter exists to prevent.
 */
export async function manifestOf(runDir: string): Promise<RunManifest> {
  return JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
}

export async function copyFixture(name = "sample-target"): Promise<string> {
  const target = await tempDir();
  await cp(resolve("tests/fixtures", name), target, { recursive: true });
  return target;
}

export interface GraphNodeFixture {
  id: string;
  kind: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string | null;
}

export function insertGraphFile(db: DatabaseSync, path: string, nodeCount = 1, language = "typescript"): void {
  db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(path, `hash-${path}`, language, 400, Date.now(), Date.now(), nodeCount, "[]");
}

export function insertGraphNode(db: DatabaseSync, node: GraphNodeFixture, language = "typescript"): void {
  db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    node.id, node.kind, node.name, node.name, node.filePath, language, node.startLine, node.endLine, 1, 80,
    null, node.signature ?? null, "public", 1, 0, 0, 0, "[]", "[]", null, Date.now()
  );
}

export function createCodeGraphSchema(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, node_count INTEGER DEFAULT 0, errors TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_column INTEGER NOT NULL, end_column INTEGER NOT NULL, docstring TEXT, signature TEXT, visibility TEXT, is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0, is_static INTEGER DEFAULT 0, is_abstract INTEGER DEFAULT 0, decorators TEXT, type_parameters TEXT, return_type TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, metadata TEXT, line INTEGER, col INTEGER, provenance TEXT DEFAULT NULL);
    CREATE TABLE unresolved_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, from_node_id TEXT NOT NULL, reference_name TEXT NOT NULL, reference_kind TEXT NOT NULL, line INTEGER NOT NULL, col INTEGER NOT NULL, candidates TEXT, file_path TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'unknown', status TEXT NOT NULL DEFAULT 'pending', name_tail TEXT NOT NULL DEFAULT '');
    CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO project_metadata VALUES (?, ?, ?)").run("index_state", "complete", Date.now());
  db.prepare("INSERT INTO project_metadata VALUES (?, ?, ?)").run("indexed_with_version", "test", Date.now());
  return db;
}

export function createCodeGraphFixture(path: string): void {
  const db = createCodeGraphSchema(path);
  db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("src/server.ts", "hash", "typescript", 300, Date.now(), Date.now(), 4, "[]");
  const insertNode = db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insertNode.run("route-1", "route", "GET /leave", "GET /leave", "src/server.ts", "typescript", 5, 5, 1, 50, null, "app.get('/leave', requireManager, listLeave)", "public", 0, 0, 0, 0, "[]", "[]", null, Date.now());
  insertNode.run("fn-1", "function", "requireManager", "requireManager", "src/server.ts", "typescript", 3, 3, 1, 80, null, "function requireManager", "private", 0, 0, 0, 0, "[]", "[]", null, Date.now());
  insertNode.run("fn-2", "function", "listLeave", "listLeave", "src/server.ts", "typescript", 4, 4, 1, 60, null, "function listLeave", "private", 0, 0, 0, 0, "[]", "[]", null, Date.now());
  db.prepare("INSERT INTO edges (source,target,kind,metadata,line,col) VALUES (?,?,?,?,?,?)").run("route-1", "fn-1", "references", JSON.stringify({ confidence: 0.9, refName: "requireManager" }), 5, 20);
  db.prepare("INSERT INTO edges (source,target,kind,metadata,line,col) VALUES (?,?,?,?,?,?)").run("route-1", "fn-2", "references", JSON.stringify({ confidence: 0.9, refName: "listLeave" }), 5, 35);
  db.close();
}
