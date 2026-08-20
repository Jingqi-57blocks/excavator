/**
 * The plan proposal: what a planner (a model, or the model-free fixture generator) is allowed to say about how a
 * report gets written — and nothing else.
 *
 * A PROPOSAL IS UNTRUSTED INPUT. It arrives as bytes from outside Core, so every field is parsed and every parse
 * failure is fatal and named. There is no arm that returns a partially understood proposal: a row this file cannot
 * classify is a refusal, never a row that lands in some default bucket. `assertNever` closes each switch, so
 * adding a unit kind without saying what it may hang off is a typecheck failure rather than a kind that silently
 * validates against nothing.
 *
 * WHAT THE PROPOSAL MAY NOT CARRY. No counts, no coverage percentages, no materiality, no topic content. R2's
 * rule moves up here unchanged: the DENOMINATOR ONLY EVER COMES FROM THE CATALOG. A proposal that carried its own
 * "12 of 14 topics covered" would be a document grading itself, so the schema has nowhere to put one. What it does
 * echo is the BUDGET, and that is echoed to be compared: the validator re-derives the budget from the requests and
 * refuses a proposal whose echo differs, which is why the echo is required rather than optional.
 *
 * WHY `synthesis` HAS NO `topicIds` FIELD AT ALL. The epic's rule is that a synthesis unit writes from child
 * summaries only; if the field existed and merely had to be empty, an unread `topicIds: [...]` would be a plan
 * that reaches past its children into raw topic dossiers. Making it absent from the arm turns that into an unknown
 * field on a synthesis row — a named parse failure — which is the only version of the rule a reader cannot forget.
 *
 * DISPOSITIONS STAY UNPARSED HERE, DELIBERATELY. The six states, their per-state field arity and the
 * unknown-may-not-be-not-applicable rule all live in `topic-disposition.ts`, and they are audit rules: a second
 * parser here would be a second copy of an audit rule, which is how the two drift and the weaker one wins. This
 * file checks that `dispositions` is an array and passes the rows through; the validator hands them to R2's
 * validator, whose problems are reported per row and per facet.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { PlanBudget } from "./plan-budget.ts";
import { planBudgetProblems } from "./plan-budget.ts";

export const PLAN_PROPOSAL_VERSION = "plan-proposal-v1";

/**
 * The four unit kinds, sorted. `leaf` writes from a bounded topic dossier, `synthesis` only from child
 * summaries, `bridge` explains a relation that no single topic owns, and `appendix` is the deterministic tail
 * (coverage, unknowns, glossary) — which is why it is the one kind allowed to carry no topic at all.
 */
export const AUTHORING_UNIT_KINDS = ["appendix", "bridge", "leaf", "synthesis"] as const;
export type AuthoringUnitKind = (typeof AUTHORING_UNIT_KINDS)[number];

interface ProposedUnitCommon {
  readonly unitId: string;
  readonly documentId: string;
  readonly title: string;
}

/** A unit that writes from topics it names. Ascending, de-duplicated topic ids. */
export interface ProposedTopicUnit extends ProposedUnitCommon {
  readonly kind: "appendix" | "bridge" | "leaf";
  readonly topicIds: readonly string[];
}

/** A unit that writes from its children's summaries. It has no `topicIds` field — see the header. */
export interface ProposedSynthesisUnit extends ProposedUnitCommon {
  readonly kind: "synthesis";
  readonly childUnitIds: readonly string[];
}

export type ProposedUnit = ProposedTopicUnit | ProposedSynthesisUnit;

export interface PlanProposal {
  readonly version: typeof PLAN_PROPOSAL_VERSION;
  /** Strictly ascending by `unitId`, so two identical plans cannot differ by byte. */
  readonly units: readonly ProposedUnit[];
  /** One row per material topic, in the six states. Unparsed here on purpose; R2's validator owns the rules. */
  readonly dispositions: readonly unknown[];
  /** Echoed from the packet, re-derived and compared by the validator. */
  readonly budget: PlanBudget;
}

export interface PlanProposalParse {
  /** Non-null exactly when `problems` is empty. */
  readonly proposal: PlanProposal | null;
  readonly problems: readonly string[];
}

const PROPOSAL_FIELDS = ["budget", "dispositions", "units", "version"] as const;
const TOPIC_UNIT_FIELDS = ["documentId", "kind", "title", "topicIds", "unitId"] as const;
const SYNTHESIS_UNIT_FIELDS = ["childUnitIds", "documentId", "kind", "title", "unitId"] as const;

/**
 * The topic/child arity every kind must satisfy.
 *
 * Exhaustive with no `default` arm: the trailing `assertNever` is what makes deleting a kind a typecheck failure
 * instead of a kind whose arity nobody checks. `appendix` is the only kind allowed to name no topic, and it is
 * allowed because the deterministic tail of a document exists whether or not the catalog holds a topic for it —
 * which is exactly the zero-feature shape the second baseline target has.
 */
export function unitArityProblems(unit: ProposedUnit): string[] {
  switch (unit.kind) {
    case "leaf":
      return unit.topicIds.length >= 1 ? []
        : [`leaf unit ${JSON.stringify(unit.unitId)} names no topic; a leaf writes from a topic dossier, so it would have nothing to write from`];
    case "bridge":
      return unit.topicIds.length >= 2 ? []
        : [`bridge unit ${JSON.stringify(unit.unitId)} names ${unit.topicIds.length} topic(s); a bridge explains a relation between topics and needs at least two`];
    case "appendix":
      return [];
    case "synthesis":
      return unit.childUnitIds.length >= 1 ? []
        : [`synthesis unit ${JSON.stringify(unit.unitId)} names no child unit; a synthesis writes from child summaries, so it would have nothing to write from`];
  }
  return assertNever(unit, "authoring unit kind");
}

/** The topics a unit names, exhaustively over the kinds: a synthesis names none, by construction. */
export function unitTopicIds(unit: ProposedUnit): readonly string[] {
  switch (unit.kind) {
    case "leaf":
    case "bridge":
    case "appendix":
      return unit.topicIds;
    case "synthesis":
      return [];
  }
  return assertNever(unit, "authoring unit kind");
}

/** The child units a unit names, exhaustively over the kinds: only a synthesis has children. */
export function unitChildIds(unit: ProposedUnit): readonly string[] {
  switch (unit.kind) {
    case "leaf":
    case "bridge":
    case "appendix":
      return [];
    case "synthesis":
      return unit.childUnitIds;
  }
  return assertNever(unit, "authoring unit kind");
}

/** Parse an untrusted proposal. Returns every problem, as data; the caller names the source and the severity. */
export function parsePlanProposal(value: unknown): PlanProposalParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { proposal: null, problems: [`is ${Array.isArray(value) ? "an array" : JSON.stringify(value)}, not a proposal object`] };
  }
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(PROPOSAL_FIELDS);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of PROPOSAL_FIELDS) {
    if (!(key in row)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  if (row.version !== PLAN_PROPOSAL_VERSION) problems.push(`version ${JSON.stringify(row.version)} is not ${PLAN_PROPOSAL_VERSION}`);
  if (!Array.isArray(row.dispositions)) problems.push(`dispositions ${JSON.stringify(row.dispositions)} is not an array; a plan carries one disposition row per material topic`);
  problems.push(...planBudgetProblems(row.budget));

  const units: ProposedUnit[] = [];
  if (!Array.isArray(row.units)) {
    problems.push(`units ${JSON.stringify(row.units)} is not an array`);
  } else {
    let previousId: string | null = null;
    for (const [index, rawUnit] of (row.units as unknown[]).entries()) {
      const parsed = parseUnit(rawUnit);
      if (parsed.unit === null) {
        for (const problem of parsed.problems) problems.push(`units[${index}] ${problem}`);
        continue;
      }
      for (const problem of unitArityProblems(parsed.unit)) problems.push(`units[${index}] ${problem}`);
      if (previousId !== null && parsed.unit.unitId.localeCompare(previousId) <= 0) {
        problems.push(`units[${index}] unitId ${JSON.stringify(parsed.unit.unitId)} does not follow ${JSON.stringify(previousId)}; the units must be strictly ascending by unit id`);
      }
      previousId = parsed.unit.unitId;
      units.push(parsed.unit);
    }
  }
  if (problems.length > 0) return { proposal: null, problems };
  return {
    proposal: {
      version: PLAN_PROPOSAL_VERSION,
      units,
      dispositions: row.dispositions as readonly unknown[],
      budget: row.budget as PlanBudget
    },
    problems: []
  };
}

interface UnitParse {
  readonly unit: ProposedUnit | null;
  readonly problems: readonly string[];
}

function parseUnit(value: unknown): UnitParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { unit: null, problems: [`is ${Array.isArray(value) ? "an array" : JSON.stringify(value)}, not a unit object`] };
  }
  const row = value as Record<string, unknown>;
  if (typeof row.kind !== "string" || !(AUTHORING_UNIT_KINDS as readonly string[]).includes(row.kind)) {
    return { unit: null, problems: [`kind ${JSON.stringify(row.kind)} is not one of: ${AUTHORING_UNIT_KINDS.join(", ")}`] };
  }
  const kind = row.kind as AuthoringUnitKind;
  const fields = kind === "synthesis" ? SYNTHESIS_UNIT_FIELDS : TOPIC_UNIT_FIELDS;
  const problems: string[] = [];
  const known = new Set<string>(fields);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) {
      problems.push(kind === "synthesis" && key === "topicIds"
        ? `is a synthesis unit carrying ${JSON.stringify(key)}; a synthesis writes from child summaries only and may never hang a topic directly`
        : `has unknown field ${JSON.stringify(key)}`);
    }
  }
  for (const key of fields) {
    if (!(key in row)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  for (const key of ["unitId", "documentId", "title"] as const) {
    if (typeof row[key] !== "string" || (row[key] as string).trim() === "") problems.push(`${key} ${JSON.stringify(row[key])} is not a non-empty string`);
  }
  const listField = kind === "synthesis" ? "childUnitIds" : "topicIds";
  const ids = idList(row[listField], listField, problems);
  if (problems.length > 0) return { unit: null, problems };
  const common = { unitId: row.unitId as string, documentId: row.documentId as string, title: row.title as string };
  return {
    unit: kind === "synthesis"
      ? { kind, ...common, childUnitIds: ids! }
      : { kind, ...common, topicIds: ids! },
    problems: []
  };
}

/** Ascending and de-duplicated, so one plan has one byte form. An unsorted list is a named failure, not sorted here. */
function idList(value: unknown, field: string, problems: string[]): readonly string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.trim() === "")) {
    problems.push(`${field} ${JSON.stringify(value)} is not an array of non-empty ids`);
    return null;
  }
  const ids = value as string[];
  const sortedUnique = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  if (ids.length !== sortedUnique.length || ids.some((id, index) => id !== sortedUnique[index])) {
    problems.push(`${field} ${JSON.stringify(ids)} is not sorted and de-duplicated; two identical plans would then differ by byte`);
    return null;
  }
  return ids;
}
