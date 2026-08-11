import { join } from "node:path";
import type { AuditFinding } from "./assurance.ts";
import type {
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
} from "./types.ts";
import { exists } from "./util.ts";

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
  "notifications-and-exports": "external-calls"
};

/** Stable display order for fact-pack categories inside a section block. */
const FACT_CATEGORY_ORDER: FactPackCategory[] = ["entrypoints", "entities", "states", "config-keys", "jobs", "external-calls"];

/** Disposition order for the completeness header; statuses absent from the document are omitted. */
const STATUS_ORDER = ["found", "searched-not-found", "cannot-determine", "not-applicable", "in_progress", "pending"] as const;

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
  if (document.kind === "feature") {
    const blocks: PacketSection[] = [];
    for (const section of document.sections) {
      const items = orderWorkItems(relevant.filter((item) => item.reportSection === section.index));
      if (!items.length) continue;
      blocks.push({ key: `section ${section.index}`, section: section.index, heading: `Section ${section.index} — ${section.title}`, workItems: items, evidenceIds: unionEvidenceIds(items) });
    }
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
  factPacks: Record<string, FeatureFactPack>
): string {
  const sections = packetEvidenceForDocument(document, plan);
  const relevant = plan.items.filter((item) => item.requiredFor.includes(document.id));
  const factPack = document.kind === "feature" ? factPacks[featureKeyOf(document)] : undefined;
  const tracesById = new Map(traces.traces.map((trace) => [trace.id, trace]));
  const seenEvidence = new Map<string, string>();
  const seenTraces = new Map<string, string>();

  const parts: string[] = [];
  parts.push(`# Authoring packet — ${document.id}`);
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
    const traceBlock = renderTraces(block, tracesById, seenTraces);
    if (traceBlock) parts.push(traceBlock);
  }

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
    const categoryItems = factPack.items.filter((item) => item.category === category);
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
    const shown = items.slice(0, MAX_FACT_ROWS_PER_CATEGORY);
    for (const item of shown) lines.push(`- \`${item.name}\` — \`${item.filePath}:${item.line}${item.endLine && item.endLine !== item.line ? `-${item.endLine}` : ""}\``);
    const remainder = items.length - shown.length;
    if (remainder > 0) lines.push(`- … ${remainder} further ${category} item${remainder === 1 ? "" : "s"} in context/features/${featureKey}.factpack.json`);
  }
  if (coverage?.truncated) lines.push(`Truncated: ${coverage.note ?? "budget or cap reached"}`);
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
  return lines.join("\n");
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
    if (clipped) out.push(`…clipped; full excerpt: evidence.json id ${id}`);
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
