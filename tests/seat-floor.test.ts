import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { CodeGraphSet } from "../src/codegraph/codegraph-set.ts";
import { Deadline } from "../src/core/util.ts";
import { tempDir } from "./helpers.ts";

// A MODULE THAT MATCHED SOMETHING CANNOT LOSE EVERY SEAT.
//
// Seeds used to be one global competition: every member's hits merged, sorted, truncated to `limit`. A module
// can lose that outright — simulated on the five-module real target with the leave vocabulary, two modules won
// ZERO seats — and `expand` then skips a seatless module entirely (`if (!seeds?.length) continue`), so nothing
// downstream can recover it. A whole repository contributing nothing is the failure that function-level read
// obligations cannot express, since a module outside the boundary lands in no bucket at all.
//
// Measured on the real databases: the floor costs the strongest module ONE seat and rescues a module from
// silence — 78/24/18 with one module absent becomes 77/24/18/1.

async function graphSet(modules: Array<{ id: string; hits: number; kind?: string }>, limit: number): Promise<{ set: CodeGraphSet; allowed: string[] }> {
  const dir = await tempDir();
  const members: Array<{ module: never; path: string }> = [];
  const allowed: string[] = [];
  for (const spec of modules) {
    const path = join(dir, `${spec.id}.db`);
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE files (path TEXT PRIMARY KEY, content_hash TEXT, language TEXT, size INT, modified_at INT, indexed_at INT, node_count INT, errors TEXT);
             CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, language TEXT, start_line INT, end_line INT, start_column INT, end_column INT, docstring TEXT, signature TEXT, visibility TEXT, is_exported INT, is_async INT, is_static INT, is_abstract INT, decorators TEXT, type_parameters TEXT, return_type TEXT, updated_at INT);
             CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, target TEXT, kind TEXT, metadata TEXT, line INT, col INT, provenance TEXT);
             CREATE TABLE unresolved_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, from_node_id TEXT, reference_name TEXT, reference_kind TEXT, line INT, col INT, candidates TEXT, file_path TEXT, language TEXT, status TEXT, name_tail TEXT);
             CREATE TABLE schema_versions (version INT, applied_at INT, description TEXT);
             CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO schema_versions VALUES (1, 0, 'test');`);
    // The database stores MODULE-RELATIVE paths; `globalNode` prefixes the module dir, and the allowed set
    // that `CodeGraphSet` receives is global. Getting this backwards yields an empty result with no error.
    const file = "src/leave.ts";
    db.prepare("INSERT INTO files VALUES (?,?,?,?,?,?,?,?)").run(file, "h", "typescript", 100, 0, 0, spec.hits, "[]");
    allowed.push(`${spec.id}/${file}`);
    for (let index = 0; index < spec.hits; index += 1) {
      db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(`${spec.id}-n${index}`, spec.kind ?? "function", `leaveHandler${index}`, `leaveHandler${index}`, file, "typescript", index + 1, index + 1, 1, 10, null, "sig", "public", 0, 0, 0, 0, "[]", "[]", null, 0);
    }
    db.close();
    members.push({ module: { id: spec.id, dir: spec.id } as never, path });
  }
  return { set: new CodeGraphSet(members, allowed, 500, new Deadline(30_000, "seat-floor-test")), allowed };
}

function seatsByModule(nodes: Array<{ filePath: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const node of nodes) {
    const key = String(node.filePath).split("/")[0];
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

// The shape that used to zero a module: one member holds far more hits than the budget, another holds a few
// that sort after all of them. Kind rank decides first, so the loser's `method` nodes lose to `route` nodes.
test("a module whose hits all sort last still gets seats", async () => {
  const { set } = await graphSet([
    { id: "loud", hits: 30, kind: "route" },
    { id: "quiet", hits: 3, kind: "method" },
  ], 10);
  const seats = seatsByModule(set.searchNodes(["leave"], 10));
  assert.ok(seats.quiet >= 1, `the quiet module must not be zeroed: ${JSON.stringify(seats)}`);
  assert.equal(seats.quiet, 2, "two reserved seats, as documented");
  assert.equal(seats.loud, 8, "the rest of the budget still goes by the global order");
  set.close();
});

// A module with NO hit gets no seat, and that is correct — the floor guarantees presence for modules that
// matched, not membership for every module. Modules with nothing to match are the census's job to report.
test("a module that matched nothing gets no seat", async () => {
  const { set } = await graphSet([{ id: "present", hits: 5 }, { id: "empty", hits: 0 }], 10);
  const seats = seatsByModule(set.searchNodes(["leave"], 10));
  assert.equal(seats.empty, undefined, "no hit, no seat — and the census reports it as zero-hit");
  assert.equal(seats.present, 5);
  set.close();
});

// The floor may never take more than half the budget, or it would replace ranking rather than guard against
// silence. With more modules than it can seat, the remainder competes globally — defined, not empty.
test("the floor is capped at half the budget and degrades to one seat each", async () => {
  const modules = Array.from({ length: 8 }, (_, index) => ({ id: `m${index}`, hits: 4 }));
  const { set } = await graphSet(modules, 6);
  const nodes = set.searchNodes(["leave"], 6);
  assert.equal(nodes.length, 6, "the budget is still respected exactly");
  const seats = seatsByModule(nodes);
  // floorBudget = 3, so three modules get one reserved seat; the other three seats compete globally.
  assert.ok(Object.keys(seats).length >= 3, `several modules present, not one: ${JSON.stringify(seats)}`);
  set.close();
});

// More modules than the whole budget. The floor is capped at half the budget on purpose, so with two seats
// only ONE is reserved and the other still goes by ranking — which means both can land in the same module.
// My first version of this test asserted "two seats, two modules"; the design does not promise that, and
// asserting a promise the code never made is how a test starts lying about what is guaranteed. What IS
// guaranteed is that the result is defined: the budget is exact, nothing is empty, no phantom seats.
test("more modules than seats produces a defined result rather than an empty one", async () => {
  const modules = Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, hits: 2 }));
  const { set } = await graphSet(modules, 2);
  const nodes = set.searchNodes(["leave"], 2);
  assert.equal(nodes.length, 2, "the budget is exact");
  const seats = seatsByModule(nodes);
  assert.ok(Object.keys(seats).length >= 1, "at least one module is seated — never an empty scope");
  assert.equal(Object.values(seats).reduce((sum, value) => sum + value, 0), 2, "and every seat belongs to a real module");
  set.close();
});

// Output ordering is unchanged: the floor decides membership, not order, so a scope whose modules all placed
// anyway is byte-identical to before this change.
test("the returned nodes stay in the global order", async () => {
  const { set } = await graphSet([{ id: "a", hits: 4, kind: "route" }, { id: "b", hits: 4, kind: "method" }], 8);
  const nodes = set.searchNodes(["leave"], 8);
  const ranks = nodes.map((node) => (node.kind === "route" ? 0 : 3));
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y), "kind rank is still non-decreasing across the result");
  set.close();
});
