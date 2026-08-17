import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createSnapshot, scanFiles } from "../src/snapshot/snapshot.ts";
import { FileLedgerDraft, buildFileLedger, ledgerContentIdentity, serializeLedgerArtifact, type FileLedger } from "../src/snapshot/file-ledger.ts";
import { built } from "../src/base/artifact-result.ts";
import { tempDir } from "./helpers.ts";

const execFileAsync = promisify(execFile);

/**
 * Layer 1's ledger: every candidate the root discovery produced lands in exactly one bucket, and the
 * completeness block states what the scan could not see. Before this, five `continue`s and one `break` in
 * `scanRoot`/`scanWorkspace` dropped candidates with no record at all — the file cap, the fixed exclusions,
 * unregistered extensions, path escapes, irregular/oversized files, a failed `lstat`, and a whole root.
 */

async function initGit(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
}

function excludedFor(ledger: FileLedger, relativePath: string) {
  return ledger.excluded.find((row) => row.relativePath === relativePath);
}

function groupFor(ledger: FileLedger, rule: string, extension: string) {
  return ledger.excludedGroups.find((group) => group.rule === rule && group.extension === extension);
}

/** total = counted + Σexcluded + unexplained, with no unexplained residual. */
function assertBalanced(ledger: FileLedger): void {
  assert.equal(ledger.summary.counted, ledger.counted.length);
  assert.equal(ledger.summary.excluded, ledger.excluded.length);
  assert.equal(
    ledger.summary.total,
    ledger.summary.counted + ledger.summary.excluded + ledger.summary.unexplained,
    "the coverage axis must be a complete partition of the candidate set"
  );
  assert.equal(ledger.summary.unexplained, 0, "no candidate may fall outside every bucket");
  assert.deepEqual(ledger.unexplained, []);
}

test("the file cap, the fixed exclusions and the unregistered extensions all land in named buckets", async () => {
  const target = await tempDir();
  for (const name of ["a1.ts", "a2.ts", "a3.ts"]) await writeFile(join(target, name), `export const x = "${name}";\n`);
  await writeFile(join(target, "b.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
  await writeFile(join(target, "c.ejs"), "<%= leaveBalance %>\n");
  await writeFile(join(target, "notes.pem"), "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n");

  const { ledger, files } = await createSnapshot(target, 2);
  assertBalanced(ledger);
  assert.equal(ledger.summary.total, 6, "every discovered candidate is a row");
  assert.deepEqual(files.map((file) => file.relativePath), ["a1.ts", "a2.ts"], "the cap still selects exactly what it selected before");
  assert.deepEqual(ledger.counted.map((row) => row.relativePath), ["a1.ts", "a2.ts"], "the counted rows are the selected files");

  assert.equal(ledger.completeness.capReached, true, "the cap changed the outcome and says so");
  assert.equal(ledger.completeness.skippedByCap, 1, "a3.ts passed every filter and was refused only for lack of room");
  assert.deepEqual(ledger.completeness.droppedRoots, [], "no root was dropped in a single-root scan");
  assert.equal(ledger.completeness.maxFiles, 2);

  assert.equal(excludedFor(ledger, "a3.ts")?.rule, "cap-reached");
  assert.equal(excludedFor(ledger, "b.png")?.rule, "unsupported-extension");
  assert.equal(excludedFor(ledger, "c.ejs")?.rule, "unsupported-extension");
  assert.equal(excludedFor(ledger, "notes.pem")?.rule, "sensitive-file", "a tracked private key is visible as an excluded row, not absent");
});

test("an unregistered extension is grouped by extension and carries its own shape, so text is not buried under assets", async () => {
  const target = await tempDir();
  await mkdir(join(target, "views"), { recursive: true });
  await writeFile(join(target, "views", "mail_leave_approval.ejs"), "<h1><%= employee.name %> 的请假申请</h1>\n");
  await writeFile(join(target, "main.ts"), "export const value = 1;\n");
  for (const name of ["logo.png", "hero.png"]) {
    await writeFile(join(target, name), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x00, 0x1a, 0x0a, 0x00, 0x00]));
  }

  const { ledger } = await createSnapshot(target);
  assertBalanced(ledger);
  const ejs = excludedFor(ledger, "views/mail_leave_approval.ejs");
  assert.equal(ejs?.rule, "unsupported-extension", "a template the engine cannot read is a recorded gap, not an absence");
  assert.deepEqual(groupFor(ledger, "unsupported-extension", ".ejs"), { rule: "unsupported-extension", extension: ".ejs", count: 1, shape: "textual" });
  assert.deepEqual(groupFor(ledger, "unsupported-extension", ".png"), { rule: "unsupported-extension", extension: ".png", count: 2, shape: "binary" });
  assert.deepEqual(ledger.counted.map((row) => row.relativePath), ["main.ts"]);
});

test("two paths holding identical bytes are two distinguishable rows", async () => {
  const target = await tempDir();
  for (const dir of ["a", "b"]) {
    await mkdir(join(target, dir), { recursive: true });
    await writeFile(join(target, dir, "__init__.py"), "");
    await writeFile(join(target, dir, "newline.py"), "\n");
  }

  const { ledger } = await createSnapshot(target);
  assertBalanced(ledger);
  assert.deepEqual(ledger.counted.map((row) => row.relativePath), ["a/__init__.py", "a/newline.py", "b/__init__.py", "b/newline.py"],
    "four files with two distinct contents are four rows — content-hash identity would collapse them to two");
  assert.deepEqual(ledger.rowIdentity.components, ["snapshot-identity", "target-relative-path"],
    "the row identity is declared in the artifact, so no consumer re-assembles the tuple");
  assert.equal(ledger.rowIdentity.contentDigestIsAttribute, true, "the tier2 digest is a mandatory attribute of a row, never its identity");

  const digest = (path: string): string => {
    const row = ledger.counted.find((candidate) => candidate.relativePath === path);
    assert.ok(row, `${path} is counted`);
    assert.equal(row.content.status, "present");
    return row.content.status === "present" ? row.content.digest : "";
  };
  assert.equal(digest("a/__init__.py"), digest("b/__init__.py"), "identical bytes share a tier2 digest");
  assert.equal(digest("a/newline.py"), digest("b/newline.py"), "identical bytes share a tier2 digest");
  assert.notEqual(digest("a/__init__.py"), digest("a/newline.py"), "an empty file and a newline are different bytes");
  assert.equal(ledger.contentManifestDigest, ledgerContentIdentity(ledger), "the whole-table content digest is re-derivable from the rows");
});

test("the ledger is byte-identical across reruns and across a cold and warm content cache", async () => {
  const target = await tempDir();
  await mkdir(join(target, "src"), { recursive: true });
  for (const name of ["one.ts", "two.ts", "three.md"]) await writeFile(join(target, "src", name), `# ${name}\nvalue\n`);
  await writeFile(join(target, "skip.ejs"), "<%= x %>\n");
  const coldCache = await tempDir();
  const warmCache = await tempDir();

  const first = await createSnapshot(target, 100, { cacheDir: warmCache });
  const second = await createSnapshot(target, 100, { cacheDir: warmCache });
  const cold = await createSnapshot(target, 100, { cacheDir: coldCache });
  const uncached = await createSnapshot(target, 100);

  const bytes = (ledger: FileLedger): Buffer => Buffer.from(serializeLedgerArtifact(built(ledger)), "utf8");
  assert.equal(Buffer.compare(bytes(first.ledger), bytes(second.ledger)), 0, "a warm content cache produces the same ledger bytes");
  assert.equal(Buffer.compare(bytes(first.ledger), bytes(cold.ledger)), 0, "a cold cache in a different directory produces the same ledger bytes");
  assert.equal(Buffer.compare(bytes(first.ledger), bytes(uncached.ledger)), 0, "no cache at all produces the same ledger bytes");
  assert.equal(first.snapshot.id, second.snapshot.id);
  assert.equal(first.snapshot.id, cold.snapshot.id);
  assert.equal(first.snapshot.id, uncached.snapshot.id);
  assert.ok(!serializeLedgerArtifact(built(first.ledger)).includes("createdAt"), "the canonical ledger carries no wall-clock field");
});

test("a sensitive file is a stat-only row: nothing about it is read, and no byte of it reaches the artifact", async () => {
  const target = await tempDir();
  const marker = "MARKER-b7f2-PRIVATE-KEY-MATERIAL-b7f2";
  const secret = `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----\n`;
  await writeFile(join(target, "server.pem"), secret);
  await writeFile(join(target, ".env"), `DATABASE_URL=postgres://user:${marker}@db/app\n`);
  await writeFile(join(target, ".env.example"), "DATABASE_URL=\n");
  await writeFile(join(target, "main.ts"), "export const value = 1;\n");

  const { ledger } = await createSnapshot(target);
  assertBalanced(ledger);
  for (const path of ["server.pem", ".env"]) {
    const row = excludedFor(ledger, path);
    assert.equal(row?.rule, "sensitive-file", `${path} is still a visible row`);
    // The whole point of the rule is not doing work on these bytes, and an 8 KiB shape sample read exactly the
    // leading bytes of the private key. `stat-only` is what "we looked at the inode and stopped" looks like.
    assert.equal(row?.tier1.status, "stat-only", `${path} must not report a sampled shape`);
    assert.equal(row?.tier1.status === "stat-only" ? row.tier1.reason : null, "sensitive");
    assert.deepEqual(Object.keys(row!.tier1).sort(), ["mtimeMs", "reason", "size", "status"],
      "the row carries the inode facts and nothing derived from the bytes — no shape, and no maxLineLength metadata leak");
    assert.deepEqual(row?.content, { status: "absent", reason: "excluded" }, "not reading it is policy, not a failure");
  }
  assert.equal(excludedFor(ledger, ".env.example")?.rule, undefined, "a checked-in sample env file is counted, not sensitive");

  const artifact = serializeLedgerArtifact(built(ledger));
  assert.equal(artifact.includes(marker), false, "no content of a sensitive file appears in the artifact");
  assert.equal(artifact.includes(createHash("sha256").update(secret).digest("hex")), false, "and neither does a digest of it");
  assert.equal(groupFor(ledger, "sensitive-file", ".pem")?.shape, "unsampled", "the group reports the row as unsampled rather than inventing a shape");
});

test("a counted row whose bytes vanish between the stat and the read says read-failed, not excluded", async () => {
  // The real race — a file present at `lstat` and gone at `readFile` — reproduced by handing the ledger a
  // counted draft row whose stat is plausible and whose path does not exist. `excluded` is the bucket this used
  // to borrow, which read as "we chose not to hash it" for a row the contract requires a digest on.
  const target = await tempDir();
  await writeFile(join(target, "present.ts"), "export const value = 1;\n");
  const draft = new FileLedgerDraft();
  draft.candidate({ relativePath: "present.ts", absolutePath: join(target, "present.ts"), rootName: ".", extension: ".ts", rule: null, stat: { size: 24, mtimeMs: 1_600_000_000_000, ctimeMs: 1_600_000_000_000 }, unsampled: null });
  draft.candidate({ relativePath: "vanished.ts", absolutePath: join(target, "vanished.ts"), rootName: ".", extension: ".ts", rule: null, stat: { size: 24, mtimeMs: 1_600_000_000_000, ctimeMs: 1_600_000_000_000 }, unsampled: null });
  draft.root({ name: ".", candidateSource: "filesystem-walk", candidates: 2, counted: 2, dropped: false });

  const ledger = await buildFileLedger({ draft, target, scannerVersion: "test", maxFiles: 100 });
  assertBalanced(ledger);
  const vanished = ledger.counted.find((row) => row.relativePath === "vanished.ts");
  assert.ok(vanished, "the row is still counted: the scan selected it, and pretending otherwise moves a denominator");
  assert.deepEqual(vanished.content, { status: "absent", reason: "read-failed" }, "a counted row must not borrow the excluded row's reason");
  assert.equal(vanished.tier1.status, "stat-only", "stat succeeded, so this is stat-only rather than unsampled");
  assert.equal(vanished.tier1.status === "stat-only" ? vanished.tier1.reason : null, "read-failed");
  const present = ledger.counted.find((row) => row.relativePath === "present.ts");
  assert.equal(present?.content.status, "present", "the readable row in the same scan is unaffected");
  assert.equal(ledger.contentManifestDigest, ledgerContentIdentity(ledger), "the whole-table digest stays re-derivable across a failed read");
});

test("a root the cap never reached is recorded as dropped rather than silently missing", async () => {
  const target = await tempDir();
  for (const module of ["api", "web"]) {
    const root = join(target, module);
    await initGit(root);
    for (const name of ["one.ts", "two.ts", "three.ts"]) await writeFile(join(root, name), `export const ${name.replace(".ts", "")} = 1;\n`);
    await execFileAsync("git", ["-C", root, "add", "-A"]);
    await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "init"]);
  }

  const { ledger, files } = await createSnapshot(target, 3);
  assert.deepEqual(files.map((file) => file.relativePath).sort(), ["api/one.ts", "api/three.ts", "api/two.ts"]);
  assert.deepEqual(ledger.completeness.droppedRoots, ["web"], "the second root was never examined and the ledger says which one");
  assert.equal(ledger.completeness.capReached, true, "a dropped root means the cap changed the outcome");
  assertBalanced(ledger);
});

test("the counted row set is exactly what the scanner selects today", async () => {
  const target = await tempDir();
  await mkdir(join(target, "nested", "deep"), { recursive: true });
  await writeFile(join(target, "nested", "deep", "handler.go"), "package deep\n");
  await writeFile(join(target, "nested", "notes.md"), "# notes\n");
  await writeFile(join(target, "package.json"), "{}\n");
  await writeFile(join(target, ".DS_Store"), "junk");
  await writeFile(join(target, "style.less"), ".a { color: red }\n");
  await mkdir(join(target, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(target, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

  const scanned = (await scanFiles(target)).map((file) => file.relativePath);
  const { ledger } = await createSnapshot(target);
  assert.deepEqual(ledger.counted.map((row) => row.relativePath), scanned, "the ledger adds accounting, never a different selection");
  assertBalanced(ledger);
  assert.equal(excludedFor(ledger, ".DS_Store")?.rule, "os-artifact");
  assert.equal(excludedFor(ledger, "style.less")?.rule, "unsupported-extension");
  assert.equal(excludedFor(ledger, "node_modules/pkg/index.js"), undefined,
    "workspace machinery is pruned before candidacy by a directory rule already covered by ignoreRulesDigest");
});
