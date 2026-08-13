/**
 * `excavator native-graph` orchestration.
 *
 * Deterministic, zero-model, target is READ-ONLY: build the NativeGraph (tree-sitter Perl + optional
 * universal-ctags census + Zope template inventory) and write `<out>/native-graph.json` and a
 * human-readable `<out>/native-graph-summary.md`. Writes only under `--out`, never the target.
 */

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { atomicWrite, ensureDir, writeJson } from "../core/util.ts";
import { DEFAULT_WORKDIR } from "../core/defaults.ts";
import { buildNativeGraph } from "./build.ts";
import { renderNativeGraphSummary } from "./render.ts";
import type { NativeGraph } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface NativeGraphOptions {
  target: string;
  out?: string;
  ctags?: boolean;
}

export interface NativeGraphResult {
  target: string;
  outDir: string;
  jsonPath: string;
  summaryPath: string;
  ctagsAvailable: boolean;
  stats: NativeGraph["stats"];
  templates: { zptFiles: number; dtmlFiles: number; distinctRefs: number };
}

export async function runNativeGraph(options: NativeGraphOptions): Promise<NativeGraphResult> {
  const target = resolve(options.target);
  const outDir = resolve(options.out ?? join(DEFAULT_WORKDIR, "native-graph"));
  const gitHead = await headOf(target);

  const graph = await buildNativeGraph({
    target,
    ...(gitHead ? { gitHead } : {}),
    ...(options.ctags === false ? { ctags: false } : {}),
  });
  const summary = renderNativeGraphSummary(graph);

  await ensureDir(outDir);
  const jsonPath = join(outDir, "native-graph.json");
  const summaryPath = join(outDir, "native-graph-summary.md");
  await writeJson(jsonPath, graph);
  await atomicWrite(summaryPath, summary);

  return {
    target,
    outDir,
    jsonPath,
    summaryPath,
    ctagsAvailable: graph.ctags.available,
    stats: graph.stats,
    templates: {
      zptFiles: graph.templates.zptFiles,
      dtmlFiles: graph.templates.dtmlFiles,
      distinctRefs: graph.templates.refs.length,
    },
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
