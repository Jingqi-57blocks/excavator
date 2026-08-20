import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A TEST THAT MINTS A SYSTEM TEMP DIRECTORY MUST ROUTE THROUGH `tests/temp-dir.ts`.
 *
 * `mkdtemp` on its own leaks: the system reclaims those directories at reboot and nothing else does, so a suite
 * run leaves its whole working set behind. One day of runs left 259,350 of them once; the count was then brought
 * to zero, and it came back to 56,186 within a day — because the fix lived on `main` while every run happened on
 * a long-lived feature branch that never merged it. A helper nobody is forced to reach for is a helper that stops
 * being reached for, which is what this census is for.
 *
 * WHAT IT PINS: occurrences per file, not a file allowlist. A second `mkdtemp` added to `framework.test.ts` — a
 * file this list already names — is exactly the shape a per-file allowlist waves through, and it is a leak unless
 * its own `t.after` covers it.
 *
 * WHAT IT CANNOT CATCH, stated rather than implied. It is a text rule, and 57B-447 measured what happens when a
 * text rule is the whole defence: a call reached through an alias (`const make = mkdtemp`), or a directory built
 * with `mkdir` and a name of one's own, walks past it. Those shapes are covered by the second census below —
 * every route into the system temp area goes through `tmpdir()`, so pinning that expression's sites closes the
 * gap that pinning the one API name leaves open. Nothing here catches a hard kill (`SIGKILL`), which is the one
 * path `temp-dir.ts` itself also cannot clean up, and it is recorded there.
 */

const ROOTS = ["tests", "eval"] as const;

/**
 * This file is excluded from its own censuses: the self-tests below hold the very call shapes being counted, and
 * the doc comments name them in prose. It identifies itself from `import.meta.url` rather than by a filename
 * string, so a rename cannot silently turn the exclusion into a match for nothing — and the exclusion is asserted
 * to remove exactly one scanned file, which is the shape a typo in a name-based skip would fail to have.
 */
const SELF = fileURLToPath(import.meta.url);

/**
 * Every file allowed to call `mkdtemp` / `mkdtempSync` directly, with its occurrence count.
 *
 *   * `tests/temp-dir.ts` × 2 — the two shapes of the one implementation (async and sync). This is the file the
 *     rule exists to funnel everything into.
 *   * `tests/framework.test.ts` × 2 and `tests/nativegraph.test.ts` × 2 — each mint is paired with a `t.after`
 *     that removes it. Inside a test context `t.after` is the better shape than a process-exit registry, so these
 *     stay; the pairing is asserted below rather than trusted.
 */
const ALLOWED_MKDTEMP: ReadonlyArray<readonly [string, number]> = [
  ["tests/framework.test.ts", 2],
  ["tests/nativegraph.test.ts", 2],
  ["tests/temp-dir.ts", 2]
];

/**
 * Every file allowed to name the system temp area at all, with its occurrence count. Two entries here are not
 * mints and are the reason this census counts sites rather than forbidding the expression:
 *
 *   * `tests/intent-baseline-smoke.ts` × 1 — a STABLE per-fixture corpus path, deliberately reused so that
 *     `materializeCorpus` does not rebuild every navigation index. Bounded by the number of fixtures, not by the
 *     number of runs, and its own comment says so.
 *   * `eval/tests/assemble-golden.test.ts` × 1 — `tmpdir()` as a string to assert the ABSENCE of in the canonical
 *     projection. It creates nothing.
 */
const ALLOWED_TMPDIR: ReadonlyArray<readonly [string, number]> = [
  ["eval/tests/assemble-golden.test.ts", 1],
  ["tests/framework.test.ts", 2],
  ["tests/intent-baseline-smoke.ts", 1],
  ["tests/nativegraph.test.ts", 2],
  ["tests/temp-dir.ts", 2]
];

/**
 * Count a call, not a mention. `mkdtemp(` does not match inside `mkdtempSync(`, and neither matches the import
 * line `import { mkdtemp } from "node:fs/promises"` or prose about the name — the open paren is the whole
 * discriminator, and the doc comment above says which questions this cannot ask.
 */
function callSites(text: string, name: string): number {
  return text.split(`${name}(`).length - 1;
}

function mintSites(text: string): number {
  return callSites(text, "mkdtemp") + callSites(text, "mkdtempSync");
}

async function testFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await testFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

async function census(count: (text: string) => number): Promise<{ rows: Array<[string, number]>; scanned: number; skipped: number }> {
  const rows: Array<[string, number]> = [];
  let scanned = 0;
  let skipped = 0;
  for (const root of ROOTS) {
    for (const path of await testFiles(resolve(root))) {
      if (path === SELF) { skipped += 1; continue; }
      scanned += 1;
      const n = count(await readFile(path, "utf8"));
      if (n > 0) rows.push([join(root, relative(resolve(root), path)).split("\\").join("/"), n]);
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return { rows, scanned, skipped };
}

test("only temp-dir.ts and the two self-cleaning suites mint a system temp directory", async () => {
  const { rows, scanned, skipped } = await census(mintSites);
  assert.ok(scanned > 200, `the census must cover the whole tree; it saw ${scanned} files`);
  assert.equal(skipped, 1, "the census excludes exactly one file — itself; any other number means the exclusion no longer matches this file");
  assert.deepEqual(rows, ALLOWED_MKDTEMP.map((row) => [...row]),
    "an unlisted mkdtemp leaks its directory until the machine reboots; call tempDir/tempDirSync from tests/temp-dir.ts instead");
});

test("nothing else names the system temp area, so no mint can hide behind a different API", async () => {
  const { rows } = await census((text) => callSites(text, "tmpdir"));
  assert.deepEqual(rows, ALLOWED_TMPDIR.map((row) => [...row]),
    "an unlisted tmpdir() either mints a directory outside the helper or reads a path that should come from it");
});

test("the two exempt suites really do remove what they mint", async () => {
  for (const [path, mints] of [["tests/framework.test.ts", 2], ["tests/nativegraph.test.ts", 2]] as const) {
    const text = await readFile(resolve(path), "utf8");
    assert.equal(mintSites(text), mints, `${path}: the exemption is stated as ${mints} mints`);
    assert.ok(callSites(text, "t.after") >= mints,
      `${path} mints ${mints} directories and must register at least that many t.after cleanups; the exemption is the cleanup, not the file name`);
  }
});

test("the counter fires on a call and not on an import or a sentence about one", () => {
  assert.equal(mintSites('const dir = await mkdtemp(join(tmpdir(), "x-"));\n'), 1);
  assert.equal(mintSites('const dir = mkdtempSync(join(tmpdir(), "x-"));\n'), 1);
  assert.equal(mintSites('const a = await mkdtemp(p);\nconst b = mkdtempSync(p);\n'), 2);

  assert.equal(mintSites('import { mkdtemp } from "node:fs/promises";\n'), 0);
  assert.equal(mintSites("// mkdtemp on its own leaks, so this suite uses tempDir\n"), 0);
  assert.equal(callSites('import { tmpdir } from "node:os";\n', "tmpdir"), 0);
});
