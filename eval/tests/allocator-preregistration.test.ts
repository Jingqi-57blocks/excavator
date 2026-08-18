import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { canonicalJson } from "../../src/base/util.ts";
import { captureAllocatorPreregistration } from "../capture-allocator-baseline.ts";
import { loadAllocatorPreregistration, validateAllocatorPreregistration } from "../allocator-preregistration.ts";

const FILE = join(import.meta.dirname, "..", "fixtures", "allocator", "preregistration-v1.json");

test("57B-426 preregistration was captured by the executable old selector before replacement", () => {
  const frozen = loadAllocatorPreregistration(FILE);
  assert.deepEqual(validateAllocatorPreregistration(frozen), []);
  assert.equal(canonicalJson(captureAllocatorPreregistration()), canonicalJson(frozen));
});

test("57B-426 preregisters M1-M7 and the no-threshold contribution contract", () => {
  const frozen = loadAllocatorPreregistration(FILE);
  assert.deepEqual(Object.keys(frozen.gates).sort(), ["M1", "M2", "M3", "M4", "M5", "M6", "M7"]);
  assert.equal(frozen.eligibility.thresholdAdmissionAllowed, false);
  assert.equal(frozen.eligibility.silentModuleSeatAllowed, false);
  assert.equal(frozen.proposedFusion.rawScoresMayBeSummedAcrossChannels, false);
  assert.equal(frozen.proposedFusion.fallbackRanksEveryEligibleCandidate, true);
  assert.deepEqual(frozen.contributionContract.requiredFields, ["sourceChannel", "reason", "anchor", "propagationPath"]);
});
