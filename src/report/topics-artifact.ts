/**
 * `plan/topics.json` — the Topic Catalog of one frozen epoch, written once.
 *
 * `plan/` and not `report/`: the run directory already spends `reports/` on the assembled markdown, and two
 * directories separated only by a plural is a path nobody reads correctly twice. `plan/requests.json` landed here
 * first; `plan/catalog.json` and `plan/dag.json` join later.
 *
 * WRITE-ONCE WITH A READ-BACK. A second write of the identical catalog is a no-op; a second write of a different
 * one fails by name. The catalog is content-addressed by the epoch it projects, so "different bytes for the same
 * epoch" means the generator changed under a plan someone already made — replacing the file silently would make
 * every id downstream point at something that no longer says the same thing.
 *
 * THE READER RE-DERIVES. Every topic's `topicId` and `digest` are recomputed from the row's own content on read.
 * A hand-edited catalog therefore fails by name instead of reading as a plan the generator produced, and that is
 * what lets a later slice treat the file as a premise rather than as a hint.
 *
 * NO RUN-STAGE CALLER YET, deliberately: the first in-run consumer is R3's planner, and the placement plus the
 * command surface land with it. An entry point with no consumer is an optional path, and an optional path is the
 * remembered flag this codebase keeps paying for.
 */

import { join } from "node:path";
import { canonicalJson, exists, readJson, sha256, stableJson, writeJson } from "../base/util.ts";
import {
  materialityOf,
  confidenceOf,
  topicCandidateDigest,
  topicIdOf,
  TOPIC_FACETS,
  WORK_ITEM_STATUSES,
  type TopicCandidate,
  type TopicFacet
} from "./topic-candidate.ts";
import { TOPIC_CATALOG_VERSION, type TopicCatalogArtifact } from "./topic-catalog.ts";

export function topicsPath(runDir: string): string {
  return join(runDir, "plan", "topics.json");
}

/**
 * The catalog's content identity: canonical bytes of the whole artifact.
 *
 * Not a field of the artifact — a digest inside the thing it digests is either self-referential or excluded by a
 * rule every reader has to remember. Callers that need to record it (the eval readings, a later cache key) call
 * this.
 */
export function topicCatalogDigest(catalog: TopicCatalogArtifact): string {
  return sha256(canonicalJson(catalog));
}

/** Write the catalog once. Identical bytes are a no-op; different bytes for the same run are a named refusal. */
export async function writeTopicCatalog(runDir: string, catalog: TopicCatalogArtifact): Promise<TopicCatalogArtifact> {
  const path = topicsPath(runDir);
  if (await exists(path)) {
    const recorded = await readTopicCatalog(runDir);
    if (stableJson(recorded) !== stableJson(catalog)) {
      throw new Error(`${path} already records a different Topic Catalog (recorded digest ${topicCatalogDigest(recorded)}, offered ${topicCatalogDigest(catalog)}); the catalog is written once per epoch`);
    }
    return catalog;
  }
  await writeJson(path, catalog);
  return catalog;
}

/** Read and fully validate the catalog. Every failure names the file and what is wrong with it. */
export async function readTopicCatalog(runDir: string): Promise<TopicCatalogArtifact> {
  const path = topicsPath(runDir);
  let raw: unknown;
  try {
    raw = await readJson<unknown>(path);
  } catch (error) {
    throw new Error(`${path} could not be read as JSON: ${(error as Error).message}`);
  }
  const problems = topicCatalogProblems(raw);
  if (problems.length > 0) throw new Error(`${path} is not a valid Topic Catalog: ${problems.join("; ")}`);
  return raw as TopicCatalogArtifact;
}

const CATALOG_FIELDS = [
  "facets", "factRouting", "knowledgeDigest", "knowledgeEpoch", "materiality",
  "obligationAccounting", "runId", "snapshotId", "topics", "version"
] as const;

const TOPIC_FIELDS = [
  "bindings", "canonicalKey", "completeness", "confidence", "digest", "facet",
  "kind", "materiality", "relationIds", "source", "title", "topicId", "unknown"
] as const;

/** Every problem an untrusted value has as a Topic Catalog, as data. Empty means valid. */
export function topicCatalogProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["is not a catalog object"];
  const catalog = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(CATALOG_FIELDS);
  for (const key of Object.keys(catalog).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of CATALOG_FIELDS) {
    if (!(key in catalog)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  if (catalog.version !== TOPIC_CATALOG_VERSION) problems.push(`version ${JSON.stringify(catalog.version)} is not ${TOPIC_CATALOG_VERSION}`);
  problems.push(...facetCensusProblems(catalog.facets));
  if (!Array.isArray(catalog.topics)) return [...problems, `topics ${JSON.stringify(catalog.topics)} is not an array`];

  let previousId: string | null = null;
  const bound = new Set<string>();
  for (const [index, row] of (catalog.topics as unknown[]).entries()) {
    const rowProblems = topicProblems(row);
    for (const problem of rowProblems) problems.push(`topics[${index}] ${problem}`);
    if (rowProblems.length > 0) continue;
    const topic = row as TopicCandidate;
    if (previousId !== null && topic.topicId.localeCompare(previousId) <= 0) {
      problems.push(`topics[${index}] topicId ${JSON.stringify(topic.topicId)} does not follow ${JSON.stringify(previousId)}; the rows must be strictly ascending by topic id`);
    }
    previousId = topic.topicId;
    for (const binding of topic.bindings) bound.add(binding.workItemId);
  }
  problems.push(...accountingProblems(catalog.obligationAccounting, bound));
  return problems;
}

function facetCensusProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return [`facets ${JSON.stringify(value)} is not an array`];
  const problems: string[] = [];
  const rows = value as Array<Record<string, unknown>>;
  const facets = rows.map((row) => row?.facet);
  for (const [index, facet] of TOPIC_FACETS.entries()) {
    if (facets[index] !== facet) problems.push(`facets[${index}] is ${JSON.stringify(facets[index])}, not ${JSON.stringify(facet)}; every facet has a census row, in the declared order`);
  }
  if (rows.length !== TOPIC_FACETS.length) problems.push(`facets holds ${rows.length} rows, not the ${TOPIC_FACETS.length} declared facets`);
  for (const [index, row] of rows.entries()) {
    const outcome = row?.outcome as Record<string, unknown> | undefined;
    const state = outcome?.state;
    if (state === "populated") {
      if (typeof outcome?.topics !== "number") problems.push(`facets[${index}] populated outcome has no topic count`);
    } else if (state === "ledger-absent" || state === "ledger-empty") {
      if (typeof outcome?.reason !== "string" || (outcome.reason as string).trim() === "") {
        problems.push(`facets[${index}] ${String(state)} outcome carries no reason; an empty facet must say which ledger was not there`);
      }
    } else {
      problems.push(`facets[${index}] outcome state ${JSON.stringify(state)} is not populated, ledger-absent or ledger-empty`);
    }
  }
  return problems;
}

function accountingProblems(value: unknown, bound: ReadonlySet<string>): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [`obligationAccounting ${JSON.stringify(value)} is not an object`];
  const accounting = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of ["total", "assigned", "unassigned"]) {
    if (typeof accounting[field] !== "number") problems.push(`obligationAccounting.${field} ${JSON.stringify(accounting[field])} is not a number`);
  }
  if (!Array.isArray(accounting.unassignedWorkItemIds)) return [...problems, "obligationAccounting.unassignedWorkItemIds is not an array"];
  if (problems.length > 0) return problems;
  const total = accounting.total as number;
  const assigned = accounting.assigned as number;
  const unassigned = accounting.unassigned as number;
  if (assigned + unassigned !== total) {
    problems.push(`obligationAccounting does not conserve: ${assigned} assigned + ${unassigned} unassigned is not ${total} total`);
  }
  if ((accounting.unassignedWorkItemIds as unknown[]).length !== unassigned) {
    problems.push(`obligationAccounting names ${(accounting.unassignedWorkItemIds as unknown[]).length} unassigned work items but counts ${unassigned}`);
  }
  if (assigned !== bound.size) {
    problems.push(`obligationAccounting counts ${assigned} assigned work items but the topics bind ${bound.size}`);
  }
  return problems;
}

/**
 * One topic row, with its identity and digest RE-DERIVED.
 *
 * Re-deriving is the whole point: it means a hand-edited title, a swapped evidence id or a flipped materiality is
 * a named failure at the file boundary rather than a plan premise nobody re-checked. Materiality and confidence
 * are recomputed from the bindings for the same reason — they are derived facts, and a file that carries a
 * different answer is a file whose numbers were written by something other than the ledger.
 */
function topicProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["is not a topic object"];
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(TOPIC_FIELDS);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of TOPIC_FIELDS) {
    if (!(key in row)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  if (problems.length > 0) return problems;
  if (typeof row.facet !== "string" || !(TOPIC_FACETS as readonly string[]).includes(row.facet)) {
    return [`facet ${JSON.stringify(row.facet)} is not one of: ${TOPIC_FACETS.join(", ")}`];
  }
  if (typeof row.canonicalKey !== "string" || row.canonicalKey.trim() === "") return [`canonicalKey ${JSON.stringify(row.canonicalKey)} is not a non-empty string`];
  if (!Array.isArray(row.bindings)) return [`bindings ${JSON.stringify(row.bindings)} is not an array`];
  // Checked before anything is derived FROM them: `confidenceOf` classifies a status exhaustively and would
  // throw on a malformed row, turning a named file problem into a crash at the reader's boundary.
  const bindingShapes = (row.bindings as unknown[]).flatMap((value, index) => bindingProblems(value).map((problem) => `bindings[${index}] ${problem}`));
  if (bindingShapes.length > 0) return bindingShapes;
  const expectedId = topicIdOf(row.facet as TopicFacet, row.canonicalKey);
  if (row.topicId !== expectedId) {
    problems.push(`topicId ${JSON.stringify(row.topicId)} is not the id its canonical key derives (${expectedId})`);
  }
  const topic = row as unknown as TopicCandidate;
  const expectedMateriality = materialityOf(topic.bindings);
  if (topic.materiality !== expectedMateriality) {
    problems.push(`materiality ${JSON.stringify(topic.materiality)} is not the ${expectedMateriality} its bindings derive`);
  }
  const expectedConfidence = confidenceOf(topic.bindings);
  if (topic.confidence !== expectedConfidence) {
    problems.push(`confidence ${JSON.stringify(topic.confidence)} is not the ${expectedConfidence} its bindings derive`);
  }
  const { digest, ...rest } = topic;
  const expectedDigest = topicCandidateDigest(rest);
  if (digest !== expectedDigest) problems.push(`digest ${JSON.stringify(digest)} is not the digest of its own content (${expectedDigest})`);
  return problems;
}

const BINDING_FIELDS = ["dimension", "evidenceIds", "material", "status", "traceIds", "workItemId"] as const;

/** One obligation binding's shape. The 57B-453 row: ids attached to a work item, verbatim, or a named failure. */
function bindingProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["is not a binding object"];
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(BINDING_FIELDS);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of BINDING_FIELDS) {
    if (!(key in row)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  if (typeof row.workItemId !== "string" || row.workItemId.trim() === "") problems.push(`workItemId ${JSON.stringify(row.workItemId)} is not a non-empty string`);
  if (typeof row.dimension !== "string" || row.dimension.trim() === "") problems.push(`dimension ${JSON.stringify(row.dimension)} is not a non-empty string`);
  if (typeof row.material !== "boolean") problems.push(`material ${JSON.stringify(row.material)} is not a boolean`);
  if (typeof row.status !== "string" || !(WORK_ITEM_STATUSES as readonly string[]).includes(row.status)) {
    problems.push(`status ${JSON.stringify(row.status)} is not one of: ${WORK_ITEM_STATUSES.join(", ")}`);
  }
  for (const field of ["evidenceIds", "traceIds"] as const) {
    const ids = row[field];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.trim() === "")) {
      problems.push(`${field} ${JSON.stringify(ids)} is not an array of non-empty ids`);
    }
  }
  return problems;
}
