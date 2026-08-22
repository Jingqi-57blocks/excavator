/**
 * Every rule ONE claim must satisfy, at ONE address.
 *
 * WHY IT HAS ITS OWN FILE. It began inside `section-audit.ts` because the section sidecar was the first caller,
 * and 57B-475 then hardened it into the validator BOTH sidecars call, so that a second claims sidecar could not
 * grow a weaker copy of the rules. That made it a shared piece living inside a module scheduled for retirement:
 * `section-audit.ts` went with the section path (57B-481), and a validator the unit path depends on must not be
 * a passenger on that deletion. So it moved here first, alone, with its body unchanged byte for byte — the two
 * refusal messages, their order, and the two helpers it delegates to are all exactly what they were.
 *
 * `where` is the place the caller names in the message. It is the only thing that differs between call sites:
 * `"unit <unitId>"` on the write door and `"claims[<index>]"` on the read-back door.
 *
 * CALLERS, grep-verified at the time of writing rather than recalled — command:
 * `grep -rn --include='*.ts' assertValidClaim src/` and read the import lines out of the hits. Exactly one `src/`
 * file imports this: `unit-output.ts`, at `validateUnitClaims` (the write door, which throws) and at
 * `parseUnitClaims` (the read-back door, which catches and returns the message as data). Three other files name
 * it in prose only — `synthesis-claim-backlink.ts`, `unit-companions.ts`, `unit-claim-binding.ts` — to say what
 * they do NOT check; those are comments, not edges. The section sidecar's own door, `validateClaimsInput`, was
 * deleted with this move: it had no `src/` caller left once the section authoring path retired.
 *
 * ONE KNOWN WART, MOVED RATHER THAN FIXED, so it is not read as endorsed. The first refusal — "Each claim must
 * be an object" — is the only one of the four that does not interpolate `where`. A sidecar holding
 * `[{valid}, null, {valid}]` therefore reaches the operator through `parseUnitClaims` as a problem naming no
 * index, while every sibling refusal in that same loop would have said `claims[1]`. That is the untrusted-JSON
 * case the read-back door exists for, so it is the one place the omission costs something. It is NOT fixed here
 * on purpose: 57B-481 batch (i) is a byte-identical relocation, and an operator-visible message is not a string
 * to change inside a diff whose whole claim is that nothing changed. Reported for a slice that may change
 * behaviour.
 *
 * IT SAYS NOTHING ABOUT WHETHER AN ID EXISTS. That is the grounding audit's job, against the run's own ledgers.
 * This is shape and internal consistency only, pure: no path, no I/O, no clock, no model call.
 */

import type { SectionClaim } from "../base/types.ts";
import { validateComparisonSides } from "./claim-comparison.ts";
import { claimIdShapeProblems } from "./claim-id-shape.ts";

export function assertValidClaim(claim: SectionClaim, where: string): void {
  if (!claim || typeof claim !== "object") throw new Error("Each claim must be an object");
  if (!claim.id || !claim.statement || !["fact", "verified", "inferred", "unavailable"].includes(claim.marker)) throw new Error(`Invalid claim in ${where}`);
  // The three id lists' SHAPE, before anything iterates them: both sidecars arrive as JSON cast to `SectionClaim`,
  // so `"traceIds": "T-1"` reaches every consumer as four one-character ids and fails for the wrong reason.
  const shape = claimIdShapeProblems(claim as unknown as Record<string, unknown>);
  if (shape.length) throw new Error(`Invalid claim id list in ${where}: ${shape.join("; ")}`);
  const sideViolations = validateComparisonSides(claim);
  if (sideViolations.length) throw new Error(`Invalid comparison sides in ${where}: ${sideViolations.join("; ")}`);
}
