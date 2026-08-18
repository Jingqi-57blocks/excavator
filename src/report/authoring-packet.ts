import { join } from "node:path";
import type { ConditionInventory } from "../investigation/condition-inventory.ts";
import type { ReadCoverageItem } from "../investigation/read-coverage.ts";
import type { ReadObligation } from "../obligation/read-obligations.ts";
import { readingExposure, renderReadingBoundary } from "../investigation/read-residual-exposure.ts";
import type {
  AuditFinding,
  DocumentPlan,
  EvidenceItem,
  FactPackCategory,
  FactPackCoverage,
  FactPackItem,
  FeatureFactPack,
  InvestigationPlan,
  InvestigationWorkItem,
  SearchReceipt,
  SectionClaim,
  TraceCatalog,
  TraceRecord
} from "../base/types.ts";
import { exists } from "../base/util.ts";
import { consumableFactPackItems } from "../workset/factpack-view.ts";
import { boundEvidenceModelView } from "../investigation/evidence-store.ts";

/**
 * The authoring packet: a deterministic, model-free per-document rendering of the frozen investigation
 * knowledge, organized by the report section each work item is assigned to. Freeze writes one packet per
 * document under `context/authoring/`; the author reads a section's block before writing that section, so
 * the deterministic facts and frozen evidence that section must cover are already in hand.
 *
 * The packet renders frozen knowledge and nothing else — it copies no content that is not already in
 * `evidence.json`, `workitems.json`, `traces.json` or the feature fact pack. It treats the run's own
 * transport as the problem: knowledge that was mined but never reached the section that needed it. It
 * cannot deepen an investigation — knowledge the investigation never recorded cannot appear here.
 */

/** Ceilings for one inlined source excerpt, whichever is reached first; the honesty philosophy of factpack. */
const MAX_EXCERPT_LINES = 40;
const MAX_EXCERPT_CHARS = 2000;
/** Ceiling for one fact-pack category listing inside a section block; a remainder line carries the rest. */
const MAX_FACT_ROWS_PER_CATEGORY = 40;
/** The logic complement is deeper than the structural categories (tier 0 + tier 1 alone exceed 40). */
const MAX_LOGIC_ROWS_PER_CATEGORY = 120;

/**
 * Category-level map from investigation dimension to the fact-pack category it enumerates. It is derived
 * from the meaning of each dimension, not from any target's routes, tables or names, so it stays framework
 * neutral. Section attribution rides on each work item's own `reportSection` (assurance's canonical
 * numbering); this map deliberately does NOT reuse `FACT_PACK_SECTIONS`, which is the engineering-template
 * section-number table serving a different layer.
 */
export const DIMENSION_FACT_CATEGORY: Record<string, FactPackCategory> = {
  "states-and-lifecycle": "states",
  "ui-entrypoints": "entrypoints",
  "api-entrypoints": "entrypoints",
  "scheduled-entrypoints": "entrypoints",
  "entities-and-fields": "entities",
  "configuration": "config-keys",
  "background-work": "jobs",
  "files-and-integrations": "external-calls",
  "notifications-and-exports": "external-calls",
  // The behaviour dimensions carry the business/decision logic the six structural categories do not name;
  // the `logic` complement is their deterministic fact floor.
  "normal-flow": "logic",
  "decision-flow": "logic",
  "reversal-flow": "logic",
  "calculations-and-thresholds": "logic",
  "validation-and-duplicates": "logic",
  "authorization": "logic",
  "data-scope": "logic"
};

/** Stable display order for fact-pack categories inside a section block. */
const FACT_CATEGORY_ORDER: FactPackCategory[] = ["entrypoints", "entities", "states", "config-keys", "jobs", "external-calls", "logic"];

/** Disposition order for the completeness header; statuses absent from the document are omitted. */
const STATUS_ORDER = ["found", "searched-not-found", "cannot-determine", "not-applicable", "in_progress", "pending"] as const;

/**
 * What the reading-boundary block needs: the run's own denominator and its reconciliation. The block is
 * derived here rather than handed in pre-rendered so the packet scopes it to its own feature — the caller
 * holds one run-wide reconciliation, and a document must never show another feature's residual.
 */
export interface ReadingExposureSource {
  obligations: ReadObligation[];
  items: ReadCoverageItem[];
  /** Whether the obligations were relevance-annotated; without labels there is no partition to render. */
  annotated: boolean;
}

/**
 * One organizational block of a packet: a report section for feature documents, or the single project
 * block for overviews. `evidenceIds` is the union of the block's work-item evidence ids in first-seen
 * order — the derivation the renderer and the consumption advisory share so they cannot drift apart.
 */
export interface PacketSection {
  /** Stable key used in advisory messages and cross-section references, e.g. `section 4` or `project`. */
  key: string;
  /** Report section index for feature blocks; undefined for the overview single-level list. */
  section?: number;
  /** Section heading text (feature: the template section title; overview: the project label). */
  heading: string;
  /** Work items owning this block, in canonical order with open-origin items last. */
  workItems: InvestigationWorkItem[];
  /** Union of the block's work-item evidence ids, first-seen order across those work items. */
  evidenceIds: string[];
}

/**
 * The per-block skeleton of a document's packet: which work items and which evidence ids belong to each
 * block. Exported so the consumption advisory reconciles against exactly what the renderer laid out.
 *
 *  - feature documents: one block per template section that owns at least one work item (empty sections
 *    are omitted), in `document.sections` ascending order; work items are placed by their `reportSection`.
 *  - overview documents: project work items carry no `reportSection`, so they form one single-level block.
 */
export function packetEvidenceForDocument(document: DocumentPlan, plan: InvestigationPlan): PacketSection[] {
  const relevant = plan.items.filter((item) => item.requiredFor.includes(document.id));
  // prd feature docs carry fewer chapters than the canonical 1..12 work-item reportSection space, so a
  // section-keyed packet would silently drop items pinned to a chapter the prd template does not have (they
  // match no section block yet are not `undefined`, so the section loop and the trailing-`undefined` rescue
  // both miss them). Render every pinned item in one flat block instead — like the overview single block —
  // then keep the trailing logic-disposition block for the unpinned rescued-logic items. Nothing vanishes.
  if (document.kind === "feature" && document.audience === "prd") {
    const blocks: PacketSection[] = [];
    const pinned = orderWorkItems(relevant.filter((item) => item.reportSection !== undefined));
    if (pinned.length) blocks.push({ key: "feature", heading: "Feature investigation", workItems: pinned, evidenceIds: unionEvidenceIds(pinned) });
    const unassigned = orderWorkItems(relevant.filter((item) => item.reportSection === undefined));
    if (unassigned.length) blocks.push({ key: "logic-disposition", heading: "Logic disposition — rescued decision functions (place each where its behavior belongs)", workItems: unassigned, evidenceIds: unionEvidenceIds(unassigned) });
    return blocks;
  }
  if (document.kind === "feature") {
    const blocks: PacketSection[] = [];
    for (const section of document.sections) {
      const items = orderWorkItems(relevant.filter((item) => item.reportSection === section.index));
      if (!items.length) continue;
      blocks.push({ key: `section ${section.index}`, section: section.index, heading: `Section ${section.index} — ${section.title}`, workItems: items, evidenceIds: unionEvidenceIds(items) });
    }
    // Work items with no pinned report section (the forced logic-disposition items, and any open item that
    // never received one) would vanish from a section-keyed packet. Surface them in one trailing block so the
    // author cannot miss a rescued decision function; the author places each where its behavior belongs.
    const unassigned = orderWorkItems(relevant.filter((item) => item.reportSection === undefined));
    if (unassigned.length) blocks.push({ key: "logic-disposition", heading: "Logic disposition — rescued decision functions (place each where its behavior belongs)", workItems: unassigned, evidenceIds: unionEvidenceIds(unassigned) });
    return blocks;
  }
  const items = orderWorkItems(relevant);
  if (!items.length) return [];
  return [{ key: "project", heading: "Project investigation", workItems: items, evidenceIds: unionEvidenceIds(items) }];
}

/** Render one document's authoring packet as English Markdown. Pure and deterministic: same inputs, same bytes. */
export function buildAuthoringPacket(
  document: DocumentPlan,
  plan: InvestigationPlan,
  evidenceById: Map<string, EvidenceItem>,
  traces: TraceCatalog,
  factPacks: Record<string, FeatureFactPack>,
  /** Literal domain conditions found inside the opened windows (generation 5+). Optional and additive: when
   *  absent the packet is byte-identical to before, so older runs and callers are unaffected. Measured
   *  extraction of these conditions was ~0, which is why they are put in front of the author BEFORE writing
   *  rather than only reported as an audit residual afterwards. */
  conditions?: ConditionInventory,
  /** The reconciled read obligations, for the reading-boundary block (generation 5+). Optional and additive
   *  on the same terms as `conditions`: absent, the packet is byte-identical to before. Feature documents
   *  only — the partitions are feature-scoped by construction, so an overview has nothing to scope them to. */
  reading?: ReadingExposureSource,
  /** Latest immutable knowledge epoch. Optional so legacy/direct render callers retain their exact bytes. */
  epoch?: number
): string {
  const sections = packetEvidenceForDocument(document, plan);
  const relevant = plan.items.filter((item) => item.requiredFor.includes(document.id));
  const factPack = document.kind === "feature" ? factPacks[featureKeyOf(document)] : undefined;
  const tracesById = new Map(traces.traces.map((trace) => [trace.id, trace]));
  const seenEvidence = new Map<string, string>();
  const seenTraces = new Map<string, string>();

  const parts: string[] = [];
  parts.push(`# Authoring packet — ${document.id}`);
  if (epoch !== undefined) parts.push(`Sealed knowledge epoch: ${epoch}`);
  parts.push(
    "This packet renders the frozen investigation knowledge this document must cover, organized by report section. " +
    "It is a deterministic view of `evidence.json`, `workitems.json`, `traces.json` and the feature fact pack; it adds nothing that is not already frozen. " +
    "Write from each section's block: cover every listed work item, deterministic fact and evidence excerpt, or state explicitly why it does not apply."
  );
  parts.push(renderCompleteness(relevant));

  for (const block of sections) {
    parts.push(`## ${block.heading}`);
    parts.push(renderWorkItems(block.workItems));
    if (document.kind === "feature") {
      const facts = renderFacts(block.workItems, factPack, document);
      if (facts) parts.push(facts);
    }
    parts.push(renderEvidence(block, evidenceById, factPack, seenEvidence));
    const conditionBlock = renderConditions(block, conditions);
    if (conditionBlock) parts.push(conditionBlock);
    const traceBlock = renderTraces(block, tracesById, seenTraces);
    if (traceBlock) parts.push(traceBlock);
  }

  // A window opened during investigation but cited by no work item belongs to no section block, so its
  // conditions would vanish from the packet — the one thing this block exists to prevent. Render them once at
  // the end, unassigned, rather than dropping them (same "nothing vanishes" rule the prd block follows).
  const unassignedConditions = renderUnassignedConditions(sections, conditions);
  if (unassignedConditions) parts.push(unassignedConditions);
  const families = renderEnumFamilies(conditions);
  if (families) parts.push(families);
  // Last block in the packet, and deliberately so: everything above renders knowledge that was frozen, while
  // this renders the known unknowns. A boundary statement belongs after what it bounds.
  const boundary = renderReadingBlock(document, reading);
  if (boundary) parts.push(boundary);

  if (!sections.length) parts.push("No work item is required for this document.");
  return `${parts.join("\n\n")}\n`;
}

/**
 * Warning-level consumption advisory, self-gated on the packet file existing. For each document that has a
 * packet, it derives each block's should-cover evidence set, subtracts every evidence id any of the
 * document's claims already declares (a document-level consumption set, so evidence shared across sections
 * is never nagged twice), and emits one warning per block whose evidence the report left entirely unused.
 * It guards against a whole section ignoring its packet; it is silent when the shallow evidence was cited,
 * so it does not — and cannot — measure investigation depth.
 */
export async function auditAuthoringPacketConsumption(
  runDir: string,
  documents: DocumentPlan[],
  plan: InvestigationPlan,
  claimsByDocument: Map<string, Array<{ section: number; claim: SectionClaim }>>
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  for (const document of documents) {
    if (!await exists(join(runDir, "context", "authoring", `${document.id}.md`))) continue;
    const blocks = packetEvidenceForDocument(document, plan);
    if (!blocks.length) continue;
    const consumed = new Set<string>();
    for (const { claim } of claimsByDocument.get(document.id) ?? []) for (const id of claim.evidenceIds ?? []) consumed.add(id);
    for (const block of blocks) {
      const unconsumed = block.evidenceIds.filter((id) => !consumed.has(id));
      if (unconsumed.length) findings.push({ level: "warning", document: document.id, message: `authoring packet ${block.key} lists frozen evidence not consumed by any claim: ${unconsumed.join(", ")}` });
    }
  }
  return findings;
}

// --- rendering helpers ---

function renderCompleteness(items: InvestigationWorkItem[]): string {
  const byStatus = new Map<string, number>();
  for (const item of items) byStatus.set(item.status, (byStatus.get(item.status) ?? 0) + 1);
  const summary = STATUS_ORDER.filter((status) => byStatus.has(status)).map((status) => `${status} ${byStatus.get(status)}`).join(", ");
  const lines = [`## Completeness`, `Work items required for this document, by disposition: ${summary || "none"}.`];
  const searched = items.filter((item) => item.status === "searched-not-found");
  const cannot = items.filter((item) => item.status === "cannot-determine");
  if (searched.length) {
    lines.push("", "Searched but not found:");
    for (const item of searched) lines.push(`- \`${item.id}\` — ${item.searchScope?.trim() || item.reason?.trim() || "no scope recorded"}`);
  }
  if (cannot.length) {
    lines.push("", "Cannot determine:");
    for (const item of cannot) lines.push(`- \`${item.id}\` — ${item.reason?.trim() || "no reason recorded"}`);
  }
  return lines.join("\n");
}

function renderWorkItems(items: InvestigationWorkItem[]): string {
  const lines = ["### Work items"];
  for (const item of items) {
    lines.push(`- \`${item.id}\` — ${item.dimension} · ${item.status} · ${item.material ? "material" : "non-material"} · ${item.hypothesis}`);
    if (item.status !== "found") {
      const detail = item.searchScope?.trim() || item.reason?.trim();
      if (detail) lines.push(`  - ${item.status === "searched-not-found" ? "search scope" : "reason"}: ${detail}`);
    }
  }
  return lines.join("\n");
}

function renderFacts(items: InvestigationWorkItem[], factPack: FeatureFactPack | undefined, document: DocumentPlan): string | null {
  const categories: FactPackCategory[] = [];
  for (const category of FACT_CATEGORY_ORDER) {
    if (items.some((item) => DIMENSION_FACT_CATEGORY[item.dimension] === category) && !categories.includes(category)) categories.push(category);
  }
  if (!categories.length) return null;
  const lines = ["### Deterministic facts"];
  if (!factPack) {
    lines.push("No fact pack was produced for this feature; this section has no deterministic fact floor.");
    return lines.join("\n");
  }
  const key = featureKeyOf(document);
  for (const category of categories) {
    const coverage = factPack.coverage.find((entry) => entry.category === category);
    const categoryItems = consumableFactPackItems(factPack).filter((item) => item.category === category);
    lines.push("", renderFactCategory(category, coverage, categoryItems, key));
  }
  return lines.join("\n");
}

function renderFactCategory(category: FactPackCategory, coverage: FactPackCoverage | undefined, items: FactPackItem[], featureKey: string): string {
  const truncated = coverage?.truncated ? "yes" : "no";
  const lines = [`#### ${category} — ${items.length} item${items.length === 1 ? "" : "s"}, truncated ${truncated}`];
  if (!items.length) {
    lines.push(coverage?.method === "none"
      ? "No method was available for this category in this run; absence here is not evidence of absence in the code."
      : "No item of this category was found inside the feature boundary.");
  } else {
    const rowCap = category === "logic" ? MAX_LOGIC_ROWS_PER_CATEGORY : MAX_FACT_ROWS_PER_CATEGORY;
    const shown = items.slice(0, rowCap);
    for (const item of shown) lines.push(`- \`${item.name}\` — \`${item.filePath}:${item.line}${item.endLine && item.endLine !== item.line ? `-${item.endLine}` : ""}\`${item.signal ? ` · rescued: ${item.signal}` : ""}`);
    const remainder = items.length - shown.length;
    if (remainder > 0) lines.push(`- … view bound reached; ${remainder} additional ${category} item${remainder === 1 ? "" : "s"} remain counted by the category summary`);
  }
  if (coverage?.truncated) lines.push(`Truncated: ${coverage.note ?? "budget or cap reached"}`);
  return lines.join("\n");
}

/**
 * The literal domain conditions sitting inside the windows this block cites. Rendered BEFORE writing, because
 * the measured extraction of these conditions was ~0 when they were only reported afterwards as an audit
 * residual: an author cannot state a threshold they never noticed. Consumption is deliberately absent — no
 * claim exists yet at freeze — so this is a checklist, not a verdict.
 */
function renderConditions(block: PacketSection, conditions: ConditionInventory | undefined): string {
  if (!conditions?.items.length || !block.evidenceIds.length) return "";
  const windows = new Set(block.evidenceIds);
  // An excluded site is listed in the inventory but never put in front of the author: the packet is where
  // "state every condition that carries reportable behaviour" turns a framework protocol value into a
  // sentence written for a counter. Measured: three such values produced three near-worthless sentences.
  const mine = conditions.items.filter((item) => windows.has(item.windowId) && !item.excluded);
  if (!mine.length) return "";
  const lines = ["### Literal conditions inside these windows"];
  lines.push(
    "Recovered mechanically from the opened source windows. State every one that carries reportable behavior " +
    "and cite the window it came from; if a condition is not reportable behavior, leave it out deliberately rather than by omission."
  );
  for (const item of mine) lines.push(`- \`${item.expression}\` — ${item.path}:${item.line}`);
  return lines.join("\n");
}

/**
 * String comparisons regrouped per field. This is the highest-information form of the inventory: six separate
 * `repr.View == "..."` lines say far less than one line naming the five values that field accepts, and "which
 * modes/types exist" is a question reports are routinely asked and routinely miss. Rendered once per document
 * because a field's values usually span several windows.
 */
function renderEnumFamilies(conditions: ConditionInventory | undefined): string {
  const families = (conditions?.families ?? []).filter((family) => family.values.length > 1);
  if (!families.length) return "";
  const lines = ["## Value sets compared in these windows (enum families)"];
  lines.push(
    "Each line is one field and the literal values the opened code compares it against — the modes, types or " +
    "states that exist. State the sets that carry reportable behavior; a set stated as a list is usually clearer than prose."
  );
  for (const family of families) {
    lines.push(`- \`${family.field}\` ∈ { ${family.values.map((value) => `\`${value}\``).join(", ")} } — ${family.path}:${family.lines.join(",")}`);
  }
  return lines.join("\n");
}

/**
 * The reading boundary for THIS document's feature. Overviews get nothing: the strong partition is
 * feature-scoped by construction (its `retained` half comes from a feature boundary, its anchor half from a
 * feature's vocabulary), so an overview could only be given every feature's residual at once — a dump, not
 * a boundary. Both audiences of one feature render it: each packet is read in its own authoring pass, and
 * nothing counts the block, so showing it twice creates no second obligation.
 */
function renderReadingBlock(document: DocumentPlan, reading: ReadingExposureSource | undefined): string {
  if (!reading || document.kind !== "feature") return "";
  return renderReadingBoundary(readingExposure({ ...reading, featureKey: featureKeyOf(document) }));
}

/** Conditions whose window no section block claims — rendered once, unassigned, so none is silently dropped. */
function renderUnassignedConditions(sections: PacketSection[], conditions: ConditionInventory | undefined): string {
  if (!conditions?.items.length) return "";
  const assigned = new Set(sections.flatMap((block) => block.evidenceIds));
  const orphans = conditions.items.filter((item) => !assigned.has(item.windowId) && !item.excluded);
  if (!orphans.length) return "";
  const lines = ["## Literal conditions in opened windows not linked to a section"];
  lines.push(
    "These windows were read during the investigation but no work item cites them, so they belong to no " +
    "section block above. Place each condition that carries reportable behavior where its behavior belongs, and cite its window."
  );
  for (const item of orphans) lines.push(`- \`${item.expression}\` — ${item.path}:${item.line}`);
  return lines.join("\n");
}

function renderEvidence(block: PacketSection, evidenceById: Map<string, EvidenceItem>, factPack: FeatureFactPack | undefined, seen: Map<string, string>): string {
  const lines = ["### Evidence"];
  if (!block.evidenceIds.length) {
    lines.push("No evidence is linked to this section's work items.");
    return lines.join("\n");
  }
  for (const id of block.evidenceIds) {
    const priorBlock = seen.get(id);
    if (priorBlock && priorBlock !== block.key) {
      lines.push(`- \`${id}\` — see the ${priorBlock} block`);
      continue;
    }
    seen.set(id, block.key);
    lines.push(...renderEvidenceItem(id, evidenceById.get(id)));
  }
  return boundEvidenceModelView(lines.join("\n"));
}

function renderEvidenceItem(id: string, item: EvidenceItem | undefined): string[] {
  if (!item) return [`- \`${id}\` — (not present in the evidence catalog)`];
  if (id.startsWith("FACT-")) {
    const data = item.data as { category?: string; coverage?: FactPackCoverage } | undefined;
    const coverage = data?.coverage;
    return [`- \`${id}\` — fact pack ${data?.category ?? "?"}: ${coverage?.itemCount ?? 0} item(s), truncated ${coverage?.truncated ? "yes" : "no"} (items listed under Deterministic facts)`];
  }
  if (item.kind === "search") {
    const data = item.data as SearchReceipt | undefined;
    const matches = Array.isArray(data?.matches) ? data!.matches.length : 0;
    return [`- \`${id}\` — search "${(data?.terms ?? []).join(", ")}": ${data?.candidateFiles ?? 0} candidate file(s), ${matches} match(es)${data?.truncated ? ", truncated" : ""}`];
  }
  if (item.content != null) {
    const { text, clipped } = clipExcerpt(item.content);
    const out = [`- \`${id}\` — ${item.title}${item.path ? ` (\`${item.path}:${item.startLine}-${item.endLine}\`)` : ""}`, "", "```", text, "```"];
    if (clipped) out.push(item.contentRef
      ? `…clipped in this model view; an immutable full machine record is retained audit-only (${item.contentDigest})`
      : `…clipped in this model view; the full machine record remains audit-only under evidence id ${id}`);
    return out;
  }
  return [`- \`${id}\` — ${item.kind}: ${item.title}`];
}

function renderTraces(block: PacketSection, tracesById: Map<string, TraceRecord>, seen: Map<string, string>): string | null {
  const ids: string[] = [];
  const collected = new Set<string>();
  for (const item of block.workItems) for (const id of item.traceIds) if (!collected.has(id)) { collected.add(id); ids.push(id); }
  if (!ids.length) return null;
  const lines = ["### Traces"];
  for (const id of ids) {
    const priorBlock = seen.get(id);
    if (priorBlock && priorBlock !== block.key) { lines.push(`- \`${id}\` — see the ${priorBlock} block`); continue; }
    seen.set(id, block.key);
    const trace = tracesById.get(id);
    if (!trace) { lines.push(`- \`${id}\` — (not present in the trace catalog)`); continue; }
    lines.push(`- \`${id}\` — ${trace.title} · ${trace.status} · ${trace.steps.length} step${trace.steps.length === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}

// --- pure helpers ---

/** Canonical order with open-origin items last; `items` is already filtered from `plan.items` in-order. */
function orderWorkItems(items: InvestigationWorkItem[]): InvestigationWorkItem[] {
  return [...items.filter((item) => item.origin !== "open"), ...items.filter((item) => item.origin === "open")];
}

function unionEvidenceIds(items: InvestigationWorkItem[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of items) for (const id of item.evidenceIds) if (!seen.has(id)) { seen.add(id); ids.push(id); }
  return ids;
}

/** The feature cache key embedded in a feature document id: `feature-<key>-<audience>`. */
function featureKeyOf(document: DocumentPlan): string {
  return document.id.replace(/^feature-/, "").replace(new RegExp(`-${document.audience}$`), "");
}

/** Clip a source excerpt to the first of the line/character ceiling; a single over-long line is hard-clipped. */
function clipExcerpt(content: string): { text: string; clipped: boolean } {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let chars = 0;
  let clipped = false;
  for (const line of lines) {
    if (kept.length >= MAX_EXCERPT_LINES) { clipped = true; break; }
    const projected = chars + line.length + (kept.length ? 1 : 0);
    if (projected > MAX_EXCERPT_CHARS) {
      if (kept.length === 0) kept.push(line.slice(0, MAX_EXCERPT_CHARS));
      clipped = true;
      break;
    }
    kept.push(line);
    chars = projected;
  }
  if (!clipped && kept.length < lines.length) clipped = true;
  return { text: kept.join("\n"), clipped };
}
