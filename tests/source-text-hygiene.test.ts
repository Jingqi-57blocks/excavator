import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TREES = ["src", "tests", "eval", "packages"];
const SKIP_DIRS = new Set(["node_modules", ".git", "fixtures", "dist", "build"]);

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...await sourceFiles(path));
    } else if (entry.isFile() && /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * A raw control byte in a source file makes grep classify the whole file as binary, and the file then goes
 * silently missing from every text-scanning tool — including the import-graph parser the layer-order test
 * is built on. `npm test` and `tsc` both pass regardless, so no other gate can see it.
 *
 * This has now happened twice, both times as a NUL used as a composite-key separator written as a raw byte
 * instead of `\0`. The escape is identical in meaning and keeps the file plain text. Removing this test
 * makes that class of defect invisible again, which is the point of pinning it here.
 */
test("no source file carries a raw control byte outside tab and newline", async () => {
  const files: string[] = [];
  for (const tree of TREES) files.push(...await sourceFiles(join(ROOT, tree)));
  assert.ok(files.length > 100, `expected to scan the source trees, scanned ${files.length} files`);

  const offenders: string[] = [];
  for (const path of files) {
    const bytes = await readFile(path);
    for (const [index, byte] of bytes.entries()) {
      // Allow tab (9), newline (10), carriage return (13); reject every other C0 control and DEL.
      if ((byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 0x7f) {
        const line = bytes.subarray(0, index).toString("utf8").split("\n").length;
        offenders.push(`${relative(ROOT, path)}:${line} byte 0x${byte.toString(16).padStart(2, "0")}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], `write control characters as escapes (\\0, \\x1b), not raw bytes:\n${offenders.join("\n")}`);
});
