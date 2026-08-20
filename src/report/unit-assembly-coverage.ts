/**
 * WHY UNIT ASSEMBLY SHIPS EVERY ARM OF EVERY COVERAGE STATEMENT — as four branches the compiler counts, not as a
 * paragraph asking the next author to be careful.
 *
 * WHAT THIS REPLACES. Until the arm split there was one arm named `violations` holding both a plan legitimately
 * omitting a topic for an audience and an unread residual nothing measured, and `unit-assembly-source.ts` carried a
 * six-line paragraph arguing why assembly must not gate on it. That paragraph existed because the arm NAME pulled
 * its author toward a gate — three times, by that author's own account — and prose was the only thing available to
 * push back. Prose loses: it is not consulted by the next consumer, and it cannot be run. Now the union names the
 * distinction (`withheld` vs `defective`) and this file spends it: every arm gets its own clause, `assertNever`
 * closes the switch, and putting a gate here means deleting a branch in the open rather than writing one line that
 * looked right.
 *
 * WHY EVEN `defective` SHIPS. A defective statement means this run OWES rows — an unread residual, a displaced
 * read, an obligation nobody grounds. Refusing to assemble it would make the run that reports its debt honestly the
 * one nobody can read, while a run whose ledgers happen to be empty assembles fine; gate 10 exists precisely so the
 * residue reaches a reader, and it cannot reach one out of a document that was never written. Defect GATING belongs
 * to the cross-unit checker, which turns statements into a repair set of unit ids — a different artifact, at a
 * different time, with somewhere to send the answer.
 *
 * IT DECIDES NOTHING ELSE. Assembly's own refusals (every planned unit collected, every ledger promise still true,
 * no path shared with the section path) are unaffected and live where they were.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { CoverageStatement } from "../investigation/coverage-statement.ts";
import type { TitledCoverageStatement } from "./coverage-companion.ts";

/** One coverage statement this assembly placed, and why its arm is not a gate. */
export interface ShippedCoverageArm {
  readonly title: string;
  readonly state: CoverageStatement["state"];
  /** The clause this arm ships under. One per arm, exhaustive — see `armShipsBecause`. */
  readonly shippedBecause: string;
}

/**
 * Why one arm is assembled rather than refused. Exhaustive over the four arms with no `default`.
 *
 * A fifth arm cannot be added to the union without answering this question, and a gate cannot be introduced without
 * changing this function's return type — which is the entire point of it existing instead of a comment.
 */
export function armShipsBecause(statement: CoverageStatement): string {
  switch (statement.state) {
    case "complete":
      return "every row of this denominator is accounted for, so there is nothing for a gate to catch";
    case "vacuous":
      return "this run recorded no denominator at all, and a document stating that is the correct output, not a failure";
    case "withheld":
      return "every row it names left this answer's scope by a decision this run recorded, so nobody owes them and there is nothing to repair";
    case "defective":
      return "the rows it names are owed and unpaid, and a run that reports its own debt must still be readable; the debt is stated in the coverage companion, and the repair set belongs to the cross-unit checker rather than to assembly";
  }
  return assertNever(statement, "coverage statement state");
}

/** Every statement an assembly places, with the arm it took and the clause it ships under. Order is the input's. */
export function shippedCoverageArms(statements: readonly TitledCoverageStatement[]): readonly ShippedCoverageArm[] {
  return statements.map(({ title, statement }) => ({
    title,
    state: statement.state,
    shippedBecause: armShipsBecause(statement)
  }));
}
