/**
 * Build a FrameworkModel for one target: scan the tree, run every framework pack that detects its
 * framework, and aggregate the recovered components + routes. Deterministic (all lists sorted, no
 * wall-clock), zero-model, target read-only. Reuses the snapshot scanner so `.gitignore` and excluded
 * directories are honored, and paths are target-relative for byte-stable provenance.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scanFiles } from "../snapshot/snapshot.ts";
import { PACKS } from "./pack.ts";
import type {
  ComponentRole, DetectedFramework, FrameworkComponent, FrameworkModel, FrameworkWarning, RouteAction, SourceText,
} from "./types.ts";

export interface FrameworkBuildOptions {
  target: string;
  gitHead?: string;
}

const ALL_ROLES: ComponentRole[] = [
  "application", "controller", "model", "view", "schema", "dispatch-type", "role", "plugin", "other",
];

export async function buildFrameworkModel(options: FrameworkBuildOptions): Promise<FrameworkModel> {
  const target = resolve(options.target);
  const scanned = await scanFiles(target);

  const wanted = new Set(PACKS.flatMap((pack) => pack.extensions));
  const texts: SourceText[] = [];
  for (const file of scanned) {
    if (wanted.has(file.extension)) texts.push({ file: file.relativePath, content: await readOrEmpty(file.absolutePath) });
  }

  const detected: DetectedFramework[] = [];
  const components: FrameworkComponent[] = [];
  const routes: RouteAction[] = [];
  const warnings: FrameworkWarning[] = [];

  for (const pack of PACKS) {
    const packTexts = texts.filter((t) => pack.extensions.some((ext) => t.file.endsWith(ext)));
    if (!packTexts.length) continue;
    const found = pack.detect(packTexts);
    if (!found) continue;
    detected.push(found);
    const result = pack.extract(packTexts);
    components.push(...result.components);
    routes.push(...result.routes);
    warnings.push(...result.warnings);
  }

  detected.sort((a, b) => cmp(a.name, b.name));
  components.sort((a, b) => cmp(a.package, b.package) || cmp(a.file, b.file));
  routes.sort((a, b) => cmp(a.controller, b.controller) || cmp(a.action, b.action) || a.line - b.line);
  warnings.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.message, b.message));

  const componentsByRole = Object.fromEntries(ALL_ROLES.map((r) => [r, 0])) as Record<ComponentRole, number>;
  for (const component of components) componentsByRole[component.role]++;
  const actionsByKind: Record<string, number> = {};
  for (const route of routes) actionsByKind[route.kind] = (actionsByKind[route.kind] ?? 0) + 1;

  return {
    target,
    ...(options.gitHead ? { gitHead: options.gitHead } : {}),
    detected,
    components,
    routes,
    stats: {
      frameworks: detected.map((d) => d.name).sort(cmp),
      componentsByRole,
      actions: routes.length,
      actionsByKind,
    },
    warnings,
  };
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
