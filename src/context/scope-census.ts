import type { GraphSummary } from "../codegraph/codegraph.ts";

/**
 * WHICH MODULES GOT HOW MUCH OF THE SCOPE — the reading that makes "an entire module was never looked at"
 * visible inside the run instead of after the fact.
 *
 * A real run recorded ZERO nodes from an entire frontend repository, and nothing in the artifacts said so:
 * the read-obligation denominator is derived from the feature's own boundary, so a module absent from the
 * boundary contributes to no bucket at all — it is neither covered nor missing, it simply is not counted.
 * `read-obligations.ts` states that ceiling honestly in its own header; this table is the layer below it.
 *
 * THE ROW SET COMES FROM THE CENSUS, NOT FROM THE POOL. That is the whole point and the easiest thing to get
 * wrong: a table built by walking the candidate pool can only ever list modules that made it into the pool,
 * so the one fact worth reporting — that a module contributed nothing — is the one it structurally cannot
 * express. Two external systems converge on this. lcov's `--initial` builds a zero-coverage baseline of the
 * whole instrumented set from structure and merges observation into it, which its own manual says is what
 * makes the percentage correct "even when not all source code files were loaded". deepwiki-open shows the
 * failure mode: its planning view and its index view share one file iterator, but they share it AFTER the
 * filter, so the planner never learns that the excluded directories exist and one over-broad config setting
 * becomes a permanent structural blind spot in the output.
 *
 * TWO STATES, NEVER ONE. A module that contributed nothing is either exempted by a NAMED rule or explained
 * by nobody, and those are different accountability facts. Every coverage tool surveyed flattens them:
 * coverage.py touches un-executed files so they report as 0%, but the report cannot distinguish that from a
 * file that was loaded and had every line miss; JaCoCo's analyzer knows the difference internally
 * (`noMatch`) and its XML writer drops it. in-toto is the one design that keeps them apart — artifact rules
 * consume the queue and a trailing `DISALLOW *` fails verification on anything no rule explained. Our
 * obligation layer already does this at function granularity (`ObligationExclusion` carries a reason and
 * stays visible in the artifact); module granularity is what was missing.
 */
export const SCOPE_CENSUS_VERSION = "scope-census-v1";

/**
 * Why no per-module accounting exists for a feature, and WHICH cause. Written as an artifact of its own
 * rather than by
 * omitting the file, because "there is no table" and "the table says everything is accounted for" must not
 * look the same on disk — which is precisely the flattening this whole module argues against, and which the
 * first version of it committed by writing nothing on source-fallback runs.
 */
export interface ScopeCensusUnavailable {
  version: string;
  reason: "no-graph" | "empty-vocabulary";
  detail: string;
}

const UNAVAILABLE_DETAIL: Record<ScopeCensusUnavailable["reason"], string> = {
  "no-graph": "This feature was analysed without a CodeGraph index, so there is no module census to account against.",
  "empty-vocabulary": "This feature's subject and aliases tokenised to nothing, so no graph search ran and no module census was built.",
};

/**
 * Two reasons, not one. Review caught the first version labelling both as `no-graph`: the census is built
 * under `graph && terms.length`, so a feature whose vocabulary tokenises to nothing took the same label as a
 * run with no index at all. The record stayed visible either way — it was never a fourth state — but a
 * reason that names the wrong cause is a reason someone will act on wrongly.
 */
export function scopeCensusUnavailable(reason: ScopeCensusUnavailable["reason"] = "no-graph"): ScopeCensusUnavailable {
  return {
    version: SCOPE_CENSUS_VERSION,
    reason,
    detail: `${UNAVAILABLE_DETAIL[reason]} Absence of module accounting is not evidence that every module was covered.`,
  };
}

/**
 * Why a module holds no scope. `zero-hit` is the honest default — it means NOBODY explained the absence,
 * and it is deliberately not a synonym for "fine". A named rule must announce itself: the `rule` field is
 * required on `excluded-by-rule`, so a future module-level exclusion cannot be added silently and land in
 * the same bucket as an unexplained gap.
 */
export type ModuleScopeStatus =
  | { kind: "counted" }
  | { kind: "zero-hit" }
  | { kind: "excluded-by-rule"; rule: string };

export interface ModuleScopeRow {
  /** Module identity as the graph census reports it, so the row survives a module holding nothing. */
  module: string;
  /** Files the census knows in this module — the zero baseline, independent of this feature's scope. */
  censusFiles: number;
  /** Nodes the census knows in this module. */
  censusNodes: number;
  /** Nodes this module contributed to the candidate pool before the budget was applied. */
  poolNodes: number;
  /** Nodes of this module that survived the budget into the feature graph. */
  retainedNodes: number;
  /** Share of the retained scope this module holds, in basis points (integer — floats are not byte-stable). */
  retainedShareBp: number;
  status: ModuleScopeStatus;
}

export interface ScopeCensus {
  version: string;
  rows: ModuleScopeRow[];
  summary: {
    /** Modules the census knows — the denominator. */
    censusModules: number;
    /** Modules holding at least one retained node — the numerator that percentages are usually built on. */
    countedModules: number;
    /** Modules explained by a named rule. */
    excludedModules: number;
    /**
     * Modules holding nothing that no rule explains. **This is the alarm.** A nonzero value means the
     * investigation's scope silently omitted a whole module, and every per-module percentage in the run is
     * a conditional reading rather than a coverage figure.
     */
    zeroHitModules: number;
    /** Retained nodes across all modules, so a reader can check the shares add up. */
    retainedNodes: number;
  };
}

/** A node reduced to the two fields this accounting needs. */
export interface CensusNode {
  filePath: string;
}

interface BuildScopeCensusInput {
  /** The graph census — MUST enumerate every indexed module, including ones this feature never touched. */
  roots: GraphSummary["roots"];
  /** The candidate pool, before the node budget was applied. */
  pool: CensusNode[];
  /** The nodes that survived into the feature graph. */
  retained: CensusNode[];
  /**
   * Module-level exemptions, keyed by module, valued by the NAME of the rule granting them. Empty today:
   * no module-level exclusion rule exists, so every module holding nothing reads as `zero-hit`, which is
   * the honest answer. The parameter exists so that adding such a rule forces naming it.
   */
  exemptions?: Record<string, string>;
}

/**
 * The module a FILE PATH belongs to: its first segment, or `"."` when it has none.
 *
 * The `"."` matters and is not cosmetic. The census computes roots in SQL as
 * `CASE WHEN instr(path,'/') > 0 THEN substr(...) ELSE '.' END`, so a top-level `main.go` is reported under
 * root `"."`. Returning `"main.go"` here instead would put the two sides in different key domains, and on
 * any target with top-level source files — `index.js`, `main.go`, entirely ordinary — the table would grow a
 * false `.` row reading as an unexplained module plus one bogus zero-census row per top-level file. Aligning
 * with the SQL convention is what keeps the join honest.
 *
 * Exported so `overview-census.ts` derives module identity from this rule rather than its own copy. Two
 * copies of a canonicalization drift, and a drifted module key would silently split one module across two
 * rows in one artifact and not the other.
 */
export function moduleOfPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const cut = normalized.indexOf("/");
  return cut === -1 ? "." : normalized.slice(0, cut);
}

/**
 * The module a CENSUS ROOT LABEL denotes. A separate domain from file paths: `CodeGraphSet` prefixes each
 * member's roots with its module directory, so a root-module label arrives as `service-a/.` and must fold
 * back to `service-a`, while a bare `.` from a single-database target is already the module.
 */
function moduleOfRoot(root: string): string {
  const normalized = root.replaceAll("\\", "/").replace(/^\.\//, "");
  const cut = normalized.indexOf("/");
  return cut === -1 ? normalized : normalized.slice(0, cut);
}

function countByModule(nodes: CensusNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const key = moduleOfPath(node.filePath);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Build the table. Pure and deterministic: a function of (census, pool, retained, exemptions) with rows in
 * a fixed order, so the same run produces the same bytes.
 *
 * Modules appearing in the pool but NOT in the census are added as rows too. That should not happen — the
 * census is supposed to be the superset — and silently dropping them would be exactly the fourth state this
 * accounting exists to forbid, so they are surfaced with zero census counts where the discrepancy is
 * visible rather than hidden.
 */
export function buildScopeCensus(input: BuildScopeCensusInput): ScopeCensus {
  const poolCounts = countByModule(input.pool);
  const retainedCounts = countByModule(input.retained);
  const exemptions = input.exemptions ?? {};

  const censusByModule = new Map<string, { files: number; nodes: number }>();
  for (const root of input.roots) {
    const key = moduleOfRoot(root.root);
    const prior = censusByModule.get(key) ?? { files: 0, nodes: 0 };
    censusByModule.set(key, { files: prior.files + root.files, nodes: prior.nodes + root.nodes });
  }
  // A module that produced nodes but is missing from the census: keep it, with zeroes, so the mismatch shows.
  for (const key of [...poolCounts.keys(), ...retainedCounts.keys()]) {
    if (!censusByModule.has(key)) censusByModule.set(key, { files: 0, nodes: 0 });
  }

  const totalRetained = [...retainedCounts.values()].reduce((sum, value) => sum + value, 0);
  const rows: ModuleScopeRow[] = [...censusByModule.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([module, census]) => {
      const retainedNodes = retainedCounts.get(module) ?? 0;
      const rule = exemptions[module];
      const status: ModuleScopeStatus = retainedNodes > 0
        ? { kind: "counted" }
        : rule !== undefined ? { kind: "excluded-by-rule", rule } : { kind: "zero-hit" };
      return {
        module,
        censusFiles: census.files,
        censusNodes: census.nodes,
        poolNodes: poolCounts.get(module) ?? 0,
        retainedNodes,
        // Basis points, integer-rounded: a float share would not survive a byte-for-byte artifact comparison.
        retainedShareBp: totalRetained === 0 ? 0 : Math.round((retainedNodes / totalRetained) * 10_000),
        status,
      };
    });

  return {
    version: SCOPE_CENSUS_VERSION,
    rows,
    summary: {
      censusModules: rows.length,
      countedModules: rows.filter((row) => row.status.kind === "counted").length,
      excludedModules: rows.filter((row) => row.status.kind === "excluded-by-rule").length,
      zeroHitModules: rows.filter((row) => row.status.kind === "zero-hit").length,
      retainedNodes: totalRetained,
    },
  };
}

/**
 * The residual identity: every module the census knows is counted, exempted by a named rule, or unexplained.
 * Nothing may fall outside those three.
 *
 * This is in-toto's trailing `DISALLOW *` in the only form that is honest today — an assertion over the
 * accounting rather than a gate over the run. `zeroHitModules > 0` is a real finding, but it is reported as
 * an advisory first: the reading has to be collected across real runs before it can be hardened into a gate,
 * which is the same "measure before you enforce" order every previous denominator change followed.
 */
export function scopeCensusResidual(census: ScopeCensus): { balanced: boolean; unexplained: string[] } {
  const { censusModules, countedModules, excludedModules, zeroHitModules } = census.summary;
  return {
    balanced: censusModules === countedModules + excludedModules + zeroHitModules,
    unexplained: census.rows.filter((row) => row.status.kind === "zero-hit").map((row) => row.module),
  };
}
