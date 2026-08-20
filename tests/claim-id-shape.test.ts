import test from "node:test";
import assert from "node:assert/strict";
import type { SectionClaim } from "../src/base/types.ts";
import { CLAIM_ID_FIELDS, claimIdShapeProblems } from "../src/report/claim-id-shape.ts";
import { assertValidClaim, validateClaimsInput } from "../src/report/section-audit.ts";
import { parseUnitClaims, validateUnitClaims, UNIT_CLAIMS_VERSION } from "../src/report/unit-output.ts";

// THE SHAPE OF A CLAIM'S THREE ID LISTS (57B-434 R7c prerequisite, reported out of R7b).
//
// WHAT WAS UNCHECKED. `assertValidClaim` validated `id`, `statement`, `marker` and the comparison sides, and said
// nothing about `evidenceIds` / `traceIds` / `workItemIds`. Both sidecars arrive as parsed JSON CAST to
// `SectionClaim` — `parseUnitClaims` ends in a cast — so `"traceIds": "T-1"` is refused nowhere and every consumer
// SPREADS or ITERATES the field. Iterating a string yields its characters: the claim silently declares four
// one-character trace ids, the audit then reports it as ungrounded, and the message names nothing about the typo.
//
// Both doors are tested, because the plan requires ONE validator for both: the section sidecar and the unit sidecar.

function claim(extra: Record<string, unknown>): SectionClaim {
  return { id: "C-1", marker: "fact", statement: "the leave window is fourteen days", ...extra } as unknown as SectionClaim;
}

// --- the pure reading ------------------------------------------------------------------------------------------

test("a string where a list belongs is a named problem, for each of the three fields", () => {
  assert.deepEqual([...CLAIM_ID_FIELDS], ["evidenceIds", "traceIds", "workItemIds"]);
  for (const field of CLAIM_ID_FIELDS) {
    const problems = claimIdShapeProblems({ id: "C-1", [field]: "T-1" });
    assert.equal(problems.length, 1, problems.join(" | "));
    assert.ok(problems[0]!.includes(field), problems[0]);
    assert.ok(problems[0]!.includes('"C-1"'), "the refusal names the claim");
    assert.match(problems[0]!, /iterating a string yields its characters/);
  }
});

test("an absent field is not a problem, and a well-formed list is not either", () => {
  assert.deepEqual(claimIdShapeProblems({ id: "C-1" }), []);
  assert.deepEqual(claimIdShapeProblems({ id: "C-1", evidenceIds: [], traceIds: ["T-1"], workItemIds: ["wi-1", "wi-2"] }), []);
  // `null` is how a serializer spells "not set"; it is not a shape problem, only a missing list.
  assert.deepEqual(claimIdShapeProblems({ id: "C-1", traceIds: null }), []);
});

test("a non-string or empty member is named with its index", () => {
  const problems = claimIdShapeProblems({ id: "C-1", traceIds: ["T-1", 7, "", null] });
  assert.equal(problems.length, 3, problems.join(" | "));
  assert.match(problems[0]!, /traceIds\[1\] of type number/);
  assert.match(problems[1]!, /empty traceIds\[2\]/);
  assert.match(problems[2]!, /traceIds\[3\] of type null/);
  // A claim with no usable id still gets a refusal that says so rather than printing `undefined`.
  assert.match(claimIdShapeProblems({ traceIds: "T-1" })[0]!, /\(a claim with no id\)/);
});

test("an object or a number where a list belongs is named by its type, not by a string message", () => {
  assert.match(claimIdShapeProblems({ id: "C-1", workItemIds: 3 })[0]!, /declares workItemIds as a number/);
  assert.match(claimIdShapeProblems({ id: "C-1", workItemIds: { "0": "wi-1" } })[0]!, /declares workItemIds as a object/);
});

// --- both doors, through the one validator ---------------------------------------------------------------------

test("the section path refuses the shape, naming the claim and the field", () => {
  assert.throws(
    () => assertValidClaim(claim({ traceIds: "T-1" }), "doc section 3"),
    /Invalid claim id list in doc section 3: claim "C-1" declares traceIds as the string "T-1"/
  );
  assert.throws(
    () => validateClaimsInput("doc", 3, [claim({ evidenceIds: ["ev-1"] }), claim({ id: "C-2", workItemIds: [""] })]),
    /claim "C-2" has an empty workItemIds\[0\]/
  );
  // The legal claims still pass, through the same door.
  const file = validateClaimsInput("doc", 3, [claim({ evidenceIds: ["ev-1"], traceIds: ["T-1"], workItemIds: ["wi-1"] })]);
  assert.equal(file.claims.length, 1);
});

test("the unit path refuses the same shape on write and on read back", () => {
  assert.throws(
    () => validateUnitClaims("d::leaf::x", "d", [claim({ workItemIds: "wi-1" })]),
    /Invalid claim id list in unit d::leaf::x: claim "C-1" declares workItemIds as the string "wi-1"/
  );
  // The read side returns problems as DATA — its caller names the file — but the rule is the same one.
  const parsed = parseUnitClaims({
    version: UNIT_CLAIMS_VERSION,
    unitId: "d::leaf::x",
    documentId: "d",
    claims: [claim({ traceIds: "T-1" })]
  });
  assert.equal(parsed.claims, null);
  assert.equal(parsed.problems.length, 1, parsed.problems.join(" | "));
  assert.match(parsed.problems[0]!, /claims\[0\]: claim "C-1" declares traceIds as the string "T-1"/);
  // And a well-formed sidecar still parses: the check adds a refusal, not a new hurdle for legal bytes.
  const good = parseUnitClaims({
    version: UNIT_CLAIMS_VERSION,
    unitId: "d::leaf::x",
    documentId: "d",
    claims: [claim({ traceIds: ["T-1"], evidenceIds: ["ev-1"], workItemIds: ["wi-1"] })]
  });
  assert.deepEqual(good.problems, []);
  assert.equal(good.claims?.claims.length, 1);
});
