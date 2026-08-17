import { join } from "node:path";
import type { AuditFinding } from "./assurance.ts";
import { CONTRACT_MANIFEST_ASSURANCE_GENERATION, assuranceGenerationAtLeast } from "./assurance.ts";
import type { RunManifest } from "../core/types.ts";
import type { ContractManifest } from "../contract/contract-manifest.ts";
import { assertNever, type ArtifactResult } from "../base/artifact-result.ts";
import { ledgerContentIdentity, type FileLedger } from "../snapshot/file-ledger.ts";
import { exists, readJson } from "../core/util.ts";

/**
 * Verify a run against the contract IT recorded, instance by instance.
 *
 * Two properties matter more than the checks themselves. First, the expected set comes from
 * `contract/contract-manifest.json` inside the run — not from what the current code would expect — so an
 * archived run keeps verifying under the contract it was prepared with, and a later code change cannot fail it
 * retroactively. Second, the check is per INSTANCE: a run with two features expects two fact packs, so
 * feature A's pack cannot stand in for feature B's.
 *
 * The layer-1 envelope is consumed with an exhaustive switch closed by `assertNever`, which is the point of
 * having one artifact union: a fourth state cannot be added anywhere without this consumer failing to compile.
 */

function error(message: string): AuditFinding { return { level: "error", document: "contract", message }; }

export async function auditContractInstances(runDir: string, manifest: RunManifest): Promise<AuditFinding[]> {
  const manifestPath = join(runDir, "contract", "contract-manifest.json");
  if (!await exists(manifestPath)) {
    // Grandfathering is by GENERATION, not by the file's presence: "the file is missing so there is nothing to
    // check" is exactly the shape that lets a required record disappear unnoticed.
    if (!assuranceGenerationAtLeast(manifest, CONTRACT_MANIFEST_ASSURANCE_GENERATION)) return [];
    return [error(`contract/contract-manifest.json is missing; a run prepared under assurance generation ${CONTRACT_MANIFEST_ASSURANCE_GENERATION} or later records its contract before any producer runs`)];
  }
  const contract = await readJson<ContractManifest>(manifestPath);
  const findings: AuditFinding[] = [];
  for (const instance of contract.expected) {
    if (!instance.enforced) continue;
    if (!await exists(join(runDir, instance.path))) {
      findings.push(error(`${instance.slotId} instance "${instance.instanceKey}" is missing: ${instance.path} (schema ${instance.schemaId}, validator ${instance.validatorVersion})`));
    }
  }
  findings.push(...await auditBoundaryLedger(runDir, manifest, contract));
  return findings;
}

/**
 * The layer-1 envelope, consumed exhaustively.
 *
 * `NotApplicable` is not a legal state here and says so: layer 1 either read the boundary or could not, and a
 * "provably not applicable" boundary would mean the run has no denominator while claiming it checked.
 */
async function auditBoundaryLedger(runDir: string, manifest: RunManifest, contract: ContractManifest): Promise<AuditFinding[]> {
  const slot = contract.expected.find((instance) => instance.slotId === "boundary.files-ledger");
  if (!slot?.enforced) return [];
  const path = join(runDir, slot.path);
  if (!await exists(path)) return [];  // already reported as a missing instance above
  let envelope: ArtifactResult<FileLedger>;
  try {
    envelope = await readJson<ArtifactResult<FileLedger>>(path);
  } catch (readError) {
    return [error(`${slot.path} could not be read: ${(readError as Error).message}`)];
  }
  switch (envelope.status) {
    case "built":
      return auditLedgerContent(slot.path, envelope.value, manifest);
    case "not-applicable":
      return [error(`${slot.path} records the file ledger as not-applicable ("${envelope.determination}"); the source boundary is either read or unavailable, never inapplicable`)];
    case "unavailable":
      return [error(`${slot.path} records the source boundary as unreadable: ${envelope.cause}`)];
    default:
      return assertNever(envelope, "file ledger artifact result");
  }
}

function auditLedgerContent(path: string, ledger: FileLedger, manifest: RunManifest): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const { total, counted, excluded, unexplained } = ledger.summary;
  if (total !== counted + excluded + unexplained) {
    findings.push(error(`${path}: the coverage partition does not balance (total ${total} != counted ${counted} + excluded ${excluded} + unexplained ${unexplained})`));
  }
  if (unexplained > 0) {
    findings.push(error(`${path}: ${unexplained} candidate(s) fell into no bucket; every denominator derived from this ledger is short by that much`));
  }
  // tier2 is an error and tier1 is advice, per the freeze rules: a content-digest mismatch means the identity
  // the whole run is bound to cannot be re-derived from the ledger it was derived from.
  const recomputed = ledgerContentIdentity(ledger);
  if (recomputed !== ledger.contentManifestDigest) {
    findings.push(error(`${path}: the recorded content digest does not match its own rows (recorded ${ledger.contentManifestDigest}, re-derived ${recomputed})`));
  }
  if (manifest.snapshot && manifest.snapshot.contentManifestDigest !== ledger.contentManifestDigest) {
    findings.push(error(`${path}: the ledger content digest does not match the snapshot this run recorded (snapshot ${manifest.snapshot.contentManifestDigest}, ledger ${ledger.contentManifestDigest})`));
  }
  return findings;
}
