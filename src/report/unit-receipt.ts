/**
 * The commit marker one unit draft writes last: `units/<key>/receipt.json`.
 *
 * WHY LAST. A draft writes content, claims and summary first and the receipt only when all three are on disk, so
 * a draft that dies mid-write leaves no receipt and `collect` never records a half-written unit. The receipt is
 * the promise `collect` verifies, which is why it carries the three digests: a promise whose subject was edited
 * afterwards is a named refusal, not a checkpoint over bytes nobody re-checked.
 *
 * `knowledgeEpoch` IS REQUIRED, unlike `DraftReceipt`'s optional one. That optionality is a grandfathering
 * clause for runs archived before epochs existed, and there are none for units — the unit path is new, and every
 * unit is drafted through a gate that already refuses an unfrozen run. Copying the optional shape would have
 * meant a stale-epoch check that reads `undefined !== 0` as "fine" on the one receipt where it matters most.
 *
 * `planCatalogDigest` IS THE SECOND HALF OF THAT IDENTITY. The epoch says which knowledge the draft read; the
 * plan digest says which plan gave the unit its title, its topics and its children. A receipt written against a
 * superseded plan is refused by name rather than collected into a ledger that then disagrees with the plan.
 */

import { AUTHORING_UNIT_KINDS, type AuthoringUnitKind } from "./plan-proposal.ts";
import { isSha256Digest } from "./unit-output.ts";

export const UNIT_RECEIPT_VERSION = "unit-receipt-v1";

export interface UnitDraftReceipt {
  readonly version: typeof UNIT_RECEIPT_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  readonly draftedAt: string;
  /** True when this draft replaced a version that was already on disk; the replaced one is in `history/`. */
  readonly revision: boolean;
  readonly contentDigest: string;
  readonly claimsDigest: string;
  readonly summaryDigest: string;
  readonly evidenceIds: readonly string[];
  readonly traceIds: readonly string[];
}

export interface UnitReceiptParse {
  /** Non-null exactly when `problems` is empty. */
  readonly receipt: UnitDraftReceipt | null;
  readonly problems: readonly string[];
}

const RECEIPT_FIELDS = [
  "claimsDigest", "contentDigest", "documentId", "draftedAt", "evidenceIds", "kind", "knowledgeEpoch",
  "planCatalogDigest", "revision", "runId", "summaryDigest", "traceIds", "unitId", "version"
] as const;

/** Parse an untrusted receipt. Every problem as data; the caller names the file. */
export function parseUnitReceipt(value: unknown): UnitReceiptParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { receipt: null, problems: [`is ${Array.isArray(value) ? "an array" : JSON.stringify(value)}, not a receipt object`] };
  }
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(RECEIPT_FIELDS);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of RECEIPT_FIELDS) {
    if (!(key in row)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  if (row.version !== UNIT_RECEIPT_VERSION) problems.push(`version ${JSON.stringify(row.version)} is not ${UNIT_RECEIPT_VERSION}`);
  for (const key of ["runId", "unitId", "documentId", "draftedAt"] as const) {
    if (typeof row[key] !== "string" || (row[key] as string).trim() === "") problems.push(`${key} ${JSON.stringify(row[key])} is not a non-empty string`);
  }
  if (!Number.isSafeInteger(row.knowledgeEpoch) || (row.knowledgeEpoch as number) < 0) {
    problems.push(`knowledgeEpoch ${JSON.stringify(row.knowledgeEpoch)} is not a knowledge epoch; a unit receipt always records the epoch it was drafted from`);
  }
  if (typeof row.kind !== "string" || !(AUTHORING_UNIT_KINDS as readonly string[]).includes(row.kind)) {
    problems.push(`kind ${JSON.stringify(row.kind)} is not one of: ${AUTHORING_UNIT_KINDS.join(", ")}`);
  }
  if (typeof row.revision !== "boolean") problems.push(`revision ${JSON.stringify(row.revision)} is not a boolean`);
  for (const key of ["planCatalogDigest", "contentDigest", "claimsDigest", "summaryDigest"] as const) {
    if (!isSha256Digest(row[key])) problems.push(`${key} ${JSON.stringify(row[key])} is not a sha256 digest`);
  }
  for (const key of ["evidenceIds", "traceIds"] as const) {
    const value_ = row[key];
    if (!Array.isArray(value_) || value_.some((id) => typeof id !== "string" || id.trim() === "")) {
      problems.push(`${key} ${JSON.stringify(value_)} is not an array of non-empty ids`);
    }
  }
  if (problems.length > 0) return { receipt: null, problems };
  return { receipt: row as unknown as UnitDraftReceipt, problems: [] };
}
