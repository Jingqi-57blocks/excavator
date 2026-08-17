/**
 * Optional AI-locate manifest — the stage-1 refinement for weird / monorepo layouts.
 *
 * When `--manifest <path>` is given it REPLACES automatic discovery: instead of fingerprinting the
 * tree, the extractor consumes exactly the file sets a manifest names. The manifest itself is produced
 * by a separate authoring/locate step; Core only validates and resolves it — zero model calls here.
 *
 *   { "sources": [ { "format": "gorm", "include": ["internal/model/*.go", "internal/const/tables.go"] } ] }
 *
 * `include` entries are relative paths (resolved and required to exist) or simple globs (`*`, `**`, `?`)
 * matched against the target's file universe. A source whose `format` has no parser is not an error —
 * it takes the same honest `UnsupportedFormat` path as auto-discovery, so a manifest that points at a
 * Prisma schema still reports "located but unsupported" rather than failing silently.
 *
 * Output shape mirrors `discover.ts`'s `Discovery`, so the command treats manifest and discovery
 * identically downstream.
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { safeRelative } from "../base/util.ts";
import { scanFiles } from "../snapshot/snapshot.ts";
import { PARSERS } from "./parsers/parser.ts";
import type { Discovery, DiscoveredSource } from "./discover.ts";
import type { FileRef, SchemaFormat, UnsupportedFormat } from "./types.ts";

interface RawManifest {
  sources: Array<{ format: string; include: string[] }>;
}

/** Load, validate, and resolve a manifest against the target tree. Throws on malformed input. */
export async function loadManifest(manifestPath: string, target: string): Promise<Discovery> {
  const root = resolve(target);
  const raw = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);

  // Group by format first: two entries naming the same format union their includes into one source,
  // so there is at most one source per format (matching what auto-discovery produces).
  const includesByFormat = new Map<string, string[]>();
  for (const entry of raw.sources) {
    const list = includesByFormat.get(entry.format) ?? [];
    list.push(...entry.include);
    includesByFormat.set(entry.format, list);
  }

  const universe = (await scanFiles(root)).map((file) => file.relativePath);
  const sources: DiscoveredSource[] = [];
  const unsupported: UnsupportedFormat[] = [];

  for (const [format, includes] of [...includesByFormat.entries()].sort(([a], [b]) => cmp(a, b))) {
    const files = await resolveIncludes(includes, universe, root, format, manifestPath);
    if (isKnownFormat(format)) {
      sources.push({ format, files });
    } else {
      unsupported.push({
        format,
        reason: `Manifest names format '${format}', which this extractor has no parser for.`,
        evidence: files.map((file): FileRef => ({ file })),
      });
    }
  }

  sources.sort((a, b) => cmp(a.format, b.format));
  unsupported.sort((a, b) => cmp(a.format, b.format));
  return { sources, unsupported };
}

function parseManifest(text: string, manifestPath: string): RawManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Manifest ${manifestPath} is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as RawManifest).sources)) {
    throw new Error(`Manifest ${manifestPath} must be an object with a "sources" array.`);
  }
  const sources = (parsed as RawManifest).sources;
  sources.forEach((entry, index) => {
    if (!entry || typeof entry.format !== "string" || !entry.format.trim()) {
      throw new Error(`Manifest ${manifestPath} sources[${index}] is missing a non-empty "format".`);
    }
    if (!Array.isArray(entry.include) || entry.include.some((value) => typeof value !== "string")) {
      throw new Error(`Manifest ${manifestPath} sources[${index}] "include" must be an array of strings.`);
    }
  });
  return { sources };
}

/** Resolve one format's include list to a sorted, de-duplicated set of existing relative paths. */
async function resolveIncludes(
  includes: string[],
  universe: string[],
  root: string,
  format: string,
  manifestPath: string,
): Promise<string[]> {
  const resolved = new Set<string>();
  for (const raw of includes) {
    const pattern = raw.replaceAll("\\", "/").replace(/^\.\/+/, "");
    if (isGlob(pattern)) {
      const re = globToRegExp(pattern);
      const matches = universe.filter((file) => re.test(file));
      if (!matches.length) {
        throw new Error(`Manifest ${manifestPath}: glob "${raw}" (format ${format}) matched no files under the target.`);
      }
      for (const match of matches) resolved.add(match);
    } else {
      const rel = safeRelative(root, join(root, pattern));
      if (!(await isFile(join(root, rel)))) {
        throw new Error(`Manifest ${manifestPath}: file "${raw}" (format ${format}) does not exist under the target.`);
      }
      resolved.add(rel);
    }
  }
  return [...resolved].sort(cmp);
}

function isKnownFormat(format: string): format is SchemaFormat {
  return Object.prototype.hasOwnProperty.call(PARSERS, format);
}

function isGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** Minimal, zero-dep glob: `**` any depth, `*` within a segment, `?` one non-slash char. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
