import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFeatureProfile } from "../src/base/feature-profile.ts";
import { materializeBoundRunContract } from "../src/contract/bound-run-contract.ts";
import { featureCacheKey } from "../src/context/context.ts";
import type { FeatureRequest, ReportRequest } from "../src/base/types.ts";

// FEATURE PROFILE: A RECORDED HYPOTHESIS, WITH NOWHERE TO HIDE.
//
// The profile exists so a later recall channel can find code that shares no vocabulary with the query. That makes
// it the operator's assertion about the target, and the two ways it can betray them are opposite: silently
// dropping an entry (they believe it was searched) and silently sharing a cache with a run that had a different
// one (they believe they got their own answer). Both are covered below; neither is a style question.

const BUDGETS = { prepareMs: 1000, authorMs: 1000, maxGraphQueries: 1, maxSourceWindows: 1, maxSourceCharacters: 1, maxFiles: 1, maxFeatureNodes: 1, maxExpansionDepth: 1 };

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { method: "post", pathPattern: "/leaves/{id}/approve", origin: "user", ...overrides };
}

test("normalisation upper-cases the method, converts brace params, sorts and de-duplicates", () => {
  const profile = normalizeFeatureProfile({
    possibleEntrypoints: [
      entry({ pathPattern: "/leaves/{id}/reject", method: "put" }),
      entry({ pathPattern: "/leaves/{id}/approve", method: "post" }),
      // The same hypothesis written the other dialect: it must collapse, not appear twice.
      entry({ pathPattern: "/leaves/:id/approve", method: "POST" }),
      entry({ pathPattern: "/leaves", method: null })
    ]
  }, "leave");

  assert.deepEqual(profile.possibleEntrypoints, [
    { method: null, pathPattern: "/leaves", origin: "user" },
    { method: "POST", pathPattern: "/leaves/:id/approve", origin: "user" },
    { method: "PUT", pathPattern: "/leaves/:id/reject", origin: "user" }
  ]);
});

// THE SILENT-DISCARD TRIPWIRE.
//
// Two valid entries and one invalid one. If someone "makes the validator more forgiving" by skipping what it
// cannot parse, this test is what stops it: the operator asked for three routes to be considered and would get
// two, with nothing in any artifact saying so, and would then read the report as evidence about all three.
test("one invalid entry rejects the whole profile rather than being skipped", () => {
  assert.throws(() => normalizeFeatureProfile({
    possibleEntrypoints: [entry(), entry({ pathPattern: "leaves/no-slash" }), entry({ pathPattern: "/leaves" })]
  }, "leave"), (error: Error) => {
    assert.match(error.message, /"leave"/, "the error names the feature");
    assert.match(error.message, /entry 1/, "and the entry index, so it is locatable without bisecting the request");
    return true;
  });
});

test("every rejected shape is named, and none of them passes", () => {
  const cases: Array<[string, unknown]> = [
    ["not an object", []],
    ["no possibleEntrypoints", {}],
    ["empty possibleEntrypoints", { possibleEntrypoints: [] }],
    ["entry is not an object", { possibleEntrypoints: ["/leaves"] }],
    ["missing pathPattern", { possibleEntrypoints: [entry({ pathPattern: undefined })] }],
    ["pathPattern without leading slash", { possibleEntrypoints: [entry({ pathPattern: "leaves" })] }],
    ["pathPattern with whitespace", { possibleEntrypoints: [entry({ pathPattern: "/lea ves" })] }],
    ["non-ASCII pathPattern", { possibleEntrypoints: [entry({ pathPattern: "/请假" })] }],
    ["non-alphabetic method", { possibleEntrypoints: [entry({ method: "P0ST" })] }],
    ["unknown origin", { possibleEntrypoints: [entry({ origin: "guess" })] }],
    ["missing origin", { possibleEntrypoints: [entry({ origin: undefined })] }],
    // The two that matter most, because they are the shape a REAL request takes: the epic plans `entities`,
    // `possibleEvents` and `possibleStates` as later fields, so the likely mistake is a request written against a
    // later engine than the one reading it. Silently dropping the key would start a run that answers a narrower
    // question than it was asked and record a digest covering only the understood part — and by the time those
    // fields land, the swallowing has already happened in runs nobody can revisit.
    ["unknown profile key", { possibleEntrypoints: [entry()], possibleEvents: ["leave.approved"] }],
    ["unknown entry key", { possibleEntrypoints: [entry({ params: { id: "x" } })] }],
    // Dialect conversion can leave a brace behind, and a recorded route path never holds one: the hypothesis
    // could never match, and the operator would read its silence as an absent route.
    ["unclosed brace", { possibleEntrypoints: [entry({ pathPattern: "/leaves/{id" })] }],
    ["nested braces", { possibleEntrypoints: [entry({ pathPattern: "/leaves/{a/{b}}" })] }]
  ];
  for (const [name, raw] of cases) {
    assert.throws(() => normalizeFeatureProfile(raw, "leave"), /leave/, `must reject: ${name}`);
  }
});

// THE CACHE-KEY TRIPWIRE.
//
// Pinned against a literal, because the property that matters is that runs WITHOUT profiles keep the exact bytes
// they had before the field existed. A relative assertion ("equals a key computed the same way") would move with
// the implementation and prove nothing about the caches already on disk.
test("a feature with no profile keeps its existing cache key, byte for byte", () => {
  const feature: FeatureRequest = { subject: "请假管理", aliases: ["approve", "holiday", "leave"], audiences: ["product"] };
  assert.equal(featureCacheKey(feature), "请假管理-8c2d685d81",
    "this is the key the frozen S2 baseline was measured under; changing it invalidates every cache on disk");
});

// The other half: two intents that differ ONLY by profile must not share a scope. This is the assertion that has
// to exist BEFORE any channel reads profiles — once one does, a shared key serves the first run's selection to the
// second, and nothing in either artifact says the answer belongs to a different question.
test("two features differing only by profile get different cache keys", () => {
  const base: FeatureRequest = { subject: "请假管理", aliases: ["leave"], audiences: ["product"] };
  const withProfile: FeatureRequest = { ...base, profile: normalizeFeatureProfile({ possibleEntrypoints: [entry()] }, "k") };
  const other: FeatureRequest = { ...base, profile: normalizeFeatureProfile({ possibleEntrypoints: [entry({ pathPattern: "/leaves/{id}/reject" })] }, "k") };

  assert.notEqual(featureCacheKey(base), featureCacheKey(withProfile), "absent and present are different questions");
  assert.notEqual(featureCacheKey(withProfile), featureCacheKey(other), "and two different hypotheses are too");
});

function contractFor(features: FeatureRequest[]): ReturnType<typeof materializeBoundRunContract> {
  const request = { target: "/t", language: "en-US", workdir: "/w", overviewAudiences: [], features, budgets: BUDGETS } as ReportRequest;
  return materializeBoundRunContract({
    request,
    features: features.map((feature) => ({ key: featureCacheKey(feature), subject: feature.subject, aliases: feature.aliases, ...(feature.profile === undefined ? {} : { profile: feature.profile }) })),
    documents: []
  });
}

// THE DIGEST TRIPWIRE. The contract digest is what layer 8 re-verifies an archived run against, so a hypothesis
// that does not reach it is a hypothesis the archive cannot prove was asked for.
test("the run-intent digest is sensitive to the profile and blind to how it was written", () => {
  const base: FeatureRequest = { subject: "Leave", aliases: ["leave"], audiences: ["product"] };
  const one = contractFor([{ ...base, profile: normalizeFeatureProfile({ possibleEntrypoints: [entry(), entry({ pathPattern: "/leaves" })] }, "k") }]);
  // Same hypotheses, opposite written order and the other param dialect: normalisation happens before the digest,
  // so this must be the same intent.
  const reordered = contractFor([{ ...base, profile: normalizeFeatureProfile({ possibleEntrypoints: [entry({ pathPattern: "/leaves" }), entry({ pathPattern: "/leaves/:id/approve" })] }, "k") }]);
  const changed = contractFor([{ ...base, profile: normalizeFeatureProfile({ possibleEntrypoints: [entry()] }, "k") }]);

  assert.equal(one.runIntent.digest, reordered.runIntent.digest, "writing order and param dialect are not part of the intent");
  assert.notEqual(one.runIntent.digest, changed.runIntent.digest, "dropping a hypothesis is a different intent");
});

// A run with no profiles must not acquire the key at all. `profile: undefined` would serialise into the unsigned
// object and move the digest of every run that never used the feature.
test("a run without hypotheses records no profile key and stays at the new version", () => {
  const contract = contractFor([{ subject: "Leave", aliases: ["leave"], audiences: ["product"] }]);
  assert.equal(contract.runIntent.version, "run-intent-v2");
  assert.ok(!("profile" in contract.runIntent.features[0]!), "no profile means the field is absent, not undefined");
});

// The profile reaches the recorded contract. Without this, everything above could hold while the hypothesis never
// makes it into the artifact an auditor reads.
test("a recorded profile is normalised on the way into the contract", () => {
  const contract = contractFor([{
    subject: "Leave",
    aliases: ["leave"],
    audiences: ["product"],
    // Raw, un-normalised shape cast in deliberately: `materializeRunIntent` is the normalisation point, and this
    // asserts it normalises rather than trusting whatever the caller handed it.
    profile: { possibleEntrypoints: [{ method: "post", pathPattern: "/leaves/{id}/approve", origin: "user" }] } as never
  }]);
  assert.deepEqual(contract.runIntent.features[0]!.profile?.possibleEntrypoints, [
    { method: "POST", pathPattern: "/leaves/:id/approve", origin: "user" }
  ]);
});
