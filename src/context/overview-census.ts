import { moduleOfPath, type ModuleScopeStatus } from "./scope-census.ts";

/**
 * WHAT THE OVERVIEW ACTUALLY LOOKED AT, PER MODULE — the same accounting `scope-census.ts` does for a
 * feature, for the document that claims to describe the whole project.
 *
 * THE DENOMINATOR IS THE SNAPSHOT, NOT THE GRAPH CENSUS. This is the one thing that must not be copied from
 * the feature path. The feature census takes its row set from `GraphSummary.roots`, which is correct there
 * because a feature's scope is built by searching the graph. An overview makes a claim about the project, and
 * the graph is itself a filtered view of it: measured on a real Perl target, CodeGraph held 12,399 nodes in
 * javascript/python/xml and ZERO in Perl, while the snapshot had scanned 1,422 Perl files. A row set taken
 * from the graph census would not have given those files a zero row — it would not have given them a row at
 * all, which is the exact failure this accounting exists to prevent, reproduced one layer up.
 *
 * NAMED AND READ ARE DIFFERENT FACTS. A file whose symbol appears in the representative-node or route
 * evidence has been NAMED to the author; a file with a recorded source window has been READ. Both are real,
 * they are not the same strength, and one column holding their sum would let a name-level mention be cited as
 * if the code had been opened. They are counted separately for the same reason `ModuleScopeStatus` refuses to
 * merge `zero-hit` with `excluded-by-rule`.
 *
 * NO PER-MODULE COVERAGE PERCENTAGE IS COMPUTED, deliberately. The overview's read set is bounded by fixed
 * budgets — representative nodes, routes, project documents and a small number of fallback windows — so
 * `read / snapshot` is a budget artifact, and publishing it as a percentage invites reading it as
 * completeness. The raw counts are recorded instead; `readShareBp` says where the overview's attention went,
 * which is a question the numbers can honestly answer.
 *
 * THERE IS NO UNAVAILABLE STATE. The feature census needs a graph and a vocabulary, so it has to be able to
 * say why no table exists. This one needs neither: the snapshot alone supplies the row set, so a table is
 * always produced. A source-only run reports every module with `indexedFiles: 0`, which is a reading rather
 * than an absence.
 */
export const OVERVIEW_CENSUS_VERSION = "overview-census-v1";

/**
 * Runs frozen before this generation are not judged by this accounting. Not a courtesy: their artifacts were
 * produced under a contract that did not include it, so a finding they could never have acted on is noise
 * that also breaks archived-run equivalence. Set to the generation current when the artifact was introduced
 * rather than a new one, because absence is already handled — a generation-9 run prepared before this slice
 * simply has no file, and no file means no findings.
 */
export const OVERVIEW_CENSUS_ASSURANCE_GENERATION = 9;

export interface OverviewModuleRow {
  module: string;
  /** Source files the SNAPSHOT scanned here. The denominator, independent of any index. */
  snapshotFiles: number;
  /** How many of those CodeGraph indexed. A gap is a navigation blind spot, never a coverage figure. */
  indexedFiles: number;
  /** Files named to the author through graph-derived evidence (representative nodes, route candidates). */
  namedFiles: number;
  /** Files the overview opened a recorded source window on. */
  readFiles: number;
  /** Share of the whole read set this module holds, in basis points (integer — floats are not byte-stable). */
  readShareBp: number;
  status: ModuleScopeStatus;
}

/**
 * The same four counts grouped by file extension.
 *
 * Module rows alone cannot answer "which language did the overview never look at", and on the target that
 * motivated this artifact they actively hide it: provital keeps 2,757 of its 2,760 source files under a
 * single top-level directory, so its 1,422 Perl files and the JavaScript that IS read share one row and that
 * row reads `counted`. First-path-segment granularity is the right key for joining against the graph census
 * — it is the convention the census SQL uses — and it is the wrong key for this question. Both are kept
 * rather than picking one.
 */
export interface OverviewExtensionRow {
  /** Lowercased, with the dot (`.pm`); `""` for a source file with no extension. */
  extension: string;
  snapshotFiles: number;
  indexedFiles: number;
  namedFiles: number;
  readFiles: number;
}

export interface OverviewCensus {
  version: string;
  rows: OverviewModuleRow[];
  /** Sorted by extension, so the artifact stays diffable. */
  byExtension: OverviewExtensionRow[];
  summary: {
    /** Modules the snapshot knows — the denominator. */
    censusModules: number;
    /** Modules the overview either named or read. */
    countedModules: number;
    /** Modules a named rule exempts. */
    excludedModules: number;
    /**
     * Modules the overview neither named nor read, that no rule explains. **This is the alarm.** A nonzero
     * value means a document describing the whole project never touched part of it.
     */
    zeroHitModules: number;
    snapshotFiles: number;
    indexedFiles: number;
    namedFiles: number;
    readFiles: number;
    /**
     * Snapshot files CodeGraph did not index. Not a defect on its own — source fallback exists for exactly
     * this — but it bounds how much of the project the graph-derived evidence could ever have named.
     */
    unindexedFiles: number;
  };
}

interface BuildOverviewCensusInput {
  /** Every source file the snapshot scanned, as relative paths. */
  sourcePaths: Iterable<string>;
  /** Paths CodeGraph indexed, normalized without a leading `./`. */
  indexedPaths: Set<string>;
  /** Files named through graph-derived evidence. */
  namedPaths: Iterable<string>;
  /** Files with a recorded source window. */
  readPaths: Iterable<string>;
  /**
   * Module-level exemptions, keyed by module, valued by the NAME of the rule granting them. Empty today; the
   * parameter exists so that adding such a rule forces naming it.
   */
  exemptions?: Record<string, string>;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * The extension of a path, lowercased and including the dot. Read from the BASENAME so a dot in a directory
 * name (`lib/ZMS-1.4/Shop.pm`) cannot be mistaken for one, and `""` for a file that genuinely has none — an
 * extensionless source file must land in a visible bucket rather than being dropped from the grouping.
 */
function extensionOf(path: string): string {
  const name = normalizePath(path).split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** Distinct paths per group — distinct, because the same file arrives from several evidence items. */
function distinctBy(paths: Iterable<string>, key: (path: string) => string): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const path of paths) {
    const normalized = normalizePath(path);
    const bucket = grouped.get(key(normalized)) ?? new Set<string>();
    bucket.add(normalized);
    grouped.set(key(normalized), bucket);
  }
  return grouped;
}

const distinctByModule = (paths: Iterable<string>) => distinctBy(paths, moduleOfPath);
const distinctByExtension = (paths: Iterable<string>) => distinctBy(paths, extensionOf);

/**
 * Build the table. Pure and deterministic: rows sorted by module, counts integral, so the same run produces
 * the same bytes.
 *
 * Modules that appear in the named or read sets but NOT in the snapshot are kept, with `snapshotFiles: 0`.
 * That should not happen — the snapshot is the superset — and dropping them silently would hide a real
 * inconsistency, so the discrepancy is made visible instead.
 */
export function buildOverviewCensus(input: BuildOverviewCensusInput): OverviewCensus {
  const sourceByModule = distinctByModule(input.sourcePaths);
  const namedByModule = distinctByModule(input.namedPaths);
  const readByModule = distinctByModule(input.readPaths);
  const exemptions = input.exemptions ?? {};

  const modules = new Set<string>([...sourceByModule.keys(), ...namedByModule.keys(), ...readByModule.keys()]);
  const totalRead = [...readByModule.values()].reduce((sum, set) => sum + set.size, 0);

  const rows: OverviewModuleRow[] = [...modules]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((module) => {
      const snapshot = sourceByModule.get(module) ?? new Set<string>();
      const named = namedByModule.get(module)?.size ?? 0;
      const read = readByModule.get(module)?.size ?? 0;
      const rule = exemptions[module];
      const status: ModuleScopeStatus = named + read > 0
        ? { kind: "counted" }
        : rule !== undefined ? { kind: "excluded-by-rule", rule } : { kind: "zero-hit" };
      return {
        module,
        snapshotFiles: snapshot.size,
        indexedFiles: [...snapshot].filter((path) => input.indexedPaths.has(path)).length,
        namedFiles: named,
        readFiles: read,
        readShareBp: totalRead === 0 ? 0 : Math.round((read / totalRead) * 10_000),
        status,
      };
    });

  const sourceByExtension = distinctByExtension(input.sourcePaths);
  const namedByExtension = distinctByExtension(input.namedPaths);
  const readByExtension = distinctByExtension(input.readPaths);
  const byExtension: OverviewExtensionRow[] = [...new Set([...sourceByExtension.keys(), ...namedByExtension.keys(), ...readByExtension.keys()])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((extension) => {
      const snapshot = sourceByExtension.get(extension) ?? new Set<string>();
      return {
        extension,
        snapshotFiles: snapshot.size,
        indexedFiles: [...snapshot].filter((path) => input.indexedPaths.has(path)).length,
        namedFiles: namedByExtension.get(extension)?.size ?? 0,
        readFiles: readByExtension.get(extension)?.size ?? 0,
      };
    });

  const snapshotFiles = rows.reduce((sum, row) => sum + row.snapshotFiles, 0);
  const indexedFiles = rows.reduce((sum, row) => sum + row.indexedFiles, 0);
  return {
    version: OVERVIEW_CENSUS_VERSION,
    rows,
    byExtension,
    summary: {
      censusModules: rows.length,
      countedModules: rows.filter((row) => row.status.kind === "counted").length,
      excludedModules: rows.filter((row) => row.status.kind === "excluded-by-rule").length,
      zeroHitModules: rows.filter((row) => row.status.kind === "zero-hit").length,
      snapshotFiles,
      indexedFiles,
      namedFiles: rows.reduce((sum, row) => sum + row.namedFiles, 0),
      readFiles: totalRead,
      unindexedFiles: snapshotFiles - indexedFiles,
    },
  };
}

/**
 * Extensions the snapshot scanned that the overview neither named nor read.
 *
 * On a polyglot or legacy target this is the sharpest statement this accounting can make. "Some files were
 * unindexed" is true of nearly every run — source fallback exists for exactly that — which is why it earns no
 * finding of its own. "An entire language is outside what this overview examined" is a different claim, and
 * for a document that describes the whole project it is a defect the reader must be told about.
 */
export function untouchedExtensions(census: OverviewCensus): OverviewExtensionRow[] {
  return census.byExtension.filter((row) => row.snapshotFiles > 0 && row.namedFiles + row.readFiles === 0);
}

/**
 * The residual identity: every module the snapshot knows is counted, exempted by a named rule, or
 * unexplained. Nothing may fall outside those three — in-toto's trailing `DISALLOW *`, as an assertion over
 * the accounting rather than a gate over the run.
 */
export function overviewCensusResidual(census: OverviewCensus): { balanced: boolean; unexplained: string[] } {
  const { censusModules, countedModules, excludedModules, zeroHitModules } = census.summary;
  return {
    balanced: censusModules === countedModules + excludedModules + zeroHitModules,
    unexplained: census.rows.filter((row) => row.status.kind === "zero-hit").map((row) => row.module),
  };
}
