/**
 * `excavator crossrepo` orchestration.
 *
 * Deterministic, zero-model, target is READ-ONLY: recover each backend module's route table, extract the
 * frontend HTTP calls, match them, and write `<out>/crossrepo-links.json` plus a readable summary.
 *
 * This command exists so the measurement that justified the resolver stays reproducible by anyone. Its
 * three counts — recovered routes, extracted calls, and what did NOT match with the reason — are the same
 * numbers the run artifact will carry, produced by the same functions.
 */

import { join, resolve } from "node:path";
import { atomicWrite, ensureDir, writeJson } from "../core/util.ts";
import { DEFAULT_WORKDIR } from "../core/defaults.ts";
import { resolveCodeGraphDatabase } from "../snapshot/providers.ts";
import { scanCrossRepoLinks, type CrossRepoScan, type ScanModule } from "./crossrepo-scan.ts";

export interface CrossRepoOptions {
  target: string;
  out?: string;
}

export interface CrossRepoResult {
  target: string;
  outDir: string;
  jsonPath: string;
  summaryPath: string;
  scan: CrossRepoScan;
}

export async function runCrossRepo(options: CrossRepoOptions): Promise<CrossRepoResult> {
  const target = resolve(options.target);
  const outDir = resolve(options.out ?? join(DEFAULT_WORKDIR, "crossrepo"));
  await ensureDir(outDir);

  const resolution = await resolveCodeGraphDatabase(target);
  const modules: ScanModule[] = resolution.modules?.map((module) => ({ id: module.id, dir: module.dir, databasePath: module.path })) ?? [];
  if (!modules.length && resolution.path) modules.push({ id: ".", dir: ".", databasePath: resolution.path });

  const scan = await scanCrossRepoLinks(target, modules);
  if (!modules.length) {
    scan.warnings.push("no CodeGraph database found: route registrations cannot be located, so no links were resolved");
  }

  const jsonPath = join(outDir, "crossrepo-links.json");
  const summaryPath = join(outDir, "crossrepo-summary.md");
  await writeJson(jsonPath, scan);
  await atomicWrite(summaryPath, renderSummary(target, scan));
  return { target, outDir, jsonPath, summaryPath, scan };
}

function renderSummary(target: string, scan: CrossRepoScan): string {
  const lines: string[] = [];
  lines.push(`# Cross-repo HTTP links`, "", `Target: \`${target}\``, "");
  lines.push(`Modules: ${scan.modules.join(", ") || "(none)"}`);
  lines.push(`Clients recognised: ${scan.clients.join(", ") || "(none)"}`, "");

  lines.push(`## Route recovery`, "");
  lines.push("| Module | Framework | Recovered | Graph route nodes | Unrecovered |", "| --- | --- | --- | --- | --- |");
  for (const entry of scan.routeRecovery) {
    lines.push(`| ${entry.module} | ${entry.framework} | ${entry.recovered} | ${entry.graphRouteNodes} | ${entry.unrecovered} |`);
  }
  lines.push("", "Recovery and the graph are reported side by side on purpose: neither is a superset of the other, and a gap in either direction is a fact about coverage rather than an error to hide.", "");

  lines.push(`## Calls`, "");
  lines.push(`- calls extracted: **${scan.summary.calls}**`);
  lines.push(`- linked: **${scan.summary.static + scan.summary.framework}** (static ${scan.summary.static}, framework ${scan.summary.framework})`);
  lines.push(`- ambiguous: ${scan.summary.ambiguous} — several modules serve the same path`);
  lines.push(`- weak candidates: ${scan.summary.weak} — recorded for a human, never asserted as links`);
  lines.push(`- unresolved: ${scan.summary.unresolved}`, "");

  const methodMisses = scan.unresolved.filter((entry) => entry.nearMisses.some((miss) => miss.mismatch === "method"));
  if (methodMisses.length) {
    lines.push(`## Calls whose path exists but whose method does not (${methodMisses.length})`, "");
    lines.push("A frontend calling a method the backend never registers is a finding about the system, not a limitation of the matcher.", "");
    for (const entry of methodMisses.slice(0, 20)) {
      lines.push(`- \`${entry.method} ${entry.routePath}\` (${entry.path}:${entry.line}) — backend serves \`${entry.nearMisses[0].route}\``);
    }
    lines.push("");
  }

  const noRoute = scan.unresolved.filter((entry) => !entry.nearMisses.length && entry.routePath);
  if (noRoute.length) {
    lines.push(`## Calls with no route at all (${noRoute.length})`, "");
    for (const entry of noRoute.slice(0, 20)) lines.push(`- \`${entry.method} ${entry.routePath}\` (${entry.path}:${entry.line})`);
    lines.push("");
  }

  if (scan.warnings.length) {
    lines.push(`## Warnings (${scan.warnings.length})`, "");
    for (const warning of scan.warnings.slice(0, 20)) lines.push(`- ${warning}`);
    lines.push("");
  }
  return lines.join("\n");
}
