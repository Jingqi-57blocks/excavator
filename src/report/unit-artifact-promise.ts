/**
 * ARE THE THREE ARTIFACTS ON DISK STILL THE BYTES A RECORD PROMISED — asked once, for both records that promise.
 *
 * `collect` asks it of a DRAFT RECEIPT: a receipt is a promise that content, claims and summary are on disk and are
 * the bytes it digested, and a promise whose subject was edited afterwards must be a named refusal rather than a
 * checkpoint over bytes nobody re-checked. R6b's admission asks the same question of a LEDGER ROW, and has to
 * DOWNGRADE a candidate whose bytes moved instead of aborting the pass.
 *
 * TWO SPELLINGS OF THIS WOULD BE TWO DEFINITIONS OF "still the verified bytes", and the cache would end up built on
 * whichever was looser. So the comparison lives here once and returns its findings as DATA; each caller turns them
 * into its own sentence, because only the words differ — the record is a receipt in one case and a ledger row in the
 * other, and telling an operator to "re-draft the unit" is right either way but has to name the right promise.
 */

import { readFile } from "node:fs/promises";
import { assertNever } from "../base/artifact-result.ts";
import { canonicalJson, exists, readJson, sha256 } from "../base/util.ts";

/** Which of the three artifacts a promise covers. */
export type PromisedArtifact = "content" | "claims" | "summary";

/**
 * ONE artifact that is not what a record promised. Structured rather than a sentence, because two callers name the
 * record differently — a draft receipt here, a ledger row in the admission — and only the WORDS differ.
 */
export type PromisedArtifactProblem =
  | { readonly what: PromisedArtifact; readonly state: "absent"; readonly path: string }
  | { readonly what: PromisedArtifact; readonly state: "unreadable"; readonly path: string; readonly reason: string }
  | { readonly what: PromisedArtifact; readonly state: "mismatch"; readonly digest: string; readonly promised: string };

/** How a caller names the record that made the promise, for the sentences below. */
export interface PromiseSubject {
  readonly unitId: string;
  /** The record, as a noun phrase: "Unit draft receipt", "The ledger row". */
  readonly record: string;
  /** The same record possessively: "its receipt", "its ledger row". */
  readonly possessive: string;
}

/**
 * THE ONE CHECK of "are the three artifacts on disk still the bytes a record promised".
 *
 * It answers for a RECEIPT here and for a LEDGER ROW in `unit-cache-admission-run.ts`, which needs exactly these
 * three comparisons and must DOWNGRADE a drifted candidate rather than abort a pass. Two spellings of this would be
 * two definitions of "still the verified bytes", and a cache would end up built on the looser one.
 */
export async function promisedArtifactProblems(
  paths: { readonly content: string; readonly claims: string; readonly summary: string },
  promised: { readonly contentDigest: string; readonly claimsDigest: string; readonly summaryDigest: string }
): Promise<readonly PromisedArtifactProblem[]> {
  const problems: PromisedArtifactProblem[] = [];
  for (const [path, what] of [[paths.content, "content"], [paths.claims, "claims"], [paths.summary, "summary"]] as const) {
    if (!await exists(path)) problems.push({ what, state: "absent", path });
  }
  if (problems.length > 0) return problems;
  const content = sha256(await readFile(paths.content, "utf8"));
  if (content !== promised.contentDigest) problems.push({ what: "content", state: "mismatch", digest: content, promised: promised.contentDigest });
  for (const [path, recorded, what] of [[paths.claims, promised.claimsDigest, "claims"], [paths.summary, promised.summaryDigest, "summary"]] as const) {
    let parsed: unknown;
    try {
      parsed = await readJson<unknown>(path);
    } catch (error) {
      problems.push({ what, state: "unreadable", path, reason: (error as Error).message });
      continue;
    }
    const digest = sha256(canonicalJson(parsed));
    if (digest !== recorded) problems.push({ what, state: "mismatch", digest, promised: recorded });
  }
  return problems;
}

/** One problem as the sentence its caller's refusal is made of. Exhaustive over the three states. */
export function describePromisedArtifactProblem(subject: PromiseSubject, problem: PromisedArtifactProblem): string {
  switch (problem.state) {
    case "absent":
      return `${subject.record} for ${JSON.stringify(subject.unitId)} promises ${problem.what} that is not on disk: ${problem.path}`;
    case "unreadable":
      return `${problem.path} could not be read as JSON: ${problem.reason}`;
    case "mismatch":
      return `Unit ${JSON.stringify(subject.unitId)} has ${problem.what} digesting to ${problem.digest}, but ${subject.possessive} promises ${problem.promised}; re-draft the unit`;
  }
  return assertNever(problem, "promised unit artifact problem state");
}
