/**
 * `plan/requests.json` — the v2 request row prepare recorded for each planned document.
 *
 * `plan/` and not `report/`: the run directory already has `reports/` for the assembled markdown, and two
 * directories separated only by a plural is a path nobody can read at a glance. The later slices' planning
 * artifacts (`plan/topics.json`, `plan/catalog.json`, `plan/dag.json`) join this one here.
 *
 * A RECORD, not yet a premise: authoring still runs off the template sections the bound contract materialised,
 * and nothing reads this file back to steer it (that cutover is the epic's R3+). What the record buys now is the
 * audit trail the epic's R1 acceptance asks for — which reader, which document task, which knowledge boundary,
 * and the digest of the exact policy bytes each was resolved against.
 *
 * Write-once with a read-back: a second write into the same run directory must reproduce the same artifact or
 * fail by name. That is also what gives the reader a caller — the validation below is not test-only scaffolding,
 * it is what the second write runs through.
 *
 * The reader verifies the recorded policy references against the LIVE registry, so a hand-edited digest, a
 * swapped policy id or an unknown enum member fails by name instead of reading as a request nobody made. A
 * policy version bump therefore invalidates records written under the old one — deliberately: the epic does not
 * carry old runs across schema generations, it audits them under the contract they recorded.
 */

import { join } from "node:path";
import { exists, readJson, stableJson, writeJson } from "../base/util.ts";
import {
  LEGACY_REQUEST_MAPPING_VERSION,
  mapLegacyDocumentRequest,
  type LegacyDocumentRequest
} from "./legacy-request-mapping.ts";
import {
  intentPolicyFor,
  lensPolicyFor,
  policyReference,
  REPORT_POLICY_REGISTRY,
  type PolicyReference,
  type ReportPolicyRegistry
} from "./report-policy-registry.ts";
import { parseReportRequestV2, type ReportRequestV2 } from "./report-request-v2.ts";

export const REPORT_REQUESTS_ARTIFACT_VERSION = "report-requests-v1";

export interface ReportRequestRecord {
  readonly documentId: string;
  readonly request: ReportRequestV2;
  readonly lensPolicy: PolicyReference;
  readonly intentPolicy: PolicyReference;
  readonly mappingVersion: string;
}

export interface ReportRequestsArtifact {
  readonly version: string;
  /** Strictly ascending by `documentId`: the requests are a set keyed by document, so their order is canonical. */
  readonly requests: readonly ReportRequestRecord[];
}

export function reportRequestsPath(runDir: string): string {
  return join(runDir, "plan", "requests.json");
}

/**
 * Build the artifact for one run's planned documents.
 *
 * A refused mapping throws. The mapping returns the refusal as data so this caller can name the document, and
 * this caller makes it a hard error because that is the verdict the existing prd-overview guard already gives the
 * same fact — an artifact that quietly omitted the row would be a document with no recorded request.
 */
export function buildReportRequestsArtifact(
  documents: readonly LegacyDocumentRequest[],
  registry: ReportPolicyRegistry = REPORT_POLICY_REGISTRY
): ReportRequestsArtifact {
  const records: ReportRequestRecord[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    if (seen.has(document.documentId)) throw new Error(`Two planned documents share the id ${JSON.stringify(document.documentId)}; a recorded request must name exactly one document`);
    seen.add(document.documentId);
    const mapping = mapLegacyDocumentRequest(document);
    if (mapping.outcome === "refused") {
      throw new Error(`Document ${JSON.stringify(document.documentId)} has no v2 request: ${mapping.reason}`);
    }
    records.push({
      documentId: document.documentId,
      request: mapping.request,
      lensPolicy: policyReference(lensPolicyFor(mapping.request.audience, registry)),
      intentPolicy: policyReference(intentPolicyFor(mapping.request.intent, registry)),
      mappingVersion: LEGACY_REQUEST_MAPPING_VERSION
    });
  }
  return {
    version: REPORT_REQUESTS_ARTIFACT_VERSION,
    requests: records.sort((a, b) => a.documentId.localeCompare(b.documentId))
  };
}

/**
 * Write the artifact once. Writing the identical artifact again is a no-op; writing a different one fails by
 * name rather than replacing a record other artifacts already point at.
 */
export async function writeReportRequests(
  runDir: string,
  documents: readonly LegacyDocumentRequest[],
  registry: ReportPolicyRegistry = REPORT_POLICY_REGISTRY
): Promise<ReportRequestsArtifact> {
  const artifact = buildReportRequestsArtifact(documents, registry);
  const path = reportRequestsPath(runDir);
  if (await exists(path)) {
    const recorded = await readReportRequests(runDir, registry);
    if (stableJson(recorded) !== stableJson(artifact)) {
      throw new Error(`${path} already records a different request set; report requests are written once per run`);
    }
    return artifact;
  }
  await writeJson(path, artifact);
  return artifact;
}

/** Read and validate the artifact. Every failure names the file and what is wrong with it; none returns empty. */
export async function readReportRequests(
  runDir: string,
  registry: ReportPolicyRegistry = REPORT_POLICY_REGISTRY
): Promise<ReportRequestsArtifact> {
  const path = reportRequestsPath(runDir);
  let raw: unknown;
  try {
    raw = await readJson<unknown>(path);
  } catch (error) {
    throw new Error(`${path} could not be read as JSON: ${(error as Error).message}`);
  }
  const problems = reportRequestsProblems(raw, registry);
  if (problems.length > 0) throw new Error(`${path} is not a valid report requests artifact: ${problems.join("; ")}`);
  return raw as ReportRequestsArtifact;
}

/** Every problem an untrusted value has as a report requests artifact, as data. Empty means valid. */
export function reportRequestsProblems(value: unknown, registry: ReportPolicyRegistry = REPORT_POLICY_REGISTRY): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["is not an artifact object"];
  const artifact = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(artifact).sort()) {
    if (key !== "version" && key !== "requests") problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  if (artifact.version !== REPORT_REQUESTS_ARTIFACT_VERSION) {
    problems.push(`version ${JSON.stringify(artifact.version)} is not ${REPORT_REQUESTS_ARTIFACT_VERSION}`);
  }
  if (!Array.isArray(artifact.requests)) return [...problems, `requests ${JSON.stringify(artifact.requests)} is not an array`];
  let previousId: string | null = null;
  for (const [index, row] of (artifact.requests as unknown[]).entries()) {
    const rowProblems = recordProblems(row, registry);
    for (const problem of rowProblems) problems.push(`requests[${index}] ${problem}`);
    if (rowProblems.length > 0) continue;
    const documentId = (row as ReportRequestRecord).documentId;
    if (previousId !== null && documentId.localeCompare(previousId) <= 0) {
      problems.push(`requests[${index}] documentId ${JSON.stringify(documentId)} does not follow ${JSON.stringify(previousId)}; the rows must be strictly ascending by document`);
    }
    previousId = documentId;
  }
  return problems;
}

const RECORD_FIELDS = ["documentId", "intentPolicy", "lensPolicy", "mappingVersion", "request"] as const;

function recordProblems(value: unknown, registry: ReportPolicyRegistry): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["is not a record object"];
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(RECORD_FIELDS);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  if (typeof row.documentId !== "string" || row.documentId.trim() === "") problems.push(`documentId ${JSON.stringify(row.documentId)} is not a non-empty string`);
  if (row.mappingVersion !== LEGACY_REQUEST_MAPPING_VERSION) problems.push(`mappingVersion ${JSON.stringify(row.mappingVersion)} is not ${LEGACY_REQUEST_MAPPING_VERSION}`);
  const parsed = parseReportRequestV2(row.request);
  for (const problem of parsed.problems) problems.push(`request ${problem}`);
  if (parsed.request === null) return problems;
  if (parsed.request.policyVersion !== registry.version) {
    problems.push(`request policyVersion ${JSON.stringify(parsed.request.policyVersion)} is not the registry's ${JSON.stringify(registry.version)}`);
  }
  problems.push(...referenceProblems("lensPolicy", row.lensPolicy, policyReference(lensPolicyFor(parsed.request.audience, registry))));
  problems.push(...referenceProblems("intentPolicy", row.intentPolicy, policyReference(intentPolicyFor(parsed.request.intent, registry))));
  return problems;
}

/**
 * A recorded policy reference must equal, byte for byte, the reference the live registry produces for that
 * request's audience/intent. Comparing the whole reference is what makes a swapped id, a stale version and a
 * hand-edited digest all one named failure instead of three checks one of which gets forgotten.
 */
function referenceProblems(field: string, recorded: unknown, expected: PolicyReference): string[] {
  if (stableJson(recorded) === stableJson(expected)) return [];
  return [`${field} ${JSON.stringify(recorded)} is not the registry's ${JSON.stringify(expected)}`];
}
