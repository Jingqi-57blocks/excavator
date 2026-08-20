/**
 * The unit packet: the bounded, deterministic, model-facing view ONE authoring unit is written from.
 *
 * IT CARRIES THE BINDING, AND THAT IS WHY IT EXISTS. 57B-453 measured a real document written from the old
 * per-document packet: 60.1% of one document's material obligations (74.5% of another's) needed evidence the packet
 * never rendered, and even for the evidence it DID render it never said which work item that evidence grounded. The
 * author's only inferable rule was "the window whose line range covers the function", which was wrong for 5 of 18
 * obligations and impossible for 2. So here every obligation gets ITS OWN ROW — work item id, dimension, status,
 * materiality, and its evidence and trace ids copied verbatim from the ledger through the catalog — and every
 * evidence record says which obligations it grounds. Nothing has to be inferred from a line range.
 *
 * NOTHING IS DROPPED, EVER. The bound is declared and checked over the WHOLE rendering; over-budget has exactly two
 * forms, both required to be chosen at the call site: `refuse` names it at the entry, `record-limitation` returns
 * the whole packet with the overrun in `limitations` and in the header. There is no truncation, no cap on any list
 * and no per-record clipping — 57B-453's mechanism B is what clipping costs: the old packet cut rows and told the
 * author the rest "remain in the frozen catalog", while the prompt forbade loading `evidence.json` and no command
 * could read one. A notice pointing at a path that does not exist is worse than the bytes it saved.
 *
 * THE INPUT BUDGET IS THE PLAN'S, NOT A NEW NUMBER. `PlanBudget.perUnitInputBytes` is the only authority for how
 * many bytes a unit may be asked to read, so the caller derives the bound from it. There is NO output budget in
 * this slice: no artifact declares one (`PlanBudget` carries the two input numbers only), so the packet says so in
 * as many words and defers it to R5 rather than inventing one or leaving the reader to assume.
 *
 * A SYNTHESIS HAS NOWHERE TO PUT A TOPIC DOSSIER. `UnitDossier` is a union: the `child-summaries` arm has no
 * `topics` field and no evidence map at all, so "a synthesis reads only its children's summaries" is a type fact
 * rather than a rule someone has to remember. The kind and the arm are checked against each other at the entry.
 *
 * ONE OWNER RENDERS AN OBLIGATION IN FULL; EVERY OTHER UNIT GETS A STUB, AND A STUB IS NOT A TRUNCATION (R5a).
 * R4b let every unit that could reach an obligation render it whole, and measured on wcp that meant each document
 * carried the same 847 obligations three times: 4,243,714 bytes of packets against a 3,145,728-byte document
 * budget. Splitting cannot change a sum; only deduplication can. So the OWNER unit (`plan-obligation-conservation.ts`
 * derives it per document) renders the obligation row plus its evidence in full, and every other unit of that
 * document renders a stub line — work item id, dimension, determination, materiality and THE OWNER UNIT — with no
 * evidence body. The two are different statements: "which obligations exist and whose they are" is not "here are
 * their bytes". Stubs are uncapped and exhaustive, exactly like every other list here; nothing is dropped, and the
 * author can always follow a stub to the unit that owes it. Non-material obligations have no owner and are rendered
 * in full by every unit that names their topic — ownership is a MATERIAL-obligation concept, and inventing one for
 * a row no gate grounds would be a rule with no audit behind it.
 *
 * EVIDENCE NO OBLIGATION BINDS IS COUNTED IN EVERY PACKET AND ENUMERATED IN THE APPENDIX. That is 57B-453's
 * mechanism A: the binding path is obligation → evidence, so a record no work item references cannot reach any unit
 * through it — and on the wcp baseline that is 931 of 1,884 frozen records, including the manifest, README, scope
 * and provider rows a coverage section is required to report. The count is in every header with the reason, and the
 * deterministic tail (the appendix, gate 10's path) lists every one of them by id with its kind, title and
 * location, uncapped. What would bring one's CONTENT into a unit is an obligation binding it; that is upstream of
 * this packet, and saying so is not the same as pointing at a path that does not exist.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { EvidenceItem } from "../base/types.ts";
import { canonicalJson, sha256 } from "../base/util.ts";
import { GROUNDING_RULES } from "./unit-grounding-audit.ts";
import type { PlanBudget } from "./plan-budget.ts";
import type { PlanCatalogArtifact, PlanCatalogUnit, PlanDagArtifact } from "./plan-artifacts.ts";
import { planCatalogDigest } from "./plan-artifacts.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import { intentPolicyFor, lensPolicyFor, type ReportPolicyRegistry } from "./report-policy-registry.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";
import { OWNERSHIP_FACET_PRIORITY, type DocumentObligationOwnership, type ObligationOwnership } from "./plan-obligation-conservation.ts";
import type { PacketOverBudgetMode } from "./planner-packet.ts";
import { TOPIC_FACETS, type TopicCandidate, type TopicObligationBinding } from "./topic-candidate.ts";
import type { FacetOutcome, TopicFacetCensus } from "./topic-catalog.ts";
import type { UnitSummary } from "./unit-output.ts";
import { compareUnitIds } from "./unit-paths.ts";

export const UNIT_PACKET_VERSION = "unit-packet-v2";

/**
 * What one unit writes from. A union, so the synthesis arm has no place for a topic or an evidence record.
 *
 * `evidence` is keyed by id and must hold every id the bindings name; a missing one is a named refusal at the entry
 * rather than a row that renders as "(not present)". The frozen epoch already guarantees the ids exist, so a gap
 * means the catalog and the evidence ledger disagree — a fact worth stopping for.
 */
export type UnitDossier =
  | {
      readonly source: "topics";
      /** The unit's topics, resolved from the catalog, in the plan's own order. */
      readonly topics: readonly TopicCandidate[];
      readonly evidence: ReadonlyMap<string, EvidenceItem>;
    }
  | {
      readonly source: "child-summaries";
      /** The collected children's summaries, ascending by unit id. */
      readonly children: readonly UnitSummary[];
    };

/**
 * How far the obligation ledger reaches into this run's frozen evidence — the mechanism-A reading.
 *
 * `unbound` is every frozen evidence record NO work item binds, whole records so the appendix can name them with
 * their kind, title and location. Never capped: a cap on a coverage residue is where the next silent loss hides.
 */
export interface RunEvidenceReach {
  readonly frozenEvidenceIds: number;
  readonly boundEvidenceIds: number;
  readonly unbound: readonly EvidenceItem[];
}

export interface UnitPacketInput {
  readonly planCatalog: PlanCatalogArtifact;
  /**
   * The catalog's facet census, one row per facet, populated or named-empty with the ledger's own reason.
   *
   * Required, and rendered by the deterministic tail: gate 10 says the run's own residual must reach a reader, and
   * "this project has no data-model topics" and "no run-scoped schema ledger exists" are two different sentences.
   * `ledger-absent` and `ledger-empty` therefore stay distinguishable all the way into the packet an author reads —
   * on the cebreo baseline the appendix is the only place either sentence could ever appear.
   */
  readonly facets: readonly TopicFacetCensus[];
  readonly dag: PlanDagArtifact;
  readonly requests: ReportRequestsArtifact;
  readonly registry: ReportPolicyRegistry;
  readonly unitId: string;
  readonly dossier: UnitDossier;
  /**
   * R5a's ownership for THIS unit's document, from the one derivation that also feeds the grounding audit.
   *
   * Required, and checked against the unit's own document at the entry. There is no default: an empty ownership row
   * would make every material obligation read as owned elsewhere, so a whole document would render as stubs and the
   * author would be handed no evidence at all — silently.
   */
  readonly ownership: DocumentObligationOwnership;
  readonly reach: RunEvidenceReach;
  /** From `PlanBudget.perUnitInputBytes` for this unit's document. Required: there is no second authority. */
  readonly byteLimit: number;
  readonly overBudget: PacketOverBudgetMode;
}

export interface UnitPacket {
  readonly version: typeof UNIT_PACKET_VERSION;
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  readonly bytes: number;
  readonly byteLimit: number;
  /** Empty unless something was recorded as a limitation. Never a reason a row is missing. */
  readonly limitations: readonly string[];
  /**
   * Every evidence id rendered in full below, ascending. The 57B-453 answerability set.
   *
   * Owner-scoped since R5a: an obligation owned by another unit contributes no evidence here, because this packet
   * does not hand over its bytes. The 453 closure reading follows the owner for the same reason.
   */
  readonly renderedEvidenceIds: readonly string[];
  /** Every obligation rendered IN FULL below, ascending. A stub is in `stubObligationIds`, not here. */
  readonly obligationIds: readonly string[];
  /** Every material obligation rendered as a stub because another unit owns it, ascending. Uncapped. */
  readonly stubObligationIds: readonly string[];
  readonly markdown: string;
}

/**
 * The sentence that says an output budget does not exist yet, printed in every packet.
 *
 * Stated rather than omitted on purpose: a header that lists an input budget and says nothing about output reads as
 * "output is unbounded", and the honest fact is narrower — no artifact in this run declares one.
 */
export const OUTPUT_BUDGET_DEFERRAL =
  "output budget: NONE DECLARED — no artifact in this run declares one (`PlanBudget` carries `perUnitInputBytes` and `totalInputBytes` only), so this packet states no output bound. Deferred to the R5 budget system rather than omitted or invented.";

/** Render one unit's packet. Deterministic: same plan, same catalog rows, same evidence, same bytes. */
export function renderUnitPacket(input: UnitPacketInput): UnitPacket {
  const unit = requireUnit(input);
  assertOwnershipIsThisDocument(unit, input.ownership);
  assertDossierMatchesUnit(unit, input.dossier);
  const body = renderBody(unit, input);
  const withoutLimitation = `${renderHeader(unit, input, body, [])}\n${body}`;
  const bytes = Buffer.byteLength(withoutLimitation, "utf8");
  const rendered = renderedIds(unit, input.dossier, input.ownership);
  if (bytes <= input.byteLimit) {
    return { ...rendered, version: UNIT_PACKET_VERSION, unitId: unit.unitId, documentId: unit.documentId, kind: unit.kind, bytes, byteLimit: input.byteLimit, limitations: [], markdown: withoutLimitation };
  }
  const overrun = overrunSentence(unit, input, bytes, rendered);
  switch (input.overBudget) {
    case "refuse":
      throw new Error(overrun);
    case "record-limitation": {
      const markdown = `${renderHeader(unit, input, body, [overrun])}\n${body}`;
      return {
        ...rendered,
        version: UNIT_PACKET_VERSION,
        unitId: unit.unitId,
        documentId: unit.documentId,
        kind: unit.kind,
        bytes: Buffer.byteLength(markdown, "utf8"),
        byteLimit: input.byteLimit,
        limitations: [overrun],
        markdown
      };
    }
  }
  return assertNever(input.overBudget, "unit packet over-budget mode");
}

/** Ownership is per document; rendering a unit against another document's row is a bug in the caller, and named. */
function assertOwnershipIsThisDocument(unit: PlanCatalogUnit, ownership: DocumentObligationOwnership): void {
  if (ownership.documentId !== unit.documentId) {
    throw new Error(`Unit ${JSON.stringify(unit.unitId)} is written into document ${JSON.stringify(unit.documentId)} but was handed the ownership of document ${JSON.stringify(ownership.documentId)}; ownership is derived per document, so these decide two different sets of owners`);
  }
}

/**
 * Whether this unit renders one binding IN FULL, or as a stub because another unit owns it.
 *
 * Non-material bindings are always full: ownership exists to stop two units grounding one obligation, and a
 * non-material row is grounded by nobody. A material binding with no owner row is FATAL rather than either default
 * — "full" would restore the duplication for exactly the rows a plan got wrong, and "stub" would point the author
 * at an owner that does not exist. Validation names that plan and `buildPlanArtifacts` refuses to record it.
 */
function ownedByThisUnit(binding: TopicObligationBinding, unit: PlanCatalogUnit, ownership: DocumentObligationOwnership): boolean {
  if (!binding.material) return true;
  const owner = ownership.ownerByObligation.get(binding.workItemId);
  if (!owner) {
    throw new Error(`Material obligation ${JSON.stringify(binding.workItemId)} is bound to a topic of unit ${JSON.stringify(unit.unitId)}, but no unit of document ${JSON.stringify(unit.documentId)} owns it; a packet cannot say whose obligation it is`);
  }
  return owner.ownerUnitId === unit.unitId;
}

/** The owner row of one material obligation this unit does not own. Fatal on a miss, for the reason above. */
function ownerOf(binding: TopicObligationBinding, unit: PlanCatalogUnit, ownership: DocumentObligationOwnership): ObligationOwnership {
  const owner = ownership.ownerByObligation.get(binding.workItemId);
  if (!owner) {
    throw new Error(`Material obligation ${JSON.stringify(binding.workItemId)} is bound to a topic of unit ${JSON.stringify(unit.unitId)}, but no unit of document ${JSON.stringify(unit.documentId)} owns it; a packet cannot say whose obligation it is`);
  }
  return owner;
}

/**
 * How many obligations THIS unit owns, from the ownership row that must exist for it.
 *
 * Fatal on a miss rather than printed as a zero: "this unit owns 0" is a sentence an author would act on, and a
 * missing row means the ownership handed in was not derived over this unit at all.
 */
function ownedCountOf(unit: PlanCatalogUnit, ownership: DocumentObligationOwnership): number {
  const row = ownership.ownedByUnit.find((entry) => entry.unitId === unit.unitId);
  if (!row) {
    throw new Error(`The ownership of document ${JSON.stringify(unit.documentId)} has no row for unit ${JSON.stringify(unit.unitId)}; it holds ${ownership.ownedByUnit.length} unit(s): ${ownership.ownedByUnit.map((entry) => entry.unitId).join(", ") || "none"}`);
  }
  return row.owned;
}

/** The packet's content identity, for a caller that records which bytes an author was handed. */
export function unitPacketDigest(packet: UnitPacket): string {
  return sha256(canonicalJson({ version: packet.version, unitId: packet.unitId, byteLimit: packet.byteLimit, limitations: packet.limitations, markdown: packet.markdown }));
}

/**
 * Whether this kind of unit enumerates the run's unbound evidence.
 *
 * The appendix is the deterministic tail — coverage, unknowns, glossary — and gate 10 requires the run's residual to
 * reach a reader through it. Exhaustive with no `default`: a fifth kind has to say whether the residue is its job.
 */
export function enumeratesUnboundEvidence(kind: AuthoringUnitKind): boolean {
  switch (kind) {
    case "appendix":
      return true;
    case "leaf":
    case "bridge":
    case "synthesis":
      return false;
  }
  return assertNever(kind, "authoring unit kind");
}

function requireUnit(input: UnitPacketInput): PlanCatalogUnit {
  const unit = input.planCatalog.units.find((row) => row.unitId === input.unitId);
  if (!unit) {
    throw new Error(`Unknown authoring unit ${JSON.stringify(input.unitId)}; this run's recorded plan holds ${input.planCatalog.units.length} unit(s): ${input.planCatalog.units.map((row) => row.unitId).join(", ")}`);
  }
  return unit;
}

/**
 * The dossier must be the one this unit's kind takes, over exactly the topics the plan gave it, at exactly the
 * digests the plan recorded.
 *
 * THE DIGEST CHECK IS THE POINT OF THE REFERENCE. The plan carries `{topicId, topicDigest}` instead of a flattened
 * id bag so that a topic whose content moved can be caught here — a packet rendered from a topic the plan never saw
 * would be an author writing against knowledge the plan did not validate. Named, both digests printed.
 */
function assertDossierMatchesUnit(unit: PlanCatalogUnit, dossier: UnitDossier): void {
  switch (dossier.source) {
    case "child-summaries": {
      if (unit.kind !== "synthesis") {
        throw new Error(`Unit ${JSON.stringify(unit.unitId)} is a ${unit.kind}, so it is written from its topics, not from child summaries`);
      }
      const named = [...unit.childUnitIds].sort(compareUnitIds);
      const supplied = dossier.children.map((child) => child.unitId);
      if (canonicalJson(named) !== canonicalJson(supplied)) {
        throw new Error(`Synthesis unit ${JSON.stringify(unit.unitId)} writes from children [${named.join(", ")}] but was handed summaries for [${supplied.join(", ")}]`);
      }
      return;
    }
    case "topics": {
      if (unit.kind === "synthesis") {
        throw new Error(`Synthesis unit ${JSON.stringify(unit.unitId)} may not be handed a topic dossier; it writes from its children's summaries only`);
      }
      if (dossier.topics.length !== unit.topics.length) {
        throw new Error(`Unit ${JSON.stringify(unit.unitId)} names ${unit.topics.length} topic(s) but was handed ${dossier.topics.length}`);
      }
      for (const [index, reference] of unit.topics.entries()) {
        const topic = dossier.topics[index]!;
        if (topic.topicId !== reference.topicId) {
          throw new Error(`Unit ${JSON.stringify(unit.unitId)} names topic ${JSON.stringify(reference.topicId)} at position ${index} but was handed ${JSON.stringify(topic.topicId)}`);
        }
        if (topic.digest !== reference.topicDigest) {
          throw new Error(`Topic ${JSON.stringify(topic.topicId)} digests to ${topic.digest} but the recorded plan references ${reference.topicDigest}; the topic moved after the plan was validated, so unit ${JSON.stringify(unit.unitId)} cannot be rendered against it`);
        }
      }
      for (const topic of dossier.topics) {
        for (const binding of topic.bindings) {
          for (const evidenceId of binding.evidenceIds) {
            if (!dossier.evidence.has(evidenceId)) {
              throw new Error(`Obligation ${JSON.stringify(binding.workItemId)} of topic ${JSON.stringify(topic.topicId)} binds evidence ${JSON.stringify(evidenceId)}, which was not supplied to unit ${JSON.stringify(unit.unitId)}'s packet; a binding whose evidence cannot be rendered is the 57B-453 failure this packet exists to close`);
            }
          }
        }
      }
      return;
    }
  }
  return assertNever(dossier, "unit dossier source");
}

/**
 * Every id this packet renders. Ascending, de-duplicated — what a reading compares against `workitems.json`.
 *
 * OWNER-SCOPED SINCE R5a, and the stubs are counted separately rather than folded in. The appendix's unbound census
 * is deliberately NOT counted here either: both are enumerated by id and metadata, not rendered in full, so
 * counting them would overstate what an author was handed. Three lists, three statements.
 */
function renderedIds(
  unit: PlanCatalogUnit,
  dossier: UnitDossier,
  ownership: DocumentObligationOwnership
): { renderedEvidenceIds: readonly string[]; obligationIds: readonly string[]; stubObligationIds: readonly string[] } {
  switch (dossier.source) {
    case "child-summaries":
      return { renderedEvidenceIds: [], obligationIds: [], stubObligationIds: [] };
    case "topics": {
      const evidence = new Set<string>();
      const obligations = new Set<string>();
      const stubs = new Set<string>();
      for (const topic of dossier.topics) {
        for (const binding of topic.bindings) {
          if (!ownedByThisUnit(binding, unit, ownership)) {
            stubs.add(binding.workItemId);
            continue;
          }
          obligations.add(binding.workItemId);
          for (const id of binding.evidenceIds) evidence.add(id);
        }
      }
      const ascending = (a: string, b: string): number => a.localeCompare(b);
      return {
        renderedEvidenceIds: [...evidence].sort(ascending),
        obligationIds: [...obligations].sort(ascending),
        stubObligationIds: [...stubs].sort(ascending)
      };
    }
  }
  return assertNever(dossier, "unit dossier source");
}

function overrunSentence(unit: PlanCatalogUnit, input: UnitPacketInput, bytes: number, rendered: { renderedEvidenceIds: readonly string[]; obligationIds: readonly string[]; stubObligationIds: readonly string[] }): string {
  const topics = unit.topics.map((topic) => topic.topicId).join(", ") || "(none)";
  return `The packet for unit ${JSON.stringify(unit.unitId)} renders to ${bytes} bytes, over the declared bound of ${input.byteLimit} (${bytes - input.byteLimit} bytes over). NOTHING has been dropped or shortened: all ${unit.topics.length} topic(s), ${rendered.obligationIds.length} obligation row(s) rendered in full, ${rendered.stubObligationIds.length} stub row(s) for obligations another unit owns and ${rendered.renderedEvidenceIds.length} evidence record(s) are present. The offending unit's topics are: ${topics}. Give this unit fewer topics, or raise the bound deliberately — semantic splitting by budget is the R5b slice, and truncation is not an option here.`;
}

function budgetRow(budget: PlanBudget, documentId: string): { perUnitInputBytes: number; totalInputBytes: number; detailBudget: string } {
  const row = budget.documents.find((entry) => entry.documentId === documentId);
  if (!row) throw new Error(`The recorded plan budget has no row for document ${JSON.stringify(documentId)}; a unit cannot be measured against a budget its document does not have`);
  return row;
}

/**
 * The declared input bound for one unit: the plan's own `perUnitInputBytes` for that unit's document.
 *
 * The ONE authority, so every caller — the CLI, the loader, a baseline projection — measures against the same
 * number instead of picking one. There is deliberately no fallback: a plan with no budget row for a document is a
 * named failure, not a unit measured against a default nobody chose.
 */
export function unitInputBound(planCatalog: PlanCatalogArtifact, unit: PlanCatalogUnit): number {
  return budgetRow(planCatalog.budget, unit.documentId).perUnitInputBytes;
}

/**
 * The topic dossier of one unit, assembled from the catalog rows and the evidence ledger.
 *
 * Pure, and shared by every caller: the run loader, and the baseline projection that cannot use the loader because
 * an archival run has no `plan/` on disk and may not be written to. A binding whose evidence the ledger does not
 * hold is a named failure here rather than a hole discovered at render time.
 */
export function topicDossier(
  unit: PlanCatalogUnit,
  topicsById: ReadonlyMap<string, TopicCandidate>,
  evidenceById: ReadonlyMap<string, EvidenceItem>
): UnitDossier {
  const topics = unit.topics.map((reference) => {
    const topic = topicsById.get(reference.topicId);
    if (!topic) throw new Error(`Unit ${JSON.stringify(unit.unitId)} names topic ${JSON.stringify(reference.topicId)}, which this run's topic catalog does not hold`);
    return topic;
  });
  const evidence = new Map<string, EvidenceItem>();
  for (const topic of topics) {
    for (const binding of topic.bindings) {
      for (const id of binding.evidenceIds) {
        const item = evidenceById.get(id);
        if (!item) {
          throw new Error(`Obligation ${JSON.stringify(binding.workItemId)} binds evidence ${JSON.stringify(id)}, which this run's evidence ledger does not hold; unit ${JSON.stringify(unit.unitId)} cannot be given a packet whose bindings it cannot render`);
        }
        evidence.set(id, item);
      }
    }
  }
  return { source: "topics", topics, evidence };
}

function renderHeader(unit: PlanCatalogUnit, input: UnitPacketInput, body: string, limitations: readonly string[]): string {
  const { planCatalog, requests, registry, dag, reach } = input;
  const record = requests.requests.find((entry) => entry.documentId === unit.documentId);
  if (!record) throw new Error(`No recorded request for document ${JSON.stringify(unit.documentId)}; a unit packet is rendered under the request that asked for its document`);
  const lens = lensPolicyFor(record.request.audience, registry);
  const intent = intentPolicyFor(record.request.intent, registry);
  const budget = budgetRow(planCatalog.budget, unit.documentId);
  const parents = dag.edges.filter((edge) => edge.childUnitId === unit.unitId).map((edge) => edge.parentUnitId).sort(compareUnitIds);
  const appendices = planCatalog.units
    .filter((row) => row.documentId === unit.documentId && enumeratesUnboundEvidence(row.kind))
    .map((row) => row.unitId)
    .sort(compareUnitIds);
  const lines = [
    `# Unit packet (${UNIT_PACKET_VERSION})`,
    "",
    "This is a VIEW of artifacts already on disk. Every id below is addressable in this run's `plan/topics.json`,",
    "`plan/catalog.json` and frozen evidence ledger; nothing here is a fact this packet invented. Write ONLY this",
    "unit, from ONLY what is below.",
    "",
    `- unit: ${unit.unitId}`,
    `- kind: ${unit.kind}; title: ${unit.title}`,
    `- document: ${unit.documentId}`,
    `- run: ${planCatalog.runId}`,
    `- knowledge epoch: ${planCatalog.knowledgeEpoch} (digest ${planCatalog.knowledgeDigest})`,
    `- topics catalog digest: ${planCatalog.topicsDigest}`,
    `- plan catalog digest: ${planCatalogDigest(planCatalog)}`,
    `- recorded requests digest: ${planCatalog.requestsDigest}`,
    `- policy registry: ${registry.version}; proposal schema: ${planCatalog.proposalVersion}`,
    `- audience: ${record.request.audience} — lens ${lens.id}@${lens.version} (digest ${lens.digest})`,
    `- intent: ${record.request.intent} — intent policy ${intent.id}@${intent.version} (digest ${intent.digest})`,
    `- language: ${record.request.language}; detail budget: ${record.request.detailBudget}`,
    `- reader concerns: ${lens.content.concerns.join("; ")}`,
    `- terminology depth: ${lens.content.terminologyDepth}; identifiers: ${lens.content.identifiers}`,
    `- document task: ${intent.content.task}`,
    `- reading mode: ${intent.content.reading}; acceptance checklist: ${intent.content.acceptanceChecklist}`,
    `- parent unit(s): ${parents.join(", ") || "(none — this is a document root)"}`,
    `- child unit(s): ${[...unit.childUnitIds].sort(compareUnitIds).join(", ") || "(none)"}`,
    `- input budget (plan, per unit for ${unit.documentId}): ${budget.perUnitInputBytes} bytes; document total ${budget.totalInputBytes} bytes`,
    `- ${OUTPUT_BUDGET_DEFERRAL}`,
    `- packet byte bound: ${input.byteLimit}; body bytes: ${Buffer.byteLength(body, "utf8")}`,
    `- evidence reach: ${reach.frozenEvidenceIds} frozen evidence record(s) in this run, ${reach.boundEvidenceIds} of them bound by some work item, ${reach.unbound.length} bound by none.`,
    `  A record no work item binds cannot reach any unit packet through the binding path (obligation → evidence), whatever this packet's byte bound is. This document's appendix unit(s) enumerate them by id: ${appendices.join(", ") || "(this document has no appendix unit, so nothing enumerates them)"}.`,
    "",
    "## What this packet is not",
    "",
    "It contains no source text that is not already a frozen evidence record of this run, and it opens no new",
    "source window. It is not a coverage claim: the counts below are the plan's and the ledger's, and this packet",
    "states no percentage of its own.",
    "",
    `## Grounding: what the unit audit checks the moment this unit is completed`,
    "",
    "Every MATERIAL obligation this unit OWNS — see Ownership below; it is a subset of what its topics reach — must",
    "be grounded by THIS unit's claims. The rule per determination, verbatim from the audit that will run:",
    ""
  ];
  for (const rule of GROUNDING_RULES) lines.push(`- \`${rule.status}\` — needs a ${rule.requires}.`);
  const owned = ownedCountOf(unit, input.ownership);
  lines.push(
    "",
    "Two exemptions, both counted rather than silent: an obligation whose ledger row carries `origin: \"open\"` is",
    "exempt (the full audit's denominator has always excluded those) and is reported in its own bucket; a",
    "non-material obligation is not required to be grounded, though it is rendered below.",
    "",
    "## Ownership: exactly one unit grounds each material obligation of this document",
    "",
    `Each material obligation of ${unit.documentId} has ONE owner unit, derived from the plan and this run's Topic`,
    "Catalog: among the topics that bind the obligation, the first one an OWNING unit of this document names — by the",
    `pinned facet priority ${OWNERSHIP_FACET_PRIORITY.join(" > ")}, then by ascending topic id.`,
    "A `leaf` and an `appendix` own the topics they name; a `bridge` references topics another unit owns; a",
    "`synthesis` names none. Ownership never crosses documents: every document answers for itself.",
    "",
    `- this document reaches ${input.ownership.reachedObligations} material obligation(s); THIS unit owns ${owned} of them, and grounds exactly those.`,
    "- an obligation another unit of this document owns appears below as a STUB row: id, dimension, determination,",
    "  materiality and the owner unit, with no evidence body. Every one of them is listed — stubs are never capped —",
    "  and the grounding audit will not ask you to ground one. Read the owner unit's packet for its evidence.",
    "- a stub is NOT a truncation. \"Which obligations exist and whose they are\" and \"here are their bytes\" are two",
    "  statements, and this packet makes the first for every obligation it can reach.",
    ""
  );
  if (limitations.length > 0) {
    lines.push("## Recorded limitations", "");
    for (const limitation of limitations) lines.push(`- ${limitation}`);
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

function renderBody(unit: PlanCatalogUnit, input: UnitPacketInput): string {
  const { dossier } = input;
  switch (dossier.source) {
    case "child-summaries":
      return renderChildSummaries(unit, dossier.children);
    case "topics":
      return [
        renderDispositions(unit, input.planCatalog),
        renderObligations(unit, dossier.topics, input.ownership),
        renderEvidence(unit, dossier.topics, dossier.evidence, input.ownership),
        renderFacetCensus(unit, input.facets),
        renderUnboundEvidence(unit, input.reach)
      ].filter((block) => block !== "").join("\n");
  }
  return assertNever(dossier, "unit dossier source");
}

/** The plan's decision for each of this unit's topics that owes one. A topic with no row says so. */
function renderDispositions(unit: PlanCatalogUnit, planCatalog: PlanCatalogArtifact): string {
  const byTopic = new Map(planCatalog.dispositions.map((row) => [row.topicId, row]));
  const lines = ["## Required dispositions", "", "The plan's decision for each topic below that owes one:", ""];
  for (const reference of unit.topics) {
    const row = byTopic.get(reference.topicId);
    lines.push(row
      ? `- ${reference.topicId} — ${row.state}${row.reason ? ` (reason: ${row.reason})` : ""}${row.lensPolicyId ? ` (lens: ${row.lensPolicyId})` : ""}`
      : `- ${reference.topicId} — (no disposition: this topic is not material, so the plan owes none)`);
  }
  if (unit.topics.length === 0) lines.push("- (this unit names no topic)");
  lines.push("");
  return lines.join("\n");
}

/**
 * One row per obligation, per topic — the 57B-453 fix, now split by owner (R5a).
 *
 * The ids are printed as the ledger records them, in the ledger's own order, never sorted or de-duplicated here: a
 * reading must be able to compare them byte for byte against `workitems.json`.
 *
 * TWO TABLES PER TOPIC, NOT ONE WIDER TABLE. The first is what this unit writes and grounds, with the binding's own
 * evidence and trace ids. The second lists the material obligations another unit of this document OWNS — every one
 * of them, uncapped — with the owner named, and nothing else: no evidence ids, because this packet does not carry
 * their bytes and printing ids it does not render is exactly the 57B-453 failure (a pointer to something the author
 * cannot open). Keeping them in separate tables is what makes "I must ground this" and "somebody else grounds this"
 * impossible to confuse at a glance.
 */
function renderObligations(unit: PlanCatalogUnit, topics: readonly TopicCandidate[], ownership: DocumentObligationOwnership): string {
  const bindings = topics.flatMap((topic) => topic.bindings);
  const material = bindings.filter((binding) => binding.material).length;
  const stubs = bindings.filter((binding) => !ownedByThisUnit(binding, unit, ownership)).length;
  const lines = [
    `## Obligations bound to this unit's topics (${bindings.length} obligation(s), ${material} material, ${bindings.length - stubs} written here, ${stubs} owned by another unit)`,
    "",
    "One row per OBLIGATION, with its own evidence and trace ids. The ids on a row belong to that obligation and to",
    "no other: this is the binding, not a shared pool, and a claim grounds an obligation by reusing the ids on ITS",
    "row. Do not infer a binding from a file path or a line range.",
    ""
  ];
  for (const topic of topics) {
    lines.push(
      `### ${topic.topicId} — ${topic.title}`,
      "",
      `- facet/kind: ${topic.facet}/${topic.kind}; materiality/confidence: ${topic.materiality}/${topic.confidence}; unknown: ${topic.unknown ? "yes" : "no"}`,
      `- canonical key: \`${topic.canonicalKey}\`; digest: ${topic.digest}`,
      `- source ledger: \`${topic.source.ledger}\` row \`${topic.source.rowId}\``,
      `- completeness: boundWorkItems=${topic.completeness.boundWorkItems} settledWorkItems=${topic.completeness.settledWorkItems} residualRows=${topic.completeness.residualRows} uncoveredLines=${topic.completeness.uncoveredLines}`,
      `- relations: ${topic.relationIds.join(", ") || "(none recorded)"}`,
      ""
    );
    if (topic.bindings.length === 0) {
      lines.push("| workItemId | dimension | status | material | evidenceIds | traceIds |", "| --- | --- | --- | --- | --- | --- |", "| (no obligation binds this topic) | | | | | |", "");
      continue;
    }
    const mine = topic.bindings.filter((binding) => ownedByThisUnit(binding, unit, ownership));
    const theirs = topic.bindings.filter((binding) => !ownedByThisUnit(binding, unit, ownership));
    lines.push("| workItemId | dimension | status | material | evidenceIds | traceIds |", "| --- | --- | --- | --- | --- | --- |");
    if (mine.length === 0) lines.push("| (every obligation of this topic is owned by another unit — see the stubs below) | | | | | |");
    for (const binding of mine) {
      lines.push(`| \`${binding.workItemId}\` | ${binding.dimension} | ${binding.status} | ${binding.material ? "yes" : "no"} | ${binding.evidenceIds.map((id) => `\`${id}\``).join(" ") || "(none)"} | ${binding.traceIds.map((id) => `\`${id}\``).join(" ") || "(none)"} |`);
    }
    lines.push("");
    if (theirs.length === 0) continue;
    lines.push(
      `Owned by another unit of ${unit.documentId} (${theirs.length} obligation(s), all of them listed, none of them yours to ground):`,
      "",
      "| workItemId | dimension | status | material | owner unit | owner topic |",
      "| --- | --- | --- | --- | --- | --- |"
    );
    for (const binding of theirs) {
      const owner = ownerOf(binding, unit, ownership);
      lines.push(`| \`${binding.workItemId}\` | ${binding.dimension} | ${binding.status} | ${binding.material ? "yes" : "no"} | \`${owner.ownerUnitId}\` | ${owner.ownerTopicId} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Every evidence record the obligations above bind, in full, each saying which obligations it grounds.
 *
 * The back-reference is the other half of the 57B-453 fix: the obligation row names its evidence, and the evidence
 * record names its obligations, so neither direction has to be guessed. No record is clipped here. A record the RUN
 * bounded when it was captured says so with both byte counts and where the full bytes are retained — that is a
 * statement about the run's own capture policy, not this packet dropping something.
 */
function renderEvidence(
  unit: PlanCatalogUnit,
  topics: readonly TopicCandidate[],
  evidence: ReadonlyMap<string, EvidenceItem>,
  ownership: DocumentObligationOwnership
): string {
  const groundedBy = new Map<string, string[]>();
  for (const topic of topics) {
    for (const binding of topic.bindings) {
      if (!ownedByThisUnit(binding, unit, ownership)) continue;
      for (const id of binding.evidenceIds) {
        const list = groundedBy.get(id);
        if (list) list.push(binding.workItemId);
        else groundedBy.set(id, [binding.workItemId]);
      }
    }
  }
  const ids = [...groundedBy.keys()].sort((a, b) => a.localeCompare(b));
  const lines = [`## Evidence bound to the obligations this unit owns (${ids.length} record(s), all rendered in full)`, ""];
  if (ids.length === 0) {
    lines.push("No obligation this unit OWNS binds any evidence record. That is a statement about the obligation ledger and", "about ownership, not about this packet's bound: nothing was dropped to fit. An obligation another unit owns is", "listed above as a stub and its evidence is rendered in that unit's packet.", "");
    return lines.join("\n");
  }
  for (const id of ids) {
    const item = evidence.get(id)!;
    const obligations = [...new Set(groundedBy.get(id)!)].sort((a, b) => a.localeCompare(b));
    lines.push(
      `### \`${id}\` — ${item.title}`,
      "",
      `- kind: ${item.kind}${item.path ? `; location: \`${item.path}${item.startLine === undefined ? "" : `:${item.startLine}-${item.endLine}`}\`` : ""}`,
      `- grounds obligation(s): ${obligations.map((workItemId) => `\`${workItemId}\``).join(", ")}`,
      `- recorded reason: ${item.reason}`,
      ...captureBoundNotes(item),
      ""
    );
    lines.push(...renderEvidencePayload(item), "");
  }
  return lines.join("\n");
}

/** What the run's capture policy did to this record, if anything — with both byte counts and the retained bytes. */
function captureBoundNotes(item: EvidenceItem): string[] {
  if (!item.contentRef) return [];
  return [
    `- CAPTURED BOUNDED BY THE RUN: ${item.retainedBytes} of ${item.originalBytes} byte(s) retained at capture time (${item.truncatedReason ?? "unrecorded reason"}). The full captured bytes are retained inside this run at \`${item.contentRef}\` (digest ${item.contentDigest}). This packet did not shorten the record; the run did, when it was captured.`
  ];
}

/**
 * The record's payload: prose content, or its data, or the named third state.
 *
 * Three arms and no silence: a record with neither content nor data is a real shape in the ledger (a marker row),
 * and rendering nothing for it would read as "empty file" instead of "this record carries metadata only".
 */
function renderEvidencePayload(item: EvidenceItem): string[] {
  if (item.content !== undefined) return ["```", item.content, "```"];
  if (item.data !== undefined) return ["```json", canonicalJson(item.data), "```"];
  return ["(this record carries no content and no data: it is a metadata-only ledger row)"];
}

/**
 * The mechanism-A census: frozen evidence no obligation binds, enumerated by the deterministic tail.
 *
 * Every kind and every id, uncapped. It is deliberately NOT rendered with content: these records ground no
 * obligation, so they are not part of what this packet promises to make answerable, and saying which records exist
 * is a different statement from handing over their bytes. What would bring one into a unit's grounding path is an
 * obligation binding it, which is upstream of this packet.
 */
function renderUnboundEvidence(unit: PlanCatalogUnit, reach: RunEvidenceReach): string {
  if (!enumeratesUnboundEvidence(unit.kind)) return "";
  const byKind = new Map<string, EvidenceItem[]>();
  for (const item of reach.unbound) {
    const list = byKind.get(item.kind);
    if (list) list.push(item);
    else byKind.set(item.kind, [item]);
  }
  const lines = [
    `## Evidence this run captured that no obligation binds (${reach.unbound.length} record(s))`,
    "",
    "These records are frozen in this run and NO work item binds them, so the binding path above cannot reach them",
    "and no obligation requires them to be grounded. They are enumerated here — this document's deterministic tail —",
    "so a coverage account can state that they exist and what they are. Their content is not rendered: they ground",
    "no obligation. Bringing one into a document's grounding path means minting an obligation that binds it, which",
    "happens upstream of this packet.",
    "",
    `| kind | records |`,
    "| --- | --- |"
  ];
  for (const kind of [...byKind.keys()].sort((a, b) => a.localeCompare(b))) lines.push(`| ${kind} | ${byKind.get(kind)!.length} |`);
  lines.push("", "| evidenceId | kind | title | location |", "| --- | --- | --- | --- |");
  for (const item of [...reach.unbound].sort((a, b) => a.id.localeCompare(b.id))) {
    const location = item.path ? `\`${item.path}${item.startLine === undefined ? "" : `:${item.startLine}-${item.endLine}`}\`` : "(no path)";
    lines.push(`| \`${item.id}\` | ${item.kind} | ${item.title.replace(/\|/g, "\\|")} | ${location} |`);
  }
  if (reach.unbound.length === 0) lines.push("| (none) | | | |");
  lines.push("");
  return lines.join("\n");
}

/**
 * The facet census, in the deterministic tail: every facet, populated or named-empty with its own reason.
 *
 * Rendered only by the kind that enumerates the residue, and rendered with the ledger's own words: an author writing
 * a coverage account has to be able to say "no feature topic exists because the bound contract names no feature"
 * rather than "there are no features". The two empty states are printed as themselves, never merged into "empty".
 */
function renderFacetCensus(unit: PlanCatalogUnit, facets: readonly TopicFacetCensus[]): string {
  if (!enumeratesUnboundEvidence(unit.kind)) return "";
  const lines = [
    "## Facet census of this run's Topic Catalog",
    "",
    "Every facet of the catalog, populated or empty. An empty facet says WHICH ledger was not there and why:",
    "`ledger-absent` (the producer's own artifact is missing or unavailable) and `ledger-empty` (the ledger is",
    "there and holds no row) are different statements and must not be reported as one.",
    "",
    "| facet | state | topics | material | obligated-non-material | unobligated | reason |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const facet of TOPIC_FACETS) {
    const row = facets.find((entry) => entry.facet === facet);
    if (!row) throw new Error(`The facet census handed to unit ${JSON.stringify(unit.unitId)} has no row for the ${facet} facet; every facet appears in every census`);
    lines.push(`| ${facet} | ${row.outcome.state} | ${outcomeTopics(row.outcome)} | ${row.materiality.material} | ${row.materiality.obligatedNonMaterial} | ${row.materiality.unobligated} | ${outcomeReason(row.outcome)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Exhaustive over the three facet outcome states — a fourth has to be given a column before this compiles. */
function outcomeTopics(outcome: FacetOutcome): string {
  switch (outcome.state) {
    case "populated":
      return String(outcome.topics);
    case "ledger-absent":
    case "ledger-empty":
      return "0";
  }
  return assertNever(outcome, "topic facet outcome");
}

function outcomeReason(outcome: FacetOutcome): string {
  switch (outcome.state) {
    case "populated":
      return `holds ${outcome.topics} topic(s)`;
    case "ledger-absent":
    case "ledger-empty":
      return outcome.reason;
  }
  return assertNever(outcome, "topic facet outcome");
}

/** A synthesis reads its children's summaries and nothing else. There is no topic block on this path. */
function renderChildSummaries(unit: PlanCatalogUnit, children: readonly UnitSummary[]): string {
  const lines = [
    `## Child summaries (${children.length})`,
    "",
    "This is a synthesis unit: it names no topic and reads no evidence record. Everything it may state comes from",
    "the summaries below, which its children already wrote and had collected. A fact that is not in one of them",
    "belongs in the child that owns it, not here.",
    ""
  ];
  for (const child of children) {
    lines.push(
      `### ${child.unitId} (${child.kind})`,
      "",
      `- covered topic(s): ${child.coveredTopicIds.join(", ") || "(none)"}`,
      `- content digest: ${child.contentDigest}; claims digest: ${child.claimsDigest}`,
      "",
      "Key statements:",
      ""
    );
    for (const statement of child.keyStatements) lines.push(`- ${statement}`);
    lines.push("", `Unknowns: ${child.unknowns.length === 0 ? "(none stated)" : ""}`, "");
    for (const unknown of child.unknowns) lines.push(`- ${unknown}`);
    if (child.unknowns.length > 0) lines.push("");
    lines.push(`Terminology: ${child.terminology.length === 0 ? "(none stated)" : ""}`, "");
    for (const term of child.terminology) lines.push(`- \`${term.term}\` — ${term.meaning}`);
    if (child.terminology.length > 0) lines.push("");
    if (child.childSummaryDigests.length > 0) {
      lines.push("Child digests this child recorded:", "");
      for (const row of child.childSummaryDigests) lines.push(`- ${row.childUnitId} — ${row.summaryDigest}`);
      lines.push("");
    }
  }
  if (children.length === 0) {
    lines.push("This synthesis has no collected child. Nothing can be written from an empty summary set: draft and", "collect its children first.", "");
  }
  return lines.join("\n");
}
