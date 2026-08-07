import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { ASSURANCE_VERSION, auditEvidenceCatalog } from "../src/assurance.ts";
import { sha256 } from "../src/util.ts";
import type { EvidenceItem, RunManifest } from "../src/types.ts";
import { tempDir } from "./helpers.ts";

const SNAPSHOT_ID = "snap-version-gate";
// A numeric declaration redaction never touches, so the re-derived window equals the raw line and
// any mismatch we assert comes from the stored excerpt alone, not from redaction rewriting the file.
const FILE_LINE = "export const answer = 42;";

async function targetWith(line: string): Promise<string> {
  const target = await tempDir();
  await mkdir(join(target, "src"), { recursive: true });
  await writeFile(join(target, "src", "config.ts"), `${line}\n`, "utf8");
  return target;
}

function manifest(target: string, assuranceVersion: string | undefined): RunManifest {
  return {
    version: 3,
    id: "run-version-gate",
    state: "audited",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    request: { target } as RunManifest["request"],
    snapshot: { id: SNAPSHOT_ID } as unknown as RunManifest["snapshot"],
    documents: [],
    evidenceDigest: "",
    assuranceVersion,
    metrics: {} as unknown as RunManifest["metrics"]
  };
}

function sourceEvidence(content: string, digest: string): EvidenceItem {
  return { id: "S-versiongate", snapshotId: SNAPSHOT_ID, kind: "source", title: "config window", path: "src/config.ts", startLine: 1, endLine: 1, content, reason: "test", digest };
}

test("current-version run keeps source re-derivation mismatch as hard errors", async () => {
  const target = await targetWith(FILE_LINE);
  const stored = "export const answer = 7;"; // internally consistent, but disagrees with the file
  const findings = await auditEvidenceCatalog(manifest(target, ASSURANCE_VERSION), [sourceEvidence(stored, sha256(stored))]);
  assert.ok(findings.some((f) => f.level === "error" && f.message.includes("source digest is stale")), "expected a stale source digest error");
  assert.ok(findings.some((f) => f.level === "error" && f.message.includes("stored excerpt does not match the current redacted source window")), "expected an excerpt mismatch error");
});

test("older-version run grandfathers the same source-side mismatch", async () => {
  const target = await targetWith(FILE_LINE);
  const stored = "export const answer = 7;";
  const findings = await auditEvidenceCatalog(manifest(target, "assurance-v0-redaction-v3"), [sourceEvidence(stored, sha256(stored))]);
  assert.deepEqual(findings, [], "a legacy run must not fail on a redaction/source re-derivation mismatch");
});

test("older-version run still catches a tampered archived excerpt", async () => {
  const target = await targetWith(FILE_LINE);
  const stored = "export const answer = 7;";
  // Digest recorded for a different string: the archived catalog was tampered after the run.
  const findings = await auditEvidenceCatalog(manifest(target, "assurance-v0-redaction-v3"), [sourceEvidence(stored, sha256("export const answer = 999;"))]);
  assert.ok(findings.some((f) => f.level === "error" && f.message.includes("does not match its own recorded digest")), "internal-consistency check must still catch tampering on a legacy run");
});

test("a run with no assuranceVersion field audits without crashing", async () => {
  const target = await targetWith(FILE_LINE);
  const stored = "export const answer = 7;"; // internally consistent
  const findings = await auditEvidenceCatalog(manifest(target, undefined), [sourceEvidence(stored, sha256(stored))]);
  assert.deepEqual(findings, [], "a field-less run is grandfathered and, when internally consistent, produces no findings");
});
