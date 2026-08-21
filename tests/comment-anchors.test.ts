import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/**
 * Every path this repository's own `src/` comments point at must exist.
 *
 * WHY EXISTENCE AND NOT LINES. `tests/layering-anchors.test.ts` measured what hand-kept line anchors are worth:
 * six of twenty rotted inside a single slice, one of them off by 41 lines, while the prose kept reading as if it
 * were true. That test can hold `path:line` anchors to their content because `docs/layering.md` carries twenty
 * of them and a stated fragment each. `src/` comments are a different population — hundreds of references, most
 * of them naming a module rather than a location — so the affordable and honest check is the one that cannot
 * produce fake precision: THE FILE MUST EXIST. A `:line` suffix on an anchor is read and then DISCARDED here;
 * this test never asserts anything about a line number, and no existing line anchor was rewritten to add one.
 *
 * THE WRITING RULE THIS ENFORCES THE FLOOR OF: a new anchor names a FILE AND A SYMBOL (`plan-stage.ts`'s
 * `writePlan`), not a line. A symbol survives an edit above it; a line does not. This test cannot check the
 * symbol half — that is the reviewer's — but it does guarantee the file half never silently rots, which is the
 * half that goes wrong when a module is renamed, moved or deleted.
 *
 * WHAT COUNTS AS AN ANCHOR, structurally rather than by an exception list: a token inside a comment that has at
 * least one `/` and a source-file extension, AND whose first segment is a real top-level directory of this
 * repository. A path belonging to an ANALYSED TARGET is therefore not an anchor into this tree — and when such a
 * path would collide (a target with its own `src/`), it is written with its module prefix, which is both more
 * accurate and structurally distinct. A bare filename in backticks (`plan-stage.ts`) is a NAME, not an anchor:
 * it has no directory, so it points at nothing that can rot into a wrong file.
 */

const ROOT = resolve(import.meta.dirname, "..");
const COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const ANCHOR = /(?<![\w./-])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|md|json|js|mjs|sql|ya?ml))(?::\d+(?:-\d+)?)?/g;

/** The extractor is worthless if it silently finds nothing, so the census it produces is asserted too. */
const MINIMUM_ANCHORS = 20;

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

async function topLevelDirectories(): Promise<Set<string>> {
  const entries = await readdir(ROOT, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name));
}

test("every repository path named in a src/ comment exists", async () => {
  const tops = await topLevelDirectories();
  const anchors = new Map<string, Set<string>>();
  for (const file of await tsFiles(join(ROOT, "src"))) {
    const text = await readFile(file, "utf8");
    for (const comment of text.match(COMMENT) ?? []) {
      for (const match of comment.matchAll(ANCHOR)) {
        const path = match[1];
        if (!tops.has(path.split("/")[0])) continue;
        anchors.set(path, (anchors.get(path) ?? new Set()).add(relative(ROOT, file)));
      }
    }
  }
  assert.ok(anchors.size >= MINIMUM_ANCHORS, `the extractor found only ${anchors.size} anchors; it is broken, not the tree`);

  const missing: string[] = [];
  for (const [path, citedBy] of [...anchors].sort()) {
    const exists = await readFile(join(ROOT, path)).then(() => true, () => false);
    if (!exists) missing.push(`${path} — cited by ${[...citedBy].sort().join(", ")}`);
  }
  assert.deepEqual(missing, [], `comment anchors point at files that do not exist:\n${missing.join("\n")}`);
});
