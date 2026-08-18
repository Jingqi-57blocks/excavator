import { sha256, stableJson } from "./util.ts";

/**
 * A NotApplicable determination is only as strong as the records it names. These stable names are shared by
 * the producer that makes the determination and layer 8, which re-resolves the same values from the run.
 */
export const FILE_COMPLETENESS_BASIS = "ledger/files.json#completeness";
export const CODEGRAPH_MODULES_BASIS = "request.json#codegraphModules";
export function mechanismCoverageBasisName(mechanismId: string): string {
  return `ledger/mechanisms.json#mechanism:${mechanismId}`;
}

export interface CoverageBasisValue {
  readonly reference: string;
  readonly value: unknown;
}

/** Digest named values, not an unlabelled tuple: reordering basedOn cannot change which premise a value means. */
export function coverageBasisDigest(values: readonly CoverageBasisValue[]): string {
  const references = values.map((row) => row.reference);
  if (new Set(references).size !== references.length) throw new Error("A coverage premise may not name the same basis twice");
  return sha256(stableJson([...values].sort((a, b) => a.reference.localeCompare(b.reference))));
}

/** The exact layer-2 record relevant to one mechanism; unrelated mechanisms cannot invalidate its premise. */
export function mechanismCoverageValue(ledger: {
  readonly mechanisms: readonly unknown[];
  readonly fileMatrix: readonly unknown[];
  readonly byLanguage: readonly unknown[];
}, mechanismId: string): unknown {
  const declaration = ledger.mechanisms.find((row) => recordId(row, "id") === mechanismId);
  if (!declaration) throw new Error(`Mechanism coverage basis cannot find declaration ${mechanismId}`);
  const matrix = ledger.fileMatrix.find((row) => recordId(row, "mechanismId") === mechanismId) ?? null;
  const byLanguage = ledger.byLanguage
    .filter((row) => recordId(row, "mechanismId") === mechanismId)
    .sort((a, b) => String((a as Record<string, unknown>).language ?? "").localeCompare(String((b as Record<string, unknown>).language ?? "")));
  return { declaration, matrix, byLanguage };
}

export function canonicalModuleSources(paths: readonly string[] | undefined): readonly string[] {
  return [...(paths ?? [])].sort((a, b) => a.localeCompare(b));
}

/** Only the scan-limit fields govern negative determinations; root progress detail is reported elsewhere. */
export function fileCompletenessValue(value: {
  readonly capReached: boolean;
  readonly skippedByCap: number;
  readonly droppedRoots: readonly string[];
  readonly readFailures?: number;
}): unknown {
  return {
    capReached: value.capReached,
    skippedByCap: value.skippedByCap,
    droppedRoots: [...value.droppedRoots].sort((a, b) => a.localeCompare(b)),
    readFailures: value.readFailures ?? 0
  };
}

function recordId(value: unknown, key: string): string | null {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>)[key] === "string"
    ? String((value as Record<string, unknown>)[key])
    : null;
}
