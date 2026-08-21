/**
 * `plan/catalog.json` and `plan/dag.json` — the validated plan of one epoch, written once.
 *
 * BINDINGS ARE PASSED BY REFERENCE, NEVER FLATTENED. A unit row carries `{ topicId, topicDigest, obligationScope }`
 * and nothing else about its topics: no work-item ids beyond the scope's own selection, no evidence ids, no trace
 * ids. R4's unit packet goes topicId → `plan/topics.json` → that topic's `bindings`, where every obligation still
 * owns its own evidence and trace ids. 57B-453 is what the other design costs — flatten the ids into a topic-level
 * bag here and 60% of a document's material work items can no longer be told apart from each other, which is
 * exactly the grounding failure the epic's gate 1b exists to catch. The `topicDigest` is what makes the reference
 * safe: a topic whose content moved no longer matches the plan that referenced it, and the reader below says so by
 * name.
 *
 * v2 ADDS THE SCOPE, AND REMOVES THE ONE MEASURED FIELD (R5b). `obligationScope` is how a topic too large for one
 * unit is divided without truncation, so it belongs in the recorded plan: the packet renderer and the ownership
 * derivation both read it, and a plan that recorded units without it would be a plan whose division nobody could
 * reproduce. `PlanCatalogDocument.inputBytes` is GONE for the opposite reason: the input measure is now the packet
 * renderer itself, and the packet header prints this artifact's own digest — so keeping a measured byte count as a
 * field would make the plan's identity depend on a measurement of the plan, which depends on the identity. A
 * measurement is a READING over a plan (`plan-packet-measure.ts`, and the validation report's document rows), never
 * a field of it.
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
 *
 * v3 MAKES THAT LAW TWO-AXIS: a recorded plan is identified by (knowledgeEpoch, planRevision), not by the epoch
 * alone. The epoch belongs to freeze — minting one for a report-side need would forge a knowledge change — so the
 * axis a re-plan moves along is the REVISION, recorded here as three required fields: which revision this is, the
 * digest of the revision it supersedes, and why it was recorded. Revision 0 carries `null` for the latter two and
 * nothing else may; a successor names its predecessor's digest, so succession is checked rather than assumed. What
 * supersedes what is `plan-revision.ts`'s job (it archives the replaced revision and walks the chain); this file
 * owns the fields, their coherence, and the refusal when a write would replace a revision already recorded.
 *
 * IT NO LONGER IMPORTS PLAN VALIDATION, and that is load-bearing rather than tidy. Validation now MEASURES packets,
 * measuring a packet means rendering one, and rendering one needs this file — so `plan-validation -> unit-packet ->
 * plan-artifacts -> plan-validation` would be a cycle `tests/layer-order.test.ts` refuses. The two things this file
 * used to take from the report are now taken from narrower places: the authoring order from `unit-dag-order.ts`,
 * and the gate from a `TopicDispositionVerdict` the caller passes in. Everything else it derives itself, from the
 * same functions validation derives them from.
 */

import { join } from "node:path";
import { assertNever } from "../base/artifact-result.ts";
import { canonicalJson, exists, readJson, sha256, stableJson, writeJson } from "../base/util.ts";
import { accountPlanObligations, type PlanObligationAccounting } from "./plan-obligation-conservation.ts";
import { parseObligationScope, type ObligationScope } from "./obligation-scope.ts";
import { planBudgetFor, planBudgetProblems, type PlanBudget, type PlanBudgetTable } from "./plan-budget.ts";
import {
  AUTHORING_UNIT_KINDS,
  PLAN_PROPOSAL_VERSION,
  unitChildIds,
  unitTopics,
  type AuthoringUnitKind,
  type PlanProposal,
  type ProposedUnit
} from "./plan-proposal.ts";
import { documentRootUnitIds, unitDagOrder } from "./unit-dag-order.ts";
import { REPORT_POLICY_VERSION } from "./report-policy-registry.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";
import { topicCatalogDigest } from "./topics-artifact.ts";
import type { TopicCatalogArtifact } from "./topic-catalog.ts";
import { parsedDispositionIndex, type TopicDisposition, type TopicDispositionVerdict } from "./topic-disposition.ts";

export const PLAN_CATALOG_VERSION = "plan-catalog-v3";
export const PLAN_DAG_VERSION = "plan-dag-v2";

/**
 * The fields that record WHICH revision a plan is, rather than what it says.
 *
 * Closed and exported because two callers depend on the list being exactly this: the succession reader, and the
 * comparison that decides whether a proposed revision supersedes anything at all — a revision whose only
 * difference is its own revision number would move every receipt's plan digest while changing no plan.
 */
export const PLAN_REVISION_FIELDS = ["planRevision", "previousPlanCatalogDigest", "revisionReason"] as const;

/**
 * Which revision is being recorded, and what it supersedes. Required at every derivation: a plan that did not
 * state its place in the succession would be a plan whose predecessor nobody can name.
 */
export interface PlanRevisionRef {
  readonly planRevision: number;
  readonly previousPlanCatalogDigest: string | null;
  readonly revisionReason: string | null;
}

/** The first revision of one epoch's plan: it supersedes nothing, so it names nothing and has no reason to give. */
export const FIRST_PLAN_REVISION: PlanRevisionRef = { planRevision: 0, previousPlanCatalogDigest: null, revisionReason: null };

/**
 * Every problem a revision reference has, as data. Empty means coherent.
 *
 * ONE PLACE decides what a coherent revision looks like, and both the builder and the file reader go through it:
 * revision 0 supersedes nothing (both fields null), every later revision names its predecessor's digest and says
 * why it exists. A second rule for the same shape is how "revision 0 with a predecessor" becomes writable.
 */
export function planRevisionProblems(value: {
  readonly planRevision: unknown;
  readonly previousPlanCatalogDigest: unknown;
  readonly revisionReason: unknown;
}): string[] {
  const problems: string[] = [];
  if (!Number.isSafeInteger(value.planRevision) || (value.planRevision as number) < 0) {
    problems.push(`planRevision ${JSON.stringify(value.planRevision)} is not a non-negative integer`);
  }
  const previous = value.previousPlanCatalogDigest;
  const reason = value.revisionReason;
  if (previous !== null && (typeof previous !== "string" || !/^[0-9a-f]{64}$/.test(previous))) {
    problems.push(`previousPlanCatalogDigest ${JSON.stringify(previous)} is neither null nor a sha256 digest`);
  }
  if (reason !== null && (typeof reason !== "string" || reason.trim() === "")) {
    problems.push(`revisionReason ${JSON.stringify(reason)} is neither null nor a non-empty string`);
  }
  if (value.planRevision === 0) {
    if (previous !== null) problems.push(`planRevision 0 records previousPlanCatalogDigest ${JSON.stringify(previous)}; the first plan of an epoch supersedes nothing`);
    if (reason !== null) problems.push(`planRevision 0 records revisionReason ${JSON.stringify(reason)}; the first plan of an epoch is not a revision of anything`);
  } else {
    if (previous === null) problems.push(`planRevision ${JSON.stringify(value.planRevision)} records no previousPlanCatalogDigest; a revision names the plan it supersedes`);
    if (reason === null) problems.push(`planRevision ${JSON.stringify(value.planRevision)} records no revisionReason; a revision states why the plan it supersedes was replaced`);
  }
  return problems;
}

/** The revision reference an artifact carries, as one value. The only place these three fields are read together. */
export function planRevisionOf(artifact: PlanCatalogArtifact): PlanRevisionRef {
  return {
    planRevision: artifact.planRevision,
    previousPlanCatalogDigest: artifact.previousPlanCatalogDigest,
    revisionReason: artifact.revisionReason
  };
}

export function planCatalogPath(runDir: string): string {
  return join(runDir, "plan", "catalog.json");
}

export function planDagPath(runDir: string): string {
  return join(runDir, "plan", "dag.json");
}

/** A topic reference: the id to look up in `plan/topics.json`, the digest it must still have, and this unit's scope. */
export interface PlanTopicReference {
  readonly topicId: string;
  readonly topicDigest: string;
  readonly obligationScope: ObligationScope;
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
}

export interface PlanCatalogArtifact {
  readonly version: typeof PLAN_CATALOG_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  /** Which revision of this epoch's plan this is. 0 is the first; `plan --revise` records the next. */
  readonly planRevision: number;
  /** The digest of the revision this one supersedes. `null` for revision 0 and for nothing else. */
  readonly previousPlanCatalogDigest: string | null;
  /** Why this revision was recorded. `null` for revision 0 and for nothing else. */
  readonly revisionReason: string | null;
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
  /** The catalog's own revision, restated so a graph on disk says which plan revision it belongs to. */
  readonly planRevision: number;
  /** The catalog's own predecessor, restated for the same reason. Both are checked against the catalog on read. */
  readonly previousPlanCatalogDigest: string | null;
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

/** Everything the two artifacts are DERIVED from. No verdict: a derivation is not an admission. */
export interface PlanArtifactsDerivation {
  readonly catalog: TopicCatalogArtifact;
  readonly requests: ReportRequestsArtifact;
  readonly proposal: PlanProposal;
  /** Required: the budget is derived here from the requests, never read off the proposal that echoes it. */
  readonly budgetTable: PlanBudgetTable;
  /**
   * Required: which revision this plan is, and what it supersedes.
   *
   * No default, because the two arms differ in what they are allowed to replace. `FIRST_PLAN_REVISION` is the
   * first plan of an epoch; every later one comes from `plan-revision.ts`, which derives it from the plan on disk.
   */
  readonly revision: PlanRevisionRef;
}

export interface PlanArtifactsInput extends PlanArtifactsDerivation {
  /**
   * The validation verdict this plan was admitted on.
   *
   * Narrow on purpose — the whole report would be an import edge back into `plan-validation.ts`, which is the cycle
   * this file exists on the other side of. It is REQUIRED rather than optional so no call site can record a plan
   * without having validated one: `violations` is refused here, `complete` and `vacuous` both open the gate (a
   * catalog with no material topic is a real shape, and refusing it would mean no run of that shape could be
   * written).
   */
  readonly verdict: TopicDispositionVerdict;
}

/**
 * Turn a validated proposal into the two artifacts.
 *
 * Refuses a verdict that is not `complete` or `vacuous`: the artifacts are premises for everything downstream, so
 * the only path to them is through a validation that concluded. The refusal names the problems rather than
 * summarising them — a plan is corrected by reading them.
 */
export function buildPlanArtifacts(input: PlanArtifactsInput): PlanArtifacts {
  if (input.verdict.conclusion === "violations") {
    throw new Error(`The plan cannot be recorded: validation found ${input.verdict.problems.length} problem(s) — ${input.verdict.problems.join("; ")}`);
  }
  return derivePlanArtifacts(input);
}

/**
 * The two artifacts a proposal derives, with no verdict gate.
 *
 * Separated from `buildPlanArtifacts` for exactly one caller: `plan-packet-measure.ts` has to hold a plan catalog
 * and a DAG in order to render a packet and measure it, and it does that BEFORE any verdict exists — the verdict is
 * partly a function of the measurement. Two builders would be two plans; one builder plus one gate is the same
 * bytes either way, and the gate stays required at the recording path.
 */
export function derivePlanArtifacts(input: PlanArtifactsDerivation): PlanArtifacts {
  const { catalog, requests, proposal, budgetTable, revision } = input;
  const revisionProblems = planRevisionProblems(revision);
  if (revisionProblems.length > 0) {
    throw new Error(`The plan cannot be derived at this revision: ${revisionProblems.join("; ")}`);
  }
  const topicsById = new Map(catalog.topics.map((topic) => [topic.topicId, topic]));
  const documentIds = [...new Set(requests.requests.map((record) => record.documentId))].sort((a, b) => a.localeCompare(b));
  const documents: PlanCatalogDocument[] = documentIds.map((documentId) => {
    const roots = documentRootUnitIds(proposal.units, documentId);
    if (roots.length !== 1) {
      throw new Error(`Document ${JSON.stringify(documentId)} has ${roots.length} root unit(s) (${roots.join(", ") || "none"}); a recorded plan has exactly one per document`);
    }
    return { documentId, rootUnitId: roots[0]!, units: proposal.units.filter((unit) => unit.documentId === documentId).length };
  });
  const units: PlanCatalogUnit[] = [...proposal.units]
    .sort((a, b) => a.unitId.localeCompare(b.unitId))
    .map((unit) => ({
      unitId: unit.unitId,
      documentId: unit.documentId,
      kind: unit.kind,
      title: unit.title,
      topics: unitTopics(unit).map((reference) => {
        const topic = topicsById.get(reference.topicId);
        if (!topic) throw new Error(`Unit ${JSON.stringify(unit.unitId)} references topic ${JSON.stringify(reference.topicId)}, which is not in this catalog`);
        return { topicId: reference.topicId, topicDigest: topic.digest, obligationScope: reference.obligationScope };
      }),
      childUnitIds: [...unitChildIds(unit)].sort((a, b) => a.localeCompare(b))
    }));

  const dispositions = parsedDispositionIndex(proposal.dispositions);
  const planCatalog: PlanCatalogArtifact = {
    version: PLAN_CATALOG_VERSION,
    runId: catalog.runId,
    knowledgeEpoch: catalog.knowledgeEpoch,
    planRevision: revision.planRevision,
    previousPlanCatalogDigest: revision.previousPlanCatalogDigest,
    revisionReason: revision.revisionReason,
    knowledgeDigest: catalog.knowledgeDigest,
    topicsDigest: topicCatalogDigest(catalog),
    requestsDigest: reportRequestsDigest(requests),
    policyVersion: REPORT_POLICY_VERSION,
    proposalVersion: PLAN_PROPOSAL_VERSION,
    budget: planBudgetFor(requests, budgetTable),
    documents,
    units,
    dispositions: dispositions.rows,
    obligationAccounting: accountPlanObligations(catalog, proposal.units, dispositions.byTopic)
  };

  const order = unitDagOrder(proposal.units);
  if (order.state === "cyclic") throw new Error(`The plan graph has a cycle (${order.cycle.join(" -> ")}) and cannot be recorded`);
  const positions = new Map(order.order.map((unitId, index) => [unitId, index]));
  const dag: PlanDagArtifact = {
    version: PLAN_DAG_VERSION,
    runId: catalog.runId,
    knowledgeEpoch: catalog.knowledgeEpoch,
    planRevision: planCatalog.planRevision,
    previousPlanCatalogDigest: planCatalog.previousPlanCatalogDigest,
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
        return {
          kind: unit.kind,
          unitId: unit.unitId,
          documentId: unit.documentId,
          title: unit.title,
          topics: unit.topics.map((topic) => ({ topicId: topic.topicId, obligationScope: topic.obligationScope }))
        };
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
 * How a write relates to what the run already records. Closed, no default: superseding is stated, never inferred.
 *
 * `record` is the write-once law: identical bytes are a no-op, different bytes for the same (epoch, revision) are a
 * named refusal, a new epoch supersedes — see `writeTopicCatalog` for why a supplement may not be a permanent
 * write-off. `supersede` is the only path that replaces a recorded plan, and it may only be taken with the
 * superseded revision ALREADY ARCHIVED: the two archive paths are checked to hold exactly its bytes before
 * anything on the current path is touched, so "archive first" is a verified precondition rather than a caller's
 * good intention. `plan-revision.ts` is what writes those archives; this file refuses to proceed without them.
 */
export type PlanWriteMode =
  | { readonly kind: "record" }
  | {
      readonly kind: "supersede";
      readonly superseded: PlanArtifacts;
      readonly archivedCatalogPath: string;
      readonly archivedDagPath: string;
    };

/**
 * Write both artifacts, under the law the mode names.
 *
 * THE PAIR IS TWO FILES AND THERE IS NO TWO-FILE ATOMIC WRITE, so the ORDER is chosen for what an interrupted
 * write leaves behind. The DAG goes first and the catalog second, because the catalog is the anchor: every receipt,
 * every ledger row and every candidate names `planCatalogDigest`, so as long as the catalog has not moved the run
 * still reads as the revision it was — with a graph that does not match it, which the reader refuses by name. The
 * other order would leave a catalog nobody can pair a graph with, and the next revise would then archive a
 * mismatched pair. Re-running the same revise completes the interrupted one: both writes are idempotent, and the
 * preconditions below accept the state a completed write leaves as well as the state it started from.
 *
 * THE SUPERSEDE ARM CHECKS BOTH SIDES OF THE REPLACEMENT: the revision being replaced is archived (verified at the
 * archive paths, byte for byte) AND the files about to be overwritten still hold that revision. Without the second
 * check, two revisions derived from the same predecessor would both write — the archive is immutable, so its check
 * passes forever — and the first one would vanish with nothing archived, while any row minted against it named a
 * plan that is nowhere on disk. That is a lost update, not a race nobody can reach: nothing in `src/` locks a run
 * directory.
 *
 * THE WINDOW BETWEEN THE TWO WRITES IS STILL OPEN, AND THAT IS A DECISION (57B-434, item #6 of the R8
 * pre-cleanup). For the instant between `writeJson(dag)` and `writeJson(catalog)` — and in the `record` arm,
 * between the two `writeOnce` calls — the directory holds a pair that does not read through: the graph is the new
 * revision's and the catalog is still the old one. What that costs is bounded and stated:
 *
 *   * A READER that arrives inside the window gets a NAMED refusal, never a wrong answer. `readPlanDag` refuses a
 *     graph whose plan catalog is not the one it was derived against, so the mismatch is reported, not consumed.
 *   * AN INTERRUPTION inside the window is recoverable: re-running the same revise completes it, because both
 *     writes are idempotent and `assertReplaceable` accepts the half-written state as well as the starting one.
 *   * A CONCURRENT SECOND WRITER inside the window is refused rather than silently merged, by the same
 *     precondition.
 *
 * WHY IT IS NOT CLOSED. The only two ways to close it are to merge the pair into one file, or to lock the run
 * directory. Merging changes `plan/catalog.json`'s bytes — which is every unit's cache identity and every archived
 * digest reading keyed on it — to buy an instant that already fails closed. A run-directory lock introduces a new
 * failure surface (a stale lock stops a run with no command to clear it, which is strictly worse than a refusal
 * that says "revise again") and there is no other lock in `src/` for it to be consistent with.
 *
 * WHEN TO COME BACK: when a SECOND concurrent writer of the plan pair becomes a real scenario — a scheduler, a
 * server, more than one operator against one run directory. At that point "refused" stops being good enough
 * (whoever loses has to notice and retry), and the pair needs one of the two closures above, priced deliberately.
 */
export async function writePlanArtifacts(runDir: string, artifacts: PlanArtifacts, catalog: TopicCatalogArtifact, mode: PlanWriteMode): Promise<PlanArtifacts> {
  switch (mode.kind) {
    case "record":
      await writeOnce(planCatalogPath(runDir), artifacts.planCatalog, async () => readPlanCatalog(runDir, catalog), "plan catalog");
      await writeOnce(planDagPath(runDir), artifacts.dag, async () => readPlanDag(runDir, artifacts.planCatalog), "authoring DAG");
      return artifacts;
    case "supersede": {
      assertSupersedes(artifacts.planCatalog, mode.superseded.planCatalog);
      await assertArchived(mode.archivedCatalogPath, mode.superseded.planCatalog, "plan catalog");
      await assertArchived(mode.archivedDagPath, mode.superseded.dag, "authoring DAG");
      await assertReplaceable(planDagPath(runDir), [mode.superseded.dag, artifacts.dag], "authoring DAG");
      await assertReplaceable(planCatalogPath(runDir), [mode.superseded.planCatalog, artifacts.planCatalog], "plan catalog");
      await writeJson(planDagPath(runDir), artifacts.dag);
      await writeJson(planCatalogPath(runDir), artifacts.planCatalog);
      return artifacts;
    }
  }
  return assertNever(mode, "plan write mode");
}

/**
 * The file about to be replaced must hold either the revision being superseded or the one being written.
 *
 * Two accepted values rather than one, and each for its own reason: the SUPERSEDED bytes are the normal case, and
 * the NEW bytes are what an interrupted or repeated write of this very revision left — re-running it must complete
 * rather than refuse. Anything else on disk means the run moved under this write, and replacing it would drop a
 * revision nobody archived.
 */
async function assertReplaceable(path: string, accepted: readonly unknown[], what: string): Promise<void> {
  const recorded = await readJson<unknown>(path).catch(() => null);
  if (recorded === null) {
    throw new Error(`${path} could not be read, so this revision cannot know what it would replace; a superseded ${what} is verified on disk before it is overwritten`);
  }
  if (accepted.some((value) => stableJson(recorded) === stableJson(value))) return;
  throw new Error(`${path} no longer holds the ${what} this revision supersedes (nor the one it would write); the recorded plan moved after this revision was derived — re-read the plan and revise again`);
}

/** The successor must be the next revision of the same epoch and must name its predecessor's digest. Both, always. */
function assertSupersedes(next: PlanCatalogArtifact, superseded: PlanCatalogArtifact): void {
  if (next.knowledgeEpoch !== superseded.knowledgeEpoch) {
    throw new Error(`A plan revision supersedes a plan of its own epoch: this one is epoch ${next.knowledgeEpoch} and the plan it would replace is epoch ${superseded.knowledgeEpoch}. A re-frozen run is re-planned, not revised.`);
  }
  if (next.planRevision !== superseded.planRevision + 1) {
    throw new Error(`A plan revision follows the one it supersedes: this one is revision ${next.planRevision} and the plan it would replace is revision ${superseded.planRevision}`);
  }
  const expected = planCatalogDigest(superseded);
  if (next.previousPlanCatalogDigest !== expected) {
    throw new Error(`Plan revision ${next.planRevision} names predecessor ${JSON.stringify(next.previousPlanCatalogDigest)}, but the plan it would replace digests to ${expected}; a succession is checked, never assumed`);
  }
}

/** The superseded revision must already be on disk at the archive path, byte for byte. */
async function assertArchived(path: string, value: unknown, what: string): Promise<void> {
  const recorded = await readJson<unknown>(path).catch(() => null);
  if (recorded === null) {
    throw new Error(`${path} does not hold the ${what} being superseded; a superseded plan revision is archived before it is replaced`);
  }
  if (stableJson(recorded) !== stableJson(value)) {
    throw new Error(`${path} archives a different ${what} than the one being superseded; the revision on disk cannot be replaced by bytes that do not match what was archived`);
  }
}

async function writeOnce<T extends { readonly knowledgeEpoch: number; readonly planRevision: number }>(path: string, value: T, readBack: () => Promise<T>, what: string): Promise<void> {
  if (await exists(path)) {
    // A recorded artifact that no longer parses against the current epoch cannot be compared, and that is exactly
    // the epoch-succession case: the read-back is attempted, and its failure is not allowed to strand the run.
    const recorded = await readBack().catch(() => null);
    if (recorded !== null) {
      if (stableJson(recorded) === stableJson(value)) return;
      if (recorded.knowledgeEpoch === value.knowledgeEpoch) {
        if (recorded.planRevision !== value.planRevision) {
          throw new Error(`${path} already records revision ${recorded.planRevision} of this epoch's ${what}, and this one is revision ${value.planRevision}; a recorded plan is replaced only by \`plan --revise --reason <why>\`, which archives the revision it supersedes`);
        }
        throw new Error(`${path} already records a different ${what}; it is written once per epoch and revision`);
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
  "planRevision", "policyVersion", "previousPlanCatalogDigest", "proposalVersion", "requestsDigest",
  "revisionReason", "runId", "topicsDigest", "units", "version"
] as const;

const PLAN_UNIT_FIELDS = ["childUnitIds", "documentId", "kind", "title", "topics", "unitId"] as const;

const PLAN_TOPIC_REFERENCE_FIELDS = ["obligationScope", "topicDigest", "topicId"] as const;

const PLAN_DAG_FIELDS = [
  "documents", "edges", "knowledgeEpoch", "planCatalogDigest", "planRevision", "previousPlanCatalogDigest",
  "runId", "version"
] as const;

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
  // A version mismatch says what to DO about it. There is deliberately no cross-schema read: a plan recorded under
  // an earlier schema was validated by earlier rules, and reading it under the new ones would be asserting that the
  // old validator checked things it did not. Re-planning is cheap (the topics catalog is a pure projection of the
  // sealed epoch and is already on disk); believing an unvalidated premise is not.
  if (artifact.version !== PLAN_CATALOG_VERSION) {
    problems.push(`version ${JSON.stringify(artifact.version)} is not ${PLAN_CATALOG_VERSION}; this plan was recorded under an earlier schema and no cross-schema read exists — re-plan this run`);
  }
  if (artifact.proposalVersion !== PLAN_PROPOSAL_VERSION) {
    problems.push(`proposalVersion ${JSON.stringify(artifact.proposalVersion)} is not ${PLAN_PROPOSAL_VERSION}; the proposal schema this plan was validated against is superseded — re-plan this run`);
  }
  if (artifact.policyVersion !== REPORT_POLICY_VERSION) problems.push(`policyVersion ${JSON.stringify(artifact.policyVersion)} is not the registry's ${REPORT_POLICY_VERSION}`);
  // The untrusted values go in AS THEY ARE. No `?? null` here: a missing field is already named above, and
  // defaulting one to `null` on the way in would make an absent predecessor read as a coherent revision 0.
  problems.push(...planRevisionProblems({
    planRevision: artifact.planRevision,
    previousPlanCatalogDigest: artifact.previousPlanCatalogDigest,
    revisionReason: artifact.revisionReason
  }));
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
  const dispositions = parsedDispositionIndex(recorded.dispositions);
  if (dispositions.byTopic.size !== recorded.dispositions.length) problems.push("dispositions holds two rows for one topic, or a row that does not parse; a topic carries exactly one readable disposition");
  const expectedAccounting = accountPlanObligations(catalog, proposal.units, dispositions.byTopic);
  if (stableJson(recorded.obligationAccounting) !== stableJson(expectedAccounting)) {
    problems.push(`obligationAccounting is not the reading its own units and dispositions derive (recorded ${stableJson(recorded.obligationAccounting)}, derived ${stableJson(expectedAccounting)})`);
  }
  for (const [index, document] of recorded.documents.entries()) {
    const units = recorded.units.filter((unit) => unit.documentId === document.documentId);
    if (units.length !== document.units) problems.push(`documents[${index}] counts ${document.units} unit(s) for ${JSON.stringify(document.documentId)} but the plan holds ${units.length}`);
    const roots = documentRootUnitIds(proposal.units, document.documentId);
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
    if (stableJson(keys) !== stableJson([...PLAN_TOPIC_REFERENCE_FIELDS])) {
      problems.push(`topics[${index}] has fields ${keys.join(", ")}; a topic reference carries exactly ${PLAN_TOPIC_REFERENCE_FIELDS.join(", ")} — the obligation bindings stay in plan/topics.json`);
      continue;
    }
    const { topicId, topicDigest } = reference as PlanTopicReference;
    const scope = parseObligationScope((reference as Record<string, unknown>).obligationScope);
    for (const problem of scope.problems) problems.push(`topics[${index}] ${problem}`);
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
  if (artifact.planRevision !== planCatalog.planRevision) problems.push(`planRevision ${JSON.stringify(artifact.planRevision)} is not the plan catalog's ${planCatalog.planRevision}`);
  if (artifact.previousPlanCatalogDigest !== planCatalog.previousPlanCatalogDigest) {
    problems.push(`previousPlanCatalogDigest ${JSON.stringify(artifact.previousPlanCatalogDigest)} is not the plan catalog's ${JSON.stringify(planCatalog.previousPlanCatalogDigest)}`);
  }
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
      planRevision: planCatalog.planRevision,
      previousPlanCatalogDigest: planCatalog.previousPlanCatalogDigest,
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
