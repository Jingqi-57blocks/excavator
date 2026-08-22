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
 * THIS FILE IS THE MEASURE, NOT JUST THE RENDERER (R5b). `composePacketMarkdown` below is the ONE function that
 * turns inputs into bytes; `renderUnitPacket` returns its markdown and `unitPacketBytes` returns its length, so the
 * plan's budget pre-check and the author's packet cannot disagree by construction. R4b's pre-check used a proxy —
 * the canonical bytes of a unit's topic ROWS — and it was out by about 9x on the wcp baseline (220 KB of topic rows
 * against a 1,993,499-byte packet) because the proxy did not include the evidence bodies. The proxy is gone; the
 * instrument is attached to the thing it grades.
 *
 * THE INPUT BUDGET IS THE PLAN'S, NOT A NEW NUMBER, AND SO IS THE OUTPUT BUDGET NOW. `PlanBudget` carries all four
 * numbers per document, so the packet prints the declared output and summary bounds instead of R4b's "NONE
 * DECLARED" deferral. Nothing here enforces the output bound — `draftUnit` does, at the moment the bytes exist —
 * and the sentence the packet prints says what over-budget means: rewrite tighter, never drop an entry.
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
 * author can always follow a stub to the unit that owes it.
 *
 * AND A SCOPE IS NOT A TRUNCATION EITHER (R5b), BUT IT IS NOT A STUB TABLE EITHER. A unit's topic reference carries
 * an `obligationScope`, so a topic too large for one unit is divided across several: each part renders the
 * obligations INSIDE ITS OWN SCOPE, in full, with their evidence — and for the rest of that topic it prints the
 * PARTITION: how many obligations each sibling unit of the same document carries, by unit id. Not a per-id stub
 * table, and that is a measured decision rather than a saving: repeating one topic's whole census in every part
 * costs 660 KB per wcp document (measured on the R0 baseline) and pushes the document over its own total input
 * budget — which is the duplication the division exists to remove, in a cheaper coat. Nothing is lost by it: the
 * scopes of a topic's owning units are checked to partition its bindings EXACTLY (`obligation-scope.ts`), every
 * obligation of the topic is rendered IN FULL in exactly one packet of the document, and `plan/catalog.json`
 * records each unit's scope BY WORK ITEM ID — so the partition is addressable, not merely asserted. That is the
 * difference from 57B-453's mechanism B, which pointed at a file the prompt forbade opening.
 *
 * THE OWNERSHIP STUB TABLE IS UNTOUCHED BY THAT. An obligation this unit's scope DOES cover, that another unit owns
 * through a different topic (the cross-facet case R5a measured), still gets its own row with the owner named: there
 * the author's own topic reaches it, and only a row per obligation stops "mine" and "theirs" being confused.
 *
 * EVIDENCE NO OBLIGATION BINDS IS COUNTED IN EVERY PACKET AND ENUMERATED IN THE APPENDIX. That is 57B-453's
 * mechanism A: the binding path is obligation → evidence, so a record no work item references cannot reach any
 * unit through it — and on the wcp baseline that is 931 of 1,884 frozen records, including the manifest, README,
 * scope and provider rows a coverage section is required to report. The count is in every header with the reason,
 * and the deterministic tail (the appendix, gate 10's path) lists every one of them by id with its kind, title and
 * location, uncapped. What would bring one's CONTENT into a unit is an obligation binding it; that is upstream of
 * this packet, and saying so is not the same as pointing at a path that does not exist.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { EvidenceItem, InvestigationWorkItem } from "../base/types.ts";
import { canonicalJson, sha256 } from "../base/util.ts";
import { GROUNDING_RULES } from "./unit-grounding-audit.ts";
import { documentBudgetRow, summariseDocumentBudget, type PlanDocumentBudget } from "./plan-budget.ts";
import type { PlanCatalogArtifact, PlanCatalogUnit, PlanDagArtifact, PlanTopicReference } from "./plan-artifacts.ts";
import { planCatalogDigest } from "./plan-artifacts.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import { renderCoverageStateBlock, type PacketCoverageFacts } from "./coverage-companion.ts";
import { describeObligationScope, scopeIncludes } from "./obligation-scope.ts";
import { intentPolicyFor, lensPolicyFor, type ReportPolicyRegistry } from "./report-policy-registry.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";
import { OWNERSHIP_FACET_PRIORITY, unitTopicRole, type DocumentObligationOwnership, type ObligationOwnership } from "./plan-obligation-conservation.ts";
import type { PacketOverBudgetMode } from "./planner-packet.ts";
import { TOPIC_FACETS, type TopicCandidate, type TopicObligationBinding } from "./topic-candidate.ts";
import type { FacetOutcome, TopicFacetCensus } from "./topic-catalog.ts";
import type { UnitSummary } from "./unit-output.ts";
import { compareUnitIds } from "./unit-paths.ts";

export const UNIT_PACKET_VERSION = "unit-packet-v3";

/**
 * WHICH VIEW OF ONE UNIT'S INPUTS IS BEING COMPOSED (R6a). Same renderer, one required flag, two readings.
 *
 * `packet` is the bytes an author is handed. `identity` is the SAME composition with the three plan-global digest
 * lines below normalized — the cache identity of this unit. It is a view rather than a second list of key inputs
 * for the reason R5b's 9x measurement gap already paid for: a hand-written enumeration of "what a unit's identity
 * depends on" drifts the moment the renderer reads one more input, and it drifts SILENTLY towards reusing a stale
 * draft. Derived from the renderer, a new input line changes the identity by construction, and the drift direction
 * flips to over-invalidation.
 */
export type PacketRenderView = "packet" | "identity";

/**
 * THE THREE HEADER LINES A CACHE IDENTITY NORMALIZES, and the only three. A closed, exported list.
 *
 * Each of these is a digest over the WHOLE plan or the WHOLE topic catalog, so any local change to either one
 * changes every packet's bytes: edit one topic and all 40 wcp packets differ; add a second audience document and
 * `requestsDigest` moves under every existing document. Keeping them in the identity would make the epic's own
 * acceptance arithmetically unsatisfiable — "rebuild the leaf and its ancestors" and "the other audience's
 * documents are reused" both require an identity that is LOCAL to a unit.
 *
 * Excluding them is not self-certified: R6b's admission has to pass `draftUnit` and `collect` unchanged (the
 * grounding audit, the synthesis backlink check, the digest checks), so a draft admitted on a wrong identity still
 * cannot be recorded without those gates agreeing. A FOURTH line normalized here is a planning-level decision, not
 * an edit — `tests/unit-cache-identity.test.ts` pins the length and the members of this list.
 */
export const IDENTITY_NORMALIZED_HEADER_LABELS = ["topics catalog digest", "plan catalog digest", "recorded requests digest"] as const;
export type IdentityNormalizedHeaderLabel = (typeof IDENTITY_NORMALIZED_HEADER_LABELS)[number];

/** What the identity view prints instead of a plan-global digest. Never appears in a packet an author reads. */
export const IDENTITY_NORMALIZED_VALUE = "(normalized for cache identity)";

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

/**
 * The one derivation of mechanism A's three numbers, shared by the loader, the plan-side measure and the baseline
 * projection.
 *
 * It was spelled three times before this slice, and the plan's budget pre-check needed a fourth: three spellings of
 * "how far does the ledger reach" are three answers waiting to disagree. A frozen id with no record in the evidence
 * catalog is a named failure rather than a row that quietly disappears from the census.
 */
export function evidenceReachOf(
  frozenEvidenceIds: readonly string[],
  workItems: Iterable<Pick<InvestigationWorkItem, "evidenceIds">>,
  evidenceById: ReadonlyMap<string, EvidenceItem>
): RunEvidenceReach {
  const bound = new Set<string>();
  for (const item of workItems) for (const id of item.evidenceIds) bound.add(id);
  const frozen = [...frozenEvidenceIds].sort((a, b) => a.localeCompare(b));
  const unbound: EvidenceItem[] = [];
  for (const id of frozen) {
    if (bound.has(id)) continue;
    const item = evidenceById.get(id);
    if (!item) {
      throw new Error(`knowledge.json seals evidence ${JSON.stringify(id)} but this run's evidence.json does not hold it; the frozen evidence set and the ledger disagree`);
    }
    unbound.push(item);
  }
  return { frozenEvidenceIds: frozen.length, boundEvidenceIds: bound.size, unbound };
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
  /**
   * R7a's coverage state of this run, rendered by the deterministic tail (the appendix) and by nothing else.
   *
   * Required, with no default, for the reason the facet census above is: an author writing a coverage chapter has
   * to have the run's own denominators IN the bounded view, and epic gate 10 says the run's residual must reach a
   * reader through this unit. An optional field would be omitted at the one call site where the omission matters,
   * and the block would silently disappear from the packet that is supposed to carry it.
   *
   * It is derived from this run's sealed ledgers ONLY — never from what sibling units have been collected — so
   * that drafting a sibling cannot move this unit's cache identity. `coverage-companion-source.ts` states that as
   * a named absence inside the value rather than leaving it to be inferred.
   */
  readonly coverage: PacketCoverageFacts;
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
   * Owner-scoped since R5a and obligation-scoped since R5b: an obligation another unit owns, or one outside this
   * unit's declared scope, contributes no evidence here, because this packet does not hand over its bytes. The 453
   * closure reading follows the owner for the same reason.
   */
  readonly renderedEvidenceIds: readonly string[];
  /** Every obligation rendered IN FULL below, ascending. A stub is in one of the two lists below, not here. */
  readonly obligationIds: readonly string[];
  /** Every MATERIAL obligation rendered as a stub because another unit owns it, ascending. Uncapped. */
  readonly stubObligationIds: readonly string[];
  /**
   * Every obligation of this unit's topics that its `obligationScope` excludes, ascending. Uncapped.
   *
   * Kept apart from the ownership stubs because they answer different questions — "somebody else grounds this" and
   * "this is another part of the same topic". The markdown prints these as a per-carrier PARTITION (counts by unit
   * id) rather than a row each; the ids are here, and in `plan/catalog.json`, and in full in the packet of the unit
   * whose scope holds them.
   */
  readonly scopeExcludedObligationIds: readonly string[];
  readonly markdown: string;
}

/** Render one unit's packet. Deterministic: same plan, same catalog rows, same evidence, same bytes. */
export function renderUnitPacket(input: UnitPacketInput): UnitPacket {
  const unit = requireUnit(input);
  assertOwnershipIsThisDocument(unit, input.ownership);
  assertDossierMatchesUnit(unit, input.dossier);
  const withoutLimitation = composePacketMarkdown(unit, input, [], "packet");
  const bytes = Buffer.byteLength(withoutLimitation, "utf8");
  const rendered = renderedIds(unit, input);
  if (bytes <= input.byteLimit) {
    return { ...rendered, version: UNIT_PACKET_VERSION, unitId: unit.unitId, documentId: unit.documentId, kind: unit.kind, bytes, byteLimit: input.byteLimit, limitations: [], markdown: withoutLimitation };
  }
  const overrun = overrunSentence(unit, input, bytes, rendered);
  switch (input.overBudget) {
    case "refuse":
      throw new Error(overrun);
    case "record-limitation": {
      const markdown = composePacketMarkdown(unit, input, [overrun], "packet");
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

/**
 * How many bytes this unit's packet renders to. THE plan-side input measure — same function, same bytes.
 *
 * It composes the packet the author would be handed and returns its length; it does not consult `overBudget`,
 * because a measurement is not a verdict. `renderUnitPacket` returns exactly this number in `bytes` whenever the
 * packet fits its bound, and `tests/plan-packet-measure.test.ts` asserts that identity for every renderable unit of
 * both R0 baselines and every fixture — the tripwire that stops a second, drifting estimate from being introduced.
 */
export function unitPacketBytes(input: UnitPacketInput): number {
  return Buffer.byteLength(composeUnitPacketMarkdown(input, "packet"), "utf8");
}

/**
 * The one composition, exposed: the packet an author reads, or the cache identity view of the same inputs (R6a).
 *
 * The entry checks and the composition are the packet's own, so the identity view cannot be a second renderer that
 * drifts from this one. `unitPacketBytes` and `renderUnitPacket` (when the packet fits) return exactly the bytes of
 * `view: "packet"`, and `tests/unit-cache-identity.test.ts` diffs the two views line by line: everything they disagree on
 * must be one of `IDENTITY_NORMALIZED_HEADER_LABELS`.
 */
export function composeUnitPacketMarkdown(input: UnitPacketInput, view: PacketRenderView): string {
  const unit = requireUnit(input);
  assertOwnershipIsThisDocument(unit, input.ownership);
  assertDossierMatchesUnit(unit, input.dossier);
  return composePacketMarkdown(unit, input, [], view);
}

/**
 * The three plan-global digest lines, printed in a packet and normalized in an identity view.
 *
 * Emitted FROM the closed label list rather than written out three times, so normalizing a fourth line means
 * editing that list — which is where the closure is asserted — instead of adding a quiet special case here.
 */
function planGlobalDigestLines(planCatalog: PlanCatalogArtifact, view: PacketRenderView): readonly string[] {
  switch (view) {
    case "packet": {
      const values: Record<IdentityNormalizedHeaderLabel, string> = {
        "topics catalog digest": planCatalog.topicsDigest,
        "plan catalog digest": planCatalogDigest(planCatalog),
        "recorded requests digest": planCatalog.requestsDigest
      };
      return IDENTITY_NORMALIZED_HEADER_LABELS.map((label) => `- ${label}: ${values[label]}`);
    }
    case "identity":
      return IDENTITY_NORMALIZED_HEADER_LABELS.map((label) => `- ${label}: ${IDENTITY_NORMALIZED_VALUE}`);
  }
  return assertNever(view, "unit packet render view");
}

/** The one composition: header then body. Both `renderUnitPacket` and `unitPacketBytes` go through it. */
function composePacketMarkdown(unit: PlanCatalogUnit, input: UnitPacketInput, limitations: readonly string[], view: PacketRenderView): string {
  const body = renderBody(unit, input);
  return `${renderHeader(unit, input, body, limitations, view)}\n${body}`;
}

/** Ownership is per document; rendering a unit against another document's row is a bug in the caller, and named. */
function assertOwnershipIsThisDocument(unit: PlanCatalogUnit, ownership: DocumentObligationOwnership): void {
  if (ownership.documentId !== unit.documentId) {
    throw new Error(`Unit ${JSON.stringify(unit.unitId)} is written into document ${JSON.stringify(unit.documentId)} but was handed the ownership of document ${JSON.stringify(ownership.documentId)}; ownership is derived per document, so these decide two different sets of owners`);
  }
}

/**
 * What this unit does with one binding of one of its topics — three states, exhaustive, no default.
 *
 * SCOPE IS CHECKED FIRST, and the order is the design. An obligation OUTSIDE this unit's scope for this topic is
 * another part's row: it is not rendered here, and the packet accounts for it in the per-carrier partition instead
 * of a row of its own (see the header). Checking ownership first would classify a divided topic's siblings as
 * "owned elsewhere" and print the topic's whole census in every part — 660 KB per wcp document, measured, which is
 * exactly the duplication the division removes.
 *
 * IN SCOPE, the split is R5a's, unchanged: a MATERIAL binding is rendered in full by its OWNER and as a stub row
 * naming the owner by every other unit that reaches it (the cross-facet case), and a NON-MATERIAL binding has no
 * owner at all so the unit whose scope holds it renders it. A material binding with no owner row is FATAL rather
 * than either default — "full" would restore the duplication for exactly the rows a plan got wrong, and "stub"
 * would point the author at an owner that does not exist.
 */
type BindingDisposition =
  | { readonly state: "full" }
  | { readonly state: "owned-elsewhere"; readonly owner: ObligationOwnership }
  | { readonly state: "out-of-scope"; readonly carrierUnitId: string };

function bindingDisposition(
  binding: TopicObligationBinding,
  topic: PlanTopicReference,
  unit: PlanCatalogUnit,
  input: UnitPacketInput
): BindingDisposition {
  if (!scopeIncludes(topic.obligationScope, binding.workItemId)) {
    return { state: "out-of-scope", carrierUnitId: scopeCarrierOf(binding, topic, unit, input) };
  }
  if (!binding.material) return { state: "full" };
  const owner = input.ownership.ownerByObligation.get(binding.workItemId);
  if (!owner) {
    throw new Error(`Material obligation ${JSON.stringify(binding.workItemId)} is bound to a topic of unit ${JSON.stringify(unit.unitId)}, but no unit of document ${JSON.stringify(unit.documentId)} owns it; a packet cannot say whose obligation it is`);
  }
  return owner.ownerUnitId === unit.unitId ? { state: "full" } : { state: "owned-elsewhere", owner };
}

/**
 * Which OWNING unit of this document has one out-of-scope binding inside its scope, or a named failure.
 *
 * Read off the recorded plan's own unit rows, so the packet names a unit an author can go and read. Fatal on a miss
 * for the same reason a missing owner is: a plan whose scopes do not partition a topic is named by validation
 * (`obligation-scope.ts`) and refused by `buildPlanArtifacts`, so reaching this throw means an unvalidated plan got
 * here — and printing "(nobody)" would tell the author a row exists that nothing writes.
 */
function scopeCarrierOf(
  binding: TopicObligationBinding,
  topic: PlanTopicReference,
  unit: PlanCatalogUnit,
  input: UnitPacketInput
): string {
  const carriers = input.planCatalog.units
    .filter((row) => row.documentId === unit.documentId && unitTopicRole(row.kind) === "owning")
    .filter((row) => row.topics.some((reference) => reference.topicId === topic.topicId && scopeIncludes(reference.obligationScope, binding.workItemId)))
    .map((row) => row.unitId)
    .sort(compareUnitIds);
  if (carriers.length === 0) {
    throw new Error(`Obligation ${JSON.stringify(binding.workItemId)} of topic ${JSON.stringify(topic.topicId)} is outside unit ${JSON.stringify(unit.unitId)}'s obligation scope and inside no other owning unit's scope in document ${JSON.stringify(unit.documentId)}; the scopes of a topic's owning units must partition its bindings exactly`);
  }
  return carriers[0]!;
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
 * THE DIGEST CHECK IS THE POINT OF THE REFERENCE. The plan carries `{topicId, topicDigest, obligationScope}`
 * instead of a flattened id bag so that a topic whose content moved can be caught here — a packet rendered from a
 * topic the plan never saw would be an author writing against knowledge the plan did not validate. Named, both
 * digests printed.
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

interface RenderedIds {
  readonly renderedEvidenceIds: readonly string[];
  readonly obligationIds: readonly string[];
  readonly stubObligationIds: readonly string[];
  readonly scopeExcludedObligationIds: readonly string[];
}

/**
 * Every id this packet renders. Ascending, de-duplicated — what a reading compares against `workitems.json`.
 *
 * OWNER-SCOPED AND SCOPE-SCOPED, with the two stub reasons counted separately rather than folded in. The appendix's
 * unbound census is deliberately NOT counted here either: everything in the three stub/census lists is enumerated by
 * id and metadata, not rendered in full, so counting them as rendered would overstate what an author was handed.
 */
function renderedIds(unit: PlanCatalogUnit, input: UnitPacketInput): RenderedIds {
  const { dossier } = input;
  switch (dossier.source) {
    case "child-summaries":
      return { renderedEvidenceIds: [], obligationIds: [], stubObligationIds: [], scopeExcludedObligationIds: [] };
    case "topics": {
      const evidence = new Set<string>();
      const obligations = new Set<string>();
      const stubs = new Set<string>();
      const excluded = new Set<string>();
      for (const [index, topic] of dossier.topics.entries()) {
        const reference = unit.topics[index]!;
        for (const binding of topic.bindings) {
          const disposition = bindingDisposition(binding, reference, unit, input);
          switch (disposition.state) {
            case "owned-elsewhere":
              stubs.add(binding.workItemId);
              continue;
            case "out-of-scope":
              excluded.add(binding.workItemId);
              continue;
            case "full":
              obligations.add(binding.workItemId);
              for (const id of binding.evidenceIds) evidence.add(id);
              continue;
          }
          return assertNever(disposition, "unit packet binding disposition");
        }
      }
      const ascending = (a: string, b: string): number => a.localeCompare(b);
      return {
        renderedEvidenceIds: [...evidence].sort(ascending),
        obligationIds: [...obligations].sort(ascending),
        stubObligationIds: [...stubs].sort(ascending),
        scopeExcludedObligationIds: [...excluded].sort(ascending)
      };
    }
  }
  return assertNever(dossier, "unit dossier source");
}

function overrunSentence(unit: PlanCatalogUnit, input: UnitPacketInput, bytes: number, rendered: RenderedIds): string {
  const topics = unit.topics.map((topic) => `${topic.topicId} (scope: ${describeObligationScope(topic.obligationScope)})`).join(", ") || "(none)";
  return `The packet for unit ${JSON.stringify(unit.unitId)} renders to ${bytes} bytes, over the declared bound of ${input.byteLimit} (${bytes - input.byteLimit} bytes over). NOTHING has been dropped or shortened: all ${unit.topics.length} topic(s), ${rendered.obligationIds.length} obligation row(s) rendered in full, ${rendered.stubObligationIds.length} stub row(s) for obligations another unit owns, ${rendered.scopeExcludedObligationIds.length} stub row(s) for obligations outside this unit's scope and ${rendered.renderedEvidenceIds.length} evidence record(s) are present. The offending unit's topics are: ${topics}. Divide this unit's obligations further (that is what \`plan-unit-split.ts\` does, deterministically) or raise the bound deliberately — truncation is not an option here.`;
}

/**
 * The declared input bound for one unit: the plan's own `perUnitInputBytes` for that unit's document.
 *
 * The ONE authority, so every caller — the CLI, the loader, a baseline projection — measures against the same
 * number instead of picking one. There is deliberately no fallback: a plan with no budget row for a document is a
 * named failure, not a unit measured against a default nobody chose.
 */
export function unitInputBound(planCatalog: PlanCatalogArtifact, unit: PlanCatalogUnit): number {
  return documentBudgetRow(planCatalog.budget, unit.documentId).perUnitInputBytes;
}

/**
 * The topic dossier of one unit, assembled from the catalog rows and the evidence ledger.
 *
 * Pure, and shared by every caller: the run loader, and the baseline projection that cannot use the loader because
 * an archival run has no `plan/` on disk and may not be written to. A binding whose evidence the ledger does not
 * hold is a named failure here rather than a hole discovered at render time. Every binding's evidence is collected,
 * scope or not: the check is about whether the RUN is consistent, and narrowing it to what a scoped unit happens to
 * render would make it weaker for exactly the plans that divide a topic.
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

/**
 * The output bound sentence, printed in every packet.
 *
 * R4b printed "output budget: NONE DECLARED" and deferred to R5's budget system; that deferral is redeemed here.
 * The sentence states BOTH numbers and what over-budget means, because an author told only the number would meet it
 * the cheap way: dropping an unknown or a term. Core never deletes content to fit, and the enforcement at draft
 * time says so in the same words.
 */
export function outputBoundSentence(budget: PlanDocumentBudget): string {
  return `output budget (plan, per unit for ${budget.documentId}): ${budget.perUnitOutputBytes} bytes of \`content.md\` plus canonical claims, and ${budget.perUnitSummaryBytes} bytes for the summary block a parent unit reads. Both are ENFORCED when this unit is drafted: over-budget is a named refusal, and the way to satisfy it is to WRITE MORE TIGHTLY — never to drop an obligation, an unknown or a terminology entry. Core does not delete content to fit.`;
}

function renderHeader(unit: PlanCatalogUnit, input: UnitPacketInput, body: string, limitations: readonly string[], view: PacketRenderView): string {
  const { planCatalog, requests, registry, dag, reach } = input;
  const record = requests.requests.find((entry) => entry.documentId === unit.documentId);
  if (!record) throw new Error(`No recorded request for document ${JSON.stringify(unit.documentId)}; a unit packet is rendered under the request that asked for its document`);
  const lens = lensPolicyFor(record.request.audience, registry);
  const intent = intentPolicyFor(record.request.intent, registry);
  const budget = documentBudgetRow(planCatalog.budget, unit.documentId);
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
    ...planGlobalDigestLines(planCatalog, view),
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
    `- ${outputBoundSentence(budget)}`,
    `- declared budget row: ${summariseDocumentBudget(budget)}`,
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
    "## Ownership and scope: exactly one unit grounds each material obligation of this document",
    "",
    `Each material obligation of ${unit.documentId} has ONE owner unit, derived from the plan and this run's Topic`,
    "Catalog: among the topics that bind the obligation, the first one an OWNING unit of this document names AND",
    `holds inside its obligation scope — by the pinned facet priority ${OWNERSHIP_FACET_PRIORITY.join(" > ")}, then by`,
    "ascending topic id. A `leaf` and an `appendix` own the topics they name; a `bridge` references topics another",
    "unit owns; a `synthesis` names none. Ownership never crosses documents: every document answers for itself.",
    "",
    "A topic too large for one unit is DIVIDED by obligation scope, never truncated: the scopes of one topic's",
    "owning units partition its bindings exactly — every id in exactly one of them — and a plan whose scopes do not",
    "is refused by name. This unit's scope per topic is printed with its obligations below.",
    "",
    `- this document reaches ${input.ownership.reachedObligations} material obligation(s); THIS unit owns ${owned} of them, and grounds exactly those.`,
    "- an obligation THIS UNIT'S SCOPE COVERS that another unit owns through a topic of its own appears below as a",
    "  STUB row: id, dimension, determination, materiality and the owner unit, with no evidence body. Every one of",
    "  them is listed — those stubs are never capped — and the grounding audit will not ask you to ground one.",
    "- an obligation OUTSIDE this unit's scope is another part of a divided topic. It is accounted for below by the",
    "  unit that carries it and how many it carries; its row and its evidence are rendered IN FULL in that unit's",
    "  packet, and `plan/catalog.json` records every unit's scope by work item id. Nothing is dropped or capped.",
    "- neither is a truncation. \"Which obligations exist and whose they are\" and \"here are their bytes\" are two",
    "  statements, and between this document's packets the first is made for every obligation exactly once.",
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
        renderObligations(unit, input, dossier.topics),
        renderEvidence(unit, input, dossier.topics, dossier.evidence),
        renderFacetCensus(unit, input.facets),
        // R7a: the coverage state, in the same deterministic tail and behind the same kind gate as the facet
        // census. It sits beside them because all three answer "what does this run NOT know", and gate 10 routes
        // that through the appendix.
        coverageBlock(unit, input.coverage),
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
 * One row per obligation, per topic — the 57B-453 fix, split by owner (R5a) and by scope (R5b).
 *
 * The ids are printed as the ledger records them, in the ledger's own order, never sorted or de-duplicated here: a
 * reading must be able to compare them byte for byte against `workitems.json`.
 *
 * TWO TABLES PER TOPIC, NOT ONE WIDER TABLE. The first is what this unit writes and grounds, with the binding's own
 * evidence and trace ids. The second lists every obligation of the topic that another unit carries — all of them,
 * uncapped — with that unit named and the REASON (ownership, or this unit's scope), and nothing else: no evidence
 * ids, because this packet does not carry their bytes and printing ids it does not render is exactly the 57B-453
 * failure (a pointer to something the author cannot open). Keeping them in separate tables is what makes "I must
 * ground this" and "somebody else writes this" impossible to confuse at a glance.
 */
function renderObligations(unit: PlanCatalogUnit, input: UnitPacketInput, topics: readonly TopicCandidate[]): string {
  const dispositions = new Map<string, BindingDisposition>();
  for (const [index, topic] of topics.entries()) {
    const reference = unit.topics[index]!;
    for (const binding of topic.bindings) {
      dispositions.set(`${topic.topicId} ${binding.workItemId}`, bindingDisposition(binding, reference, unit, input));
    }
  }
  const dispositionOf = (topicId: string, binding: TopicObligationBinding): BindingDisposition => dispositions.get(`${topicId} ${binding.workItemId}`)!;
  const bindings = topics.flatMap((topic) => topic.bindings);
  const material = bindings.filter((binding) => binding.material).length;
  let elsewhere = 0;
  for (const topic of topics) {
    for (const binding of topic.bindings) {
      if (dispositionOf(topic.topicId, binding).state !== "full") elsewhere += 1;
    }
  }
  const lines = [
    `## Obligations bound to this unit's topics (${bindings.length} obligation(s), ${material} material, ${bindings.length - elsewhere} written here, ${elsewhere} carried by another unit of this document)`,
    "",
    "One row per OBLIGATION, with its own evidence and trace ids. The ids on a row belong to that obligation and to",
    "no other: this is the binding, not a shared pool, and a claim grounds an obligation by reusing the ids on ITS",
    "row. Do not infer a binding from a file path or a line range.",
    ""
  ];
  for (const [index, topic] of topics.entries()) {
    const reference = unit.topics[index]!;
    lines.push(
      `### ${topic.topicId} — ${topic.title}`,
      "",
      `- facet/kind: ${topic.facet}/${topic.kind}; materiality/confidence: ${topic.materiality}/${topic.confidence}; unknown: ${topic.unknown ? "yes" : "no"}`,
      `- canonical key: \`${topic.canonicalKey}\`; digest: ${topic.digest}`,
      `- source ledger: \`${topic.source.ledger}\` row \`${topic.source.rowId}\``,
      `- THIS unit's obligation scope for this topic: ${describeObligationScope(reference.obligationScope)}`,
      `- completeness: boundWorkItems=${topic.completeness.boundWorkItems} settledWorkItems=${topic.completeness.settledWorkItems} residualRows=${topic.completeness.residualRows} uncoveredLines=${topic.completeness.uncoveredLines}`,
      `- relations: ${topic.relationIds.join(", ") || "(none recorded)"}`,
      ""
    );
    if (topic.bindings.length === 0) {
      lines.push("| workItemId | dimension | status | material | evidenceIds | traceIds |", "| --- | --- | --- | --- | --- | --- |", "| (no obligation binds this topic) | | | | | |", "");
      continue;
    }
    const mine = topic.bindings.filter((binding) => dispositionOf(topic.topicId, binding).state === "full");
    const ownedElsewhere = topic.bindings.filter((binding) => dispositionOf(topic.topicId, binding).state === "owned-elsewhere");
    const outOfScope = topic.bindings.filter((binding) => dispositionOf(topic.topicId, binding).state === "out-of-scope");
    lines.push("| workItemId | dimension | status | material | evidenceIds | traceIds |", "| --- | --- | --- | --- | --- | --- |");
    if (mine.length === 0) lines.push("| (no obligation of this topic is written by this unit — see below) | | | | | |");
    for (const binding of mine) {
      lines.push(`| \`${binding.workItemId}\` | ${binding.dimension} | ${binding.status} | ${binding.material ? "yes" : "no"} | ${binding.evidenceIds.map((id) => `\`${id}\``).join(" ") || "(none)"} | ${binding.traceIds.map((id) => `\`${id}\``).join(" ") || "(none)"} |`);
    }
    lines.push("");
    if (ownedElsewhere.length > 0) {
      lines.push(
        `OWNED BY ANOTHER UNIT of ${unit.documentId} (${ownedElsewhere.length} obligation(s), every one of them listed, none of them yours to ground). This unit's scope covers them, but their owner reaches them through a topic of its own:`,
        "",
        "| workItemId | dimension | status | material | owner unit | owner topic |",
        "| --- | --- | --- | --- | --- | --- |"
      );
      for (const binding of ownedElsewhere) {
        const owner = ownerOf(dispositionOf(topic.topicId, binding));
        lines.push(`| \`${binding.workItemId}\` | ${binding.dimension} | ${binding.status} | ${binding.material ? "yes" : "no"} | \`${owner.ownerUnitId}\` | ${owner.ownerTopicId} |`);
      }
      lines.push("");
    }
    if (outOfScope.length > 0) {
      const byCarrier = new Map<string, number>();
      for (const binding of outOfScope) {
        const carrier = carrierOf(dispositionOf(topic.topicId, binding));
        byCarrier.set(carrier, (byCarrier.get(carrier) ?? 0) + 1);
      }
      lines.push(
        `THIS TOPIC IS DIVIDED. This unit's scope covers ${mine.length + ownedElsewhere.length} of its ${topic.bindings.length} obligation(s); the other ${outOfScope.length} belong to other unit(s) of ${unit.documentId}, whose scopes partition the rest EXACTLY — every one of them is rendered IN FULL, with its evidence, in one of those packets. Nothing is dropped and nothing is capped: this run's \`plan/catalog.json\` records each unit's scope BY WORK ITEM ID, so the partition is addressable rather than asserted, and none of these are yours to write or to ground.`,
        "",
        "| carried by | obligations of this topic |",
        "| --- | --- |"
      );
      for (const carrier of [...byCarrier.keys()].sort(compareUnitIds)) lines.push(`| \`${carrier}\` | ${byCarrier.get(carrier)!} |`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** The owner row of an `owned-elsewhere` disposition. Exhaustive: the other two arms have no owner to name. */
function ownerOf(disposition: BindingDisposition): ObligationOwnership {
  switch (disposition.state) {
    case "owned-elsewhere":
      return disposition.owner;
    case "full":
      throw new Error("A fully rendered obligation has no other owner to name; it is written and grounded by this unit");
    case "out-of-scope":
      throw new Error("An obligation outside this unit's scope is accounted for by carrier, not by owner row");
  }
  return assertNever(disposition, "unit packet binding disposition");
}

/** The carrier of an `out-of-scope` disposition. Exhaustive for the same reason. */
function carrierOf(disposition: BindingDisposition): string {
  switch (disposition.state) {
    case "out-of-scope":
      return disposition.carrierUnitId;
    case "full":
      throw new Error("A fully rendered obligation has no carrier; this unit is the carrier");
    case "owned-elsewhere":
      throw new Error("An obligation this unit's scope covers is accounted for by owner row, not by carrier");
  }
  return assertNever(disposition, "unit packet binding disposition");
}

/**
 * Every evidence record the obligations this unit writes bind, in full, each saying which obligations it grounds.
 *
 * The back-reference is the other half of the 57B-453 fix: the obligation row names its evidence, and the evidence
 * record names its obligations, so neither direction has to be guessed. No record is clipped here. A record the RUN
 * bounded when it was captured says so with both byte counts and where the full bytes are retained — that is a
 * statement about the run's own capture policy, not this packet dropping something.
 */
function renderEvidence(
  unit: PlanCatalogUnit,
  input: UnitPacketInput,
  topics: readonly TopicCandidate[],
  evidence: ReadonlyMap<string, EvidenceItem>
): string {
  const groundedBy = new Map<string, string[]>();
  for (const [index, topic] of topics.entries()) {
    const reference = unit.topics[index]!;
    for (const binding of topic.bindings) {
      if (bindingDisposition(binding, reference, unit, input).state !== "full") continue;
      for (const id of binding.evidenceIds) {
        const list = groundedBy.get(id);
        if (list) list.push(binding.workItemId);
        else groundedBy.set(id, [binding.workItemId]);
      }
    }
  }
  const ids = [...groundedBy.keys()].sort((a, b) => a.localeCompare(b));
  const lines = [`## Evidence bound to the obligations this unit writes (${ids.length} record(s), all rendered in full)`, ""];
  if (ids.length === 0) {
    lines.push("No obligation this unit writes binds any evidence record. That is a statement about the obligation ledger,", "about ownership and about this unit's scope, not about this packet's bound: nothing was dropped to fit. An", "obligation another unit carries is listed above as a stub and its evidence is rendered in that unit's packet.", "");
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
 * R7a's coverage state, rendered by the same kind gate as the facet census and the unbound-evidence enumeration.
 *
 * The block itself is composed by `coverage-companion.ts`, so the appendix packet and the standalone companion
 * command cannot disagree about what this run's coverage state IS — they differ only in how much of each id list
 * they print, and the block always states the full size it was cut from.
 */
function coverageBlock(unit: PlanCatalogUnit, coverage: PacketCoverageFacts): string {
  return enumeratesUnboundEvidence(unit.kind) ? renderCoverageStateBlock(coverage) : "";
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

/**
 * One child's summary, as a parent packet renders it.
 *
 * Extracted and exported because `perUnitSummaryBytes` bounds exactly these bytes: the plan-time synthesis check
 * renders a worst case built from this block's allowance, and `draftUnit` refuses a summary whose block exceeds it.
 * Two spellings of "how big is a child summary" would be two bounds, and the one the author is graded against would
 * not be the one the plan budgeted.
 */
export function renderChildSummaryBlock(child: UnitSummary): string {
  const lines = [
    `### ${child.unitId} (${child.kind})`,
    "",
    `- covered topic(s): ${child.coveredTopicIds.join(", ") || "(none)"}`,
    `- content digest: ${child.contentDigest}; claims digest: ${child.claimsDigest}`,
    "",
    "Key statements:",
    ""
  ];
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
  return lines.join("\n");
}

/** The bytes one child summary costs a parent. What `perUnitSummaryBytes` bounds, in one place. */
export function childSummaryBlockBytes(child: UnitSummary): number {
  return Buffer.byteLength(renderChildSummaryBlock(child), "utf8");
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
  for (const child of children) lines.push(renderChildSummaryBlock(child));
  if (children.length === 0) {
    lines.push("This synthesis has no collected child. Nothing can be written from an empty summary set: draft and", "collect its children first.", "");
  }
  void unit;
  return lines.join("\n");
}
