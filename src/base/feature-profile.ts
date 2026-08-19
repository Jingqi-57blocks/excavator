/**
 * The operator's (or host model's) HYPOTHESES about where a capability enters the system.
 *
 * It exists because the candidate pool has exactly one door today, and that door is lexical: seeds come from
 * `LIKE %term%` over name / qualified_name / docstring / file_path, and a module matching no term is skipped
 * outright — the per-module floor can only rescue a module that matched and then lost. So a capability whose code
 * shares no vocabulary with the query is unreachable, and no amount of re-ranking changes that.
 *
 * A route hypothesis is the one input that is vocabulary-independent: `POST /leaves/:id/approve` locates code
 * without the code having to contain the word "leave". Path shape reads the same in Go, TypeScript and Perl.
 *
 * A HYPOTHESIS, NOT A FACT, and it may never become one: it is an unverified assertion by whoever asked for the
 * report, recorded with its origin so a later reader can tell an operator's claim from a model's guess. It earns
 * a candidate only by matching something a layer-3 producer independently observed; it never mints a membership,
 * a fact or a seat on its own.
 *
 * WHY IT CANNOT REACH LAYER 3: the layering contract forbids "feature vocabulary / query terms" as a layer-3
 * input, and this is feature vocabulary. Producers stay feature-blind; the matcher that consumes these
 * hypotheses runs on the layer-4 side, over facts the producers had already written.
 *
 * WHY IT LIVES IN THE BASE: `FeatureRequest` names it, and `FeatureRequest` is in `base/types.ts`, which sits
 * beneath every layer — a base type reaching up into the contract layer is an upward import, and the layer-order
 * test refuses it. That is the right answer rather than a workaround: this file is a closed vocabulary plus the
 * one validator over it, with no dependency on any layer, which is exactly what `fact-kind-registry.ts` already
 * is. The contract layer CONSUMES it (`materializeRunIntent` normalises on the way in); it does not own it.
 */

export const FEATURE_PROFILE_VERSION = "feature-profile-v1";

/**
 * Where a hypothesis came from.
 *
 * Recorded rather than inferred, because the three carry different weight and only the author knows which is
 * which. `deterministic` is reserved for a hypothesis some code derived; nothing derives one today, and a value
 * nobody produces is better than a value that quietly means two things.
 */
export type HypothesisOrigin = "user" | "host-model" | "deterministic";

export interface EntrypointHypothesis {
  /** Upper-cased. `null` means "any method", which is a different claim from guessing GET. */
  readonly method: string | null;
  /** Leading `/`, parameter segments as `:name`. `{name}` is normalised to `:name`. */
  readonly pathPattern: string;
  readonly origin: HypothesisOrigin;
}

export interface FeatureProfile {
  /** Sorted by (pathPattern, method, origin) and de-duplicated, so one intent has one byte sequence. */
  readonly possibleEntrypoints: readonly EntrypointHypothesis[];
}

/** Printable ASCII without space: `!` is the first, `~` the last. Route paths recorded by producers are ASCII. */
const PRINTABLE_ASCII = /^[!-~]+$/;

/**
 * Normalise and validate one feature's profile, or throw naming exactly what was wrong.
 *
 * EVERY violation is a named error, never a skipped entry. A validator that drops what it cannot parse turns "I
 * asked you to look at this route" into silence, and the operator has no way to learn their hypothesis was
 * discarded — they would read the resulting report as evidence the capability is absent. No fourth state: an
 * entry is normalised, or the run refuses to start.
 */
/**
 * The only keys a profile may carry, and the only keys one of its entries may carry.
 *
 * Enumerated so an unknown key is REFUSED rather than dropped. The epic plans `entities`, `possibleEvents` and
 * `possibleStates` as later fields, each arriving with its first consuming channel — which means the realistic
 * request is one written against a later engine than the one reading it. Dropping the key silently would start a
 * run that answers a narrower question than it was asked, record a digest covering only the part it understood,
 * and leave the archive unable to show that the rest was ever requested. And by the time those fields do land,
 * the swallowing has already happened in runs nobody can revisit.
 *
 * The same argument the entry-level validator already makes, one level up: this file's whole point is that a
 * hypothesis is either normalised or refused.
 */
const PROFILE_KEYS = new Set(["possibleEntrypoints"]);
const ENTRYPOINT_KEYS = new Set(["method", "pathPattern", "origin"]);

function refuseUnknownKeys(value: object, allowed: ReadonlySet<string>, subject: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) {
    throw new Error(`${subject} carries unrecognised key(s) ${unknown.map((key) => JSON.stringify(key)).join(", ")}; this engine would silently ignore them, so it refuses the request instead — supported keys are ${[...allowed].sort().join(", ")}`);
  }
}

export function normalizeFeatureProfile(raw: unknown, featureKey: string): FeatureProfile {
  const where = (index: number): string => `feature ${JSON.stringify(featureKey)} profile entry ${index}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`feature ${JSON.stringify(featureKey)} has a profile that is not an object`);
  }
  refuseUnknownKeys(raw, PROFILE_KEYS, `feature ${JSON.stringify(featureKey)} profile`);
  const entries = (raw as { possibleEntrypoints?: unknown }).possibleEntrypoints;
  if (!Array.isArray(entries) || entries.length === 0) {
    // An empty profile is refused rather than read as "no hypotheses": the way to say that is to omit the field.
    // Accepting `[]` would make two different intents — "I have no idea" and "I have hypotheses, here are none of
    // them" — indistinguishable in the contract, and the second one is a bug in whatever produced it.
    throw new Error(`feature ${JSON.stringify(featureKey)} has a profile with no possibleEntrypoints; omit the profile entirely to say there are no hypotheses`);
  }

  const normalized = entries.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${where(index)} is not an object`);
    refuseUnknownKeys(entry, ENTRYPOINT_KEYS, where(index));
    const { method, pathPattern, origin } = entry as { method?: unknown; pathPattern?: unknown; origin?: unknown };

    if (typeof pathPattern !== "string" || !pathPattern.length) throw new Error(`${where(index)} has no pathPattern`);
    if (!pathPattern.startsWith("/")) throw new Error(`${where(index)} pathPattern ${JSON.stringify(pathPattern)} must start with "/"`);
    if (!PRINTABLE_ASCII.test(pathPattern)) {
      throw new Error(`${where(index)} pathPattern ${JSON.stringify(pathPattern)} is not printable ASCII without whitespace; it is matched against route paths recorded by producers, which are`);
    }

    if (method !== null && method !== undefined && typeof method !== "string") throw new Error(`${where(index)} has a non-string method`);
    if (typeof method === "string" && !/^[A-Za-z]+$/.test(method)) throw new Error(`${where(index)} method ${JSON.stringify(method)} is not alphabetic`);

    if (origin !== "user" && origin !== "host-model" && origin !== "deterministic") {
      throw new Error(`${where(index)} has origin ${JSON.stringify(origin)}; it must be user, host-model or deterministic — a hypothesis with no recorded source cannot be weighed against one that has an author`);
    }

    return {
      method: typeof method === "string" ? method.toUpperCase() : null,
      // `{id}` and `:id` are the same hypothesis in two framework dialects. Normalising here is what keeps the
      // contract digest and the feature cache key from differing over a notation choice.
      pathPattern: requireNoResidualBraces(pathPattern.replace(/\{([^}/]+)\}/g, ":$1"), where(index)),
      origin
    } satisfies EntrypointHypothesis;
  });

  const byIdentity = new Map<string, EntrypointHypothesis>();
  for (const entry of normalized) byIdentity.set(`${entry.pathPattern} ${entry.method ?? ""} ${entry.origin}`, entry);
  const unique = [...byIdentity.values()].sort((a, b) =>
    a.pathPattern.localeCompare(b.pathPattern)
    || (a.method ?? "").localeCompare(b.method ?? "")
    || a.origin.localeCompare(b.origin));

  return { possibleEntrypoints: unique };
}

/**
 * Refuse a pattern that still holds a brace after dialect conversion.
 *
 * `/leaves/{id` and `/leaves/{a/{b}}` survive the substitution with braces intact, and a recorded route path never
 * contains one — so the hypothesis is dead on arrival: it can never match anything, and the operator would read
 * its silence as "that route is not there".
 */
function requireNoResidualBraces(pathPattern: string, subject: string): string {
  if (/[{}]/.test(pathPattern)) {
    throw new Error(`${subject} pathPattern ${JSON.stringify(pathPattern)} still contains a brace after "{name}" was converted to ":name"; a recorded route path never holds one, so this hypothesis could never match and its silence would read as an absent route`);
  }
  return pathPattern;
}
