/**
 * WHO would have written a recorded unit, and WHERE its bytes came from — the two provenance terms of a v2 unit
 * record (R6b).
 *
 * WHY THIS IS ITS OWN FILE AND NOT PART OF THE IDENTITY. `unit-cache-identity.ts` needs the authorship to compute a
 * key; `unit-receipt.ts` and `unit-ledger.ts` need to RECORD both terms; and the identity file already imports the
 * receipt (the output contract is part of the key). Defining them in the identity file would make the receipt import
 * it back, which is a cycle `tests/layer-order.test.ts` refuses — and rightly: these two are vocabulary, not
 * derivation, so they sit beneath both.
 *
 * BOTH ARE REQUIRED FIELDS WITH NO DEFAULT, and that is the whole point of the pair.
 *
 *   * `authorship` — a draft written by one model family is not evidence that another family would write the same
 *     thing, so it is part of what a reused draft is an answer FOR. There is no "unknown" arm: an unknown author is
 *     precisely the case where reuse must not be considered at all. `model-free` must NAME its generator, because
 *     "not a model" is not an identity.
 *   * `provenance` — whether these bytes were written for this record or ADMITTED from a prior verified unit. Two
 *     arms, and the admitted arm carries the ledger row it came from: the epoch, the plan digest, the identity
 *     digest the decision was made on, and the three artifact digests the row promised. An admission whose source
 *     is not recorded is indistinguishable from a fresh draft the moment the run is read back, and "which of these
 *     units did a model actually write" is the first question an audit of a cache asks.
 *
 * THE PARSERS LIVE HERE TOO, so the receipt and the ledger check these two fields with ONE spelling. They return
 * problems as data (the caller names the file), and an unknown field is a problem rather than something ignored:
 * a record with an extra key is a record written by something that disagrees with this schema.
 */

import { assertNever } from "../base/artifact-result.ts";
import { isSha256Digest } from "./unit-output.ts";

/** The two arms of "who would have written this". Closed, required, no default and no unknown arm. */
export type UnitAuthorship =
  | { readonly kind: "model-family"; readonly family: string }
  | { readonly kind: "model-free"; readonly generator: string };

export const UNIT_AUTHORSHIP_KINDS = ["model-family", "model-free"] as const;

/** One sentence naming the author, for a reading or a refusal. Exhaustive over the two arms. */
export function describeAuthorship(authorship: UnitAuthorship): string {
  switch (authorship.kind) {
    case "model-family":
      return `model family ${authorship.family}`;
    case "model-free":
      return `model-free generator ${authorship.generator}`;
  }
  return assertNever(authorship, "unit authorship kind");
}

/** The authorship's own value. Checked non-empty by its callers: an empty family name is not a stated author. */
export function authorshipValue(authorship: UnitAuthorship): string {
  switch (authorship.kind) {
    case "model-family":
      return authorship.family;
    case "model-free":
      return authorship.generator;
  }
  return assertNever(authorship, "unit authorship kind");
}

/**
 * The ledger row a cache admission re-entered, as the fields that decided it.
 *
 * Every field is what it is for a reason an audit needs: the epoch and the plan digest say WHICH collection the
 * bytes were verified under, `packetIdentityDigest` is the key the reuse decision was made on, and the three
 * artifact digests are what the re-entered bytes had to reproduce exactly.
 */
export interface UnitCacheAdmissionSource {
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  readonly packetIdentityDigest: string;
  readonly contentDigest: string;
  readonly claimsDigest: string;
  readonly summaryDigest: string;
}

/** Where a recorded unit's bytes came from. Closed: written for this record, or admitted from a verified one. */
export type UnitProvenance =
  | { readonly kind: "fresh" }
  | { readonly kind: "cache-admitted"; readonly source: UnitCacheAdmissionSource };

export const UNIT_PROVENANCE_KINDS = ["cache-admitted", "fresh"] as const;

/** One sentence naming the origin of these bytes. Exhaustive over the two arms. */
export function describeProvenance(provenance: UnitProvenance): string {
  switch (provenance.kind) {
    case "fresh":
      return "written for this record";
    case "cache-admitted":
      return `admitted from a unit verified at knowledge epoch ${provenance.source.knowledgeEpoch} under plan ${provenance.source.planCatalogDigest.slice(0, 16)}, identity ${provenance.source.packetIdentityDigest.slice(0, 16)}`;
  }
  return assertNever(provenance, "unit provenance kind");
}

const ADMISSION_SOURCE_FIELDS = [
  "claimsDigest", "contentDigest", "knowledgeEpoch", "packetIdentityDigest", "planCatalogDigest", "summaryDigest"
] as const;

/** Every problem an untrusted value has as an authorship. Empty means valid. */
export function authorshipProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`is ${Array.isArray(value) ? "an array" : JSON.stringify(value)}, not an authorship object`];
  }
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const kind = row.kind;
  if (kind === "model-family" || kind === "model-free") {
    const field = kind === "model-family" ? "family" : "generator";
    for (const key of Object.keys(row).sort()) {
      if (key !== "kind" && key !== field) problems.push(`has unknown field ${JSON.stringify(key)}`);
    }
    const name = row[field];
    // Trimmed rather than trimmable: two spellings of one author are two identities, which is a cache miss that
    // reads as a real change. The boundary that accepted the name normalizes it; a record does not.
    if (typeof name !== "string" || name.trim() === "" || name.trim() !== name) {
      problems.push(`${field} ${JSON.stringify(name)} is not a non-empty name without surrounding whitespace`);
    }
    return problems;
  }
  return [`kind ${JSON.stringify(kind)} is not one of: ${UNIT_AUTHORSHIP_KINDS.join(", ")}`];
}

/** Every problem an untrusted value has as a provenance. Empty means valid. */
export function provenanceProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`is ${Array.isArray(value) ? "an array" : JSON.stringify(value)}, not a provenance object`];
  }
  const row = value as Record<string, unknown>;
  if (row.kind === "fresh") {
    return Object.keys(row).sort().filter((key) => key !== "kind").map((key) => `has unknown field ${JSON.stringify(key)}`);
  }
  if (row.kind !== "cache-admitted") {
    return [`kind ${JSON.stringify(row.kind)} is not one of: ${UNIT_PROVENANCE_KINDS.join(", ")}`];
  }
  const problems: string[] = [];
  for (const key of Object.keys(row).sort()) {
    if (key !== "kind" && key !== "source") problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  const source = row.source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return [...problems, `source ${JSON.stringify(source)} is not the ledger row this admission came from`];
  }
  const known = new Set<string>(ADMISSION_SOURCE_FIELDS);
  const sourceRow = source as Record<string, unknown>;
  for (const key of Object.keys(sourceRow).sort()) {
    if (!known.has(key)) problems.push(`source has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of ADMISSION_SOURCE_FIELDS) {
    if (!(key in sourceRow)) problems.push(`source is missing field ${JSON.stringify(key)}`);
  }
  if (!Number.isSafeInteger(sourceRow.knowledgeEpoch) || (sourceRow.knowledgeEpoch as number) < 0) {
    problems.push(`source knowledgeEpoch ${JSON.stringify(sourceRow.knowledgeEpoch)} is not a knowledge epoch`);
  }
  for (const key of ["planCatalogDigest", "packetIdentityDigest", "contentDigest", "claimsDigest", "summaryDigest"] as const) {
    if (!isSha256Digest(sourceRow[key])) problems.push(`source ${key} ${JSON.stringify(sourceRow[key])} is not a sha256 digest`);
  }
  return problems;
}
