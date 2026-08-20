/**
 * `units/collected.json` — which authoring units have been RECORDED, written by `collect` and by nothing else.
 *
 * WHY NOT `run.json`. The manifest's `documents[].sections[].complete` is the section world's state machine, and
 * the epic's own rule for this slice is that the section path does not move a byte. Reusing that structure for
 * units would mean the two worlds share a state field, so a unit collection would show up in the section
 * manifest, in the golden bytes and in every audit that reads them. A separate ledger keeps the unit machinery
 * additive: a run that never authored a unit does not have this file at all.
 *
 * ONE WRITER, BY CONSTRUCTION. `draft` reads this file (a synthesis may not be written before its children are
 * collected) and never writes it; `collect` is the single-writer barrier that does. That is the same
 * "write in parallel, account serially" split the section path uses, and it is what makes the ledger's row order
 * a function of the plan rather than of who finished first.
 *
 * EVERY ROW CARRIES ITS EPOCH AND ITS PLAN. A row is only "collected" for the epoch and plan it names, so a
 * re-freeze does not silently turn last epoch's collections into this epoch's. The rows are kept rather than
 * cleared: a superseded collection is reported by name (`unit-status.ts`), because deleting the record of work
 * that was done is exactly the silent loss this file exists to prevent.
 */

import { exists, readJson, writeJson } from "../base/util.ts";
import { AUTHORING_UNIT_KINDS, type AuthoringUnitKind } from "./plan-proposal.ts";
import { isSha256Digest } from "./unit-output.ts";
import { compareUnitIds, unitLedgerPath } from "./unit-paths.ts";

export const UNIT_LEDGER_VERSION = "unit-ledger-v1";

export interface CollectedUnit {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  readonly collectedAt: string;
  readonly revision: boolean;
  readonly contentDigest: string;
  readonly claimsDigest: string;
  readonly summaryDigest: string;
  /** The timeline sequence of the event this collection appended. The ledger and the chain name each other. */
  readonly timelineSequence: number;
}

export interface UnitLedger {
  readonly version: typeof UNIT_LEDGER_VERSION;
  readonly runId: string;
  /** Strictly ascending by `unitId`, so two ledgers holding the same collections are the same bytes. */
  readonly units: readonly CollectedUnit[];
}

const LEDGER_FIELDS = ["runId", "units", "version"] as const;

const ROW_FIELDS = [
  "claimsDigest", "collectedAt", "contentDigest", "documentId", "kind", "knowledgeEpoch", "planCatalogDigest",
  "revision", "summaryDigest", "timelineSequence", "unitId"
] as const;

/**
 * Read the ledger of one run. An absent file is an EMPTY ledger for this run id — the state of a run that has
 * collected no unit — and a present file that does not parse is fatal, named, and never read as empty.
 */
export async function readUnitLedger(runDir: string, runId: string): Promise<UnitLedger> {
  const path = unitLedgerPath(runDir);
  if (!await exists(path)) return { version: UNIT_LEDGER_VERSION, runId, units: [] };
  let raw: unknown;
  try {
    raw = await readJson<unknown>(path);
  } catch (error) {
    throw new Error(`${path} could not be read as JSON: ${(error as Error).message}`);
  }
  const problems = unitLedgerProblems(raw, runId);
  if (problems.length > 0) throw new Error(`${path} is not a valid unit ledger: ${problems.join("; ")}`);
  return raw as UnitLedger;
}

/**
 * Write the ledger. Called by `collect` only — the ordering below is what keeps its bytes deterministic.
 *
 * The sort and the strictly-ascending check in `unitLedgerProblems` MUST use one comparator, and it must be a
 * total one (`compareUnitIds`, not a collator): two distinct-but-collate-equal ids sorted by a collator and then
 * required to be strictly ascending by that same collator make a file its own reader refuses.
 */
export async function writeUnitLedger(runDir: string, ledger: UnitLedger): Promise<void> {
  await writeJson(unitLedgerPath(runDir), {
    ...ledger,
    units: [...ledger.units].sort((a, b) => compareUnitIds(a.unitId, b.unitId))
  });
}

/** Replace the row for one unit, or add it. Ascending by unit id; a revision replaces, never appends a twin. */
export function withCollectedUnit(ledger: UnitLedger, row: CollectedUnit): UnitLedger {
  return {
    ...ledger,
    units: [...ledger.units.filter((unit) => unit.unitId !== row.unitId), row].sort((a, b) => compareUnitIds(a.unitId, b.unitId))
  };
}

/**
 * The units this ledger records as collected FOR one epoch and one plan.
 *
 * The epoch and plan filter is the point: after a re-freeze and a re-plan, last epoch's rows are still on disk
 * and still readable, but they are not collections of the plan now in force.
 */
export function collectedUnitsFor(ledger: UnitLedger, knowledgeEpoch: number, planCatalogDigest: string): readonly CollectedUnit[] {
  return ledger.units.filter((unit) => unit.knowledgeEpoch === knowledgeEpoch && unit.planCatalogDigest === planCatalogDigest);
}

/** Every problem an untrusted value has as a unit ledger, as data. Empty means valid. */
export function unitLedgerProblems(value: unknown, runId: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["is not a unit ledger object"];
  const artifact = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(LEDGER_FIELDS);
  for (const key of Object.keys(artifact).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of LEDGER_FIELDS) {
    if (!(key in artifact)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  if (artifact.version !== UNIT_LEDGER_VERSION) problems.push(`version ${JSON.stringify(artifact.version)} is not ${UNIT_LEDGER_VERSION}`);
  if (artifact.runId !== runId) problems.push(`runId ${JSON.stringify(artifact.runId)} is not this run's ${JSON.stringify(runId)}`);
  if (!Array.isArray(artifact.units)) return [...problems, `units ${JSON.stringify(artifact.units)} is not an array`];
  let previous: string | null = null;
  for (const [index, row] of (artifact.units as unknown[]).entries()) {
    const rowProblems = collectedRowProblems(row);
    for (const problem of rowProblems) problems.push(`units[${index}] ${problem}`);
    if (rowProblems.length > 0) continue;
    const unit = row as CollectedUnit;
    if (previous !== null && compareUnitIds(unit.unitId, previous) <= 0) {
      problems.push(`units[${index}] unitId ${JSON.stringify(unit.unitId)} does not follow ${JSON.stringify(previous)}; the rows must be strictly ascending by unit id`);
    }
    previous = unit.unitId;
  }
  return problems;
}

function collectedRowProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["is not a collected unit object"];
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(ROW_FIELDS);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of ROW_FIELDS) {
    if (!(key in row)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  for (const key of ["unitId", "documentId", "collectedAt"] as const) {
    if (typeof row[key] !== "string" || (row[key] as string).trim() === "") problems.push(`${key} ${JSON.stringify(row[key])} is not a non-empty string`);
  }
  if (typeof row.kind !== "string" || !(AUTHORING_UNIT_KINDS as readonly string[]).includes(row.kind)) {
    problems.push(`kind ${JSON.stringify(row.kind)} is not one of: ${AUTHORING_UNIT_KINDS.join(", ")}`);
  }
  if (typeof row.revision !== "boolean") problems.push(`revision ${JSON.stringify(row.revision)} is not a boolean`);
  for (const key of ["knowledgeEpoch", "timelineSequence"] as const) {
    if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0) problems.push(`${key} ${JSON.stringify(row[key])} is not a non-negative integer`);
  }
  for (const key of ["planCatalogDigest", "contentDigest", "claimsDigest", "summaryDigest"] as const) {
    if (!isSha256Digest(row[key])) problems.push(`${key} ${JSON.stringify(row[key])} is not a sha256 digest`);
  }
  return problems;
}
