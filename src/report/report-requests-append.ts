/**
 * The one supported way `plan/requests.json` grows: append one document, never touch a row already recorded.
 *
 * WHY APPENDING NEEDS A DOOR OF ITS OWN. Prepare writes the request set once per run, and that write-once is
 * right: a recorded request is what a plan was validated against, and every unit's cache identity carries its own
 * document's request row. But the epic's own headline case — one more audience is asked for, and the documents
 * already written are not re-drawn — is exactly "one more requested document" inside one knowledge epoch. Without
 * a door for it, that case is unreachable through supported operations; with a door that rewrites the file, the
 * rows every recorded plan and every ledger row stand on could change under them.
 *
 * SO THE DOOR IS APPEND-ONLY, AND STRUCTURALLY SO. The recorded rows are COPIED — never rebuilt from the legacy
 * inputs, which nobody has after prepare — and the write is checked against what is on disk: every recorded row
 * must survive byte for byte and exactly one document may be added. A duplicate document, a changed row, a
 * removed row: three named refusals, no silent merge.
 *
 * WHAT AN APPEND DELIBERATELY BREAKS. The recorded plan was validated against the request set as it was, so after
 * an append the plan does not cover the requests. That is not a state to paper over: `plan-gate.ts` refuses to
 * author against it by name and says to record the next plan revision. Appending and re-planning are two acts
 * because the second one is what the units downstream are written against.
 *
 * THE MANIFEST IS NOT TOUCHED, and that is a scope statement rather than an omission. `run.json`'s document list
 * is what the legacy section path authors from; the authoring-DAG path takes its document set from THIS file (see
 * `validatePlan`: "the requests are the document set"). An appended document is therefore plannable and
 * authorable on the unit path, and invisible to the section path — which is where the cutover puts it anyway.
 *
 * THE BOUNDARY AN APPENDED ROW NAMES IS VERIFIED, NOT AVOIDED. A feature document's request carries a knowledge
 * BOUNDARY — `scope: feature`, `scopeIds: [key]` — and nothing downstream re-derives that key: `buildFixturePlan`
 * reads neither field, so a mistyped key mints a whole document of authoring units for a feature this run never
 * investigated. This door used to close that hole by refusing every feature document, which also made the epic's
 * own feature-scope deliverables unreachable except by re-preparing the run (and throwing the investigation away).
 * It now checks the key against `contract/run-intent.json` — the run's own record of what was investigated, read-only
 * since before any producer ran — and refuses by name, listing the keys that ARE bound. The check lives in
 * `request-append-boundary.ts`, and the bound keys are a REQUIRED argument to `appendedRequestSet` rather than
 * something it reads: a pure function that reached for a file would be a second reader of the contract, and an
 * optional argument would be the check one call site forgets.
 */

import { canonicalJson, exists, stableJson, writeJson } from "../base/util.ts";
import type { LegacyDocumentRequest } from "./legacy-request-mapping.ts";
import { assertAppendableBoundary, boundFeatureKeys } from "./request-append-boundary.ts";
import { REPORT_POLICY_REGISTRY, type ReportPolicyRegistry } from "./report-policy-registry.ts";
import {
  readReportRequests,
  reportRequestRecordFor,
  reportRequestsPath,
  type ReportRequestRecord,
  type ReportRequestsArtifact
} from "./report-requests-artifact.ts";

/** What one append produced: where it was written, the whole set, and the row that is new. */
export interface AppendedReportRequest {
  readonly path: string;
  readonly artifact: ReportRequestsArtifact;
  readonly appended: ReportRequestRecord;
}

/**
 * The set one append produces: the recorded rows unchanged, plus one document that was not there.
 *
 * A duplicate is refused here rather than mapped and compared, because two rows for one document is the one shape
 * the artifact's own reader cannot express — the rows are a set keyed by document.
 */
export function appendedRequestSet(
  recorded: ReportRequestsArtifact,
  document: LegacyDocumentRequest,
  boundKeys: readonly string[],
  registry: ReportPolicyRegistry = REPORT_POLICY_REGISTRY
): ReportRequestsArtifact {
  assertAppendableBoundary(document, boundKeys);
  if (recorded.requests.some((row) => row.documentId === document.documentId)) {
    throw new Error(`Document ${JSON.stringify(document.documentId)} is already in the recorded request set; a request row is appended once and never edited`);
  }
  const appended = reportRequestRecordFor(document, registry);
  return {
    version: recorded.version,
    requests: [...recorded.requests, appended].sort((a, b) => a.documentId.localeCompare(b.documentId))
  };
}

/**
 * Refuse anything but an append. Every recorded row must survive byte for byte, and exactly one row is added.
 *
 * This is the guard the write goes through, so a caller that hands over a rebuilt set with one field of an
 * existing row moved is refused with the field named — the failure mode a "rewrite the whole file" append would
 * make invisible.
 */
export function assertRequestsOnlyAppended(recorded: ReportRequestsArtifact, next: ReportRequestsArtifact): void {
  if (next.version !== recorded.version) {
    throw new Error(`An append does not change the recorded artifact version: ${JSON.stringify(recorded.version)} would become ${JSON.stringify(next.version)}`);
  }
  const nextById = new Map(next.requests.map((row) => [row.documentId, row]));
  for (const row of recorded.requests) {
    const kept = nextById.get(row.documentId);
    if (kept === undefined) {
      throw new Error(`The recorded request for document ${JSON.stringify(row.documentId)} is not in the set being written; recorded request rows are never removed`);
    }
    if (stableJson(kept) !== stableJson(row)) {
      throw new Error(`The recorded request for document ${JSON.stringify(row.documentId)} would change from ${canonicalJson(row)} to ${canonicalJson(kept)}; recorded request rows are immutable — a request set is only ever appended to`);
    }
  }
  const added = next.requests.filter((row) => !recorded.requests.some((existing) => existing.documentId === row.documentId));
  if (added.length !== 1) {
    throw new Error(`An append adds exactly one document, and this write adds ${added.length} (${added.map((row) => row.documentId).join(", ") || "none"})`);
  }
}

/**
 * Append one requested document to a run's recorded request set.
 *
 * The recorded set is READ AND VALIDATED first: appending to a file that does not parse against the live policy
 * registry would carry an unreadable row forward, and the reader's refusal already says which row and why.
 */
export async function appendReportRequest(
  runDir: string,
  document: LegacyDocumentRequest,
  registry: ReportPolicyRegistry = REPORT_POLICY_REGISTRY
): Promise<AppendedReportRequest> {
  const path = reportRequestsPath(runDir);
  if (!await exists(path)) {
    throw new Error(`${path} is missing, so there is no recorded request set to append to. Re-prepare the run under the current version.`);
  }
  const recorded = await readReportRequests(runDir, registry);
  // The contract is read HERE, once, and handed to the pure function: the boundary check and the append are one
  // act, and a door that verified the boundary against a second reading of the contract would be two.
  const next = appendedRequestSet(recorded, document, await boundFeatureKeys(runDir), registry);
  assertRequestsOnlyAppended(recorded, next);
  await writeJson(path, next);
  const appended = next.requests.find((row) => row.documentId === document.documentId);
  if (appended === undefined) throw new Error(`The appended request for ${JSON.stringify(document.documentId)} is not in the set that was written`);
  return { path, artifact: next, appended };
}
