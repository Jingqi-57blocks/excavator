import { join } from "node:path";
import { CONTRACT_MANIFEST_ASSURANCE_GENERATION, assuranceGenerationAtLeast } from "../base/assurance-version.ts";
import type { AuditFinding, RunManifest } from "../base/types.ts";
import { contractManifestDigest, type ContractManifest } from "../contract/contract-manifest.ts";
import { requirementsDigest, runIntentDigest, type Requirements, type RunIntent } from "../contract/bound-run-contract.ts";
import { assertNever, type ArtifactResult } from "../base/artifact-result.ts";
import { ledgerContentIdentity, type FileLedger } from "../snapshot/file-ledger.ts";
import { auditMechanismLedger } from "./mechanism-ledger-audit.ts";
import { exists, readJson } from "../base/util.ts";

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
  const findings: AuditFinding[] = [...await auditContractDigests(runDir, contract)];
  for (const instance of contract.expected) {
    if (!instance.enforced) continue;
    if (!await exists(join(runDir, instance.path))) {
      findings.push(error(`${instance.slotId} instance "${instance.instanceKey}" is missing: ${instance.path} (schema ${instance.schemaId}, validator ${instance.validatorVersion})`));
    }
  }
  // Layer 1 is read ONCE and handed down: layer 2's audit checks its own rows against the very envelope this
  // run recorded, rather than re-reading a file that could have changed between the two reads.
  const boundary = await auditBoundaryLedger(runDir, manifest, contract);
  findings.push(...boundary.findings);
  findings.push(...await auditMechanismLedger(runDir, contract, boundary.envelope));
  return findings;
}

/**
 * Verify the contract record against ITSELF before anything is checked against it.
 *
 * Every check below reads `contract.expected` and skips whatever it does not find there, so a manifest
 * truncated to `expected: []` — or one with every `enforced` flipped to false — turns the entire instance audit
 * into a silent pass. The recorded digests are what make that detectable, and they only work if someone
 * recomputes them. The two input digests are checked against the contract files sitting next to the manifest as
 * well, so the three records cannot be verified in isolation and still disagree with each other.
 */
async function auditContractDigests(runDir: string, contract: ContractManifest): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const recomputed = contractManifestDigest(contract);
  if (recomputed !== contract.digest) {
    findings.push(error(`contract/contract-manifest.json does not match its own digest (recorded ${contract.digest}, re-derived ${recomputed}); the expected-instance set it declares cannot be trusted`));
  }
  findings.push(...await auditContractInput<RunIntent>(runDir, "run-intent.json", contract.runIntentDigest, runIntentDigest));
  findings.push(...await auditContractInput<Requirements>(runDir, "requirements.json", contract.requirementsDigest, requirementsDigest));
  return findings;
}

/** One contract input, checked against its own digest and against the digest the manifest recorded for it. */
async function auditContractInput<T extends { digest: string }>(runDir: string, file: string, recorded: string, rederive: (value: T) => string): Promise<AuditFinding[]> {
  const path = join(runDir, "contract", file);
  if (!await exists(path)) {
    return [error(`contract/${file} is missing; the contract manifest records its digest ${recorded}, so the input the contract was derived from is gone`)];
  }
  const value = await readJson<T>(path);
  const findings: AuditFinding[] = [];
  const rederived = rederive(value);
  if (rederived !== value.digest) findings.push(error(`contract/${file} does not match its own digest (recorded ${value.digest}, re-derived ${rederived})`));
  if (value.digest !== recorded) findings.push(error(`contract/${file} is not the input the contract manifest was derived from (the manifest records ${recorded}, the file carries ${value.digest})`));
  return findings;
}

/**
 * The layer-1 envelope, consumed exhaustively.
 *
 * `NotApplicable` is not a legal state here and says so: layer 1 either read the boundary or could not, and a
 * "provably not applicable" boundary would mean the run has no denominator while claiming it checked.
 */
async function auditBoundaryLedger(runDir: string, manifest: RunManifest, contract: ContractManifest): Promise<{ findings: AuditFinding[]; envelope: ArtifactResult<FileLedger> | null }> {
  const slot = contract.expected.find((instance) => instance.slotId === "boundary.files-ledger");
  if (!slot?.enforced) return { findings: [], envelope: null };
  const path = join(runDir, slot.path);
  if (!await exists(path)) return { findings: [], envelope: null };  // already reported as a missing instance above
  let envelope: ArtifactResult<FileLedger>;
  try {
    envelope = await readJson<ArtifactResult<FileLedger>>(path);
  } catch (readError) {
    return { findings: [error(`${slot.path} could not be read: ${(readError as Error).message}`)], envelope: null };
  }
  switch (envelope.status) {
    case "built":
      return { findings: auditLedgerContent(slot.path, envelope.value, manifest), envelope };
    case "not-applicable":
      return { findings: [error(`${slot.path} records the file ledger as not-applicable ("${envelope.determination}"); the source boundary is either read or unavailable, never inapplicable`)], envelope };
    case "unavailable":
      return { findings: [error(`${slot.path} records the source boundary as unreadable: ${envelope.cause}`)], envelope };
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
  // The contract makes the tier2 digest a MANDATORY ATTRIBUTE of a counted row, so an absent one is a finding
  // here rather than a shrug in the ledger. It means the file lost the race between `lstat` and the read, and
  // every downstream consumer keyed on content identity is one row short without saying so.
  const unread = ledger.counted.filter((row) => row.content.status === "absent");
  if (unread.length) {
    const named = unread.slice(0, 5).map((row) => `${row.relativePath} (${row.content.status === "absent" ? row.content.reason : ""})`).join(", ");
    findings.push(error(`${path}: ${unread.length} counted row(s) carry no content identity: ${named}${unread.length > 5 ? ", …" : ""}; a counted row's tier2 digest is a required attribute, so the boundary was read incompletely`));
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
