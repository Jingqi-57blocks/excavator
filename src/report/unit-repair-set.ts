/**
 * THE REPAIR SET: which authoring units have to be written again, and why — derived from the checker's findings
 * and from nothing else.
 *
 * IT IS EXACT, AND "EXACT" IS THE HARD PART. Every unit in here can name the finding that put it there or the
 * child that pulled it in. There is no "while we are at it" row: a unit redrawn for nothing costs a model call and
 * a new set of bytes to review, and a repair set that habitually names more than it must is one nobody reads
 * closely. So the derivation is two steps and no third: the units the findings NAME, and the units WRITTEN FROM
 * them. The second step goes through `ancestorClosure`, which is the same relation R6a's invalidation plan
 * propagates — one answer to "who else has to be written again", not two.
 *
 * WHY ANCESTORS ARE LOAD-BEARING AND NOT CAUTION. A synthesis is written from its children's SUMMARIES and its
 * own summary records their digests (`childSummaryDigests`). Re-drafting a leaf mints a new summary, so the
 * parent's recorded digests stop matching what is on disk and `unitSummaryAgreementProblems` refuses the parent at
 * its next collect. Leaving ancestors out does not produce a smaller repair — it produces a run that cannot be
 * collected. The falsification is exactly that: drop them and the child-digest check goes red.
 *
 * THE COVERAGE STATEMENTS ARE ROUTED, NOT SEEDED — and this is a deliberate narrowing of R7c's brief, recorded
 * here because it changes what the artifact says. The four-arm union is exhausted (`coverageRepairRoute`), and no
 * arm contributes a unit id. `withheld` obviously cannot: a recorded decision took those rows out of the answer's
 * scope, so there is nothing to repair. `defective` cannot either, and the reason is measured rather than
 * asserted — every one of its nine kinds is owed somewhere other than unit prose:
 *
 *   * `unread-residual`, `displaced-by-budget` — reading budget. Re-drafting a unit reads nothing.
 *   * `cannot-determine`, `open-determination`, `unknown-topic` — the ledger's own determinations. Re-drafting a
 *     unit cannot settle a question the investigation left open.
 *   * `claimed-but-unplaced`, `undispositioned`, `owned-by-no-unit` — the PLAN. The repair is `plan --revise`, and
 *     these entries name obligations, not units; there is no unit to send them to.
 *   * `stated-unknown` — names UNIT IDS, and is the one that would look seedable. It is the count of units whose
 *     summary states an unknown about themselves. Putting those units in a repair set would mean "you are being
 *     redrawn for having been honest", and the only way a redraw removes the row is by deleting the statement. It
 *     is a gate-10 residue to be READ, never a defect to be repaired.
 *
 * So the arms travel out as routes with the clause that says where the debt belongs, and the repair set stays what
 * a re-draw can actually fix. Moving any of this into seeds is a planning-layer decision about
 * `COVERAGE_KIND_CATEGORY`, taken in the open; it is not a line added here.
 *
 * TWO CONSERVATION EQUATIONS, ASSERTED — AND ONLY ONE OF THEM IS REACHABLE, which is recorded here rather than
 * implied. Every finding's units are in the set, and every unit of the set is a unit of the plan. Both are named
 * throws rather than data, because either one failing is a bug in this file. Measured while falsifying them:
 * breaking `ancestorClosure` so it drops its seeds makes the FIRST one fire with its own sentence, so it is
 * load-bearing against a bug in the closure. The SECOND cannot be reached: the closure only ever admits ids it
 * took from the plan, and any injected id that is not in the plan dies inside the closure's own `via` derivation
 * before this file sees it. It stays as depth, unfalsified, and it is not claimed as a tested guard.
 *
 * THERE IS NO WHOLE-DOCUMENT REWRITE ENTRY POINT, and that is mechanical rather than a policy: the plan's only
 * output is a list of unit ids, and the action it prints is the existing revision path. A caller that wanted to
 * rewrite everything would have to ask for every unit id by name.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { CoverageEntryKind, CoverageStatement } from "../investigation/coverage-statement.ts";
import type { TitledCoverageStatement } from "./coverage-companion.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import { ancestorClosure } from "./unit-ancestor-closure.ts";
import { CONSISTENCY_FINDING_KINDS, whyCollectCannotSee, type ConsistencyFinding, type ConsistencyFindingKind } from "./unit-consistency.ts";
import { compareUnitIds } from "./unit-paths.ts";

export const UNIT_REPAIR_SET_VERSION = "unit-repair-set-v1";

/** One planned unit, as the repair derivation needs it. The same four fields the plan catalog records. */
export interface RepairPlanUnit {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  /** Empty for every kind but synthesis. */
  readonly childUnitIds: readonly string[];
}

/** Why one unit is in the repair set. Closed; each arm carries what it names. */
export type RepairReason =
  | {
      readonly cause: "named-by-finding";
      /** The classes that named this unit, ascending in the union's order. Never empty. */
      readonly findingKinds: readonly ConsistencyFindingKind[];
      /** One clause per finding: what it found, and why no collect gate could have caught it. Never empty. */
      readonly statements: readonly string[];
    }
  | {
      readonly cause: "written-from-a-repaired-unit";
      /** The direct children in the repair set that pull this unit in, ascending. Never empty. */
      readonly viaChildUnitIds: readonly string[];
      readonly statement: string;
    };

export interface RepairTarget {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  readonly reason: RepairReason;
}

/** The two equations, as data beside the sentences they stand for. */
export interface RepairConservation {
  readonly findings: number;
  readonly namedUnits: number;
  readonly ancestors: number;
  readonly plannedUnits: number;
  readonly statements: readonly string[];
}

/** Where the debt one coverage statement reports has to be paid. No arm names a unit — see the file header. */
export type CoverageRepairRoute =
  | { readonly route: "nothing-owed"; readonly clause: string }
  | { readonly route: "withheld-by-a-recorded-decision"; readonly clause: string }
  | {
      readonly route: "owed-outside-unit-authoring";
      readonly clause: string;
      readonly owedRows: number;
      /** The defective kinds this statement carries, ascending and distinct. */
      readonly kinds: readonly CoverageEntryKind[];
    };

/** One coverage statement, its arm, and the route its debt takes. */
export interface TitledCoverageRoute {
  readonly title: string;
  readonly state: CoverageStatement["state"];
  readonly route: CoverageRepairRoute;
}

export interface UnitRepairPlan {
  readonly version: typeof UNIT_REPAIR_SET_VERSION;
  /** Ascending by unit id. Empty exactly when the checker found nothing. */
  readonly targets: readonly RepairTarget[];
  readonly conservation: RepairConservation;
  /** Every coverage statement of the run, routed. Order is the input's. */
  readonly coverage: readonly TitledCoverageRoute[];
  /** The one action a repair set asks for. There is no whole-document rewrite to ask for. */
  readonly action: string;
}

export interface UnitRepairPlanInput {
  /** Every unit of the plan now in force. */
  readonly planned: readonly RepairPlanUnit[];
  readonly findings: readonly ConsistencyFinding[];
  readonly coverage: readonly TitledCoverageStatement[];
}

/**
 * Where one coverage statement's debt is paid. Exhaustive over the four arms, no `default`.
 *
 * The return type carries NO unit id, in any arm, which is what makes "coverage does not seed the repair set" a
 * property of the code rather than a discipline. Introducing a seed means changing this type in the open.
 */
export function coverageRepairRoute(statement: CoverageStatement): CoverageRepairRoute {
  switch (statement.state) {
    case "complete":
      return { route: "nothing-owed", clause: `every row of ${statement.ledger} is accounted for, so no unit is owed a repair on its account` };
    case "vacuous":
      return { route: "nothing-owed", clause: `${statement.ledger} recorded no denominator (${statement.source}), so there is nothing a repair could act on` };
    case "withheld":
      return {
        route: "withheld-by-a-recorded-decision",
        clause: `${statement.withheld.reduce((rows, entry) => rows + entry.rows, 0)} row(s) of ${statement.ledger} left this answer's scope by a decision this run recorded; a repair set may never contain them`
      };
    case "defective": {
      const rows = statement.defects.reduce((total, entry) => total + entry.rows, 0);
      return {
        route: "owed-outside-unit-authoring",
        clause: `${rows} row(s) of ${statement.ledger} are owed and unpaid (${statement.defects.map((entry) => entry.kind).join(", ")}); every one of these kinds is owed by the investigation's reading, the obligation ledger's own determinations or the plan, so re-drafting a unit cannot pay it — see the coverage companion for the rows and the file header for why none of them is a repair seed`,
        owedRows: rows,
        kinds: [...new Set(statement.defects.map((entry) => entry.kind))].sort()
      };
    }
  }
  return assertNever(statement, "coverage statement state");
}

/** Derive the repair set. Deterministic: same values, same set, same reasons. */
export function deriveUnitRepairPlan(input: UnitRepairPlanInput): UnitRepairPlan {
  const byId = new Map<string, RepairPlanUnit>();
  for (const unit of input.planned) {
    if (byId.has(unit.unitId)) throw new Error(`The planned unit list holds ${JSON.stringify(unit.unitId)} twice; a unit with two plan rows has none`);
    byId.set(unit.unitId, unit);
  }
  const named = new Map<string, ConsistencyFinding[]>();
  for (const finding of input.findings) {
    if (finding.unitIds.length === 0) {
      throw new Error(`A ${finding.kind} finding in ${JSON.stringify(finding.documentId)} names no unit, so it cannot be repaired by anyone (${finding.statement}); the checker is required to locate every finding it reports`);
    }
    for (const unitId of finding.unitIds) {
      if (!byId.has(unitId)) {
        throw new Error(`A ${finding.kind} finding names unit ${JSON.stringify(unitId)}, which the plan now in force does not hold; a repair set over a unit nothing would draw is not a repair set`);
      }
      named.set(unitId, [...(named.get(unitId) ?? []), finding]);
    }
  }

  const seeds = [...named.keys()].sort(compareUnitIds);
  const closure = ancestorClosure(input.planned.map((unit) => ({ unitId: unit.unitId, childUnitIds: unit.childUnitIds })), seeds);
  const targets: RepairTarget[] = closure.map((row) => {
    const unit = byId.get(row.unitId)!;
    const findings = named.get(row.unitId);
    if (findings) {
      const kinds = CONSISTENCY_FINDING_KINDS.filter((kind) => findings.some((finding) => finding.kind === kind));
      return {
        unitId: unit.unitId,
        documentId: unit.documentId,
        kind: unit.kind,
        reason: {
          cause: "named-by-finding",
          findingKinds: kinds,
          statements: findings.map((finding) => `${finding.kind}: ${finding.statement} — no collect gate catches this because ${whyCollectCannotSee(finding.kind)}`)
        }
      };
    }
    return {
      unitId: unit.unitId,
      documentId: unit.documentId,
      kind: unit.kind,
      reason: {
        cause: "written-from-a-repaired-unit",
        viaChildUnitIds: row.viaChildUnitIds,
        statement: `unit ${unit.unitId} is written from ${row.viaChildUnitIds.length} repaired child unit(s) (${row.viaChildUnitIds.join(", ")}), and its summary records their summary digests; re-drafting a child mints a new summary, so leaving this unit out does not make the repair smaller — it makes the run uncollectable at this unit's next collect`
      }
    };
  });

  const targetIds = new Set(targets.map((target) => target.unitId));
  assertConservation(input, targetIds, byId);
  const conservation: RepairConservation = {
    findings: input.findings.length,
    namedUnits: seeds.length,
    ancestors: targets.length - seeds.length,
    plannedUnits: byId.size,
    statements: [
      `every finding's units are in the repair set: ${input.findings.length} finding(s) naming ${seeds.length} unit(s), all present`,
      `the repair set is inside the plan: ${targets.length} = ${seeds.length} named + ${targets.length - seeds.length} written-from, of ${byId.size} planned unit(s)`
    ]
  };
  return {
    version: UNIT_REPAIR_SET_VERSION,
    targets,
    conservation,
    coverage: input.coverage.map(({ title, statement }) => ({ title, state: statement.state, route: coverageRepairRoute(statement) })),
    action: describeRepairAction(targets)
  };
}

/**
 * The two equations. Both are bugs in this file when they fail, so both throw.
 *
 * EQUATION ONE IS LOAD-BEARING: "every unit a finding names is in the repair set". Break the closure and it fires
 * by name, which is what `tests/unit-repair-set.test.ts` does to it — a finding reported and then dropped is worse
 * than one never made, and this is the throw that says so.
 *
 * EQUATION TWO IS STRUCTURALLY UNREACHABLE, AND IT IS KEPT AS DEPTH WITH NO CLAIM TO BEING A TESTED GUARD
 * (57B-434, item #13, raised by R7c). It asks whether the repair set stays inside the plan. It cannot fail, because
 * every id that could put it outside dies earlier, in one of four named refusals:
 *
 *   1. a finding naming a unit the plan does not hold — refused in `deriveUnitRepairPlan` above, before the
 *      closure is even called ("a repair set over a unit nothing would draw is not a repair set");
 *   2. the same id as a closure SEED — refused by `ancestorClosure` ("a repair set may only name units this plan
 *      holds");
 *   3. a child edge pointing at an id the plan does not hold — refused by `ancestorClosure`'s edge-completeness
 *      check, which is what would otherwise let a foreign id in through a `via` derivation;
 *   4. one plan row handed in twice under one id — refused twice, by `byId` above and by `ancestorClosure`'s own
 *      duplicate check.
 *
 * And beyond those refusals the closure's membership set is SEEDED from ids it verified and only ever grows by
 * iterating the plan's own rows, so its output is a subset of the plan by construction. (The two examples this
 * note used to give as reasons equation two is not implied by equation one — a duplicated plan row, a closure
 * returning an unheld unit — are exactly cases 4 and 2 above: both are caught before this function runs. The
 * reasoning is corrected here rather than left standing, because it read as if this throw were reachable.)
 *
 * IT IS NOT DELETED for the same reason `assertPlanEpoch` is not: the property it states — the repair set is a
 * subset of the plan now in force — is what makes `plannedUnits` a denominator rather than a number, and it is held
 * today by four separate refusals in two files. An unexercised throw is the one nobody notices going missing.
 *
 * WHEN TO COME BACK: the day the closure admits an id from any source other than the plan's own rows — a repair
 * set seeded from a ledger, an archived plan, or another run — this stops being depth and becomes the first line.
 * At that point it needs a reachability fixture through the real entry point, not a hand-made input.
 */
function assertConservation(
  input: UnitRepairPlanInput,
  targetIds: ReadonlySet<string>,
  planned: ReadonlyMap<string, RepairPlanUnit>
): void {
  for (const finding of input.findings) {
    const missing = finding.unitIds.filter((unitId) => !targetIds.has(unitId));
    if (missing.length > 0) {
      throw new Error(`The repair set omits ${missing.length} unit(s) a ${finding.kind} finding names (${missing.join(", ")}); a finding reported and then dropped is worse than one never made`);
    }
  }
  const outside = [...targetIds].filter((unitId) => !planned.has(unitId)).sort(compareUnitIds);
  if (outside.length > 0) {
    throw new Error(`The repair set names ${outside.length} unit(s) the plan now in force does not hold (${outside.join(", ")}); nothing would draw them`);
  }
}

/** The one action. Named units only; there is no argument that means "the whole document". */
function describeRepairAction(targets: readonly RepairTarget[]): string {
  if (targets.length === 0) {
    return "nothing to repair: the checker found no cross-unit defect, so no unit needs to be written again";
  }
  return `re-draft and re-collect exactly these ${targets.length} unit(s) — ${targets.map((target) => target.unitId).join(", ")} — through the existing revision path (draft --unit … then collect --units), then assemble --units --mode write. Every other unit of the plan is left as it is; there is no whole-document rewrite to ask for.`;
}
