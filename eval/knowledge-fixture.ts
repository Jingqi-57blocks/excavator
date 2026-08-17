// Freeze a run's extracted Knowledge into one gzipped fixture, so the claims-layer pinned-red tests
// (57B-374) can diff against real authoring output without committing the (git-ignored) run dirs.
// Mirrors factpack-fixture.ts's gz-fixture pattern (node:zlib, no added dependency) and reuses
// extractKnowledge as-is — this is a pure projector, it changes no eval semantics.
//
// Regenerate:  node --experimental-strip-types eval/knowledge-fixture.ts <runDir> <outFile.json.gz>
// The run dirs are never committed, so this is a one-shot generator; the committed .gz is the durable input.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { stableJson } from "../src/base/util.ts";
import { extractKnowledge, type Knowledge } from "./knowledge.ts";

/** Freeze a Knowledge object to a gzipped, stable-JSON file (byte-stable across regenerations). */
export function writeKnowledgeFixture(file: string, knowledge: Knowledge): void {
  writeFileSync(file, gzipSync(Buffer.from(stableJson(knowledge), "utf8")));
}

/** Load a gzipped Knowledge fixture (the frozen extraction of a real run). */
export function loadKnowledgeFixture(file: string): Knowledge {
  if (!existsSync(file)) throw new Error(`knowledge fixture not found: ${file}`);
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
}

function main(argv: string[]): void {
  const [runDir, out] = argv;
  if (!runDir || !out) {
    process.stderr.write("usage: knowledge-fixture <runDir> <outFile.json.gz>\n");
    process.exitCode = 2;
    return;
  }
  const knowledge = extractKnowledge(runDir);
  writeKnowledgeFixture(out, knowledge);
  process.stdout.write(
    `wrote ${out}: ${knowledge.facts.length} facts, ${knowledge.relations.length} relations, ${knowledge.coverage.length} coverage, ${knowledge.prepareHorizon.files.length} horizon files\n`
  );
}

// Run as a script only when invoked directly (never on import from the test suite).
if (process.argv[1]?.endsWith("knowledge-fixture.ts")) main(process.argv.slice(2));
