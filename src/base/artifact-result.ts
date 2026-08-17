/**
 * The engine's one artifact envelope, defined here and nowhere else.
 *
 * Every layer interface is a TOTAL function: any input, including a bad one, maps to a written-down result.
 * "It did not run" is a recorded state, never an absent file — that is what turns forty-two silent empties
 * into forty-two readable records. The union is closed at three states and consumers must switch
 * exhaustively, so a fourth spelling of failure (`censusUnavailable`, `channel-unavailable`, a bare `null`)
 * cannot be introduced in a producer without a compile error at every consumer.
 *
 * The admission rule for a new state, so this union does not drift into a reason bag: a state is added ONLY
 * when a freeze/completeness consumer must branch on it WITHOUT reading `reason`, and merging it into an
 * existing bucket would flip an audit conclusion. By that rule:
 *
 *  - `NotApplicable` earns its place: `not-detected` and `single-module` are DETERMINATIONS about the target
 *    (it was looked at; there is provably nothing), and folding them into `Unavailable` would render "known
 *    absent" as "blind spot". Because it is a determination, it must carry what it rests on — `basedOn` names
 *    the completeness records and `coverageDigest` pins their value at the time, so layer 8 can re-check the
 *    premise. When the scan was capped, a read failed or a mechanism covered only part of the corpus, the
 *    determination does not hold and the producer must return `Unavailable` instead.
 *  - A policy skip does NOT earn one: no consumer branches on it today, so it is `Unavailable{cause:"policy"}`.
 */

export interface Built<T> {
  status: "built";
  value: T;
}

export interface NotApplicable {
  status: "not-applicable";
  /** The determination itself — `not-detected`, `single-module`, … — never a free-text explanation. */
  determination: string;
  /** The completeness records this determination rests on, by artifact path or record name. Never empty. */
  basedOn: string[];
  /** The value of those records when the determination was made, so layer 8 can verify the premise. */
  coverageDigest: string;
}

export interface Unavailable {
  status: "unavailable";
  cause: string;
  /** Whether re-running with the same inputs could plausibly succeed (a missing tool, yes; a bad path, no). */
  retryable: boolean;
}

export type ArtifactResult<T> = Built<T> | NotApplicable | Unavailable;

export function built<T>(value: T): Built<T> {
  return { status: "built", value };
}

/**
 * A determination that the artifact does not apply. Both premises are enforced HERE rather than trusted at
 * the call sites: a determination with no stated basis is indistinguishable from a guess, and it is precisely
 * the guesses that render as "we checked, there is nothing".
 */
export function notApplicable(determination: string, basedOn: string[], coverageDigest: string): NotApplicable {
  if (!determination.trim()) throw new Error("A not-applicable result requires a determination");
  if (!basedOn.length) throw new Error("A not-applicable result requires basedOn: the completeness records the determination rests on");
  if (!coverageDigest.trim()) throw new Error("A not-applicable result requires a coverageDigest pinning those records' value");
  return { status: "not-applicable", determination, basedOn: [...basedOn], coverageDigest };
}

export function unavailable(cause: string, retryable = false): Unavailable {
  if (!cause.trim()) throw new Error("An unavailable result requires a cause");
  return { status: "unavailable", cause, retryable };
}

/**
 * The exhaustiveness sink. Reached only when a new state was added to a union without updating a consumer;
 * `context` names which union was being consumed, because "unexpected value" in a stack trace is not enough
 * to find the switch that was left behind.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context} state: ${JSON.stringify(value)}`);
}
