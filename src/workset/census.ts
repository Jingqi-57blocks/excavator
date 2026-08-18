import type { ArtifactResult } from "../base/artifact-result.ts";
import { summarizeCoverage, summarizeSelection, type CoverageConservation, type SelectionConservation } from "../base/conservation.ts";
import { corpusResolver, LANGUAGE_REGISTRY } from "../base/language-registry.ts";
import { RowSet, type RowSetIdentity } from "../base/row-set.ts";
import type { AttributionArtifact, AttributionSelection } from "../attribution/attribution-artifact.ts";
import type { UnitsArtifact } from "../facts/units/units-artifact.ts";
import type { FileLedger, CountedRow } from "../snapshot/file-ledger.ts";

export const SCOPE_CENSUS_VERSION = "scope-census-v2";
export const OVERVIEW_CENSUS_VERSION = "overview-census-v2";

export interface CensusDenominator {
  readonly artifact: string;
  readonly contentDigest: string;
  readonly producerVersion: string;
  readonly coverageDomain: "file";
  readonly unitKind: "file" | "partition-cell";
  readonly rows: number;
  readonly completeness: RowSetIdentity["completeness"];
}

export interface ScopeCensusRow {
  readonly kind: "census";
  readonly module: string;
  readonly language: string;
  /** Coverage of lower-ledger FILE rows by this feature's seated workset. */
  readonly coverage: {
    readonly coverageDomain: "file";
    readonly unitKind: "file";
    readonly totals: CoverageConservation;
  };
  /** The layer-4 selection law, independently conserved over partition cells. */
  readonly selection: {
    readonly coverageDomain: "file";
    readonly unitKind: "partition-cell";
    readonly totals: SelectionConservation;
  };
}

export interface CensusUnavailableRow {
  readonly kind: "census-unavailable";
  readonly featureKey: string;
  readonly cause: string;
  readonly retryable: boolean;
}

export interface ScopeCensusV2 {
  readonly version: typeof SCOPE_CENSUS_VERSION;
  readonly featureKey: string;
  readonly identity: {
    readonly files: CensusDenominator;
    readonly partition: CensusDenominator | null;
    readonly attributionDigest: string | null;
  };
  readonly rows: readonly (ScopeCensusRow | CensusUnavailableRow)[];
  readonly summary: {
    readonly coverage: CoverageConservation;
    readonly selection: SelectionConservation | null;
    readonly unavailableRows: number;
  };
}

export interface OverviewCensusRow {
  readonly kind: "census";
  readonly module: string;
  readonly language: string;
  readonly coverageDomain: "file";
  readonly unitKind: "file";
  /** Layer 1's candidate classification, regrouped without changing a bucket. */
  readonly totals: CoverageConservation;
}

export interface OverviewCensusV2 {
  readonly version: typeof OVERVIEW_CENSUS_VERSION;
  readonly identity: { readonly files: CensusDenominator };
  readonly rows: readonly OverviewCensusRow[];
  readonly summary: CoverageConservation;
}

export interface ScopeCensusInput {
  readonly featureKey: string;
  readonly files: RowSet;
  readonly ledger: FileLedger;
  readonly partition: RowSet;
  readonly units: UnitsArtifact;
  readonly attribution: AttributionArtifact;
  readonly attributionDigest: string;
}

/**
 * Layer 5's scope census. Both denominators must arrive through the two RowSet doors; raw arrays and
 * `refUnits[]` have no admissible runtime shape here. The two laws are built independently because file
 * coverage and partition selection answer different questions and are not addable.
 */
export function buildScopeCensus(input: ScopeCensusInput): ScopeCensusV2 {
  requireRowSet(input.files, "ledger/files.json", "file");
  requireRowSet(input.partition, "facts/units.json", "partition-cell");
  requireRows(input.files.rowIds, input.ledger.counted.map((row) => row.relativePath), "files RowSet");
  requireRows(input.partition.rowIds, input.units.partition.map((cell) => cell.unitId), "partition RowSet");
  if (input.attribution.denominator.contentDigest !== input.partition.identity.contentDigest) {
    throw new Error("Scope census attribution and partition RowSet name different denominator identities");
  }
  const selections = input.attribution.selections.filter((row) => row.featureKey === input.featureKey);
  if (selections.length !== 1) throw new Error(`Scope census requires exactly one attribution selection for ${JSON.stringify(input.featureKey)}, found ${selections.length}`);
  const selection = selections[0]!;

  const fileGroup = fileGroups(input.units, input.files);
  const cellGroup = cellGroups(input.units, input.partition);
  const keys = [...new Set([...fileGroup.values(), ...cellGroup.values()].map((group) => group.key))].sort();
  const seatedCells = new Set(selection.seats.map((row) => row.unitId));
  const displacedCells = new Set(selection.displacements.map((row) => row.unitId).filter((id) => !seatedCells.has(id)));
  const seatedPaths = new Set(selection.seats.map((row) => row.relativePath));
  const zeroScore = zeroScoreByGroup(selection);

  const rows = keys.map((key): ScopeCensusRow => {
    const group = [...fileGroup.values(), ...cellGroup.values()].find((candidate) => candidate.key === key)!;
    const fileIds = [...fileGroup.entries()].filter(([, value]) => value.key === key).map(([id]) => id);
    const cellIds = [...cellGroup.entries()].filter(([, value]) => value.key === key).map(([id]) => id);
    const seated = cellIds.filter((id) => seatedCells.has(id)).length;
    const displaced = cellIds.filter((id) => displacedCells.has(id)).length;
    const zero = zeroScore.get(key) ?? 0;
    return {
      kind: "census",
      module: group.module,
      language: group.language,
      coverage: {
        coverageDomain: "file",
        unitKind: "file",
        totals: summarizeCoverage({ total: fileIds.length, counted: fileIds.filter((path) => seatedPaths.has(path)).length, excluded: 0 })
      },
      selection: {
        coverageDomain: "file",
        unitKind: "partition-cell",
        totals: summarizeSelection({ counted: cellIds.length, seated, zeroScore: zero, displaced })
      }
    };
  });
  const coverage = summarizeCoverage({
    total: rows.reduce((sum, row) => sum + row.coverage.totals.total, 0),
    counted: rows.reduce((sum, row) => sum + row.coverage.totals.counted, 0),
    excluded: rows.reduce((sum, row) => sum + row.coverage.totals.excluded, 0)
  });
  const selected = summarizeSelection({
    counted: rows.reduce((sum, row) => sum + row.selection.totals.counted, 0),
    seated: rows.reduce((sum, row) => sum + row.selection.totals.seated, 0),
    zeroScore: rows.reduce((sum, row) => sum + row.selection.totals.zeroScore, 0),
    displaced: rows.reduce((sum, row) => sum + row.selection.totals.displaced, 0)
  });
  return {
    version: SCOPE_CENSUS_VERSION,
    featureKey: input.featureKey,
    identity: {
      files: denominator(input.files),
      partition: denominator(input.partition),
      attributionDigest: input.attributionDigest
    },
    rows,
    summary: { coverage, selection: selected, unavailableRows: 0 }
  };
}

/** A local feature failure remains a row inside Built; the whole workset did not disappear. */
export function unavailableScopeCensus(featureKey: string, files: RowSet, cause: string, retryable: boolean): ScopeCensusV2 {
  requireRowSet(files, "ledger/files.json", "file");
  return {
    version: SCOPE_CENSUS_VERSION,
    featureKey,
    identity: { files: denominator(files), partition: null, attributionDigest: null },
    rows: [{ kind: "census-unavailable", featureKey, cause, retryable }],
    summary: { coverage: summarizeCoverage({ total: files.size, counted: 0, excluded: 0 }), selection: null, unavailableRows: 1 }
  };
}

/** Unconditional run-level census over layer 1's own three buckets, grouped by module and language. */
export function buildOverviewCensus(ledger: FileLedger, files: RowSet): OverviewCensusV2 {
  requireRowSet(files, "ledger/files.json", "file");
  requireRows(files.rowIds, ledger.counted.map((row) => row.relativePath), "files RowSet");
  const resolver = corpusResolver(LANGUAGE_REGISTRY);
  const groups = new Map<string, { module: string; language: string; total: number; counted: number; excluded: number }>();
  const add = (row: CountedRow, bucket: "counted" | "excluded"): void => {
    const name = row.relativePath.slice(row.relativePath.lastIndexOf("/") + 1);
    const language = resolver.languageOf(name, row.extension) ?? `unregistered:${row.extension || "(none)"}`;
    const key = groupKey(row.rootName, language);
    const current = groups.get(key) ?? { module: row.rootName, language, total: 0, counted: 0, excluded: 0 };
    current.total += 1;
    current[bucket] += 1;
    groups.set(key, current);
  };
  for (const row of ledger.counted) add(row, "counted");
  for (const row of ledger.excluded) add(row, "excluded");
  // `unexplained` is structurally empty today. Keep it in the total and let the single constructor derive the
  // residual, so a future non-empty row cannot be dropped by this view.
  for (const row of ledger.unexplained) {
    const name = row.relativePath.slice(row.relativePath.lastIndexOf("/") + 1);
    const language = resolver.languageOf(name, row.extension) ?? `unregistered:${row.extension || "(none)"}`;
    const key = groupKey(row.rootName, language);
    const current = groups.get(key) ?? { module: row.rootName, language, total: 0, counted: 0, excluded: 0 };
    current.total += 1;
    groups.set(key, current);
  }
  const rows: OverviewCensusRow[] = [...groups.values()]
    .sort((a, b) => a.module.localeCompare(b.module) || a.language.localeCompare(b.language))
    .map((row) => ({
      kind: "census",
      module: row.module,
      language: row.language,
      coverageDomain: "file",
      unitKind: "file",
      totals: summarizeCoverage({ total: row.total, counted: row.counted, excluded: row.excluded })
    }));
  const summary = summarizeCoverage({
    total: rows.reduce((sum, row) => sum + row.totals.total, 0),
    counted: rows.reduce((sum, row) => sum + row.totals.counted, 0),
    excluded: rows.reduce((sum, row) => sum + row.totals.excluded, 0)
  });
  if (summary.total !== ledger.summary.total || summary.counted !== ledger.summary.counted || summary.excluded !== ledger.summary.excluded || summary.unexplained !== ledger.summary.unexplained) {
    throw new Error("Overview census regrouping changed the file-ledger conservation buckets");
  }
  return { version: OVERVIEW_CENSUS_VERSION, identity: { files: denominator(files) }, rows, summary };
}

export function scopeCensusResidual(census: ScopeCensusV2): { balanced: boolean; unexplained: readonly string[]; unavailable: readonly CensusUnavailableRow[] } {
  const ordinary = census.rows.filter((row): row is ScopeCensusRow => row.kind === "census");
  const unavailable = census.rows.filter((row): row is CensusUnavailableRow => row.kind === "census-unavailable");
  const balanced = ordinary.every((row) =>
    row.coverage.totals.total === row.coverage.totals.counted + row.coverage.totals.excluded + row.coverage.totals.unexplained
    && row.selection.totals.counted === row.selection.totals.seated + row.selection.totals.zeroScore + row.selection.totals.displaced);
  return {
    balanced,
    unexplained: ordinary.filter((row) => row.coverage.totals.unexplained > 0).map((row) => `${row.module}/${row.language}`),
    unavailable
  };
}

export function overviewCensusResidual(census: OverviewCensusV2): { balanced: boolean; unexplained: readonly string[] } {
  return {
    balanced: census.rows.every((row) => row.totals.total === row.totals.counted + row.totals.excluded + row.totals.unexplained),
    unexplained: census.rows.filter((row) => row.totals.unexplained > 0).map((row) => `${row.module}/${row.language}`)
  };
}

export function requireBuilt<T>(result: ArtifactResult<T>, name: string): T {
  if (result.status === "built") return result.value;
  throw new Error(`${name} is ${result.status === "unavailable" ? `unavailable: ${result.cause}` : `not applicable: ${result.determination}`}`);
}

function denominator(rowSet: RowSet): CensusDenominator {
  if (rowSet.coverageDomain !== "file" || (rowSet.unitKind !== "file" && rowSet.unitKind !== "partition-cell")) {
    throw new Error(`Census denominator has unsupported domain/kind ${rowSet.coverageDomain}/${rowSet.unitKind}`);
  }
  return {
    artifact: rowSet.identity.artifact,
    contentDigest: rowSet.identity.contentDigest,
    producerVersion: rowSet.identity.producerVersion,
    coverageDomain: rowSet.coverageDomain,
    unitKind: rowSet.unitKind,
    rows: rowSet.size,
    completeness: rowSet.identity.completeness
  };
}

function requireRowSet(value: unknown, artifact: string, unitKind: "file" | "partition-cell"): asserts value is RowSet {
  if (!(value instanceof RowSet)) throw new Error(`Census denominator must be a RowSet from ${artifact}; bare arrays and refUnits are forbidden`);
  if (value.identity.artifact !== artifact || value.unitKind !== unitKind || value.coverageDomain !== "file") {
    throw new Error(`Census expected ${artifact} (${unitKind}, file domain), got ${value.identity.artifact} (${value.unitKind}, ${value.coverageDomain})`);
  }
}

function requireRows(actual: readonly string[], expected: readonly string[], name: string): void {
  const canonical = [...new Set(expected)].sort();
  if (actual.length !== canonical.length || actual.some((id, index) => id !== canonical[index])) {
    throw new Error(`${name} does not contain exactly the ledger rows it claims to represent`);
  }
}

interface Group { readonly key: string; readonly module: string; readonly language: string; }

function fileGroups(units: UnitsArtifact, files: RowSet): Map<string, Group> {
  const records = new Map(units.files.map((row) => [row.relativePath, row] as const));
  const out = new Map<string, Group>();
  for (const path of files.rowIds) {
    const row = records.get(path);
    if (!row) throw new Error(`Units artifact has no file record for files RowSet row ${JSON.stringify(path)}`);
    const language = row.language ?? "unregistered";
    out.set(path, { key: groupKey(row.rootName, language), module: row.rootName, language });
  }
  return out;
}

function cellGroups(units: UnitsArtifact, partition: RowSet): Map<string, Group> {
  const languageByPath = new Map(units.files.map((row) => [row.relativePath, row.language ?? "unregistered"] as const));
  const cells = new Map(units.partition.map((cell) => [cell.unitId, cell] as const));
  const out = new Map<string, Group>();
  for (const id of partition.rowIds) {
    const cell = cells.get(id);
    if (!cell) throw new Error(`Units artifact has no partition cell for RowSet row ${JSON.stringify(id)}`);
    const language = languageByPath.get(cell.relativePath);
    if (language === undefined) throw new Error(`Units artifact has no language row for partition path ${JSON.stringify(cell.relativePath)}`);
    out.set(id, { key: groupKey(cell.rootName, language), module: cell.rootName, language });
  }
  return out;
}

function zeroScoreByGroup(selection: AttributionSelection): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of selection.zeroScore) {
    const key = groupKey(row.rootName, row.language ?? "unregistered");
    out.set(key, (out.get(key) ?? 0) + row.cells);
  }
  return out;
}

function groupKey(module: string, language: string): string { return `${module}\u0000${language}`; }
