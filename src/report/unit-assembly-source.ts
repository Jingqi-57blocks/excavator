/**
 * WHAT UNIT ASSEMBLY IS ASSEMBLED FROM: the validated plan, the collect-written ledger, and the bytes those rows
 * vouch for. Nothing here decides how a document reads, and nothing here recomputes a coverage number.
 *
 * IT DOES NOT DO PARTIAL ASSEMBLY. A document is assembled only when every unit its plan holds has a ledger row
 * FOR THIS EPOCH AND THIS PLAN. The two ways that can fail get two different sentences, because they have two
 * different fixes: a unit that was never collected has to be drafted, and a unit collected against a superseded
 * plan has to be re-drafted against the recorded one. Merging them into "not collected" would tell an operator who
 * just revised a plan to go looking for work they already did. Both name every offending unit id, and neither
 * leaves a run in a state a re-collect cannot clear.
 *
 * THE LEDGER'S PROMISE IS RE-CHECKED, THROUGH THE ONE CHECK. `promisedArtifactProblems` is the same comparison
 * `collect` runs against a receipt and `unit-cache-admit` runs against a ledger row; a second spelling of "still
 * the verified bytes" here would be a second definition, and assembly would end up shipping whichever was looser.
 * Only the noun changes: the record that made the promise is the ledger row.
 *
 * THE COVERAGE COMPANION IS PLACED, NOT RECOMPUTED. `loadCoverageStateFacts` + `renderCoverageCompanion` are R7a's
 * single derivation and single rendering; this file calls them and writes what they return. Deriving any coverage
 * figure here would be a second denominator, which is the one thing gate 1b forbids one level up. It costs a second
 * pass through the plan gate — the same bytes, re-validated — and that is the price of not reaching inside R7a.
 *
 * IT GATES ON NOTHING THE COVERAGE STATEMENTS SAY. A statement's arm (`complete` / `vacuous` / `violations`) is a
 * WORDING rule, and `violations` covers legitimate, counted exits — a plan waiving a topic for an audience, a
 * recorded read ceiling — as well as defects. Refusing to assemble because a statement is in that arm would turn a
 * wording union into a defect gate, and would make a run that honestly reported a residue unshippable. Assembly's
 * own gates are the ones above: every unit collected, every promise still true, no path shared with the section
 * path.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunManifest, TraceCatalog } from "../base/types.ts";
import { readJson } from "../base/util.ts";
import { sectionCompanionRelativePaths } from "./assurance-artifacts.ts";
import { reportFileName } from "./authoring-plan.ts";
import { renderCoverageCompanion } from "./coverage-companion.ts";
import { loadCoverageStateFacts } from "./coverage-companion-source.ts";
import type { PlanCatalogUnit } from "./plan-artifacts.ts";
import { describePromisedArtifactProblem, promisedArtifactProblems, type PromiseSubject } from "./unit-artifact-promise.ts";
import {
  assemblyUnitsInOrder,
  renderUnitDocument,
  type AssemblyIdentity,
  type AssemblyUnit,
  type UnitDocumentAssembly
} from "./unit-assembly.ts";
import {
  assertNoSectionPathConflict,
  UNIT_COVERAGE_COMPANION_PATH,
  unitDocumentCompanionPaths,
  unitDocumentReportPath,
  type SectionReportTarget,
  type UnitAssemblyTarget
} from "./unit-assembly-paths.ts";
import {
  aggregateUnitClaims,
  aggregateUnitTraces,
  unitClaimKey,
  type UnitClaimsCompanion,
  type UnitClaimsSource,
  type UnitTracesCompanion
} from "./unit-companions.ts";
import { collectedUnitsFor, readUnitLedger, type CollectedUnit } from "./unit-ledger.ts";
import { parseUnitClaims } from "./unit-output.ts";
import { compareUnitIds, unitPaths } from "./unit-paths.ts";
import { assertPlanEpoch, loadUnitPlanView, requireKnowledgeEpoch, type UnitPlanView } from "./unit-plan-view.ts";

/** One document's assembled bytes and the two companions it owns, all run-relative. */
export interface AssembledUnitDocument {
  readonly documentId: string;
  readonly path: string;
  readonly markdown: string;
  readonly units: readonly string[];
  readonly claims: { readonly path: string; readonly companion: UnitClaimsCompanion };
  readonly traces: { readonly path: string; readonly companion: UnitTracesCompanion };
}

/** Everything one run assembles, as values. The writer turns these into files and nothing else. */
export interface UnitAssembly {
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  readonly documents: readonly AssembledUnitDocument[];
  readonly coverage: { readonly path: string; readonly markdown: string };
  /** Every run-relative path this load opened, sorted. A caller republishes it rather than re-deriving it. */
  readonly readPaths: readonly string[];
}

/** Load one run's unit-path assembly. Every refusal is named, and none leaves the run in an unclearable state. */
export async function loadUnitAssembly(runDirInput: string): Promise<UnitAssembly> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const knowledgeEpoch = requireKnowledgeEpoch(manifest, "assembled");
  const view = await loadUnitPlanView(runDir, manifest);
  assertPlanEpoch(view, knowledgeEpoch);

  const readPaths = new Set<string>([
    "run.json", "plan/requests.json", "plan/topics.json", "plan/catalog.json", "plan/dag.json",
    "traces.json", "units/collected.json", ...view.sourceReadPaths
  ]);

  const ledger = await readUnitLedger(runDir, manifest.id);
  const current = new Map(collectedUnitsFor(ledger, knowledgeEpoch, view.planCatalogDigest).map((row) => [row.unitId, row]));
  const anyEpoch = new Map(ledger.units.map((row) => [row.unitId, row]));
  assertEveryPlannedUnitCollected(view, current, anyEpoch, knowledgeEpoch);

  const traces = await readJson<TraceCatalog>(join(runDir, "traces.json"));
  const parents = parentUnitIds(view);
  const identity: AssemblyIdentity = {
    runId: view.runId,
    knowledgeEpoch,
    knowledgeDigest: view.planCatalog.knowledgeDigest,
    planCatalogDigest: view.planCatalogDigest,
    planRevision: view.planCatalog.planRevision,
    sourceText: manifest.request.redactSecrets === true ? "redacted" : "verbatim"
  };

  if (view.planCatalog.documents.length === 0) {
    throw new Error(`Run ${JSON.stringify(view.runId)} has a validated plan holding no document, so there is nothing to assemble; a successful assemble over zero documents would report the same thing as a successful one over every document`);
  }
  const documents: AssembledUnitDocument[] = [];
  const targets: UnitAssemblyTarget[] = [];
  for (const document of view.planCatalog.documents) {
    const planned = assemblyUnitsInOrder(
      document.documentId,
      view.units.filter((unit) => unit.documentId === document.documentId),
      view.collectionOrder
    );
    const request = view.requests.requests.find((record) => record.documentId === document.documentId);
    if (!request) {
      throw new Error(`Document ${JSON.stringify(document.documentId)} has a recorded plan but no recorded request row; a document is assembled under the request it was planned for`);
    }
    const units: AssemblyUnit[] = [];
    const claimSources: UnitClaimsSource[] = [];
    for (const unit of planned) {
      const row = current.get(unit.unitId)!;
      const paths = unitPaths(runDir, unit.unitId);
      await assertLedgerPromise(unit.unitId, row, paths);
      readPaths.add(`units/${paths.key}/content.md`);
      readPaths.add(`units/${paths.key}/claims.json`);
      readPaths.add(`units/${paths.key}/summary.json`);
      const parsed = parseUnitClaims(await readJson<unknown>(paths.claims));
      if (parsed.claims === null) {
        throw new Error(`${paths.claims} is not a valid unit claims sidecar for ${JSON.stringify(unit.unitId)}: ${parsed.problems.join("; ")}`);
      }
      units.push({
        unitId: unit.unitId,
        kind: unit.kind,
        title: unit.title,
        parentUnitId: parents.get(unit.unitId) ?? null,
        content: await readFile(paths.content, "utf8")
      });
      claimSources.push({ unitId: unit.unitId, kind: unit.kind, claims: parsed.claims.claims });
    }

    const companions = unitDocumentCompanionPaths(document.documentId);
    const aggregation = {
      runId: view.runId,
      documentId: document.documentId,
      knowledgeEpoch,
      planCatalogDigest: view.planCatalogDigest,
      units: claimSources
    };
    const assembly: UnitDocumentAssembly = {
      documentId: document.documentId,
      title: rootUnitTitle(view, document.documentId, document.rootUnitId),
      identity,
      request,
      companions,
      units
    };
    const path = unitDocumentReportPath(document.documentId);
    documents.push({
      documentId: document.documentId,
      path,
      markdown: renderUnitDocument(assembly),
      units: units.map((unit) => unit.unitId),
      claims: { path: companions.claims, companion: aggregateUnitClaims(aggregation, unitClaimKey) },
      traces: { path: companions.traces, companion: aggregateUnitTraces({ ...aggregation, traces: traces.traces }) }
    });
    for (const target of [path, companions.claims, companions.traces]) {
      targets.push({ documentId: document.documentId, path: target });
    }
  }

  assertNoSectionPathConflict(targets, sectionReportTargets(manifest));

  const coverage = await loadCoverageStateFacts(runDir);
  for (const path of coverage.readPaths) readPaths.add(path);
  return {
    runId: view.runId,
    knowledgeEpoch,
    planCatalogDigest: view.planCatalogDigest,
    documents,
    coverage: { path: UNIT_COVERAGE_COMPANION_PATH, markdown: renderCoverageCompanion(coverage.facts) },
    readPaths: [...readPaths].sort(compareUnitIds)
  };
}

/**
 * Every planned unit of every document has a ledger row for THIS epoch and THIS plan, or a named refusal.
 *
 * Two buckets, two sentences, one throw: an operator who revised a plan and an operator who has not finished
 * drafting need different instructions, and a run in both states should hear both facts at once.
 */
function assertEveryPlannedUnitCollected(
  view: UnitPlanView,
  current: ReadonlyMap<string, CollectedUnit>,
  anyEpoch: ReadonlyMap<string, CollectedUnit>,
  knowledgeEpoch: number
): void {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const unitId of view.collectionOrder) {
    if (current.has(unitId)) continue;
    const row = anyEpoch.get(unitId);
    if (row) stale.push(`${unitId} (collected at epoch ${row.knowledgeEpoch} against plan ${row.planCatalogDigest.slice(0, 16)})`);
    else missing.push(unitId);
  }
  if (missing.length === 0 && stale.length === 0) return;
  const sentences: string[] = [];
  if (missing.length > 0) {
    sentences.push(`${missing.length} unit(s) of this plan have not been collected: ${missing.sort(compareUnitIds).join(", ")}`);
  }
  if (stale.length > 0) {
    sentences.push(`${stale.length} unit(s) are collected against a superseded plan or epoch and must be re-drafted against the recorded plan ${view.planCatalogDigest.slice(0, 16)} at epoch ${knowledgeEpoch}: ${stale.sort(compareUnitIds).join(", ")}`);
  }
  throw new Error(`This run cannot be assembled on the unit path; assembly is all-or-nothing per run, and ${sentences.join("; ")}. Collect the named units and run assemble again.`);
}

/** The ledger row's promise, re-checked through the one comparison. */
async function assertLedgerPromise(unitId: string, row: CollectedUnit, paths: { content: string; claims: string; summary: string }): Promise<void> {
  const problems = await promisedArtifactProblems(paths, row);
  if (problems.length === 0) return;
  const subject: PromiseSubject = { unitId, record: "The unit ledger row", possessive: "its ledger row" };
  throw new Error(`${problems.map((problem) => describePromisedArtifactProblem(subject, problem)).join("; ")}. Re-collect the unit before assembling; its ledger row is left in place.`);
}

/** Child → parent, from the recorded DAG's edges. One edge set, no second derivation of the tree. */
function parentUnitIds(view: UnitPlanView): ReadonlyMap<string, string> {
  const parents = new Map<string, string>();
  for (const edge of view.dag.edges) parents.set(edge.childUnitId, edge.parentUnitId);
  return parents;
}

/** The document's title: the plan's title for its root unit. A root the plan does not hold is a named refusal. */
function rootUnitTitle(view: UnitPlanView, documentId: string, rootUnitId: string): string {
  const root: PlanCatalogUnit | undefined = view.byId.get(rootUnitId);
  if (!root) {
    throw new Error(`Document ${JSON.stringify(documentId)} records root unit ${JSON.stringify(rootUnitId)}, which this plan's unit list does not hold`);
  }
  return root.title;
}

/** Every run-relative path the SECTION path names for this run: one report plus three companions per document. */
function sectionReportTargets(manifest: RunManifest): readonly SectionReportTarget[] {
  return manifest.documents.flatMap((document) => {
    const companions = sectionCompanionRelativePaths(document.id);
    return [`reports/${reportFileName(document)}`, companions.claims, companions.traces, companions.coverage]
      .map((path) => ({ documentId: document.id, path }));
  });
}
