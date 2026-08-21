/**
 * The output contract of one authoring unit: `content.md`, `claims.json`, `summary.json` — and the digests that
 * tie the three together.
 *
 * THE SUMMARY IS REQUIRED FROM THE FIRST DAY, and that is a design decision with a reason, not an ambition. The
 * epic makes `summary.json` the ONLY thing a synthesis unit may read from its children: a parent that could fall
 * back to raw evidence is a parent that will. A field added later as optional is a field most units never carry,
 * and by the time a synthesis needs one the honest answer is "most of this run has none" — the remembered-flag
 * failure this codebase has already paid for twice. So a draft that does not hand over a legal summary is not a
 * draft with a missing extra; it is one of the ways a bad unit fails at draft time.
 *
 * WHAT CORE CHECKS, AND WHAT IT DOES NOT. The prose — `keyStatements`, `unknowns`, `terminology` — is model
 * content, and Core checks only its shape: present, non-blank, closed field set. What Core does check by
 * re-deriving is every claim the summary makes ABOUT the unit: `coveredTopicIds` must equal the plan's topics for
 * that unit exactly, `contentDigest` and `claimsDigest` must be the digests of the very bytes being written, and
 * `childSummaryDigests` must match the children the ledger says were collected. A summary is therefore either a
 * true statement about artifacts on disk or a named refusal; it is never a claim nobody checked.
 *
 * `coveredTopicIds` EQUALS THE PLAN'S TOPICS — NOT "IS CONTAINED IN". A subset would let a unit quietly drop a
 * topic it was given and still pass, which is precisely the silent narrowing gate 1b exists to catch one level
 * up. For a synthesis the plan hangs no topic at all, so its `coveredTopicIds` is empty and its coverage is
 * reachable only through its children — that is the shape the epic asks for, stated rather than implied.
 *
 * PARSE FAILURE IS FATAL AND EVERY INPUT LANDS IN A VISIBLE BUCKET: an unknown field is a problem, a missing
 * field is a problem, and there is no arm that returns a partially understood summary.
 */

import type { SectionClaim } from "../base/types.ts";
import { canonicalJson, sha256 } from "../base/util.ts";
import { AUTHORING_UNIT_KINDS, type AuthoringUnitKind } from "./plan-proposal.ts";
import { assertValidClaim } from "./claim-validity.ts";
import { compareUnitIds } from "./unit-paths.ts";

export const UNIT_CLAIMS_VERSION = "unit-claims-v1";
export const UNIT_SUMMARY_VERSION = "unit-summary-v1";

/** The claims sidecar of one unit. Unit-keyed: it carries no section index, because a unit has none. */
export interface UnitClaimsFile {
  readonly version: typeof UNIT_CLAIMS_VERSION;
  readonly unitId: string;
  readonly documentId: string;
  readonly claims: readonly SectionClaim[];
}

/** One term a unit defines for its reader. */
export interface UnitTerminologyEntry {
  readonly term: string;
  readonly meaning: string;
}

/** One child's summary identity, as the parent recorded it. */
export interface UnitChildSummaryDigest {
  readonly childUnitId: string;
  readonly summaryDigest: string;
}

export interface UnitSummary {
  readonly version: typeof UNIT_SUMMARY_VERSION;
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  /** Exactly the plan's topics for this unit, ascending. Empty for a synthesis, which hangs none. */
  readonly coveredTopicIds: readonly string[];
  /** Model content. At least one: a unit that states nothing has not been written. */
  readonly keyStatements: readonly string[];
  /** Model content. May be empty — but the field is always present, so "none" is stated, never absent. */
  readonly unknowns: readonly string[];
  readonly terminology: readonly UnitTerminologyEntry[];
  readonly contentDigest: string;
  readonly claimsDigest: string;
  /** The children a synthesis wrote from, ascending. Empty for every other kind. */
  readonly childSummaryDigests: readonly UnitChildSummaryDigest[];
}

export interface UnitSummaryParse {
  /** Non-null exactly when `problems` is empty. */
  readonly summary: UnitSummary | null;
  readonly problems: readonly string[];
}

/** What the summary must agree with: the plan row for this unit, and the bytes being written beside it. */
export interface UnitSummaryExpectation {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  /** The plan's topic ids for this unit, ascending. */
  readonly topicIds: readonly string[];
  readonly contentDigest: string;
  readonly claimsDigest: string;
  readonly childSummaryDigests: readonly UnitChildSummaryDigest[];
}

const SUMMARY_FIELDS = [
  "childSummaryDigests", "claimsDigest", "contentDigest", "coveredTopicIds", "documentId",
  "keyStatements", "kind", "terminology", "unitId", "unknowns", "version"
] as const;

const TERMINOLOGY_FIELDS = ["meaning", "term"] as const;
const CHILD_DIGEST_FIELDS = ["childUnitId", "summaryDigest"] as const;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** One spelling of "this is a sha256 digest", shared by the summary, the receipt and the ledger. */
export function isSha256Digest(value: unknown): boolean {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/** The digest of one unit's normalized content: the bytes that land in `content.md`. */
export function unitContentDigest(normalizedContent: string): string {
  return sha256(normalizedContent);
}

/** The digest of one unit's claims sidecar, over its canonical form so file formatting cannot move it. */
export function unitClaimsDigest(claims: UnitClaimsFile): string {
  return sha256(canonicalJson(claims));
}

/** The digest of one unit's summary. What a receipt records and a parent references. */
export function unitSummaryDigest(summary: UnitSummary): string {
  return sha256(canonicalJson(summary));
}

/**
 * Validate the claims a unit draft was handed and return the sidecar to write.
 *
 * Per-claim rules come from `assertValidClaim` (`claim-validity.ts`), not a second copy of them: one spelling of
 * "this claim is valid" is the only way the two claims doors cannot drift. An EMPTY claim list is legal
 * and still writes a sidecar: the file always exists, so `claimsDigest` always means something and no unit is in
 * the state "has claims that were never written down".
 */
export function validateUnitClaims(unitId: string, documentId: string, claims: readonly SectionClaim[]): UnitClaimsFile {
  if (!Array.isArray(claims)) throw new Error(`Claims for unit ${JSON.stringify(unitId)} must be an array`);
  const seen = new Set<string>();
  for (const claim of claims) {
    assertValidClaim(claim, `unit ${unitId}`);
    if (seen.has(claim.id)) throw new Error(`Unit ${JSON.stringify(unitId)} states claim id ${JSON.stringify(claim.id)} twice; a claim id is what a trace and an audit reference`);
    seen.add(claim.id);
  }
  return { version: UNIT_CLAIMS_VERSION, unitId, documentId, claims: [...claims] };
}

export interface UnitClaimsParse {
  /** Non-null exactly when `problems` is empty. */
  readonly claims: UnitClaimsFile | null;
  readonly problems: readonly string[];
}

const CLAIMS_FIELDS = ["claims", "documentId", "unitId", "version"] as const;

/**
 * Parse an untrusted claims sidecar back off disk.
 *
 * The WRITE side (`validateUnitClaims`) throws, because a draft handing over a bad claim is a refusal at the entry.
 * The READ side returns problems as data, because its caller — the grounding audit, running inside the collect
 * barrier — names the file it read. Per-claim rules come from `assertValidClaim` either way: one spelling of "this
 * claim is valid", so the reader cannot be weaker than the writer.
 */
export function parseUnitClaims(value: unknown): UnitClaimsParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { claims: null, problems: [`is ${Array.isArray(value) ? "an array" : JSON.stringify(value)}, not a claims sidecar object`] };
  }
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(CLAIMS_FIELDS);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of CLAIMS_FIELDS) {
    if (!(key in row)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  if (row.version !== UNIT_CLAIMS_VERSION) problems.push(`version ${JSON.stringify(row.version)} is not ${UNIT_CLAIMS_VERSION}`);
  for (const key of ["unitId", "documentId"] as const) {
    if (typeof row[key] !== "string" || (row[key] as string).trim() === "") problems.push(`${key} ${JSON.stringify(row[key])} is not a non-empty string`);
  }
  if (!Array.isArray(row.claims)) problems.push(`claims ${JSON.stringify(row.claims)} is not an array`);
  else {
    for (const [index, claim] of (row.claims as unknown[]).entries()) {
      try {
        assertValidClaim(claim as SectionClaim, `claims[${index}]`);
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
  }
  if (problems.length > 0) return { claims: null, problems };
  return { claims: row as unknown as UnitClaimsFile, problems: [] };
}

/** Parse an untrusted summary. Every problem is returned as data; the caller names the source. */
export function parseUnitSummary(value: unknown): UnitSummaryParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { summary: null, problems: [`is ${Array.isArray(value) ? "an array" : JSON.stringify(value)}, not a summary object`] };
  }
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(SUMMARY_FIELDS);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of SUMMARY_FIELDS) {
    if (!(key in row)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  if (row.version !== UNIT_SUMMARY_VERSION) problems.push(`version ${JSON.stringify(row.version)} is not ${UNIT_SUMMARY_VERSION}`);
  for (const key of ["unitId", "documentId"] as const) {
    if (typeof row[key] !== "string" || (row[key] as string).trim() === "") problems.push(`${key} ${JSON.stringify(row[key])} is not a non-empty string`);
  }
  if (typeof row.kind !== "string" || !(AUTHORING_UNIT_KINDS as readonly string[]).includes(row.kind)) {
    problems.push(`kind ${JSON.stringify(row.kind)} is not one of: ${AUTHORING_UNIT_KINDS.join(", ")}`);
  }
  for (const key of ["contentDigest", "claimsDigest"] as const) {
    if (!isSha256Digest(row[key])) problems.push(`${key} ${JSON.stringify(row[key])} is not a sha256 digest`);
  }
  problems.push(...idListProblems(row.coveredTopicIds, "coveredTopicIds"));
  problems.push(...textListProblems(row.keyStatements, "keyStatements"));
  if (Array.isArray(row.keyStatements) && (row.keyStatements as unknown[]).length === 0) {
    problems.push("keyStatements is empty; a unit that states nothing has not been written");
  }
  problems.push(...textListProblems(row.unknowns, "unknowns"));
  problems.push(...terminologyProblems(row.terminology));
  problems.push(...childDigestProblems(row.childSummaryDigests));
  if (problems.length > 0) return { summary: null, problems };
  return {
    summary: {
      version: UNIT_SUMMARY_VERSION,
      unitId: row.unitId as string,
      documentId: row.documentId as string,
      kind: row.kind as AuthoringUnitKind,
      coveredTopicIds: row.coveredTopicIds as readonly string[],
      keyStatements: row.keyStatements as readonly string[],
      unknowns: row.unknowns as readonly string[],
      terminology: row.terminology as readonly UnitTerminologyEntry[],
      contentDigest: row.contentDigest as string,
      claimsDigest: row.claimsDigest as string,
      childSummaryDigests: row.childSummaryDigests as readonly UnitChildSummaryDigest[]
    },
    problems: []
  };
}

/**
 * Where a well-shaped summary disagrees with the plan and the bytes it claims to describe, as data.
 *
 * Each comparison prints BOTH sides. A digest mismatch reported as "digest mismatch" tells an author nothing they
 * can act on; the recorded value beside the derived one tells them whether they summarised the wrong draft or
 * edited the content afterwards.
 */
export function unitSummaryAgreementProblems(summary: UnitSummary, expectation: UnitSummaryExpectation): string[] {
  const problems: string[] = [];
  if (summary.unitId !== expectation.unitId) problems.push(`names unit ${JSON.stringify(summary.unitId)}, but it is the summary of ${JSON.stringify(expectation.unitId)}`);
  if (summary.documentId !== expectation.documentId) problems.push(`names document ${JSON.stringify(summary.documentId)}, but the plan puts this unit in ${JSON.stringify(expectation.documentId)}`);
  if (summary.kind !== expectation.kind) problems.push(`declares kind ${JSON.stringify(summary.kind)}, but the plan records ${JSON.stringify(expectation.kind)}`);
  const covered = [...summary.coveredTopicIds];
  const planned = [...expectation.topicIds];
  if (canonicalJson(covered) !== canonicalJson(planned)) {
    problems.push(`covers topic(s) [${covered.join(", ")}] but the plan gives this unit [${planned.join(", ")}]; a summary covers its unit's topics exactly, neither fewer nor more`);
  }
  if (summary.contentDigest !== expectation.contentDigest) {
    problems.push(`records contentDigest ${summary.contentDigest} but the content beside it digests to ${expectation.contentDigest}`);
  }
  if (summary.claimsDigest !== expectation.claimsDigest) {
    problems.push(`records claimsDigest ${summary.claimsDigest} but the claims beside it digest to ${expectation.claimsDigest}`);
  }
  if (canonicalJson(summary.childSummaryDigests) !== canonicalJson(expectation.childSummaryDigests)) {
    problems.push(`records child summaries ${canonicalJson(summary.childSummaryDigests)} but its collected children are ${canonicalJson(expectation.childSummaryDigests)}`);
  }
  return problems;
}

/** Ascending and de-duplicated, so one summary has one byte form. An unsorted list is a problem, not sorted here. */
function idListProblems(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.trim() === "")) {
    return [`${field} ${JSON.stringify(value)} is not an array of non-empty ids`];
  }
  const ids = value as string[];
  const sortedUnique = [...new Set(ids)].sort(compareUnitIds);
  if (ids.length !== sortedUnique.length || ids.some((id, index) => id !== sortedUnique[index])) {
    return [`${field} ${JSON.stringify(ids)} is not sorted and de-duplicated; two identical summaries would then differ by byte`];
  }
  return [];
}

/** Shape only. A per-field floor is stated at the call site, where the reason for it can be stated with it. */
function textListProblems(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    return [`${field} ${JSON.stringify(value)} is not an array of non-empty strings`];
  }
  return [];
}

function terminologyProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return [`terminology ${JSON.stringify(value)} is not an array`];
  const problems: string[] = [];
  for (const [index, entry] of (value as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push(`terminology[${index}] is not a term object`);
      continue;
    }
    const keys = Object.keys(entry).sort();
    if (canonicalJson(keys) !== canonicalJson([...TERMINOLOGY_FIELDS])) {
      problems.push(`terminology[${index}] has fields ${keys.join(", ")}; a term carries exactly ${TERMINOLOGY_FIELDS.join(" and ")}`);
      continue;
    }
    const row = entry as Record<string, unknown>;
    for (const key of TERMINOLOGY_FIELDS) {
      if (typeof row[key] !== "string" || (row[key] as string).trim() === "") problems.push(`terminology[${index}] ${key} ${JSON.stringify(row[key])} is not a non-empty string`);
    }
  }
  return problems;
}

function childDigestProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return [`childSummaryDigests ${JSON.stringify(value)} is not an array`];
  const problems: string[] = [];
  let previous: string | null = null;
  for (const [index, entry] of (value as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push(`childSummaryDigests[${index}] is not a child summary object`);
      continue;
    }
    const keys = Object.keys(entry).sort();
    if (canonicalJson(keys) !== canonicalJson([...CHILD_DIGEST_FIELDS])) {
      problems.push(`childSummaryDigests[${index}] has fields ${keys.join(", ")}; a child reference carries exactly ${CHILD_DIGEST_FIELDS.join(" and ")}`);
      continue;
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.childUnitId !== "string" || (row.childUnitId as string).trim() === "") {
      problems.push(`childSummaryDigests[${index}] childUnitId ${JSON.stringify(row.childUnitId)} is not a non-empty string`);
      continue;
    }
    if (!isSha256Digest(row.summaryDigest)) {
      problems.push(`childSummaryDigests[${index}] summaryDigest ${JSON.stringify(row.summaryDigest)} is not a sha256 digest`);
    }
    if (previous !== null && compareUnitIds(row.childUnitId as string, previous) <= 0) {
      problems.push(`childSummaryDigests[${index}] childUnitId ${JSON.stringify(row.childUnitId)} does not follow ${JSON.stringify(previous)}; the rows must be strictly ascending`);
    }
    previous = row.childUnitId as string;
  }
  return problems;
}
