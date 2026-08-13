/**
 * Human-readable navigation summary of a NativeGraph, for report authoring.
 *
 * This is a MAP, not evidence: it points authoring at the largest packages, the internal call
 * structure, and the template surface so an investigator knows where to open real source. It states
 * its own limits plainly (dynamic-dispatch edges are unresolved; template refs are textual). Written
 * in English to match the neutral driver instructions; the final report's language is independent.
 */

import type { NativeGraph, PerlSub } from "./types.ts";

const MVC_SEGMENTS = ["Controller", "Model", "View", "Schema", "Role", "Plugin"];

export function renderNativeGraphSummary(graph: NativeGraph): string {
  const out: string[] = [];
  const s = graph.stats;

  out.push("# Native-language navigation graph", "");
  out.push(`- Target: ${graph.target}`);
  if (graph.gitHead) out.push(`- Git HEAD: ${graph.gitHead}`);
  out.push(`- Scanned Perl extensions: ${graph.scannedExtensions.join(", ") || "—"}`);
  out.push(
    `- Perl files: ${s.files} (parsed ${s.parsedFiles}); packages ${s.packages}; subs ${s.subs}; ` +
      `call sites ${s.callEdges}`,
  );
  out.push(
    `- Call sites by kind: package-method ${s.edgesByKind["package-method"]}, self ${s.edgesByKind.self}, ` +
      `super ${s.edgesByKind.super}, dynamic ${s.edgesByKind.dynamic}, function ${s.edgesByKind.function}, ` +
      `builtin ${s.edgesByKind.builtin}`,
  );
  out.push("");

  // ctags cross-check
  out.push("## Definition census (universal-ctags)", "");
  if (graph.ctags.available) {
    out.push(`- By language: ${kv(graph.ctags.byLanguage)}`);
    out.push(`- By kind: ${kv(graph.ctags.byKind)}`, "");
  } else {
    out.push(`_Unavailable: ${graph.ctags.reason ?? "n/a"} — figures below are tree-sitter only._`, "");
  }

  // Largest packages by sub count
  const subCounts = subCountByPackage(graph.subs);
  const pkgRows = graph.packages
    .map((p) => ({ ...p, subs: subCounts.get(p.name) ?? 0 }))
    .sort((a, b) => b.subs - a.subs || cmp(a.name, b.name))
    .slice(0, 40);
  out.push("## Largest packages (by sub count)", "");
  out.push("| package | subs | declared at |", "| --- | --- | --- |");
  for (const p of pkgRows) out.push(`| ${p.name} | ${p.subs} | ${p.file}:${p.line} |`);
  out.push("");

  // MVC-shaped grouping (generic name heuristic; not target-specific)
  const mvc = groupByMvc(graph.packages.map((p) => p.name));
  if (mvc.length) {
    out.push("## Framework-shaped packages (name heuristic)", "");
    for (const [segment, names] of mvc) {
      out.push(`- **::${segment}::** (${names.length}): ${names.slice(0, 20).join(", ")}${names.length > 20 ? " …" : ""}`);
    }
    out.push("");
  }

  // Internal package dependency edges
  out.push("## Internal package call edges (resolved receiver, top 40)", "");
  if (graph.packageEdges.length) {
    out.push("| from | → to | calls |", "| --- | --- | --- |");
    for (const e of graph.packageEdges.slice(0, 40)) out.push(`| ${e.from} | ${e.to} | ${e.count} |`);
  } else {
    out.push("_No internal package→package edges resolved._");
  }
  out.push("");

  // Templates
  out.push("## Zope template surface", "");
  out.push(`- ZPT/TAL files: ${graph.templates.zptFiles}; DTML files: ${graph.templates.dtmlFiles}`);
  if (graph.templates.refs.length) {
    const top = graph.templates.refs.slice(0, 30).map((r) => `${r.name} (${r.count})`).join(", ");
    out.push(`- Most-referenced names (textual): ${top}`);
  }
  out.push("");

  out.push("## Reading limits (honesty)", "");
  out.push(`- ${s.dynamicEdges} call sites have a runtime receiver (\`$obj->method\`) and are NOT resolved to a package.`);
  out.push("- Template references are regex-extracted text, not verified dispatch.");
  out.push("- This graph is navigation only; every report claim must be grounded to a real source window.");
  out.push("");

  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

function subCountByPackage(subs: PerlSub[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sub of subs) {
    if (!sub.package) continue;
    counts.set(sub.package, (counts.get(sub.package) ?? 0) + 1);
  }
  return counts;
}

function groupByMvc(names: string[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    for (const segment of MVC_SEGMENTS) {
      if (name.includes(`::${segment}::`) || name.endsWith(`::${segment}`)) {
        const list = groups.get(segment) ?? [];
        list.push(name);
        groups.set(segment, list);
      }
    }
  }
  return [...groups.entries()]
    .map(([segment, list]) => [segment, list.slice().sort(cmp)] as [string, string[]])
    .sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0]));
}

function kv(record: Record<string, number>): string {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "—";
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
