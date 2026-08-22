/**
 * Versioned lens (per audience) and intent (per intent) policy registry.
 *
 * A policy is a DECLARATION about how a document is written, not a fact about the target: the reader's concerns
 * and terminology depth on the lens side, the document's task and reading mode on the intent side. Keeping them
 * here — one entry per enum member, each with its own version and content digest — is what makes "the same
 * knowledge, two audiences" auditable later: the digest of the policy a document was written under is recorded
 * with the request, so a policy edit can never masquerade as a knowledge change.
 *
 * Load-time completeness is checked in BOTH directions (the shape `src/base/partition-designation.ts` uses):
 * a member with no entry would reach the accessor and throw mid-run, and an entry for a member the enum does not
 * have is a dead row that reads like support. The tables are therefore keyed by `string`, deliberately: keying
 * them by the enum type would move the forward check to the compiler and leave the backward one unwritten, and
 * the runtime check is the one an operator sees named.
 *
 * Only five of the fifty-six (audience, intent) pairs have a producer today: the legacy mapping's six arms yield
 * `product-manager` x {overview, deep-dive, prd} and `engineer` x {overview, deep-dive}. The rest are declarations
 * awaiting the epic's planner slices; revising one is a version bump on that entry alone, which is why the
 * version sits on the entry and not only on the registry.
 */

import { sha256, stableJson } from "../base/util.ts";
import { REPORT_AUDIENCES, REPORT_INTENTS, type ReportAudience, type ReportIntent } from "./report-request-v2.ts";

/** The registry's own version. It is what a recorded request's `policyVersion` names. */
export const REPORT_POLICY_VERSION = "report-policy-v1";

/** How deep the reader's vocabulary goes. Decides wording, never which facts are in scope. */
export type TerminologyDepth = "business" | "mixed" | "implementation";
/** Where implementation identifiers may appear for this reader. `product-overview.md` keeps them in evidence. */
export type IdentifierPlacement = "evidence-only" | "in-prose";
/** How the document is read: front to back, or looked up. */
export type ReadingMode = "narrative" | "lookup";
/**
 * Whether the document restates its findings as sign-off items.
 *
 * `required` no longer has a holder: 57B-497 deleted the PRD's acceptance chapter on the user's instruction ("a PRD
 * states behavior, not sign-off conditions"), and prd was the only intent that asked for one. The flag is therefore
 * constant across every intent and reads as a dead declaration — retiring the field outright is the honest end
 * state, and it is deferred to its own chore rather than folded in here BECAUSE the field is inside the digested
 * policy content: removing it moves all eight intent digests and shortens the packet header, which moves every
 * recorded-request digest, every unit identity and the two ARCHIVAL identity readings whose run directories are not
 * in this repository (`eval/tests/unit-cache-identity-fixture-readings.test.ts` states that law). Flipping prd alone
 * moves one digest and nothing else, which is what this slice is scoped to pay.
 */
export type AcceptanceChecklist = "required" | "not-required";

export interface LensPolicy {
  readonly audience: ReportAudience;
  readonly terminologyDepth: TerminologyDepth;
  readonly identifiers: IdentifierPlacement;
  /** The reader's concerns, sorted so two identical policies cannot differ by byte. Never empty. */
  readonly concerns: readonly string[];
}

export interface IntentPolicy {
  readonly intent: ReportIntent;
  /** One sentence: what the document must do. */
  readonly task: string;
  readonly reading: ReadingMode;
  readonly acceptanceChecklist: AcceptanceChecklist;
}

export interface PolicyEntry<T> {
  readonly id: string;
  readonly version: string;
  readonly content: T;
  /** sha256 over `{id, version, content}`. Computed, never written by hand — a hand-written digest rots. */
  readonly digest: string;
}

/** What a recorded request carries about the policy it was resolved against. */
export interface PolicyReference {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface ReportPolicyRegistry {
  readonly version: string;
  /** Keyed by `ReportAudience`; the load-time check is what keeps the key set exactly that. */
  readonly lenses: Readonly<Record<string, PolicyEntry<LensPolicy>>>;
  /** Keyed by `ReportIntent`. */
  readonly intents: Readonly<Record<string, PolicyEntry<IntentPolicy>>>;
}

function entry<T>(id: string, version: string, content: T): PolicyEntry<T> {
  return { id, version, content, digest: sha256(stableJson({ id, version, content })) };
}

function lensEntry(audience: ReportAudience, version: string, policy: Omit<LensPolicy, "audience">): PolicyEntry<LensPolicy> {
  return entry(`lens.${audience}`, version, { audience, ...policy });
}

function intentEntry(id: ReportIntent, version: string, policy: Omit<IntentPolicy, "intent">): PolicyEntry<IntentPolicy> {
  return entry(`intent.${id}`, version, { intent: id, ...policy });
}

const LENSES: Record<string, PolicyEntry<LensPolicy>> = {
  // product-manager and engineer are the two the existing product/engineering document instructions already
  // describe (`renderOverviewContext` in src/context/context.ts), down to where identifiers may appear.
  "product-manager": lensEntry("product-manager", "v1", {
    terminologyDepth: "business",
    identifiers: "evidence-only",
    concerns: [
      "business rules and boundary values",
      "current problems as the business feels them",
      "roles and permissions in business terms",
      "user-visible behaviour and flows"
    ]
  }),
  "engineer": lensEntry("engineer", "v1", {
    terminologyDepth: "implementation",
    identifiers: "in-prose",
    concerns: [
      "call paths and entry points",
      "configuration and deployment inputs",
      "data models and storage",
      "failure paths and error handling",
      "technical risks in the current code"
    ]
  }),
  "architect": lensEntry("architect", "v1", {
    terminologyDepth: "implementation",
    identifiers: "in-prose",
    concerns: [
      "component boundaries and responsibilities",
      "cross-repository and service relationships",
      "runtime topology",
      "technology stack and its constraints"
    ]
  }),
  "sre": lensEntry("sre", "v1", {
    terminologyDepth: "implementation",
    identifiers: "in-prose",
    concerns: [
      "deployment and configuration surface",
      "failure modes and retries",
      "observability signals",
      "runtime dependencies and their availability"
    ]
  }),
  "qa": lensEntry("qa", "v1", {
    terminologyDepth: "mixed",
    identifiers: "evidence-only",
    concerns: [
      "acceptance conditions and boundary values",
      "observable states and transitions",
      "preconditions and permissions",
      "test coverage of the current behaviour"
    ]
  }),
  "security": lensEntry("security", "v1", {
    terminologyDepth: "implementation",
    identifiers: "in-prose",
    concerns: [
      "authentication and authorization paths",
      "external inputs and trust boundaries",
      "secret and credential handling",
      "sensitive data storage and flow"
    ]
  }),
  "executive": lensEntry("executive", "v1", {
    terminologyDepth: "business",
    identifiers: "evidence-only",
    concerns: [
      "current risks in business terms",
      "delivered capabilities",
      "scope and coverage of what is known"
    ]
  })
};

const INTENTS: Record<string, PolicyEntry<IntentPolicy>> = {
  "overview": intentEntry("overview", "v1", {
    task: "Describe the scope's current state and current problems once, in reading order.",
    reading: "narrative",
    acceptanceChecklist: "not-required"
  }),
  "deep-dive": intentEntry("deep-dive", "v1", {
    task: "Explain one scope member's current behaviour end to end, including rules, flows and failure paths.",
    reading: "narrative",
    acceptanceChecklist: "not-required"
  }),
  "onboarding": intentEntry("onboarding", "v1", {
    task: "Bring a reader new to the scope to the point of locating the code behind a behaviour.",
    reading: "narrative",
    acceptanceChecklist: "not-required"
  }),
  "reference": intentEntry("reference", "v1", {
    task: "Answer point questions about the scope; the reader arrives already knowing what to look up.",
    reading: "lookup",
    acceptanceChecklist: "not-required"
  }),
  // The prd row restates what the existing prd document instruction asks for: boundary values, a permission
  // matrix, verbatim interface text, tables over prose. No acceptance chapter since 57B-497 — see the flag's type.
  "prd": intentEntry("prd", "v1", {
    task: "Specify the current behaviour as a requirements document: rules with boundary values, permission matrix, verbatim interface text.",
    reading: "lookup",
    acceptanceChecklist: "not-required"
  }),
  "audit": intentEntry("audit", "v1", {
    task: "Report what is known about the scope, how it was verified, and what remains undetermined.",
    reading: "lookup",
    acceptanceChecklist: "not-required"
  }),
  // Still no advice: the report states the facts a decision turns on. Recommending an action is out of contract
  // for every intent (see recommendation-language.ts), so no intent policy may license it.
  "decision-support": intentEntry("decision-support", "v1", {
    task: "Lay out the current facts a named decision turns on, without proposing the decision.",
    reading: "narrative",
    acceptanceChecklist: "not-required"
  }),
  "change-impact": intentEntry("change-impact", "v1", {
    task: "State what a named change reaches in the current system.",
    reading: "lookup",
    acceptanceChecklist: "not-required"
  })
};

export const REPORT_POLICY_REGISTRY: ReportPolicyRegistry = {
  version: REPORT_POLICY_VERSION,
  lenses: LENSES,
  intents: INTENTS
};

/**
 * The load-time completeness check, in both directions, for both tables.
 *
 * Injectable so the negative fixtures can feed it a registry with a missing or a phantom entry: a check that can
 * only ever run against the one real table can only ever go green.
 */
export function validateReportPolicyRegistry(registry: ReportPolicyRegistry = REPORT_POLICY_REGISTRY): void {
  if (!registry.version.trim()) throw new Error("The report policy registry must declare its version; it is what a recorded request's policyVersion names");
  checkTable("lens", registry.lenses, REPORT_AUDIENCES, (content) => content.audience);
  checkTable("intent", registry.intents, REPORT_INTENTS, (content) => content.intent);
  for (const [audience, lensEntry] of Object.entries(registry.lenses)) {
    if (lensEntry.content.concerns.length === 0) throw new Error(`Lens policy ${JSON.stringify(audience)} declares no concerns; a lens that narrows nothing is not a lens`);
    const sorted = [...new Set(lensEntry.content.concerns)].sort();
    if (stableJson(lensEntry.content.concerns) !== stableJson(sorted)) {
      throw new Error(`Lens policy ${JSON.stringify(audience)} lists concerns unsorted or duplicated; the digest would then depend on typing order`);
    }
  }
  for (const [id, intentEntry] of Object.entries(registry.intents)) {
    if (!intentEntry.content.task.trim()) throw new Error(`Intent policy ${JSON.stringify(id)} declares no task; the intent would decide nothing`);
  }
}

function checkTable<T>(
  kind: "lens" | "intent",
  table: Readonly<Record<string, PolicyEntry<T>>>,
  members: readonly string[],
  memberOf: (content: T) => string
): void {
  const declared = new Set(Object.keys(table));
  const missing = members.filter((member) => !declared.has(member)).sort();
  if (missing.length) {
    throw new Error(`No ${kind} policy is registered for ${missing.join(", ")}; every ${kind} member must declare its policy or requests naming it would resolve to nothing`);
  }
  const phantom = [...declared].filter((key) => !members.includes(key)).sort();
  if (phantom.length) {
    throw new Error(`The ${kind} policy table registers unknown member(s) ${phantom.join(", ")}; a policy no request can name is a dead row that reads like support`);
  }
  for (const [key, policyEntry] of Object.entries(table)) {
    if (policyEntry.id !== `${kind}.${key}`) throw new Error(`${kind} policy under key ${JSON.stringify(key)} carries id ${JSON.stringify(policyEntry.id)}; the id is what a record names, so it must match the key`);
    if (!policyEntry.version.trim()) throw new Error(`${kind} policy ${JSON.stringify(key)} declares no version; a policy edit would then be invisible in a recorded request`);
    if (memberOf(policyEntry.content) !== key) throw new Error(`${kind} policy under key ${JSON.stringify(key)} describes ${JSON.stringify(memberOf(policyEntry.content))}; a copy-pasted policy body must not answer for another member`);
    const recomputed = sha256(stableJson({ id: policyEntry.id, version: policyEntry.version, content: policyEntry.content }));
    if (policyEntry.digest !== recomputed) throw new Error(`${kind} policy ${JSON.stringify(key)} carries digest ${policyEntry.digest} but its content digests to ${recomputed}`);
  }
}

validateReportPolicyRegistry(REPORT_POLICY_REGISTRY);

/** The lens policy for one audience. Unreachable for a registered audience thanks to the load-time check. */
export function lensPolicyFor(audience: ReportAudience, registry: ReportPolicyRegistry = REPORT_POLICY_REGISTRY): PolicyEntry<LensPolicy> {
  const found = registry.lenses[audience];
  if (!found) throw new Error(`No lens policy is registered for audience ${JSON.stringify(audience)}; declare one in report-policy-registry.ts`);
  return found;
}

/** The intent policy for one intent. */
export function intentPolicyFor(intent: ReportIntent, registry: ReportPolicyRegistry = REPORT_POLICY_REGISTRY): PolicyEntry<IntentPolicy> {
  const found = registry.intents[intent];
  if (!found) throw new Error(`No intent policy is registered for intent ${JSON.stringify(intent)}; declare one in report-policy-registry.ts`);
  return found;
}

/** What a recorded request carries: enough to audit which policy bytes a document was written under. */
export function policyReference<T>(policyEntry: PolicyEntry<T>): PolicyReference {
  return { id: policyEntry.id, version: policyEntry.version, digest: policyEntry.digest };
}

/** Digest over the whole registry. A single entry's edit moves it, so a registry change is a contract change. */
export function reportPolicyRegistryDigest(registry: ReportPolicyRegistry = REPORT_POLICY_REGISTRY): string {
  return sha256(stableJson(registry));
}
