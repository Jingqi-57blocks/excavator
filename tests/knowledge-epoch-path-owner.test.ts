import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/**
 * `knowledge.json` IS EPOCH 0'S ARCHIVE LOCATION, NOT "THE KNOWLEDGE FILE".
 *
 * Every later epoch lives at `knowledge/epochs/epoch-N.json`, and the one function that knows this is
 * `knowledgeEpochRelativePath` in `src/freeze/freeze.ts`, reached through `currentKnowledgeRelativePath` /
 * `readCurrentKnowledge`. A reader that spells the epoch-0 name itself is reading a superseded record on every
 * re-frozen run — which is exactly what the Topic Catalog did, and it went unnoticed because on an epoch-0 run the
 * literal and the mapping agree.
 *
 * THIS SCAN IS THE FIRST LINE, NOT THE ONLY ONE. It is a text rule, and 57B-447 measured what happens when a text
 * rule is the whole defence: a path assembled from a variable, or a name reached through a helper, walks straight
 * past it. The second line is structural and cannot be evaded — `loadTopicCatalogSource` compares the record it
 * read against the epoch the manifest selects, so a return to a literal fails on every run past epoch 0 (see
 * `tests/topic-catalog-epoch.test.ts`) — and the third is the real supplement→re-freeze→re-plan chain in
 * `tests/unit-authoring.test.ts`.
 *
 * WHAT THE CENSUS PINS. Counts per file, not a file allowlist: a new literal added to `freeze.ts` itself would
 * pass a per-file allowlist while being exactly the kind of second mapping this rule exists to stop.
 */

const SOURCE_ROOT = resolve("src");

/**
 * The occurrences of the exact string literal `"knowledge.json"` that `src/**` is allowed to hold, per file.
 *
 *   * `freeze/freeze.ts` × 4 — the epoch-to-path mapping itself, the two legacy inline-supplement-ledger sites
 *     (an archived run keeps its supplements inside epoch 0's record, deliberately), and the epoch-0 existence
 *     probe that decides whether `auditFrozenKnowledge` has a chain to walk at all. Epoch 0 is always there.
 *   * `run/run.ts` × 2 — two existence probes ("has this run ever been frozen?"), each followed immediately by
 *     `readCurrentKnowledge`, which is what actually reads the content at the manifest-selected epoch.
 *   * `base/artifact-registry.ts` × 1 — the registry's `pathTemplate` for the epoch-0 slot, whose own
 *     `enforcementNote` states that later epochs are covered by the freeze audit rather than by a path template.
 *
 * Anything else is a second answer to "where is this run's knowledge", and the answer it gives is epoch 0.
 */
const ALLOWED_OCCURRENCES: ReadonlyArray<readonly [string, number]> = [
  ["base/artifact-registry.ts", 1],
  ["freeze/freeze.ts", 4],
  ["run/run.ts", 2]
];

/**
 * Count the exact literal, quotes included.
 *
 * The quotes are the whole discriminator: a prose mention in a comment, and a failure message that starts with
 * `knowledge.json is missing`, are both about the name without being a path built from it. The scan asks one
 * narrow question and the doc comment above says which questions it cannot ask.
 */
function epochZeroLiterals(text: string): number {
  return text.split('"knowledge.json"').length - 1;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

test("only freeze, the registry and run.ts's freeze probes spell epoch 0's location", async () => {
  const census: Array<[string, number]> = [];
  let scanned = 0;
  for (const path of await sourceFiles(SOURCE_ROOT)) {
    scanned += 1;
    const count = epochZeroLiterals(await readFile(path, "utf8"));
    if (count > 0) census.push([relative(SOURCE_ROOT, path).split("\\").join("/"), count]);
  }
  assert.ok(scanned > 80, `the scan must cover the whole tree; it saw ${scanned} files`);
  census.sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(census, ALLOWED_OCCURRENCES.map((row) => [...row]),
    'each unlisted "knowledge.json" is a reader pinned to epoch 0; route it through readCurrentKnowledge / currentKnowledgeRelativePath instead');
});

test("the scan really fires on the shape it exists to catch, and not on prose about it", () => {
  // The defect itself, verbatim: the line `topic-catalog-source.ts` used to hold.
  assert.equal(epochZeroLiterals('  const knowledge = await read<KnowledgeArtifact>("knowledge.json");\n'), 1);
  assert.equal(epochZeroLiterals('const p = join(runDir, "knowledge.json");\nconst q = join(dir, "knowledge.json");\n'), 2);

  // And not on the two shapes that are about the name rather than built from it.
  assert.equal(epochZeroLiterals("// the stable archive location of epoch 0 is knowledge.json\n"), 0);
  assert.equal(epochZeroLiterals('throw new Error("knowledge.json is missing from the run");\n'), 0);
});

test("the mapping the census protects is exported and is the only place the legacy default lives", async () => {
  const freeze = await readFile(join(SOURCE_ROOT, "freeze", "freeze.ts"), "utf8");
  assert.match(freeze, /export function knowledgeEpochRelativePath\(epoch: number\): string/);
  assert.match(freeze, /export function currentKnowledgeRelativePath\(manifest: RunManifest\): string/);

  // `manifest.knowledgeEpoch ?? 0` is the legacy reading of a manifest recorded before the field existed. Two
  // copies of it drift the moment one is updated, so the whole tree may hold exactly one — and it must be inside
  // the function whose job is to answer "which epoch is current".
  const sites: string[] = [];
  for (const path of await sourceFiles(SOURCE_ROOT)) {
    const count = (await readFile(path, "utf8")).split("knowledgeEpoch ?? 0").length - 1;
    if (count > 0) sites.push(`${relative(SOURCE_ROOT, path).split("\\").join("/")}:${count}`);
  }
  assert.deepEqual(sites, ["freeze/freeze.ts:1"],
    "the epoch-absent default belongs to currentKnowledgeRelativePath alone; a second copy is the next drift");
});
