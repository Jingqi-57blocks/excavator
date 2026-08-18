import { assertNever, type ArtifactResult } from "../base/artifact-result.ts";
import { canonicalJson, sha256 } from "../base/util.ts";
import type { OverviewCensusV2, ScopeCensusV2 } from "./census.ts";
import type { ReadSpecsArtifact } from "./read-specs.ts";

/** This slice pins the view boundary only; step 8 will unify the four storage/content ceilings. */
export const WORKSET_VIEW_MAX_ROWS = 200;

export function renderWorksetView(input: {
  readonly readSpecs: ArtifactResult<ReadSpecsArtifact>;
  readonly overviewCensus: ArtifactResult<OverviewCensusV2>;
  readonly scopeCensuses: ReadonlyMap<string, ArtifactResult<ScopeCensusV2>>;
  readonly maxRows?: number;
}): string {
  const maxRows = input.maxRows ?? WORKSET_VIEW_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error(`Workset view row bound must be a positive integer, got ${maxRows}`);
  const parts = [
    "# Workset view",
    "Deterministic layer-5 model view. Machine artifacts remain audit inputs; this bounded view is the only authoring projection.",
    `Declared bound: at most ${maxRows} detail rows across ReadSpecs and census tables. Every omitted remainder is counted.`,
    renderReadSpecs(input.readSpecs, maxRows)
  ];
  let remaining = maxRows - detailedRows(input.readSpecs, maxRows);
  parts.push(renderOverview(input.overviewCensus, remaining));
  remaining = Math.max(0, remaining - detailedOverviewRows(input.overviewCensus, remaining));
  for (const [featureKey, census] of [...input.scopeCensuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(renderScope(featureKey, census, remaining));
    remaining = Math.max(0, remaining - detailedScopeRows(census, remaining));
  }
  return `${parts.join("\n\n")}\n`;
}

function renderReadSpecs(result: ArtifactResult<ReadSpecsArtifact>, maxRows: number): string {
  const digest = sha256(canonicalJson(result));
  switch (result.status) {
    case "unavailable": return `## Read authorizations\n\nSource digest: \`${digest}\`\n\nUnavailable: ${cell(result.cause)}`;
    case "not-applicable": return `## Read authorizations\n\nSource digest: \`${digest}\`\n\nNot applicable: ${cell(result.determination)}`;
    case "built": {
      const shown = result.value.specs.slice(0, maxRows);
      const lines = [
        "## Read authorizations",
        `Source digest: \`${digest}\``,
        `Rows: ${result.value.specs.length}; requested lines: ${result.value.summary.requestedLines}; candidates: decision ${result.value.summary.decision}, no-decision ${result.value.summary.noDecision}, unavailable ${result.value.summary.unavailable}.`,
        "| Feature | Path and span | Authorized lines | Reason |",
        "|---|---|---:|---|",
        ...shown.map((row) => `| ${cell(row.featureKey)} | \`${cell(row.path)}:${row.span.startLine}-${row.span.endLine}\` | ${row.budget.requestedLines} | ${cell(row.reason)} |`)
      ];
      if (shown.length < result.value.specs.length) lines.push(`\nOmitted by the declared view bound: ${result.value.specs.length - shown.length} ReadSpec row(s).`);
      return lines.join("\n");
    }
    default: return assertNever(result, "ReadSpec view result");
  }
}

function renderOverview(result: ArtifactResult<OverviewCensusV2>, maxRows: number): string {
  const digest = sha256(canonicalJson(result));
  switch (result.status) {
    case "unavailable": return `## Overview census\n\nSource digest: \`${digest}\`\n\nUnavailable: ${cell(result.cause)}`;
    case "not-applicable": return `## Overview census\n\nSource digest: \`${digest}\`\n\nNot applicable: ${cell(result.determination)}`;
    case "built": {
      const shown = result.value.rows.slice(0, maxRows);
      const lines = [
        "## Overview census",
        `Source digest: \`${digest}\``,
        `File candidates: total ${result.value.summary.total}, counted ${result.value.summary.counted}, excluded ${result.value.summary.excluded}, unexplained ${result.value.summary.unexplained}.`,
        "| Module | Language | Total | Counted | Excluded | Unexplained |",
        "|---|---|---:|---:|---:|---:|",
        ...shown.map((row) => `| ${cell(row.module)} | ${cell(row.language)} | ${row.totals.total} | ${row.totals.counted} | ${row.totals.excluded} | ${row.totals.unexplained} |`)
      ];
      if (shown.length < result.value.rows.length) lines.push(`\nOmitted by the declared view bound: ${result.value.rows.length - shown.length} overview census row(s).`);
      return lines.join("\n");
    }
    default: return assertNever(result, "overview census view result");
  }
}

function renderScope(featureKey: string, result: ArtifactResult<ScopeCensusV2>, maxRows: number): string {
  const digest = sha256(canonicalJson(result));
  switch (result.status) {
    case "unavailable": return `## Scope census — ${cell(featureKey)}\n\nSource digest: \`${digest}\`\n\nUnavailable: ${cell(result.cause)}`;
    case "not-applicable": return `## Scope census — ${cell(featureKey)}\n\nSource digest: \`${digest}\`\n\nNot applicable: ${cell(result.determination)}`;
    case "built": {
      const shown = result.value.rows.slice(0, maxRows);
      const coverage = result.value.summary.coverage;
      const selection = result.value.summary.selection;
      const lines = [
        `## Scope census — ${cell(featureKey)}`,
        `Source digest: \`${digest}\``,
        `File coverage: ${coverage.total}=${coverage.counted}+${coverage.excluded}+${coverage.unexplained}. Partition selection: ${selection ? `${selection.counted}=${selection.seated}+${selection.zeroScore}+${selection.displaced}` : "unavailable"}. Census-unavailable rows: ${result.value.summary.unavailableRows}.`,
        "| Module / language | File coverage (total=counted+excluded+unexplained) | Partition selection (counted=seated+zero-score+displaced) |",
        "|---|---|---|"
      ];
      for (const row of shown) {
        if (row.kind === "census-unavailable") {
          lines.push(`| ${cell(row.featureKey)} | census-unavailable: ${cell(row.cause)} | — |`);
          continue;
        }
        lines.push(`| ${cell(row.module)} / ${cell(row.language)} | ${row.coverage.totals.total}=${row.coverage.totals.counted}+${row.coverage.totals.excluded}+${row.coverage.totals.unexplained} | ${row.selection.totals.counted}=${row.selection.totals.seated}+${row.selection.totals.zeroScore}+${row.selection.totals.displaced} |`);
      }
      if (shown.length < result.value.rows.length) lines.push(`\nOmitted by the declared view bound: ${result.value.rows.length - shown.length} scope census row(s).`);
      return lines.join("\n");
    }
    default: return assertNever(result, "scope census view result");
  }
}

function detailedRows(result: ArtifactResult<ReadSpecsArtifact>, cap: number): number { return result.status === "built" ? Math.min(cap, result.value.specs.length) : 0; }
function detailedOverviewRows(result: ArtifactResult<OverviewCensusV2>, cap: number): number { return result.status === "built" ? Math.min(cap, result.value.rows.length) : 0; }
function detailedScopeRows(result: ArtifactResult<ScopeCensusV2>, cap: number): number { return result.status === "built" ? Math.min(cap, result.value.rows.length) : 0; }
function cell(value: string): string { return value.replace(/\s+/g, " ").trim().replaceAll("|", "\\|"); }
