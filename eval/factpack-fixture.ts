// Deterministic projector: read a real run dir and freeze BOTH layers 57B-372 measures into one gzipped
// fixture, so the pinned-red tests can run against real artifacts without committing the (git-ignored) run
// dirs. Mirrors prune-replay.ts's gz-fixture pattern (node:zlib, no added dependency), and reuses the FG reader
// and fact-pack mapping in boundary.ts rather than re-deriving them.
//
//   * `nodes`       = the run's FG node set (with each node's `rescued` reason, so 57B-371's rescues stay
//                     visible) -> the fg layer.
//   * `claimedItems`= the items the EXISTING 6 fact-pack categories produced for the run (its factpack.json)
//                     -> the factpack layer the author consumes.
//
// Regenerate:  node --experimental-strip-types eval/factpack-fixture.ts <runDir> <outFile.json.gz>
// The run dirs are never committed, so this is a one-shot generator; the committed .gz is the durable input.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { stableJson } from "../src/core/util.ts";
import { featureLogicItems } from "../src/context/factpack.ts";
import type { LogicFeatureGraph } from "../src/context/factpack-logic.ts";
import type { FactPackItem } from "../src/core/types.ts";
import { rawFeatureGraphFromRun, factPackItemsToNodes, type BoundaryNode } from "./boundary.ts";

export interface FactpackFixtureNode {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** The 57B-371 rescue reason, when this node was pulled in by the boundary fix. */
  rescued?: string;
}

export interface FactpackClaimedItem {
  category: string;
  name: string;
  filePath: string;
  line: number;
  endLine: number;
}

export interface FactpackFixture {
  /** Provenance only (never read by the metric): the exact regeneration command + absolute source run dir. */
  _meta: { command: string; sourceRunDir: string };
  featureKey: string;
  maxNodes: number;
  seedIds: string[];
  nodes: FactpackFixtureNode[];
  edges: Array<{ source: string; target: string; kind: string }>;
  claimedItems: FactpackClaimedItem[];
}

/** SOH (U+0001) de-dupe key separator, built without a literal control byte — never a NUL. */
const SEP = String.fromCharCode(1);

function projectFixtureNode(node: any): FactpackFixtureNode {
  const out: FactpackFixtureNode = {
    id: String(node.id ?? ""),
    name: String(node.name ?? ""),
    kind: String(node.kind ?? ""),
    filePath: String(node.filePath ?? ""),
    startLine: Number(node.startLine),
    endLine: Number(node.endLine)
  };
  if (typeof node.rescued === "string" && node.rescued.length) out.rescued = node.rescued;
  return out;
}

/** De-dupe edges to (source,target,kind), shrinking the frozen fixture without changing any recall. */
function projectEdges(edges: any[]): Array<{ source: string; target: string; kind: string }> {
  const seen = new Set<string>();
  const out: Array<{ source: string; target: string; kind: string }> = [];
  for (const edge of edges) {
    const source = String(edge?.source ?? "");
    const target = String(edge?.target ?? "");
    const kind = String(edge?.kind ?? "");
    const key = `${source}${SEP}${target}${SEP}${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source, target, kind });
  }
  return out;
}

/** Read the run's fact-pack items (union across features) into the compact claimed-item shape. */
function readClaimedItems(runDir: string): { featureKey: string; claimedItems: FactpackClaimedItem[] } {
  const dir = join(runDir, "context", "features");
  if (!existsSync(dir)) throw new Error(`no context/features directory in ${runDir}`);
  let featureKey = "";
  const claimedItems: FactpackClaimedItem[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".factpack.json")) continue;
    const pack = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (!featureKey && typeof pack.featureKey === "string") featureKey = pack.featureKey;
    for (const item of pack.items ?? []) {
      claimedItems.push({
        category: String(item.category ?? ""),
        name: String(item.name ?? ""),
        filePath: String(item.filePath ?? ""),
        line: Number(item.line),
        endLine: Number(item.endLine ?? item.line)
      });
    }
  }
  return { featureKey, claimedItems };
}

/** Build the frozen fixture from a run dir. `command` is recorded verbatim for provenance. */
export function buildFactpackFixture(runDir: string, command: string): FactpackFixture {
  const abs = resolve(runDir);
  const fg = rawFeatureGraphFromRun(abs);
  const { featureKey, claimedItems } = readClaimedItems(abs);
  return {
    _meta: { command, sourceRunDir: abs },
    featureKey,
    maxNodes: fg.nodes.length,
    seedIds: fg.seeds.map((seed: any) => String(seed.id)),
    nodes: fg.nodes.map(projectFixtureNode),
    edges: projectEdges(fg.edges),
    claimedItems
  };
}

/** Freeze a fixture to a gzipped, stable-JSON file (byte-stable across regenerations). */
export function writeFactpackFixture(file: string, fixture: FactpackFixture): void {
  writeFileSync(file, gzipSync(Buffer.from(stableJson(fixture), "utf8")));
}

/** Load a gzipped fact-pack fixture. */
export function loadFactpackFixture(file: string): FactpackFixture {
  if (!existsSync(file)) throw new Error(`factpack fixture not found: ${file}`);
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
}

/** The fixture's FG node set, projected to boundary nodes (the fg layer). */
export function fixtureFgNodes(fixture: FactpackFixture): BoundaryNode[] {
  return fixture.nodes.map((node) => ({
    filePath: node.filePath,
    name: node.name,
    startLine: node.startLine,
    endLine: node.endLine
  }));
}

/** The fixture's claimed fact-pack items, projected to boundary nodes (the PRE-PR-2 factpack layer:
 *  the six structural categories only, exactly what the frozen run's factpack.json held). */
export function fixtureFactPackNodes(fixture: FactpackFixture): BoundaryNode[] {
  return factPackItemsToNodes(fixture.claimedItems);
}

/** The fixture's frozen feature graph, shaped as the complement enumeration consumes it. Seeds are stored
 *  as ids in the fixture; logic only needs their ids (attention tier 1). */
export function fixtureFeatureGraph(fixture: FactpackFixture): LogicFeatureGraph {
  return { nodes: fixture.nodes, edges: fixture.edges, seeds: fixture.seedIds.map((id) => ({ id })) };
}

/** The `logic` complement items the post-PR-2 fact pack adds for this fixture: the exact production
 *  derivation (`featureLogicItems`) over the frozen graph and the run's own claimed item locations. */
export function fixtureLogicItems(fixture: FactpackFixture): FactPackItem[] {
  return featureLogicItems(fixtureFeatureGraph(fixture), fixture.claimedItems);
}

/** The POST-PR-2 factpack layer the author reads: claimed items ∪ the logic complement. */
export function fixturePostFixFactPackNodes(fixture: FactpackFixture): BoundaryNode[] {
  return factPackItemsToNodes([...fixture.claimedItems, ...fixtureLogicItems(fixture)]);
}

function main(argv: string[]): void {
  const [runDir, out] = argv;
  if (!runDir || !out) {
    process.stderr.write("usage: factpack-fixture <runDir> <outFile.json.gz>\n");
    process.exitCode = 2;
    return;
  }
  const command = `node --experimental-strip-types eval/factpack-fixture.ts ${runDir} ${out}`;
  const fixture = buildFactpackFixture(runDir, command);
  writeFactpackFixture(out, fixture);
  process.stdout.write(
    `wrote ${out}: ${fixture.nodes.length} nodes, ${fixture.edges.length} edges, ${fixture.claimedItems.length} claimed items (feature ${fixture.featureKey})\n`
  );
}

// Run as a script only when invoked directly (never on import from the test suite).
if (process.argv[1]?.endsWith("factpack-fixture.ts")) main(process.argv.slice(2));
