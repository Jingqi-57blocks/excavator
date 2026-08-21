import test from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentPlan, EvidenceItem } from "../src/base/types.ts";
import { canonicalJson, sha256, stableJson } from "../src/base/util.ts";
import {
  EVIDENCE_MODEL_VIEW_MAX_BYTES, EVIDENCE_RECORD_MAX_BYTES, EVIDENCE_SCALAR_MAX_BYTES,
  EVIDENCE_SHARD_MAX_BYTES, appendEvidence, auditEvidenceStorage, boundEvidenceItem,
  boundEvidenceModelView, canonicalEvidenceDigest, readContentRef, readEvidenceCatalog, writeEvidenceCatalog
} from "../src/investigation/evidence-store.ts";
import { tempDir } from "./helpers.ts";

function item(id: string, kind: EvidenceItem["kind"], data: unknown): EvidenceItem {
  return { id, snapshotId: "snapshot", kind, title: id, data, reason: "fixture", digest: sha256(stableJson(data)) };
}

test("a compressed single-line source is clipped, content-addressed and stored only after run redaction", async () => {
  const runDir = await tempDir();
  const secret = "abcd1234efgh";
  const content = `const bundled = \"${"x".repeat(400_000)}\";\nAPI_KEY=${secret}`;
  const evidence: EvidenceItem = {
    id: "S-minified",
    snapshotId: "snapshot",
    kind: "source",
    title: "minified fixture",
    path: "dist/app.min.js",
    startLine: 1,
    endLine: 2,
    content,
    reason: "compressed-line fixture",
    digest: sha256(content)
  };

  const bounded = await boundEvidenceItem(runDir, evidence, true);
  assert.ok(bounded.contentRef);
  assert.equal(typeof bounded.contentDigest, "string");
  assert.ok((bounded.originalBytes ?? 0) > EVIDENCE_RECORD_MAX_BYTES);
  assert.ok(Buffer.byteLength(bounded.content ?? "") <= EVIDENCE_SCALAR_MAX_BYTES);
  assert.ok(Buffer.byteLength(canonicalJson(bounded)) <= EVIDENCE_RECORD_MAX_BYTES);
  assert.match(bounded.truncatedReason ?? "", /scalar-field-byte-limit/);

  const full = (await readContentRef(runDir, bounded.contentRef!)).toString("utf8");
  assert.doesNotMatch(full, new RegExp(secret));
  assert.match(full, /<redacted>/);
  assert.equal(sha256(full), bounded.contentDigest);

  const structured = await boundEvidenceItem(runDir, item("E-secret-object", "ledger", { API_KEY: secret, rows: Array.from({ length: 1_000 }, () => "x".repeat(500)) }), true);
  const structuredFull = (await readContentRef(runDir, structured.contentRef!)).toString("utf8");
  assert.doesNotMatch(structuredFull, new RegExp(secret), "structured secrets use their key as redaction context");
  assert.match(structuredFull, /<redacted>/);
});

test("giant graph, fact and ledger records share the same record contract", async () => {
  const runDir = await tempDir();
  for (const kind of ["graph", "fact", "ledger"] as const) {
    const rows = Array.from({ length: 2_000 }, (_, index) => ({ index, label: `${kind}-${index}-${"z".repeat(300)}` }));
    const bounded = await boundEvidenceItem(runDir, item(`E-${kind}`, kind, { rows, completeness: { total: rows.length } }), false);
    assert.equal(bounded.kind, kind);
    assert.ok(bounded.contentRef, `${kind} must retain the pre-truncation record`);
    assert.match(bounded.truncatedReason ?? "", /record-byte-limit/);
    assert.ok(Buffer.byteLength(canonicalJson(bounded)) <= EVIDENCE_RECORD_MAX_BYTES);
    const retainedRows = ((bounded.data as { rows?: unknown[] }).rows ?? []).length;
    assert.ok(retainedRows < rows.length, `${kind} retained array is bounded`);
  }
});

test("many medium records remain sharded and the catalog reproduces every record", async () => {
  const runDir = await tempDir();
  const records = Array.from({ length: 80 }, (_, index) => item(`E-${String(index).padStart(3, "0")}`, "derived", { excerpt: "m".repeat(6_000), index }));
  const written = await writeEvidenceCatalog(runDir, records, false);
  assert.equal(written.evidence.length, records.length);
  assert.deepEqual(await auditEvidenceStorage(runDir, written.evidence), []);

  for (let shard = 1; ; shard += 1) {
    const path = join(runDir, "evidence", "shards", `${String(shard).padStart(6, "0")}.jsonl`);
    const size = await stat(path).then((value) => value.size).catch(() => -1);
    if (size < 0) break;
    assert.ok(size <= EVIDENCE_SHARD_MAX_BYTES, `shard ${shard} is ${size} bytes`);
  }
});

test("concurrent appenders pass through one writer and allocate a continuous evidence sequence", async () => {
  const runDir = await tempDir();
  await writeEvidenceCatalog(runDir, [], false);
  const records = Array.from({ length: 100 }, (_, index) => item(`E-${String(index).padStart(3, "0")}`, "search", { index, excerpt: "x".repeat(500) }));
  const results = await Promise.all(records.map((record) => appendEvidence(runDir, record, false)));
  assert.ok(results.every((result) => result.appended));
  const catalog = await readEvidenceCatalog(runDir);
  assert.equal(catalog.evidence.length, records.length);
  assert.equal(new Set(catalog.evidence.map((entry) => entry.id)).size, records.length);
  assert.deepEqual(await auditEvidenceStorage(runDir, catalog.evidence), []);
  assert.equal(results.map((result) => result.checkpoint.sequence).sort((a, b) => a - b).at(-1), records.length);

  const duplicate = await appendEvidence(runDir, records[0], false);
  assert.equal(duplicate.appended, false);
  assert.equal((await readEvidenceCatalog(runDir)).evidence.length, records.length);
  await assert.rejects(() => appendEvidence(runDir, item(records[0].id, "search", { different: true }), false), /already committed with different content/);
});

test("a direct writer bypass is detected while normal append bytes stay proportional to the new record", async () => {
  const runDir = await tempDir();
  await writeEvidenceCatalog(runDir, [item("E-0", "derived", { value: 0 })], false);
  const beforeCheckpoint = await stat(join(runDir, ".writer", "evidence.checkpoint.json")).then((value) => value.size);
  for (let index = 1; index <= 50; index += 1) await appendEvidence(runDir, item(`E-${index}`, "derived", { value: index }), false);
  const afterCheckpoint = await stat(join(runDir, ".writer", "evidence.checkpoint.json")).then((value) => value.size);
  assert.ok(afterCheckpoint < beforeCheckpoint + 64, "the tail checkpoint stays constant-sized as N grows");

  const path = join(runDir, "evidence.json");
  const catalog = JSON.parse(await readFile(path, "utf8")) as { evidence: EvidenceItem[] };
  catalog.evidence.push(item("BYPASS", "derived", { value: "outside the writer" }));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify(catalog)));
  assert.ok((await auditEvidenceStorage(runDir, catalog.evidence)).some((message) => /checkpoint|shards/.test(message)));
});

test("content refs survive a run-directory archive copy and the model view has its own byte bound", async () => {
  const runDir = await tempDir();
  const bounded = await boundEvidenceItem(runDir, item("E-offline", "fact", { rows: Array.from({ length: 1_000 }, () => "v".repeat(1_000)) }), false);
  assert.ok(bounded.contentRef);
  const archived = await tempDir();
  await cp(runDir, archived, { recursive: true });
  const offline = await readContentRef(archived, bounded.contentRef!);
  assert.equal(sha256(offline), bounded.contentDigest);

  const view = boundEvidenceModelView("row\n".repeat(EVIDENCE_MODEL_VIEW_MAX_BYTES));
  assert.ok(Buffer.byteLength(view) <= EVIDENCE_MODEL_VIEW_MAX_BYTES);
  assert.match(view, /model-view byte bound reached/);
  assert.equal(canonicalEvidenceDigest([item("b", "fact", {}), item("a", "ledger", {})]), canonicalEvidenceDigest([item("a", "ledger", {}), item("b", "fact", {})]));
});

test("an offline archive audit fails when a content-addressed evidence blob is tampered with or deleted", async () => {
  const runDir = await tempDir();
  const written = await writeEvidenceCatalog(runDir, [item("E-archive", "fact", { rows: Array.from({ length: 1_000 }, () => "v".repeat(1_000)) })], false);
  const contentRef = written.evidence[0].contentRef;
  assert.ok(contentRef);
  const archived = await tempDir();
  await cp(runDir, archived, { recursive: true });
  assert.deepEqual(await auditEvidenceStorage(archived, (await readEvidenceCatalog(archived)).evidence, false), []);

  const blob = join(archived, contentRef);
  const original = await readFile(blob);
  await writeFile(blob, Buffer.from("tampered"));
  assert.ok((await auditEvidenceStorage(archived, (await readEvidenceCatalog(archived)).evidence, false)).some((message) => /contentRef has the wrong/.test(message)));
  await writeFile(blob, original);
  await rm(blob);
  assert.ok((await auditEvidenceStorage(archived, (await readEvidenceCatalog(archived)).evidence, false)).some((message) => /contentRef cannot be resolved/.test(message)));
});

