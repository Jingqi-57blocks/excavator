/**
 * WHAT THE CONSISTENCY CHECKER IS RUN OVER: one run's validated plan, its collected units, and the deliverable
 * that was assembled from them. Read-only from end to end — this file opens files and writes none.
 *
 * IT RUNS AFTER ASSEMBLE, AND THAT IS A CHECKED PRECONDITION RATHER THAN AN ASSUMPTION. The dangling-reference
 * class resolves references against the ASSEMBLED DOCUMENT, so a run whose deliverable is absent, or whose
 * deliverable is not the one this plan and these collected units produce, cannot be checked: every anchor answer
 * would be about bytes nobody is shipping. So EVERY assembled artifact on disk — each document, each document's
 * claims and traces companions, and the run's coverage companion — is compared against the bytes
 * `loadUnitAssembly` derives, and a difference is a named refusal that says to re-assemble.
 *
 * THE FIVE PRECONDITIONS ARE NAMED, WITH THEIR AUTHORITY, and three of them are INHERITED rather than restated.
 * The board this checker reads has to be the board the run recorded, and every way it could have drifted after
 * collect is closed — but two of the closures already exist and re-implementing them would be two definitions:
 *
 *   1. `plan-in-force` (inherited, plan gate) — the recorded plan re-validates against the sealed epoch on every
 *      load: topic dispositions readable, obligation accounting conserving, ownership conserving with one owner per
 *      obligation, one parent per child. A hand-edited `plan/catalog.json` is refused there.
 *   2. `every-unit-collected` (inherited, `loadUnitAssembly`) — no partial assembly, so no partial check.
 *   3. `ledger-promise-intact` (inherited, `promisedArtifactProblems`) — each unit's content, claims and summary
 *      still digest to what its ledger row promised. THIS is the tripwire for a hand-edited summary byte.
 *   4. `assembled-deliverable-current` (asserted here) — every assembled artifact on disk (each document, its two
 *      companions, and the run's coverage companion) is the bytes the plan and the collected units produce.
 *   5. `child-summary-digests-current` (asserted here) — every synthesis's recorded `childSummaryDigests` equal
 *      the digests of its children's summaries as they are on disk NOW. Nothing re-checks this after collect: the
 *      promise check compares each unit against its OWN row, so a child re-drafted and re-collected without its
 *      parent leaves the parent's recorded digests pointing at a summary that no longer exists.
 *
 * IT DERIVES NO SEMANTICS OF ITS OWN. The coverage statements come from R7a through the assembly value, the plan
 * comes from the plan gate through the same value, and the claims come from the claims companion that assembly
 * already aggregated. The only thing this file reads that assembly does not hand over is each unit's PARSED
 * summary, because assembly only ever needed its digest.
 *
 * PARSE FAILURE IS FATAL. A summary that does not parse is a named refusal naming the file, never an empty
 * terminology list that would make the drift class report "nothing to compare".
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SectionClaim } from "../base/types.ts";
import { exists, readJson } from "../base/util.ts";
import type { Requirements } from "../contract/bound-run-contract.ts";
import { lensPolicyFor } from "./report-policy-registry.ts";
import { assembledJsonBytes } from "./unit-assembly.ts";
import { runRelativePath } from "./unit-assembly-paths.ts";
import { loadUnitAssembly, type AssembledUnitDocument, type UnitAssembly } from "./unit-assembly-source.ts";
import {
  checkUnitConsistency,
  type ConsistencyDocument,
  type ConsistencyResult,
  type ConsistencyUnit
} from "./unit-consistency.ts";
import { parseUnitSummary, unitSummaryDigest, type UnitSummary } from "./unit-output.ts";
import { compareUnitIds, unitPaths } from "./unit-paths.ts";
import { deriveUnitRepairPlan, type UnitRepairPlan } from "./unit-repair-set.ts";

export const UNIT_CONSISTENCY_READING_VERSION = "unit-consistency-reading-v1";

/** Where one precondition's authority lives. `inherited` means another module refuses it; this file only says so. */
export type PreconditionAuthority = "inherited" | "asserted-here";

export interface ConsistencyPrecondition {
  readonly name: string;
  readonly authority: PreconditionAuthority;
  readonly statement: string;
}

export interface UnitConsistencyReading {
  readonly version: typeof UNIT_CONSISTENCY_READING_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  /** Every precondition that held before a class ran, in the order they were established. */
  readonly preconditions: readonly ConsistencyPrecondition[];
  readonly result: ConsistencyResult;
  readonly repair: UnitRepairPlan;
  /** Every run-relative path this load opened, sorted. Republished, never re-derived. */
  readonly readPaths: readonly string[];
}

/** Check one run's assembled unit path. Every refusal is named; nothing is written. */
export async function checkRunConsistency(runDirInput: string): Promise<UnitConsistencyReading> {
  const runDir = resolve(runDirInput);
  const assembly = await loadUnitAssembly(runDir);
  const readPaths = new Set<string>(assembly.readPaths);
  const preconditions: ConsistencyPrecondition[] = [
    {
      name: "plan-in-force",
      authority: "inherited",
      statement: `the recorded plan ${assembly.planCatalogDigest.slice(0, 16)} re-validates against knowledge epoch ${assembly.knowledgeEpoch} through the one plan gate: dispositions readable, obligation accounting and ownership conserving, one parent per child`
    },
    {
      name: "every-unit-collected",
      authority: "inherited",
      statement: `all ${assembly.plan.collectionOrder.length} planned unit(s) of ${assembly.documents.length} document(s) have a ledger row for this epoch and this plan; assembly is all-or-nothing, so a check over part of a run is unreachable`
    },
    {
      name: "ledger-promise-intact",
      authority: "inherited",
      statement: "every collected unit's content, claims and summary still digest to what its ledger row promised, through the one comparison collect and unit-cache-admit use"
    }
  ];

  await assertAssembledDeliverableCurrent(runDir, assembly, readPaths);
  preconditions.push({
    name: "assembled-deliverable-current",
    authority: "asserted-here",
    statement: `every assembled artifact on disk — ${assembly.documents.length} document(s), their ${assembly.documents.length * 2} companion(s) and the run's coverage companion — is byte for byte what this plan and these collected units produce, so every reference this checker resolves is a reference the deliverable holds`
  });

  const summaries = await readUnitSummaries(runDir, assembly, readPaths);
  assertChildSummaryDigestsCurrent(assembly, summaries);
  preconditions.push({
    name: "child-summary-digests-current",
    authority: "asserted-here",
    statement: `every synthesis unit's recorded childSummaryDigests equal the digests of its children's summaries as they are on disk now (${[...summaries.keys()].length} summary/summaries read)`
  });

  const chapterCounts = await readPlannedChapterCounts(runDir, readPaths);
  const documents: ConsistencyDocument[] = assembly.documents.map((document) => toConsistencyDocument(document, summaries, assembly, chapterCounts));
  const result = checkUnitConsistency({
    documents,
    workItems: assembly.plan.workItems,
    frozenEvidenceIds: assembly.plan.frozenEvidenceIds
  });
  const repair = deriveUnitRepairPlan({
    planned: assembly.plan.units.map((unit) => ({
      unitId: unit.unitId,
      documentId: unit.documentId,
      kind: unit.kind,
      childUnitIds: unit.childUnitIds
    })),
    findings: result.findings,
    coverage: assembly.coverage.statements
  });
  return {
    version: UNIT_CONSISTENCY_READING_VERSION,
    runId: assembly.runId,
    knowledgeEpoch: assembly.knowledgeEpoch,
    planCatalogDigest: assembly.planCatalogDigest,
    preconditions,
    result,
    repair,
    readPaths: [...readPaths].sort(compareUnitIds)
  };
}

/**
 * The deliverable on disk is the deliverable this plan produces — or a named refusal.
 *
 * Two sentences, because they have two fixes: a document that was never written needs an assemble, and a document
 * whose bytes differ needs one too but ALSO says something happened after it — a unit re-drafted without a
 * re-assemble, or the file edited by hand. Naming which of the two it is means an operator does not go looking for
 * work they already did.
 */
async function assertAssembledDeliverableCurrent(runDir: string, assembly: UnitAssembly, readPaths: Set<string>): Promise<void> {
  const absent: string[] = [];
  const stale: string[] = [];
  // EVERY assembled artifact, not only the documents: the two companions per document carry the claim rows and the
  // trace rows a reader follows, and a hand-edited companion would otherwise be the one file on this path nothing
  // re-checks. Their byte form comes from `assembledJsonBytes`, the same function the stage writes them with.
  const files: Array<{ readonly path: string; readonly expected: string }> = [
    ...assembly.documents.flatMap((document) => [
      { path: document.path, expected: document.markdown },
      { path: document.claims.path, expected: assembledJsonBytes(document.claims.companion) },
      { path: document.traces.path, expected: assembledJsonBytes(document.traces.companion) }
    ]),
    { path: assembly.coverage.path, expected: assembly.coverage.markdown }
  ];
  for (const file of files) {
    readPaths.add(file.path);
    const full = runRelativePath(runDir, file.path);
    if (!await exists(full)) {
      absent.push(file.path);
      continue;
    }
    const onDisk = await readFile(full, "utf8");
    if (onDisk !== file.expected) {
      stale.push(`${file.path} (${Buffer.byteLength(onDisk, "utf8")} byte(s) on disk against ${Buffer.byteLength(file.expected, "utf8")} this plan produces)`);
    }
  }
  if (absent.length === 0 && stale.length === 0) return;
  const sentences: string[] = [];
  if (absent.length > 0) sentences.push(`${absent.length} assembled artifact(s) are not on disk: ${absent.sort().join(", ")}`);
  if (stale.length > 0) sentences.push(`${stale.length} assembled artifact(s) on disk are not the bytes this plan and these collected units produce: ${stale.sort().join(", ")}`);
  throw new Error(`This run's unit path cannot be checked for consistency; the checker resolves references against the assembled deliverable, and ${sentences.join("; ")}. Run \`assemble --units --mode write\` and check again.`);
}

/** Every collected unit's PARSED summary, by unit id. A summary that does not parse is fatal and names its file. */
async function readUnitSummaries(runDir: string, assembly: UnitAssembly, readPaths: Set<string>): Promise<ReadonlyMap<string, UnitSummary>> {
  const summaries = new Map<string, UnitSummary>();
  for (const unitId of assembly.plan.collectionOrder) {
    const paths = unitPaths(runDir, unitId);
    readPaths.add(`units/${paths.key}/summary.json`);
    const parsed = parseUnitSummary(await readJson<unknown>(paths.summary));
    if (parsed.summary === null) {
      throw new Error(`${paths.summary} is not a valid unit summary for ${JSON.stringify(unitId)}: ${parsed.problems.join("; ")}`);
    }
    summaries.set(unitId, parsed.summary);
  }
  return summaries;
}

/**
 * Every synthesis's recorded child digests match its children's summaries as they are NOW — or a named refusal.
 *
 * The gap this closes: the promise check compares each unit against its OWN ledger row, so a child re-drafted and
 * re-collected while its parent was left alone passes every existing gate. The parent then records digests of a
 * summary that no longer exists, and its document ships a synthesis written from bytes nobody can produce.
 */
function assertChildSummaryDigestsCurrent(assembly: UnitAssembly, summaries: ReadonlyMap<string, UnitSummary>): void {
  const problems: string[] = [];
  for (const unit of assembly.plan.units) {
    const summary = summaries.get(unit.unitId);
    if (!summary) continue;
    for (const recorded of summary.childSummaryDigests) {
      const child = summaries.get(recorded.childUnitId);
      if (!child) {
        problems.push(`unit ${unit.unitId} records a summary digest for child ${recorded.childUnitId}, which this plan does not hold`);
        continue;
      }
      const digest = unitSummaryDigest(child);
      if (digest === recorded.summaryDigest) continue;
      problems.push(`unit ${unit.unitId} records child ${recorded.childUnitId} at summary digest ${recorded.summaryDigest.slice(0, 16)} but that child's summary on disk digests to ${digest.slice(0, 16)}`);
    }
  }
  if (problems.length === 0) return;
  throw new Error(`This run's collected units disagree about what their children said, so it cannot be checked for consistency: ${problems.join("; ")}. Re-draft and re-collect the units named first, then assemble again.`);
}

/**
 * How many numbered chapters each planned document owes, from THIS RUN's recorded requirement rows.
 *
 * `contract/requirements.json` is one of the three inputs materialized before any producer ran, and it holds one
 * row per level-two template section of every requested document. That is the denominator the chapter contract is
 * checked against, and reading it here — rather than re-reading a template off disk — is what makes the verdict a
 * statement about the run instead of about whatever the templates say today.
 *
 * Run-level rows carry no `documentId` and no `sectionIndex`; they are requirements of the run, not chapters of a
 * document, so they are not counted.
 */
async function readPlannedChapterCounts(runDir: string, readPaths: Set<string>): Promise<ReadonlyMap<string, number>> {
  const path = join("contract", "requirements.json");
  readPaths.add(path);
  const full = runRelativePath(runDir, path);
  // An absent contract is an empty map, not a refusal. A run prepared before the contract generation is
  // grandfathered by the generation gate and has no `contract/` at all, and this checker is READ-ONLY: locking an
  // operator out of inspecting a shipped deliverable because one input postdates it would be the same failure the
  // freeze gate was moved off this path to avoid. Every document then reads `vacuous` with the reason.
  if (!await exists(full)) return new Map();
  const requirements = await readJson<Requirements>(full);
  const counts = new Map<string, number>();
  for (const row of requirements.rows) {
    if (row.documentId === null || row.sectionIndex === null) continue;
    counts.set(row.documentId, (counts.get(row.documentId) ?? 0) + 1);
  }
  return counts;
}

/** One document's checker input: the assembled bytes, the lens's identifier rule, and every unit's three parts. */
function toConsistencyDocument(
  document: AssembledUnitDocument,
  summaries: ReadonlyMap<string, UnitSummary>,
  assembly: UnitAssembly,
  chapterCounts: ReadonlyMap<string, number>
): ConsistencyDocument {
  const request = assembly.plan.requests.requests.find((record) => record.documentId === document.documentId);
  if (!request) {
    throw new Error(`Document ${JSON.stringify(document.documentId)} was assembled but this run records no request row for it; the lens whose identifier rule applies to it is not knowable`);
  }
  // Resolved from the registry rather than from the recorded reference, which carries only a digest. Plan
  // validation has already refused a recorded reference that is not this registry's, so the two cannot disagree.
  const lens = lensPolicyFor(request.request.audience);
  // Null rather than a refusal or a zero. Zero would report every chapter the document holds as an excess; a
  // refusal would produce no reading for ANY document of a run that used the supported `request-append` door,
  // because that door grows `plan/requests.json` and never the contract. The class reports null as vacuous and
  // says so, and the other five classes keep speaking about this document.
  const plannedChapterCount = chapterCounts.get(document.documentId) ?? null;
  const claimsByUnit = new Map<string, SectionClaim[]>();
  for (const row of document.claims.companion.claims) {
    claimsByUnit.set(row.unitId, [...(claimsByUnit.get(row.unitId) ?? []), row.claim]);
  }
  const units: ConsistencyUnit[] = document.assemblyUnits.map((unit) => {
    const summary = summaries.get(unit.unitId);
    if (!summary) throw new Error(`Unit ${JSON.stringify(unit.unitId)} was assembled into ${JSON.stringify(document.documentId)} but no summary was read for it`);
    return {
      unitId: unit.unitId,
      documentId: document.documentId,
      kind: unit.kind,
      title: unit.title,
      content: unit.content,
      claims: claimsByUnit.get(unit.unitId) ?? [],
      summary
    };
  });
  return {
    documentId: document.documentId,
    markdown: document.markdown,
    audience: request.request.audience,
    // The TASK, from the same recorded row as the reader. The PRD word-form rules key on this one: a prd request
    // is recorded as the `product-manager` audience with the `prd` intent, so keying them on the audience would
    // apply them to every product overview in the run.
    intent: request.request.intent,
    identifierPlacement: lens.content.identifiers,
    plannedChapterCount,
    units
  };
}
