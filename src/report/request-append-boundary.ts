/**
 * The knowledge boundary an appended request row names, and the one thing that can verify it.
 *
 * WHY THIS FILE EXISTS. A feature document's request row carries a boundary — `scope: feature`,
 * `scopeIds: [key]` — and nothing downstream re-derives that key: `buildFixturePlan` reads neither field, so a
 * mistyped key used to mint a whole document of authoring units for a feature the run never investigated. The
 * append door's answer was to refuse every feature document, which closed the hole by closing the door: the epic's
 * own R8 deliverables include feature-scope documents (a feature PRD), so "re-prepare the run" was the only route
 * to one, and re-preparing throws away the investigation.
 *
 * SO THE BOUNDARY IS CHECKED INSTEAD OF AVOIDED. `contract/run-intent.json` is the run's own record of what was
 * asked for and investigated, written before any producer ran and read-only afterwards — the same file the Topic
 * Catalog attributes work-item scopes against. A feature key in it is a feature this run has knowledge about; a
 * key that is not in it is a document with nothing to write from. That makes the check a comparison against a
 * recorded input, not against what the current code happens to expect.
 *
 * WHAT IT STILL DOES NOT CHECK, stated so nobody reads more into a green than is there: that the units of the
 * appended document then confine themselves to that feature's knowledge. `buildFixturePlan` gives every document
 * every material topic, so a feature document's units today name the other features' topics too. That is a
 * PLAN-side boundary rule, it is named at `buildFixturePlan`, and it is not this door's to enforce — this door
 * verifies that the boundary the row names exists at all.
 *
 * =================================================================================================================
 * THE PREMISE THIS CHECK RESTS ON, AS A TRIPWIRE CONDITION. This door used to refuse every feature document, which
 * was a STRUCTURAL guarantee: the shape could not get in. What replaced it is a VALUE COMPARISON — is this key in
 * that array — and a value comparison is only as strong as the premise that makes the array authoritative:
 *
 *     `contract/run-intent.json`'s `features[]` is the COMPLETE set of features this run holds knowledge about.
 *
 * WHY IT HOLDS TODAY, mechanically and in both directions. The keys are minted once, by `featureCacheKey` over the
 * operator's `FeatureRequest`, and written by `prepareRun` before any producer runs; the file is read-only
 * afterwards and its digest is in the bound contract. Every downstream attribution of knowledge to a feature goes
 * through that same list: the Topic Catalog's feature facet mints exactly one topic per key in it
 * (`projectFeatures`), and a work item whose scope names a feature is attributed by matching against it
 * (`featureKeyOfScope`, which THROWS on a `feature:` scope matching no bound key rather than inventing one). So
 * today there is no route by which a run acquires feature knowledge that this list does not name.
 *
 * IT IS A PREMISE, NOT A TYPE. Nothing in the type system prevents a future producer from minting feature-scoped
 * knowledge on its own — a discovery pass that names features it found in the source, a supplement loop that adds
 * a feature at epoch N+1, a cross-repo or cross-feature ledger that introduces a key of its own, an import of
 * another run's knowledge. The moment any of those exists, this array stops being the complete set, and this
 * check inverts from "refuses documents with no knowledge behind them" into "refuses documents whose knowledge
 * this file cannot see" — a false refusal, which is the worse failure of the two, because the operator's remedy
 * ("re-prepare the run with that feature requested") would be wrong advice.
 *
 * WHEN TO COME BACK: any change that lets feature knowledge into a run WITHOUT going through
 * `run-intent.json`'s `features[]`. Then the bound-key list must become a derivation over every producer of
 * feature-scoped knowledge (the catalog's feature facet is the natural owner, since it already has to attribute
 * all of it), and this door must read THAT instead — never a second, wider list kept beside it.
 * =================================================================================================================
 */

import { join } from "node:path";
import { assertNever } from "../base/artifact-result.ts";
import { exists, readJson } from "../base/util.ts";
import type { RunIntent } from "../contract/bound-run-contract.ts";
import type { LegacyDocumentRequest } from "./legacy-request-mapping.ts";

/**
 * Run-relative location of the contract input this check reads. ONE owner: the read below joins these segments and
 * both refusals name this constant, so the file that is opened and the file the message blames cannot drift apart.
 */
export const RUN_INTENT_RELATIVE_PATH = "contract/run-intent.json";

/** The absolute path, built from the constant rather than re-spelled. */
function runIntentPath(runDir: string): string {
  return join(runDir, ...RUN_INTENT_RELATIVE_PATH.split("/"));
}

/**
 * The feature keys this run's contract binds, in the contract's own order.
 *
 * A missing or shapeless contract is a NAMED refusal rather than an empty list: an empty list would make every
 * feature append fail with "this run investigated no feature", which reads like a verified answer about the run
 * instead of a file nobody could read.
 */
export async function boundFeatureKeys(runDir: string): Promise<readonly string[]> {
  const path = runIntentPath(runDir);
  if (!await exists(path)) {
    throw new Error(`${RUN_INTENT_RELATIVE_PATH} is missing from ${runDir}, so the feature keys this run investigated cannot be read; a feature document's boundary is checked against the recorded contract. Re-prepare the run under the current version.`);
  }
  const intent = await readJson<RunIntent>(path);
  if (!Array.isArray(intent.features)) {
    throw new Error(`${RUN_INTENT_RELATIVE_PATH} has no features array, so the bound feature keys cannot be read`);
  }
  return intent.features.map((feature) => feature.key);
}

/**
 * Exhaustive over the document kinds: a third kind has to say what its boundary is and how it is verified.
 *
 * Both arms carry a positive statement rather than only a refusal. An overview document's boundary is the whole
 * project, so a feature key on one is a contradiction, not extra information. A feature document's boundary is
 * exactly one bound key, and the refusal names the keys that ARE bound — an operator who mistyped one needs to
 * see the list, not be told to re-prepare a run that already holds what they asked for.
 */
export function assertAppendableBoundary(document: LegacyDocumentRequest, boundFeatureKeys: readonly string[]): void {
  switch (document.kind) {
    case "overview":
      if (document.featureKey !== null) {
        throw new Error(`Document ${JSON.stringify(document.documentId)} is an overview and carries feature key ${JSON.stringify(document.featureKey)}; the project scope is not addressed by feature`);
      }
      return;
    case "feature": {
      if (document.featureKey === null) {
        throw new Error(`Document ${JSON.stringify(document.documentId)} is a feature document with no feature key; the boundary it would be written against has no name`);
      }
      if (!boundFeatureKeys.includes(document.featureKey)) {
        throw new Error(`Document ${JSON.stringify(document.documentId)} names feature key ${JSON.stringify(document.featureKey)}, which ${RUN_INTENT_RELATIVE_PATH} does not bind (this run investigated: ${boundFeatureKeys.join(", ") || "no feature"}); this run has no knowledge to write that document from. Re-prepare the run with that feature requested.`);
      }
      return;
    }
  }
  return assertNever(document.kind, "appended document kind");
}
