import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { buildContexts } from "../src/context/context.ts";
import { CodeGraphIndex } from "../src/codegraph/codegraph.ts";
import { Deadline } from "../src/base/util.ts";
import { createSnapshot, scanFiles } from "../src/snapshot/snapshot.ts";
import { selectProjectDocuments, sourceSearch } from "../src/snapshot/source.ts";
import type { ReportRequest } from "../src/base/types.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

const execFileAsync = promisify(execFile);

async function initGit(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
}

function request(target: string, db: string | undefined, workdir: string): ReportRequest {
  return {
    target,
    codegraph: db,
    language: "zh-CN",
    detailLevel: "standard",
    workdir,
    overviewAudiences: ["product", "engineering"],
    features: [{ subject: "请假管理", aliases: ["leave", "holiday"], audiences: ["product", "engineering"] }],
    budgets: {
      prepareMs: 30_000,
      authorMs: 30_000,
      maxGraphQueries: 40,
      maxSourceWindows: 30,
      maxSourceCharacters: 100_000,
      maxFiles: 10_000,
      maxFeatureNodes: 50,
      maxExpansionDepth: 2
    }
  };
}

test("shared and feature contexts are reused across audiences and later runs", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const db = join(workdir, "codegraph.db");
  createCodeGraphFixture(db);

  const first = await buildContexts(request(target, db, workdir));
  assert.equal(first.prepared.documentContexts.size, 4);
  assert.ok(first.stats.graphQueries > 0);
  assert.ok(first.stats.sourceWindows > 0);
  assert.ok((first.stats.codegraphCoverage?.ratio ?? 1) < 1, "the Vue source is intentionally absent from CodeGraph");
  assert.match(first.prepared.sharedMarkdown, /source fallback/i);
  assert.equal(first.stats.cache.shared, "miss");

  const second = await buildContexts(request(target, db, workdir));
  assert.equal(second.stats.cache.shared, "hit");
  assert.ok(Object.entries(second.stats.cache).some(([key, value]) => key.startsWith("feature:") && value === "hit"));
  assert.equal(second.stats.graphQueries, 0, "cached contexts must not repeat graph reads");
  assert.equal(second.stats.sourceWindows, 0, "cached contexts must not repeat source reads");
});

// THE COVERAGE DENOMINATOR IS THE LEDGER'S, NOT A LOCAL PREDICATE'S.
//
// `eligible` used to be `files.filter(isLikelySource)` — nine hardcoded extensions in `snapshot.ts`. The ratio
// built on it was published in the model view and quoted in a real report as a fact: "1,639/1,719 = 95.3%" on
// wcp, where 1,719 is 1,999 counted minus 280 files the denylist named and appears in no ledger at all.
//
// The fixture makes the difference visible rather than asserting an equality that both versions satisfy: the
// `.scss` and `.md` files below are exactly what the old denylist removed. If the denominator goes back to a
// predicate, `counted` drops by four and this fails.
test("the CodeGraph coverage denominator counts every scanned file, not a hand-picked source subset", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const db = join(workdir, "codegraph.db");
  createCodeGraphFixture(db);

  // Four files no code index would ever hold, in the extensions the retired denylist named.
  await writeFile(join(target, "theme.scss"), "$brand: #123456;\n.button { color: $brand; }\n", "utf8");
  await writeFile(join(target, "layout.css"), ".row { display: flex; }\n", "utf8");
  await writeFile(join(target, "NOTES.md"), "# Notes\n\nNothing structural here.\n", "utf8");
  await writeFile(join(target, "fixture.json"), JSON.stringify({ sample: true }) + "\n", "utf8");

  const result = await buildContexts(request(target, db, workdir));
  const coverage = result.stats.codegraphCoverage;
  assert.ok(coverage, "a run with a graph publishes coverage");

  const scanned = await scanFiles(target, 10_000);
  assert.equal(coverage.counted, scanned.length,
    "the denominator is the counted row set; a predicate that drops non-source extensions would report fewer");
  assert.equal(coverage.ratio, coverage.indexed / coverage.counted, "and the ratio is those two numbers");

  // The split is reported as observation, not asserted as a rule — the point of replacing the denylist. Each
  // added file lands in its own language row rather than being removed from the denominator.
  const byLanguage = new Map(coverage.byLanguage.map((row) => [row.language, row]));
  for (const language of ["scss", "css", "markdown", "json"]) {
    const row = byLanguage.get(language);
    assert.ok(row && row.counted >= 1, `${language} is a visible row rather than a silent subtraction: ${JSON.stringify(coverage.byLanguage)}`);
    assert.equal(row.indexed, 0, `${language} is genuinely unindexed here, which is what makes the row informative`);
  }
  assert.equal(coverage.byLanguage.reduce((sum, row) => sum + row.counted, 0), coverage.counted,
    "the language rows partition the counted set exactly");
  assert.equal(coverage.byLanguage.reduce((sum, row) => sum + row.indexed, 0), coverage.indexed,
    "and their indexed counts add up to the aggregate");
});

test("source-only mode remains usable when CodeGraph is absent", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const result = await buildContexts(request(target, undefined, workdir));
  assert.equal(result.stats.graphQueries, 0);
  assert.equal(result.stats.codegraphCoverage?.ratio, 0);
  assert.ok(result.stats.sourceWindows > 0);
  assert.ok(result.stats.warnings.some((warning) => /No CodeGraph/i.test(warning)));
  const featureContext = [...result.prepared.featureMarkdowns.values()][0] ?? "";
  assert.match(featureContext, /LeavePanel|server\.ts|leave/i);
});


test("feature fallback merges overlapping search windows in the same file", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const result = await buildContexts(request(target, undefined, workdir));
  const fallback = result.prepared.evidence.filter((item) => item.reason.includes("feature source fallback") && item.path);
  const byPath = new Map<string, Array<{ start: number; end: number }>>();
  for (const item of fallback) {
    const ranges = byPath.get(item.path!) ?? [];
    ranges.push({ start: item.startLine!, end: item.endLine! });
    byPath.set(item.path!, ranges);
  }
  for (const [path, ranges] of byPath) {
    ranges.sort((a, b) => a.start - b.start);
    for (let index = 1; index < ranges.length; index += 1) {
      assert.ok(ranges[index].start > ranges[index - 1].end, `${path} contains overlapping fallback windows`);
    }
  }
});

test("starved evidence collection reports truncation instead of silently stopping", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const starved = request(target, undefined, workdir);
  starved.budgets.maxSourceWindows = 1;

  const result = await buildContexts(starved);
  const truncation = result.stats.warnings.filter((warning) => /evidence truncated at/.test(warning));
  assert.ok(truncation.length > 0, `expected a truncation warning, got ${JSON.stringify(result.stats.warnings)}`);
  assert.ok(truncation.every((warning) => /^Feature "请假管理" evidence truncated at .+: .+/.test(warning)));
  assert.ok(truncation.some((warning) => /Source window budget exceeded/.test(warning)), "the warning must carry the underlying budget cause");

  const featureContext = [...result.prepared.featureMarkdowns.values()][0] ?? "";
  assert.match(featureContext, /- Evidence truncation: .*evidence truncated at/);
});

test("a feature context with an ample window budget records no truncation", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const result = await buildContexts(request(target, undefined, workdir));
  const featureContext = [...result.prepared.featureMarkdowns.values()][0] ?? "";
  assert.match(featureContext, /- Evidence truncation: none/);
  assert.ok(!result.stats.warnings.some((warning) => /evidence truncated at/.test(warning)));
});

test("project document selection skips empty files and deduplicates generated API formats per root", () => {
  const files = [
    { absolutePath: "/x/a/README.md", relativePath: "a/README.md", size: 20, extension: ".md", rootName: "a" },
    { absolutePath: "/x/a/swagger.json", relativePath: "a/swagger.json", size: 1000, extension: ".json", rootName: "a" },
    { absolutePath: "/x/a/swagger.yaml", relativePath: "a/swagger.yaml", size: 900, extension: ".yaml", rootName: "a" },
    { absolutePath: "/x/a/Makefile", relativePath: "a/Makefile", size: 0, extension: "", rootName: "a" }
  ];
  const selected = selectProjectDocuments(files, 10);
  assert.ok(selected.some((file) => file.relativePath === "a/README.md"));
  assert.equal(selected.filter((file) => /swagger/.test(file.relativePath)).length, 1);
  assert.ok(selected.some((file) => file.relativePath === "a/swagger.yaml"));
  assert.ok(!selected.some((file) => file.relativePath.endsWith("Makefile")));
});

test("project document selection ranks contract-facing files ahead of the README", () => {
  const files = [
    { absolutePath: "/x/README.md", relativePath: "README.md", size: 4000, extension: ".md", rootName: "root" },
    { absolutePath: "/x/src/routes/user.ts", relativePath: "src/routes/user.ts", size: 800, extension: ".ts", rootName: "root" },
    { absolutePath: "/x/schema.graphql", relativePath: "schema.graphql", size: 1200, extension: ".graphql", rootName: "root" },
    { absolutePath: "/x/package.json", relativePath: "package.json", size: 600, extension: ".json", rootName: "root" }
  ];
  const selected = selectProjectDocuments(files, 14);
  const readmeRank = selected.findIndex((file) => file.relativePath === "README.md");
  assert.ok(readmeRank >= 0, "the README stays eligible");
  for (const contract of ["src/routes/user.ts", "schema.graphql", "package.json"]) {
    const rank = selected.findIndex((file) => file.relativePath === contract);
    assert.ok(rank >= 0 && rank < readmeRank, `${contract} must rank ahead of the README (README at ${readmeRank}, ${contract} at ${rank})`);
  }
});

test("project document selection admits safe env, compose and front-end route config as candidates", () => {
  const files = [
    { absolutePath: "/x/.env.example", relativePath: ".env.example", size: 60, extension: ".example", rootName: "root" },
    { absolutePath: "/x/docker-compose.yml", relativePath: "docker-compose.yml", size: 300, extension: ".yml", rootName: "root" },
    { absolutePath: "/x/src/router/menu.ts", relativePath: "src/router/menu.ts", size: 500, extension: ".ts", rootName: "root" },
    { absolutePath: "/x/src/widget.ts", relativePath: "src/widget.ts", size: 500, extension: ".ts", rootName: "root" }
  ];
  const selected = new Set(selectProjectDocuments(files, 14).map((file) => file.relativePath));
  assert.ok(selected.has(".env.example"), "a non-secret env sample is a candidate");
  assert.ok(selected.has("docker-compose.yml"), "compose orchestration is a candidate");
  assert.ok(selected.has("src/router/menu.ts"), "front-end menu/route config is a candidate");
  assert.ok(!selected.has("src/widget.ts"), "a plain source file with no contract signal is not a project document");
});

test("project document selection stays diverse under the cap: README and entrypoints survive a route swarm", () => {
  const files = [
    { absolutePath: "/x/README.md", relativePath: "README.md", size: 1200, extension: ".md", rootName: "root" },
    { absolutePath: "/x/src/server.ts", relativePath: "src/server.ts", size: 400, extension: ".ts", rootName: "root" },
    { absolutePath: "/x/src/app.ts", relativePath: "src/app.ts", size: 400, extension: ".ts", rootName: "root" },
    { absolutePath: "/x/package.json", relativePath: "package.json", size: 300, extension: ".json", rootName: "root" },
    { absolutePath: "/x/Dockerfile", relativePath: "Dockerfile", size: 200, extension: "", rootName: "root" },
    { absolutePath: "/x/docker-compose.yml", relativePath: "docker-compose.yml", size: 200, extension: ".yml", rootName: "root" },
    { absolutePath: "/x/Makefile", relativePath: "Makefile", size: 200, extension: "", rootName: "root" },
    { absolutePath: "/x/openapi.yaml", relativePath: "openapi.yaml", size: 500, extension: ".yaml", rootName: "root" },
    // A route swarm large enough to fill the cap on its own if a single category could monopolize it.
    ...Array.from({ length: 10 }, (_, index) => ({
      absolutePath: `/x/src/routes/route${index}.ts`,
      relativePath: `src/routes/route${index}.ts`,
      size: 300,
      extension: ".ts",
      rootName: "root"
    }))
  ];
  const selected = selectProjectDocuments(files, 14);
  const paths = new Set(selected.map((file) => file.relativePath));
  assert.equal(selected.length, 14, "the cap is fully used");
  assert.ok(paths.has("README.md"), "the README is never dropped");
  assert.ok(paths.has("src/server.ts") && paths.has("src/app.ts"), "both entrypoints survive the route swarm");
  const routeCount = selected.filter((file) => file.relativePath.startsWith("src/routes/")).length;
  assert.ok(routeCount < selected.length - 3, `no single category monopolizes the cap (routes filled ${routeCount}/${selected.length})`);
  assert.notEqual(selected[0].relativePath, "README.md", "the README is de-weighted, never first");
});


test("source search supports regex and case sensitivity without matching identifier substrings", async () => {
  const root = await tempDir();
  const sourceDir = join(root, "src");
  await mkdir(sourceDir, { recursive: true });
  const todo = join(sourceDir, "todo.ts");
  const list = join(sourceDir, "TodoList.ts");
  await writeFile(todo, "// TODO: replace temporary branch\nexport const ready = false;\n");
  await writeFile(list, "export class MainTodoList {}\n");
  const todoStat = await stat(todo);
  const listStat = await stat(list);
  const files = [
    { absolutePath: todo, relativePath: "src/todo.ts", size: todoStat.size, extension: ".ts", rootName: "root" },
    { absolutePath: list, relativePath: "src/TodoList.ts", size: listStat.size, extension: ".ts", rootName: "root" }
  ];
  const matches = await sourceSearch(files, ["\\bTODO\\b"], { regex: true, caseSensitive: true, maxResults: 10, redact: false });
  assert.deepEqual(matches.map((match) => match.file.relativePath), ["src/todo.ts"]);
});

test("source search ranks subject source ahead of unrelated test and generated matches", async () => {
  const root = await tempDir();
  const paths = [
    ["src/leave/service.ts", "export function createLeaveRequest() { return 'leave request'; }\n"],
    ["tests/cache.test.ts", "test('ResponseWriter is safe when leave ETag is absent', () => {});\n"],
    ["docs/swagger.json", "{ \"description\": \"leave request\" }\n"]
  ] as const;
  const files = [];
  for (const [relativePath, content] of paths) {
    const absolutePath = join(root, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, content);
    const info = await stat(absolutePath);
    files.push({ absolutePath, relativePath, size: info.size, extension: relativePath.slice(relativePath.lastIndexOf(".")), rootName: "root" });
  }
  const matches = await sourceSearch(files, ["leave"], { maxResults: 10, redact: false });
  assert.equal(matches[0].file.relativePath, "src/leave/service.ts");
  assert.ok(matches[0].score > matches.find((match) => match.file.relativePath === "tests/cache.test.ts")!.score);
});


test("merged feature fallback reasons are deduplicated", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const result = await buildContexts(request(target, undefined, workdir));
  for (const item of result.prepared.evidence.filter((entry) => entry.reason.includes("feature source fallback"))) {
    const reasons = item.reason.split("; ");
    assert.equal(new Set(reasons).size, reasons.length, `${item.id} repeats a fallback reason`);
  }
});


test("workspace scanning excludes agent-tool metadata directories", async () => {
  const target = await copyFixture();
  const noise = join(target, ".claude", "skills", "noise.md");
  await mkdir(join(target, ".claude", "skills"), { recursive: true });
  await writeFile(noise, "# route controller permission migration schema\n");
  const files = await scanFiles(target);
  assert.ok(!files.some((file) => file.relativePath.includes("/.claude/") || file.relativePath.startsWith(".claude/")));
});

test("shared source fallback does not treat Markdown documentation as unsupported source", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const db = join(workdir, "codegraph.db");
  createCodeGraphFixture(db);
  const result = await buildContexts(request(target, db, workdir));
  const fallback = result.prepared.evidence.filter((item) => item.reason.includes("source file not represented by CodeGraph"));
  assert.ok(fallback.every((item) => !item.path?.endsWith(".md")));
});

test("workspace scanning includes safe environment templates but excludes real environment files", async () => {
  const target = await copyFixture();
  await writeFile(join(target, ".env"), "API_KEY=real-secret\n");
  await writeFile(join(target, ".env.production"), "API_KEY=real-secret\n");
  await writeFile(join(target, ".env.sample"), "API_KEY=${API_KEY}\nFEATURE_ENABLED=false\n");
  await writeFile(join(target, ".env.example"), "API_KEY=${API_KEY}\n");
  const files = await scanFiles(target);
  const paths = new Set(files.map((file) => file.relativePath));
  assert.ok(paths.has(".env.sample"));
  assert.ok(paths.has(".env.example"));
  assert.ok(!paths.has(".env"));
  assert.ok(!paths.has(".env.production"));
});


test("project document selection includes safe environment templates", () => {
  const files = [
    { absolutePath: "/x/.env.sample", relativePath: ".env.sample", size: 50, extension: ".sample", rootName: "root" },
    { absolutePath: "/x/package.json", relativePath: "package.json", size: 100, extension: ".json", rootName: "root" }
  ];
  const selected = selectProjectDocuments(files, 10);
  assert.ok(selected.some((file) => file.relativePath === ".env.sample"));
});


test("Git-aware scanning includes tracked and unignored files while excluding ignored and OS metadata files", async () => {
  const target = await tempDir();
  await initGit(target);
  await mkdir(join(target, "nested"), { recursive: true });
  await writeFile(join(target, "tracked-ignored.ts"), "export const tracked = true;\n");
  await execFileAsync("git", ["-C", target, "add", "tracked-ignored.ts"]);
  await execFileAsync("git", ["-C", target, "commit", "-qm", "track source"]);
  await writeFile(join(target, ".gitignore"), "ignored.ts\nnested/*.ts\ntracked-ignored.ts\n");
  await writeFile(join(target, "ignored.ts"), "export const ignored = true;\n");
  await writeFile(join(target, "included.ts"), "export const included = true;\n");
  await writeFile(join(target, "vite.config.mts"), "export default {};\n");
  await writeFile(join(target, "go.mod"), "module example.com/test\n\ngo 1.22\n");
  await mkdir(join(target, "build"), { recursive: true });
  await writeFile(join(target, "build", "Dockerfile"), "FROM scratch\n");
  await execFileAsync("git", ["-C", target, "add", "build/Dockerfile"]);
  await writeFile(join(target, "nested", "ignored.ts"), "export const nestedIgnored = true;\n");
  await writeFile(join(target, ".DS_Store"), "metadata");
  await writeFile(join(target, "._resource.ts"), "export const resource = true;\n");
  await writeFile(join(target, "scratch.ts.swp"), "swap");

  const paths = new Set((await scanFiles(target)).map((file) => file.relativePath));
  assert.ok(paths.has("tracked-ignored.ts"), "tracked files remain part of the snapshot even when a later ignore rule matches them");
  assert.ok(paths.has("included.ts"));
  assert.ok(paths.has("vite.config.mts"));
  assert.ok(paths.has("go.mod"));
  assert.ok(paths.has("build/Dockerfile"), "tracked project files are not dropped merely because a directory is named build");
  assert.ok(!paths.has("ignored.ts"));
  assert.ok(!paths.has("nested/ignored.ts"));
  assert.ok(!paths.has(".DS_Store"));
  assert.ok(!paths.has("._resource.ts"));
  assert.ok(!paths.has("scratch.ts.swp"));
});

test("nested Git ignore rules and repository-local rules are applied independently in a multi-repository workspace", async () => {
  const workspace = await tempDir();
  for (const name of ["a", "b"]) {
    const root = join(workspace, name);
    await mkdir(root, { recursive: true });
    await initGit(root);
    await writeFile(join(root, ".gitignore"), name === "a" ? "private.ts\n" : "generated/\n");
    await writeFile(join(root, "main.ts"), `export const root = "${name}";\n`);
    if (name === "a") await writeFile(join(root, "private.ts"), "export const hidden = true;\n");
    else {
      await mkdir(join(root, "generated"), { recursive: true });
      await writeFile(join(root, "generated", "api.ts"), "export const generated = true;\n");
    }
  }
  const paths = new Set((await scanFiles(workspace)).map((file) => file.relativePath));
  assert.ok(paths.has("a/main.ts"));
  assert.ok(paths.has("b/main.ts"));
  assert.ok(!paths.has("a/private.ts"));
  assert.ok(!paths.has("b/generated/api.ts"));
});

test("changing ignore rules changes the snapshot identity even when the visible source set is unchanged", async () => {
  const target = await tempDir();
  await initGit(target);
  await writeFile(join(target, "main.ts"), "export const value = 1;\n");
  await writeFile(join(target, ".gitignore"), "*.tmp\n");
  const first = await createSnapshot(target);
  await writeFile(join(target, ".gitignore"), "*.cache\n");
  const second = await createSnapshot(target);
  assert.deepEqual(first.files.map((file) => file.relativePath), second.files.map((file) => file.relativePath));
  assert.notEqual(first.snapshot.ignoreRulesDigest, second.snapshot.ignoreRulesDigest);
  assert.notEqual(first.snapshot.id, second.snapshot.id);
});

test("CodeGraph records outside the Git-aware source manifest are excluded from queries", async () => {
  const workdir = await tempDir();
  const dbPath = join(workdir, "codegraph.db");
  createCodeGraphFixture(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("ignored/generated.ts", "hash2", "typescript", 50, Date.now(), Date.now(), 1, "[]");
  db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ignored-node", "function", "SecretGeneratedFunction", "SecretGeneratedFunction", "ignored/generated.ts", "typescript", 1, 1, 1, 10, null, "function SecretGeneratedFunction", "public", 1, 0, 0, 0, "[]", "[]", null, Date.now());
  db.close();

  const graph = new CodeGraphIndex(dbPath, 30, new Deadline(30_000, "test"), ["src/server.ts"]);
  assert.deepEqual(graph.files().map((file) => file.path), ["src/server.ts"]);
  assert.equal(graph.searchNodes(["SecretGeneratedFunction"]).length, 0);
  assert.equal(graph.nodesByKindInFiles(["function"], ["ignored/generated.ts"]).length, 0, "a kind query cannot reach outside the source manifest either");
  assert.deepEqual(graph.nodesByKindInFiles(["route"], ["src/server.ts"]).map((node) => node.name), ["GET /leave"]);
  assert.equal(graph.summary().fileCount, 1);
  graph.close();
});
