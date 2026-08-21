// Canonical projection of the CROSS-UNIT CONSISTENCY CHECKER's reading (57B-434 R7c), for a checked-in golden that
// survives being run twice and dies on a changed sentence.
//
// WHY A READING AND NOT A TEXT PROJECTION. What this slice ships is JUDGEMENT SENTENCES: which class examined what,
// why a class had nothing to check, what a finding says, why a unit is in the repair set, and where a coverage
// arm's debt belongs. None of those are bytes in a deliverable — they are the artifact an operator acts on — so the
// golden is the reading itself, per scenario, with every sentence in it.
//
// THE VOLATILE IDENTIFIERS ARE SUBSTITUTED AS EXACT STRINGS, never as shaped patterns: the run id, the plan catalog
// digest (in full and in the 16-character prefix the refusals print), and every sealed evidence id. A digest that is
// not one of those is left alone, so a hand-pinned constant would still show as a diff. Every rule is reported with
// the number of replacements it made, and the golden test asserts the ones that must fire did.
//
// WHY THE INPUT IS A SYNTHETIC FIXTURE, AND WHY THAT IS NOT A GAP. The epic's two R0 baselines hold SECTION drafts:
// nothing has ever authored a unit into either of them, so there is no archival run whose unit prose, unit claims or
// unit summaries could be checked for cross-unit consistency. The input is therefore
// `tests/unit-consistency-fixture.ts` — a run IN THIS REPOSITORY — which is the same shape
// `eval/tests/unit-assemble-golden.test.ts` has, and it buys the property the two archival identity readings cannot
// have: CI recomputes every sentence below on every run.

import { stableJson } from "../src/base/util.ts";
import type { UnitConsistencyReading } from "../src/report/unit-consistency-source.ts";

export const UNIT_CONSISTENCY_READINGS_VERSION = "unit-consistency-readings-v1";

/** What a run makes volatile. Read off the run's own artifacts by the caller, never guessed at here. */
export interface VolatileRunIdentity {
  readonly runId: string;
  readonly planCatalogDigest: string;
  /**
   * The one evidence id the fixture's claims and prose cite, with a placeholder of its own.
   *
   * It is NOT left to the numbered list below, and that is a determinism requirement rather than tidiness: the
   * numbering is positional, so if a run's sealed id set ever varied, the cited id could land on a different index
   * and the golden would move without anything having changed.
   */
  readonly sourceEvidenceId: string;
  /** Every evidence id the epoch sealed. Substituted in a stable order so two runs produce one numbering. */
  readonly evidenceIds: readonly string[];
}

/** One substitution rule and how many times it fired. A rule that must fire and did not is a broken projection. */
export interface AppliedSubstitution {
  readonly name: string;
  readonly placeholder: string;
  readonly replacements: number;
}

/** One scenario: what was done to the fixture, and the reading that came back. */
export interface ConsistencyScenarioReading {
  readonly scenario: string;
  /** What the scenario injected, in words, so the golden says what it is a reading OF. */
  readonly injected: string;
  /** The checker's reading with every volatile identifier replaced. */
  readonly reading: unknown;
}

export interface ConsistencyReadingsProjection {
  readonly version: typeof UNIT_CONSISTENCY_READINGS_VERSION;
  readonly scenarios: readonly ConsistencyScenarioReading[];
  readonly applied: readonly AppliedSubstitution[];
}

export interface ConsistencyScenarioInput {
  readonly scenario: string;
  readonly injected: string;
  readonly reading: UnitConsistencyReading;
  readonly volatile: VolatileRunIdentity;
}

/**
 * The substitutions for one run, in the order they are applied.
 *
 * The full digest goes before its 16-character prefix, so the long form is never left as a placeholder followed by
 * the tail of the digest it came from.
 */
function rulesFor(identity: VolatileRunIdentity): ReadonlyArray<readonly [string, string, string]> {
  return [
    ["run-id", identity.runId, "<RUN-ID>"],
    ["source-evidence-id", identity.sourceEvidenceId, "<SOURCE-EVIDENCE-ID>"],
    ["plan-catalog-digest", identity.planCatalogDigest, "<PLAN-CATALOG-DIGEST>"],
    ["plan-catalog-digest-16", identity.planCatalogDigest.slice(0, 16), "<PLAN-CATALOG-DIGEST-16>"],
    ...[...identity.evidenceIds].filter((id) => id !== identity.sourceEvidenceId).sort()
      .map((id, index) => ["evidence-id", id, `<EVIDENCE-${index}>`] as const)
  ];
}

/**
 * Project one or more scenarios into the reading that gets checked in.
 *
 * Substitution is over the CANONICAL JSON of the reading and the result is parsed back, so a volatile id is replaced
 * wherever it appears — inside a sentence, inside a path, inside a nested reason — rather than only in the fields
 * somebody remembered to normalize.
 */
export function projectConsistencyReadings(scenarios: readonly ConsistencyScenarioInput[]): ConsistencyReadingsProjection {
  const fired = new Map<string, number>();
  const projected = scenarios.map((input) => {
    let text = stableJson(input.reading);
    for (const [name, literal, placeholder] of rulesFor(input.volatile)) {
      if (literal === "") throw new Error(`unit consistency readings: the ${name} rule of scenario ${input.scenario} has an empty literal, so it would replace everything`);
      const parts = text.split(literal);
      text = parts.join(placeholder);
      fired.set(name, (fired.get(name) ?? 0) + parts.length - 1);
    }
    return { scenario: input.scenario, injected: input.injected, reading: JSON.parse(text) as unknown };
  });
  const applied = [...fired.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, replacements]) => ({
    name,
    placeholder: name === "evidence-id" ? "<EVIDENCE-N>" : `<${name.toUpperCase()}>`,
    replacements
  }));
  return { version: UNIT_CONSISTENCY_READINGS_VERSION, scenarios: projected, applied };
}

/** Every volatile literal of one run, for a caller that wants to assert none of them survived the projection. */
export function volatileLiterals(identity: VolatileRunIdentity): readonly string[] {
  return rulesFor(identity).map(([, literal]) => literal);
}
