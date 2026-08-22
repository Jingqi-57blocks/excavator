/**
 * The discover → parse → merge core of schema recovery, shared by both entrances.
 *
 * `excavator db-schema` (its own command, writing outside a run directory) and the run-scoped layer-3 producer
 * (`src/run/facts-stage.ts`) recover the SAME schema from the same target. A second implementation of the
 * pipeline is drift by construction — the command and the envelope would answer "which tables does this target
 * declare" differently the first time either side changed a step — so the pipeline lives here once and each
 * entrance supplies only what it owns: the command supplies `--manifest` / `--descriptions` / `--out`, the
 * producer supplies the run's counted-file census and its envelope discipline.
 *
 * WHAT IS NOT SHARED, on purpose: failure handling. The command lets a parser throw so the CLI reports it; the
 * producer catches and records `Unavailable{cause}`, because a layer-3 producer owes an envelope on every run.
 * That is a property of the two boundaries, not two pipelines.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeRelative } from "../base/util.ts";
import type { Discovery } from "./discover.ts";
import { mergeSchemas, type MergeInput } from "./merge.ts";
import { PARSERS } from "./parsers/parser.ts";
import type { DetectedEngine, ReadFile, SchemaExtraction } from "./types.ts";

export interface SchemaExtractInput {
  readonly target: string;
  /** Which formats to parse and with which files. Already narrowed by whatever census the caller owns. */
  readonly discovery: Discovery;
  readonly read: ReadFile;
  /** The target's git HEAD when it has one; `undefined` when the target is not a repository. */
  readonly gitHead: string | undefined;
  /** The detected engine, or `undefined` when no dialect signal was weighed. Never guessed here. */
  readonly engine: DetectedEngine | undefined;
}

/** Parse every discovered source with its registered parser and merge them into one framework-neutral schema. */
export function extractSchema(input: SchemaExtractInput): SchemaExtraction {
  const inputs: MergeInput[] = input.discovery.sources.map((source) => ({
    source: { id: source.format, format: source.format, files: source.files },
    result: PARSERS[source.format].parse(source.files, input.read),
  }));
  const extraction = mergeSchemas(inputs, {
    target: input.target,
    ...(input.gitHead !== undefined ? { gitHead: input.gitHead } : {}),
  });
  // Discovery/manifest owns the unsupported list; merge cannot see it (it only sees parsed sources).
  extraction.unsupported = input.discovery.unsupported;
  extraction.engine = input.engine;
  return extraction;
}

/** A synchronous reader for parsers: relative paths only, never escaping the read-only target root. */
export function boundedReader(target: string): ReadFile {
  return (relativePath: string): string => {
    const rel = safeRelative(target, resolve(target, relativePath));
    return readFileSync(join(target, rel), "utf8");
  };
}
