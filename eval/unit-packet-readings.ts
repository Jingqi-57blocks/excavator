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
// R5a adds two readings on top, and both are measured rather than asserted:
//
//  5. `obligationsOwedByMoreThanOneUnit` per document — how many material obligations more than one unit of one
//     document OWES. It is counted from the per-unit audits' own `owed` lists, so it cannot come out zero merely
//     because the ownership derivation says each obligation has one owner. Before ownership it was 847 per wcp
//     document (1,858 owed instances against 847 distinct), and that duplication is what put the four packets of one
//     document at 4,243,714 bytes against a 3,145,728-byte document budget.
//  6. `stubObligations` per unit — the material obligations a unit renders as a stub because another unit owns them.
//     Stubs are uncapped and exhaustive; a stub is not a truncation, so the number is reported next to the bytes.
//
// Zero model calls. Any input it cannot project is a named throw.

import { join } from "node:path";
import type { DocumentPlan, EvidenceItem, InvestigationPlan, RunManifest } from "../src/base/types.ts";
import { readJson, sha256, canonicalJson } from "../src/base/util.ts";
import { featureKeyOf } from "../src/report/authoring-packet.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { buildPlanArtifacts, planCatalogDigest, type PlanCatalogUnit } from "../src/report/plan-artifacts.ts";
import { documentOwnership, materialObligationTopics, summariseObligationAccounting, type ObligationOwnershipIndex, type PlanObligationAccounting } from "../src/report/plan-obligation-conservation.ts";
import { AUTHORING_UNIT_KINDS } from "../src/report/plan-proposal.ts";
import { planThroughBudgetRefinement } from "../src/report/plan-unit-split.ts";
import { loadRunEvidenceReach } from "../src/report/run-evidence-reach.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { buildReportRequestsArtifact, type ReportRequestsArtifact } from "../src/report/report-requests-artifact.ts";
import { buildTopicCatalog } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import { auditUnitGrounding } from "../src/report/unit-grounding-audit.ts";
import { renderUnitPacket, topicDossier, unitInputBound, unitPacketBytes, unitPacketDigest, type UnitPacket } from "../src/report/unit-packet.ts";
import { documentBudgetRow } from "../src/report/plan-budget.ts";

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
  /** Material obligations this unit OWNS, and the ones it renders as a stub because another unit owns them. */
  readonly ownedMaterial: number;
  readonly stubObligations: number;
  /**
   * Obligations of this unit's topics that its `obligationScope` excludes — the other parts of a divided topic.
   *
   * Zero on an undivided plan. Together with `ownedMaterial` and `stubObligations` it accounts for every material
   * obligation the unit reaches, which is the conservation the eval test asserts.
   */
  readonly scopeExcludedObligations: number;
  /** The MATERIAL ones among them. `ownedMaterial + stubObligations + this` is every material obligation reached. */
  readonly scopeExcludedMaterial: number;
  readonly packetBytes: number;
  /**
   * THE SAME-SOURCE TRIPWIRE, recorded per unit: what the plan's budget pre-check measured for this unit.
   *
   * It must equal `packetBytes` exactly, and the extractor throws if it does not — the whole point of R5b is that
   * the pre-check IS the renderer rather than a second estimate beside it. R4b's proxy (canonical topic rows) was
   * out by about 9x on this baseline, and it was out silently because nothing compared the two numbers.
   */
  readonly precheckBytes: number;
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
  /**
   * R5b: per document, the measured bytes of every unit's packet against the document's own total input budget.
   *
   * `renderedBytes` sums the units this projection could render; `measuredBytes` is the plan-side measurement over
   * ALL of them, synthesis units included (bounded by the declared summary allowance). The second is the number
   * acceptance reads, because a synthesis is a packet an author will be handed too.
   */
  readonly documents: readonly {
    readonly documentId: string;
    readonly units: number;
    readonly renderedBytes: number;
    readonly measuredBytes: number;
    readonly totalInputBytes: number;
  }[];
  /** Units over their own per-unit bound after the budget refinement. Zero is R5b's acceptance condition. */
  readonly overBudgetUnits: number;
  /** Every over-budget unit the refinement divided, with the ladder rung it was divided at. */
  readonly divisions: readonly { readonly unitId: string; readonly level: string; readonly measuredBytes: number; readonly partUnitIds: readonly string[] }[];
  /** Measurement passes the refinement took. 1 means the proposal already fitted and nothing was divided. */
  readonly refinementPasses: number;
  /** Gate 1b's plan-side accounting: the one denominator. */
  readonly obligations: PlanObligationAccounting;
  readonly obligationSummary: string;
  /** THE 57B-453 CLOSURE READING. */
  readonly inUnitsObligations: number;
  /**
   * Distinct (obligation, evidence id) pairs the in-unit obligations require, from `workitems.json` directly.
   *
   * Kept at run granularity so it stays comparable across R4b and R5a. It is NOT the number an author answers for:
   * a document that reaches an obligation has to ground it, so the author-facing denominator is the triple count
   * below — one per (owner unit, obligation, evidence id).
   */
  readonly evidenceRequired: number;
  /** (owner unit, obligation, evidence id) triples: what the owning units of every document must carry between them. */
  readonly ownerEvidenceRequired: number;
  /** Triples whose evidence is absent from the OWNER unit's packet. The R0 numbers were 179 and 409 of 310/564. */
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
  /** R5a's ownership reading, one row per document. `owedByMoreThanOneUnit` is the acceptance number. */
  readonly ownership: readonly {
    readonly documentId: string;
    readonly reachedObligations: number;
    readonly owedByUnit: readonly { readonly unitId: string; readonly owed: number }[];
    readonly owedByMoreThanOneUnit: number;
    readonly unownedObligationIds: readonly string[];
  }[];
  /** The sum of the row above across documents. Zero is the point; it was 3,388 on wcp before ownership. */
  readonly obligationsOwedByMoreThanOneUnit: number;
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
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const source = await loadTopicCatalogSource(runDir, manifest);
  const catalog = buildTopicCatalog(source);
  const requests = requestsFor(manifest);
  const evidence = await loadRunEvidenceReach(runDir, source);
  const evidenceById = evidence.evidenceById;
  // The same door the plan stage uses: validate, divide whatever is over budget, validate the divided plan. The
  // packets below are therefore rendered from the plan an operator would actually get.
  const planned = planThroughBudgetRefinement({
    catalog,
    requests,
    proposal: buildFixturePlan(catalog, requests, PLAN_BUDGET_TABLE),
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    evidence: evidenceById,
    reach: evidence.reach
  });
  if (planned.state === "rejected") {
    throw new Error(`the fixture plan for ${runDir} cannot be recorded: ${planned.problems.join("; ")}`);
  }
  const report = planned.report;
  const artifacts = buildPlanArtifacts({
    catalog,
    requests,
    proposal: planned.proposal,
    budgetTable: PLAN_BUDGET_TABLE,
    verdict: report.overall
  });
  const planCatalog = artifacts.planCatalog;

  const topicsById = new Map(catalog.topics.map((topic) => [topic.topicId, topic]));
  const workItems = new Map(source.workItems.map((item) => [item.id, item]));
  const obligations = materialObligationTopics(catalog);
  const materialIds = new Set(obligations.map((row) => row.workItemId));
  const reach = evidence.reach;

  const rendered: UnitPacketReadingRow[] = [];
  const notRenderable: { unitId: string; reason: string }[] = [];
  const packetsByUnit = new Map<string, UnitPacket>();
  const openOriginExempt = new Set<string>();
  const ownedByUnit = new Map<string, Map<string, string[]>>();

  for (const unit of planCatalog.units) {
    const ownership = documentOwnership(report.ownership, unit.documentId);
    const grounding = auditUnitGrounding({ unit, obligations, ownership, workItems, claims: [] });
    for (const row of grounding.openOriginExempt) openOriginExempt.add(row.workItemId);
    // Who OWES what, taken from the audit rather than from the ownership derivation: a reading read off the
    // derivation would agree with it whatever the audit did.
    let owedIn = ownedByUnit.get(unit.documentId);
    if (!owedIn) ownedByUnit.set(unit.documentId, owedIn = new Map());
    for (const workItemId of grounding.owed) {
      const list = owedIn.get(workItemId);
      if (list) list.push(unit.unitId);
      else owedIn.set(workItemId, [unit.unitId]);
    }
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
      ownership,
      reach,
      byteLimit: unitInputBound(planCatalog, unit),
      // Recorded, not refused: a baseline reading that threw would report nothing at all, and what this projection
      // exists to say is what a real corpus costs. Nothing is dropped either way.
      overBudget: "record-limitation" as const
    };
    const packet = renderUnitPacket(input);
    const again = renderUnitPacket(input);
    // The tripwire, asserted where the two numbers are both in hand rather than only recorded: the plan's budget
    // pre-check and the packet an author reads are one composition, so a difference is a bug and not a reading.
    const precheckBytes = unitPacketBytes(input);
    if (precheckBytes !== packet.bytes) {
      throw new Error(`unit ${JSON.stringify(unit.unitId)}: the plan's budget pre-check measured ${precheckBytes} bytes and the rendered packet is ${packet.bytes}; the pre-check must BE the renderer, not an estimate beside it`);
    }
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
      ownedMaterial: grounding.owed.length + grounding.openOriginExempt.length,
      stubObligations: packet.stubObligationIds.length,
      scopeExcludedObligations: packet.scopeExcludedObligationIds.length,
      scopeExcludedMaterial: packet.scopeExcludedObligationIds.filter((workItemId) => materialIds.has(workItemId)).length,
      renderedEvidenceIds: packet.renderedEvidenceIds.length,
      packetBytes: packet.bytes,
      precheckBytes,
      packetByteLimit: packet.byteLimit,
      packetLimitations: packet.limitations,
      packetDigest: unitPacketDigest(packet),
      renderedTwiceIdentical: packet.markdown === again.markdown
    });
  }

  const closure = closureReading(planCatalog.units, obligations, packetsByUnit, report.ownership, await ledgerItems(runDir));
  const ownership = report.ownership.documents.map((document) => {
    const owed = ownedByUnit.get(document.documentId) ?? new Map<string, string[]>();
    const perUnit = new Map<string, number>();
    for (const unitIds of owed.values()) for (const unitId of unitIds) perUnit.set(unitId, (perUnit.get(unitId) ?? 0) + 1);
    return {
      documentId: document.documentId,
      reachedObligations: document.reachedObligations,
      owedByUnit: document.ownedByUnit.map((row) => ({ unitId: row.unitId, owed: perUnit.get(row.unitId) ?? 0 })),
      owedByMoreThanOneUnit: [...owed.values()].filter((unitIds) => unitIds.length > 1).length,
      unownedObligationIds: document.unowned.map((row) => row.workItemId)
    };
  });
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
    documents: planCatalog.documents.map((document) => ({
      documentId: document.documentId,
      units: document.units,
      renderedBytes: rendered.filter((row) => row.documentId === document.documentId).reduce((total, row) => total + row.packetBytes, 0),
      measuredBytes: report.packets.state === "measured"
        ? report.packets.measurement.documents.find((row) => row.documentId === document.documentId)!.bytes
        : 0,
      totalInputBytes: documentBudgetRow(planCatalog.budget, document.documentId).totalInputBytes
    })),
    overBudgetUnits: report.packets.state === "measured" ? report.packets.measurement.overBudgetUnitIds.length : -1,
    divisions: planned.divisions.map((row) => ({ unitId: row.unitId, level: row.level, measuredBytes: row.measuredBytes, partUnitIds: row.partUnitIds })),
    refinementPasses: planned.iterations,
    obligations: planCatalog.obligationAccounting,
    obligationSummary: summariseObligationAccounting(planCatalog.obligationAccounting),
    ...closure,
    frozenEvidenceIds: reach.frozenEvidenceIds,
    boundEvidenceIds: reach.boundEvidenceIds,
    unboundEvidenceIds: reach.unbound.length,
    unboundEvidenceByKind: censusByKind(reach.unbound),
    openOriginExemptObligations: [...openOriginExempt].sort((a, b) => a.localeCompare(b)),
    ownership,
    obligationsOwedByMoreThanOneUnit: ownership.reduce((total, row) => total + row.owedByMoreThanOneUnit, 0),
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
 * The 57B-453 closure reading: every in-unit material obligation's OWN evidence, in the packet of the unit that
 * OWNS it.
 *
 * The requirement side is read from `workitems.json` itself, so this cannot be satisfied by the catalog and the
 * packet agreeing with each other: a denominator taken from the code under test agrees with it whatever it does.
 *
 * R5a NARROWED THE CARRIER SET FROM "any unit naming a binding topic" TO "the owner", which is a STRICTER reading,
 * not a looser one: before, an obligation counted as answerable if any of the three units that could reach it
 * happened to render the evidence; now the one unit that must ground it has to be the one carrying the bytes. R5b
 * keeps that reading word for word — a divided topic moves WHICH unit owns an obligation, never whether one does —
 * so an obligation with no owner in a document it reaches is still a named throw.
 */
function closureReading(
  units: readonly PlanCatalogUnit[],
  obligations: readonly ReturnType<typeof materialObligationTopics>[number][],
  packetsByUnit: ReadonlyMap<string, UnitPacket>,
  ownership: ObligationOwnershipIndex,
  items: InvestigationPlan["items"]
): { inUnitsObligations: number; evidenceRequired: number; ownerEvidenceRequired: number; evidenceAbsent: number; absentBindings: readonly AbsentEvidenceBinding[] } {
  const ledgerById = new Map(items.map((item) => [item.id, item]));
  const absent: AbsentEvidenceBinding[] = [];
  let required = 0;
  let ownerRequired = 0;
  let inUnits = 0;
  for (const row of obligations) {
    const naming = units.filter((unit) => unit.topics.some((reference) => row.topicIds.includes(reference.topicId)));
    if (naming.length === 0) continue;
    inUnits += 1;
    const ledgerRow = ledgerById.get(row.workItemId);
    if (!ledgerRow) throw new Error(`material obligation ${JSON.stringify(row.workItemId)} has no row in workitems.json`);
    const owners = [...new Set(naming.map((unit) => unit.documentId))].sort((a, b) => a.localeCompare(b)).map((documentId) => {
      const owner = documentOwnership(ownership, documentId).ownerByObligation.get(row.workItemId);
      if (!owner) throw new Error(`material obligation ${JSON.stringify(row.workItemId)} is reached by document ${JSON.stringify(documentId)} and owned by no unit of it`);
      return owner.ownerUnitId;
    });
    for (const evidenceId of ledgerRow.evidenceIds) {
      required += 1;
      for (const ownerUnitId of owners) {
        ownerRequired += 1;
        if (packetsByUnit.get(ownerUnitId)?.renderedEvidenceIds.includes(evidenceId)) continue;
        absent.push({ unitId: ownerUnitId, workItemId: row.workItemId, evidenceId });
      }
    }
  }
  return {
    inUnitsObligations: inUnits,
    evidenceRequired: required,
    ownerEvidenceRequired: ownerRequired,
    evidenceAbsent: absent.length,
    absentBindings: absent
  };
}

/** Obligations bound to a unit's topics, scope or not: the topic-level census, unchanged since R4b. */
function obligationCount(unit: PlanCatalogUnit, topicsById: ReadonlyMap<string, { bindings: readonly { material: boolean }[] }>, materialOnly: boolean): number {
  let total = 0;
  for (const reference of unit.topics) {
    const topic = topicsById.get(reference.topicId)!;
    total += materialOnly ? topic.bindings.filter((binding) => binding.material).length : topic.bindings.length;
  }
  return total;
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
