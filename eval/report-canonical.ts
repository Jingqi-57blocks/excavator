// Canonical projection of a run's assemble artifacts: the bytes under `reports/` with this run's volatile
// identifiers replaced by named placeholders, so two runs of the same fixture project to the same bytes and a
// checked-in golden can pin them.
//
// The point is a byte pin that survives being run twice and dies on a content change. So the substitution list
// is deliberately short, explicit, and built from the RUN'S OWN artifacts rather than from patterns:
//
//   1. evidence ids   — every id in `evidence.json` becomes a placeholder naming WHAT that evidence is:
//                       `<EVIDENCE source src/server.ts:1-40>`. Source-window ids are
//                       `S-<digest of snapshotId:path:lines>`, so they move every run even though the cited
//                       evidence does not. The placeholder is derived from the catalog entry's own kind, path and
//                       line span (its title when it has no path), never from its position, so it does not depend
//                       on catalog ordering. Enumerated, not pattern-matched: an id-shaped string that is not in
//                       this run's catalog is left alone, and two ids that appear in the projection must map to
//                       different placeholders or the projection fails — a swap between two cited pieces of
//                       evidence stays visible as a diff.
//   2. run id         — `manifest.id`, exact string.
//   3. snapshot id    — `manifest.snapshot.id`, exact string (applied after evidence ids, because graph evidence
//                       ids embed the snapshot id and the exact-id rule has to match first).
//   4. target path    — the absolute target directory, exact string.
//   5. target name    — its basename, exact string; it reaches the report through the front-matter title.
//   6. timestamps     — ISO-8601 instants (`...THH:MM:SS[.mmm]Z`), the only pattern rule. A bare date or a bare
//                       clock time is NOT matched: the rule replaces instants, not anything date-shaped.
//
// Nothing else is touched. Section prose, claim statements, evidence markers, counts, headings, work-item ids
// and trace ids all reach the golden verbatim — which is what makes a one-byte change to a draft go red.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { EvidenceItem, RunManifest } from "../src/base/types.ts";

/** The volatile identifiers of one run, read off its own artifacts. */
export interface VolatileIdentity {
  runId: string;
  snapshotId: string;
  targetPath: string;
  targetName: string;
  /** Every evidence id in the catalog, mapped to the volatility-free description of what it is. */
  evidencePlaceholders: Record<string, string>;
}

export interface AppliedRule { name: string; placeholder: string; replacements: number; }

export interface CanonicalProjection {
  text: string;
  identity: VolatileIdentity;
  /** Report-relative paths, sorted; a changed file set changes the projection. */
  files: string[];
  applied: AppliedRule[];
}

const SEPARATOR = "===== file:";
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z/g;

function fail(message: string): never {
  throw new Error(`report canonical: ${message}`);
}

export function volatileIdentityFromRun(runDir: string): VolatileIdentity {
  const runPath = join(runDir, "run.json");
  if (!existsSync(runPath)) fail(`${runDir} has no run.json`);
  const manifest = JSON.parse(readFileSync(runPath, "utf8")) as RunManifest;
  if (!manifest.id) fail("run.json has no run id");
  if (!manifest.snapshot?.id) fail("run.json has no snapshot id");
  if (!manifest.request?.target) fail("run.json has no request target");
  const evidencePath = join(runDir, "evidence.json");
  if (!existsSync(evidencePath)) fail(`${runDir} has no evidence.json`);
  const catalog = JSON.parse(readFileSync(evidencePath, "utf8")) as { evidence: EvidenceItem[] };
  if (!Array.isArray(catalog.evidence)) fail("evidence.json has no evidence array");
  return {
    runId: manifest.id,
    snapshotId: manifest.snapshot.id,
    targetPath: manifest.request.target,
    targetName: basename(manifest.request.target),
    evidencePlaceholders: Object.fromEntries(catalog.evidence.map((item) => [item.id, evidencePlaceholder(item)]))
  };
}

/**
 * What one catalog entry IS, in terms that do not move between runs: its kind plus the source span it covers, or
 * its title when it covers no file. Deliberately content-derived — a catalog index would silently renumber if the
 * catalog were ever built in a different order, and the golden would go red for a reason nobody could read.
 */
function evidencePlaceholder(item: EvidenceItem): string {
  const span = item.path
    ? `${item.path}${item.startLine === undefined ? "" : `:${item.startLine}-${item.endLine ?? item.startLine}`}`
    : item.title;
  return `<EVIDENCE ${item.kind} ${span}>`;
}

/**
 * Apply the six rules in order and report how many times each fired. A rule that fires zero times is reported
 * as zero rather than hidden, so a test can require the rules it depends on to be load-bearing.
 */
export function canonicalizeText(text: string, identity: VolatileIdentity): { text: string; applied: AppliedRule[] } {
  const applied: AppliedRule[] = [];
  let out = text;

  // 1. evidence ids, longest first so no id can be eaten by a shorter id that prefixes it.
  const placeholders = new Map(Object.entries(identity.evidencePlaceholders));
  const ordered = [...placeholders.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  let evidenceHits = 0;
  const describedBy = new Map<string, string>();
  if (ordered.length) {
    const pattern = new RegExp(ordered.map(escapeRegExp).join("|"), "g");
    out = out.replace(pattern, (match) => {
      const placeholder = placeholders.get(match) ?? fail(`matched ${match} but it is not a catalog evidence id`);
      const owner = describedBy.get(placeholder);
      if (owner !== undefined && owner !== match) fail(`evidence ids ${owner} and ${match} both appear in the projection and both describe ${placeholder}, so the golden could not tell them apart`);
      describedBy.set(placeholder, match);
      evidenceHits += 1;
      return placeholder;
    });
  }
  applied.push({ name: "evidence-id", placeholder: "<EVIDENCE kind span>", replacements: evidenceHits });

  for (const [name, literal, placeholder] of [
    ["run-id", identity.runId, "<RUN-ID>"],
    ["snapshot-id", identity.snapshotId, "<SNAPSHOT-ID>"],
    ["target-path", identity.targetPath, "<TARGET-PATH>"],
    ["target-name", identity.targetName, "<TARGET-NAME>"]
  ] as const) {
    let hits = 0;
    if (literal) {
      const parts = out.split(literal);
      hits = parts.length - 1;
      out = parts.join(placeholder);
    }
    applied.push({ name, placeholder, replacements: hits });
  }

  let timestampHits = 0;
  out = out.replace(ISO_INSTANT, () => { timestampHits += 1; return "<TIMESTAMP>"; });
  applied.push({ name: "iso-instant", placeholder: "<TIMESTAMP>", replacements: timestampHits });

  return { text: out, applied };
}

/**
 * The canonical projection of everything `assemble` wrote under `reports/`: each file introduced by its
 * report-relative path, then its canonicalized bytes. One text, so the golden is one file and the diff reads.
 */
export function canonicalAssembleProjection(runDir: string): CanonicalProjection {
  const reports = join(runDir, "reports");
  if (!existsSync(reports)) fail(`${runDir} has no reports/ directory; assemble has not run`);
  const files = listFiles(reports);
  if (!files.length) fail(`${runDir}/reports is empty; assemble wrote nothing`);
  const identity = volatileIdentityFromRun(runDir);
  const parts: string[] = [];
  for (const file of files) {
    const raw = readFileSync(join(reports, file), "utf8");
    if (raw.includes(SEPARATOR)) fail(`reports/${file} contains the projection separator ${JSON.stringify(SEPARATOR)}`);
    parts.push(`${SEPARATOR} ${file} =====\n${raw}`);
  }
  const { text, applied } = canonicalizeText(parts.join("\n"), identity);
  return { text, identity, files, applied };
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out.sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
