/**
 * A synthesis unit may re-state its children's facts and may not mint new ones — enforced on the claims, at the
 * collect barrier (R5a).
 *
 * WHAT WAS ALREADY TRUE, AND WHY IT WAS NOT ENOUGH. R4b made "a synthesis writes from child summaries only" a TYPE
 * fact on the input side: `ProposedSynthesisUnit` has no `topicIds` field at all, `UnitDossier`'s synthesis arm has
 * no topics and no evidence map, and the packet renderer refuses a synthesis handed a topic dossier
 * (`unit-packet.ts`'s entry check). So a synthesis cannot be GIVEN raw evidence. But nothing looked at what it
 * WROTE: `unit-draft.ts` runs `validateUnitClaims`, which checks each claim's shape through the section path's own
 * `assertValidClaim` and nothing about where its ids came from, and the grounding audit reads a synthesis as
 * `vacuous` because it reaches no material obligation. A synthesis claim carrying an evidence id copied from
 * anywhere — a leaf of another document, a record no child cited, an id typed by hand — was therefore checked by
 * nothing at all. This file is that hole and nothing else.
 *
 * THE RULE. Every `evidenceIds` and `traceIds` entry of a synthesis unit's claims must already appear in the claims
 * of its OWN children. Re-using a child's id is re-stating a fact the child established and defended, which is what
 * a synthesis is for; a new id is a new fact, which the epic's contract forbids a parent outright. The check is on
 * ids and not on prose, because ids are the only part of a claim that reaches into the evidence ledger — this is a
 * traceability rule, not a paraphrase detector.
 *
 * IT IS A CORE READ AT THE BARRIER, NOT A MODEL INPUT. The children's claims are read from `units/<key>/claims.json`
 * — deterministic bytes already on disk, of children the barrier has just confirmed are COLLECTED — inside the same
 * serial collect step that runs the grounding audit. Nothing here is handed to a model, and nothing here reads a
 * child's prose: only the two id lists.
 *
 * FAIL CLOSED, NEVER PERMANENTLY, and named to the id. A violation names the claim, the field and the offending id,
 * so the fix is mechanical: cite the child's id, or move the fact into the child that owns it. The receipt stays on
 * disk, so a corrected re-draft is collected on the next run — the same contract as every other refusal at that
 * barrier. There is no state a bad synthesis draft can put a run into for good.
 *
 * THREE STATES, NO BOOLEAN. `complete` (at least one referenced id, all of them a child's), `vacuous` (the claims
 * reference no evidence or trace id at all — carrying WHICH emptiness it is, because "this synthesis has no claims"
 * and "its claims cite nothing" are two different things a reader must be able to tell apart) and `violations`.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { SectionClaim } from "../base/types.ts";
import { readJson } from "../base/util.ts";
import type { PlanCatalogUnit } from "./plan-artifacts.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import { parseUnitClaims } from "./unit-output.ts";
import { compareUnitIds, unitPaths } from "./unit-paths.ts";

export const SYNTHESIS_BACKLINK_VERSION = "synthesis-backlink-v1";

/** The two claim fields that reach into this run's ledgers. Pinned, so a third one has to be added deliberately. */
export const BACKLINKED_CLAIM_FIELDS = ["evidenceIds", "traceIds"] as const;
export type BacklinkedClaimField = (typeof BACKLINKED_CLAIM_FIELDS)[number];

/** One child's claims, as the barrier read them from disk. */
export interface ChildClaimSet {
  readonly childUnitId: string;
  readonly claims: readonly SectionClaim[];
}

/** One id a synthesis claim cites that no child of it cites. Named to the claim and the id, never counted. */
export interface BacklinkViolation {
  readonly claimId: string;
  readonly field: BacklinkedClaimField;
  readonly id: string;
  readonly problem: string;
}

export type SynthesisBacklinkVerdict =
  | { readonly conclusion: "complete"; readonly referenced: number; readonly childReferenced: number }
  | { readonly conclusion: "vacuous"; readonly referenced: 0; readonly childReferenced: number; readonly source: string }
  | {
      readonly conclusion: "violations";
      readonly referenced: number;
      readonly childReferenced: number;
      readonly problems: readonly string[];
      /** The offending claims, by id, ascending — what a re-draft has to address. */
      readonly claimIds: readonly string[];
    };

export interface SynthesisBacklinkResult {
  readonly version: typeof SYNTHESIS_BACKLINK_VERSION;
  readonly unitId: string;
  readonly documentId: string;
  /** The children whose claims formed the permitted set, ascending. */
  readonly childUnitIds: readonly string[];
  /** Distinct `field:id` pairs this synthesis cites, ascending. The denominator. */
  readonly referenced: readonly string[];
  /** Distinct `field:id` pairs the children cite — what a synthesis may re-state. */
  readonly childReferenced: readonly string[];
  readonly violations: readonly BacklinkViolation[];
  readonly verdict: SynthesisBacklinkVerdict;
}

/**
 * Which kinds must have their claims traced back to children.
 *
 * Exhaustive with no `default` arm: a fifth kind has to declare whether it may mint facts of its own before this
 * compiles, because the alternative is a new parent kind that silently answers to nothing. Only a synthesis has
 * children at all, and only a synthesis is forbidden its own evidence.
 */
export function requiresChildClaimBacklink(kind: AuthoringUnitKind): boolean {
  switch (kind) {
    case "synthesis":
      return true;
    case "leaf":
    case "bridge":
    case "appendix":
      return false;
  }
  return assertNever(kind, "authoring unit kind");
}

export interface SynthesisBacklinkInput {
  readonly unit: PlanCatalogUnit;
  /** The synthesis unit's own claims sidecar, as written. */
  readonly claims: readonly SectionClaim[];
  /** Its children's claims. Must be exactly the children the plan gives it — checked, not assumed. */
  readonly children: readonly ChildClaimSet[];
}

/** Audit one synthesis unit's claims. Pure: no path, no clock, no I/O — the caller hands over the values it read. */
export function auditSynthesisBacklink(input: SynthesisBacklinkInput): SynthesisBacklinkResult {
  const { unit, claims } = input;
  if (!requiresChildClaimBacklink(unit.kind)) {
    throw new Error(`Unit ${JSON.stringify(unit.unitId)} is a ${unit.kind}, which writes from its own topics; only a synthesis has its claims traced back to children`);
  }
  const named = [...unit.childUnitIds].sort(compareUnitIds);
  const supplied = input.children.map((child) => child.childUnitId).sort(compareUnitIds);
  if (named.length !== supplied.length || named.some((id, index) => id !== supplied[index])) {
    throw new Error(`Synthesis unit ${JSON.stringify(unit.unitId)} writes from children [${named.join(", ")}] but its claims were checked against [${supplied.join(", ")}]; a permitted set built from the wrong children is a different rule`);
  }

  const childReferenced = new Set<string>();
  for (const child of input.children) for (const key of referencedKeys(child.claims)) childReferenced.add(key);

  const referenced = new Set<string>();
  const violations: BacklinkViolation[] = [];
  for (const claim of claims) {
    for (const field of BACKLINKED_CLAIM_FIELDS) {
      for (const id of claim[field] ?? []) {
        const key = `${field}:${id}`;
        referenced.add(key);
        if (childReferenced.has(key)) continue;
        violations.push({
          claimId: claim.id,
          field,
          id,
          problem: `claim ${JSON.stringify(claim.id)} of synthesis unit ${JSON.stringify(unit.unitId)} cites ${field.slice(0, -3)} id ${JSON.stringify(id)}, which none of its children [${named.join(", ")}] cites; a synthesis may re-state a child's fact by reusing the child's own id, and a new id is a new fact it is not allowed to add`
        });
      }
    }
  }

  const ascending = (a: string, b: string): number => a.localeCompare(b);
  return {
    version: SYNTHESIS_BACKLINK_VERSION,
    unitId: unit.unitId,
    documentId: unit.documentId,
    childUnitIds: named,
    referenced: [...referenced].sort(ascending),
    childReferenced: [...childReferenced].sort(ascending),
    violations,
    verdict: verdictOf(unit, claims, referenced.size, childReferenced.size, violations)
  };
}

/** The distinct `field:id` pairs one claim set cites. */
function referencedKeys(claims: readonly SectionClaim[]): readonly string[] {
  const keys: string[] = [];
  for (const claim of claims) {
    for (const field of BACKLINKED_CLAIM_FIELDS) {
      for (const id of claim[field] ?? []) keys.push(`${field}:${id}`);
    }
  }
  return keys;
}

function verdictOf(
  unit: PlanCatalogUnit,
  claims: readonly SectionClaim[],
  referenced: number,
  childReferenced: number,
  violations: readonly BacklinkViolation[]
): SynthesisBacklinkVerdict {
  if (violations.length > 0) {
    return {
      conclusion: "violations",
      referenced,
      childReferenced,
      problems: violations.map((row) => row.problem),
      claimIds: [...new Set(violations.map((row) => row.claimId))].sort((a, b) => a.localeCompare(b))
    };
  }
  if (referenced === 0) {
    return {
      conclusion: "vacuous",
      referenced: 0,
      childReferenced,
      source: claims.length === 0
        ? `synthesis unit ${JSON.stringify(unit.unitId)} records no claim at all, so no id of its own can have left its children's`
        : `the ${claims.length} claim(s) of synthesis unit ${JSON.stringify(unit.unitId)} cite no evidence and no trace id, so nothing had to be traced back to a child (its children cite ${childReferenced})`
    };
  }
  return { conclusion: "complete", referenced, childReferenced };
}

/** One sentence a reader cannot mistake for the other two states. Exhaustive; there is no `passed` boolean. */
export function summariseSynthesisBacklink(result: SynthesisBacklinkResult): string {
  const { verdict } = result;
  switch (verdict.conclusion) {
    case "complete":
      return `complete: every one of the ${verdict.referenced} evidence/trace id(s) synthesis unit ${result.unitId} cites is cited by one of its ${result.childUnitIds.length} child unit(s) (which cite ${verdict.childReferenced} in all)`;
    case "vacuous":
      return `vacuous: synthesis unit ${result.unitId} cites no evidence or trace id, so nothing was traced — ${verdict.source}`;
    case "violations":
      return `violations: synthesis unit ${result.unitId} cites ${verdict.problems.length} of its ${verdict.referenced} evidence/trace id(s) that no child of it cites (offending claim(s): ${verdict.claimIds.join(", ")})`;
  }
  return assertNever(verdict, "synthesis backlink conclusion");
}

/**
 * Audit one synthesis unit from the artifacts on disk. What the collect barrier calls before it records a synthesis.
 *
 * Every sidecar is parsed rather than trusted, and one that sits in the wrong directory is a named refusal — the
 * same check `auditUnitFromDisk` makes, for the same reason: a claims file filed under another unit's key is the
 * shape a path-collapse bug takes, and it must not be read as that unit's claims.
 */
export async function auditSynthesisBacklinkFromDisk(runDir: string, unit: PlanCatalogUnit): Promise<SynthesisBacklinkResult> {
  const own = await readClaimsOf(runDir, unit.unitId);
  const children: ChildClaimSet[] = [];
  for (const childUnitId of [...unit.childUnitIds].sort(compareUnitIds)) {
    children.push({ childUnitId, claims: await readClaimsOf(runDir, childUnitId) });
  }
  return auditSynthesisBacklink({ unit, claims: own, children });
}

async function readClaimsOf(runDir: string, unitId: string): Promise<readonly SectionClaim[]> {
  const paths = unitPaths(runDir, unitId);
  const parsed = parseUnitClaims(await readJson<unknown>(paths.claims));
  if (parsed.claims === null) {
    throw new Error(`${paths.claims} is not a valid unit claims sidecar: ${parsed.problems.join("; ")}`);
  }
  if (parsed.claims.unitId !== unitId) {
    throw new Error(`${paths.claims} records unit ${JSON.stringify(parsed.claims.unitId)}, but it sits in the directory of ${JSON.stringify(unitId)}`);
  }
  return parsed.claims.claims;
}

