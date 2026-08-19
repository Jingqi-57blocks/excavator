// READ WINDOW DEMAND — how many source windows this run's authorized reads need, before the first one opens.
//
// THE NUMBER IS NOT AN ESTIMATE. Layer 5 already declares it per ReadSpec: `budget.windows` is "the exact
// number of bounded source-window operations layer 7 needs to cover this span", validated in
// `read-specs.ts` against `ceil(span / MAX_WINDOW_LINES)`. Nothing ever summed it. So the only way a run
// could learn its own demand was to hit the ceiling and read what was left — which is how a prepare that
// needed 892 windows and was handed 60 could report nothing but "budget exceeded", and how an operator
// was left to pick a number by doubling until it stopped failing. Summing the declared authorizations makes
// the demand a determined quantity: `requiredRunWindowBudget` is what `--max-source-windows` has to be for
// this run to open every window it authorized, and it is knowable at prepare, not after.
//
// WHY THE SHORTFALL IS SILENT WHEN THERE IS NONE. `readWindowShortfall` returns null when the budget covers
// the demand, for the reason `read-coverage.ts:67` already states: an advisory that is necessarily true
// every time trains the reader to ignore advisories. The FIGURES are recorded unconditionally (metrics), the
// SENTENCE only when there is a decision to make.
//
// Pure: zero I/O, zero model call, byte-stable.

import type { RunMetrics } from "../base/types.ts";
import type { ReadSpec } from "../workset/read-specs.ts";

/** The run-level window ceiling and what was already spent against it before layer 7 executed. */
export interface ReadWindowBudget {
  /** `request.budgets.maxSourceWindows`. */
  readonly total: number;
  /** Windows recorded before read execution — today prepare's own project-document and fallback reads. */
  readonly consumed: number;
}

export interface ReadWindowDemand {
  readonly authorizedSpecs: number;
  /** Sum of layer 5's per-spec `budget.windows`. */
  readonly requiredWindows: number;
  readonly runWindowBudget: number;
  readonly consumedBeforeExecution: number;
  /** What read execution may actually spend: the ceiling minus what prepare already took. */
  readonly availableWindows: number;
  /** What `--max-source-windows` must be for this run to open every window it authorized. */
  readonly requiredRunWindowBudget: number;
  /** Windows the authorized set needs and cannot have. Zero means the ceiling is not binding. */
  readonly deficit: number;
}

/** Sum layer 5's declared per-spec authorizations against the run's window ceiling. */
export function readWindowDemand(specs: readonly ReadSpec[], budget: ReadWindowBudget): ReadWindowDemand {
  const requiredWindows = specs.reduce((total, spec) => total + spec.budget.windows, 0);
  const consumedBeforeExecution = Math.max(0, budget.consumed);
  const runWindowBudget = Math.max(0, budget.total);
  const availableWindows = Math.max(0, runWindowBudget - consumedBeforeExecution);
  return {
    authorizedSpecs: specs.length,
    requiredWindows,
    runWindowBudget,
    consumedBeforeExecution,
    availableWindows,
    requiredRunWindowBudget: consumedBeforeExecution + requiredWindows,
    deficit: Math.max(0, requiredWindows - availableWindows)
  };
}

/** The three figures that survive into the run manifest, so freeze can name the number without re-deriving it. */
export function recordedWindowDemand(demand: ReadWindowDemand): NonNullable<RunMetrics["sourceWindowDemand"]> {
  return {
    requiredWindows: demand.requiredWindows,
    availableWindows: demand.availableWindows,
    requiredRunWindowBudget: demand.requiredRunWindowBudget
  };
}

/**
 * The prepare-time sentence, or null when the ceiling is not binding.
 *
 * It names the run-level number rather than the remaining one. A message built from the remainder said
 * "increase --max-source-windows (e.g. 0)" once prepare had spent the whole ceiling itself, which is advice
 * that cannot be followed; the demand is what an operator can act on in one step.
 */
export function readWindowShortfall(demand: ReadWindowDemand): string | null {
  if (demand.deficit <= 0) return null;
  return `Source-window budget is short by ${demand.deficit}: this run authorized ${demand.authorizedSpecs} read(s) `
    + `needing ${demand.requiredWindows} window(s), prepare had already recorded ${demand.consumedBeforeExecution} `
    + `of maxSourceWindows=${demand.runWindowBudget}, leaving ${demand.availableWindows}. The displaced reads are `
    + `recorded as limitations, not as knowledge; re-prepare with --max-source-windows ${demand.requiredRunWindowBudget} to read them.`;
}

/**
 * The freeze-time aggregate for reads a recorded ceiling displaced — ONE line for the whole set.
 *
 * Per-row findings are what made this unreadable in the first place: one wcp freeze printed 1,687 of them.
 * The aggregate carries the counts, the causes and the number to re-prepare with, and the per-row detail
 * stays where per-row detail belongs (the executions, their ledger evidence, and the read residual).
 */
export function displacedReadsAdvisory(input: {
  readonly causes: readonly (string | undefined)[];
  readonly displacedDispositions: number;
  readonly demand: RunMetrics["sourceWindowDemand"];
}): string {
  const counts = new Map<string, number>();
  for (const cause of input.causes) {
    const key = cause?.trim() || "budget-ceiling-unnamed";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const causeList = [...counts.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([cause, count]) => `${cause} ${count}`).join(", ");
  const demand = input.demand;
  // The demand figures are absent on a run prepared before they were measured. Absence is stated, never
  // rendered as zero: "0 windows required" would read as "nothing was authorized", the opposite fact.
  const number = demand
    ? `This run's authorized reads require ${demand.requiredWindows} source window(s) and ${demand.availableWindows} were available; `
      + `re-prepare with --max-source-windows ${demand.requiredRunWindowBudget} to open them.`
    : "This run recorded no source-window demand figure, so the number to re-prepare with is not derivable from it; re-prepare under the current version to obtain one.";
  return `${input.causes.length} authorized read(s) were displaced by a recorded budget ceiling (${causeList}) and `
    + `${input.displacedDispositions} decision-reading declaration(s) are therefore disposed as recorded limitations. `
    + `A displaced read is a LIMITATION, not a closed obligation and not knowledge: it carries ledger evidence saying `
    + `nothing was read, its work item is cannot-determine, and it stays in the read residual. ${number}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
