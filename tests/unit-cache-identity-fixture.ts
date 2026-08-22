/**
 * Shared setup for the R6a identity and invalidation tests: ONE frozen mini run, and several PLAN STATES over it.
 *
 * WHY PLAN STATES RATHER THAN FIXTURE FILES. Every perturbation here is a VALUE — a topic whose title changed, a
 * topic that binds one obligation fewer, a document added to the recorded requests, a bumped epoch, a lens whose
 * digest moved. The frozen fixture on disk is never edited, so what is being tested is what the derivation does
 * with two states of the same run rather than what two hand-built fixtures happen to look like.
 *
 * TWO PERTURBATIONS, AND THEY ARE NOT INTERCHANGEABLE. That is the whole reason this file has both:
 *
 *   * `withTopicTitle` is a BINDING-PRESERVING content change. The topic's obligations, their evidence and their
 *     ownership are untouched, so only the units that NAME the topic (and their ancestors) can move. This is the
 *     shape the epic's acceptance is written for.
 *   * `withoutBinding` is a BINDING-SET change, and it moves OWNERSHIP: an obligation whose highest-priority
 *     binding topic drops it is owned by the next facet's topic, in another unit — so a sibling unit that never
 *     named the perturbed topic changes too, because the obligation crosses from its stub table into its own rows
 *     with the evidence. A suite that only ever perturbed content would assert the first shape and never discover
 *     the second, which is 57B-466's mistake one level up: verifying a claim with the load it holds under.
 *
 * The proposals go through `parsePlanProposal` and `validatePlan`, so no state here is a plan Core would refuse.
 */

import assert from "node:assert/strict";
import { canonicalJson, sha256 } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { FULL_OBLIGATION_SCOPE } from "../src/report/obligation-scope.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { FIRST_PLAN_REVISION, buildPlanArtifacts, type PlanCatalogArtifact, type PlanCatalogUnit, type PlanDagArtifact } from "../src/report/plan-artifacts.ts";
import { documentOwnership, type ObligationOwnershipIndex } from "../src/report/plan-obligation-conservation.ts";
import { parsePlanProposal, type PlanProposal, type ProposedUnit, type ProposedUnitTopic } from "../src/report/plan-proposal.ts";
import { validatePlan } from "../src/report/plan-validation.ts";
import { REPORT_POLICY_REGISTRY, type ReportPolicyRegistry } from "../src/report/report-policy-registry.ts";
import { buildReportRequestsArtifact, type ReportRequestsArtifact } from "../src/report/report-requests-artifact.ts";
import type { LegacyDocumentRequest } from "../src/report/legacy-request-mapping.ts";
import {
  confidenceOf,
  materialityOf,
  statusDetermination,
  topicCandidateDigest,
  type TopicCandidate,
  type TopicObligationBinding
} from "../src/report/topic-candidate.ts";
import type { TopicCatalogArtifact } from "../src/report/topic-catalog.ts";
import { UNIT_SUMMARY_VERSION, type UnitSummary } from "../src/report/unit-output.ts";
import { topicDossier, type UnitDossier, type UnitPacketInput } from "../src/report/unit-packet.ts";
import { unitIdentityOf, type UnitIdentity } from "../src/report/unit-cache-identity.ts";
import type { UnitAuthorship } from "../src/report/unit-provenance.ts";
import type { CandidateIdentity, PlannedUnitIdentity } from "../src/report/unit-cache-plan.ts";
import { MINI_DOCUMENTS, miniRun, type MiniRun } from "./plan-fixture.ts";

/** The mini catalog rows these fixtures name, pinned so a test can be read without running it. */
export const FEATURE_TOPIC = "feature:bc52e64d1cbcc204";
export const DIMENSION_TOPIC = "work-item-dimension:dacb48b0720f0ed5";
export const COVERAGE_TOPIC = "coverage:510e691a6643fdfa";
/** Bound by all three topics above; owned by the FEATURE leaf until the feature topic stops binding it. */
export const MIGRATING_OBLIGATION = "feature:leave-1a2b3c4d5e:logic:approve@svc/leave/approve.go:10";

export const OVERVIEW_PRODUCT = "overview-product";
export const BRIDGE_UNIT = `${OVERVIEW_PRODUCT}::bridge::features`;

/** The fixture plan is model-free, and its identities must say so rather than borrow a model family's name. */
export const FIXTURE_AUTHORSHIP: UnitAuthorship = { kind: "model-free", generator: "fixture-plan" };

/** One plan state: a catalog, the recorded requests, and the artifacts a validated proposal derives. */
export interface PlanState {
  readonly label: string;
  readonly catalog: TopicCatalogArtifact;
  readonly requests: ReportRequestsArtifact;
  readonly planCatalog: PlanCatalogArtifact;
  readonly dag: PlanDagArtifact;
  readonly ownership: ObligationOwnershipIndex;
}

export interface IdentityFixture {
  readonly run: MiniRun;
  /**
   * The VERIFIED child summaries: one per non-synthesis unit of the BASE state.
   *
   * They stand for what a prior run collected, which is why they are built once from the base plan and never
   * rebuilt for a perturbed state: a synthesis identity is computed from the summaries a candidate actually holds,
   * and recomputing them per state would quietly make every synthesis look reusable.
   */
  readonly summaries: ReadonlyMap<string, UnitSummary>;
  readonly base: PlanState;
}

let shared: Promise<IdentityFixture> | null = null;

/** The fixture, built once per process. The premises it stands on are asserted here rather than assumed. */
export function identityFixture(): Promise<IdentityFixture> {
  return (shared ??= build());
}

async function build(): Promise<IdentityFixture> {
  const run = await miniRun();
  const base = planStateOf(run, "base", run.catalog, run.requests, bridgedProposal(run.catalog, run.requests));
  // Fail closed: every pinned premise below is checked, so a fixture that stopped exercising ownership migration
  // fails here instead of passing a test that no longer means anything.
  const feature = topicOf(run.catalog, FEATURE_TOPIC);
  assert.ok(feature.bindings.some((binding) => binding.workItemId === MIGRATING_OBLIGATION),
    `${FEATURE_TOPIC} must bind ${MIGRATING_OBLIGATION}, or dropping that binding cannot move an owner`);
  assert.ok(topicOf(run.catalog, DIMENSION_TOPIC).bindings.some((binding) => binding.workItemId === MIGRATING_OBLIGATION),
    `${DIMENSION_TOPIC} must bind ${MIGRATING_OBLIGATION}, or the obligation would become unowned rather than move`);
  const owner = documentOwnership(base.ownership, OVERVIEW_PRODUCT).ownerByObligation.get(MIGRATING_OBLIGATION);
  assert.equal(owner?.ownerUnitId, `${OVERVIEW_PRODUCT}::leaf::feature`, "the base owner must be the feature leaf");
  return { run, summaries: verifiedSummaries(base), base };
}

/** The topic row, or a named failure: a fixture that silently skipped a missing topic would test nothing. */
export function topicOf(catalog: TopicCatalogArtifact, topicId: string): TopicCandidate {
  const topic = catalog.topics.find((row) => row.topicId === topicId);
  if (!topic) throw new Error(`the mini catalog does not hold topic ${JSON.stringify(topicId)}`);
  return topic;
}

/** Whole-topic references, the fixture plan's own shape. */
function whole(topicIds: readonly string[]): readonly ProposedUnitTopic[] {
  return topicIds.map((topicId) => ({ topicId, obligationScope: FULL_OBLIGATION_SCOPE }));
}

/**
 * The fixture plan plus a BRIDGE over `overview-product`'s feature topics.
 *
 * The generator mints no bridge, and the epic's acceptance for a content perturbation names one: a unit that
 * REFERENCES the changed topic must be invalidated with the units that own it, even though it grounds nothing.
 */
export function bridgedProposal(catalog: TopicCatalogArtifact, requests: ReportRequestsArtifact): PlanProposal {
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const featureTopics = proposal.units
    .filter((unit) => unit.unitId === `${OVERVIEW_PRODUCT}::leaf::feature`)
    .flatMap((unit) => (unit.kind === "synthesis" ? [] : unit.topics.map((topic) => topic.topicId)));
  if (featureTopics.length === 0) return proposal;
  const bridge: ProposedUnit = {
    kind: "bridge",
    unitId: BRIDGE_UNIT,
    documentId: OVERVIEW_PRODUCT,
    title: "How the features relate",
    topics: whole(featureTopics)
  };
  const others = proposal.units.filter((unit) => unit.documentId !== OVERVIEW_PRODUCT);
  const leaves = proposal.units.filter((unit) => unit.documentId === OVERVIEW_PRODUCT && unit.kind !== "synthesis");
  const children = [...leaves.map((unit) => unit.unitId), bridge.unitId].sort((a, b) => a.localeCompare(b));
  const units: ProposedUnit[] = [
    ...others,
    ...leaves,
    bridge,
    {
      kind: "synthesis",
      unitId: `${OVERVIEW_PRODUCT}::synthesis::document`,
      documentId: OVERVIEW_PRODUCT,
      title: `${OVERVIEW_PRODUCT} synthesis`,
      childUnitIds: children
    }
  ];
  const parsed = parsePlanProposal({ ...JSON.parse(canonicalJson(proposal)) as Record<string, unknown>, units: units.sort((a, b) => a.unitId.localeCompare(b.unitId)).map((unit) => JSON.parse(canonicalJson(unit)) as unknown) });
  if (!parsed.proposal) throw new Error(`the bridged proposal does not parse: ${parsed.problems.join("; ")}`);
  return parsed.proposal;
}

/** Validate one proposal against one catalog and derive its artifacts. A refused plan is a named throw. */
export function planStateOf(
  run: MiniRun,
  label: string,
  catalog: TopicCatalogArtifact,
  requests: ReportRequestsArtifact,
  proposal: PlanProposal
): PlanState {
  const report = validatePlan({
    catalog,
    requests,
    proposal,
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    evidence: run.evidenceById,
    reach: run.reach,
    epochCoverage: run.epochCoverage
  });
  if (report.overall.conclusion === "violations") {
    throw new Error(`plan state ${JSON.stringify(label)} does not validate: ${report.overall.problems.join("; ")}`);
  }
  const artifacts = buildPlanArtifacts({ catalog, requests, proposal, budgetTable: PLAN_BUDGET_TABLE, verdict: report.overall, revision: FIRST_PLAN_REVISION });
  return { label, catalog, requests, planCatalog: artifacts.planCatalog, dag: artifacts.dag, ownership: report.ownership };
}

/** A plan state over a perturbed catalog, with the same bridged proposal shape re-derived from it. */
export function stateOverCatalog(run: MiniRun, label: string, catalog: TopicCatalogArtifact, requests: ReportRequestsArtifact): PlanState {
  return planStateOf(run, label, catalog, requests, bridgedProposal(catalog, requests));
}

/**
 * A binding-PRESERVING content change: one topic's title, with every derived field re-derived by Core's own
 * functions and the digest re-minted the way `mintTopicCandidate` mints it.
 */
export function withTopicTitle(catalog: TopicCatalogArtifact, topicId: string, title: string): TopicCatalogArtifact {
  const topic = topicOf(catalog, topicId);
  return withTopic(catalog, reminted(topic, { title, bindings: topic.bindings }));
}

/** A binding-SET change: one topic stops binding one obligation. Everything else about the topic is untouched. */
export function withoutBinding(catalog: TopicCatalogArtifact, topicId: string, workItemId: string): TopicCatalogArtifact {
  const topic = topicOf(catalog, topicId);
  const bindings = topic.bindings.filter((binding) => binding.workItemId !== workItemId);
  if (bindings.length === topic.bindings.length) throw new Error(`topic ${JSON.stringify(topicId)} does not bind ${JSON.stringify(workItemId)}`);
  if (bindings.length === 0) throw new Error(`dropping ${JSON.stringify(workItemId)} would leave topic ${JSON.stringify(topicId)} unbound, which is a different perturbation`);
  return withTopic(catalog, reminted(topic, { title: topic.title, bindings }));
}

/** One document added to the recorded requests — the second-audience shape, at the value layer. */
export function withDocument(requests: ReportRequestsArtifact, document: LegacyDocumentRequest): ReportRequestsArtifact {
  assert.equal(requests.requests.length, MINI_DOCUMENTS.length, "withDocument adds to the fixture's own three documents");
  return buildReportRequestsArtifact([...MINI_DOCUMENTS, document]);
}

/** One document dropped from the recorded requests: the shape that RETIRES a set of verified units. */
export function withoutDocument(requests: ReportRequestsArtifact, documentId: string): ReportRequestsArtifact {
  assert.equal(requests.requests.length, MINI_DOCUMENTS.length, "withoutDocument removes from the fixture's own three documents");
  const remaining = MINI_DOCUMENTS.filter((document) => document.documentId !== documentId);
  assert.equal(remaining.length, MINI_DOCUMENTS.length - 1, `the fixture requests must hold ${documentId}`);
  return buildReportRequestsArtifact(remaining);
}

/** A registry whose lens for one audience has a new version, and therefore a new digest. */
export function withLensVersion(registry: ReportPolicyRegistry, audience: string, version: string): ReportPolicyRegistry {
  const lens = registry.lenses[audience];
  if (!lens) throw new Error(`the policy registry holds no lens for audience ${JSON.stringify(audience)}`);
  const bumped = { id: lens.id, version, content: lens.content };
  return {
    ...registry,
    lenses: { ...registry.lenses, [audience]: { ...bumped, digest: sha256(canonicalJson(bumped)) } }
  };
}

/** Replace one topic and keep the catalog's own census honest: a stale reading here would be a lying fixture. */
function withTopic(catalog: TopicCatalogArtifact, topic: TopicCandidate): TopicCatalogArtifact {
  const topics = catalog.topics.map((row) => (row.topicId === topic.topicId ? topic : row));
  const assigned = new Set<string>();
  for (const row of topics) for (const binding of row.bindings) assigned.add(binding.workItemId);
  assert.equal(assigned.size, catalog.obligationAccounting.assigned,
    "this perturbation changed which obligations any topic carries, so the catalog's obligation accounting would be stale — recompute it here before using it");
  return { ...catalog, topics };
}

/** One topic with derived fields re-derived: materiality, confidence, completeness and the digest. */
function reminted(topic: TopicCandidate, next: { readonly title: string; readonly bindings: readonly TopicObligationBinding[] }): TopicCandidate {
  const bindings = [...next.bindings].sort((a, b) => a.workItemId.localeCompare(b.workItemId));
  const { digest: _replaced, ...rest } = topic;
  const withoutDigest = {
    ...rest,
    title: next.title,
    bindings,
    materiality: materialityOf(bindings),
    confidence: confidenceOf(bindings),
    completeness: {
      ...topic.completeness,
      boundWorkItems: bindings.length,
      settledWorkItems: bindings.filter((binding) => statusDetermination(binding.status) !== "open").length
    }
  };
  return { ...withoutDigest, digest: topicCandidateDigest(withoutDigest) };
}

export interface IdentityInputOptions {
  /** For the epoch perturbation: a plan catalog with one field moved. */
  readonly planCatalog?: PlanCatalogArtifact;
  /** For the policy perturbation. */
  readonly registry?: ReportPolicyRegistry;
  /** For the synthesis arm: the verified child summaries a candidate holds. */
  readonly summaries?: ReadonlyMap<string, UnitSummary>;
  /** For the terms fixtures: the author this identity stands for. Defaults to the fixture plan's own. */
  readonly authorship?: UnitAuthorship;
}

/** The packet input of one unit of one plan state — the same values `renderUnitPacket` is given anywhere else. */
export function identityInput(fixture: IdentityFixture, state: PlanState, unitId: string, options: IdentityInputOptions = {}): UnitPacketInput {
  const planCatalog = options.planCatalog ?? state.planCatalog;
  const unit = planCatalog.units.find((row) => row.unitId === unitId);
  if (!unit) throw new Error(`plan state ${JSON.stringify(state.label)} holds no unit ${JSON.stringify(unitId)}`);
  return {
    planCatalog,
    facets: state.catalog.facets,
    dag: state.dag,
    requests: state.requests,
    registry: options.registry ?? REPORT_POLICY_REGISTRY,
    unitId,
    dossier: dossierFor(fixture, state, unit, options.summaries ?? fixture.summaries),
    ownership: documentOwnership(state.ownership, unit.documentId),
    coverage: fixture.run.epochCoverage,
    reach: fixture.run.reach,
    byteLimit: 4_194_304,
    overBudget: "refuse"
  };
}

/** The identity of one unit of one plan state. */
export function identityOf(fixture: IdentityFixture, state: PlanState, unitId: string, options: IdentityInputOptions = {}): UnitIdentity {
  return unitIdentityOf(identityInput(fixture, state, unitId, options), options.authorship ?? FIXTURE_AUTHORSHIP);
}

/**
 * Every unit of one plan state as a `PlannedUnitIdentity`.
 *
 * A synthesis is carried by the `candidate-children-summaries` arm whenever every child it names has a verified
 * summary, and by `children-unavailable` when one does not — which is exactly what a division that renamed a part
 * produces. The arm is chosen from what the candidate side HOLDS, never from what the plan wishes were there.
 */
export function plannedIdentities(
  fixture: IdentityFixture,
  state: PlanState,
  summaries: ReadonlyMap<string, UnitSummary> = fixture.summaries,
  authorship: UnitAuthorship = FIXTURE_AUTHORSHIP
): readonly PlannedUnitIdentity[] {
  return state.planCatalog.units.map((unit) => {
    if (unit.kind !== "synthesis") {
      return { derivation: "own-inputs", identity: identityOf(fixture, state, unit.unitId, { summaries, authorship }) } as const;
    }
    const missing = [...unit.childUnitIds].filter((childUnitId) => !summaries.has(childUnitId)).sort((a, b) => a.localeCompare(b));
    if (missing.length > 0) {
      return {
        derivation: "children-unavailable",
        unitId: unit.unitId,
        documentId: unit.documentId,
        kind: unit.kind,
        childUnitIds: unit.childUnitIds,
        reason: `no verified summary is held for ${missing.length} of its ${unit.childUnitIds.length} child unit(s): ${missing.join(", ")}`
      } as const;
    }
    return {
      derivation: "candidate-children-summaries",
      identity: identityOf(fixture, state, unit.unitId, { summaries, authorship }),
      childUnitIds: unit.childUnitIds
    } as const;
  });
}

/**
 * Candidates held as WHOLE identities — the form only a caller with both plan states can produce.
 *
 * The other form (a ledger row's recorded digest) is what a re-planned run on disk actually has, and it is exercised
 * by the admission tests against a real run directory. Stated as a helper here so the wrapping is one spelling.
 */
export function heldCandidates(identities: readonly UnitIdentity[]): readonly CandidateIdentity[] {
  return identities.map((identity) => ({ form: "identity", identity }));
}

/** The dossier for one unit: its topics, or the verified summaries of its children. */
function dossierFor(fixture: IdentityFixture, state: PlanState, unit: PlanCatalogUnit, summaries: ReadonlyMap<string, UnitSummary>): UnitDossier {
  if (unit.kind !== "synthesis") {
    return topicDossier(unit, new Map(state.catalog.topics.map((topic) => [topic.topicId, topic])), fixture.run.evidenceById);
  }
  const children = [...unit.childUnitIds].sort((a, b) => a.localeCompare(b)).map((childUnitId) => {
    const summary = summaries.get(childUnitId);
    if (!summary) throw new Error(`no verified summary is held for child ${JSON.stringify(childUnitId)} of ${JSON.stringify(unit.unitId)}`);
    return summary;
  });
  return { source: "child-summaries", children };
}

/**
 * The verified summaries of one plan state's non-synthesis units.
 *
 * Deterministic and model-free: the digests are sha256 over the unit's own id, because what a summary SAYS is not
 * what this fixture is about — that a synthesis's identity is a function of the summaries a candidate holds is.
 */
function verifiedSummaries(state: PlanState): ReadonlyMap<string, UnitSummary> {
  const summaries = new Map<string, UnitSummary>();
  for (const unit of state.planCatalog.units) {
    if (unit.kind === "synthesis") continue;
    summaries.set(unit.unitId, {
      version: UNIT_SUMMARY_VERSION,
      unitId: unit.unitId,
      documentId: unit.documentId,
      kind: unit.kind,
      coveredTopicIds: unit.topics.map((topic) => topic.topicId).sort((a, b) => a.localeCompare(b)),
      keyStatements: [`${unit.title} 的当前状态已记录。`],
      unknowns: [],
      terminology: [],
      contentDigest: sha256(`content:${unit.unitId}`),
      claimsDigest: sha256(`claims:${unit.unitId}`),
      childSummaryDigests: []
    });
  }
  return summaries;
}
