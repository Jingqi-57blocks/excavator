// Deterministic, read-only projection of one frozen run into UNIT PACKET readings (57B-434 R4b).
//
// What it answers — and it is one question above all: does every material obligation a unit reaches get its own
// evidence into that unit's packet? 57B-453 measured the old per-document packet on this very baseline and found
// 60.1% (one document) and 74.5% (another) of material obligations could not be grounded from the packet they were
// written from. `evidenceAbsent` here is that number for the unit packets, and the reading exists to make it zero
// and keep it zero.
//
// Four rules this file holds:
//
//  1. It NEVER writes into the run it reads. The two R0 baselines are archival, so the plan artifacts are built in
//     MEMORY (the same way `eval/plan-readings.ts` does) and the packets are rendered from values. Nothing here
//     calls the plan stage or the unit loader, both of which need `plan/` on disk.
//  2. The 453 reading's requirement side comes from `workitems.json` DIRECTLY, not from the catalog the packets
//     were rendered through: a denominator taken from the code under test would agree with it whatever it did.
//     No id join anywhere — the obligation ids are compared by equality within one ledger (57B-458).
//  3. Synthesis units are NAMED, not silently skipped: an archival run has no collected child summaries, so their
//     packets cannot be rendered here, and saying which units that applies to is the difference between a gap and
//     a hole.
//  4. Determinism is recorded per unit (`renderedTwiceIdentical`), because a packet that differs between two
//     renderings of the same bytes would make every other number here unrepeatable.
//
// Zero model calls. Any input it cannot project is a named throw.

import { join } from "node:path";
import type { DocumentPlan, EvidenceItem, InvestigationPlan, RunManifest } from "../src/base/types.ts";
import { readJson, sha256, canonicalJson } from "../src/base/util.ts";
import { readEvidenceCatalog } from "../src/investigation/evidence-store.ts";
import { featureKeyOf } from "../src/report/authoring-packet.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { buildPlanArtifacts, planCatalogDigest, type PlanCatalogUnit } from "../src/report/plan-artifacts.ts";
import { materialObligationTopics, summariseObligationAccounting, type PlanObligationAccounting } from "../src/report/plan-obligation-conservation.ts";
import { AUTHORING_UNIT_KINDS } from "../src/report/plan-proposal.ts";
import { validatePlan } from "../src/report/plan-validation.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { buildReportRequestsArtifact, type ReportRequestsArtifact } from "../src/report/report-requests-artifact.ts";
import { buildTopicCatalog } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import { auditUnitGrounding } from "../src/report/unit-grounding-audit.ts";
import { renderUnitPacket, topicDossier, unitInputBound, unitPacketDigest, type RunEvidenceReach, type UnitPacket } from "../src/report/unit-packet.ts";

export const UNIT_PACKET_READINGS_VERSION = "unit-packet-readings-v1";

export interface UnitPacketReadingRow {
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: string;
  readonly topics: number;
  readonly obligations: number;
  readonly materialObligations: number;
  /** Material obligations reachable through this unit's topics, and the open-origin ones among them. */
  readonly reachableMaterial: number;
  readonly openOriginExempt: number;
  readonly renderedEvidenceIds: number;
  readonly packetBytes: number;
  readonly packetByteLimit: number;
  /** Empty when the packet fits; one recorded overrun when it does not. Never a dropped row. */
  readonly packetLimitations: readonly string[];
  readonly packetDigest: string;
  readonly renderedTwiceIdentical: boolean;
}

/** One material obligation whose evidence a packet that should carry it does not. Empty is the point. */
export interface AbsentEvidenceBinding {
  readonly unitId: string;
  readonly workItemId: string;
  readonly evidenceId: string;
}

export interface UnitPacketReadings {
  readonly version: typeof UNIT_PACKET_READINGS_VERSION;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly knowledgeDigest: string;
  readonly planCatalogDigest: string;
  readonly units: number;
  readonly unitsByKind: readonly { readonly kind: string; readonly units: number }[];
  /** Units whose packets this projection rendered; synthesis units are named below instead. */
  readonly rendered: readonly UnitPacketReadingRow[];
  /** Synthesis units: no collected child summary exists on an archival run, so their packet is not renderable here. */
  readonly notRenderable: readonly { readonly unitId: string; readonly reason: string }[];
  /** Gate 1b's plan-side accounting: the one denominator. */
  readonly obligations: PlanObligationAccounting;
  readonly obligationSummary: string;
  /** THE 57B-453 CLOSURE READING. */
  readonly inUnitsObligations: number;
  /** Distinct (obligation, evidence id) pairs the in-unit obligations require, from `workitems.json` directly. */
  readonly evidenceRequired: number;
  /** Pairs whose evidence appears in NO packet of a unit naming a binding topic. The R0 numbers were 179 and 409. */
  readonly evidenceAbsent: number;
  /** Every absent pair, by id. Never capped: a cap on a coverage residue is where the next silent loss hides. */
  readonly absentBindings: readonly AbsentEvidenceBinding[];
  /** Mechanism A: how far the obligation ledger reaches into the frozen evidence set. */
  readonly frozenEvidenceIds: number;
  readonly boundEvidenceIds: number;
  readonly unboundEvidenceIds: number;
  readonly unboundEvidenceByKind: readonly { readonly kind: string; readonly records: number }[];
  /** Open-origin material obligations across the whole plan, by id. wcp reads 0; non-zero is visible. */
  readonly openOriginExemptObligations: readonly string[];
  /** The facets the catalog reports as empty, with the state and reason the appendix packet prints. */
  readonly namedEmptyFacets: readonly { readonly facet: string; readonly state: string; readonly reason: string }[];
  readonly readPaths: readonly string[];
}

/** Recover the v2 request rows from the run manifest, the way prepare records them. */
function requestsFor(manifest: RunManifest): ReportRequestsArtifact {
  return buildReportRequestsArtifact(manifest.documents.map((document: DocumentPlan) => ({
    documentId: document.id,
    kind: document.kind,
    audience: document.audience,
    featureKey: document.kind === "feature" ? featureKeyOf(document) : null,
    detailLevel: manifest.request.detailLevel ?? "standard",
    language: manifest.request.language
  })));
}

/** Project one frozen run directory. Never writes; every failure is a named throw. */
export async function extractUnitPacketReadings(runDir: string): Promise<UnitPacketReadings> {
  const source = await loadTopicCatalogSource(runDir);
  const catalog = buildTopicCatalog(source);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const requests = requestsFor(manifest);
  const proposal = buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE);
  const report = validatePlan({ catalog, requests, proposal, registry: REPORT_POLICY_REGISTRY, budgetTable: PLAN_BUDGET_TABLE });
  const artifacts = buildPlanArtifacts({ catalog, requests, proposal, report });
  const planCatalog = artifacts.planCatalog;

  const evidence = await readEvidenceCatalog(runDir);
  const evidenceById = new Map(evidence.evidence.map((item) => [item.id, item]));
  const topicsById = new Map(catalog.topics.map((topic) => [topic.topicId, topic]));
  const workItems = new Map(source.workItems.map((item) => [item.id, item]));
  const obligations = materialObligationTopics(catalog);
  const reach = evidenceReach(source.knowledge.evidenceIds ?? [], workItems, evidenceById);

  const rendered: UnitPacketReadingRow[] = [];
  const notRenderable: { unitId: string; reason: string }[] = [];
  const packetsByUnit = new Map<string, UnitPacket>();
  const openOriginExempt = new Set<string>();

  for (const unit of planCatalog.units) {
    const grounding = auditUnitGrounding({ unit, obligations, workItems, claims: [] });
    for (const row of grounding.openOriginExempt) openOriginExempt.add(row.workItemId);
    if (unit.kind === "synthesis") {
      notRenderable.push({
        unitId: unit.unitId,
        reason: "a synthesis unit is written from its children's COLLECTED summaries, and this archival run has authored no unit, so there is no summary to render"
      });
      continue;
    }
    const dossier = topicDossier(unit, topicsById, evidenceById);
    const input = {
      planCatalog,
      facets: catalog.facets,
      dag: artifacts.dag,
      requests,
      registry: REPORT_POLICY_REGISTRY,
      unitId: unit.unitId,
      dossier,
      reach,
      byteLimit: unitInputBound(planCatalog, unit),
      // Recorded, not refused: a baseline reading that threw would report nothing at all, and what this projection
      // exists to say is what a real corpus costs. Nothing is dropped either way.
      overBudget: "record-limitation" as const
    };
    const packet = renderUnitPacket(input);
    const again = renderUnitPacket(input);
    packetsByUnit.set(unit.unitId, packet);
    rendered.push({
      unitId: unit.unitId,
      documentId: unit.documentId,
      kind: unit.kind,
      topics: unit.topics.length,
      obligations: obligationCount(unit, topicsById, false),
      materialObligations: obligationCount(unit, topicsById, true),
      reachableMaterial: grounding.reachable.length,
      openOriginExempt: grounding.openOriginExempt.length,
      renderedEvidenceIds: packet.renderedEvidenceIds.length,
      packetBytes: packet.bytes,
      packetByteLimit: packet.byteLimit,
      packetLimitations: packet.limitations,
      packetDigest: unitPacketDigest(packet),
      renderedTwiceIdentical: packet.markdown === again.markdown
    });
  }

  const closure = closureReading(planCatalog.units, obligations, packetsByUnit, await ledgerItems(runDir));
  return {
    version: UNIT_PACKET_READINGS_VERSION,
    runId: catalog.runId,
    knowledgeEpoch: catalog.knowledgeEpoch,
    knowledgeDigest: catalog.knowledgeDigest,
    planCatalogDigest: planCatalogDigest(planCatalog),
    units: planCatalog.units.length,
    unitsByKind: AUTHORING_UNIT_KINDS.map((kind) => ({ kind, units: planCatalog.units.filter((unit) => unit.kind === kind).length })),
    rendered,
    notRenderable,
    obligations: planCatalog.obligationAccounting,
    obligationSummary: summariseObligationAccounting(planCatalog.obligationAccounting),
    ...closure,
    frozenEvidenceIds: reach.frozenEvidenceIds,
    boundEvidenceIds: reach.boundEvidenceIds,
    unboundEvidenceIds: reach.unbound.length,
    unboundEvidenceByKind: censusByKind(reach.unbound),
    openOriginExemptObligations: [...openOriginExempt].sort((a, b) => a.localeCompare(b)),
    namedEmptyFacets: catalog.facets
      .filter((row) => row.outcome.state !== "populated")
      .map((row) => ({ facet: row.facet, state: row.outcome.state, reason: row.outcome.state === "populated" ? "" : row.outcome.reason })),
    readPaths: [...new Set([...source.readPaths, "run.json", "evidence.json"])].sort((a, b) => a.localeCompare(b))
  };
}

async function ledgerItems(runDir: string): Promise<InvestigationPlan["items"]> {
  const plan = await readJson<InvestigationPlan>(join(runDir, "workitems.json"));
  return plan.items;
}

/**
 * The 57B-453 closure reading: every in-unit material obligation's OWN evidence, in a packet that names it.
 *
 * The requirement side is read from `workitems.json` itself, so this cannot be satisfied by the catalog and the
 * packet agreeing with each other: a denominator taken from the code under test agrees with it whatever it does.
 */
function closureReading(
  units: readonly PlanCatalogUnit[],
  obligations: readonly ReturnType<typeof materialObligationTopics>[number][],
  packetsByUnit: ReadonlyMap<string, UnitPacket>,
  items: InvestigationPlan["items"]
): { inUnitsObligations: number; evidenceRequired: number; evidenceAbsent: number; absentBindings: readonly AbsentEvidenceBinding[] } {
  const ledgerById = new Map(items.map((item) => [item.id, item]));
  const absent: AbsentEvidenceBinding[] = [];
  let required = 0;
  let inUnits = 0;
  for (const row of obligations) {
    const naming = units.filter((unit) => unit.topics.some((reference) => row.topicIds.includes(reference.topicId)));
    if (naming.length === 0) continue;
    inUnits += 1;
    const ledgerRow = ledgerById.get(row.workItemId);
    if (!ledgerRow) throw new Error(`material obligation ${JSON.stringify(row.workItemId)} has no row in workitems.json`);
    for (const evidenceId of ledgerRow.evidenceIds) {
      required += 1;
      const carriers = naming.filter((unit) => packetsByUnit.get(unit.unitId)?.renderedEvidenceIds.includes(evidenceId));
      if (carriers.length === 0) {
        absent.push({ unitId: naming.map((unit) => unit.unitId).sort((a, b) => a.localeCompare(b))[0]!, workItemId: row.workItemId, evidenceId });
      }
    }
  }
  return {
    inUnitsObligations: inUnits,
    evidenceRequired: required,
    evidenceAbsent: absent.length,
    absentBindings: absent
  };
}

function obligationCount(unit: PlanCatalogUnit, topicsById: ReadonlyMap<string, { bindings: readonly { material: boolean }[] }>, materialOnly: boolean): number {
  let total = 0;
  for (const reference of unit.topics) {
    const topic = topicsById.get(reference.topicId)!;
    total += materialOnly ? topic.bindings.filter((binding) => binding.material).length : topic.bindings.length;
  }
  return total;
}

function evidenceReach(
  frozenEvidenceIds: readonly string[],
  workItems: ReadonlyMap<string, { evidenceIds: string[] }>,
  evidenceById: ReadonlyMap<string, EvidenceItem>
): RunEvidenceReach {
  const bound = new Set<string>();
  for (const item of workItems.values()) for (const id of item.evidenceIds) bound.add(id);
  const unbound: EvidenceItem[] = [];
  for (const id of [...frozenEvidenceIds].sort((a, b) => a.localeCompare(b))) {
    if (bound.has(id)) continue;
    const item = evidenceById.get(id);
    if (!item) throw new Error(`knowledge.json seals evidence ${JSON.stringify(id)} but evidence.json does not hold it`);
    unbound.push(item);
  }
  return { frozenEvidenceIds: frozenEvidenceIds.length, boundEvidenceIds: bound.size, unbound };
}

function censusByKind(items: readonly EvidenceItem[]): readonly { kind: string; records: number }[] {
  const byKind = new Map<string, number>();
  for (const item of items) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  return [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, records]) => ({ kind, records }));
}

/** The readings' own content identity, for a caller that wants to compare two projections. */
export function unitPacketReadingsDigest(readings: UnitPacketReadings): string {
  return sha256(canonicalJson(readings));
}
