import test from "node:test";
import assert from "node:assert/strict";
import { sha256, stableJson } from "../src/base/util.ts";
import {
  REPORT_POLICY_REGISTRY,
  REPORT_POLICY_VERSION,
  intentPolicyFor,
  lensPolicyFor,
  policyReference,
  reportPolicyRegistryDigest,
  validateReportPolicyRegistry,
  type IntentPolicy,
  type LensPolicy,
  type PolicyEntry,
  type ReportPolicyRegistry
} from "../src/report/report-policy-registry.ts";
import { REPORT_AUDIENCES, REPORT_INTENTS } from "../src/report/report-request-v2.ts";

// Two claims, and they need different instruments.
//
//   * COMPLETENESS is checked in both directions at load, so the negatives here feed the validator synthetic
//     registries — a check that can only ever run against the one real table can only ever go green.
//   * The DIGEST TABLE below is a byte pin. The digest is what a recorded request carries, so editing a policy's
//     content without bumping that entry's version has to be visible somewhere; this is that somewhere.

/** (key, id, version, digest) for every entry. Editing a policy moves its digest and turns this red. */
const PINNED = [
  { key: "product-manager", id: "lens.product-manager", version: "v1", digest: "2f840ba8c03ff6c2ac27ad29a45dee01797b33e45c05c4de611b954c4c18125c" },
  { key: "engineer", id: "lens.engineer", version: "v1", digest: "28796ebaa0f3d58058ab8f11a1f73e1448f15696115473641da453f8e94d72a4" },
  { key: "architect", id: "lens.architect", version: "v1", digest: "237c728dc1952ab1413fbe34f3ea6bc04b03735506fcf2cf6c523db491191c70" },
  { key: "sre", id: "lens.sre", version: "v1", digest: "45eb7df44707f1c113b218fc7a7b7b056bad4a7ea33fceb0aab9f4ed933f39c2" },
  { key: "qa", id: "lens.qa", version: "v1", digest: "4dc9de6cd4ad302128635f04a1add16f3e4a4aa404e0e86d9e5db53b29a60825" },
  { key: "security", id: "lens.security", version: "v1", digest: "c6842cd06e2b07b1df0ccb7322b8e08a7f39ba1dbb586b6aa48280ea29a2b7e7" },
  { key: "executive", id: "lens.executive", version: "v1", digest: "532106ee3e3026e37bcc8310bb863544999d9d92d42189c863ec2957cfab92aa" },
  { key: "overview", id: "intent.overview", version: "v1", digest: "9581cc05cbf0c293e5df6814a2501e3c8c664d06430a7c343d98c280b5aa5d09" },
  { key: "deep-dive", id: "intent.deep-dive", version: "v1", digest: "b971bfbe143bccf855876ed5e0827dc13c9c4023243eacf6addb54aacd003329" },
  { key: "onboarding", id: "intent.onboarding", version: "v1", digest: "fda50ebe828634da665f21273232c3565004849974dbf6381d2ac97b958fab51" },
  { key: "reference", id: "intent.reference", version: "v1", digest: "4a3b2dd030571f17f59fe4b9767f0e5a879b4d89c26206e6c0256b3ef5d8d8f8" },
  { key: "prd", id: "intent.prd", version: "v2", digest: "556a24225a08aed02ade319cab8e5904c158f95fe611d5ab6b5390cce1bc9214" },
  { key: "audit", id: "intent.audit", version: "v1", digest: "611745b42c8c130753fd32ba7bf0e19427cfb24cbd0caf513d505dd925de0173" },
  { key: "decision-support", id: "intent.decision-support", version: "v1", digest: "3f15a6136cfedd7cabf6d3fcf6fbc362d2dbebae7b199a9b7594ee891cad6eb4" },
  { key: "change-impact", id: "intent.change-impact", version: "v1", digest: "c65522048e6ab79e69cab72b257a5da0c701e068b75c5ebf94eb776060bf2e47" }
];

function withLenses(lenses: Record<string, PolicyEntry<LensPolicy>>): ReportPolicyRegistry {
  return { ...REPORT_POLICY_REGISTRY, lenses };
}
function withIntents(intents: Record<string, PolicyEntry<IntentPolicy>>): ReportPolicyRegistry {
  return { ...REPORT_POLICY_REGISTRY, intents };
}
function rebuild<T>(entry: PolicyEntry<T>, content: T, version = entry.version): PolicyEntry<T> {
  return { id: entry.id, version, content, digest: sha256(stableJson({ id: entry.id, version, content })) };
}

test("the real registry loads, and every enum member resolves to a policy", () => {
  validateReportPolicyRegistry();
  assert.equal(REPORT_POLICY_REGISTRY.version, REPORT_POLICY_VERSION);
  for (const audience of REPORT_AUDIENCES) assert.equal(lensPolicyFor(audience).content.audience, audience);
  for (const intent of REPORT_INTENTS) assert.equal(intentPolicyFor(intent).content.intent, intent);
});

test("a missing entry fails the load by name — in both tables", () => {
  const { overview: _dropped, ...intentsWithoutOverview } = REPORT_POLICY_REGISTRY.intents;
  assert.throws(() => validateReportPolicyRegistry(withIntents(intentsWithoutOverview)),
    /No intent policy is registered for overview; every intent member must declare its policy/);
  const { qa: _droppedLens, ...lensesWithoutQa } = REPORT_POLICY_REGISTRY.lenses;
  assert.throws(() => validateReportPolicyRegistry(withLenses(lensesWithoutQa)),
    /No lens policy is registered for qa; every lens member must declare its policy/);
});

test("a phantom entry fails the load by name — a policy no request can name is a dead row", () => {
  const phantomLens = rebuild({ ...lensPolicyFor("qa"), id: "lens.devrel" }, { ...lensPolicyFor("qa").content });
  assert.throws(() => validateReportPolicyRegistry(withLenses({ ...REPORT_POLICY_REGISTRY.lenses, devrel: phantomLens })),
    /The lens policy table registers unknown member\(s\) devrel/);
  const phantomIntent = rebuild({ ...intentPolicyFor("audit"), id: "intent.retro" }, { ...intentPolicyFor("audit").content });
  assert.throws(() => validateReportPolicyRegistry(withIntents({ ...REPORT_POLICY_REGISTRY.intents, retro: phantomIntent })),
    /The intent policy table registers unknown member\(s\) retro/);
});

test("an id, a body or a digest that does not match its key fails the load by name", () => {
  const qa = lensPolicyFor("qa");
  assert.throws(() => validateReportPolicyRegistry(withLenses({ ...REPORT_POLICY_REGISTRY.lenses, qa: rebuild({ ...qa, id: "lens.security" }, qa.content) })),
    /lens policy under key "qa" carries id "lens.security"/);
  // A copy-pasted body: the entry sits under `qa` but says it describes the engineer.
  assert.throws(() => validateReportPolicyRegistry(withLenses({ ...REPORT_POLICY_REGISTRY.lenses, qa: rebuild(qa, { ...qa.content, audience: "engineer" }) })),
    /lens policy under key "qa" describes "engineer"/);
  assert.throws(() => validateReportPolicyRegistry(withLenses({ ...REPORT_POLICY_REGISTRY.lenses, qa: { ...qa, digest: "0".repeat(64) } })),
    /lens policy "qa" carries digest 0{64} but its content digests to /);
  assert.throws(() => validateReportPolicyRegistry(withLenses({ ...REPORT_POLICY_REGISTRY.lenses, qa: rebuild(qa, qa.content, "  ") })),
    /lens policy "qa" declares no version/);
});

test("a lens with no concerns, an intent with no task, and a registry with no version all fail by name", () => {
  const qa = lensPolicyFor("qa");
  assert.throws(() => validateReportPolicyRegistry(withLenses({ ...REPORT_POLICY_REGISTRY.lenses, qa: rebuild(qa, { ...qa.content, concerns: [] }) })),
    /Lens policy "qa" declares no concerns/);
  assert.throws(() => validateReportPolicyRegistry(withLenses({ ...REPORT_POLICY_REGISTRY.lenses, qa: rebuild(qa, { ...qa.content, concerns: ["b", "a"] }) })),
    /Lens policy "qa" lists concerns unsorted or duplicated/);
  const audit = intentPolicyFor("audit");
  assert.throws(() => validateReportPolicyRegistry(withIntents({ ...REPORT_POLICY_REGISTRY.intents, audit: rebuild(audit, { ...audit.content, task: " " }) })),
    /Intent policy "audit" declares no task/);
  assert.throws(() => validateReportPolicyRegistry({ ...REPORT_POLICY_REGISTRY, version: "" }),
    /must declare its version/);
});

test("every entry's id, version and content digest are pinned — a policy edit without a version bump shows up here", () => {
  const actual = [
    ...Object.entries(REPORT_POLICY_REGISTRY.lenses),
    ...Object.entries(REPORT_POLICY_REGISTRY.intents)
  ].map(([key, entry]) => ({ key, id: entry.id, version: entry.version, digest: entry.digest }));
  assert.deepEqual(actual, PINNED);
});

test("the digest is a function of content alone: same content twice digests the same, one edit moves it", () => {
  const engineer = lensPolicyFor("engineer");
  assert.equal(rebuild(engineer, engineer.content).digest, engineer.digest, "rebuilding from the same content reproduces the digest");
  const edited = rebuild(engineer, { ...engineer.content, terminologyDepth: "business" });
  assert.notEqual(edited.digest, engineer.digest, "an unversioned content edit must move the digest");
  const bumped = rebuild(engineer, engineer.content, "v2");
  assert.notEqual(bumped.digest, engineer.digest, "the version is part of the digested payload");
});

test("the registry digest moves when any single entry does — a policy change is a contract change", () => {
  const before = reportPolicyRegistryDigest();
  assert.equal(before, reportPolicyRegistryDigest(REPORT_POLICY_REGISTRY));
  const qa = lensPolicyFor("qa");
  assert.notEqual(before, reportPolicyRegistryDigest(withLenses({
    ...REPORT_POLICY_REGISTRY.lenses,
    qa: rebuild(qa, { ...qa.content, identifiers: "in-prose" })
  })));
});

test("a recorded policy reference is id + version + digest and nothing else", () => {
  // v2 since 57B-497 revised the prd policy (the acceptance chapter is gone). The version moving WITH the content
  // is the point: a request recorded under v1 is legibly a different policy, not a corrupt digest.
  assert.deepEqual(policyReference(intentPolicyFor("prd")), {
    id: "intent.prd", version: "v2", digest: PINNED.find((row) => row.id === "intent.prd")!.digest
  });
});

test("the two audiences the legacy vocabulary had keep the distinction the existing templates state", () => {
  // product keeps implementation identifiers inside evidence blocks; engineering explains them in prose. That is
  // the difference `renderOverviewContext` already draws, now stated as policy rather than only as prompt prose.
  assert.equal(lensPolicyFor("product-manager").content.identifiers, "evidence-only");
  assert.equal(lensPolicyFor("product-manager").content.terminologyDepth, "business");
  assert.equal(lensPolicyFor("engineer").content.identifiers, "in-prose");
  assert.equal(lensPolicyFor("engineer").content.terminologyDepth, "implementation");
  // prd reads as lookup, not narrative — that part is unchanged. What changed in 57B-497: prd was the ONE intent
  // that asked for an acceptance checklist, and its chapter is gone, so no intent asks for one any more. The loop
  // is the shape of that claim: a future entry that reintroduces `required` has to argue with a red test rather
  // than slip in beside the other seven. (The flag is now constant and therefore dead; retiring the field
  // itself is deferred to its own chore because it is digested content — see the type's comment in the registry.)
  assert.equal(intentPolicyFor("prd").content.reading, "lookup");
  for (const intent of REPORT_INTENTS) {
    assert.equal(intentPolicyFor(intent).content.acceptanceChecklist, "not-required",
      `intent ${intent} asks for an acceptance checklist; no report intent may, since 57B-497 deleted the PRD's acceptance chapter`);
  }
  // No intent licenses advice: recommendations are out of contract for the whole report side.
  for (const intent of REPORT_INTENTS) assert.doesNotMatch(intentPolicyFor(intent).content.task, /recommend|propose the/i);
});
