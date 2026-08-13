/**
 * `excavator framework` orchestration.
 *
 * Deterministic, zero-model, target READ-ONLY: detect the framework(s) in a target and recover their
 * convention-declared components + routes, writing `<out>/framework-model.json` and a human-readable
 * `<out>/framework-summary.md`. Writes only under `--out`, never the target.
 */

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { atomicWrite, ensureDir, writeJson } from "../core/util.ts";
import { DEFAULT_WORKDIR } from "../core/defaults.ts";
import { buildFrameworkModel } from "./build.ts";
import { renderFrameworkSummary } from "./render.ts";
import type { FrameworkModel } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface FrameworkOptions {
  target: string;
  out?: string;
}

export interface FrameworkResult {
  target: string;
  outDir: string;
  jsonPath: string;
  summaryPath: string;
  detected: string[];
  stats: FrameworkModel["stats"];
}

export async function runFramework(options: FrameworkOptions): Promise<FrameworkResult> {
  const target = resolve(options.target);
  const outDir = resolve(options.out ?? join(DEFAULT_WORKDIR, "framework"));
  const gitHead = await headOf(target);

  const model = await buildFrameworkModel({ target, ...(gitHead ? { gitHead } : {}) });
  const summary = renderFrameworkSummary(model);

  await ensureDir(outDir);
  const jsonPath = join(outDir, "framework-model.json");
  const summaryPath = join(outDir, "framework-summary.md");
  await writeJson(jsonPath, model);
  await atomicWrite(summaryPath, summary);

  return {
    target,
    outDir,
    jsonPath,
    summaryPath,
    detected: model.detected.map((d) => d.name),
    stats: model.stats,
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
