import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReportRequest } from "../src/base/types.ts";
import { prepareRun } from "../src/run/run.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

// THE PRODUCTION PATH, BECAUSE THAT IS THE ONE THAT WAS DEAD.
//
// `factpack-annotate.ts` has had a `{ kind: "seeded", basis: "explicit-seed" }` branch all along, and unit
// tests covered it — by passing seed sets the production caller never passed. `run.ts` handed every feature an
// explicit empty set, so on every real run `relations.seeded` was zero and the branch was unreachable code that
// looked tested. Every other test in this slice would stay green if that wiring were reverted; this is the one
// that would not.
//
// It asserts on the WRITTEN ARTIFACTS rather than on a function's return, because the defect lived in how the
// stages were connected, not in any stage.

const BUDGETS = { prepareMs: 60_000, authorMs: 60_000, maxGraphQueries: 40, maxSourceWindows: 40, maxSourceCharacters: 150_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function featureRun(): Promise<{ runDir: string }> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  const request: ReportRequest = {
    target, workdir, codegraph, language: "en-US", detailLevel: "standard",
    overviewAudiences: [],
    // Terms the CodeGraph fixture actually holds (`GET /leave`, `requireManager`, `listLeave`) — a query that
    // seeds nothing would make this test pass vacuously for the wrong reason.
    features: [{ subject: "Leave management", aliases: ["leave", "manager"], audiences: ["product"] }],
    budgets: BUDGETS
  };
  return { runDir: (await prepareRun(request)).runDir };
}

type Membership =
  | { kind: "unit"; unitId: string }
  | { kind: "span-set"; unitIds: string[] }
  | { kind: "relation"; endpoints: string[] }
  | { kind: "module"; moduleId: string }
  | { kind: "corpus" };

type PackItem = {
  relation: { kind: string; basis: string };
  membership: { joined?: { factId: string; kind: string; membership: Membership }; unjoined?: { reason: string } };
};

/** The cells a membership names, mirroring `membershipCells` — the arms that hold no cell yield none. */
function cellsOf(membership: Membership): string[] {
  switch (membership.kind) {
    case "unit": return [membership.unitId];
    case "span-set": return membership.unitIds;
    case "relation": return membership.endpoints;
    default: return [];
  }
}

async function readFactPack(runDir: string): Promise<{ relations: Record<string, number>; items: PackItem[] }> {
  const dir = join(runDir, "context", "features");
  const [name] = (await readdir(dir)).filter((entry) => entry.endsWith(".factpack.json"));
  assert.ok(name, "the feature run wrote a fact pack");
  return JSON.parse(await readFile(join(dir, name!), "utf8"));
}

test("a real prepare seats query seeds and layer 5 marks them seeded", async () => {
  const { runDir } = await featureRun();

  const attribution = JSON.parse(await readFile(join(runDir, "attribution", "attribution.json"), "utf8"));
  assert.equal(attribution.status, "built");
  assert.equal(attribution.value.version, "attribution-v3");

  const selection = attribution.value.selections[0];
  assert.ok(selection, "the run selected for its one feature");
  assert.ok(selection.seedCells.length > 0,
    `layer 4 must publish the cells its query seeds won; an empty set here is the defect this slice fixes: ${JSON.stringify(selection.channels)}`);

  const seatedIds = new Set<string>(selection.seats.map((seat: { unitId: string }) => seat.unitId));
  for (const cell of selection.seedCells) {
    assert.ok(seatedIds.has(cell), `every seedCell holds a seat: ${cell}`);
  }

  // The join, end to end: what layer 4 published is what layer 5 marked.
  const pack = await readFactPack(runDir);
  assert.ok(pack.relations.seeded >= 1,
    `layer 5's seeded relation must be reachable in production; it was structurally zero on every run before this: ${JSON.stringify(pack.relations)}`);

  const seedCells = new Set<string>(selection.seedCells);
  const seededItems = pack.items.filter((item) => item.relation.kind === "seeded");
  assert.equal(seededItems.length, pack.relations.seeded, "the summary counts the rows it claims to");
  for (const item of seededItems) {
    assert.equal(item.relation.basis, "explicit-seed", "the only basis that may produce a seeded relation");
    const joined = item.membership.joined;
    assert.ok(joined, "a seeded row is joined to a layer-3 fact; an unjoined row can never be seeded");
    const cells = cellsOf(joined.membership);
    assert.ok(cells.some((cell) => seedCells.has(cell)),
      `a seeded row must name a cell layer 4 published, never one layer 5 re-derived: ${JSON.stringify(cells)}`);
  }
});
