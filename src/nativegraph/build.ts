/**
 * Build a NativeGraph for one target: tree-sitter Perl extraction across the whole tree, cross-file
 * call resolution against the discovered internal packages, a Zope template inventory, and an optional
 * universal-ctags census. Deterministic — every list is sorted before it lands, no wall-clock enters.
 *
 * The graph is a NAVIGATION aid (same role as CodeGraph for supported languages); it is written to a
 * side file and handed to report authoring so Perl/Zope symbols and call relationships can be located
 * and then grounded to real source windows. It is never an audit-chain artifact.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scanFiles } from "../snapshot/snapshot.ts";
import { extractPerlFile } from "./perl.ts";
import { scanTemplates } from "./templates.ts";
import type { TemplateEntry } from "./templates.ts";
import { runCtagsCensus } from "./ctags.ts";
import type {
  CallEdge, CallKind, NativeGraph, NativeGraphWarning, PackageEdge, PerlPackage, PerlSub,
} from "./types.ts";

const PERL_EXT = new Set([".pm", ".pl", ".t", ".cgi", ".psgi", ".pod"]);
const ZPT_EXT = new Set([".zpt", ".pt"]);
const DTML_EXT = new Set([".dtml"]);

export interface BuildOptions {
  target: string;
  gitHead?: string;
  /** Run the optional universal-ctags census (default true; tests disable it for determinism). */
  ctags?: boolean;
}

export async function buildNativeGraph(options: BuildOptions): Promise<NativeGraph> {
  const target = resolve(options.target);
  const scanned = await scanFiles(target);

  const packages: PerlPackage[] = [];
  const subs: PerlSub[] = [];
  const callEdges: CallEdge[] = [];
  const templateEntries: TemplateEntry[] = [];
  const warnings: NativeGraphWarning[] = [];
  const scannedExt = new Set<string>();
  let files = 0;
  let parsedFiles = 0;

  for (const file of scanned) {
    if (PERL_EXT.has(file.extension)) {
      files++;
      scannedExt.add(file.extension);
      const source = await readOrEmpty(file.absolutePath);
      const extraction = extractPerlFile(source, file.relativePath);
      if (!extraction.ok) {
        warnings.push({ kind: "parse-failed", message: "tree-sitter failed to parse", file: file.relativePath });
        continue;
      }
      parsedFiles++;
      packages.push(...extraction.packages);
      subs.push(...extraction.subs);
      callEdges.push(...extraction.calls);
    } else if (ZPT_EXT.has(file.extension)) {
      templateEntries.push({ file: file.relativePath, kind: "zpt", content: await readOrEmpty(file.absolutePath) });
    } else if (DTML_EXT.has(file.extension)) {
      templateEntries.push({ file: file.relativePath, kind: "dtml", content: await readOrEmpty(file.absolutePath) });
    }
  }

  // Resolve internal package→package edges: a package-method / super call whose receiver names a
  // package we actually extracted, from within another extracted package.
  // A package-method / super edge whose receiver is NOT an extracted package stays as-is (its
  // resolvedPackage names an external CPAN/framework module); only receivers that are internal
  // packages become internal package→package edges below.
  const knownPackages = new Set(packages.map((p) => p.name));
  const packageEdgeCounts = new Map<string, PackageEdge>();
  for (const edge of callEdges) {
    if (
      (edge.kind === "package-method" || edge.kind === "super") &&
      edge.fromPackage && edge.resolvedPackage &&
      knownPackages.has(edge.fromPackage) && knownPackages.has(edge.resolvedPackage) &&
      edge.fromPackage !== edge.resolvedPackage
    ) {
      const key = `${edge.fromPackage} ${edge.resolvedPackage}`;
      const existing = packageEdgeCounts.get(key);
      if (existing) existing.count++;
      else packageEdgeCounts.set(key, { from: edge.fromPackage, to: edge.resolvedPackage, count: 1 });
    }
  }

  const ctags = options.ctags === false
    ? { available: false, reason: "ctags census skipped", byKind: {}, byLanguage: {} }
    : await runCtagsCensus(target);

  const edgesByKind = countKinds(callEdges);
  packages.sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.name, b.name));
  subs.sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.name, b.name));
  callEdges.sort((a, b) => cmp(a.fromFile, b.fromFile) || a.fromLine - b.fromLine || cmp(a.callee, b.callee) || cmp(a.kind, b.kind));
  const packageEdges = [...packageEdgeCounts.values()].sort((a, b) => b.count - a.count || cmp(a.from, b.from) || cmp(a.to, b.to));

  const graph: NativeGraph = {
    target,
    ...(options.gitHead ? { gitHead: options.gitHead } : {}),
    scannedExtensions: [...scannedExt].sort(cmp),
    packages,
    subs,
    callEdges,
    packageEdges,
    templates: scanTemplates(templateEntries),
    ctags,
    stats: {
      files,
      parsedFiles,
      packages: packages.length,
      subs: subs.length,
      callEdges: callEdges.length,
      edgesByKind,
      resolvedEdges: callEdges.filter((e) => e.kind === "package-method" || e.kind === "super").length,
      dynamicEdges: edgesByKind.dynamic,
    },
    warnings: warnings.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.file ?? "", b.file ?? "")),
  };
  return graph;
}

function countKinds(edges: CallEdge[]): Record<CallKind, number> {
  const counts: Record<CallKind, number> = {
    "package-method": 0, self: 0, super: 0, dynamic: 0, function: 0, builtin: 0,
  };
  for (const edge of edges) counts[edge.kind]++;
  return counts;
}

async function readOrEmpty(absolutePath: string): Promise<string> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    return "";
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
