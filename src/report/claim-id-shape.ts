/**
 * THE SHAPE OF A CLAIM'S THREE ID LISTS, checked once for both claims sidecars.
 *
 * WHAT IT CATCHES, and why a type annotation did not. `SectionClaim` declares `evidenceIds?: string[]`, and both
 * sidecars arrive as parsed JSON that is CAST to it — `parseUnitClaims` ends in a cast, and the section path
 * validates fields one by one. So `"traceIds": "T-1"` type-checks nowhere and is refused nowhere: every consumer
 * spreads or iterates the field, and iterating a string yields its CHARACTERS. A claim written that way does not
 * fail; it silently declares four one-character trace ids, none of which matches anything, and the audit then
 * reports the claim as ungrounded for a reason that has nothing to do with the mistake.
 *
 * WHY EMPTY STRINGS ARE REFUSED TOO. An id is a key into a ledger. `""` cannot match a row, and a list holding one
 * is a list whose length over-states how much the claim is standing behind — the same over-count as the string
 * case, one element at a time.
 *
 * WHAT IT DOES NOT DO. It says nothing about whether an id EXISTS: that is the audit's job, against the run's own
 * ledgers, and duplicating it here would be a second denominator. This is shape only.
 *
 * Pure: no I/O, no model call. Every refusal names the claim and the field.
 */

/** The three id fields both sidecars carry. A fourth would have to be added here to be checked. */
export const CLAIM_ID_FIELDS = ["evidenceIds", "traceIds", "workItemIds"] as const;
export type ClaimIdField = (typeof CLAIM_ID_FIELDS)[number];

/**
 * Every shape problem of one claim's id lists, in field order. An absent field is not a problem — the three are
 * optional by contract, and a claim that names no trace is ordinary.
 *
 * The parameter is `unknown`-shaped on purpose: the callers hold values that were CAST to `SectionClaim`, so a
 * checker typed to the interface would be looking at fields the type system already believes are arrays.
 */
export function claimIdShapeProblems(claim: { readonly id?: unknown } & Record<string, unknown>): readonly string[] {
  const problems: string[] = [];
  const named = typeof claim.id === "string" && claim.id.trim() !== "" ? JSON.stringify(claim.id) : "(a claim with no id)";
  for (const field of CLAIM_ID_FIELDS) {
    const value = claim[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      problems.push(`claim ${named} declares ${field} as ${typeof value === "string" ? `the string ${JSON.stringify(value)}` : `a ${typeof value}`} rather than an array of ids; every consumer iterates this field, and iterating a string yields its characters instead of failing`);
      continue;
    }
    for (const [index, id] of value.entries()) {
      if (typeof id !== "string") {
        problems.push(`claim ${named} has ${field}[${index}] of type ${id === null ? "null" : typeof id}; an id is a string key into a ledger`);
        continue;
      }
      if (id.trim() === "") problems.push(`claim ${named} has an empty ${field}[${index}]; an empty id cannot match a ledger row, and a list holding one over-states what the claim stands behind`);
    }
  }
  return problems;
}
