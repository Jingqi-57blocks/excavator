import { assertNever, built, notApplicable, unavailable, type ArtifactResult } from "../src/base/artifact-result.ts";
import { summarizeCoverage, summarizeSelection, type CoverageConservation, type SelectionConservation } from "../src/base/conservation.ts";
import {
  CORPUS_MEMBERSHIP, moduleMembership, relationMembership, spanSetMembership, unitMembership,
  type Membership
} from "../src/base/fact-kind-registry.ts";
import { RowSet } from "../src/base/row-set.ts";

/**
 * The interface laws of `docs/layering.md` §二 that hold at COMPILE time, and the fixtures that prove they do.
 *
 * This file is never executed. It is not named `*.test.ts`, so `npm test`'s `tests/*.test.ts` glob does not pick
 * it up; it IS inside `tsconfig.json`'s `tests/**\/*.ts` include, so `npm run typecheck` does. Every `@ts-expect-error`
 * below is therefore a live tripwire in BOTH directions: if the constraint it names ever stops holding, the
 * suppressed error disappears, TypeScript reports the now-unnecessary `@ts-expect-error`, and typecheck goes red.
 * A compile-time rule with no failing fixture is a comment.
 *
 * Four laws, four fixtures:
 *
 *  1. The envelope is exhaustively consumed. A consumer that forgets a branch cannot reach `assertNever`.
 *  2. A denominator is a `RowSet` from a lower ledger, never a hand-assembled array and never a direct `new`.
 *  3. A conservation record can only come from its one constructor, never from a literal with the right numbers.
 *  4. Membership is a closed union with no empty-set arm, consumed exhaustively and built only by constructors.
 */

// --- 1. the output law: three states, consumed exhaustively -----------------------------------------------

/** The shape every consumer must have: all three arms, and `assertNever` reachable only when they are present. */
export function describeResult(result: ArtifactResult<number>): string {
  switch (result.status) {
    case "built": return `built:${result.value}`;
    case "not-applicable": return `na:${result.determination}`;
    case "unavailable": return `un:${result.cause}`;
    default: return assertNever(result, "artifact result");
  }
}

/**
 * The same consumer with the `unavailable` branch left out.
 *
 * This is the fixture for "a fourth spelling of failure cannot be introduced in a producer without a compile
 * error at every consumer" — read in the other direction, it is also the guard against a consumer QUIETLY
 * dropping a state it is supposed to handle. `result` is still `Unavailable` in the default arm, so it is not
 * assignable to `never`.
 */
export function forgetsAState(result: ArtifactResult<number>): string {
  switch (result.status) {
    case "built": return `built:${result.value}`;
    case "not-applicable": return `na:${result.determination}`;
    // @ts-expect-error a switch that does not handle `unavailable` may not reach the exhaustiveness sink
    default: return assertNever(result, "artifact result");
  }
}

/** Positive control: the three constructors are the only way to make one, and they all typecheck. */
export const results: Array<ArtifactResult<number>> = [
  built(1),
  notApplicable("not-detected", ["ledger/files.json"], "digest"),
  unavailable("the binding is missing", true)
];

// --- 2. the denominator law: a RowSet, from a ledger -------------------------------------------------------

/** Anything that publishes a ratio takes the denominator as a RowSet, so the type states where it came from. */
function coverageRatio(numerator: number, denominator: RowSet): number {
  return denominator.size === 0 ? 0 : numerator / denominator.size;
}

export const legitimateDenominator = RowSet.fromLedgerCounted(
  [{ relativePath: "src/base/util.ts" }],
  {
    artifact: "ledger/files.json",
    contentDigest: "digest",
    producerVersion: "scanner-v2",
    completeness: { capReached: false, skippedByCap: 0, droppedRoots: [] }
  }
);

export const legitimateRatio = coverageRatio(1, legitimateDenominator);

// @ts-expect-error the constructor is private: the factories are the only door, and each one demands a ledger identity
export const bypassed = new RowSet("file", "file", { artifact: "x", contentDigest: "y", producerVersion: "z", completeness: { capReached: false, skippedByCap: 0, droppedRoots: [] } }, ["a.ts"]);

// @ts-expect-error a bare string[] is not a denominator — it carries no unit kind, no corpus identity and no completeness
export const bareArrayDenominator = coverageRatio(1, ["src/base/util.ts", "src/base/types.ts"]);

// --- 3. the three-state law: one constructor per axis ------------------------------------------------------

export const coverage: CoverageConservation = summarizeCoverage({ total: 10, counted: 7, excluded: 3 });
export const selection: SelectionConservation = summarizeSelection({ counted: 7, seated: 2, zeroScore: 4, displaced: 1 });

// @ts-expect-error four correct numbers are not a conservation record; the brand's key is unreachable outside its module
export const forgedCoverage: CoverageConservation = { total: 10, counted: 7, excluded: 3, unexplained: 0 };

// @ts-expect-error same for the selection axis: copying the arithmetic into another layer is a compile error there
export const forgedSelection: SelectionConservation = { counted: 7, seated: 2, zeroScore: 4, displaced: 1 };

/**
 * And the residual cannot be re-declared away. `unexplained` is derived by the constructor, so a caller cannot
 * pass one in — an artifact that "has no unexplained rows" has to actually have none.
 */
// @ts-expect-error `unexplained` is a subtraction the constructor performs, never an input a caller supplies
export const suppliedResidual = summarizeCoverage({ total: 10, counted: 7, excluded: 3, unexplained: 0 });

// --- 4. membership: a closed union, exhaustively consumed ---------------------------------------------------

/** The shape every membership consumer must have: all five arms, and `assertNever` reachable only with them. */
export function describeMembership(membership: Membership): string {
  switch (membership.kind) {
    case "unit": return `unit:${membership.unitId}`;
    case "span-set": return `span-set:${membership.unitIds.length}`;
    case "relation": return `relation:${membership.endpoints.length}`;
    case "module": return `module:${membership.moduleId}`;
    case "corpus": return "corpus";
    default: return assertNever(membership, "membership");
  }
}

/**
 * The same consumer with the `corpus` arm left out — the arm that is easiest to forget, because it is the one
 * with no ids in it, and the one whose seat verdict is `NotApplicable` rather than a cell.
 */
export function forgetsCorpus(membership: Membership): string {
  switch (membership.kind) {
    case "unit": return `unit:${membership.unitId}`;
    case "span-set": return `span-set:${membership.unitIds.length}`;
    case "relation": return `relation:${membership.endpoints.length}`;
    case "module": return `module:${membership.moduleId}`;
    // @ts-expect-error a switch that does not handle `corpus` may not reach the exhaustiveness sink
    default: return assertNever(membership, "membership");
  }
}

/** Positive control: the constructors are the only door, and every arm goes through one. */
export const memberships: Membership[] = [
  unitMembership("cell:structure:0-40:src/app.ts"),
  spanSetMembership(["cell:structure:0-40:src/app.ts", "cell:residual:40-60:src/app.ts"]),
  relationMembership(["cell:structure:0-40:src/app.ts", "cell:structure:0-90:web/page.tsx"]),
  moduleMembership("api"),
  CORPUS_MEMBERSHIP
];

/**
 * And the empty set is refused at RUNTIME rather than at compile time, on purpose: `readonly string[]` cannot
 * express non-emptiness without a tuple type that would reject a producer's ordinary array. The compile-time half
 * is that no other arm exists to slip an empty collection through — every arm is built by a constructor above,
 * and `tests/fact-kind-registry.test.ts` holds the throwing fixtures.
 */
// @ts-expect-error an object literal with the right fields is still a Membership, but a NEW arm is not
export const invented: Membership = { kind: "file", relativePath: "src/app.ts" };
