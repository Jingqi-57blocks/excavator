/**
 * Optional cross-language definition census via universal-ctags.
 *
 * This is a supplementary, DEGRADABLE cross-check: it counts definitions by kind and language across
 * the target, independent of the tree-sitter Perl pass, so a report can cite a defensible "N packages
 * / M subroutines / K classes" inventory and notice if tree-sitter under-recovered. It is NOT required
 * — if no Universal Ctags binary is present the census returns `available:false` with a reason and the
 * graph is built from tree-sitter alone.
 *
 * Only Universal Ctags is accepted (the BSD/Exuberant `ctags` shipped with Xcode lacks JSON output and
 * modern Perl kinds); the binary is verified by its `--version` banner before use.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CtagsCensus } from "./types.ts";

const execFileAsync = promisify(execFile);
const CANDIDATES = ["/opt/homebrew/bin/ctags", "/usr/local/bin/ctags", "/usr/bin/ctags", "ctags"];
const EXCLUDES = ["node_modules", ".git", ".hg", ".svn", "vendor", ".codegraph", ".excavator", ".work"];
const LANGUAGES = "Perl,Python,JavaScript,SQL,HTML";
const MAX_BUFFER = 256 * 1024 * 1024;

/** Locate a Universal Ctags binary, or return null if none is installed. */
async function findUniversalCtags(): Promise<string | null> {
  for (const bin of CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 5000 });
      if (stdout.includes("Universal Ctags")) return bin;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Run a definition census over `target`. Never throws; degrades to `available:false`. */
export async function runCtagsCensus(target: string): Promise<CtagsCensus> {
  const empty = { byKind: {}, byLanguage: {} };
  const bin = await findUniversalCtags();
  if (!bin) {
    return { available: false, reason: "no Universal Ctags binary found on PATH", ...empty };
  }

  const args = [
    "-R", "--output-format=json", "--fields=+Kl", `--languages=${LANGUAGES}`,
    ...EXCLUDES.map((dir) => `--exclude=${dir}`),
    "-f", "-", target,
  ];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(bin, args, { timeout: 180_000, maxBuffer: MAX_BUFFER }));
  } catch (error) {
    return { available: false, reason: `ctags run failed: ${(error as Error).message}`, ...empty };
  }

  const byKind: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let tag: { _type?: string; kind?: string; language?: string };
    try {
      tag = JSON.parse(line);
    } catch {
      continue;
    }
    if (tag._type !== "tag") continue;
    if (tag.kind) byKind[tag.kind] = (byKind[tag.kind] ?? 0) + 1;
    if (tag.language) byLanguage[tag.language] = (byLanguage[tag.language] ?? 0) + 1;
  }
  return { available: true, byKind, byLanguage };
}
