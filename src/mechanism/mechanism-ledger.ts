import { assertNever, type ArtifactResult } from "../base/artifact-result.ts";
import { corpusResolver, languageRegistryDigest, type CorpusResolver, type LanguageRegistry } from "../base/language-registry.ts";
import {
  fileMatrixMechanisms, mechanismRegistryDigest,
  type FileMatrixMechanism, type MechanismAvailability, type MechanismAvailabilityMap,
  type MechanismRegistry, type CoverageDomain, type MechanismUnitKind
} from "../base/mechanism-registry.ts";
import type { CountedRow } from "../snapshot/file-ledger.ts";
import { stableJson } from "../base/util.ts";

/**
 * Layer 2's artifact: what could look at each row of layer 1's corpus.
 *
 * The gap this measures was previously a single aggregate counter. Structural probing covers seven extensions
 * (TS/Tsx/JS/Go) plus a separate Perl backend, so on a Perl target 1366 `.pm` files come back `unavailable`
 * from `probeDecision` and Python, Java, Ruby, PHP and C# come back the same way — all of it invisible per
 * language. This slice adds no grammar. It turns the gap into one number per (language x mechanism), which is
 * the ordering the layering contract insists on: measurement before the mechanism it attributes.
 *
 * Three cells, and they must never be confused, because each names a different party:
 *
 *  - `covered` — the mechanism's declared capability includes this row. Capability, NOT yield: see
 *    mechanism-registry.ts. A mechanism that runs and finds nothing is still `covered` here, and its emptiness
 *    is a layer-3 `NotApplicable{not-detected}`.
 *  - `no-mechanism` — the row is layer-1 counted and this mechanism does not declare it (wrong file type, or
 *    beyond the mechanism's own size bound). It says nothing about tools being installed. A file type the
 *    scanner never admitted is NOT this: it is `excluded{unsupported-extension}` at layer 1, and manufacturing
 *    a row for it here would be inventing a denominator this layer never received.
 *  - `mechanism-unavailable` — the mechanism DOES declare this row and its runtime dependency is missing. This
 *    is the one cell that says "we are blind where we claimed we could see", and folding it into either
 *    neighbour is what let a missing ast-grep binding read as "this language has no probe".
 *
 * No ratio is published, here or anywhere downstream from here, and least of all across two CoverageDomains:
 * `crossrepo` accounts for module pairs and `search` for files, so their numbers are not addable.
 */

/**
 * v2 serializes `takesMatrixRows` on every declaration.
 *
 * v1 declarations said nothing about whether a mechanism was SUPPOSED to have matrix rows, and the audit only
 * walked the rows that were present. So "the `search` row was deleted" and "`codegraph` legitimately has no
 * rows" were indistinguishable in the artifact's bytes: deleting a whole mechanism's grid removed its cells,
 * its conservation obligation and its per-language census all at once, and every remaining check still passed.
 * With the expectation written down, the audit can compare two sets instead of iterating one.
 */
export const MECHANISM_LEDGER_VERSION = "mechanisms-ledger-v2";

/**
 * A cell plus the reason it is not `covered`. Modelled as a union rather than an optional `cause`, so a
 * `no-mechanism` row without a stated reason is not representable and `covered` cannot carry a stray one.
 */
export type CellVerdict =
  | { cell: "covered" }
  | { cell: "no-mechanism"; cause: string }
  | { cell: "mechanism-unavailable"; cause: string };

/** The three cells as a set, derived from the union so a fourth spelling cannot enter one and not the other. */
export type Cell = CellVerdict["cell"];

export interface MechanismDeclaration {
  id: string;
  title: string;
  coverageDomain: CoverageDomain;
  unitKind: MechanismUnitKind;
  version: string;
  availability: MechanismAvailability;
  /**
   * Whether this mechanism is expected to carry (file x mechanism) rows.
   *
   * Computed from the SAME predicate that decides which mechanisms get rows (`fileMatrixMechanisms`), not
   * restated here — a second reading of "file domain with a declared extension set" would be a second answer,
   * and the whole point of the field is that the audit can trust it. It exists because without it the matrix is
   * only checkable against itself: deleting an entire row took its conservation obligation and its census with
   * it, and the artifact could not say a row was missing.
   */
  takesMatrixRows: boolean;
}

/** One (mechanism x extension group) default. `files` is the whole group; exceptions override part of it. */
export type MatrixDefault = { extension: string; files: number } & CellVerdict;

/** One row whose verdict differs from its group's default. */
export type MatrixException = { relativePath: string } & CellVerdict;

export interface MatrixTotals {
  covered: number;
  noMechanism: number;
  mechanismUnavailable: number;
}

export interface FileMatrixRow {
  mechanismId: string;
  defaults: MatrixDefault[];
  exceptions: MatrixException[];
  /** Counted per row, never derived from the compression, so conservation cannot be broken by a folding bug. */
  totals: MatrixTotals;
}

export interface LanguageCensusRow extends MatrixTotals {
  language: string;
  mechanismId: string;
}

export interface MechanismLedger {
  version: typeof MECHANISM_LEDGER_VERSION;
  /** Binds this ledger to the layer-1 rows it accounted for and to the declarations it applied. */
  identity: {
    filesContentManifestDigest: string;
    scannerVersion: string;
    languageRegistry: { version: string; digest: string };
    mechanismRegistry: { version: string; digest: string };
  };
  /** The layer-1 denominator every matrix row must sum to. */
  counted: number;
  /** Every registered mechanism, including the ones with no matrix rows. */
  mechanisms: MechanismDeclaration[];
  fileMatrix: FileMatrixRow[];
  byLanguage: LanguageCensusRow[];
}

export interface MechanismLedgerInput {
  /** The counted rows of `ledger/files.json`. The ONLY admissible row set for this layer. */
  counted: readonly CountedRow[];
  filesContentManifestDigest: string;
  scannerVersion: string;
  availability: MechanismAvailabilityMap;
  /**
   * Both registries are REQUIRED, not defaulted. The ledger records their digests as its own identity, so a
   * builder that fell back to the module's tables when a caller passed nothing would publish a digest for
   * declarations it never applied.
   */
  languages: LanguageRegistry;
  mechanisms: MechanismRegistry;
}

/** The row properties a verdict depends on, resolved once so the matrix loop does no re-parsing. */
interface CorpusRow {
  relativePath: string;
  extension: string;
  name: string;
  /** `null` when layer 1 never observed a size; see `observedSize`. */
  size: number | null;
  nameClasses: string[];
  registeredExtension: boolean;
  language: string;
}

export function buildMechanismLedger(input: MechanismLedgerInput): MechanismLedger {
  const { languages, mechanisms } = input;
  const corpus = corpusResolver(languages);
  const rows = input.counted.map((row) => toCorpusRow(row, corpus));
  const matrix: FileMatrixRow[] = [];
  const census = new Map<string, LanguageCensusRow>();
  // Resolved ONCE, and both the loop below and the `takesMatrixRows` field read this one answer. Asking the
  // predicate twice would let the declaration and the grid drift, which is the drift the field exists to catch.
  const matrixMechanisms = fileMatrixMechanisms(mechanisms);
  const takesMatrixRows = new Set(matrixMechanisms.map((mechanism) => mechanism.id));

  for (const mechanism of matrixMechanisms) {
    const availability = input.availability[mechanism.id];
    const verdicts = rows.map((row) => verdictFor(mechanism, row, availability));
    matrix.push({
      mechanismId: mechanism.id,
      ...compress(rows, verdicts),
      totals: tally(verdicts)
    });
    rows.forEach((row, index) => {
      const key = `${row.language}\0${mechanism.id}`;
      const entry = census.get(key) ?? { language: row.language, mechanismId: mechanism.id, covered: 0, noMechanism: 0, mechanismUnavailable: 0 };
      add(entry, verdicts[index]);
      census.set(key, entry);
    });
  }

  return {
    version: MECHANISM_LEDGER_VERSION,
    identity: {
      filesContentManifestDigest: input.filesContentManifestDigest,
      scannerVersion: input.scannerVersion,
      languageRegistry: { version: languages.version, digest: languageRegistryDigest(languages) },
      mechanismRegistry: { version: mechanisms.version, digest: mechanismRegistryDigest(mechanisms) }
    },
    counted: rows.length,
    mechanisms: mechanisms.mechanisms.map((entry) => ({
      id: entry.id,
      title: entry.title,
      coverageDomain: entry.coverageDomain,
      unitKind: entry.unitKind,
      version: entry.version,
      availability: input.availability[entry.id],
      takesMatrixRows: takesMatrixRows.has(entry.id)
    })).sort((a, b) => compare(a.id, b.id)),
    fileMatrix: matrix.sort((a, b) => compare(a.mechanismId, b.mechanismId)),
    byLanguage: [...census.values()].sort((a, b) => compare(a.language, b.language) || compare(a.mechanismId, b.mechanismId))
  };
}

/**
 * The whole cell decision, in declared order. Every branch reads a declaration or an observation — nothing
 * here inspects a file or asks a mechanism how it did.
 *
 * The ORDER is the honest part. Support is judged before availability, so a `.md` row against
 * `decision-probe` stays `no-mechanism` even when ast-grep is missing: calling it `mechanism-unavailable`
 * would claim we could have probed markdown if only the binding had been there. And the size bound is judged
 * before availability for the same reason — a 700 KB file is out of content search's scope whether or not
 * anything is installed.
 */
function verdictFor(mechanism: FileMatrixMechanism, row: CorpusRow, availability: MechanismAvailability): CellVerdict {
  // Layer 1 admitted a row this registry does not recognise at all. Unreachable while the scanner admits rows
  // through `isRegisteredCorpusMember` (which the consistency test pins), and it must still land in a visible
  // bucket rather than vanish, or the matrix would stop summing to the layer-1 denominator.
  if (!row.registeredExtension && !row.nameClasses.length) return { cell: "no-mechanism", cause: "corpus-unregistered" };

  const byExtension = row.registeredExtension && mechanism.support.extensions.includes(row.extension);
  const byNameClass = row.nameClasses.some((id) => mechanism.nameClasses.includes(id));
  if (!byExtension && !byNameClass) {
    return { cell: "no-mechanism", cause: row.registeredExtension ? "extension-not-declared" : "name-class-not-declared" };
  }

  if (mechanism.maxFileBytes !== null) {
    // A counted row whose bytes were never sampled has no size to compare, so nothing can claim it is within
    // the bound. The cause names the observation gap instead of pretending capability.
    if (row.size === null) return { cell: "no-mechanism", cause: "size-unobserved" };
    if (row.size > mechanism.maxFileBytes) return { cell: "no-mechanism", cause: `${mechanism.id}-size-cap-${mechanism.maxFileBytes}` };
  }

  switch (availability.status) {
    case "available": return { cell: "covered" };
    case "unavailable": return { cell: "mechanism-unavailable", cause: availability.cause };
    default: return assertNever(availability, "mechanism availability");
  }
}

/**
 * Fold one mechanism's per-row verdicts into (one default per extension group + the rows that differ).
 *
 * Uncompressed, wcp's 1999 rows across eight file-domain mechanisms are 15,992 cells — a grid nobody reads and
 * every consumer must scan. The default is the group's MODAL verdict rather than a verdict computed from the
 * extension alone, because for a group like `""` (whose rows are `README`, `Makefile`, `LICENSE`,
 * `Dockerfile`) no extension-only verdict is a verdict any row actually has. Ties break on the verdict key so
 * two runs over the same rows fold identically.
 */
function compress(rows: CorpusRow[], verdicts: CellVerdict[]): { defaults: MatrixDefault[]; exceptions: MatrixException[] } {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const bucket = groups.get(row.extension);
    if (bucket) bucket.push(index);
    else groups.set(row.extension, [index]);
  });
  const defaults: MatrixDefault[] = [];
  const exceptions: MatrixException[] = [];
  for (const [extension, indexes] of groups) {
    const counts = new Map<string, { verdict: CellVerdict; count: number }>();
    for (const index of indexes) {
      const key = verdictKey(verdicts[index]);
      const entry = counts.get(key) ?? { verdict: verdicts[index], count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    const modal = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || compare(a[0], b[0]))[0];
    defaults.push({ extension, files: indexes.length, ...modal[1].verdict });
    for (const index of indexes) {
      if (verdictKey(verdicts[index]) === modal[0]) continue;
      exceptions.push({ relativePath: rows[index].relativePath, ...verdicts[index] });
    }
  }
  return {
    defaults: defaults.sort((a, b) => compare(a.extension, b.extension)),
    exceptions: exceptions.sort((a, b) => compare(a.relativePath, b.relativePath))
  };
}

/**
 * Expand a compressed matrix row back to one verdict per counted path. The inverse of `compress`, and the
 * reason compression is safe to publish: the round trip is checkable against a brute-force per-row computation
 * and the audit uses it to re-derive `totals` from the folded form.
 */
export function expandMatrixRow(row: FileMatrixRow, pathsByExtension: ReadonlyMap<string, readonly string[]>): Map<string, CellVerdict> {
  const out = new Map<string, CellVerdict>();
  for (const entry of row.defaults) {
    for (const relativePath of pathsByExtension.get(entry.extension) ?? []) out.set(relativePath, verdictOf(entry));
  }
  // Applied last, because an exception's whole job is to override the default its group carries.
  for (const exception of row.exceptions) out.set(exception.relativePath, verdictOf(exception));
  return out;
}

/** The verdict half of a matrix record, without its identifying fields. */
export function verdictOf(record: MatrixDefault | MatrixException): CellVerdict {
  switch (record.cell) {
    case "covered": return { cell: "covered" };
    case "no-mechanism": return { cell: "no-mechanism", cause: record.cause };
    case "mechanism-unavailable": return { cell: "mechanism-unavailable", cause: record.cause };
    default: return assertNever(record, "matrix cell verdict");
  }
}

export function verdictKey(verdict: CellVerdict): string {
  return verdict.cell === "covered" ? "covered" : `${verdict.cell}\0${verdict.cause}`;
}

function tally(verdicts: CellVerdict[]): MatrixTotals {
  const totals: MatrixTotals = { covered: 0, noMechanism: 0, mechanismUnavailable: 0 };
  for (const verdict of verdicts) add(totals, verdict);
  return totals;
}

function add(totals: MatrixTotals, verdict: CellVerdict): void {
  switch (verdict.cell) {
    case "covered": totals.covered += 1; return;
    case "no-mechanism": totals.noMechanism += 1; return;
    case "mechanism-unavailable": totals.mechanismUnavailable += 1; return;
    default: return assertNever(verdict, "matrix cell verdict");
  }
}

function toCorpusRow(row: CountedRow, corpus: CorpusResolver): CorpusRow {
  // Layer 1 normalises every relative path to forward slashes, so the basename is a slice — this module takes
  // no dependency outside the base, the layer-1 row type and core utilities.
  const name = row.relativePath.slice(row.relativePath.lastIndexOf("/") + 1);
  return {
    relativePath: row.relativePath,
    extension: row.extension,
    name,
    size: observedSize(row),
    nameClasses: corpus.nameClassesMatching(name).map((entry) => entry.id),
    registeredExtension: corpus.isRegisteredExtension(row.extension),
    language: corpus.languageOf(name, row.extension) ?? "unregistered"
  };
}

/** The size layer 1 observed, or `null` when it recorded no bytes at all. Exhaustive over the tier1 union. */
function observedSize(row: CountedRow): number | null {
  switch (row.tier1.status) {
    case "sampled": return row.tier1.size;
    case "stat-only": return row.tier1.size;
    case "unsampled": return null;
    default: return assertNever(row.tier1, "counted row tier1 shape");
  }
}

function compare(a: string, b: string): number { return a.localeCompare(b); }

/**
 * The ledger's canonical bytes: stable key order, stable row order, no wall-clock field anywhere. Two prepares
 * over an unchanged tree on one machine must produce identical bytes; availability is a real per-machine
 * observation, so byte equality is pinned across re-runs, never across machines.
 */
export function serializeMechanismLedger(result: ArtifactResult<MechanismLedger>): string {
  return `${stableJson(result)}\n`;
}
