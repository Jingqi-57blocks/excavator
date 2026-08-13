/**
 * Human-readable navigation summary of a FrameworkModel, for report authoring.
 *
 * A MAP, not evidence: it hands authoring the real route/entry-point inventory and component roles a
 * generic call graph cannot produce for a dynamically-dispatched framework app, so §"Interfaces and
 * entry points" and §"Code organization" can be written from convention rather than left as
 * cannot-determine — with claims still grounded to the cited source. Written in English to match the
 * neutral driver instructions; the final report language is independent.
 */

import type { FrameworkModel, RouteAction } from "./types.ts";

export function renderFrameworkSummary(model: FrameworkModel): string {
  const out: string[] = [];

  out.push("# Framework-convention navigation", "");
  out.push(`- Target: ${model.target}`);
  if (model.gitHead) out.push(`- Git HEAD: ${model.gitHead}`);
  out.push(`- Detected frameworks: ${model.detected.map((d) => `${d.name} (${d.confidence})`).join(", ") || "none"}`);
  const roles = model.stats.componentsByRole;
  out.push(
    `- Components: controller ${roles.controller}, model ${roles.model}, view ${roles.view}, ` +
      `schema ${roles.schema}, dispatch-type ${roles["dispatch-type"]}, role ${roles.role}, ` +
      `plugin ${roles.plugin}, application ${roles.application}, other ${roles.other}`,
  );
  out.push(`- Actions: ${model.stats.actions} (${kv(model.stats.actionsByKind)})`, "");

  // Detection evidence
  out.push("## Detection evidence", "");
  for (const framework of model.detected) {
    out.push(`- **${framework.name}** (${framework.confidence}):`);
    for (const item of framework.evidence.slice(0, 6)) out.push(`  - ${item.file}:${item.line} — ${item.hint}`);
  }
  out.push("");

  // Route / action inventory (the entry-point inventory a generic graph reports as empty)
  out.push("## Route / action inventory", "");
  if (model.routes.length) {
    out.push("| controller | action | kind | path/spec | attributes | at |", "| --- | --- | --- | --- | --- | --- |");
    for (const route of model.routes) out.push(routeRow(route));
  } else {
    out.push("_No convention-declared actions recovered._");
  }
  out.push("");

  // Component inventory grouped by role
  out.push("## Components by role", "");
  for (const role of ["controller", "model", "view", "schema", "dispatch-type", "role", "plugin", "application"] as const) {
    const named = model.components.filter((c) => c.role === role).map((c) => c.package);
    if (!named.length) continue;
    out.push(`- **${role}** (${named.length}): ${named.slice(0, 40).join(", ")}${named.length > 40 ? " …" : ""}`);
  }
  out.push("");

  if (model.warnings.length) {
    out.push("## Notes", "");
    for (const warning of model.warnings) out.push(`- [${warning.kind}] ${warning.message}${warning.file ? ` (${warning.file})` : ""}`);
    out.push("");
  }

  out.push("## Reading limits (honesty)", "");
  out.push("- Recovered from framework conventions (attributes/namespaces/config), not from a resolved call graph.");
  out.push("- A path/spec is shown only when the source states it literally; runtime-composed URLs are not inferred.");
  out.push("- This is navigation only; every report claim must be grounded to a real source window.");
  out.push("");

  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

function routeRow(route: RouteAction): string {
  const attrs = route.attributes.join(" ").replace(/\|/g, "\\|") || "—";
  const path = (route.pathHint ?? "—").replace(/\|/g, "\\|");
  return `| ${route.controller} | ${route.action} | ${route.kind} | ${path} | ${attrs} | ${route.file}:${route.line} |`;
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
