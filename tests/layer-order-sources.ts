import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

// The only impure half of the layer-order instrument: read `src/**.ts` off disk. Kept out of
// `layer-order-check.ts` so the checks themselves stay pure functions that negative fixtures can feed
// synthetic file sets. Paths are repo-relative ("src/base/util.ts") so a violation message names the file the
// way a human greps for it.

const REPO_ROOT = resolve(import.meta.dirname, "..");

export async function loadSourceFiles(root: string = "src"): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const name of (await readdir(join(REPO_ROOT, dir))).sort()) {
      const relativePath = `${dir}/${name}`;
      if ((await stat(join(REPO_ROOT, relativePath))).isDirectory()) { pending.push(relativePath); continue; }
      if (!name.endsWith(".ts")) continue;
      files.set(relativePath, await readFile(join(REPO_ROOT, relativePath), "utf8"));
    }
  }
  return files;
}
