/**
 * What the coverage companion is derived FROM: the validated plan view, and nothing this file recounts.
 *
 * ONE DERIVATION, AND EXACTLY ONE FIELD BETWEEN THE TWO CONSUMERS. The appendix packet's coverage block and the
 * standalone companion share the epoch-only families byte for byte; the only input that differs is the unit-stated
 * unknowns, and that difference is forced rather than chosen:
 *
 *   A UNIT PACKET'S COVERAGE BLOCK MUST NOT DEPEND ON WHAT SIBLING UNITS HAVE BEEN COLLECTED. The packet's bytes
 *   ARE the unit's cache identity (R6a), so if the appendix block quoted the unknowns other units had stated, then
 *   drafting any unit of a document would move the appendix's identity and force it to be rewritten — which is
 *   exactly the "identity must be LOCAL to a unit" requirement R6a's normalization list exists to satisfy, and
 *   would undo the reuse R6b/R6d demonstrated. So the packet arm passes the named-absence reading, saying WHY, and
 *   the companion command — which is not inside any byte budget and is not a cache key — reads the ledger.
 *
 * Everything else comes from the view, which means from bytes the plan gate already re-validated and digest-checked
 * against the sealed epoch. This file opens exactly one file of its own, and only on the companion path.
 */

import { join, resolve } from "node:path";
import type { RunManifest } from "../base/types.ts";
import { exists, readJson } from "../base/util.ts";
import { COVERAGE_COMPANION_VERSION, type CollectedUnknownsReading, type CoverageStateFacts } from "./coverage-companion.ts";
import { UNIT_LEDGER_RELATIVE_PATH, projectDocumentCoverage, projectTopicCoverage } from "./coverage-projection.ts";
import { collectedUnitsFor, readUnitLedger } from "./unit-ledger.ts";
import { parseUnitSummary, unitSummaryDigest } from "./unit-output.ts";
import { compareUnitIds } from "./unit-paths.ts";
import { unitPaths } from "./unit-paths.ts";
import { assertPlanEpoch, loadUnitPlanView, requireKnowledgeEpoch, type UnitPlanView } from "./unit-plan-view.ts";

/**
 * The coverage facts for the companion command: the same ledgers plus the unit summaries a row vouches for.
 *
 * A summary whose bytes no longer digest to what the ledger recorded is a named refusal, not a silently stale
 * unknown: the whole point of reporting unit-stated unknowns is that they are what the written document says.
 */
export async function loadCoverageStateFacts(runDirInput: string): Promise<{ readonly facts: CoverageStateFacts; readonly readPaths: readonly string[] }> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const knowledgeEpoch = requireKnowledgeEpoch(manifest, "given a coverage companion");
  const view = await loadUnitPlanView(runDir, manifest);
  assertPlanEpoch(view, knowledgeEpoch);
  const readPaths = ["run.json", "plan/requests.json", "plan/topics.json", "plan/catalog.json", "plan/dag.json", ...view.sourceReadPaths];

  // A LEDGER THAT IS NOT THERE IS `ledger-absent`, NOT A PRESENT EMPTY ONE. `readUnitLedger` returns a synthetic
  // empty ledger for a missing file, which is the right answer for `collect` and the wrong one here: reported as
  // `present` it would say "units/collected.json is present and records no collected unit" about a file that does
  // not exist, and would publish a path this load never opened — 57B-449's conflation, one level up.
  if (!await exists(join(runDir, UNIT_LEDGER_RELATIVE_PATH))) {
    return {
      facts: coverageFacts(view, {
        state: "absent",
        ledger: UNIT_LEDGER_RELATIVE_PATH,
        reason: `${UNIT_LEDGER_RELATIVE_PATH} is absent from this run, so no unit has been collected under any plan and nothing vouches for a summary yet`
      }),
      readPaths: [...new Set(readPaths)].sort(ascending)
    };
  }
  readPaths.push(UNIT_LEDGER_RELATIVE_PATH);

  const ledger = await readUnitLedger(runDir, manifest.id);
  const collected = [...collectedUnitsFor(ledger, knowledgeEpoch, view.planCatalogDigest)].sort((a, b) => compareUnitIds(a.unitId, b.unitId));
  const units: { readonly unitId: string; readonly unknowns: readonly string[] }[] = [];
  for (const row of collected) {
    const paths = unitPaths(runDir, row.unitId);
    readPaths.push(`units/${paths.key}/summary.json`);
    const parsed = parseUnitSummary(await readJson<unknown>(paths.summary));
    if (parsed.summary === null) throw new Error(`${paths.summary} is not a valid unit summary: ${parsed.problems.join("; ")}`);
    const digest = unitSummaryDigest(parsed.summary);
    if (digest !== row.summaryDigest) {
      throw new Error(`Unit ${JSON.stringify(row.unitId)} has a summary digesting to ${digest} but the unit ledger recorded ${row.summaryDigest}; re-collect it before reporting the unknowns it states`);
    }
    units.push({ unitId: row.unitId, unknowns: parsed.summary.unknowns });
  }

  return {
    facts: coverageFacts(view, { state: "present", ledger: UNIT_LEDGER_RELATIVE_PATH, collectedUnits: collected.length, units }),
    readPaths: [...new Set(readPaths)].sort(ascending)
  };
}

/** One total ordering for the published path list. */
function ascending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The one assembly. Every number is a field selection over the view; nothing is recounted.
 *
 * The epoch-only half is the plan view's own `epochCoverage` — the same value the packet loader and the plan-time
 * measure are handed — and the two plan/catalog-dependent families are added here, where nothing is a cache key.
 */
function coverageFacts(view: UnitPlanView, statedUnknowns: CollectedUnknownsReading): CoverageStateFacts {
  return {
    version: COVERAGE_COMPANION_VERSION,
    runId: view.runId,
    knowledgeEpoch: view.knowledgeEpoch,
    knowledgeDigest: view.planCatalog.knowledgeDigest,
    planCatalogDigest: view.planCatalogDigest,
    material: {
      // READ from the recorded plan, never recomputed: `assertReachMatchesAccounting` already checks that the
      // recorded buckets agree with the shared index, and a second derivation here would be a second denominator.
      accounting: view.planCatalog.obligationAccounting,
      documents: projectDocumentCoverage(view.ownership.documents, view.workItems)
    },
    topics: projectTopicCoverage(view.catalog),
    // The epoch-only half comes from the view's single projection; only `statedUnknowns` is replaced, and that
    // one field is the only thing a companion may know that a packet may not.
    ...view.epochCoverage,
    statedUnknowns
  };
}
