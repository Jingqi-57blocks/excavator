import test from "node:test";
import assert from "node:assert/strict";
import type { SectionClaim } from "../src/base/types.ts";
import { assertValidClaim } from "../src/report/claim-validity.ts";

// THE ONE CLAIMS VALIDATOR, AT ITS OWN ADDRESS (57B-434 R8d batch (i)).
//
// `assertValidClaim` moved out of `section-audit.ts` unchanged byte for byte, because the module it lived in
// retires with the section path while the unit path calls this function on every claim it writes and every claim
// it reads back. A move is exactly the change no test notices, so this file states the function's whole contract
// where the function now lives: FOUR refusals in a fixed order, and one clean return.
//
// THE ORDER IS PART OF THE CONTRACT, not an implementation detail. A claim that is malformed in two ways is
// refused for the FIRST reason, and the caller's operator reads that message. Reordering the checks would change
// which sentence a person is shown without changing whether anything is refused — a difference no "does it throw"
// assertion can see, so it is asserted here directly.
//
// EVERY EXIT IS ASSERTED, INCLUDING THE CLEAN ONE. `"Each claim must be an object"` had no assertion anywhere in
// the suite before this file: it is the exit taken by a sidecar holding `null` or a bare string, which is exactly
// the untrusted-JSON shape the read-back door exists for. An exit no test ever reaches is an exit that can stop
// working silently.

function claim(extra: Record<string, unknown> = {}): SectionClaim {
  return { id: "C-1", marker: "fact", statement: "the leave window is fourteen days", ...extra } as unknown as SectionClaim;
}

test("a claim that is not an object is refused before any field is read", () => {
  for (const notAnObject of [null, undefined, "C-1", 7, true]) {
    assert.throws(() => assertValidClaim(notAnObject as unknown as SectionClaim, "unit d::leaf::x"), /Each claim must be an object/);
  }
  // An array IS an object here, and falls through to the field checks rather than to this refusal — stated so a
  // future tightening of that arm is a deliberate change and not a surprise.
  assert.throws(() => assertValidClaim([] as unknown as SectionClaim, "unit d::leaf::x"), /Invalid claim in unit d::leaf::x/);
});

test("a missing id, a blank statement or an unknown marker is refused, and the message names the caller's place", () => {
  for (const broken of [{ id: "" }, { statement: "" }, { marker: "guess" }, { marker: "" }]) {
    assert.throws(() => assertValidClaim(claim(broken), "unit d::leaf::x"), /Invalid claim in unit d::leaf::x/);
  }
  // All four legal markers pass. A fifth would have to be added to the validator to be accepted.
  for (const marker of ["fact", "verified", "inferred", "unavailable"]) {
    assert.doesNotThrow(() => assertValidClaim(claim({ marker }), "claims[0]"));
  }
});

test("the id-list shape and the comparison sides are refused in that order, each naming the place", () => {
  assert.throws(
    () => assertValidClaim(claim({ traceIds: "T-1" }), "claims[3]"),
    /Invalid claim id list in claims\[3\]: claim "C-1" declares traceIds as the string "T-1"/
  );
  assert.throws(
    () => assertValidClaim(claim({ evidenceIds: ["S-a"], sides: [["S-a"]] }), "unit d::leaf::x"),
    /Invalid comparison sides in unit d::leaf::x: claim C-1 declares comparison sides but has fewer than two groups/
  );
  // Malformed in BOTH ways: the id-list refusal is the one the operator is shown.
  assert.throws(
    () => assertValidClaim(claim({ evidenceIds: "S-a", sides: [["S-a"]] }), "unit d::leaf::x"),
    /Invalid claim id list in unit d::leaf::x/
  );
});

test("a well-formed claim returns cleanly, with and without the optional lists", () => {
  assert.doesNotThrow(() => assertValidClaim(claim(), "unit d::leaf::x"));
  assert.doesNotThrow(() => assertValidClaim(claim({ evidenceIds: [], traceIds: [], workItemIds: [] }), "unit d::leaf::x"));
  assert.doesNotThrow(() => assertValidClaim(
    claim({ evidenceIds: ["S-a", "S-b"], traceIds: ["T-1"], workItemIds: ["wi-1"], sides: [["S-a"], ["S-b"]] }),
    "unit d::leaf::x"
  ));
});
