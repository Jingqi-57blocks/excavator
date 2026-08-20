import type { InvestigationWorkItem } from "../base/types.ts";
import { canonicalJson, sha256 } from "../base/util.ts";

/**
 * Which work-item fields a frozen epoch's `judgementDigest` covers, and which version of that answer the
 * epoch recorded.
 *
 * The version travels IN the digest value because the shape lives there. `manifest.assuranceVersion` cannot
 * answer it: a re-freeze appends an epoch to a chain whose earlier epochs were sealed by an older build, so
 * "which field set does THIS digest cover" is a per-record question, not a per-run one.
 *
 * v1 — every epoch frozen before this module existed — sealed a chosen list: id, status, reason, settledBy,
 * searchScope, evidenceIds, traceIds. That sealed the dispositions and their grounding while leaving the
 * fields that decide WHICH obligations must be grounded outside every digest. The grounding audit's
 * denominator is `material && requiredFor.includes(document) && origin !== "open"`
 * (`auditWorkItemClaimCoverage`), and `dimension` decides whether the material-flow trace rule applies at
 * all (`auditWorkItems`). None of those four was in `workitemsDigest` either — that one covers `{id, status}`
 * — so a sealed run's "how many obligations must be grounded" number stayed editable after freeze, with no
 * digest to go red.
 *
 * v2 seals the work item WHOLE. A chosen list is a second definition of the record: the next field added to
 * `InvestigationWorkItem` re-opens the same hole without anyone editing this file, which is how the two
 * fields above escaped in the first place. The record itself has no such seam. v1's list is kept verbatim
 * below only so archived epochs keep recomputing — never extend it; a wider field set is a new version.
 */
export type JudgementSealVersion = "judgement-seal-v1" | "judgement-seal-v2";

/**
 * v1 predates the label: its digest is a bare sha256 and its payload carries no version key. Fixed forever,
 * because changing either would change what every archived digest is compared against.
 */
const UNLABELLED_SEAL: JudgementSealVersion = "judgement-seal-v1";

/** The version every new freeze writes. */
export const CURRENT_JUDGEMENT_SEAL: JudgementSealVersion = "judgement-seal-v2";

/**
 * A `Record` over the version union rather than a switch: adding a version to the union fails to compile
 * until its field set exists, so no version can be readable without being computable.
 */
const SEALED_FIELDS: Record<JudgementSealVersion, (item: InvestigationWorkItem) => unknown> = {
  "judgement-seal-v1": v1Fields,
  "judgement-seal-v2": v2Fields
};

/** v1's field list. Frozen verbatim: archived epochs recompute through here. */
function v1Fields(item: InvestigationWorkItem): unknown {
  return {
    id: item.id,
    status: item.status,
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
    ...(item.settledBy !== undefined ? { settledBy: item.settledBy } : {}),
    ...(item.searchScope !== undefined ? { searchScope: item.searchScope } : {}),
    evidenceIds: sortedIds(item.evidenceIds),
    traceIds: sortedIds(item.traceIds)
  };
}

/** v2: the record whole, with its three order-insensitive id sets normalized so a reorder is not a change. */
function v2Fields(item: InvestigationWorkItem): unknown {
  return {
    ...item,
    requiredFor: sortedIds(item.requiredFor),
    evidenceIds: sortedIds(item.evidenceIds),
    traceIds: sortedIds(item.traceIds)
  };
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * A `judgementDigest` read off disk. `unreadable` is a state, not a fallback: an unknown label must surface
 * as a finding rather than be recomputed under a guessed field set, which would report a mismatch that says
 * nothing about whether the ledger actually changed.
 */
export type RecordedJudgementSeal =
  | { version: JudgementSealVersion; value: string }
  | { version: "unreadable"; value: string };

const LABELLED_SEAL = /^(judgement-seal-v[1-9][0-9]*):([0-9a-f]{64})$/;
const BARE_SEAL = /^[0-9a-f]{64}$/;

function isSealVersion(value: string): value is JudgementSealVersion {
  return Object.hasOwn(SEALED_FIELDS, value);
}

export function readJudgementSeal(recorded: string): RecordedJudgementSeal {
  if (BARE_SEAL.test(recorded)) return { version: UNLABELLED_SEAL, value: recorded };
  const labelled = LABELLED_SEAL.exec(recorded)?.[1];
  // A labelled v1 is not a shape any build writes, so it is unreadable rather than legacy.
  if (labelled && labelled !== UNLABELLED_SEAL && isSealVersion(labelled)) return { version: labelled, value: recorded };
  return { version: "unreadable", value: recorded };
}

/**
 * The sealed judgement value: work items under `version`'s field set plus the already-canonical L7 result
 * set. The version is hashed into the payload as well as prefixed onto the value, so relabelling a digest
 * cannot make it verify.
 */
export function judgementSeal(items: readonly InvestigationWorkItem[], canonicalResults: unknown, version: JudgementSealVersion): string {
  const workitems = [...items].sort((a, b) => a.id.localeCompare(b.id)).map((item) => SEALED_FIELDS[version](item));
  if (version === UNLABELLED_SEAL) return sha256(canonicalJson({ workitems, investigationResults: canonicalResults }));
  return `${version}:${sha256(canonicalJson({ sealVersion: version, workitems, investigationResults: canonicalResults }))}`;
}
