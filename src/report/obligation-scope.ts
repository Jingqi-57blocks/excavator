/**
 * `obligationScope` — which of a topic's obligations one unit writes — and the partition law that makes a split
 * incapable of losing one.
 *
 * WHY A SCOPE EXISTS AT ALL. R5b has to make an over-budget unit fit without truncating, and on the measured
 * baseline the smallest structure the catalog offers is already too big: one wcp feature topic renders ~1 MB of
 * packet against a 786,432-byte per-unit allowance, so "one unit per topic" — the last rung of the epic's own
 * ladder sketch — does not terminate. The division therefore has to reach INSIDE a topic, and a unit's topic
 * reference has to be able to say which obligations of that topic are its own.
 *
 * TWO ARMS, BOTH CLOSED, NO DEFAULT. `all` is the whole topic; `work-items` is an explicit, ascending,
 * de-duplicated, NON-EMPTY id list. There is no third form and no omission: a missing scope would default to
 * something, and whichever it defaulted to would silently be wrong for the other case — the remembered-flag
 * failure this codebase has already paid for. An EMPTY explicit list is refused at parse rather than accepted as
 * "nothing": a unit scoped to no obligation is a unit with nothing to write, and a splitter allowed to emit one
 * would have found a way to drop rows while every count still balanced.
 *
 * THE PARTITION LAW IS THE ANTI-TRUNCATION TRIPWIRE, and it is the whole reason this file is not just a type.
 * Within ONE document, the OWNING units that name a topic must partition that topic's binding ids EXACTLY: every
 * id covered, no id covered twice, and no id named that the topic does not bind. Miss one and the obligation
 * silently stops being written by anybody; cover one twice and two units render the same evidence in full again
 * (the duplication R5a removed); name an id the topic does not bind and the plan is describing an obligation that
 * is not there. All three are NAMED violations with the offending ids in them — never counts, never capped.
 *
 * IT IMPORTS NOTHING FROM THE PLAN SIDE, on purpose. `owning` arrives as a boolean the caller derived from
 * `unitTopicRole` (the one spelling of "what naming a topic means for this kind"), so this file can be read by the
 * proposal parser, the ownership derivation and the splitter without any of them importing each other.
 */

import { assertNever } from "../base/artifact-result.ts";

/** The two arms, at runtime, so an unknown scope kind is a named refusal rather than a crash. */
export const OBLIGATION_SCOPE_KINDS = ["all", "work-items"] as const;
export type ObligationScopeKind = (typeof OBLIGATION_SCOPE_KINDS)[number];

export type ObligationScope =
  | { readonly kind: "all" }
  | { readonly kind: "work-items"; readonly workItemIds: readonly string[] };

/** The whole topic. Named rather than spelled inline, so "the unsplit case" reads as one thing everywhere. */
export const FULL_OBLIGATION_SCOPE: ObligationScope = { kind: "all" };

/** Whether one obligation is inside a scope. Exhaustive with no `default`: a third arm must answer this first. */
export function scopeIncludes(scope: ObligationScope, workItemId: string): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "work-items":
      return scope.workItemIds.includes(workItemId);
  }
  return assertNever(scope, "obligation scope kind");
}

/** The ids of `bindingWorkItemIds` this scope selects, in the ledger's own order. Exhaustive over the two arms. */
export function scopedWorkItemIds(scope: ObligationScope, bindingWorkItemIds: readonly string[]): readonly string[] {
  switch (scope.kind) {
    case "all":
      return bindingWorkItemIds;
    case "work-items":
      return bindingWorkItemIds.filter((workItemId) => scope.workItemIds.includes(workItemId));
  }
  return assertNever(scope, "obligation scope kind");
}

/** One sentence a packet header and a failure message can both print. Exhaustive over the two arms. */
export function describeObligationScope(scope: ObligationScope): string {
  switch (scope.kind) {
    case "all":
      return "all — every obligation this topic binds";
    case "work-items":
      return `work-items — ${scope.workItemIds.length} named obligation(s) of this topic`;
  }
  return assertNever(scope, "obligation scope kind");
}

/** How many obligations a scope names explicitly, or `null` for `all`. Used by readings, never by a gate. */
export function scopeSize(scope: ObligationScope): number | null {
  switch (scope.kind) {
    case "all":
      return null;
    case "work-items":
      return scope.workItemIds.length;
  }
  return assertNever(scope, "obligation scope kind");
}

export interface ObligationScopeParse {
  /** Non-null exactly when `problems` is empty. */
  readonly scope: ObligationScope | null;
  readonly problems: readonly string[];
}

const SCOPE_ALL_FIELDS = ["kind"] as const;
const SCOPE_ITEMS_FIELDS = ["kind", "workItemIds"] as const;

/** Parse an untrusted scope. Every problem is data; the caller names the unit and the topic. */
export function parseObligationScope(value: unknown): ObligationScopeParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { scope: null, problems: [`obligationScope ${Array.isArray(value) ? "is an array" : `${JSON.stringify(value)} is not a scope object`}`] };
  }
  const row = value as Record<string, unknown>;
  if (typeof row.kind !== "string" || !(OBLIGATION_SCOPE_KINDS as readonly string[]).includes(row.kind)) {
    return { scope: null, problems: [`obligationScope kind ${JSON.stringify(row.kind)} is not one of: ${OBLIGATION_SCOPE_KINDS.join(", ")}`] };
  }
  const kind = row.kind as ObligationScopeKind;
  const fields = kind === "all" ? SCOPE_ALL_FIELDS : SCOPE_ITEMS_FIELDS;
  const problems: string[] = [];
  const known = new Set<string>(fields);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) {
      problems.push(kind === "all" && key === "workItemIds"
        ? `obligationScope is \`all\` and carries ${JSON.stringify(key)}; \`all\` means the whole topic, so a list beside it would be two answers to one question`
        : `obligationScope has unknown field ${JSON.stringify(key)}`);
    }
  }
  for (const key of fields) {
    if (!(key in row)) problems.push(`obligationScope is missing field ${JSON.stringify(key)}`);
  }
  if (kind === "all") {
    if (problems.length > 0) return { scope: null, problems };
    return { scope: FULL_OBLIGATION_SCOPE, problems: [] };
  }
  const raw = row.workItemIds;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || id.trim() === "")) {
    problems.push(`obligationScope workItemIds ${JSON.stringify(raw)} is not an array of non-empty ids`);
    return { scope: null, problems };
  }
  const ids = raw as string[];
  if (ids.length === 0) {
    problems.push("obligationScope names no work item; a unit scoped to no obligation has nothing to write, and a division that produced one would have dropped rows while every count still balanced");
  }
  const sortedUnique = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  if (ids.length !== sortedUnique.length || ids.some((id, index) => id !== sortedUnique[index])) {
    problems.push(`obligationScope workItemIds ${JSON.stringify(ids)} is not sorted and de-duplicated; two identical plans would then differ by byte`);
  }
  if (problems.length > 0) return { scope: null, problems };
  return { scope: { kind: "work-items", workItemIds: ids }, problems: [] };
}

/** One topic reference, as the partition law needs to see it. */
export interface ScopedTopicReference {
  readonly topicId: string;
  readonly obligationScope: ObligationScope;
}

/**
 * One unit, as the partition law needs to see it.
 *
 * `owning` is a boolean the caller derived from `unitTopicRole`: a `leaf`/`appendix` owns what it names, a `bridge`
 * references it. Only owning units partition a topic — a bridge points at obligations somebody else writes, so
 * requiring it to cover them would make "explain a relation" and "write the rows" the same statement.
 */
export interface ScopePartitionUnit {
  readonly unitId: string;
  readonly documentId: string;
  readonly owning: boolean;
  readonly topics: readonly ScopedTopicReference[];
}

/**
 * Every way one plan's scopes fail to partition their topics, as named problems. Empty means exact partition.
 *
 * `bindingIdsByTopic` maps a topic id to the work item ids that topic binds, in the catalog's own order. A topic id
 * this map does not hold is SKIPPED: plan validation already names an unknown topic as a reference problem, and
 * throwing here would replace a list of named problems with a crash on the first one.
 */
export function scopePartitionProblems(
  bindingIdsByTopic: ReadonlyMap<string, readonly string[]>,
  units: readonly ScopePartitionUnit[]
): string[] {
  const problems: string[] = [];
  const ascending = (a: string, b: string): number => a.localeCompare(b);

  // (1) An explicit scope may only name ids the topic actually binds — checked for EVERY topic-bearing unit,
  // owning or not: a reference to an obligation a topic does not carry is a plan describing something absent.
  for (const unit of [...units].sort((a, b) => ascending(a.unitId, b.unitId))) {
    for (const reference of unit.topics) {
      const bound = bindingIdsByTopic.get(reference.topicId);
      if (bound === undefined) continue;
      if (reference.obligationScope.kind !== "work-items") continue;
      const strangers = reference.obligationScope.workItemIds.filter((workItemId) => !bound.includes(workItemId));
      if (strangers.length === 0) continue;
      problems.push(`unit ${JSON.stringify(unit.unitId)} scopes topic ${JSON.stringify(reference.topicId)} to obligation(s) ${strangers.join(", ")}, which that topic does not bind; a scope selects from a topic's own bindings and cannot introduce one`);
    }
  }

  // (2) Within one document, the OWNING units of one topic partition its bindings exactly.
  for (const documentId of [...new Set(units.map((unit) => unit.documentId))].sort(ascending)) {
    const owning = units.filter((unit) => unit.documentId === documentId && unit.owning).sort((a, b) => ascending(a.unitId, b.unitId));
    const topicIds = [...new Set(owning.flatMap((unit) => unit.topics.map((reference) => reference.topicId)))].sort(ascending);
    for (const topicId of topicIds) {
      const bound = bindingIdsByTopic.get(topicId);
      if (bound === undefined) continue;
      const coveredBy = new Map<string, string[]>();
      for (const workItemId of bound) coveredBy.set(workItemId, []);
      const namingUnits: string[] = [];
      for (const unit of owning) {
        for (const reference of unit.topics) {
          if (reference.topicId !== topicId) continue;
          namingUnits.push(unit.unitId);
          for (const workItemId of scopedWorkItemIds(reference.obligationScope, bound)) {
            coveredBy.get(workItemId)!.push(unit.unitId);
          }
        }
      }
      const missing = bound.filter((workItemId) => coveredBy.get(workItemId)!.length === 0).sort(ascending);
      const duplicated = bound.filter((workItemId) => coveredBy.get(workItemId)!.length > 1).sort(ascending);
      if (missing.length > 0) {
        problems.push(`topic ${JSON.stringify(topicId)} of document ${JSON.stringify(documentId)} binds ${bound.length} obligation(s) and its owning unit(s) ${[...new Set(namingUnits)].sort(ascending).join(", ")} scope ${missing.length} of them to nobody (${missing.join(", ")}); the scopes of a topic's owning units must partition its bindings exactly, or an obligation stops being written by anyone and nothing says so`);
      }
      if (duplicated.length > 0) {
        problems.push(`topic ${JSON.stringify(topicId)} of document ${JSON.stringify(documentId)} has ${duplicated.length} obligation(s) inside the scope of more than one OWNING unit (${duplicated.map((workItemId) => `${workItemId} -> ${coveredBy.get(workItemId)!.join(" + ")}`).join("; ")}); two owners means both grounding the same obligation and rendering its evidence in full twice — a bridge may reference a topic another unit owns, a second owning unit may not`);
      }
    }
  }
  return problems;
}
