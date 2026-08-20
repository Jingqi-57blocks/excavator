/**
 * The plan's input budget: how many bytes of topic dossier one authoring unit may be asked to read, per document.
 *
 * WHY PER DOCUMENT AND NOT PER PLAN. `detailBudget` is a field of ONE request, and one request is one document. A
 * plan-wide number would have to pick between two documents' budgets — the strict one starves the detailed
 * document, the loose one lets the compact one grow — and either way the number no longer means what the request
 * said. So the budget is a row per document, ascending by document id, and a unit is measured against its own
 * document's row.
 *
 * WHY THE PROPOSAL ECHOES IT. A planner that computed its own budget could satisfy any plan by declaring a bigger
 * one. The budget is therefore derived here, from the recorded requests, and the proposal's echo is compared byte
 * for byte: a differing echo is a named failure, not an override. This is the same rule as "the denominator only
 * comes from the catalog", applied to the other number a plan could grade itself with.
 *
 * WHY THE ALLOWANCE TABLE IS INJECTABLE. A budget check that can only ever run against the one real table can only
 * ever go green — the negative fixtures need a table small enough to make a real catalog overflow. The table is
 * checked for completeness in BOTH directions at load, the shape `report-policy-registry.ts` uses, so a new
 * `DetailBudget` member with no allowance is a named refusal instead of a silently unbudgeted document.
 *
 * WHAT OVERFLOW MAY NOT DO. It may not truncate. This slice's only verdict on an over-budget unit is a NAMED
 * failure that points at the unit and its topics; semantic splitting is R5's, and until it exists an over-budget
 * plan is a plan that gets rejected and re-proposed. Nothing here caps a list or drops a topic to fit.
 */

import { canonicalJson } from "../base/util.ts";
import { DETAIL_BUDGETS, type DetailBudget } from "./report-request-v2.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";
import type { TopicCandidate } from "./topic-candidate.ts";

export const PLAN_BUDGET_VERSION = "plan-budget-v1";

export interface DetailBudgetAllowance {
  /** The largest topic dossier one unit may be handed, in bytes of canonical topic rows. */
  readonly perUnitInputBytes: number;
  /** The largest sum over all of one document's units. */
  readonly totalInputBytes: number;
}

export interface PlanBudgetTable {
  readonly version: string;
  /** Keyed by `DetailBudget`; the load-time check is what keeps the key set exactly that. */
  readonly allowances: Readonly<Record<string, DetailBudgetAllowance>>;
}

export interface PlanDocumentBudget {
  readonly documentId: string;
  readonly detailBudget: DetailBudget;
  readonly perUnitInputBytes: number;
  readonly totalInputBytes: number;
}

export interface PlanBudget {
  readonly version: string;
  /** Strictly ascending by `documentId` — one row per recorded request, always. */
  readonly documents: readonly PlanDocumentBudget[];
}

/**
 * The allowances, in bytes of canonical topic rows.
 *
 * MEASURED, not guessed. On the wcp R0 baseline (1,570 topics, 7 material, 847 material obligations) the facet
 * dossiers a fixture plan groups come out: feature 220,107 B over 2 material topics, work-item-dimension 206,967 B
 * over 4, coverage 39,942 B over 1, and a 37,111 B appendix over the 55 non-material coverage topics. The largest
 * single unit is therefore ~220 KB, which is why `standard` sits at 768 KiB: a real plan fits with headroom, and a
 * `compact` request is measurably tighter without being unsatisfiable on that same catalog. The route facet's
 * 970,230 B over 1,434 unobligated topics is deliberately NOT in a unit — no obligation binds to it, so nothing
 * makes it a leaf; if a plan ever puts it in one, this budget is what says so by name.
 *
 * The ladder gates granularity, never truth: an over-budget unit is a named refusal here and a semantic split in
 * R5, and in neither case does a topic get dropped to fit.
 */
export const PLAN_BUDGET_TABLE: PlanBudgetTable = {
  version: PLAN_BUDGET_VERSION,
  allowances: {
    compact: { perUnitInputBytes: 262_144, totalInputBytes: 1_048_576 },
    standard: { perUnitInputBytes: 786_432, totalInputBytes: 3_145_728 },
    detailed: { perUnitInputBytes: 2_097_152, totalInputBytes: 8_388_608 }
  }
};

/** Completeness in both directions, plus the ordering the ladder claims. Injectable so a fixture can fail it. */
export function validatePlanBudgetTable(table: PlanBudgetTable = PLAN_BUDGET_TABLE): void {
  if (!table.version.trim()) throw new Error("The plan budget table must declare its version; it is what a recorded plan's budget names");
  const declared = new Set(Object.keys(table.allowances));
  const missing = DETAIL_BUDGETS.filter((member) => !declared.has(member));
  if (missing.length) throw new Error(`No plan budget allowance is declared for detail budget(s) ${missing.join(", ")}; a request naming one would resolve to no budget`);
  const phantom = [...declared].filter((key) => !(DETAIL_BUDGETS as readonly string[]).includes(key)).sort();
  if (phantom.length) throw new Error(`The plan budget table declares allowances for unknown detail budget(s) ${phantom.join(", ")}; a row no request can name is a dead row that reads like support`);
  for (const [key, allowance] of Object.entries(table.allowances)) {
    if (!Number.isSafeInteger(allowance.perUnitInputBytes) || allowance.perUnitInputBytes <= 0) {
      throw new Error(`Detail budget ${JSON.stringify(key)} declares perUnitInputBytes ${JSON.stringify(allowance.perUnitInputBytes)}; a unit budget must be a positive integer`);
    }
    if (!Number.isSafeInteger(allowance.totalInputBytes) || allowance.totalInputBytes < allowance.perUnitInputBytes) {
      throw new Error(`Detail budget ${JSON.stringify(key)} declares totalInputBytes ${JSON.stringify(allowance.totalInputBytes)}, which is below its own per-unit allowance; one unit would be unsatisfiable inside a satisfiable document`);
    }
  }
}

validatePlanBudgetTable(PLAN_BUDGET_TABLE);

/** The allowance for one detail budget. Unreachable for a declared member thanks to the load-time check. */
export function detailBudgetAllowance(detailBudget: DetailBudget, table: PlanBudgetTable = PLAN_BUDGET_TABLE): DetailBudgetAllowance {
  const found = table.allowances[detailBudget];
  if (!found) throw new Error(`No plan budget allowance is declared for detail budget ${JSON.stringify(detailBudget)}; declare one in plan-budget.ts`);
  return found;
}

/** Derive the budget from the recorded requests. The only producer — a proposal never states its own. */
export function planBudgetFor(requests: ReportRequestsArtifact, table: PlanBudgetTable = PLAN_BUDGET_TABLE): PlanBudget {
  return {
    version: table.version,
    documents: [...requests.requests]
      .sort((a, b) => a.documentId.localeCompare(b.documentId))
      .map((record) => {
        const allowance = detailBudgetAllowance(record.request.detailBudget, table);
        return {
          documentId: record.documentId,
          detailBudget: record.request.detailBudget,
          perUnitInputBytes: allowance.perUnitInputBytes,
          totalInputBytes: allowance.totalInputBytes
        };
      })
  };
}

/**
 * What one unit's topic dossier costs: the canonical bytes of the topic rows it names, obligation bindings and
 * all. It is a proxy for what R4 will render, and it is deliberately the FULL row — a budget measured against a
 * summary would report a unit as affordable and then hand the author the thing it did not measure.
 */
export function unitInputBytes(topics: readonly TopicCandidate[]): number {
  return topics.reduce((total, topic) => total + Buffer.byteLength(canonicalJson(topic), "utf8"), 0);
}

const BUDGET_FIELDS = ["documents", "version"] as const;
const DOCUMENT_BUDGET_FIELDS = ["detailBudget", "documentId", "perUnitInputBytes", "totalInputBytes"] as const;

/** Every problem an untrusted value has as a plan budget echo, as data. Empty means well-shaped (not yet equal). */
export function planBudgetProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [`budget ${JSON.stringify(value)} is not a budget object`];
  const budget = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(BUDGET_FIELDS);
  for (const key of Object.keys(budget).sort()) {
    if (!known.has(key)) problems.push(`budget has unknown field ${JSON.stringify(key)}`);
  }
  if (typeof budget.version !== "string" || budget.version.trim() === "") problems.push(`budget version ${JSON.stringify(budget.version)} is not a non-empty string`);
  if (!Array.isArray(budget.documents)) return [...problems, `budget documents ${JSON.stringify(budget.documents)} is not an array`];
  for (const [index, row] of (budget.documents as unknown[]).entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      problems.push(`budget documents[${index}] is not a document budget object`);
      continue;
    }
    const document = row as Record<string, unknown>;
    const knownRow = new Set<string>(DOCUMENT_BUDGET_FIELDS);
    for (const key of Object.keys(document).sort()) {
      if (!knownRow.has(key)) problems.push(`budget documents[${index}] has unknown field ${JSON.stringify(key)}`);
    }
    if (typeof document.documentId !== "string" || document.documentId.trim() === "") problems.push(`budget documents[${index}] documentId ${JSON.stringify(document.documentId)} is not a non-empty string`);
    if (typeof document.detailBudget !== "string" || !(DETAIL_BUDGETS as readonly string[]).includes(document.detailBudget)) {
      problems.push(`budget documents[${index}] detailBudget ${JSON.stringify(document.detailBudget)} is not one of: ${DETAIL_BUDGETS.join(", ")}`);
    }
    for (const field of ["perUnitInputBytes", "totalInputBytes"] as const) {
      if (!Number.isSafeInteger(document[field]) || (document[field] as number) <= 0) {
        problems.push(`budget documents[${index}] ${field} ${JSON.stringify(document[field])} is not a positive integer`);
      }
    }
  }
  return problems;
}
