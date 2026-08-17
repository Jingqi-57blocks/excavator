import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { SCANNER_VERSION, createSnapshot } from "../src/snapshot/snapshot.ts";
import { serializeLedgerArtifact, type FileLedger } from "../src/snapshot/file-ledger.ts";
import { built } from "../src/base/artifact-result.ts";
import { codegraphIdentity } from "../src/codegraph/codegraph-identity.ts";
import { tempDir } from "./helpers.ts";

const execFileAsync = promisify(execFile);

/**
 * The snapshot identity's two learned lessons, as executable assertions.
 *
 * P10: the identity was a (path, size, mtime) shape, so a same-size rewrite reproduced the same id and every
 * content-addressed cache downstream served the old bytes. It now anchors on the tier2 content digest.
 *
 * The second is the CodeGraph mixing: an OPTIONAL navigation index sat inside the SOURCE snapshot's identity,
 * so building or rebuilding `.codegraph` moved the source snapshot's id — invalidating context caches, search
 * receipts and source windows that had nothing to do with the index. The index identity is now its own
 * function, recorded and compared on its own.
 */

/** A whole-second timestamp, so restoring it is exact: sub-millisecond stat precision makes any derived
 *  round-trip (`utimes(path, stat.mtime)`) land one millisecond off, which would fake the rewrite test. */
const FIXED_MTIME_SECONDS = 1_600_000_000;

async function initGit(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
}

/** A git target whose `.codegraph` directory is ignored, exactly as a real indexed target has it. */
async function indexedTarget(): Promise<string> {
  const target = await tempDir();
  await initGit(target);
  await writeFile(join(target, ".gitignore"), ".codegraph/\n");
  await mkdir(join(target, "src"), { recursive: true });
  await writeFile(join(target, "src", "main.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["-C", target, "add", "-A"]);
  await execFileAsync("git", ["-C", target, "commit", "-q", "-m", "init"]);
  return target;
}

async function writeDatabase(path: string, bytes: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
}

test("a same-size, same-mtime content rewrite changes the snapshot identity", async () => {
  // Deliberately NOT a git target: rewriting a committed file would also flip the root's `dirty` flag, and
  // that alone would move the identity — the test would then pass without the content digest existing.
  const target = await tempDir();
  await mkdir(join(target, "src"), { recursive: true });
  const file = join(target, "src", "main.ts");
  await writeFile(file, "export const value = 1;\n");
  await utimes(file, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
  const before = await stat(file);
  const first = await createSnapshot(target);

  await writeFile(file, "export const value = 2;\n");
  await utimes(file, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
  const after = await stat(file);
  assert.equal(after.size, before.size, "the fixture rewrite must keep the size identical");
  assert.equal(Math.trunc(after.mtimeMs), Math.trunc(before.mtimeMs), "the fixture rewrite must keep the mtime identical");

  const second = await createSnapshot(target);
  assert.equal(first.snapshot.sourceManifestDigest, second.snapshot.sourceManifestDigest,
    "the tier1 (path, size, mtime) digest is blind to this rewrite — which is exactly why it cannot be the identity");
  assert.notEqual(first.snapshot.contentManifestDigest, second.snapshot.contentManifestDigest, "the tier2 content digest sees the rewrite");
  assert.notEqual(first.snapshot.id, second.snapshot.id, "the snapshot identity anchors on content, not on mtime");
});

test("building, rebuilding and removing a CodeGraph database leaves the source snapshot identity and ledger untouched", async () => {
  const target = await indexedTarget();
  const dbPath = join(target, ".codegraph", "codegraph.db");
  const bytes = (ledger: FileLedger): Buffer => Buffer.from(serializeLedgerArtifact(built(ledger)), "utf8");

  const withoutIndex = await createSnapshot(target);
  assert.equal(await codegraphIdentity(dbPath), null, "an absent database has no identity");

  await writeDatabase(dbPath, "sqlite-bytes-v1");
  const withIndex = await createSnapshot(target);
  const firstIdentity = await codegraphIdentity(dbPath);
  assert.ok(firstIdentity, "a present database has an identity");
  assert.equal(withIndex.snapshot.id, withoutIndex.snapshot.id, "the source snapshot identity does not move when the index appears");
  assert.equal(Buffer.compare(bytes(withIndex.ledger), bytes(withoutIndex.ledger)), 0, "not one ledger byte moves either");

  await writeDatabase(dbPath, "sqlite-bytes-v2-longer");
  const rebuilt = await createSnapshot(target);
  const secondIdentity = await codegraphIdentity(dbPath);
  assert.notEqual(secondIdentity, firstIdentity, "rebuilding the database changes the index identity");
  assert.equal(rebuilt.snapshot.id, withoutIndex.snapshot.id, "the source snapshot identity does not move when the index is rebuilt");
  assert.equal(Buffer.compare(bytes(rebuilt.ledger), bytes(withoutIndex.ledger)), 0);
  assert.equal((rebuilt.snapshot as unknown as Record<string, unknown>).codegraphDigest, undefined,
    "the snapshot record no longer carries the index identity at all — its home is the CodeGraph producer envelope");
  assert.equal(rebuilt.ledger.counted.some((row) => row.relativePath.startsWith(".codegraph/")), false,
    "the index is pruned before candidacy, so it is not a row either");
  assert.equal(rebuilt.ledger.excluded.some((row) => row.relativePath.startsWith(".codegraph/")), false);
});

test("an unignored CodeGraph database is pruned by the directory rule, not merely by gitignore", async () => {
  // No git at all: `.codegraph` is a real, visible, untracked directory here, so only the directory-level
  // exclusion can keep it out of the candidate set.
  const target = await tempDir();
  await mkdir(join(target, "src"), { recursive: true });
  await writeFile(join(target, "src", "main.ts"), "export const value = 1;\n");
  const before = await createSnapshot(target);
  await writeDatabase(join(target, ".codegraph", "codegraph.db"), "sqlite-bytes");
  const after = await createSnapshot(target);
  assert.equal(after.snapshot.id, before.snapshot.id);
  assert.equal(after.ledger.summary.total, before.ledger.summary.total, "the index adds no candidate at all");
});

test("per-module CodeGraph databases are outside the source snapshot identity too", async () => {
  const target = await tempDir();
  for (const module of ["api", "web"]) {
    const root = join(target, module);
    await initGit(root);
    await writeFile(join(root, ".gitignore"), ".codegraph/\n");
    await writeFile(join(root, "main.ts"), `export const ${module} = 1;\n`);
    await execFileAsync("git", ["-C", root, "add", "-A"]);
    await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "init"]);
  }
  const paths = ["api", "web"].map((module) => join(target, module, ".codegraph", "codegraph.db"));

  const withoutIndexes = await createSnapshot(target);
  assert.equal(await codegraphIdentity(paths), null, "no module database means no multi-module index identity");
  for (const path of paths) await writeDatabase(path, `bytes-for-${path}`);
  const withIndexes = await createSnapshot(target);
  const multi = await codegraphIdentity(paths);
  assert.ok(multi, "the multi-module identity is derived from every present database");
  assert.notEqual(multi, await codegraphIdentity(paths[0]), "the multi-database branch is not the single-database formula");
  assert.equal(withIndexes.snapshot.id, withoutIndexes.snapshot.id, "the source snapshot identity is independent of the module databases");
  assert.equal(await codegraphIdentity([]), null, "an empty database list is not an identity");
  assert.equal(await codegraphIdentity(undefined), null);
});

test("the scanner version names the identity generation, so a run records how its id was derived", async () => {
  const target = await indexedTarget();
  const { snapshot } = await createSnapshot(target);
  assert.equal(SCANNER_VERSION, "git-aware-source-boundary-v2", "anchoring the identity on content is a declared generation change");
  assert.equal(snapshot.scannerVersion, SCANNER_VERSION);
});
