/**
 * `plan/catalog.json` and `plan/dag.json` — the validated plan of one epoch, written once.
 *
 * BINDINGS ARE PASSED BY REFERENCE, NEVER FLATTENED. A unit row carries `{ topicId, topicDigest }` and nothing
 * else about its topics: no work-item ids, no evidence ids, no trace ids. R4's unit packet goes topicId →
 * `plan/topics.json` → that topic's `bindings`, where every obligation still owns its own evidence and trace ids.
 * 57B-453 is what the other design costs — flatten the ids into a topic-level bag here and 60% of a document's
 * material work items can no longer be told apart from each other, which is exactly the grounding failure the
 * epic's gate 1b exists to catch. The `topicDigest` is what makes the reference safe: a topic whose content moved
 * no longer matches the plan that referenced it, and the reader below says so by name.
 *
 * WHAT THE PLAN CATALOG DOES CARRY that is not a reference: the disposition rows (a plan decision, not knowledge)
 * and gate 1b's obligation accounting (the audited reading — including the by-id list of every material obligation
 * a waiving disposition removed). Both are RE-DERIVED on read from the topics catalog, so a hand-edited waived
 * list, a swapped disposition or a moved topic digest is a named failure at the file boundary instead of a premise
 * nobody re-checked.
 *
 * WRITE-ONCE WITH A READ-BACK, the same shape as `topics-artifact.ts`: identical bytes are a no-op, different
 * bytes for the same run are a named refusal. A plan is what the units downstream were written against; replacing
 * it silently would leave every receipt pointing at a plan that no longer says the same thing.
 */

import { join } from "node:path";
import { assertNever } from "../base/artifact-result.ts";
import { canonicalJson, exists, readJson, sha256, stableJson, writeJson } from "../base/util.ts";
import { accountPlanObligations, type PlanObligationAccounting } from "./plan-obligation-conservation.ts";
import { planBudgetProblems, type PlanBudget } from "./plan-budget.ts";
import {
  AUTHORING_UNIT_KINDS,
  PLAN_PROPOSAL_VERSION,
  unitChildIds,
  unitTopicIds,
  type AuthoringUnitKind,
  type PlanProposal,
  type ProposedUnit
} from "./plan-proposal.ts";
import { unitDagOrder, type PlanValidationReport } from "./plan-validation.ts";
import { REPORT_POLICY_VERSION } from "./report-policy-registry.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";
import { topicCatalogDigest } from "./topics-artifact.ts";
import type { TopicCatalogArtifact } from "./topic-catalog.ts";
import type { TopicDisposition } from "./topic-disposition.ts";

export const PLAN_CATALOG_VERSION = "plan-catalog-v1";
export const PLAN_DAG_VERSION = "plan-dag-v1";

export function planCatalogPath(runDir: string): string {
  return join(runDir, "plan", "catalog.json");
}

export function planDagPath(runDir: string): string {
  return join(runDir, "plan", "dag.json");
}

/** A topic reference: the id to look up in `plan/topics.json`, and the digest it must still have. */
export interface PlanTopicReference {
  readonly topicId: string;
  readonly topicDigest: string;
}

export interface PlanCatalogUnit {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  readonly title: string;
  /** Empty for a synthesis unit — it writes from child summaries, so it references no topic at all. */
  readonly topics: readonly PlanTopicReference[];
  /** Empty for every kind but synthesis. */
  readonly childUnitIds: readonly string[];
}

export interface PlanCatalogDocument {
  readonly documentId: string;
  readonly rootUnitId: string;
  readonly units: number;
  readonly inputBytes: number;
}

export interface PlanCatalogArtifact {
  readonly version: typeof PLAN_CATALOG_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly knowledgeDigest: string;
  /** The digest of the `plan/topics.json` this plan references. A different catalog is a different plan. */
  readonly topicsDigest: string;
  readonly requestsDigest: string;
  readonly policyVersion: string;
  readonly proposalVersion: string;
  readonly budget: PlanBudget;
  /** Ascending by `documentId`. */
  readonly documents: readonly PlanCatalogDocument[];
  /** Strictly ascending by `unitId`. */
  readonly units: readonly PlanCatalogUnit[];
  /** Ascending by `topicId`: one row per material topic. */
  readonly dispositions: readonly TopicDisposition[];
  /** Gate 1b's reading, re-derived on read. */
  readonly obligationAccounting: PlanObligationAccounting;
}

export interface PlanDagArtifact {
  readonly version: typeof PLAN_DAG_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  /** Ties this graph to one plan catalog; a graph read next to a different catalog is a named failure. */
  readonly planCatalogDigest: string;
  /** One row per document, ascending; the order every unit is written in, children before parents. */
  readonly documents: readonly { readonly documentId: string; readonly rootUnitId: string; readonly authoringOrder: readonly string[] }[];
  /** Every parent→child edge, ascending by (parent, child). */
  readonly edges: readonly { readonly parentUnitId: string; readonly childUnitId: string }[];
}

/** The plan catalog's content identity. Not a field of the artifact — a digest inside its own subject is a rule. */
export function planCatalogDigest(artifact: PlanCatalogArtifact): string {
  return sha256(canonicalJson(artifact));
}

/** The recorded request set's content identity, as the plan catalog records it. */
export function reportRequestsDigest(requests: ReportRequestsArtifact): string {
  return sha256(canonicalJson(requests));
}

export interface PlanArtifacts {
  readonly planCatalog: PlanCatalogArtifact;
  readonly dag: PlanDagArtifact;
}

/**
 * Turn a validated proposal into the two artifacts.
 *
 * Refuses a report that is not `complete` or `vacuous`: the artifacts are premises for everything downstream, so
 * the only path to them is through a validation that concluded. The refusal names the problems rather than
 * summarising them — a plan is corrected by reading them.
 */
export function buildPlanArtifacts(input: {
  readonly catalog: TopicCatalogArtifact;
  readonly requests: ReportRequestsArtifact;
  readonly proposal: PlanProposal;
  readonly report: PlanValidationReport;
}): PlanArtifacts {
  const { catalog, requests, proposal, report } = input;
  if (report.overall.conclusion === "violations") {
    throw new Error(`The plan cannot be recorded: validation found ${report.overall.problems.length} problem(s) — ${report.overall.problems.join("; ")}`);
  }
  const topicsById = new Map(catalog.topics.map((topic) => [topic.topicId, topic]));
  const documents: PlanCatalogDocument[] = report.documents.map((row) => {
    if (row.rootUnitIds.length !== 1) {
      throw new Error(`Document ${JSON.stringify(row.documentId)} has ${row.rootUnitIds.length} root unit(s); a recorded plan has exactly one per document`);
    }
    return { documentId: row.documentId, rootUnitId: row.rootUnitIds[0]!, units: row.units, inputBytes: row.inputBytes };
  });
  const units: PlanCatalogUnit[] = [...proposal.units]
    .sort((a, b) => a.unitId.localeCompare(b.unitId))
    .map((unit) => ({
      unitId: unit.unitId,
      documentId: unit.documentId,
      kind: unit.kind,
      title: unit.title,
      topics: unitTopicIds(unit).map((topicId) => {
        const topic = topicsById.get(topicId);
        if (!topic) throw new Error(`Unit ${JSON.stringify(unit.unitId)} references topic ${JSON.stringify(topicId)}, which is not in this catalog`);
        return { topicId, topicDigest: topic.digest };
      }),
      childUnitIds: [...unitChildIds(unit)].sort((a, b) => a.localeCompare(b))
    }));

  const planCatalog: PlanCatalogArtifact = {
    version: PLAN_CATALOG_VERSION,
    runId: catalog.runId,
    knowledgeEpoch: catalog.knowledgeEpoch,
    knowledgeDigest: catalog.knowledgeDigest,
    topicsDigest: topicCatalogDigest(catalog),
    requestsDigest: reportRequestsDigest(requests),
    policyVersion: REPORT_POLICY_VERSION,
    proposalVersion: PLAN_PROPOSAL_VERSION,
    budget: report.budget,
    documents,
    units,
    dispositions: [...report.dispositions].sort((a, b) => a.topicId.localeCompare(b.topicId)),
    obligationAccounting: report.obligations
  };

  const order = unitDagOrder(proposal.units);
  if (order.state === "cyclic") throw new Error(`The plan graph has a cycle (${order.cycle.join(" -> ")}) and cannot be recorded`);
  const positions = new Map(order.order.map((unitId, index) => [unitId, index]));
  const dag: PlanDagArtifact = {
    version: PLAN_DAG_VERSION,
    runId: catalog.runId,
    knowledgeEpoch: catalog.knowledgeEpoch,
    planCatalogDigest: planCatalogDigest(planCatalog),
    documents: documents.map((document) => ({
      documentId: document.documentId,
      rootUnitId: document.rootUnitId,
      authoringOrder: order.order.filter((unitId) => units.find((unit) => unit.unitId === unitId)?.documentId === document.documentId)
    })),
    edges: units
      .flatMap((unit) => unit.childUnitIds.map((childUnitId) => ({ parentUnitId: unit.unitId, childUnitId })))
      .sort((a, b) => a.parentUnitId.localeCompare(b.parentUnitId) || a.childUnitId.localeCompare(b.childUnitId))
  };
  // Stated as an assertion, not as a comment: a parent that is written before its child would let a synthesis
  // read a summary that does not exist yet, and the order is the only thing standing between the two.
  for (const edge of dag.edges) {
    if (positions.get(edge.parentUnitId)! <= positions.get(edge.childUnitId)!) {
      throw new Error(`The authoring order puts ${edge.parentUnitId} before its child ${edge.childUnitId}`);
    }
  }
  return { planCatalog, dag };
}

/**
 * Rebuild the proposal a recorded plan catalog came from.
 *
 * This is what lets the authoring gate RE-VALIDATE a plan on disk instead of trusting that whoever wrote it ran
 * the validator: the same rows go back through the same function. A synthesis row carrying a topic is refused
 * here, because the proposal type has nowhere to put one.
 */
export function proposalFromPlanCatalog(artifact: PlanCatalogArtifact): PlanProposal {
  const units: ProposedUnit[] = artifact.units.map((unit) => {
    switch (unit.kind) {
      case "synthesis":
        if (unit.topics.length > 0) throw new Error(`Recorded synthesis unit ${JSON.stringify(unit.unitId)} references ${unit.topics.length} topic(s); a synthesis writes from child summaries only`);
        return { kind: "synthesis", unitId: unit.unitId, documentId: unit.documentId, title: unit.title, childUnitIds: [...unit.childUnitIds] };
      case "leaf":
      case "bridge":
      case "appendix":
        if (unit.childUnitIds.length > 0) throw new Error(`Recorded ${unit.kind} unit ${JSON.stringify(unit.unitId)} names ${unit.childUnitIds.length} child unit(s); only a synthesis has children`);
        return { kind: unit.kind, unitId: unit.unitId, documentId: unit.documentId, title: unit.title, topicIds: unit.topics.map((topic) => topic.topicId) };
    }
    return assertNever(unit.kind, "recorded authoring unit kind");
  });
  return {
    version: PLAN_PROPOSAL_VERSION,
    units: units.sort((a, b) => a.unitId.localeCompare(b.unitId)),
    dispositions: artifact.dispositions,
    budget: artifact.budget
  };
}

/**
 * Write both artifacts once per EPOCH. Identical bytes are a no-op; different bytes for the same epoch are a named
 * refusal; a new epoch supersedes — see `writeTopicCatalog` for why a supplement may not be a permanent write-off.
 *
 * The DAG is written second and read back against the catalog in hand, so a half-written pair cannot pass: a graph
 * whose `planCatalogDigest` does not match the catalog beside it is refused by the reader.
 */
export async function writePlanArtifacts(runDir: string, artifacts: PlanArtifacts, catalog: TopicCatalogArtifact): Promise<PlanArtifacts> {
  await writeOnce(planCatalogPath(runDir), artifacts.planCatalog, async () => readPlanCatalog(runDir, catalog), (value) => value.knowledgeEpoch, "plan catalog");
  await writeOnce(planDagPath(runDir), artifacts.dag, async () => readPlanDag(runDir, artifacts.planCatalog), (value) => value.knowledgeEpoch, "authoring DAG");
  return artifacts;
}

async function writeOnce<T>(path: string, value: T, readBack: () => Promise<T>, epochOf: (value: T) => number, what: string): Promise<void> {
  if (await exists(path)) {
    // A recorded artifact that no longer parses against the current epoch cannot be compared, and that is exactly
    // the epoch-succession case: the read-back is attempted, and its failure is not allowed to strand the run.
    const recorded = await readBack().catch(() => null);
    if (recorded !== null) {
      if (stableJson(recorded) === stableJson(value)) return;
      if (epochOf(recorded) === epochOf(value)) {
        throw new Error(`${path} already records a different ${what}; it is written once per epoch`);
      }
    }
  }
  await writeJson(path, value);
}

/** Read and fully validate the plan catalog against the topics catalog it references. */
export async function readPlanCatalog(runDir: string, catalog: TopicCatalogArtifact): Promise<PlanCatalogArtifact> {
  const path = planCatalogPath(runDir);
  let raw: unknown;
  try {
    raw = await readJson<unknown>(path);
  } catch (error) {
    throw new Error(`${path} could not be read as JSON: ${(error as Error).message}`);
  }
  const problems = planCatalogProblems(raw, catalog);
  if (problems.length > 0) throw new Error(`${path} is not a valid plan catalog: ${problems.join("; ")}`);
  return raw as PlanCatalogArtifact;
}

/** Read and fully validate the authoring DAG against the plan catalog it belongs to. */
export async function readPlanDag(runDir: string, planCatalog: PlanCatalogArtifact): Promise<PlanDagArtifact> {
  const path = planDagPath(runDir);
  let raw: unknown;
  try {
    raw = await readJson<unknown>(path);
  } catch (error) {
    throw new Error(`${path} could not be read as JSON: ${(error as Error).message}`);
  }
  const problems = planDagProblems(raw, planCatalog);
  if (problems.length > 0) throw new Error(`${path} is not a valid authoring DAG: ${problems.join("; ")}`);
  return raw as PlanDagArtifact;
}

const PLAN_CATALOG_FIELDS = [
  "budget", "dispositions", "documents", "knowledgeDigest", "knowledgeEpoch", "obligationAccounting",
  "policyVersion", "proposalVersion", "requestsDigest", "runId", "topicsDigest", "units", "version"
] as const;

const PLAN_UNIT_FIELDS = ["childUnitIds", "documentId", "kind", "title", "topics", "unitId"] as const;

const PLAN_DAG_FIELDS = ["documents", "edges", "knowledgeEpoch", "planCatalogDigest", "runId", "version"] as const;

/**
 * Every problem an untrusted value has as a plan catalog, as data. Empty means valid.
 *
 * The topics catalog is REQUIRED, not optional: every check that makes this file worth having — the topic digests,
 * the disposition set, gate 1b's accounting — is a comparison against it, and a version of this function that
 * could run without one would be a version that mostly checked field names.
 */
export function planCatalogProblems(value: unknown, catalog: TopicCatalogArtifact): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["is not a plan catalog object"];
  const artifact = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(PLAN_CATALOG_FIELDS);
  for (const key of Object.keys(artifact).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of PLAN_CATALOG_FIELDS) {
    if (!(key in artifact)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  if (artifact.version !== PLAN_CATALOG_VERSION) problems.push(`version ${JSON.stringify(artifact.version)} is not ${PLAN_CATALOG_VERSION}`);
  if (artifact.proposalVersion !== PLAN_PROPOSAL_VERSION) problems.push(`proposalVersion ${JSON.stringify(artifact.proposalVersion)} is not ${PLAN_PROPOSAL_VERSION}`);
  if (artifact.policyVersion !== REPORT_POLICY_VERSION) problems.push(`policyVersion ${JSON.stringify(artifact.policyVersion)} is not the registry's ${REPORT_POLICY_VERSION}`);
  const expectedTopicsDigest = topicCatalogDigest(catalog);
  if (artifact.topicsDigest !== expectedTopicsDigest) {
    problems.push(`topicsDigest ${JSON.stringify(artifact.topicsDigest)} is not the digest of this run's plan/topics.json (${expectedTopicsDigest}); the plan references another catalog`);
  }
  if (artifact.knowledgeDigest !== catalog.knowledgeDigest) {
    problems.push(`knowledgeDigest ${JSON.stringify(artifact.knowledgeDigest)} is not the epoch the topics catalog projects (${catalog.knowledgeDigest})`);
  }
  if (artifact.knowledgeEpoch !== catalog.knowledgeEpoch) {
    problems.push(`knowledgeEpoch ${JSON.stringify(artifact.knowledgeEpoch)} is not the topics catalog's ${catalog.knowledgeEpoch}`);
  }
  problems.push(...planBudgetProblems(artifact.budget));
  if (!Array.isArray(artifact.units)) return [...problems, `units ${JSON.stringify(artifact.units)} is not an array`];
  if (!Array.isArray(artifact.dispositions)) return [...problems, `dispositions ${JSON.stringify(artifact.dispositions)} is not an array`];
  if (!Array.isArray(artifact.documents)) return [...problems, `documents ${JSON.stringify(artifact.documents)} is not an array`];

  const topicsById = new Map(catalog.topics.map((topic) => [topic.topicId, topic]));
  let previousId: string | null = null;
  for (const [index, row] of (artifact.units as unknown[]).entries()) {
    const rowProblems = unitRowProblems(row, topicsById);
    for (const problem of rowProblems) problems.push(`units[${index}] ${problem}`);
    if (rowProblems.length > 0) continue;
    const unit = row as PlanCatalogUnit;
    if (previousId !== null && unit.unitId.localeCompare(previousId) <= 0) {
      problems.push(`units[${index}] unitId ${JSON.stringify(unit.unitId)} does not follow ${JSON.stringify(previousId)}; the rows must be strictly ascending by unit id`);
    }
    previousId = unit.unitId;
  }
  if (problems.length > 0) return problems;

  // Re-derive the reading. This is the check that makes a hand-edited waived list, a swapped disposition state or
  // a quietly widened denominator a named failure instead of a number a later gate would have believed.
  const recorded = artifact as unknown as PlanCatalogArtifact;
  let proposal: PlanProposal;
  try {
    proposal = proposalFromPlanCatalog(recorded);
  } catch (error) {
    return [(error as Error).message];
  }
  const byTopic = new Map(recorded.dispositions.map((disposition) => [disposition.topicId, disposition]));
  if (byTopic.size !== recorded.dispositions.length) problems.push("dispositions holds two rows for one topic; a topic carries exactly one disposition");
  const expectedAccounting = accountPlanObligations(catalog, proposal.units, byTopic);
  if (stableJson(recorded.obligationAccounting) !== stableJson(expectedAccounting)) {
    problems.push(`obligationAccounting is not the reading its own units and dispositions derive (recorded ${stableJson(recorded.obligationAccounting)}, derived ${stableJson(expectedAccounting)})`);
  }
  for (const [index, document] of recorded.documents.entries()) {
    const units = recorded.units.filter((unit) => unit.documentId === document.documentId);
    if (units.length !== document.units) problems.push(`documents[${index}] counts ${document.units} unit(s) for ${JSON.stringify(document.documentId)} but the plan holds ${units.length}`);
    const named = new Set(units.flatMap((unit) => unit.childUnitIds));
    const roots = units.map((unit) => unit.unitId).filter((unitId) => !named.has(unitId));
    if (roots.length !== 1 || roots[0] !== document.rootUnitId) {
      problems.push(`documents[${index}] names root ${JSON.stringify(document.rootUnitId)} but the plan's roots for ${JSON.stringify(document.documentId)} are ${roots.join(", ") || "none"}`);
    }
  }
  return problems;
}

function unitRowProblems(value: unknown, topicsById: ReadonlyMap<string, { readonly digest: string }>): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["is not a unit object"];
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(PLAN_UNIT_FIELDS);
  for (const key of Object.keys(row).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of PLAN_UNIT_FIELDS) {
    if (!(key in row)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  for (const key of ["unitId", "documentId", "title"] as const) {
    if (typeof row[key] !== "string" || (row[key] as string).trim() === "") problems.push(`${key} ${JSON.stringify(row[key])} is not a non-empty string`);
  }
  if (typeof row.kind !== "string" || !(AUTHORING_UNIT_KINDS as readonly string[]).includes(row.kind)) {
    problems.push(`kind ${JSON.stringify(row.kind)} is not one of: ${AUTHORING_UNIT_KINDS.join(", ")}`);
  }
  if (!Array.isArray(row.childUnitIds) || (row.childUnitIds as unknown[]).some((id) => typeof id !== "string" || id.trim() === "")) {
    problems.push(`childUnitIds ${JSON.stringify(row.childUnitIds)} is not an array of non-empty ids`);
  }
  if (!Array.isArray(row.topics)) return [...problems, `topics ${JSON.stringify(row.topics)} is not an array`];
  for (const [index, reference] of (row.topics as unknown[]).entries()) {
    if (typeof reference !== "object" || reference === null || Array.isArray(reference)) {
      problems.push(`topics[${index}] is not a topic reference object`);
      continue;
    }
    const keys = Object.keys(reference).sort();
    if (stableJson(keys) !== stableJson(["topicDigest", "topicId"])) {
      problems.push(`topics[${index}] has fields ${keys.join(", ")}; a topic reference carries exactly topicId and topicDigest — the obligation bindings stay in plan/topics.json`);
      continue;
    }
    const { topicId, topicDigest } = reference as PlanTopicReference;
    const topic = topicsById.get(topicId);
    if (!topic) {
      problems.push(`topics[${index}] references topic ${JSON.stringify(topicId)}, which is not in this run's topics catalog`);
      continue;
    }
    if (topic.digest !== topicDigest) {
      problems.push(`topics[${index}] references topic ${JSON.stringify(topicId)} at digest ${JSON.stringify(topicDigest)}, but that topic now digests to ${topic.digest}`);
    }
  }
  return problems;
}

/** Every problem an untrusted value has as an authoring DAG, as data. Empty means valid. */
export function planDagProblems(value: unknown, planCatalog: PlanCatalogArtifact): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["is not an authoring DAG object"];
  const artifact = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(PLAN_DAG_FIELDS);
  for (const key of Object.keys(artifact).sort()) {
    if (!known.has(key)) problems.push(`has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of PLAN_DAG_FIELDS) {
    if (!(key in artifact)) problems.push(`is missing field ${JSON.stringify(key)}`);
  }
  if (artifact.version !== PLAN_DAG_VERSION) problems.push(`version ${JSON.stringify(artifact.version)} is not ${PLAN_DAG_VERSION}`);
  const expectedDigest = planCatalogDigest(planCatalog);
  if (artifact.planCatalogDigest !== expectedDigest) {
    problems.push(`planCatalogDigest ${JSON.stringify(artifact.planCatalogDigest)} is not the digest of this run's plan/catalog.json (${expectedDigest}); the graph belongs to another plan`);
  }
  if (artifact.runId !== planCatalog.runId) problems.push(`runId ${JSON.stringify(artifact.runId)} is not the plan catalog's ${JSON.stringify(planCatalog.runId)}`);
  if (artifact.knowledgeEpoch !== planCatalog.knowledgeEpoch) problems.push(`knowledgeEpoch ${JSON.stringify(artifact.knowledgeEpoch)} is not the plan catalog's ${planCatalog.knowledgeEpoch}`);
  if (problems.length > 0) return problems;

  // The graph is re-derived from the plan catalog's own units, so an edge nobody declared and a missing edge are
  // the same named failure. A recorded order is never trusted to be topological; it is compared to the one the
  // units derive.
  let expected: PlanDagArtifact;
  try {
    const proposal = proposalFromPlanCatalog(planCatalog);
    const order = unitDagOrder(proposal.units);
    if (order.state === "cyclic") return [`the plan catalog's units form a cycle (${order.cycle.join(" -> ")}), so no authoring order exists`];
    expected = {
      version: PLAN_DAG_VERSION,
      runId: planCatalog.runId,
      knowledgeEpoch: planCatalog.knowledgeEpoch,
      planCatalogDigest: expectedDigest,
      documents: planCatalog.documents.map((document) => ({
        documentId: document.documentId,
        rootUnitId: document.rootUnitId,
        authoringOrder: order.order.filter((unitId) => planCatalog.units.find((unit) => unit.unitId === unitId)?.documentId === document.documentId)
      })),
      edges: [...planCatalog.units]
        .flatMap((unit) => [...unit.childUnitIds].map((childUnitId) => ({ parentUnitId: unit.unitId, childUnitId })))
        .sort((a, b) => a.parentUnitId.localeCompare(b.parentUnitId) || a.childUnitId.localeCompare(b.childUnitId))
    };
  } catch (error) {
    return [(error as Error).message];
  }
  if (stableJson(artifact.documents) !== stableJson(expected.documents)) {
    problems.push(`documents is not the per-document authoring order its units derive (recorded ${stableJson(artifact.documents)}, derived ${stableJson(expected.documents)})`);
  }
  if (stableJson(artifact.edges) !== stableJson(expected.edges)) {
    problems.push(`edges is not the edge set its units derive (recorded ${stableJson(artifact.edges)}, derived ${stableJson(expected.edges)})`);
  }
  return problems;
}
