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
