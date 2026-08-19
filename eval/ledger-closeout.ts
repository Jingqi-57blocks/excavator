// Transcribed close-out of a prepared run's unsettled read obligations.
//
// Why this exists. `src/freeze/freeze.ts:77` runs `auditWorkItems`, and `src/investigation/assurance.ts:351`
// makes ANY `pending` work item an error, so a run cannot be frozen — and therefore renders no authoring packet —
// until every work item holds a terminal status. On a run whose reads all hit the source-window budget, the
// pipeline already recorded WHY each read produced nothing: `src/run/investigation-stage.ts:70-80` writes the
// executing `settledBy` and the LEDGER-READ evidence onto the item and leaves it `pending`. Turning that into
// `cannot-determine` is a TRANSCRIPTION of the run's own execution record, not a judgement about the code.
//
// The one rule this file exists to hold: NOTHING IS EVER INVENTED. A work item is closed out only when the run's
// own `investigation/results.json` carries the three fields the `cannot-determine` contract demands — a cause to
// transcribe into `reason`, an execution id for `settledBy`, and limitation evidence for `evidenceIds`. Any
// unsettled item that does not have all three is NAMED in `gaps` and left alone. There is no fallback wording, no
// default cause and no "unknown" bucket: an engine whose defensibility rests on stated reasons cannot have a code
// path that manufactures one. `caller`s of this module are expected to treat a non-empty `gaps` list as red.
//
// Items that already hold a terminal status are never touched — a rerun (R8 will run this again) produces the
// same updates for the same run directory and no update at all for anything already closed.
//
// Zero model calls. This module never writes to the run directory: it projects, and the caller applies the
// `updates` array through `excavator workitem --run <dir> --file <file>` so the mutation goes through the
// pipeline's own gate and lands in the run's timeline.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InvestigationPlan, InvestigationWorkItem, RunManifest } from "../src/base/types.ts";
import type { DecisionDisposition, InvestigationResults, ReadExecutionRecord } from "../src/investigation/read-execution.ts";

/** The statuses `auditWorkItems` reports as "not completed"; the only statuses this tool ever changes. */
export const UNSETTLED_STATUSES = ["pending", "in_progress"];

/**
 * The exact record each transcription came from, so a reviewer can re-walk any single row: execution id ->
 * `investigation/results.json` `executions[]`, disposition -> `dispositions[]`. Nothing in an update's `reason`
 * appears here that is not also in the record.
 */
export interface CloseoutSource {
  /** `value.executions[].id`, and the value prepare had already written into the item's `settledBy`. */
  executionId: string;
  declarationId: string;
  readSpecId: string;
  /** `value.executions[].outcome` — quoted verbatim in the reason. */
  outcome: string;
  /** `value.executions[].cause` — quoted verbatim in the reason. Required; never defaulted. */
  cause: string;
  path: string;
  span: string;
  /** The disposition that left the item unsettled, tying the two sides of the link together. */
  dispositionStatus: string;
}

/** One apply-ready work-item update. Exactly the `InvestigationWorkItem` fields — `mergeWorkItems` spreads the
 *  update onto the item, so any extra field here would end up inside `workitems.json`. Provenance lives in the
 *  report's `rows[].source`, not in the applied array. */
export interface CloseoutUpdate {
  id: string;
  status: "cannot-determine";
  reason: string;
  settledBy: string;
  evidenceIds: string[];
}

export interface CloseoutRow {
  update: CloseoutUpdate;
  source: CloseoutSource;
}

/** An unsettled item this tool refuses to close, and the structural fact that stops it. Named, never filled in. */
export interface CloseoutGap {
  id: string;
  dimension: string;
  status: string;
  why: string;
}

export interface LedgerCloseout {
  version: 1;
  runId: string;
  /** Work items in `workitems.json`. */
  items: number;
  /** Items already holding a terminal status: skipped, never modified. */
  terminal: number;
  /** Items `auditWorkItems` would report as not completed — the population this tool looks at. */
  unsettled: number;
  transcribed: number;
  untranscribable: number;
  /** The gap tallied by dimension, so which population is missing a record is visible without reading 90 ids. */
  untranscribableByDimension: Record<string, number>;
  /** The distinct causes transcribed, with how many items each closed. A single-cause run says so out loud. */
  causes: Record<string, number>;
  rows: CloseoutRow[];
  gaps: CloseoutGap[];
}

const ERR = "ledger closeout";

function fail(message: string): never {
  throw new Error(`${ERR}: ${message}`);
}

function readJsonFile<T>(path: string, what: string): T {
  if (!existsSync(path)) fail(`${what} is missing`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail(`${what} could not be read: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    fail(`${what} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * The artifact envelope `writeInvestigationStage` persists: `{status, value}`. A run whose investigation stage is
 * unavailable or not applicable carries no executions at all, and that is a named failure rather than an empty
 * transcription — "no records" and "no cause for this item" must not read the same.
 */
function readResults(runDir: string): InvestigationResults {
  const artifact = readJsonFile<{ status?: string; value?: InvestigationResults }>(join(runDir, "investigation", "results.json"), "investigation/results.json");
  if (artifact.status !== "built") fail(`investigation/results.json is ${JSON.stringify(artifact.status)}, not "built", so it carries no execution records to transcribe`);
  const value = artifact.value;
  if (!value || typeof value !== "object") fail("investigation/results.json has no value object");
  if (!Array.isArray(value.executions)) fail("investigation/results.json has no executions array");
  if (!Array.isArray(value.dispositions)) fail("investigation/results.json has no dispositions array");
  return value;
}

export function buildLedgerCloseout(runDir: string): LedgerCloseout {
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) fail(`${runDir} is not a directory`);
  const manifest = readJsonFile<RunManifest>(join(runDir, "run.json"), "run.json");
  if (typeof manifest.id !== "string" || !manifest.id) fail("run.json has no run id");
  const plan = readJsonFile<InvestigationPlan>(join(runDir, "workitems.json"), "workitems.json");
  if (!Array.isArray(plan.items)) fail("workitems.json has no items array");
  const results = readResults(runDir);

  const executions = new Map<string, ReadExecutionRecord>();
  for (const execution of results.executions) {
    if (typeof execution.id !== "string" || !execution.id) fail("investigation/results.json has an execution with no id");
    if (executions.has(execution.id)) fail(`investigation/results.json has two executions with id ${execution.id}`);
    executions.set(execution.id, execution);
  }
  const dispositionByExecution = new Map<string, DecisionDisposition>();
  for (const disposition of results.dispositions) {
    if (typeof disposition.executionId !== "string" || !disposition.executionId) fail("investigation/results.json has a disposition with no executionId");
    dispositionByExecution.set(disposition.executionId, disposition);
  }

  const rows: CloseoutRow[] = [];
  const gaps: CloseoutGap[] = [];
  let terminal = 0;
  for (const item of plan.items) {
    if (typeof item.id !== "string" || !item.id) fail("workitems.json has a work item with no id");
    if (typeof item.status !== "string" || !item.status) fail(`work item ${item.id} has no status`);
    if (!UNSETTLED_STATUSES.includes(item.status)) { terminal += 1; continue; }
    const row = transcribe(item, executions, dispositionByExecution);
    if ("why" in row) gaps.push(row); else rows.push(row);
  }

  rows.sort((a, b) => a.update.id.localeCompare(b.update.id));
  gaps.sort((a, b) => a.id.localeCompare(b.id));
  const byDimension = new Map<string, number>();
  for (const gap of gaps) byDimension.set(gap.dimension, (byDimension.get(gap.dimension) ?? 0) + 1);
  const causes = new Map<string, number>();
  for (const row of rows) causes.set(row.source.cause, (causes.get(row.source.cause) ?? 0) + 1);

  return {
    version: 1,
    runId: manifest.id,
    items: plan.items.length,
    terminal,
    unsettled: rows.length + gaps.length,
    transcribed: rows.length,
    untranscribable: gaps.length,
    untranscribableByDimension: sorted(byDimension),
    causes: sorted(causes),
    rows,
    gaps
  };
}

/**
 * One item, transcribed or named. The link is the one the pipeline itself recorded: the `settledBy` prepare wrote
 * is an execution id. Nothing is searched for by path, name or line — a derived link would be a second linking
 * rule that no artifact backs, and the day it mismatched it would attach a real cause to the wrong item.
 */
function transcribe(
  item: InvestigationWorkItem,
  executions: Map<string, ReadExecutionRecord>,
  dispositionByExecution: Map<string, DecisionDisposition>
): CloseoutRow | CloseoutGap {
  const gap = (why: string): CloseoutGap => ({ id: item.id, dimension: item.dimension, status: item.status, why });
  const settledBy = typeof item.settledBy === "string" ? item.settledBy.trim() : "";
  if (!settledBy) return gap("the work item carries no settledBy, so investigation/results.json links no read execution to it");
  const execution = executions.get(settledBy);
  if (!execution) return gap(`settledBy ${settledBy} matches no execution id in investigation/results.json`);
  const cause = typeof execution.cause === "string" ? execution.cause.trim() : "";
  if (!cause) return gap(`execution ${settledBy} records no cause, so there is no reason to transcribe`);
  if (typeof execution.outcome !== "string" || !execution.outcome) return gap(`execution ${settledBy} records no outcome`);
  const evidenceIds = Array.isArray(execution.evidenceIds) ? [...execution.evidenceIds] : [];
  if (!evidenceIds.length) return gap(`execution ${settledBy} cites no evidence, and a cannot-determine work item requires limitation evidence`);
  const span = execution.requestedSpan;
  if (!span || typeof span.startLine !== "number" || typeof span.endLine !== "number") return gap(`execution ${settledBy} records no requested span`);
  if (typeof execution.path !== "string" || !execution.path) return gap(`execution ${settledBy} records no path`);
  const disposition = dispositionByExecution.get(settledBy);
  if (!disposition) return gap(`execution ${settledBy} has no disposition in investigation/results.json, so the record does not say the obligation was left open`);
  if (disposition.status !== "pending") return gap(`the disposition for execution ${settledBy} is ${JSON.stringify(disposition.status)}, not "pending", so this item's status did not come from an unfinished read`);

  const location = `${execution.path}:${span.startLine}-${span.endLine}`;
  // Every substring below is either fixed frame or a field quoted off the record named in the same sentence.
  const reason = `The authorized read was not completed: execution ${execution.id} of ${location} recorded outcome `
    + `"${execution.outcome}" with cause "${cause}" (transcribed from investigation/results.json).`;
  return {
    update: { id: item.id, status: "cannot-determine", reason, settledBy: execution.id, evidenceIds },
    source: {
      executionId: execution.id,
      declarationId: execution.declarationId,
      readSpecId: execution.readSpecId,
      outcome: execution.outcome,
      cause,
      path: execution.path,
      span: `${span.startLine}-${span.endLine}`,
      dispositionStatus: disposition.status
    }
  };
}

function sorted(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.keys()].sort().map((key) => [key, counts.get(key)!]));
}
