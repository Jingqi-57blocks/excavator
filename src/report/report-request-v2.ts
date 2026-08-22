/**
 * ReportRequest v2 — the request model with reader, boundary, document task and detail budget pulled apart.
 *
 * The legacy `Audience` (`product` | `engineering` | `prd`) is three dimensions wearing one word: `product` names
 * a READER, `prd` names a DOCUMENT TASK, and `DocumentKind` carries the KNOWLEDGE BOUNDARY. Nothing downstream
 * can ask for "this feature, for a product manager, as a reference" because the vocabulary has no room for it.
 * Splitting the word is the whole point of this model; the four dimensions are independent by construction.
 *
 * This slice DECLARES the model and records what it produced. The only producer is the legacy mapping in
 * `legacy-request-mapping.ts`, and nothing reads a row back to steer authoring yet — that cutover is the epic's
 * R3+. Every field is required, with no optional-with-default anywhere: the row is machine-written by one
 * function into an artifact later slices will treat as the request of record, so an omitted field would be a
 * hole no caller could have meant, normalised differently by each future reader.
 */

import { assertNever } from "../base/artifact-result.ts";

/** The knowledge boundary. `project` is the whole scope; every other member addresses its members by id. */
export const REPORT_SCOPES = ["project", "domain", "feature", "flow", "component", "change"] as const;
export type ReportScope = (typeof REPORT_SCOPES)[number];

/** The reader. Decides which concerns are in view and how deep the terminology goes — never which facts exist. */
export const REPORT_AUDIENCES = ["product-manager", "engineer", "architect", "sre", "qa", "security", "executive"] as const;
export type ReportAudience = (typeof REPORT_AUDIENCES)[number];

/** The document's task, and with it how the document is read. Orthogonal to the reader. */
export const REPORT_INTENTS = ["overview", "deep-dive", "onboarding", "reference", "prd", "audit", "decision-support", "change-impact"] as const;
export type ReportIntent = (typeof REPORT_INTENTS)[number];

/**
 * How much room the document gets. It decides granularity, never whether a fact exists — an unknown stays an
 * unknown at `compact`, it does not become a not-applicable.
 */
export const DETAIL_BUDGETS = ["compact", "standard", "detailed"] as const;
export type DetailBudget = (typeof DETAIL_BUDGETS)[number];

export interface ReportRequestV2 {
  readonly scope: ReportScope;
  /**
   * The scope's members, by id. Required and possibly empty rather than optional: `project` carrying no ids is a
   * fact about the project boundary, not a caller who said nothing, and the two must not share one encoding.
   */
  readonly scopeIds: readonly string[];
  readonly audience: ReportAudience;
  readonly intent: ReportIntent;
  readonly detailBudget: DetailBudget;
  readonly language: string;
  /** The `ReportPolicyRegistry` version whose lens and intent policies this request was resolved against. */
  readonly policyVersion: string;
}

export interface ReportRequestV2Parse {
  /** Non-null exactly when `problems` is empty. */
  readonly request: ReportRequestV2 | null;
  readonly problems: readonly string[];
}

/** Field names of `ReportRequestV2`. An extra key means the row was written by something else, so it is named. */
const REQUEST_FIELDS = ["audience", "detailBudget", "intent", "language", "policyVersion", "scope", "scopeIds"] as const;

/**
 * Parse an untrusted value (a line of a recorded artifact, a hand-edited file) into a v2 request.
 *
 * Returns every problem rather than the first, and returns them as data: the caller names the file and decides
 * the severity, so one fact never gets two severities at two call sites.
 */
export function parseReportRequestV2(value: unknown): ReportRequestV2Parse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { request: null, problems: [`is ${Array.isArray(value) ? "an array" : JSON.stringify(value)}, not a request object`] };
  }
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(REQUEST_FIELDS);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  const scope = enumMember(row.scope, REPORT_SCOPES, "scope", problems);
  const audience = enumMember(row.audience, REPORT_AUDIENCES, "audience", problems);
  const intent = enumMember(row.intent, REPORT_INTENTS, "intent", problems);
  const detailBudget = enumMember(row.detailBudget, DETAIL_BUDGETS, "detailBudget", problems);
  const language = nonEmptyString(row.language, "language", problems);
  const policyVersion = nonEmptyString(row.policyVersion, "policyVersion", problems);
  const scopeIds = stringList(row.scopeIds, "scopeIds", problems);
  if (scope !== null && scopeIds !== null) problems.push(...scopeArityProblems(scope, scopeIds));
  if (problems.length > 0 || scope === null || audience === null || intent === null || detailBudget === null
    || language === null || policyVersion === null || scopeIds === null) {
    return { request: null, problems };
  }
  return { request: { scope, scopeIds, audience, intent, detailBudget, language, policyVersion }, problems: [] };
}

/**
 * How many ids each scope must name.
 *
 * Exhaustive with no `default` arm: the trailing `assertNever` is what makes deleting a scope from the switch a
 * typecheck failure instead of a silently unchecked scope.
 */
function scopeArityProblems(scope: ReportScope, scopeIds: readonly string[]): string[] {
  switch (scope) {
    case "project":
      return scopeIds.length === 0 ? []
        : [`scope "project" names ${scopeIds.length} scopeIds; the project boundary is the whole scope and is not addressed by id`];
    case "domain":
    case "feature":
    case "flow":
    case "component":
    case "change":
      return scopeIds.length > 0 ? []
        : [`scope ${JSON.stringify(scope)} names no scopeIds, so its knowledge boundary would be undefined`];
  }
  return assertNever(scope, "report scope");
}

function enumMember<T extends string>(value: unknown, allowed: readonly T[], field: string, problems: string[]): T | null {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  problems.push(`${field} ${JSON.stringify(value)} is not one of: ${allowed.join(", ")}`);
  return null;
}

function nonEmptyString(value: unknown, field: string, problems: string[]): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  problems.push(`${field} ${JSON.stringify(value)} is not a non-empty string`);
  return null;
}

function stringList(value: unknown, field: string, problems: string[]): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    problems.push(`${field} ${JSON.stringify(value)} is not an array of non-empty strings`);
    return null;
  }
  const ids = value as string[];
  const sortedUnique = [...new Set(ids)].sort();
  if (ids.length !== sortedUnique.length || ids.some((id, index) => id !== sortedUnique[index])) {
    problems.push(`${field} ${JSON.stringify(ids)} is not sorted and deduplicated, so two requests for one boundary could differ by byte`);
    return null;
  }
  return ids;
}
