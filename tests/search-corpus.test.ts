import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SOURCE_EXTENSIONS } from "../src/snapshot.ts";
import type { ScannedFile } from "../src/snapshot.ts";
import { TEXTUAL_EXTENSIONS, sourceSearch } from "../src/source.ts";
import { tempDir } from "./helpers.ts";

// Extensions the snapshot scans that are genuinely NOT UTF-8 text and therefore legitimately fall
// outside the content-search corpus. Empty today — every scanned source extension is text — but
// declared explicitly so that a future binary extension added to the scanner is a reviewed exception
// here (with justification), not a silent "scanned but unsearchable" divergence. If the new extension
// is text, add it to TEXTUAL_EXTENSIONS instead. See 57B-347.
const NON_TEXT_SOURCE_EXTENSIONS = new Set<string>([]);

test("every scanned text extension is a member of the content-search corpus", () => {
  const missing = [...SOURCE_EXTENSIONS]
    .filter((extension) => !NON_TEXT_SOURCE_EXTENSIONS.has(extension) && !TEXTUAL_EXTENSIONS.has(extension))
    .sort();
  assert.deepEqual(missing, [], `snapshot scans these text extensions that source search cannot reach: ${missing.join(", ")}`);
});

test("declared non-text exceptions are real scanned extensions kept out of the search corpus", () => {
  for (const extension of NON_TEXT_SOURCE_EXTENSIONS) {
    assert.ok(SOURCE_EXTENSIONS.has(extension), `non-text exception ${extension} is not a scanned extension`);
    assert.ok(!TEXTUAL_EXTENSIONS.has(extension), `non-text exception ${extension} must not be in the search corpus`);
  }
});

test("source search reaches proto, graphql and terraform bodies that the snapshot scans", async () => {
  const root = await tempDir();
  const cases = [
    ["api/user.proto", "message User {\n  string leave_balance = 1;\n}\n", ".proto"],
    ["api/schema.graphql", "type Query {\n  leaveBalance: Int\n}\n", ".graphql"],
    ["infra/main.tf", "resource \"aws_s3_bucket\" \"leave_balance\" {}\n", ".tf"]
  ] as const;
  const files: ScannedFile[] = [];
  for (const [relativePath, content, extension] of cases) {
    const absolutePath = join(root, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, content);
    const info = await stat(absolutePath);
    files.push({ absolutePath, relativePath, size: info.size, extension, rootName: "root" });
  }
  const matches = await sourceSearch(files, ["leave_balance", "leaveBalance"], { maxResults: 10 });
  const hitPaths = new Set(matches.map((match) => match.file.relativePath));
  assert.ok(hitPaths.has("api/user.proto"), "a .proto body must be searchable");
  assert.ok(hitPaths.has("api/schema.graphql"), "a .graphql body must be searchable");
  assert.ok(hitPaths.has("infra/main.tf"), "a .tf body must be searchable");
});
