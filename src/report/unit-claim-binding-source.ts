/**
 * WHAT THE BINDING CONTRACT IS RUN OVER: one run's validated plan and the bytes each of its units has on disk.
 * Read-only from end to end — this file opens files and writes none.
 *
 * IT IS A SEPARATE READING FROM THE GROUNDING ONE, ON PURPOSE. `auditUnitFromDisk` is what the COLLECT barrier
 * calls before it records a unit, so anything folded into `UnitGroundingResult` becomes a collect gate. The
 * binding contract is an AUDIT finding — written, then checked, with `audit --units` saying why and its exit
 * code carrying the verdict — exactly as `auditSectionClaims` is an audit finding on the section path and not a
 * checkpoint refusal. Keeping it out of the grounding result is what keeps that true.
 *
 * A UNIT IS CHECKED WHEN BOTH ITS BYTES ARE ON DISK. `content.md` without `claims.json`, or the reverse, is a
 * half-written unit: it is listed as `unwritten` with which of the two is missing, never counted as clean and
 * never checked against half its input. That mirrors the grounding reading, which names an unwritten unit rather
 * than reporting zero findings for it.
 *
 * IT READS THE BYTES, NOT THE LEDGER'S PROMISE ABOUT THEM. Whether a unit's artifacts still digest to what its
 * ledger row recorded is `promisedArtifactProblems`' question, asserted where assembly needs it; this reading is
 * about what the prose says, so it opens the prose.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunManifest } from "../base/types.ts";
import { exists, readJson } from "../base/util.ts";
import { auditUnitClaimBinding, summariseUnitClaimBinding, type UnitClaimBindingResult } from "./unit-claim-binding.ts";
import { parseUnitClaims } from "./unit-output.ts";
import { unitPaths } from "./unit-paths.ts";
import { assertPlanEpoch, loadUnitPlanView, requireKnowledgeEpoch, type UnitPlanView } from "./unit-plan-view.ts";

export const UNIT_CLAIM_BINDING_READING_VERSION = "unit-claim-binding-reading-v1";

/** A planned unit that has no complete pair of artifacts yet, and which half is missing. */
export interface UnwrittenUnitBinding {
  readonly unitId: string;
  readonly reason: string;
}

export interface UnitClaimBindingReading {
  readonly version: typeof UNIT_CLAIM_BINDING_READING_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  /** One row per planned unit whose content and claims are both on disk, in collection order. */
  readonly units: readonly UnitClaimBindingResult[];
  /** Planned units with nothing to check yet. Named: there is no prose to bind, which is not the same as clean. */
  readonly unwritten: readonly UnwrittenUnitBinding[];
  readonly summary: string;
}

/** Check one unit from the artifacts on disk. Not exported: nothing outside this reading checks one unit. */
async function bindUnitFromDisk(runDir: string, unitId: string, documentId: string): Promise<UnitClaimBindingResult> {
  const paths = unitPaths(runDir, unitId);
  const parsed = parseUnitClaims(await readJson<unknown>(paths.claims));
  if (parsed.claims === null) {
    throw new Error(`${paths.claims} is not a valid unit claims sidecar: ${parsed.problems.join("; ")}`);
  }
  if (parsed.claims.unitId !== unitId) {
    throw new Error(`${paths.claims} records unit ${JSON.stringify(parsed.claims.unitId)}, but it sits in the directory of ${JSON.stringify(unitId)}`);
  }
  return auditUnitClaimBinding({
    unitId,
    documentId,
    content: await readFile(paths.content, "utf8"),
    claims: parsed.claims.claims
  });
}

/** The run-wide reading: every written unit checked, every planned unit accounted for. */
export async function readUnitClaimBinding(runDir: string, view: UnitPlanView): Promise<UnitClaimBindingReading> {
  const units: UnitClaimBindingResult[] = [];
  const unwritten: UnwrittenUnitBinding[] = [];
  for (const unitId of view.collectionOrder) {
    const unit = view.byId.get(unitId)!;
    const paths = unitPaths(runDir, unitId);
    const [hasContent, hasClaims] = await Promise.all([exists(paths.content), exists(paths.claims)]);
    if (!hasContent || !hasClaims) {
      const missing = [!hasContent ? "content.md" : null, !hasClaims ? "claims.json" : null].filter((name) => name !== null);
      unwritten.push({ unitId, reason: `unit ${unitId} has no ${missing.join(" and no ")} on disk, so there is no binding to check for it` });
      continue;
    }
    units.push(await bindUnitFromDisk(runDir, unitId, unit.documentId));
  }
  const violations = units.filter((row) => row.verdict.conclusion === "violations");
  const problems = units.reduce((total, row) => total + row.problems.length, 0);
  return {
    version: UNIT_CLAIM_BINDING_READING_VERSION,
    runId: view.runId,
    knowledgeEpoch: view.knowledgeEpoch,
    planCatalogDigest: view.planCatalogDigest,
    units,
    unwritten,
    summary: `${units.length} of ${view.units.length} planned unit(s) checked for claim ↔ prose binding (${violations.length} with violations, ${problems} problem(s) in all), ${unwritten.length} not written.`
  };
}

/**
 * The read-only entry point: load the validated plan, check the two epoch premises, produce the reading.
 *
 * The same premises `draft`, `collect`, `status` and the grounding reading stand on, in the same order and with
 * the same messages. A run with no validated plan is refused by the gate naming the missing file, never reported
 * as "0 units checked".
 */
export async function readUnitClaimBindingForRun(runDirInput: string): Promise<UnitClaimBindingReading> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const knowledgeEpoch = requireKnowledgeEpoch(manifest, "audited");
  const view = await loadUnitPlanView(runDir, manifest);
  assertPlanEpoch(view, knowledgeEpoch);
  return readUnitClaimBinding(runDir, view);
}

/** One line per checked unit, then every problem by name, then the unwritten. The lines a CLI prints. */
export function summariseUnitClaimBindingReading(reading: UnitClaimBindingReading): readonly string[] {
  return [
    reading.summary,
    ...reading.units.map((row) => summariseUnitClaimBinding(row)),
    ...reading.units.flatMap((row) => row.problems.map((problem) => `binding: ${problem.message}`)),
    ...reading.unwritten.map((row) => `unwritten: ${row.reason}`)
  ];
}
