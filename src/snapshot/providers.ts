import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderRegistry, Snapshot } from "../base/types.ts";
import { nowIso, sha256, stableJson } from "../base/util.ts";
import { executableAvailable } from "../base/executable.ts";
import { discoverModules } from "./module-detection.ts";

export type CodeGraphMode = "auto" | "off";

export interface ResolvedModuleDatabase {
  id: string;
  dir: string;
  path: string;
}

export interface CodeGraphResolution {
  /** Single-database path: an explicit selection, or the target-root database (single-module / legacy). */
  path?: string;
  /** Per-module databases when the target splits into >= 2 modules that each have a built graph. */
  modules?: ResolvedModuleDatabase[];
  source: "explicit" | "auto" | "disabled" | "unavailable";
}

export async function resolveCodeGraphDatabase(targetInput: string, explicitPath?: string, mode: CodeGraphMode = "auto"): Promise<CodeGraphResolution> {
  if (mode === "off") return { source: "disabled" };
  const target = resolve(targetInput);
  if (explicitPath) {
    const path = resolve(explicitPath);
    return await readable(path) ? { path, source: "explicit" } : { source: "unavailable" };
  }
  // Prefer per-module databases when the target recognizably splits into modules and at least two
  // of them carry a built graph. A target with no recognized module marker never splits here, so
  // its single root database (or nothing) is used exactly as before.
  const modules = await discoverModules(target);
  if (modules.length >= 2) {
    const resolved: ResolvedModuleDatabase[] = [];
    for (const module of modules) {
      const path = join(target, module.dir, ".codegraph", "codegraph.db");
      if (await readable(path)) resolved.push({ id: module.id, dir: module.dir, path });
    }
    if (resolved.length >= 2) return { modules: resolved, source: "auto" };
  }
  const candidate = join(target, ".codegraph", "codegraph.db");
  return await readable(candidate) ? { path: candidate, source: "auto" } : { source: "unavailable" };
}

export async function createProviderRegistry(options: {
  snapshot: Snapshot;
  codegraphResolution: CodeGraphResolution;
  codegraphSelected: boolean;
  /**
   * The CodeGraph identity, computed by the caller with `codegraphIdentity()`. Passed in rather than read off
   * the snapshot: the snapshot is the SOURCE boundary and no longer carries an index digest at all.
   */
  codegraphDigest: string | null;
  codegraphOpenError?: string;
  binary?: string;
}): Promise<ProviderRegistry> {
  const binary = options.binary ?? "codegraph";
  const providers = [
    {
      id: "source",
      available: true,
      selected: true,
      version: options.snapshot.scannerVersion,
      path: options.snapshot.target,
      selectionReason: "Source is the mandatory final evidence provider.",
      capabilities: ["manifest", "search", "bounded-read", "digest-validation", "git-aware-boundary"],
      metadata: {
        ignoreRulesDigest: options.snapshot.ignoreRulesDigest,
        sourceManifestDigest: options.snapshot.sourceManifestDigest
      }
    },
    {
      id: "codegraph",
      available: Boolean(options.codegraphResolution.path || options.codegraphResolution.modules?.length),
      selected: options.codegraphSelected,
      path: options.codegraphResolution.path,
      selectionReason: providerReason(options.codegraphResolution.source, options.codegraphSelected, options.codegraphOpenError, options.codegraphResolution.modules?.length),
      capabilities: ["symbol-search", "relationship-expansion", "route-census", "cross-file-navigation"],
      metadata: {
        databaseSource: options.codegraphResolution.source,
        databaseDigest: options.codegraphDigest,
        moduleDatabases: options.codegraphResolution.modules,
        cli: { binary, available: await executableAvailable(binary) },
        openError: options.codegraphOpenError
      }
    }
  ];
  const unsigned = { version: 1 as const, snapshotId: options.snapshot.id, createdAt: nowIso(), providers };
  return { ...unsigned, digest: sha256(stableJson(unsigned)) };
}

function providerReason(source: CodeGraphResolution["source"], selected: boolean, openError?: string, moduleCount?: number): string {
  if (openError) return `The database was discovered but could not be opened: ${openError}`;
  if (selected && source === "explicit") return "The user explicitly selected this CodeGraph database.";
  if (selected && source === "auto" && moduleCount) return `${moduleCount} per-module CodeGraph databases were auto-detected and used as navigation providers; cross-module relationships fall to source.`;
  if (selected && source === "auto") return "A target-local CodeGraph database was auto-detected and used as a navigation provider.";
  if (source === "disabled") return "CodeGraph was explicitly disabled; source-only analysis is active.";
  if (source === "unavailable") return "No readable CodeGraph database was available; source-only analysis is active.";
  return "CodeGraph was not selected.";
}

async function readable(path: string): Promise<boolean> {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}
