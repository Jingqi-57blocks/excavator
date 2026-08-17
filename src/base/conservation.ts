/**
 * The two conservation laws, each with exactly ONE constructor.
 *
 * The three-state law (`docs/layering.md` §四) says every set-valued output is a complete partition along one
 * of two axes, and that each axis has a single constructor so no layer grows a second copy of the arithmetic:
 *
 *   coverage  `total = counted + excluded + unexplained`   (layers 1, 2, 5)
 *   selection `counted = seated + zero-score + displaced`  (layer 4)
 *
 * A rule enforced by review is a rule that holds until the next file. So the records these constructors return
 * carry a BRAND keyed by a symbol this module does not export: the type is public, the key is unreachable, and
 * an object literal with the four right numbers is therefore not assignable to it. Copying the arithmetic into
 * another module is a compile error there rather than a divergence nobody notices — and `unexplained` cannot be
 * quietly dropped, because the only thing that can produce the type computes it.
 *
 * `unexplained` is a SUBTRACTION, never an input. It is the honest residual: with every candidate pushed into
 * exactly one bucket it is constructively zero, and a non-zero value means the producer is wrong — which is
 * precisely the finding it must be able to state. A negative residual is not a finding but an impossibility,
 * so it throws.
 *
 * Both laws hold WITHIN one CoverageDomain and one UnitKind. Nothing here mixes two: the denominator arrives as
 * a `RowSet` that carries both (see `row-set.ts`), and the caller states the numbers for one of them at a time.
 */

/** Not exported: the key is unreachable outside this module, so a literal cannot forge either record. */
declare const conservation: unique symbol;

export interface CoverageConservation {
  readonly [conservation]: "coverage";
  /** Every candidate the producer considered, counted once. */
  readonly total: number;
  readonly counted: number;
  readonly excluded: number;
  /** `total - counted - excluded`. Constructively zero, never removable, an error when non-zero. */
  readonly unexplained: number;
}

export interface SelectionConservation {
  readonly [conservation]: "selection";
  /** The lower ledger's counted denominator this selection accounts for. */
  readonly counted: number;
  readonly seated: number;
  /** Recorded with a reason, and NOT an exclusion: a zero score is a row that was looked at. */
  readonly zeroScore: number;
  /** Squeezed out by a budget. Every displacement carries its own record; this is only the count. */
  readonly displaced: number;
}

/**
 * The coverage axis. `unexplained` is derived here and nowhere else, which is what makes "every candidate lands
 * in exactly one bucket" a property of the code instead of a property of whoever wrote the last call site.
 */
export function summarizeCoverage(input: { total: number; counted: number; excluded: number }): CoverageConservation {
  const { total, counted, excluded } = input;
  requireCount("total", total);
  requireCount("counted", counted);
  requireCount("excluded", excluded);
  const unexplained = total - counted - excluded;
  if (unexplained < 0) {
    throw new Error(`Coverage conservation is impossible, not merely unbalanced: counted ${counted} + excluded ${excluded} exceeds total ${total}, so at least one candidate was put in two buckets`);
  }
  return { total, counted, excluded, unexplained } as CoverageConservation;
}

/**
 * The selection axis. Unlike coverage there is no residual term to absorb a mistake: an attribution that does
 * not add up is a corrupt artifact, so the imbalance is refused at construction rather than published.
 */
export function summarizeSelection(input: { counted: number; seated: number; zeroScore: number; displaced: number }): SelectionConservation {
  const { counted, seated, zeroScore, displaced } = input;
  requireCount("counted", counted);
  requireCount("seated", seated);
  requireCount("zeroScore", zeroScore);
  requireCount("displaced", displaced);
  const accounted = seated + zeroScore + displaced;
  if (accounted !== counted) {
    throw new Error(`Selection conservation is broken: seated ${seated} + zero-score ${zeroScore} + displaced ${displaced} = ${accounted}, but the denominator counted ${counted}`);
  }
  return { counted, seated, zeroScore, displaced } as SelectionConservation;
}

function requireCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`A conservation term must be a non-negative integer; ${name} is ${value}`);
  }
}
