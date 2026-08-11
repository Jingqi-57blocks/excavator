#!/usr/bin/env node
// eval harness CLI. Commands:
//   extract --run <dir> [--out <file>]                     dump normalized Knowledge as JSON
//   diff --run <dir> --expected <file> [--json] [--prepare-only]
//   view --run <dir> [--json]                              render one run's metrics + timeline
//   compare --a <dir> --b <dir> [--json]                   cross-run A->B metrics + knowledge delta
//   boundary (--run <dir> | --nodes <file>) --gold <file> [--json]   feature-graph boundary recall
// diff exits 1 on any mustFind missing / forbidden violation / coverage failure; 0 otherwise.
// boundary exits 1 on any mustFind miss; 0 otherwise (same honest-red contract as diff).
// --prepare-only runs ONLY the anchor-in-scope containment check (zero model, sub-second).
// view/compare have no semantic-fail concept: exit 0 on success, 2 on error (like every other harness error).

import { writeFileSync } from "node:fs";
import { extractKnowledge } from "./knowledge.ts";
import { loadExpected } from "./expected.ts";
import { checkContainment, diffKnowledge, exitCodeFor, type Containment, type Diff } from "./diff.ts";
import { computeRunStats } from "./run-stats.ts";
import { renderRunStats } from "./render-run-stats.ts";
import { compareRuns } from "./compare-runs.ts";
import { renderRunComparison } from "./render-run-comparison.ts";
import { loadBoundaryGold } from "./boundary-gold.ts";
import { boundaryRecall, boundaryReportFromRun, loadNodesFile, exitCodeFor as boundaryExitCode, type BoundaryReport } from "./boundary.ts";

interface Flags {
  run?: string;
  a?: string;
  b?: string;
  expected?: string;
  gold?: string;
  nodes?: string;
  out?: string;
  json: boolean;
  prepareOnly: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { json: false, prepareOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") flags.run = argv[++i];
    else if (arg === "--a") flags.a = argv[++i];
    else if (arg === "--b") flags.b = argv[++i];
    else if (arg === "--expected") flags.expected = argv[++i];
    else if (arg === "--gold") flags.gold = argv[++i];
    else if (arg === "--nodes") flags.nodes = argv[++i];
    else if (arg === "--out") flags.out = argv[++i];
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
  boundary (--run <dir> | --nodes <file>) --gold <file> [--json]`;

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
    `  missing: ${s.missing} (authoring-miss ${s.authoringMiss}, prepare-miss ${s.prepareMiss})`,
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
  const lines = [
    `=== boundary recall (${report.target}: ${s.mustFindFound}/${s.mustFind} mustFind found, ${s.nodeCount} nodes / ${s.fileCount} files) ===`,
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

function runBoundary(flags: Flags): number {
  const gold = loadBoundaryGold(requireFlag(flags.gold, "--gold"));
  if (flags.run && flags.nodes) throw new Error("pass exactly one of --run or --nodes, not both");
  const report = flags.nodes
    ? boundaryRecall(loadNodesFile(flags.nodes), gold)
    : boundaryReportFromRun(requireFlag(flags.run, "--run"), gold);
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

function main(argv: string[]): number {
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
  throw new Error(`unknown command: ${command}`);
}

// Set process.exitCode rather than calling process.exit(): a large stdout write
// to a pipe is async, and process.exit() would truncate it at the pipe buffer.
// With exitCode the process ends naturally once stdout has drained.
try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`error: ${(error as Error).message}\n`);
  process.exitCode = 2;
}
