#!/usr/bin/env node
// eval harness CLI. Two commands:
//   extract --run <dir> [--out <file>]                     dump normalized Knowledge as JSON
//   diff --run <dir> --expected <file> [--json] [--prepare-only]
// diff exits 1 on any mustFind missing / forbidden violation / coverage failure; 0 otherwise.
// --prepare-only runs ONLY the anchor-in-scope containment check (zero model, sub-second).

import { writeFileSync } from "node:fs";
import { extractKnowledge } from "./knowledge.ts";
import { loadExpected } from "./expected.ts";
import { checkContainment, diffKnowledge, exitCodeFor, type Containment, type Diff } from "./diff.ts";

interface Flags {
  run?: string;
  expected?: string;
  out?: string;
  json: boolean;
  prepareOnly: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { json: false, prepareOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") flags.run = argv[++i];
    else if (arg === "--expected") flags.expected = argv[++i];
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
  diff    --run <dir> --expected <file> [--json] [--prepare-only]`;

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
  if (diff.coverageFailures.length) {
    lines.push("--- coverage failures ---");
    for (const failure of diff.coverageFailures) lines.push(`  x ${failure.dimension}: expected ${failure.expect.join("|")}, got ${failure.actual.join("|")}`);
  }
  return lines.join("\n");
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

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 1;
  }
  const flags = parseFlags(rest);
  if (command === "extract") return runExtract(flags);
  if (command === "diff") return runDiff(flags);
  throw new Error(`unknown command: ${command}`);
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`error: ${(error as Error).message}\n`);
  process.exit(2);
}
