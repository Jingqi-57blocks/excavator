import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CodeGraphSet } from "../src/codegraph/codegraph-set.ts";
import { Deadline } from "../src/base/util.ts";
import { createCodeGraphSchema, insertGraphFile, insertGraphNode, tempDir } from "./helpers.ts";

/**
 * Build a per-module database whose paths are module-relative — exactly what `codegraph init .` run
 * inside the module directory produces. Node ids collide across modules on purpose ("n1"/"n2") so
 * the tests prove the set routes by module rather than by a globally-unique id.
 */
async function moduleDatabase(name: string, extraFile?: string): Promise<string> {
  const dir = await tempDir(`excavator-${name}-`);
  const path = join(dir, "codegraph.db");
  const db = createCodeGraphSchema(path);
  insertGraphFile(db, "handler.ts", 2);
  insertGraphNode(db, { id: "n1", kind: "function", name: "createOrder", filePath: "handler.ts", startLine: 1, endLine: 3 });
  insertGraphNode(db, { id: "n2", kind: "function", name: `${name}Repo`, filePath: "handler.ts", startLine: 5, endLine: 7 });
  db.prepare("INSERT INTO edges (source,target,kind,metadata,line,col) VALUES (?,?,?,?,?,?)").run("n1", "n2", "references", JSON.stringify({ refName: `${name}Repo` }), 2, 4);
  if (extraFile) {
    // A file the module's database indexed but that the source manifest does not own — e.g. a merged
    // build that reached past the module boundary. It must be clipped by the per-module allow-list.
    insertGraphFile(db, extraFile, 1);
    insertGraphNode(db, { id: "leaked", kind: "function", name: "LeakedSymbol", filePath: extraFile, startLine: 1, endLine: 1 });
  }
  db.close();
  return path;
}

async function buildSet(extraInA?: string): Promise<CodeGraphSet> {
  const pathA = await moduleDatabase("alpha", extraInA);
  const pathB = await moduleDatabase("beta");
  return new CodeGraphSet(
    [
      { module: { id: "service-a", dir: "service-a" }, path: pathA },
      { module: { id: "service-b", dir: "service-b" }, path: pathB }
    ],
    ["service-a/handler.ts", "service-b/handler.ts"],
    100,
    new Deadline(30_000, "codegraph-set test")
  );
}

test("a search over the set returns nodes from every module with target-relative paths", async () => {
  const set = await buildSet();
  const nodes = set.searchNodes(["createOrder"]);
  const paths = nodes.map((node) => node.filePath).sort();
  assert.deepEqual(paths, ["service-a/handler.ts", "service-b/handler.ts"]);
  // Ids from different databases collide locally ("n1") but are namespaced by module in the set.
  assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length);
  set.close();
});

test("files() enumerates every module's files translated back to target-relative paths", async () => {
  const set = await buildSet();
  assert.deepEqual(set.files().map((file) => file.path), ["service-a/handler.ts", "service-b/handler.ts"]);
  set.close();
});

test("file-scoped queries route to the owning module only", async () => {
  const set = await buildSet();
  const inA = set.nodesByKindInFiles(["function"], ["service-a/handler.ts"]);
  assert.ok(inA.length > 0);
  assert.ok(inA.every((node) => node.filePath.startsWith("service-a/")), "a module-A file query must not reach module B");
  set.close();
});

test("expansion from a module-A seed produces no node or edge crossing into module B", async () => {
  const set = await buildSet();
  const seed = set.searchNodes(["createOrder"]).find((node) => node.filePath.startsWith("service-a/"))!;
  const { nodes, edges } = set.expand([seed.id], 2, 20);
  assert.ok(edges.length > 0, "the within-module edge is still traversed");
  for (const edge of edges) {
    // Every namespaced endpoint id belongs to module A; none may reference module B.
    assert.ok(edge.source.includes("service-a") && edge.target.includes("service-a"), "an edge must stay inside module A");
    assert.ok(!edge.source.includes("service-b") && !edge.target.includes("service-b"), "an edge must not cross into module B");
  }
  assert.ok(nodes.every((node) => node.filePath.startsWith("service-a/")), "expansion must not surface module-B nodes");
  // Module B carries an identically-named symbol and an identical local id; it must not be reached.
  assert.ok(!nodes.some((node) => node.filePath.startsWith("service-b/")));
  set.close();
});

test("a database that indexed past its module boundary is clipped by the per-module allow-list", async () => {
  const set = await buildSet("../shared/leaked.ts");
  assert.equal(set.searchNodes(["LeakedSymbol"]).length, 0, "a symbol outside the module's owned files is not reachable");
  assert.ok(set.files().every((file) => !file.path.includes("leaked")));
  set.close();
});

test("the whole set draws from one shared query budget and reuses each module's cache", async () => {
  const set = await buildSet();
  set.searchNodes(["createOrder"]);
  set.searchNodes(["createOrder"]); // identical query, served from each module's cache
  assert.ok(set.stats.queries > 0);
  assert.ok(set.stats.hits > 0, "the second identical search is served from cache within its module index");
  set.close();
});
