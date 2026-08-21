import test from "node:test";
import assert from "node:assert/strict";
import { basename, join, resolve } from "node:path";
import { redactSecrets, runIdTimestamp } from "../src/base/util.ts";
import { tempDir } from "./temp-dir.ts";

test("secret redaction covers typed declarations, JSON, YAML and environment assignments", () => {
  const input = [
    'AESKey string = "real-value"',
    'const API_KEY: string = "real-value";',
    '"clientSecret": "real-value",',
    'password: real-value',
    'PORT=8080',
    'ENABLED=true',
    'TOKEN=${TOKEN}',
    '"access_token": "real-value",',
    '"jsonwebtoken": "^9.0.0",',
    '"gpt3-tokenizer": "^1.1.5"'
  ].join("\n");
  const redacted = redactSecrets(input);
  assert.doesNotMatch(redacted, /real-value/);
  assert.match(redacted, /AESKey string = <redacted>/);
  assert.match(redacted, /const API_KEY: string = <redacted>;/);
  assert.match(redacted, /"clientSecret": <redacted>,/);
  assert.match(redacted, /password: <redacted>/);
  assert.match(redacted, /PORT=8080/);
  assert.match(redacted, /ENABLED=true/);
  assert.match(redacted, /TOKEN=\$\{TOKEN\}/);
  assert.match(redacted, /"access_token": <redacted>,/);
  assert.match(redacted, /"jsonwebtoken": "\^9\.0\.0",/);
  assert.match(redacted, /"gpt3-tokenizer": "\^1\.1\.5"/);
});

test("runIdTimestamp formats a run-id stamp in local time, zero-padded, YYYY_MM_DD_HH_MM", () => {
  // Dates are built from LOCAL components, so the getters return those same components in any
  // timezone and the assertion is timezone-stable. Month is 0-based: 7 => August, 0 => January.
  assert.equal(runIdTimestamp(new Date(2026, 7, 10, 9, 30)), "2026_08_10_09_30");
  assert.equal(runIdTimestamp(new Date(2026, 0, 5, 3, 7)), "2026_01_05_03_07", "single digits are padded to two");
  assert.match(runIdTimestamp(new Date(2026, 11, 31, 23, 59)), /^\d{4}_\d{2}_\d{2}_\d{2}_\d{2}$/);
});

test("source window cache ignores legacy unversioned excerpts", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { SourceReader } = await import("../src/snapshot/source.ts");
  const { sha256 } = await import("../src/base/util.ts");
  const root = await tempDir("excavator-cache-version-");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "config.go"), 'AESKey string = "real-value"\n');
  const cacheDir = join(root, "cache");
  const legacyKey = sha256("snapshot:src/config.go:1:1");
  await mkdir(join(cacheDir, "source-windows"), { recursive: true });
  await writeFile(join(cacheDir, "source-windows", `${legacyKey}.json`), JSON.stringify({
    id: "S-legacy",
    snapshotId: "snapshot",
    path: "src/config.go",
    startLine: 1,
    endLine: 1,
    content: 'AESKey string = "real-value"',
    digest: sha256('AESKey string = "real-value"'),
    reason: "legacy"
  }));
  const reader = new SourceReader({ target: root, snapshotId: "snapshot", cacheDir, maxWindows: 2, maxCharacters: 1000, redact: true });
  const window = await reader.window("src/config.go", 1, 1, "fresh read");
  assert.equal(reader.stats.hits, 0);
  assert.match(window.content, /<redacted>/);
  assert.doesNotMatch(window.content, /real-value/);
});

// The two modes must not share a cached window. A run that asked for redaction would otherwise be served an
// excerpt recorded without it, and audit — which re-derives from the run's own mode — would then report a
// stale digest on a window nobody touched.
test("a window cached in one redaction mode is not served to the other", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { SourceReader } = await import("../src/snapshot/source.ts");
  const root = await tempDir("excavator-cache-mode-");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "config.go"), 'AESKey string = "real-value"\n');
  const cacheDir = join(root, "cache");
  const options = { target: root, snapshotId: "snapshot", cacheDir, maxWindows: 4, maxCharacters: 4000, redact: false };

  const plain = await new SourceReader({ ...options }).window("src/config.go", 1, 1, "plain");
  assert.match(plain.content, /real-value/, "off by default: a local workspace is recorded as written");

  const redacted = await new SourceReader({ ...options, redact: true }).window("src/config.go", 1, 1, "redacted");
  assert.match(redacted.content, /<redacted>/, "and the redacted read is not served the plain cache entry");
  assert.notEqual(plain.id, redacted.id, "different modes are different windows, with different ids");
});


test("redaction preserves parseable package manifests with token-related package names", () => {
  const manifest = JSON.stringify({ dependencies: { jsonwebtoken: "^9.0.0", "gpt3-tokenizer": "^1.1.5" } }, null, 2);
  const redacted = redactSecrets(manifest);
  assert.deepEqual(JSON.parse(redacted), JSON.parse(manifest));
});

test("project workspace isolates targets by name and resolves basename collisions", async () => {
  const { readFile } = await import("node:fs/promises");
  const { projectWorkspace } = await import("../src/base/util.ts");
  const { tempDir } = await import("./helpers.ts");

  const workdir = await tempDir("excavator-workspace-");
  const alpha = await tempDir("excavator-alpha-");
  const beta = await tempDir("excavator-beta-");

  const first = await projectWorkspace(workdir, join(alpha, "api"));
  const second = await projectWorkspace(workdir, join(beta, "api"));
  const firstAgain = await projectWorkspace(workdir, join(alpha, "api"));

  assert.equal(basename(first), "api", "the first target keeps the plain basename");
  assert.notEqual(second, first, "a different target never shares a directory");
  assert.match(basename(second), /^api-[0-9a-f]{6}$/, "a colliding target is suffixed with a path digest");
  assert.equal(firstAgain, first, "resolving the same target twice is stable");

  assert.equal((await readFile(join(first, ".target"), "utf8")).trim(), resolve(alpha, "api"));
  assert.equal((await readFile(join(second, ".target"), "utf8")).trim(), resolve(beta, "api"));
});
