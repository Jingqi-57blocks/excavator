#!/usr/bin/env node
// eval harness CLI. Commands:
//   extract --run <dir> [--out <file>]                     dump normalized Knowledge as JSON
//   diff --run <dir> --expected <file> [--json] [--prepare-only]
//   view --run <dir> [--json]                              render one run's metrics + timeline
//   compare --a <dir> --b <dir> [--json]                   cross-run A->B metrics + knowledge delta
//   boundary (--run <dir> | --nodes <file>) --gold <file> [--json]   feature-graph boundary recall
//   read-denominator --run <dir> [--must <path:line>]... [--json]   what the boundary second source added
//   crossrepo --run <dir> --gold <file> [--sample N] [--json]       cross-repo link gate + review sample
//   read-attribution --gold <file> --anchors a,b,c [--json]         does the partitioned reading still point right
//   packet-readings --run <dir> --mode <authored|frozen-not-authored> [--out <file>]
//                                                           per-document packet byte readings + cross-packet duplication
//   ledger-closeout --run <dir> [--out <file>] [--updates <file>]   transcribe unsettled read obligations to cannot-determine
//   topic-readings --run <dir> [--out <file>]               Topic Catalog facet/materiality/conservation readings
// diff exits 1 on any mustFind missing / forbidden violation / coverage failure; 0 otherwise.
// boundary exits 1 on any mustFind miss; 0 otherwise (same honest-red contract as diff).
// --prepare-only runs ONLY the anchor-in-scope containment check (zero model, sub-second).
// view/compare have no semantic-fail concept: exit 0 on success, 2 on error (like every other harness error).

import { writeFileSync, existsSync } from "node:fs";
import { extractKnowledge } from "./knowledge.ts";
import { loadExpected } from "./expected.ts";
import { checkContainment, diffKnowledge, exitCodeFor, type Containment, type Diff } from "./diff.ts";
import { computeRunStats } from "./run-stats.ts";
import { renderRunStats } from "./render-run-stats.ts";
import { compareRuns } from "./compare-runs.ts";
import { renderRunComparison } from "./render-run-comparison.ts";
import { loadBoundaryGold } from "./boundary-gold.ts";
import {
  boundaryRecall,
  loadNodesFile,
  fgReportFromRun,
  factPackReportFromRun,
  buildLayeredReport,
  layeredExitCode,
  exitCodeFor as boundaryExitCode,
  type BoundaryReport,
  type BoundaryLayer,
  type LayeredBoundaryReport
} from "./boundary.ts";
import { buildPoolFromRun, loadPrunePool, prunePoolToNodes, writePrunePool } from "./prune-replay.ts";
import { buildDenominatorReport, denominatorExitCode, parseMust, renderDenominator } from "./read-denominator.ts";
import { artifactExists, buildCrossRepoReport, crossRepoExitCode, loadCrossRepoGold, renderCrossRepoReport } from "./crossrepo.ts";
import { attributionExitCode, buildAttributionReport, renderAttributionReport } from "./read-attribution.ts";
import { extractPacketReadings, PACKET_READINGS_MODES, type PacketReadingsMode } from "./packet-readings.ts";
import { buildLedgerCloseout } from "./ledger-closeout.ts";
import { extractTopicReadings } from "./topic-readings.ts";
import { stableJson } from "../src/base/util.ts";

interface Flags {
  run?: string;
  a?: string;
  b?: string;
  expected?: string;
  gold?: string;
  nodes?: string;
  layer?: string;
  out?: string;
  mode?: string;
  updates?: string;
  pool?: string;
  emitPool?: string;
  modules: string[];
  must: string[];
  sample?: string;
  anchors?: string;
  json: boolean;
  prepareOnly: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { json: false, prepareOnly: false, modules: [], must: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") flags.run = argv[++i];
    else if (arg === "--a") flags.a = argv[++i];
    else if (arg === "--b") flags.b = argv[++i];
    else if (arg === "--expected") flags.expected = argv[++i];
    else if (arg === "--gold") flags.gold = argv[++i];
    else if (arg === "--nodes") flags.nodes = argv[++i];
    else if (arg === "--layer") flags.layer = argv[++i];
    else if (arg === "--must") flags.must.push(argv[++i]);
    else if (arg === "--sample") flags.sample = argv[++i];
    else if (arg === "--anchors") flags.anchors = argv[++i];
    else if (arg === "--out") flags.out = argv[++i];
    else if (arg === "--mode") flags.mode = argv[++i];
    else if (arg === "--updates") flags.updates = argv[++i];
    else if (arg === "--pool") flags.pool = argv[++i];
    else if (arg === "--emit-pool") flags.emitPool = argv[++i];
    else if (arg === "--module") flags.modules.push(argv[++i]);
    else if (arg === "--json") flags.json = true;
    else if (arg === "--prepare-only") flags.prepareOnly = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return flags;
}

function requireFlag(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing required flag ${name}`);
  return value;
}

const USAGE = `eval harness

  extract --run <dir> [--out <file>]
  diff    --run <dir> --expected <file> [--json] [--prepare-only]
  view    --run <dir> [--json]
  compare --a <dir> --b <dir> [--json]
  boundary (--run <dir> | --nodes <file>) --gold <file> [--layer fg|factpack|both] [--json]
  prune-replay (--pool <file> | --run <dir> --module <db> [--module <db>...]) --gold <file> [--emit-pool <file>] [--json]
  packet-readings --run <dir> --mode <authored|frozen-not-authored> [--out <file>]
  ledger-closeout --run <dir> [--out <file>] [--updates <file>]
  topic-readings --run <dir> [--out <file>]`;

function renderContainment(containment: Containment): string {
  const lines = [`=== prepare containment (${containment.contained.length}/${containment.contained.length + containment.missing.length} anchors in scope) ===`];
  if (containment.missing.length === 0) {
    lines.push("  all expected anchors land in the prepared horizon");
  } else {
    lines.push("  OUT OF SCOPE (would be prepare-miss):");
    for (const entry of containment.missing) lines.push(`  - [${entry.id}] ${entry.path}`);
  }
  return lines.join("\n");
}

function renderDiff(diff: Diff): string {
  const s = diff.summary;
  const lines = [
    `=== knowledge diff (${s.found}/${s.items} found, ${s.mustFindMissing} mustFind missing) ===`,
    `  verdict: ${s.pass ? "PASS" : "FAIL"}`,
    `  missing: ${s.missing} (prepare-miss ${s.prepareMiss}, read-miss ${s.readMiss}, consume-miss ${s.consumeMiss}, write-miss ${s.writeMiss}${s.authoringMiss > s.readMiss + s.consumeMiss + s.writeMiss ? `, unrefined ${s.authoringMiss - s.readMiss - s.consumeMiss - s.writeMiss}` : ""})`,
    `  forbidden violations: ${s.forbiddenHits}`,
    `  coverage failures: ${s.coverageFailures}`
  ];
  if (diff.missing.length) {
    lines.push("--- missing ---");
    for (const entry of diff.missing) lines.push(`  - [${entry.id}] ${entry.kind} ${entry.mustFind ? "(mustFind)" : "(optional)"} -> ${entry.attribution}`);
  }
  if (diff.forbiddenHits.length) {
    lines.push("--- forbidden violations (hallucination) ---");
    for (const hit of diff.forbiddenHits) lines.push(`  ! [${hit.id}] ${hit.marker} claim ${hit.ref}: ${hit.statement}`);
  }
  if (diff.forbiddenExempted.length) {
    lines.push("--- forbidden exemptions (matched base, not counted) ---");
    for (const ex of diff.forbiddenExempted) lines.push(`  ~ [${ex.ruleId}] ${ex.reason}: ${ex.marker} claim ${ex.ref}: ${ex.statement}`);
  }
  if (diff.coverageFailures.length) {
    lines.push("--- coverage failures ---");
    for (const failure of diff.coverageFailures) lines.push(`  x ${failure.dimension}: expected ${failure.expect.join("|")}, got ${failure.actual.join("|")}`);
  }
  return lines.join("\n");
}

function renderBoundary(report: BoundaryReport): string {
  const s = report.summary;
  const layerTag = report.layer ? ` @ ${report.layer}` : "";
  const lines = [
    `=== boundary recall (${report.target}${layerTag}: ${s.mustFindFound}/${s.mustFind} mustFind found, ${s.nodeCount} nodes / ${s.fileCount} files) ===`,
    `  verdict: ${s.pass ? "PASS" : "FAIL"}`,
    `  mustFind: ${s.mustFindFound}/${s.mustFind} found, ${s.mustFindMissing} missing`,
    `  optional: ${s.optionalFound}/${s.optional} found (informational)`
  ];
  const mustMiss = report.missing.filter((entry) => entry.mustFind);
  if (mustMiss.length) {
    lines.push("--- mustFind missing (out of boundary) ---");
    for (const entry of mustMiss) lines.push(`  ! [${entry.id}]${coverageTag(entry.coveredBySourceWindow)}`);
  }
  const optMiss = report.missing.filter((entry) => !entry.mustFind);
  if (optMiss.length) {
    lines.push("--- optional missing (informational, does not affect verdict) ---");
    for (const entry of optMiss) lines.push(`  ~ [${entry.id}]${coverageTag(entry.coveredBySourceWindow)}`);
  }
  return lines.join("\n");
}

/** Render the informational source-window coverage of a miss (run mode only; undefined in --nodes mode). */
function coverageTag(covered: boolean | undefined): string {
  if (covered === undefined) return "";
  return covered ? " (covered by a source window: fallback may reach it)" : " (no source window: fully out of bounds)";
}

/** Render a layered (both-layer) report: each layer's recall plus the derivation-drop view between them. */
function renderLayered(report: LayeredBoundaryReport): string {
  const lines = [
    `=== boundary recall (${report.target}: layered fg vs factpack) ===`,
    `  verdict: ${report.pass ? "PASS" : "FAIL"} (union of ${report.requested.join(" + ")})`
  ];
  if (report.fg) lines.push("", renderBoundary(report.fg));
  if (report.factpack) lines.push("", renderBoundary(report.factpack));
  lines.push("", "=== derivation drops (found@fg, dropped from the fact pack: the consumption gap) ===");
  if (report.derivationDrops.length === 0) {
    lines.push("  none");
  } else {
    for (const drop of report.derivationDrops) lines.push(`  x [${drop.id}]${drop.mustFind ? " (mustFind)" : ""} <- ${drop.via}`);
  }
  return lines.join("\n");
}

function parseLayer(value: string | undefined): BoundaryLayer | "both" | undefined {
  if (value === undefined) return undefined;
  if (value === "fg" || value === "factpack" || value === "both") return value;
  throw new Error(`--layer must be fg|factpack|both, got ${value}`);
}

/**
 * Report what the boundary-file second source added to a run's read-obligation denominator, and gate on it:
 * exit 1 if a previously counted obligation was lost, or if a `--must <path:line>` target is not inside a
 * counted obligation. Reads only the run's own frozen artifacts, so it needs neither the target repo nor a
 * CodeGraph database and runs the same way in CI as on a real run.
 */
/**
 * Gate a run's cross-repo links against gold, in both directions, and print a deterministic sample of the
 * links gold does NOT cover — the part a human still has to look at, because ten checked pairs say nothing
 * about the precision of the other several hundred.
 */
/**
 * Gate the relevance labelling against a human adjudication whose thresholds were fixed before the signal
 * existed. Exit 1 when the strong partition stops being mostly real misses, when the unclassified partition
 * stops being mostly noise, or when the reading stops pointing at the files a human said were worth reading.
 */
function runReadAttribution(flags: Flags): number {
  const anchors = requireFlag(flags.anchors, "--anchors").split(",").map((term) => term.trim()).filter(Boolean);
  if (!anchors.length) throw new Error("--anchors expects a comma-separated list of the run's anchor terms");
  const report = buildAttributionReport(requireFlag(flags.gold, "--gold"), anchors);
  process.stdout.write(`${flags.json ? JSON.stringify(report, null, 2) : renderAttributionReport(report)}\n`);
  return attributionExitCode(report);
}

function runCrossRepoGate(flags: Flags): number {
  const runDir = requireFlag(flags.run, "--run");
  const artifactPath = `${runDir}/context/crossrepo-links.json`;
  if (!artifactExists(artifactPath)) {
    process.stdout.write(`crossrepo gate — no crossrepo-links.json in ${runDir} (single-module run, or resolved before this slice)\n`);
    return 0;
  }
  const gold = loadCrossRepoGold(requireFlag(flags.gold, "--gold"));
  const sampleSize = flags.sample ? Number(flags.sample) : 20;
  if (!Number.isInteger(sampleSize) || sampleSize < 0) throw new Error("--sample expects a non-negative integer");
  const report = buildCrossRepoReport(artifactPath, gold, sampleSize);
  process.stdout.write(`${flags.json ? JSON.stringify(report, null, 2) : renderCrossRepoReport(report)}\n`);
  return crossRepoExitCode(report);
}

function runReadDenominator(flags: Flags): number {
  const report = buildDenominatorReport(requireFlag(flags.run, "--run"), flags.must.map(parseMust));
  process.stdout.write(`${flags.json ? JSON.stringify(report, null, 2) : renderDenominator(report)}\n`);
  return denominatorExitCode(report);
}

function runBoundary(flags: Flags): number {
  const gold = loadBoundaryGold(requireFlag(flags.gold, "--gold"));
  if (flags.run && flags.nodes) throw new Error("pass exactly one of --run or --nodes, not both");
  const layer = parseLayer(flags.layer);

  // --nodes supplies a bare node set (no run dir, no fact pack): it measures the fg layer only.
  if (flags.nodes) {
    if (layer !== undefined && layer !== "fg") throw new Error("--nodes measures the fg layer only; drop --layer or pass --layer fg");
    const report: BoundaryReport = { ...boundaryRecall(loadNodesFile(flags.nodes), gold), layer: "fg" };
    process.stdout.write(`${flags.json ? JSON.stringify(report, null, 2) : renderBoundary(report)}\n`);
    return boundaryExitCode(report);
  }

  const runDir = requireFlag(flags.run, "--run");
  const effective = layer ?? "both"; // a run defaults to measuring both layers.
  if (effective === "fg") {
    const report = fgReportFromRun(runDir, gold);
    process.stdout.write(`${flags.json ? JSON.stringify(report, null, 2) : renderBoundary(report)}\n`);
    return boundaryExitCode(report);
  }
  if (effective === "factpack") {
    const report = factPackReportFromRun(runDir, gold);
    process.stdout.write(`${flags.json ? JSON.stringify(report, null, 2) : renderBoundary(report)}\n`);
    return boundaryExitCode(report);
  }
  const layered = buildLayeredReport(gold.target, fgReportFromRun(runDir, gold), factPackReportFromRun(runDir, gold), ["fg", "factpack"]);
  process.stdout.write(`${flags.json ? JSON.stringify(layered, null, 2) : renderLayered(layered)}\n`);
  return layeredExitCode(layered);
}

/**
 * Replay the improved prune and report boundary recall. `--pool` runs the frozen fixture (zero I/O
 * beyond the file); `--run` + `--module` rebuilds the pool from real databases and, with
 * `--emit-pool`, freezes it. Missing databases are a graceful skip (exit 0), never a hard failure,
 * so CI stays green without the (un-committed) databases.
 */
function runPruneReplay(flags: Flags): number {
  const gold = loadBoundaryGold(requireFlag(flags.gold, "--gold"));
  if (flags.pool) {
    const report = boundaryRecall(prunePoolToNodes(loadPrunePool(flags.pool)), gold);
    process.stdout.write(`${flags.json ? JSON.stringify(report, null, 2) : renderBoundary(report)}\n`);
    return boundaryExitCode(report);
  }
  const runDir = requireFlag(flags.run, "--run");
  if (!flags.modules.length) throw new Error("prune-replay needs --pool, or --run with at least one --module <db>");
  const missing = flags.modules.filter((db) => !existsSync(db));
  if (missing.length) {
    process.stdout.write(`prune-replay skipped: module database(s) not present: ${missing.join(", ")}\n`);
    return 0;
  }
  const pool = buildPoolFromRun(runDir, flags.modules);
  if (flags.emitPool) {
    writePrunePool(flags.emitPool, pool);
    process.stdout.write(`emitted pool: ${pool.nodes.length} nodes, ${pool.edges.length} edges, ${pool.seeds.length} seeds -> ${flags.emitPool}\n`);
  }
  const report = boundaryRecall(prunePoolToNodes(pool), gold);
  process.stdout.write(`${flags.json ? JSON.stringify(report, null, 2) : renderBoundary(report)}\n`);
  return boundaryExitCode(report);
}

function runExtract(flags: Flags): number {
  const knowledge = extractKnowledge(requireFlag(flags.run, "--run"));
  const text = JSON.stringify(knowledge, null, 2);
  if (flags.out) writeFileSync(flags.out, `${text}\n`);
  else process.stdout.write(`${text}\n`);
  return 0;
}

/**
 * Project one completed run's authoring packets into byte readings: per document sections / claims / packet
 * bytes / audit findings, plus the run's cross-packet duplication. Key-sorted output, so re-running the
 * extractor over the same run directory writes the same bytes.
 */
function runPacketReadings(flags: Flags): number {
  const mode = requireFlag(flags.mode, "--mode");
  if (!PACKET_READINGS_MODES.includes(mode as PacketReadingsMode)) throw new Error(`--mode must be one of ${PACKET_READINGS_MODES.join(", ")}, got ${mode}`);
  const readings = extractPacketReadings(requireFlag(flags.run, "--run"), mode as PacketReadingsMode);
  const text = stableJson(readings);
  if (flags.out) writeFileSync(flags.out, `${text}\n`);
  else process.stdout.write(`${text}\n`);
  return 0;
}

/**
 * Transcribe a prepared run's unsettled read obligations into `cannot-determine` work-item updates, taking every
 * reason off the run's own `investigation/results.json` execution records. Exits 1 when ANY unsettled item has no
 * transcribable cause: that gap is a real finding, and the tool never fills it with a generic wording. `--out`
 * writes the full report (updates plus per-row provenance); `--updates` writes the apply-ready array for
 * `excavator workitem --run <dir> --file <file>`. Both are written even on the red exit, so the gap can be read
 * next to what would have been applied.
 */
function runLedgerCloseout(flags: Flags): number {
  const closeout = buildLedgerCloseout(requireFlag(flags.run, "--run"));
  const text = stableJson(closeout);
  if (flags.out) writeFileSync(flags.out, `${text}\n`);
  if (flags.updates) writeFileSync(flags.updates, `${stableJson(closeout.rows.map((row) => row.update))}\n`);
  if (!flags.out) process.stdout.write(`${text}\n`);
  else process.stdout.write(`transcribed ${closeout.transcribed}/${closeout.unsettled} unsettled work items; ${closeout.untranscribable} have no transcribable cause\n`);
  return closeout.untranscribable === 0 ? 0 : 1;
}

/**
 * Project one frozen run's Topic Catalog into readings. Never writes into the run directory: the R0 baselines are
 * archival and 57B-452 (a copied run splitting in two) is unfixed, so `--out` is the only place bytes land.
 *
 * Always exits 0. The disposition verdict it records is taken over an EMPTY disposition set, because nothing in
 * the engine produces dispositions yet — a red exit here would be a gate that can only ever fail, which trains
 * everyone to ignore it. The gate belongs where the plan is (the epic's R3).
 */
async function runTopicReadings(flags: Flags): Promise<number> {
  const readings = await extractTopicReadings(requireFlag(flags.run, "--run"));
  const text = stableJson(readings);
  if (flags.out) writeFileSync(flags.out, `${text}\n`);
  else process.stdout.write(`${text}\n`);
  return 0;
}

function runDiff(flags: Flags): number {
  const knowledge = extractKnowledge(requireFlag(flags.run, "--run"));
  const expected = loadExpected(requireFlag(flags.expected, "--expected"));

  if (flags.prepareOnly) {
    const containment = checkContainment(knowledge, expected);
    process.stdout.write(`${flags.json ? JSON.stringify(containment, null, 2) : renderContainment(containment)}\n`);
    return containment.allContained ? 0 : 1;
  }

  const diff = diffKnowledge(knowledge, expected);
  process.stdout.write(`${flags.json ? JSON.stringify(diff, null, 2) : renderDiff(diff)}\n`);
  return exitCodeFor(diff);
}

function runView(flags: Flags): number {
  const stats = computeRunStats(requireFlag(flags.run, "--run"));
  process.stdout.write(`${flags.json ? JSON.stringify(stats, null, 2) : renderRunStats(stats)}\n`);
  return 0;
}

function runCompare(flags: Flags): number {
  const dirA = requireFlag(flags.a, "--a");
  const dirB = requireFlag(flags.b, "--b");
  const comparison = compareRuns(
    computeRunStats(dirA),
    computeRunStats(dirB),
    extractKnowledge(dirA),
    extractKnowledge(dirB)
  );
  process.stdout.write(`${flags.json ? JSON.stringify(comparison, null, 2) : renderRunComparison(comparison)}\n`);
  return 0;
}

function main(argv: string[]): number | Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 1;
  }
  const flags = parseFlags(rest);
  if (command === "extract") return runExtract(flags);
  if (command === "diff") return runDiff(flags);
  if (command === "view") return runView(flags);
  if (command === "compare") return runCompare(flags);
  if (command === "boundary") return runBoundary(flags);
  if (command === "prune-replay") return runPruneReplay(flags);
  if (command === "read-denominator") return runReadDenominator(flags);
  if (command === "crossrepo") return runCrossRepoGate(flags);
  if (command === "read-attribution") return runReadAttribution(flags);
  if (command === "packet-readings") return runPacketReadings(flags);
  if (command === "ledger-closeout") return runLedgerCloseout(flags);
  if (command === "topic-readings") return runTopicReadings(flags);
  throw new Error(`unknown command: ${command}`);
}

// Set process.exitCode rather than calling process.exit(): a large stdout write
// to a pipe is async, and process.exit() would truncate it at the pipe buffer.
// With exitCode the process ends naturally once stdout has drained.
try {
  // One command reads its inputs asynchronously; awaiting inside the try keeps its rejection on the same path as
  // every synchronous command's throw, so there is no second error contract.
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`error: ${(error as Error).message}\n`);
  process.exitCode = 2;
}
