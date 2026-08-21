// Deterministic, read-only projection of one frozen run into UNIT CACHE IDENTITY readings (57B-434 R6a).
//
// What it answers: for the plan a real corpus produces, WHICH units would a set of verified drafts still answer
// for, and what does each kind of change to the run cost. Two numbers matter above the rest:
//
//   1. THE SAME-SOURCE TRIPWIRE, per unit: the identity view and the packet an author reads are one composition,
//      and the lines they disagree on must be exactly the three declared plan-global digests
//      (`IDENTITY_NORMALIZED_HEADER_LABELS`). The row records the labels that differed, and the extractor throws if
//      a fourth line ever does — an identity that quietly stopped covering a rendered input is the failure mode
//      this whole slice is built around.
//   2. THE SECOND-AUDIENCE READING: adding a document to the recorded requests must rebuild NOTHING of the
//      documents already planned. That is the epic's own acceptance, and it is only satisfiable because those three
//      digest lines are normalized: without the normalization every existing packet's bytes move.
//
// FIVE SCENARIOS, and the two perturbation shapes are deliberately both here. A binding-PRESERVING content change
// (a topic's title) can only move the units that name the topic and their ancestors. A binding-SET change moves
// OWNERSHIP, so a sibling unit that never named the topic moves too, and on a divided plan the part ids themselves
// can change — which reads as new + retired rather than rebuild. Recording only the first would confirm the
// premise the epic was written under; the difference between the two rows is the finding.
//
// Nothing here writes into the run it reads: the plan artifacts are built in MEMORY, exactly as
// `eval/unit-packet-readings.ts` does, because both R0 baselines are archival. Every input it cannot project is a
// named throw, and a target that cannot support a perturbation says so by name instead of reporting a zero.
//
// A DIGEST IN A READING IS ONLY EVIDENCE IF SOMETHING CAN CHECK IT (R6c). Two things make that true here, and the
// reason both are needed is that the baselines' inputs are archival: the reading is split into a VALUE projection
// (recomputed byte for byte over the in-repo mini fixture on every run) and a directory loader over it, and every
// reading carries the `contract` the digests were minted under, pinned to the code's constants by the golden tests.
//
// SECTION-LEVEL LOCATION IS THE PROMISED GRANULARITY, AND SENTENCE-LEVEL IS RULED OUT (57B-434, item #12 of the R8
// pre-cleanup). A packet wording change shows up here as a byte delta and a moved digest; to see WHICH SENTENCES
// moved you have the per-section digests and `sectionHeadings`, which narrow it to the section that changed. That
// is as fine as this reading goes, on purpose: a sentence-level projection means putting the packet's PROSE into
// the golden, and the packets are megabytes (measured on the wcp baseline) — a golden nobody can review is not a
// finer instrument, it is a bigger one. So the reading answers "which section of which unit moved", and the diff
// of the packet renderer answers "which sentence".

import { join } from "node:path";
import type { DocumentPlan, EvidenceItem, RunManifest } from "../src/base/types.ts";
import { canonicalJson, readJson, sha256 } from "../src/base/util.ts";
import { featureKeyOf } from "../src/report/authoring-packet.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { FIRST_PLAN_REVISION, buildPlanArtifacts, planCatalogDigest, type PlanCatalogArtifact, type PlanCatalogUnit, type PlanDagArtifact } from "../src/report/plan-artifacts.ts";
import { documentOwnership, type ObligationOwnershipIndex } from "../src/report/plan-obligation-conservation.ts";
import { AUTHORING_UNIT_KINDS } from "../src/report/plan-proposal.ts";
import { planThroughBudgetRefinement } from "../src/report/plan-unit-split.ts";
import { loadRunEvidenceReach } from "../src/report/run-evidence-reach.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
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
import { buildTopicCatalog, type TopicCatalogArtifact } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import { projectEpochCoverage } from "../src/report/coverage-projection.ts";
import type { PacketCoverageFacts } from "../src/report/coverage-companion.ts";
import {
  IDENTITY_NORMALIZED_HEADER_LABELS,
  composeUnitPacketMarkdown,
  topicDossier,
  unitInputBound,
  type RunEvidenceReach,
  type UnitPacketInput
} from "../src/report/unit-packet.ts";
import { UNIT_IDENTITY_KEY_VERSIONS, unitIdentityOf, type UnitIdentityKeyVersions } from "../src/report/unit-cache-identity.ts";
import { describeAuthorship, type UnitAuthorship } from "../src/report/unit-provenance.ts";
import {
  deriveUnitCachePlan,
  type CandidateIdentity,
  type CandidateSource,
  type PlannedUnitIdentity,
  type UnitCacheEntry,
  type UnitCachePlan
} from "../src/report/unit-cache-plan.ts";

/** v2 (R6c): every reading carries the key's own version set, so a bump cannot pass unnoticed again. */
export const UNIT_CACHE_IDENTITY_READINGS_VERSION = "unit-cache-identity-readings-v2";

/*
 * SEVERAL HELPERS BELOW ARE EXPORTED FOR `unit-cache-admission-readings.ts` — the plan-state projection, the two
 * perturbations and the second-audience document. R6b's reading has to compare the SAME states this one measures;
 * building a second projection beside it is the drift this whole slice is about, one level up.
 */

/**
 * The author every identity in this projection is computed for.
 *
 * Constant across the whole reading, so it cancels out of every comparison below and none of the scenarios is
 * measuring an authorship change. It is model-FREE and named, because this projection is a deterministic
 * derivation: claiming a model family wrote these packets would be a false provenance in a cache key.
 */
const PROJECTION_AUTHORSHIP: UnitAuthorship = { kind: "model-free", generator: "eval-unit-cache-identity-readings" };

export interface UnitIdentityRow {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: string;
  readonly identityDigest: string;
  readonly viewBytes: number;
  readonly packetBytes: number;
  readonly sections: number;
  /**
   * The header labels the identity view and the packet disagreed on. MUST be the three declared ones, every time.
   *
   * Recorded per unit rather than asserted once: a reading that only said "the tripwire passed" would not show
   * WHICH lines were normalized, and this list is the whole safety argument for excluding them.
   */
  readonly normalizedLabels: readonly string[];
  /** The identity view's sections, so a rebuild reason in any scenario below can be read against them. */
  readonly sectionHeadings: readonly string[];
}

/** One perturbation's outcome. Closed: a target that cannot support the perturbation says so by name. */
export type ScenarioOutcome =
  | {
      readonly state: "derived";
      readonly candidateStatement: string;
      readonly plannedUnits: number;
      readonly candidateUnits: number;
      readonly reusable: readonly string[];
      readonly rebuild: readonly {
        readonly unitId: string;
        readonly cause: string;
        /** The terms that moved (authorship, output contract, this document's request row). Empty in every scenario
         * here: the projection holds authorship and the build's contract constant, and it perturbs the CATALOG. */
        readonly changedTerms: readonly string[];
        readonly changedSections: readonly string[];
      }[];
      readonly new: readonly string[];
      readonly retired: readonly string[];
      readonly conservation: readonly string[];
    }
  | { readonly state: "not-applicable"; readonly reason: string };

export interface ScenarioReading {
  readonly scenario: string;
  /** What was changed, at the value layer, in words — including which row of the catalog. */
  readonly perturbation: string;
  readonly outcome: ScenarioOutcome;
}

/**
 * A reading of one plan state, without the paths only a run directory has.
 *
 * The split is what makes the digests below CHECKABLE. `extractUnitIdentityReadings` projects archival run
 * directories that are not in this repository, so its two goldens can only ever be records; this projection takes
 * VALUES, so the same function runs over the in-repo mini fixture and its golden is recomputed and compared byte for
 * byte on every `npm test` (`eval/tests/unit-cache-identity-fixture-readings.test.ts`). One reading function, two
 * kinds of input — not a second projection written to be testable.
 */
export interface UnitIdentityProjection {
  readonly version: typeof UNIT_CACHE_IDENTITY_READINGS_VERSION;
  /**
   * The versions this reading's `identityDigest` values were minted under — REQUIRED, and pinned to the code's own
   * constants by the golden tests.
   *
   * This field exists because of the failure it would have caught: R6b bumped the receipt schema while that version
   * was part of the identity key, so 37 checked-in digests silently became unproducible and every test stayed
   * green. A digest is only evidence if either the input that produced it is in the repository or the contract that
   * produced it is recorded beside it.
   */
  readonly contract: UnitIdentityKeyVersions;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly knowledgeDigest: string;
  readonly planCatalogDigest: string;
  readonly authorship: string;
  readonly units: number;
  readonly unitsByKind: readonly { readonly kind: string; readonly units: number }[];
  /** One row per unit whose identity this projection could compute, ascending. */
  readonly identified: readonly UnitIdentityRow[];
  /**
   * Units with no identity here, by name and reason.
   *
   * A synthesis is written from its children's COLLECTED summaries and an archival run has authored nothing, so on
   * both baselines every document root is here. That is a fact about the run, not a gap in the reading — and it is
   * why those units read as `new` in every scenario below rather than as reusable.
   */
  readonly unidentified: readonly { readonly unitId: string; readonly reason: string }[];
  readonly scenarios: readonly ScenarioReading[];
}

/** A projection of one run DIRECTORY: the reading above, plus the files it was taken from. */
export interface UnitIdentityReadings extends UnitIdentityProjection {
  readonly readPaths: readonly string[];
}

/** Recover the v2 request rows from the run manifest, the way prepare records them. */
export function legacyDocuments(manifest: RunManifest): readonly LegacyDocumentRequest[] {
  return manifest.documents.map((document: DocumentPlan) => ({
    documentId: document.id,
    kind: document.kind,
    audience: document.audience,
    featureKey: document.kind === "feature" ? featureKeyOf(document) : null,
    detailLevel: manifest.request.detailLevel ?? "standard",
    language: manifest.request.language
  }));
}

export interface StateProjection {
  readonly planCatalog: PlanCatalogArtifact;
  readonly dag: PlanDagArtifact;
  readonly ownership: ObligationOwnershipIndex;
  readonly planned: readonly PlannedUnitIdentity[];
  readonly rows: readonly UnitIdentityRow[];
  readonly unidentified: readonly { readonly unitId: string; readonly reason: string }[];
}

/** Why a synthesis has no identity on an archival run. One sentence, used everywhere it is needed. */
const SYNTHESIS_UNAVAILABLE = "a synthesis unit is written from its children's COLLECTED summaries, and this archival run has authored no unit, so there is no verified summary to compute an identity from";

/**
 * Plan one catalog + requests state through the same door the plan stage uses, then identify every unit.
 *
 * The packet inputs are built here from values, the way `eval/unit-packet-readings.ts` builds them: an archival run
 * has no `plan/` on disk and may not be written to. The identity and the packet come out of ONE call each into the
 * renderer, so the tripwire below compares two views of the same composition rather than two compositions.
 */
export function projectState(
  label: string,
  catalog: TopicCatalogArtifact,
  requests: ReportRequestsArtifact,
  evidenceById: ReadonlyMap<string, EvidenceItem>,
  reach: RunEvidenceReach,
  epochCoverage: PacketCoverageFacts
): StateProjection {
  const planned = planThroughBudgetRefinement({
    catalog,
    requests,
    proposal: buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE),
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    evidence: evidenceById,
    reach,
    epochCoverage
  });
  if (planned.state === "rejected") {
    throw new Error(`the ${label} plan state cannot be recorded: ${planned.problems.join("; ")}`);
  }
  const artifacts = buildPlanArtifacts({
    catalog,
    requests,
    proposal: planned.proposal,
    budgetTable: PLAN_BUDGET_TABLE,
    verdict: planned.report.overall,
    revision: FIRST_PLAN_REVISION
  });
  const planCatalog = artifacts.planCatalog;
  const topicsById = new Map(catalog.topics.map((topic) => [topic.topicId, topic]));
  const rows: UnitIdentityRow[] = [];
  const unidentified: { unitId: string; reason: string }[] = [];
  const identities: PlannedUnitIdentity[] = [];
  for (const unit of planCatalog.units) {
    if (unit.kind === "synthesis") {
      unidentified.push({ unitId: unit.unitId, reason: SYNTHESIS_UNAVAILABLE });
      identities.push({
        derivation: "children-unavailable",
        unitId: unit.unitId,
        documentId: unit.documentId,
        kind: unit.kind,
        childUnitIds: unit.childUnitIds,
        reason: SYNTHESIS_UNAVAILABLE
      });
      continue;
    }
    const input: UnitPacketInput = {
      planCatalog,
      facets: catalog.facets,
      dag: artifacts.dag,
      requests,
      registry: REPORT_POLICY_REGISTRY,
      unitId: unit.unitId,
      dossier: topicDossier(unit, topicsById, evidenceById),
      ownership: documentOwnership(planned.report.ownership, unit.documentId),
      coverage: epochCoverage,
      reach,
      byteLimit: unitInputBound(planCatalog, unit),
      // A measurement, not a verdict: the identity is composed with no limitation line either way, and the packet
      // side of the tripwire below must be the same composition. Recorded rather than refused for the same reason
      // `eval/unit-packet-readings.ts` records it — a projection that threw would report nothing at all.
      overBudget: "record-limitation"
    };
    const identity = unitIdentityOf(input, PROJECTION_AUTHORSHIP);
    identities.push({ derivation: "own-inputs", identity });
    rows.push({
      unitId: unit.unitId,
      documentId: unit.documentId,
      kind: unit.kind,
      identityDigest: identity.digest,
      viewBytes: identity.viewBytes,
      packetBytes: Buffer.byteLength(composeUnitPacketMarkdown(input, "packet"), "utf8"),
      sections: identity.sections.length,
      normalizedLabels: normalizedLabelsOf(input, unit),
      sectionHeadings: identity.sections.map((section) => section.heading)
    });
  }
  return { planCatalog, dag: artifacts.dag, ownership: planned.report.ownership, planned: identities, rows, unidentified };
}

/**
 * THE TRIPWIRE. Which header labels the packet and the identity view disagree on — and it must be the three.
 *
 * A line count that differs, a line that is not one of the declared labels, or a normalized line that is not
 * normalized in place are all named throws here rather than a reading somebody has to notice.
 */
function normalizedLabelsOf(input: UnitPacketInput, unit: PlanCatalogUnit): readonly string[] {
  const packet = composeUnitPacketMarkdown(input, "packet").split("\n");
  const identity = composeUnitPacketMarkdown(input, "identity").split("\n");
  if (packet.length !== identity.length) {
    throw new Error(`unit ${JSON.stringify(unit.unitId)}: the identity view has ${identity.length} line(s) against the packet's ${packet.length}; it normalizes lines in place and may not add or remove one`);
  }
  const labels: string[] = [];
  for (const [index, line] of packet.entries()) {
    if (line === identity[index]) continue;
    const label = IDENTITY_NORMALIZED_HEADER_LABELS.find((candidate) => line.startsWith(`- ${candidate}: `));
    if (!label) {
      throw new Error(`unit ${JSON.stringify(unit.unitId)}: line ${index} differs between the packet and its identity view (${JSON.stringify(line)} against ${JSON.stringify(identity[index])}) and is not one of the declared normalized lines; the identity has stopped covering an input the packet renders`);
    }
    labels.push(label);
  }
  return labels;
}

/** One topic replaced, with every derived field re-derived by Core's own functions and the digest re-minted. */
export function withTopic(catalog: TopicCatalogArtifact, topic: TopicCandidate): TopicCatalogArtifact {
  const topics = catalog.topics.map((row) => (row.topicId === topic.topicId ? topic : row));
  const assigned = new Set<string>();
  for (const row of topics) for (const binding of row.bindings) assigned.add(binding.workItemId);
  if (assigned.size !== catalog.obligationAccounting.assigned) {
    throw new Error(`this perturbation changed which obligations the catalog carries (${assigned.size} against the recorded ${catalog.obligationAccounting.assigned}); the catalog's own accounting would be stale, so the perturbation must recompute it before being used`);
  }
  return { ...catalog, topics };
}

export function reminted(topic: TopicCandidate, next: { readonly title: string; readonly bindings: readonly TopicObligationBinding[] }): TopicCandidate {
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

/**
 * The topics a perturbation is applied to: deterministic, and both stated in the reading.
 *
 * TWO TARGETS, because one would answer only half the question:
 *
 *   * the smallest material topic — the cheapest possible change, which isolates "which units does one topic's
 *     content invalidate" from every side effect a large topic has;
 *   * the smallest material topic that OWNS at least one obligation somewhere. This is the one that can move
 *     ownership when its binding set changes, and on a divided plan it is also the one whose measured bytes decide
 *     part ids — so both the sibling-invalidation effect and the new+retired effect show up here or nowhere.
 *
 * Both a content change and a binding-set change are applied to the SECOND target, so the two shapes are compared
 * on one topic rather than across two.
 */
export function smallestMaterialTopic(topics: readonly TopicCandidate[]): TopicCandidate | null {
  const material = topics.filter((topic) => topic.materiality === "material" && topic.bindings.length > 0);
  if (material.length === 0) return null;
  return [...material].sort((a, b) => a.bindings.length - b.bindings.length || a.topicId.localeCompare(b.topicId))[0]!;
}

/** Every topic that is the OWNER of at least one obligation in at least one document, by id. */
export function ownerTopicIds(planCatalog: PlanCatalogArtifact, ownership: ObligationOwnershipIndex): ReadonlySet<string> {
  const owners = new Set<string>();
  for (const document of new Set(planCatalog.units.map((unit) => unit.documentId))) {
    for (const owner of documentOwnership(ownership, document).ownerByObligation.values()) owners.add(owner.ownerTopicId);
  }
  return owners;
}

function entriesOf(plan: UnitCachePlan, status: UnitCacheEntry["status"]): readonly string[] {
  return plan.entries.filter((entry) => entry.status === status).map((entry) => entry.unitId);
}

function outcomeOf(plan: UnitCachePlan): ScenarioOutcome {
  return {
    state: "derived",
    candidateStatement: plan.candidateStatement,
    plannedUnits: plan.conservation.plannedUnits,
    candidateUnits: plan.conservation.candidateUnits,
    reusable: entriesOf(plan, "reusable"),
    rebuild: plan.entries.flatMap((entry) => entry.status !== "rebuild" ? [] : [{
      unitId: entry.unitId,
      cause: entry.reason.cause,
      changedTerms: entry.reason.cause === "identity-changed" ? entry.reason.changedTerms : [],
      changedSections: entry.reason.cause === "identity-changed" ? entry.reason.changedSections : []
    }]),
    new: entriesOf(plan, "new"),
    retired: plan.retired.map((row) => row.unitId),
    conservation: plan.conservation.statements
  };
}

/** Project one frozen run directory. Never writes; every failure is a named throw. */
export async function extractUnitIdentityReadings(runDir: string): Promise<UnitIdentityReadings> {
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const source = await loadTopicCatalogSource(runDir, manifest);
  const catalog = buildTopicCatalog(source);
  const evidence = await loadRunEvidenceReach(runDir, source);
  return {
    ...projectUnitIdentityReadings({
      catalog,
      documents: legacyDocuments(manifest),
      evidenceById: evidence.evidenceById,
      reach: evidence.reach,
      epochCoverage: projectEpochCoverage(source)
    }),
    readPaths: [...new Set([...source.readPaths, "run.json", "evidence.json"])].sort((a, b) => a.localeCompare(b))
  };
}

/** The values one reading is taken from — a catalog, the requested documents, and the run's evidence. */
export interface UnitIdentityProjectionInput {
  readonly catalog: TopicCatalogArtifact;
  readonly documents: readonly LegacyDocumentRequest[];
  readonly evidenceById: ReadonlyMap<string, EvidenceItem>;
  readonly reach: RunEvidenceReach;
  /**
   * The epoch-only coverage families (R7a). Required, because the appendix packet renders them and this projection
   * digests the packet: an omitted one would produce identities for a packet nobody is handed.
   *
   * It is a function of the SEALED EPOCH, so it is the same value in every perturbed plan state below — which is
   * exactly why the coverage block cannot move an identity that only a topic perturbation should move.
   */
  readonly epochCoverage: PacketCoverageFacts;
}

/** The whole reading, from values. Deterministic: two calls on one input produce one byte sequence. */
export function projectUnitIdentityReadings(input: UnitIdentityProjectionInput): UnitIdentityProjection {
  const { catalog, documents, evidenceById, reach, epochCoverage } = input;
  const requests = buildReportRequestsArtifact(documents);
  const base = projectState("base", catalog, requests, evidenceById, reach, epochCoverage);

  // Held as WHOLE identities: this projection has both plan states in memory, which is the one situation where a
  // candidate's sections can be diffed. A re-planned run on disk holds only the digest its ledger recorded, and the
  // admission reading exercises that form.
  const candidates: readonly CandidateIdentity[] = base.planned.flatMap((row) => (row.derivation === "children-unavailable" ? [] : [{ form: "identity" as const, identity: row.identity }]));
  const priorRun: CandidateSource = {
    origin: "prior-verified-units",
    runId: catalog.runId,
    knowledgeEpoch: catalog.knowledgeEpoch,
    planCatalogDigests: [planCatalogDigest(base.planCatalog)]
  };
  const scenarios: ScenarioReading[] = [];

  // 1. The first run: no candidate at all. Reads as all new, with the reason it is empty.
  scenarios.push({
    scenario: "first-run",
    perturbation: "nothing is changed; the candidate set is empty, as it is on a run that has collected no unit",
    outcome: outcomeOf(deriveUnitCachePlan({
      planned: base.planned,
      candidates: [],
      candidateSource: { origin: "no-prior-verified-units", reason: "this projection offers no prior verified unit: an archival run has authored none" }
    }))
  });

  // 2. The same plan against its own identities: the determinism reading.
  scenarios.push({
    scenario: "unchanged",
    perturbation: "nothing is changed; the plan is compared with the identities of its own units",
    outcome: outcomeOf(deriveUnitCachePlan({ planned: base.planned, candidates, candidateSource: priorRun }))
  });

  // 3. A second audience document added to the recorded requests.
  const second = secondAudienceDocument(documents);
  scenarios.push({
    scenario: "second-audience-document",
    perturbation: second === null
      ? "no document could be added: every audience this run's manifest can express is already requested"
      : `one document added to the recorded requests: ${second.documentId} (${second.kind}, audience ${second.audience})`,
    outcome: second === null
      ? { state: "not-applicable", reason: "this run's manifest already requests every document the legacy mapping can express for it" }
      : outcomeOf(deriveUnitCachePlan({
          planned: projectState("second-audience", catalog, buildReportRequestsArtifact([...documents, second]), evidenceById, reach, epochCoverage).planned,
          candidates,
          candidateSource: priorRun
        }))
  });

  // 4, 5 and 6. The two perturbation shapes: a content change on the cheapest topic, then BOTH shapes on the
  // smallest topic that owns something — the only place ownership can move and part ids can change.
  const smallest = smallestMaterialTopic(catalog.topics);
  const owners = ownerTopicIds(base.planCatalog, base.ownership);
  const owner = smallestMaterialTopic(catalog.topics.filter((topic) => owners.has(topic.topicId) && topic.bindings.length >= 2));
  const noMaterial = "this catalog holds no material topic with a binding, so a topic perturbation cannot be applied to one";
  const contentScenario = (name: string, target: TopicCandidate): ScenarioReading => ({
    scenario: name,
    perturbation: `binding-preserving: the title of topic ${target.topicId} (facet ${target.facet}, ${target.bindings.length} binding(s), owner of an obligation somewhere: ${owners.has(target.topicId) ? "yes" : "no"}) changed; its binding set, its evidence and every other topic are untouched`,
    outcome: outcomeOf(deriveUnitCachePlan({
      planned: projectState(name, withTopic(catalog, reminted(target, { title: `${target.title} (perturbed by eval)`, bindings: target.bindings })), requests, evidenceById, reach, epochCoverage).planned,
      candidates,
      candidateSource: priorRun
    }))
  });

  scenarios.push(smallest === null
    ? { scenario: "content-change-smallest-topic", perturbation: "no material topic exists to perturb", outcome: { state: "not-applicable", reason: noMaterial } }
    : contentScenario("content-change-smallest-topic", smallest));

  if (owner === null) {
    const reason = "this catalog holds no material topic that both OWNS an obligation and binds at least two, so neither ownership migration nor a division can be perturbed here";
    scenarios.push({ scenario: "content-change-owner-topic", perturbation: "no owning topic with two bindings exists", outcome: { state: "not-applicable", reason } });
    scenarios.push({ scenario: "binding-dropped-owner-topic", perturbation: "no owning topic with two bindings exists", outcome: { state: "not-applicable", reason } });
  } else {
    scenarios.push(contentScenario("content-change-owner-topic", owner));
    const dropped = owner.bindings.map((binding) => binding.workItemId).sort((a, b) => a.localeCompare(b))[0]!;
    scenarios.push({
      scenario: "binding-dropped-owner-topic",
      perturbation: `binding-set: topic ${owner.topicId} (facet ${owner.facet}, ${owner.bindings.length} binding(s)) stops binding obligation ${dropped}; the obligation itself is untouched and still bound by whatever other topics bind it`,
      outcome: outcomeOf(deriveUnitCachePlan({
        planned: projectState("binding-dropped-owner-topic", withTopic(catalog, reminted(owner, { title: owner.title, bindings: owner.bindings.filter((binding) => binding.workItemId !== dropped) })), requests, evidenceById, reach, epochCoverage).planned,
        candidates,
        candidateSource: priorRun
      }))
    });
  }

  return {
    version: UNIT_CACHE_IDENTITY_READINGS_VERSION,
    contract: UNIT_IDENTITY_KEY_VERSIONS,
    runId: catalog.runId,
    knowledgeEpoch: catalog.knowledgeEpoch,
    knowledgeDigest: catalog.knowledgeDigest,
    planCatalogDigest: planCatalogDigest(base.planCatalog),
    authorship: describeAuthorship(PROJECTION_AUTHORSHIP),
    units: base.planCatalog.units.length,
    unitsByKind: AUTHORING_UNIT_KINDS.map((kind) => ({ kind, units: base.planCatalog.units.filter((unit) => unit.kind === kind).length })),
    identified: base.rows,
    unidentified: base.unidentified,
    scenarios
  };
}

/**
 * A document this run does not already request: the same feature (or overview) for the other audience.
 *
 * Returns null — and the scenario says so by name — when there is nothing left to add. The point of the scenario is
 * that an ADDED document must not invalidate the ones already planned, so it needs a document that is genuinely new.
 */
export function secondAudienceDocument(documents: readonly LegacyDocumentRequest[]): LegacyDocumentRequest | null {
  const taken = new Set(documents.map((document) => document.documentId));
  for (const document of documents) {
    const audience = document.audience === "product" ? "engineering" as const : "product" as const;
    const documentId = document.kind === "feature"
      ? `feature-${document.featureKey ?? "unknown"}-${audience}`
      : `overview-${audience}`;
    if (taken.has(documentId)) continue;
    return { ...document, documentId, audience };
  }
  return null;
}

/** The readings' own content identity, for a caller that wants to compare two projections. */
export function unitIdentityReadingsDigest(readings: UnitIdentityReadings): string {
  return sha256(canonicalJson(readings));
}
