/**
 * `excavator db-schema` orchestration.
 *
 * Pipeline (all deterministic, zero model calls, target is READ-ONLY):
 *   discover (or read --manifest) → `extractSchema` (parse every source, merge) → inject --descriptions
 *   (verbatim, validated) → renderSchema → write <out>/database-design.md and <out>/db-schema.json.
 *
 * The middle step lives in `schema-extract.ts` because the run-scoped layer-3 producer runs the same one:
 * two entrances, one pipeline. What is command-only stays here — `--manifest`, `--descriptions`, `--out`,
 * and the choice to let a parser failure surface to the CLI rather than become an envelope.
 *
 * Every file the parsers read is a relative path under the target, resolved through a single injected
 * reader that refuses to escape the target root — the command never writes to the target, only to
 * `--out`. Orchestration lives here, not in cli.ts.
 */

import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { atomicWrite, ensureDir, writeJson } from "../base/util.ts";
import { DEFAULT_WORKDIR } from "../base/defaults.ts";
import { discoverSchemaFormats } from "./discover.ts";
import type { Discovery } from "./discover.ts";
import { detectEngine } from "./engine.ts";
import { loadManifest } from "./manifest.ts";
import { injectDescriptions } from "./descriptions.ts";
import { boundedReader, extractSchema } from "./schema-extract.ts";
import { renderSchema } from "./render.ts";
import type { SchemaExtraction } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface DbSchemaOptions {
  target: string;
  out?: string;
  manifest?: string;
  descriptions?: string;
}

export interface DbSchemaResult {
  target: string;
  outDir: string;
  markdownPath: string;
  jsonPath: string;
  tables: number;
  relationships: number;
  perFormat: Record<string, number>;
  warnings: number;
  unsupported: string[];
  extraction: SchemaExtraction;
}

export async function runDbSchema(options: DbSchemaOptions): Promise<DbSchemaResult> {
  const target = resolve(options.target);
  const outDir = resolve(options.out ?? join(DEFAULT_WORKDIR, "db-schema"));

  const discovery: Discovery = options.manifest
    ? await loadManifest(resolve(options.manifest), target)
    : await discoverSchemaFormats(target);

  const extraction = extractSchema({
    target,
    discovery,
    read: boundedReader(target),
    gitHead: await headOf(target),
    engine: await detectEngine(target),
  });

  if (options.descriptions) {
    const descriptions = JSON.parse(readFileSync(resolve(options.descriptions), "utf8")) as Record<string, string>;
    injectDescriptions(extraction, descriptions);
  }

  const markdown = renderSchema(extraction);
  await ensureDir(outDir);
  const markdownPath = join(outDir, "database-design.md");
  const jsonPath = join(outDir, "db-schema.json");
  await atomicWrite(markdownPath, markdown);
  await writeJson(jsonPath, extraction);

  const perFormat: Record<string, number> = {};
  for (const source of discovery.sources) perFormat[source.format] = source.files.length;

  return {
    target,
    outDir,
    markdownPath,
    jsonPath,
    tables: extraction.tables.length,
    relationships: extraction.relationships.length,
    perFormat,
    warnings: extraction.warnings.length,
    unsupported: extraction.unsupported.map((item) => item.format),
    extraction,
  };
}

async function headOf(target: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", target, "rev-parse", "HEAD"], { timeout: 10_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
