/**
 * Deterministic, zero-model schema-format discovery.
 *
 * Scans a target directory and fingerprints which schema formats are present, purely by FORMAT
 * signature (a `gorm:"` tag, a `queryInterface.createTable(` call, a `CREATE TABLE` statement) — never
 * by repo/business paths, so discovery is framework-neutral. The scan reuses the snapshot scanner
 * (`scanFiles`), so it honors the repo's `.gitignore` and the same excluded-directory conventions
 * (node_modules, vendor via gitignore, .git, …) and yields a deterministic, sorted file set.
 *
 * Two kinds of result:
 *   - `sources`: formats with a shipped parser (gorm / sequelize-migration / sequelize-model / sql-dump),
 *     each with the concrete relative-path file set that parser should consume.
 *   - `unsupported`: formats recognized by family but with NO parser (Prisma, Django, TypeORM,
 *     ActiveRecord). These are reported so the tool honestly says "located but unsupported" rather than
 *     silently missing schema that exists.
 *
 * Paths are relative to the target (POSIX-normalized) so provenance and the rendered report are
 * byte-stable across machines. Content is read only for the extensions that can carry a fingerprint.
 */

import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { scanFiles } from "../snapshot/snapshot.ts";
import type { FileRef, SchemaFormat, UnsupportedFormat } from "./types.ts";

/** One format that has a parser, plus the relative-path file set it should parse. */
export interface DiscoveredSource {
  format: SchemaFormat;
  files: string[];
}

/** The full discovery result: parseable sources plus honest report-only unsupported notices. */
export interface Discovery {
  sources: DiscoveredSource[];
  unsupported: UnsupportedFormat[];
}

const JS_EXT = new Set([".js", ".cjs", ".mjs"]);
const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);
/** Every extension the discovery loop below branches on. Exported so the mechanism registry's `db-schema`
 *  support set is proven equal to it, and so a new branch that forgets the registry fails a test rather than
 *  quietly reading a language the layer-2 ledger reports as uncovered. */
export const SCHEMA_EXTENSIONS: ReadonlySet<string> = new Set([".go", ...JS_EXT, ".sql", ...TS_EXT, ".py", ".rb"]);

// Format fingerprints. Each is a structural marker of the format, not of any particular repository.
const GORM_TAG = /gorm:"/;
// A gorm `TableName()` usually returns a typed string constant declared in a SEPARATE `constant`
// package (e.g. `return constant.TbEmp.String()` where `TbEmp TableName = "wcp_user"`). The const
// resolver can follow that once it has the declaring file, so any `.go` file carrying a typed
// string-const declaration (`IDENT TYPE = "literal"` inside a `const`) is added to the gorm file set
// — "the whole model+constant dir set". Structural Go syntax only, no repo/business strings.
const GO_CONST_KEYWORD = /\bconst\b/;
const GO_TYPED_STRING_CONST = /^[ \t]*[A-Za-z_]\w*[ \t]+[A-Za-z_][\w.]*[ \t]*=[ \t]*"/m;
const SQL_CREATE_TABLE = /\bCREATE\s+TABLE\b/i;
const SEQ_CREATE_TABLE = /\.\s*createTable\s*\(/;
const SEQ_RAW_QUERY = /\.\s*sequelize\s*\.\s*query\s*\(/;
const SEQ_DEFINE = /\.\s*define\s*\(/;
const SEQ_HINT = /\bsequelize\b|\bDataTypes\b/i;
const TYPEORM_ENTITY = /@Entity\b/;
const DJANGO_MODEL = /\bmodels\.Model\b/;
const ACTIVERECORD_SCHEMA = /(^|\/)db\/schema\.rb$/;

// Directories skipped by the supplemental Prisma walk (scanFiles cannot see `.prisma` — it is not a
// recognized source extension — so Prisma is the one format that needs its own filename lookup).
const PRISMA_SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", ".codegraph", ".excavator", ".excavator-work",
]);

interface UnsupportedAccumulator {
  format: string;
  reason: string;
  evidence: FileRef[];
}

/** Fingerprint every schema format present under `target`. Deterministic and zero-model. */
export async function discoverSchemaFormats(target: string): Promise<Discovery> {
  const root = resolve(target);
  const scanned = await scanFiles(root);

  // Per-directory Go file index so a gorm hit in a directory pulls in that directory's whole set
  // (its `TableName()` methods and any same-package constants). Table-name constants declared in a
  // SEPARATE package are added via `constFiles` below.
  const goByDir = new Map<string, string[]>();
  const gormDirs = new Set<string>();
  const constFiles: string[] = [];

  const migrationFiles: string[] = [];
  const modelFiles: string[] = [];
  const sqlFiles: string[] = [];
  const unsupported = new Map<string, UnsupportedAccumulator>();

  const note = (format: string, reason: string, ref: FileRef): void => {
    const acc = unsupported.get(format) ?? { format, reason, evidence: [] };
    acc.evidence.push(ref);
    unsupported.set(format, acc);
  };

  for (const file of scanned) {
    const rel = file.relativePath;
    const ext = file.extension;

    if (ext === ".go") {
      const dir = dirOf(rel);
      const list = goByDir.get(dir);
      if (list) list.push(rel);
      else goByDir.set(dir, [rel]);
      const content = await read(file.absolutePath);
      if (GORM_TAG.test(content)) gormDirs.add(dir);
      if (GO_CONST_KEYWORD.test(content) && GO_TYPED_STRING_CONST.test(content)) constFiles.push(rel);
      continue;
    }

    if (JS_EXT.has(ext)) {
      const content = await read(file.absolutePath);
      if (SEQ_CREATE_TABLE.test(content) || SEQ_RAW_QUERY.test(content)) migrationFiles.push(rel);
      else if (SEQ_DEFINE.test(content) && SEQ_HINT.test(content)) modelFiles.push(rel);
      continue;
    }

    if (ext === ".sql") {
      if (SQL_CREATE_TABLE.test(await read(file.absolutePath))) sqlFiles.push(rel);
      continue;
    }

    if (TS_EXT.has(ext)) {
      const line = firstMatchLine(await read(file.absolutePath), TYPEORM_ENTITY);
      if (line !== null) note("TypeORM", "TypeORM entities located; this extractor has no TypeORM parser.", { file: rel, line });
      continue;
    }

    if (ext === ".py") {
      const line = firstMatchLine(await read(file.absolutePath), DJANGO_MODEL);
      if (line !== null) note("Django", "Django models located; this extractor has no Django parser.", { file: rel, line });
      continue;
    }

    if (ext === ".rb" && ACTIVERECORD_SCHEMA.test(rel)) {
      note("ActiveRecord", "Rails db/schema.rb located; this extractor has no ActiveRecord parser.", { file: rel });
    }
  }

  // gorm file set: every `.go` in a gorm-tagged directory, plus the typed-string-const files that
  // declare the table-name constants those models reference (only when a gorm source exists at all).
  const gormSet = new Set<string>();
  for (const dir of gormDirs) for (const f of goByDir.get(dir) ?? []) gormSet.add(f);
  if (gormSet.size) for (const f of constFiles) gormSet.add(f);
  const gormFiles = [...gormSet].sort(cmp);

  for (const ref of await findPrismaFiles(root)) {
    note("Prisma", "Prisma schema located; this extractor has no Prisma parser.", ref);
  }

  const sources: DiscoveredSource[] = [];
  if (gormFiles.length) sources.push({ format: "gorm", files: gormFiles });
  if (migrationFiles.length) sources.push({ format: "sequelize-migration", files: migrationFiles.slice().sort(cmp) });
  if (modelFiles.length) sources.push({ format: "sequelize-model", files: modelFiles.slice().sort(cmp) });
  if (sqlFiles.length) sources.push({ format: "sql-dump", files: sqlFiles.slice().sort(cmp) });
  sources.sort((a, b) => cmp(a.format, b.format));

  return { sources, unsupported: finalizeUnsupported(unsupported) };
}

function finalizeUnsupported(map: Map<string, UnsupportedAccumulator>): UnsupportedFormat[] {
  return [...map.values()]
    .map((acc) => ({
      format: acc.format,
      reason: acc.reason,
      evidence: acc.evidence
        .slice()
        .sort((a, b) => cmp(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0))
        .slice(0, 20),
    }))
    .sort((a, b) => cmp(a.format, b.format));
}

/** Recursive filename lookup for `*.prisma`, the one format the shared source scanner cannot see. */
async function findPrismaFiles(root: string): Promise<FileRef[]> {
  const out: FileRef[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (PRISMA_SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".prisma")) {
        out.push({ file: posix(root, join(dir, entry.name)) });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => cmp(a.file, b.file));
}

async function read(absolutePath: string): Promise<string> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    return "";
  }
}

/** 1-based line of the first match, or null when the pattern never matches. */
function firstMatchLine(content: string, pattern: RegExp): number | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) if (pattern.test(lines[i])) return i + 1;
  return null;
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function posix(root: string, absolute: string): string {
  return absolute.slice(root.length).replace(/^[/\\]+/, "").replaceAll("\\", "/");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
