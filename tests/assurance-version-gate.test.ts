import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { auditEvidenceCatalog } from "../src/investigation/assurance.ts";
import { ASSURANCE_VERSION, assuranceGeneration, assuranceGenerationAtLeast } from "../src/base/assurance-version.ts";
import { LOGIC_DISPOSITION_ASSURANCE_GENERATION } from "../src/obligation/logic-workitems.ts";
import { sha256 } from "../src/base/util.ts";
import type { EvidenceItem, RunManifest } from "../src/base/types.ts";
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

// --- generative-expansion gate (57B-375 rework): the assurance GENERATION, decoupled from the redaction
// suffix, so a later assurance/redaction bump never stops re-deriving items already baked into a run. ---

function versioned(assuranceVersion: string | undefined): RunManifest {
  return { assuranceVersion } as unknown as RunManifest;
}

test("assuranceGeneration parses the integer generation and treats missing/malformed as 0", () => {
  assert.equal(assuranceGeneration(versioned("assurance-v4-redaction-v4")), 4);
  assert.equal(assuranceGeneration(versioned("assurance-v3-redaction-v4")), 3);
  assert.equal(assuranceGeneration(versioned("assurance-v12-redaction-v9")), 12);
  assert.equal(assuranceGeneration(versioned(undefined)), 0);
  assert.equal(assuranceGeneration(versioned("garbage")), 0);
});

test("assuranceGenerationAtLeast(4) gates logic-disposition expansion without hinging on the redaction suffix", () => {
  const n = LOGIC_DISPOSITION_ASSURANCE_GENERATION; // 4
  assert.equal(assuranceGenerationAtLeast(versioned("assurance-v3-redaction-v4"), n), false, "a pre-v4 run does not expand");
  assert.equal(assuranceGenerationAtLeast(versioned("assurance-v4-redaction-v4"), n), true, "the introducing generation expands");
  assert.equal(assuranceGenerationAtLeast(versioned("assurance-v5-redaction-v4"), n), true, "a later assurance bump still expands");
  assert.equal(assuranceGenerationAtLeast(versioned("assurance-v4-redaction-v99"), n), true, "a later redaction bump on v4 still expands (no forward false-fail)");
  assert.equal(assuranceGenerationAtLeast(versioned(undefined), n), false, "a field-less run is grandfathered (no expansion)");
  assert.equal(assuranceGenerationAtLeast(versioned("assurance-v4-redaction-v4"), n), assuranceGenerationAtLeast({ assuranceVersion: ASSURANCE_VERSION } as unknown as RunManifest, n), "the current version is generation 4");
});
