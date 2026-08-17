import { join } from "node:path";
import type { AuditFinding } from "../base/types.ts";
import { assertNever, type ArtifactResult } from "../base/artifact-result.ts";
import type { ContractManifest } from "../contract/contract-manifest.ts";
import type { FileLedger } from "../snapshot/file-ledger.ts";
import {
  expandMatrixRow, verdictKey, type FileMatrixRow, type MatrixTotals, type MechanismLedger
} from "../mechanism/mechanism-ledger.ts";
import { exists, readJson } from "../base/util.ts";

/**
 * Verify the layer-2 ledger the run recorded — against ITSELF and against the layer-1 rows it claims to
 * account for, never against what today's registries would produce. An archived run keeps verifying under the
 * declarations it was prepared with; re-deriving the cells from current code is the retroactive-failure shape
 * the contract forbids.
 *
 * What that leaves is still substantial, because every claim in this artifact is checkable from its own bytes:
 *
 *  - Conservation, per mechanism and per domain. `covered + no-mechanism + mechanism-unavailable` must equal
 *    the layer-1 counted denominator for EVERY mechanism. A matrix row that quietly drops a language is a row
 *    whose sum is short, which is the whole reason the totals are counted per row rather than folded.
 *  - The compression round trip. `totals` is computed per row at build time and the folded
 *    (defaults + exceptions) form is expanded here and compared: tampering with any of the three is caught.
 *  - Ghost rows. A matrix default for an extension that is not a layer-1 counted group means this layer
 *    invented a denominator. That is precisely the failure the `no-mechanism` term was narrowed to prevent: an
 *    unregistered extension belongs to layer 1's `excluded{unsupported-extension}`, not to a phantom row here.
 *  - The declaration/matrix agreement. A mechanism recorded as `available` may not have a single
 *    `mechanism-unavailable` cell, and one recorded `unavailable` may not have a single `covered` cell. Without
 *    this the three cells could be minted independently of what the run observed, and "the binding was missing"
 *    would once again be indistinguishable from "this language has no mechanism".
 */

function error(message: string): AuditFinding { return { level: "error", document: "contract", message }; }

export async function auditMechanismLedger(runDir: string, contract: ContractManifest, files: ArtifactResult<FileLedger> | null): Promise<AuditFinding[]> {
  const slot = contract.expected.find((instance) => instance.slotId === "mechanism.mechanisms-ledger");
  if (!slot?.enforced) return [];
  const path = join(runDir, slot.path);
  if (!await exists(path)) return [];  // already reported as a missing instance by the caller
  let envelope: ArtifactResult<MechanismLedger>;
  try {
    envelope = await readJson<ArtifactResult<MechanismLedger>>(path);
  } catch (readError) {
    return [error(`${slot.path} could not be read: ${(readError as Error).message}`)];
  }
  switch (envelope.status) {
    case "built":
      return auditLedgerContent(slot.path, envelope.value, files);
    case "not-applicable":
      // Every run has a corpus and a set of mechanisms, so "provably does not apply" cannot be true here: the
      // mechanisms were declared or the ledger could not be built.
      return [error(`${slot.path} records the mechanism ledger as not-applicable ("${envelope.determination}"); a run either declares its mechanisms or records why it could not`)];
    case "unavailable":
      return [error(`${slot.path} records the mechanism ledger as unavailable: ${envelope.cause}`)];
    default:
      return assertNever(envelope, "mechanism ledger artifact result");
  }
}

function auditLedgerContent(path: string, ledger: MechanismLedger, files: ArtifactResult<FileLedger> | null): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const boundary = files?.status === "built" ? files.value : null;
  const declared = new Map(ledger.mechanisms.map((mechanism) => [mechanism.id, mechanism]));

  if (boundary) {
    if (ledger.identity.filesContentManifestDigest !== boundary.contentManifestDigest) {
      findings.push(error(`${path}: the ledger is bound to a different layer-1 corpus (records ${ledger.identity.filesContentManifestDigest}, ledger/files.json carries ${boundary.contentManifestDigest}); every cell in it counts rows this run did not read`));
    }
    if (ledger.counted !== boundary.summary.counted) {
      findings.push(error(`${path}: the denominator does not match layer 1 (records ${ledger.counted}, ledger/files.json counted ${boundary.summary.counted})`));
    }
  }

  // Layer 1 is the authority on which extension group a row belongs to, so the mapping is read from its rows
  // rather than re-derived from the path here — a second `extname` implementation is a second answer.
  const pathsByExtension = new Map<string, string[]>();
  const extensionOfPath = new Map<string, string>();
  for (const row of boundary?.counted ?? []) {
    extensionOfPath.set(row.relativePath, row.extension);
    const bucket = pathsByExtension.get(row.extension);
    if (bucket) bucket.push(row.relativePath);
    else pathsByExtension.set(row.extension, [row.relativePath]);
  }

  for (const mechanism of ledger.mechanisms) {
    switch (mechanism.availability.status) {
      case "available": case "unavailable": break;
      default: return [assertNever(mechanism.availability, "mechanism availability")];
    }
  }

  for (const row of ledger.fileMatrix) {
    const mechanism = declared.get(row.mechanismId);
    if (!mechanism) {
      findings.push(error(`${path}: the matrix carries rows for ${row.mechanismId}, which the ledger never declares; a mechanism with cells but no declaration has no CoverageDomain, UnitKind or availability`));
      continue;
    }
    if (mechanism.coverageDomain !== "file") {
      findings.push(error(`${path}: ${row.mechanismId} declares CoverageDomain ${mechanism.coverageDomain} yet carries (file x mechanism) rows; a per-file grid for a non-file domain is a coverage claim it never made`));
    }
    const sum = row.totals.covered + row.totals.noMechanism + row.totals.mechanismUnavailable;
    if (sum !== ledger.counted) {
      findings.push(error(`${path}: ${row.mechanismId} does not account for every counted row (covered ${row.totals.covered} + no-mechanism ${row.totals.noMechanism} + mechanism-unavailable ${row.totals.mechanismUnavailable} = ${sum}, counted ${ledger.counted})`));
    }
    if (mechanism.availability.status === "available" && row.totals.mechanismUnavailable > 0) {
      findings.push(error(`${path}: ${row.mechanismId} is recorded as available yet ${row.totals.mechanismUnavailable} of its cells say the mechanism was unavailable`));
    }
    if (mechanism.availability.status === "unavailable" && row.totals.covered > 0) {
      findings.push(error(`${path}: ${row.mechanismId} is recorded as unavailable (${mechanism.availability.cause}) yet ${row.totals.covered} of its cells claim coverage`));
    }
    findings.push(...auditMatrixRow(path, row, ledger.counted, boundary === null ? null : { pathsByExtension, extensionOfPath }));
    findings.push(...auditLanguageCensus(path, ledger, row));
  }
  return findings;
}

/**
 * One matrix row: the folded form must expand to the totals it publishes, cover every counted group exactly
 * once, and name no path or extension that is not a counted row.
 *
 * When layer 1 is not readable the group-level checks are skipped rather than guessed — that absence is
 * already an error against `ledger/files.json`, and a second finding derived from missing rows would report a
 * layer-2 defect that layer 2 did not have.
 */
function auditMatrixRow(path: string, row: FileMatrixRow, counted: number, boundary: { pathsByExtension: Map<string, string[]>; extensionOfPath: Map<string, string> } | null): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const declaredFiles = row.defaults.reduce((total, entry) => total + entry.files, 0);
  if (declaredFiles !== counted) {
    findings.push(error(`${path}: ${row.mechanismId}'s extension groups cover ${declaredFiles} rows, not the ${counted} rows layer 1 counted`));
  }
  const seen = new Set<string>();
  for (const entry of row.defaults) {
    if (seen.has(entry.extension)) findings.push(error(`${path}: ${row.mechanismId} declares the extension group ${JSON.stringify(entry.extension)} twice`));
    seen.add(entry.extension);
  }
  if (!boundary) return findings;

  for (const entry of row.defaults) {
    const group = boundary.pathsByExtension.get(entry.extension);
    if (!group) {
      findings.push(error(`${path}: ${row.mechanismId} carries a default for extension ${JSON.stringify(entry.extension)}, which is not a counted group in ledger/files.json; layer 2 may only account for rows layer 1 counted`));
      continue;
    }
    if (group.length !== entry.files) {
      findings.push(error(`${path}: ${row.mechanismId} claims ${entry.files} ${JSON.stringify(entry.extension)} rows; layer 1 counted ${group.length}`));
    }
  }
  for (const exception of row.exceptions) {
    if (!boundary.extensionOfPath.has(exception.relativePath)) {
      findings.push(error(`${path}: ${row.mechanismId} records an exception for ${exception.relativePath}, which is not a counted row in ledger/files.json`));
    }
  }
  if (findings.length) return findings;  // the expansion below is only meaningful once the groups line up

  const expanded = expandMatrixRow(row, boundary.pathsByExtension);
  const rederived: MatrixTotals = { covered: 0, noMechanism: 0, mechanismUnavailable: 0 };
  for (const verdict of expanded.values()) {
    if (verdict.cell === "covered") rederived.covered += 1;
    else if (verdict.cell === "no-mechanism") rederived.noMechanism += 1;
    else rederived.mechanismUnavailable += 1;
  }
  if (!sameTotals(rederived, row.totals)) {
    findings.push(error(`${path}: ${row.mechanismId}'s published totals do not match its own compressed rows (published ${describe(row.totals)}, expanded ${describe(rederived)})`));
  }
  const seenPaths = new Set<string>();
  const duplicated: string[] = [];
  for (const exception of row.exceptions) {
    if (seenPaths.has(exception.relativePath)) duplicated.push(exception.relativePath);
    seenPaths.add(exception.relativePath);
  }
  if (duplicated.length) {
    findings.push(error(`${path}: ${row.mechanismId} records ${duplicated.length} path(s) as an exception more than once, so one row's cell is ambiguous: ${duplicated[0]}`));
  }
  const defaultByExtension = new Map(row.defaults.map((entry) => [entry.extension, entry]));
  const redundant = row.exceptions.filter((exception) => {
    const extension = boundary.extensionOfPath.get(exception.relativePath);
    const group = extension === undefined ? undefined : defaultByExtension.get(extension);
    return group !== undefined && verdictKey(exception) === verdictKey(group);
  });
  if (redundant.length) {
    findings.push(error(`${path}: ${row.mechanismId} records ${redundant.length} exception(s) that restate their group's default, so the compressed form is not canonical: ${redundant[0].relativePath}`));
  }
  return findings;
}

/** The per-language census must add up to the same mechanism totals; it is a view, never a second opinion. */
function auditLanguageCensus(path: string, ledger: MechanismLedger, row: FileMatrixRow): AuditFinding[] {
  const rows = ledger.byLanguage.filter((entry) => entry.mechanismId === row.mechanismId);
  if (!rows.length) {
    return [error(`${path}: ${row.mechanismId} has matrix rows but no per-language census; the language gap this ledger exists to expose would be invisible`)];
  }
  const totals: MatrixTotals = { covered: 0, noMechanism: 0, mechanismUnavailable: 0 };
  for (const entry of rows) {
    totals.covered += entry.covered;
    totals.noMechanism += entry.noMechanism;
    totals.mechanismUnavailable += entry.mechanismUnavailable;
  }
  if (!sameTotals(totals, row.totals)) {
    return [error(`${path}: ${row.mechanismId}'s per-language census does not add up to its matrix totals (census ${describe(totals)}, matrix ${describe(row.totals)})`)];
  }
  return [];
}

function sameTotals(a: MatrixTotals, b: MatrixTotals): boolean {
  return a.covered === b.covered && a.noMechanism === b.noMechanism && a.mechanismUnavailable === b.mechanismUnavailable;
}

function describe(totals: MatrixTotals): string {
  return `covered ${totals.covered} / no-mechanism ${totals.noMechanism} / mechanism-unavailable ${totals.mechanismUnavailable}`;
}
