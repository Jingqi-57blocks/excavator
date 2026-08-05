import test from "node:test";
import assert from "node:assert/strict";
import { basename, join, resolve } from "node:path";
import { redactSecrets } from "../src/util.ts";

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

test("source window cache ignores legacy unversioned excerpts", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SourceReader } = await import("../src/source.ts");
  const { sha256 } = await import("../src/util.ts");
  const root = await mkdtemp(join(tmpdir(), "excavator-cache-version-"));
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
  const reader = new SourceReader({ target: root, snapshotId: "snapshot", cacheDir, maxWindows: 2, maxCharacters: 1000 });
  const window = await reader.window("src/config.go", 1, 1, "fresh read");
  assert.equal(reader.stats.hits, 0);
  assert.match(window.content, /<redacted>/);
  assert.doesNotMatch(window.content, /real-value/);
});


test("redaction preserves parseable package manifests with token-related package names", () => {
  const manifest = JSON.stringify({ dependencies: { jsonwebtoken: "^9.0.0", "gpt3-tokenizer": "^1.1.5" } }, null, 2);
  const redacted = redactSecrets(manifest);
  assert.deepEqual(JSON.parse(redacted), JSON.parse(manifest));
});

test("project workspace isolates targets by name and resolves basename collisions", async () => {
  const { readFile } = await import("node:fs/promises");
  const { projectWorkspace } = await import("../src/util.ts");
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
