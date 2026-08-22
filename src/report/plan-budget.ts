/**
 * The plan's budget: how many bytes of PACKET one authoring unit may be asked to read, how many bytes of prose and
 * claims it may write back, and how many bytes of summary a parent may be handed for it — per document.
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
 * THERE IS NO PROXY MEASURE HERE ANY MORE, AND THAT IS THE POINT OF v2. R4b's `unitInputBytes` summed the canonical
 * bytes of a unit's TOPIC ROWS and called it the input cost. Measured against what the packet actually renders, it
 * was out by about 9x: one wcp feature leaf's topic rows are ~220 KB while its packet is 1,993,499 B, because the
 * packet also renders the evidence bodies the obligations bind. The instrument was not attached to the thing it
 * graded. So the input measure is now the RENDERER ITSELF (`unitPacketBytes`, one composition function shared with
 * `renderUnitPacket`), the proxy is deleted rather than corrected, and `plan-packet-measure.ts` is the only place
 * a plan's bytes come from.
 *
 * WHAT OVERFLOW MAY NOT DO. It may not truncate. An over-budget unit is either DIVIDED — `plan-unit-split.ts`, and
 * a division is checked to partition its obligations exactly — or named as a failure with the offending ids in it.
 * Nothing anywhere caps a list, clips a record or drops a topic to fit.
 */

import { assertNever } from "../base/artifact-result.ts";
import { DETAIL_BUDGETS, type DetailBudget } from "./report-request-v2.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";

export const PLAN_BUDGET_VERSION = "plan-budget-v2";

export interface DetailBudgetAllowance {
  /** The largest packet one unit may be handed, in bytes of rendered packet markdown. */
  readonly perUnitInputBytes: number;
  /** The largest sum over all of one document's units. */
  readonly totalInputBytes: number;
  /**
   * The largest OUTPUT one unit may write: `content.md` plus the canonical bytes of its claims sidecar.
   *
   * THE AUTHORITY, and there is no second one. R4b printed "output budget: NONE DECLARED" into every packet and
   * deferred the number here; a synthesis's input is unbounded until it exists, because a synthesis reads its
   * children's summaries and nothing bounds those. Enforced at DRAFT: over-budget is a named refusal that tells
   * the author to rewrite tighter. Core never deletes content to fit — an upper bound that became a reason to drop
   * `unknowns` or `terminology` entries would buy bytes with exactly the silence this whole epic exists to remove.
   */
  readonly perUnitOutputBytes: number;
  /**
   * The largest SUMMARY one unit may write, measured as the block a parent packet renders for it.
   *
   * It is what makes a synthesis's input finite before any child exists: `children x perUnitSummaryBytes` plus the
   * synthesis packet's own fixed cost is checked against `perUnitInputBytes` at plan time. Measured as the RENDERED
   * child block rather than the canonical JSON so the plan-time arithmetic and the draft-time refusal bound the
   * same bytes.
   */
  readonly perUnitSummaryBytes: number;
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
  readonly perUnitOutputBytes: number;
  readonly perUnitSummaryBytes: number;
}

export interface PlanBudget {
  readonly version: string;
  /** Strictly ascending by `documentId` — one row per recorded request, always. */
  readonly documents: readonly PlanDocumentBudget[];
}

/**
 * The allowances. MEASURED, not guessed — and the input numbers are deliberately unchanged from v1.
 *
 * INPUT. On the wcp R0 baseline the per-unit allowance of `standard` is 786,432 B. Under the true measure the
 * four documents' feature leaves render 1,993,296–1,993,499 B each, which is what R5b's splitter divides; the other
 * twelve units measure 42,108–216,784 B and fit untouched. The numbers were NOT loosened to make the corpus fit:
 * the division granularity now reaches inside a topic (down to a single obligation), so the table does not have to
 * accommodate whatever the largest topic happens to be. If a SINGLE obligation ever renders over `compact`'s
 * 262,144 B, that is a named plan failure and a real finding, reported as one rather than papered over by a bigger
 * number here.
 *
 * OUTPUT. Calibrated against the only real authored bytes this project has, the R0 section probe: the largest real
 * section is 13,477 B of `content.md` plus 35,494 B of canonical claims over 151 claims (234 B per claim), 48,971 B
 * together; a ten-section product overview runs 3,533–9,791 B of content and 4,671–15,308 B of claims per section.
 * `compact` sits at 65,536 B — above the largest section ever produced here, with room — and the ladder doubles
 * from there. A split unit that owns ~340 obligations at 234 B per claim is ~80 KB of claims plus prose, which is
 * why `standard` is 131,072 B.
 *
 * SUMMARY. A summary carries covered topic ids, key statements, unknowns, terminology and three digests; the
 * rendered child block adds the headings a parent reads. 8,192 B for `standard` admits roughly forty statements
 * and twenty terms at the length the R0 prose actually uses, and it is what bounds a synthesis: 786,432 / 8,192 is
 * 96 children before a synthesis packet becomes unsatisfiable, against the 8–10 children a divided wcp document
 * plan produces.
 */
export const PLAN_BUDGET_TABLE: PlanBudgetTable = {
  version: PLAN_BUDGET_VERSION,
  allowances: {
    compact: { perUnitInputBytes: 262_144, totalInputBytes: 1_048_576, perUnitOutputBytes: 65_536, perUnitSummaryBytes: 4_096 },
    standard: { perUnitInputBytes: 786_432, totalInputBytes: 3_145_728, perUnitOutputBytes: 131_072, perUnitSummaryBytes: 8_192 },
    detailed: { perUnitInputBytes: 2_097_152, totalInputBytes: 8_388_608, perUnitOutputBytes: 262_144, perUnitSummaryBytes: 16_384 }
  }
};

/** The four numbers of one allowance, in the order a message lists them. */
export const ALLOWANCE_FIELDS = ["perUnitInputBytes", "totalInputBytes", "perUnitOutputBytes", "perUnitSummaryBytes"] as const;
export type AllowanceField = (typeof ALLOWANCE_FIELDS)[number];

/** Completeness in both directions, plus the three orderings the ladder claims. Injectable so a fixture can fail it. */
export function validatePlanBudgetTable(table: PlanBudgetTable = PLAN_BUDGET_TABLE): void {
  if (!table.version.trim()) throw new Error("The plan budget table must declare its version; it is what a recorded plan's budget names");
  const declared = new Set(Object.keys(table.allowances));
  const missing = DETAIL_BUDGETS.filter((member) => !declared.has(member));
  if (missing.length) throw new Error(`No plan budget allowance is declared for detail budget(s) ${missing.join(", ")}; a request naming one would resolve to no budget`);
  const phantom = [...declared].filter((key) => !(DETAIL_BUDGETS as readonly string[]).includes(key)).sort();
  if (phantom.length) throw new Error(`The plan budget table declares allowances for unknown detail budget(s) ${phantom.join(", ")}; a row no request can name is a dead row that reads like support`);
  for (const [key, allowance] of Object.entries(table.allowances)) {
    for (const field of ALLOWANCE_FIELDS) {
      const value = allowance[field];
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Detail budget ${JSON.stringify(key)} declares ${field} ${JSON.stringify(value)}; every budget number must be a positive integer, and a missing one would leave that side of the contract undeclared`);
      }
    }
    if (allowance.totalInputBytes < allowance.perUnitInputBytes) {
      throw new Error(`Detail budget ${JSON.stringify(key)} declares totalInputBytes ${JSON.stringify(allowance.totalInputBytes)}, which is below its own per-unit allowance; one unit would be unsatisfiable inside a satisfiable document`);
    }
    if (allowance.perUnitOutputBytes >= allowance.perUnitInputBytes) {
      throw new Error(`Detail budget ${JSON.stringify(key)} allows a unit to write ${allowance.perUnitOutputBytes} byte(s) from ${allowance.perUnitInputBytes} byte(s) of packet; a unit that may write more than it reads has an output bound that bounds nothing`);
    }
    if (allowance.perUnitSummaryBytes >= allowance.perUnitOutputBytes) {
      throw new Error(`Detail budget ${JSON.stringify(key)} allows a summary of ${allowance.perUnitSummaryBytes} byte(s) against an output bound of ${allowance.perUnitOutputBytes}; a summary is a projection of the unit it summarises, so a summary bound at or above the output bound bounds nothing`);
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
          totalInputBytes: allowance.totalInputBytes,
          perUnitOutputBytes: allowance.perUnitOutputBytes,
          perUnitSummaryBytes: allowance.perUnitSummaryBytes
        };
      })
  };
}

/**
 * The budget row for one document, or a named refusal.
 *
 * The ONE lookup, so the packet renderer, the draft-time output gate and the plan-time measure all read the same
 * row instead of each finding it their own way. There is deliberately no fallback: a plan with no row for a
 * document is a named failure, never a unit measured against a default nobody chose.
 */
export function documentBudgetRow(budget: PlanBudget, documentId: string): PlanDocumentBudget {
  const row = budget.documents.find((entry) => entry.documentId === documentId);
  if (!row) {
    throw new Error(`The recorded plan budget has no row for document ${JSON.stringify(documentId)}; it holds ${budget.documents.length} row(s): ${budget.documents.map((entry) => entry.documentId).join(", ") || "none"}`);
  }
  return row;
}

const BUDGET_FIELDS = ["documents", "version"] as const;
const DOCUMENT_BUDGET_FIELDS = ["detailBudget", "documentId", ...ALLOWANCE_FIELDS] as const;

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
    for (const key of DOCUMENT_BUDGET_FIELDS) {
      if (!(key in document)) problems.push(`budget documents[${index}] is missing field ${JSON.stringify(key)}`);
    }
    if (typeof document.documentId !== "string" || document.documentId.trim() === "") problems.push(`budget documents[${index}] documentId ${JSON.stringify(document.documentId)} is not a non-empty string`);
    if (typeof document.detailBudget !== "string" || !(DETAIL_BUDGETS as readonly string[]).includes(document.detailBudget)) {
      problems.push(`budget documents[${index}] detailBudget ${JSON.stringify(document.detailBudget)} is not one of: ${DETAIL_BUDGETS.join(", ")}`);
    }
    for (const field of ALLOWANCE_FIELDS) {
      if (!Number.isSafeInteger(document[field]) || (document[field] as number) <= 0) {
        problems.push(`budget documents[${index}] ${field} ${JSON.stringify(document[field])} is not a positive integer`);
      }
    }
  }
  return problems;
}

/** One line per document, in the four numbers' own order. Printed by a packet header and a CLI reading alike. */
export function summariseDocumentBudget(row: PlanDocumentBudget): string {
  return ALLOWANCE_FIELDS.map((field) => `${field}=${budgetField(row, field)}`).join(", ");
}

/** Exhaustive field access, so a fifth budget number has to be given a line before this compiles. */
function budgetField(row: PlanDocumentBudget, field: AllowanceField): number {
  switch (field) {
    case "perUnitInputBytes":
      return row.perUnitInputBytes;
    case "totalInputBytes":
      return row.totalInputBytes;
    case "perUnitOutputBytes":
      return row.perUnitOutputBytes;
    case "perUnitSummaryBytes":
      return row.perUnitSummaryBytes;
  }
  return assertNever(field, "plan budget allowance field");
}
