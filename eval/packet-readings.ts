// Deterministic, read-only projection of one completed run's AUTHORING PACKETS into byte readings.
//
// What it answers (57B-441 R0 baseline): per document — how many sections, how many claims, how many packet
// bytes, how many audit errors/warnings; and run-wide — how many of those packet bytes are the SAME rendered
// block appearing in more than one packet. That last number is the "改动前" denominator for the epic's
// near-linear-growth gate: today every document's packet re-renders the shared knowledge it needs in full.
//
// Two rules this file exists to hold:
//
//  1. Block structure is NEVER re-parsed here. Every attributable chunk is produced by calling the renderer's
//     own functions (`packetEvidenceForDocument`, `renderWorkItems`, `renderEvidenceItem`, `renderTraces`) and
//     then LOCATED in the packet bytes on disk. A second packet parser would drift from the renderer, and the
//     day it drifted nothing would go red. If the renderer's line shape changes, the located chunk disappears
//     and the unit lands in the visible `absent` bucket instead of quietly reading zero.
//  2. Every byte of every packet lands in exactly one visible bucket. `work-item` / `evidence` / `trace` /
//     `factpack` hold the bytes attributable to a stable id; `anchor-line` holds an id's anchor line that is not
//     part of its full rendered chunk (the renderer's cross-block "see the X block" form, or an anchor whose
//     chunk was byte-bounded away); `unattributed` holds everything else — headings, the intro, the completeness
//     header, condition and reading-boundary blocks, and the joins between blocks. `unattributed` is counted in
//     the duplication denominator, never excluded to flatter the ratio. The bucket sum is asserted equal to the
//     packet's byte length, so there is no fourth state to hide in.
//
// The `factpack` kind exists because the deterministic-fact listings are the one large packet region whose rows
// carry no id of their own (a `FactPackItem` is keyed by name + path + line). Left unattributed, the duplication
// number would be a structural LOWER BOUND on exactly the documents where the epic expects quadratic growth —
// feature packets. So a fact listing is attributed to `factpack:<featureKey>:<category>`, the identity of the
// block `renderFactCategory` renders. Judging a gate on `duplicateBytes` versus on the two series
// (`duplicateBytes`, `unattributedBytes`) stays a separate decision; this only makes both of them possible.
//
// A fact listing is also the one block the renderer repeats WITHIN one packet — every section block whose work
// items map to a category re-renders that category's rows in full. Those repeats are attributed too, and their
// count is reported per document in `repeatedUnits`, because within-packet repetition is the same waste the
// cross-packet number measures.
//
// Zero model calls, never writes, reads only the run directory. Any input it cannot project is a named throw:
// there is no code path that returns a zero or an empty list because a file was missing.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AuditFinding, DocumentPlan, EvidenceItem, FactPackCategory, FeatureFactPack, InvestigationPlan, RunManifest, SectionClaimsFile, TraceCatalog, TraceRecord } from "../src/base/types.ts";
import {
  DIMENSION_FACT_CATEGORY,
  featureKeyOf,
  packetEvidenceForDocument,
  renderEvidenceItem,
  renderFactCategory,
  renderTraces,
  renderWorkItems,
  type PacketSection
} from "../src/report/authoring-packet.ts";
import type { InvestigationWorkItem } from "../src/base/types.ts";
import { consumableFactPackItems, requireFactPackV2 } from "../src/workset/factpack-view.ts";
import type { ReadCoverageReport } from "../src/investigation/read-coverage.ts";
import { sha256 } from "../src/base/util.ts";

/** The stable-id kinds a packet renders as its own block. */
export type PacketUnitKind = "work-item" | "evidence" | "trace" | "factpack";

/** Where a unit's own rendered chunk was found in the packet. Every unit lands in exactly one of these. */
export type PacketUnitOutcome = "full" | "anchor-only" | "absent";

export const PACKET_UNIT_KINDS: PacketUnitKind[] = ["work-item", "evidence", "trace", "factpack"];

/** Byte buckets over one packet; they sum to `packetBytes` by construction and that is asserted. */
export interface PacketByteBuckets {
  "work-item": number;
  evidence: number;
  trace: number;
  /** Deterministic-fact listings, attributed to `factpack:<featureKey>:<category>`. */
  factpack: number;
  /** An id's anchor line that is not part of its full chunk: a cross-block back reference, or a bounded tail. */
  "anchor-line": number;
  /** Headings, intro, completeness, condition/reading blocks, block joins — no stable id. */
  unattributed: number;
}

export interface DocumentPacketReading {
  documentId: string;
  kind: string;
  audience: string;
  /** Sections the manifest plans for this document. */
  sections: number;
  /** Claim entries across this document's `claims/<id>/*.json` files. */
  claims: number;
  /** Byte length of `context/authoring/<id>.md`. */
  packetBytes: number;
  /**
   * sha256 of those bytes. The buckets alone cannot see a same-length edit inside `unattributed`, so without
   * this the baseline would carry a region no assertion covers.
   */
  packetDigest: string;
  /** Renderer blocks the packet was laid out from (`packetEvidenceForDocument`). */
  blocks: number;
  buckets: PacketByteBuckets;
  units: { total: number; full: number; anchorOnly: number; absent: number };
  /** Every unit the projection could not locate at all — named, never silently dropped. */
  absentUnits: Array<{ kind: PacketUnitKind; id: string }>;
  /** Units whose full chunk the renderer wrote more than once into THIS packet, with the occurrence count. */
  repeatedUnits: Array<{ kind: PacketUnitKind; id: string; occurrences: number }>;
  /** Whether this document had a fact pack to render from: feature documents only. */
  factPack: "present" | "absent" | "not-applicable";
  auditErrors: number;
  auditWarnings: number;
}

/** One stable id and the packets it was rendered into. `duplicateBytes` is everything after the first packet. */
export interface DuplicatedUnit {
  kind: PacketUnitKind;
  id: string;
  packets: number;
  /** Attributed bytes in each packet that carries it, in manifest document order. */
  bytes: number[];
  documentIds: string[];
  duplicateBytes: number;
}

export interface PacketKindTotals { units: number; bytes: number; duplicateBytes: number; }

export interface PacketDuplication {
  /** Denominator: every packet byte in the run, including `unattributed`. */
  totalPacketBytes: number;
  duplicateBytes: number;
  /** duplicateBytes / totalPacketBytes, rounded to 6 decimals so the value is byte-stable across reruns. */
  duplicateRatio: number;
  unitsTotal: number;
  unitsDuplicated: number;
  byKind: Record<PacketUnitKind, PacketKindTotals>;
  anchorLineBytes: number;
  unattributedBytes: number;
  /**
   * EVERY duplicated unit, sorted by duplicate bytes descending (kind then id as tiebreak) so the head of the
   * list is the top offender. Deliberately uncapped: a cap would be a place for the number to be wrong.
   */
  duplicatedUnits: DuplicatedUnit[];
}

/**
 * The run's own read-coverage residual, copied field for field from `coverage/read-residual.json`. No semantics
 * are added here: the file already says that "read coverage complete" never means "nothing was missed", and the
 * baseline's job is to record what today's pipeline leaves unread so a later gate has a before-value to compare
 * against. A missing or malformed file is a named failure, not a zero.
 */
export interface ReadCoverageReading {
  version: string;
  consumptionEvaluated: boolean;
  /** Residual entries in the file. */
  items: number;
  /** Those entries tallied by their own `status` field, keys sorted. */
  itemsByStatus: Record<string, number>;
  summary: {
    counted: number;
    covered: number;
    partial: number;
    notOpened: number;
    cannotDetermine: number;
    obligationLines: number;
    openedLines: number;
    uncoveredLines: number;
    openedNotConsumed: number;
    gatedNotOpened: number;
  };
  /** The anchor-label split, or the literal "absent" when the run's obligations carried no labels. */
  notOpenedByAttribution: Record<string, number> | "absent";
  notOpenedLinesByAttribution: Record<string, number> | "absent";
}

export interface PacketReadings {
  version: 1;
  runId: string;
  snapshotId: string;
  knowledgeEpoch: number;
  documents: DocumentPacketReading[];
  totals: {
    documents: number;
    sections: number;
    claims: number;
    packetBytes: number;
    auditErrors: number;
    auditWarnings: number;
    auditFindings: number;
  };
  /** Audit findings whose `document` is not a manifest document (e.g. `condition-coverage`) — visible, not dropped. */
  auditUnscoped: { errors: number; warnings: number; scopes: string[] };
  readCoverage: ReadCoverageReading;
  duplication: PacketDuplication;
}

const ERR = "packet readings";

function fail(message: string): never {
  throw new Error(`${ERR}: ${message}`);
}

function readJsonFile<T>(path: string, what: string): T {
  if (!existsSync(path)) fail(`${what} is missing at ${relLabel(path)}`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail(`${what} at ${relLabel(path)} could not be read: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    fail(`${what} at ${relLabel(path)} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Path label for messages: the last two segments, so a message never depends on where the run dir lives. */
function relLabel(path: string): string {
  const parts = path.split("/");
  return parts.slice(Math.max(0, parts.length - 2)).join("/");
}

export function extractPacketReadings(runDir: string): PacketReadings {
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) fail(`${runDir} is not a directory`);
  const manifest = readJsonFile<RunManifest>(join(runDir, "run.json"), "run.json");
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) fail("run.json has no documents");
  if (typeof manifest.id !== "string" || !manifest.id) fail("run.json has no run id");
  if (!manifest.snapshot || typeof manifest.snapshot.id !== "string" || !manifest.snapshot.id) fail("run.json has no snapshot id");
  if (typeof manifest.knowledgeEpoch !== "number") fail(`run ${manifest.id} has no knowledgeEpoch; the projection reads packets, which only exist after freeze`);

  const plan = readJsonFile<InvestigationPlan>(join(runDir, "workitems.json"), "workitems.json");
  if (!Array.isArray(plan.items)) fail("workitems.json has no items array");
  const evidenceCatalog = readJsonFile<{ evidence: EvidenceItem[] }>(join(runDir, "evidence.json"), "evidence.json");
  if (!Array.isArray(evidenceCatalog.evidence)) fail("evidence.json has no evidence array");
  const traces = readJsonFile<TraceCatalog>(join(runDir, "traces.json"), "traces.json");
  if (!Array.isArray(traces.traces)) fail("traces.json has no traces array");
  const audit = readJsonFile<{ findings: AuditFinding[] }>(join(runDir, "audit", "audit.json"), "audit/audit.json");
  if (!Array.isArray(audit.findings)) fail("audit/audit.json has no findings array");
  const readCoverage = readCoverageReading(runDir);

  const evidenceById = new Map(evidenceCatalog.evidence.map((item) => [item.id, item]));
  const tracesById = new Map(traces.traces.map((trace) => [trace.id, trace]));
  const documentIds = new Set(manifest.documents.map((document) => document.id));
  const auditByDocument = new Map<string, { errors: number; warnings: number }>();
  const unscoped = { errors: 0, warnings: 0, scopes: new Set<string>() };
  for (const finding of audit.findings) {
    if (finding.level !== "error" && finding.level !== "warning") fail(`audit finding for ${finding.document} has unknown level ${JSON.stringify(finding.level)}`);
    if (!documentIds.has(finding.document)) {
      unscoped.scopes.add(finding.document);
      if (finding.level === "error") unscoped.errors += 1; else unscoped.warnings += 1;
      continue;
    }
    const bucket = auditByDocument.get(finding.document) ?? { errors: 0, warnings: 0 };
    if (finding.level === "error") bucket.errors += 1; else bucket.warnings += 1;
    auditByDocument.set(finding.document, bucket);
  }

  // Per-unit occurrences across packets, in manifest document order (the canonical packet order).
  const occurrences = new Map<string, DuplicatedUnit>();
  const documents: DocumentPacketReading[] = [];
  for (const document of manifest.documents) {
    const reading = projectDocument(runDir, document, plan, evidenceById, tracesById, auditByDocument.get(document.id) ?? { errors: 0, warnings: 0 }, occurrences);
    documents.push(reading);
  }

  const totalPacketBytes = documents.reduce((sum, document) => sum + document.packetBytes, 0);
  const duplicatedUnits = [...occurrences.values()]
    .filter((unit) => unit.packets > 1)
    .sort((a, b) => b.duplicateBytes - a.duplicateBytes || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const duplicateBytes = duplicatedUnits.reduce((sum, unit) => sum + unit.duplicateBytes, 0);
  const byKind = Object.fromEntries(PACKET_UNIT_KINDS.map((kind) => [kind, { units: 0, bytes: 0, duplicateBytes: 0 }])) as Record<PacketUnitKind, PacketKindTotals>;
  for (const unit of occurrences.values()) {
    const totals = byKind[unit.kind];
    totals.units += 1;
    totals.bytes += unit.bytes.reduce((sum, value) => sum + value, 0);
    totals.duplicateBytes += unit.duplicateBytes;
  }

  return {
    version: 1,
    runId: manifest.id,
    snapshotId: manifest.snapshot.id,
    knowledgeEpoch: manifest.knowledgeEpoch,
    documents,
    totals: {
      documents: documents.length,
      sections: documents.reduce((sum, document) => sum + document.sections, 0),
      claims: documents.reduce((sum, document) => sum + document.claims, 0),
      packetBytes: totalPacketBytes,
      auditErrors: documents.reduce((sum, document) => sum + document.auditErrors, 0) + unscoped.errors,
      auditWarnings: documents.reduce((sum, document) => sum + document.auditWarnings, 0) + unscoped.warnings,
      auditFindings: audit.findings.length
    },
    auditUnscoped: { errors: unscoped.errors, warnings: unscoped.warnings, scopes: [...unscoped.scopes].sort() },
    readCoverage,
    duplication: {
      totalPacketBytes,
      duplicateBytes,
      duplicateRatio: ratio(duplicateBytes, totalPacketBytes),
      unitsTotal: occurrences.size,
      unitsDuplicated: duplicatedUnits.length,
      byKind,
      anchorLineBytes: documents.reduce((sum, document) => sum + document.buckets["anchor-line"], 0),
      unattributedBytes: documents.reduce((sum, document) => sum + document.buckets.unattributed, 0),
      duplicatedUnits
    }
  };
}

/** Six decimals: enough to read, few enough that the value is byte-identical on a rerun. */
function ratio(part: number, whole: number): number {
  if (whole === 0) fail("cannot form a duplication ratio over zero packet bytes");
  return Number((part / whole).toFixed(6));
}

interface LocatedRange { start: number; end: number; kind: PacketUnitKind; id: string; anchorOnly: boolean; }

function projectDocument(
  runDir: string,
  document: DocumentPlan,
  plan: InvestigationPlan,
  evidenceById: Map<string, EvidenceItem>,
  tracesById: Map<string, TraceRecord>,
  auditCounts: { errors: number; warnings: number },
  occurrences: Map<string, DuplicatedUnit>
): DocumentPacketReading {
  if (!Array.isArray(document.sections) || document.sections.length === 0) fail(`document ${document.id} has no sections`);
  const packetPath = join(runDir, "context", "authoring", `${document.id}.md`);
  if (!existsSync(packetPath)) fail(`document ${document.id} has no authoring packet at context/authoring/${basename(packetPath)}`);
  const packet = readFileSync(packetPath);
  if (packet.length === 0) fail(`the authoring packet for ${document.id} is empty (0 bytes)`);

  const blocks = packetEvidenceForDocument(document, plan);
  const factPack = loadFactPack(runDir, document);
  const units = unitsOf(document, blocks, evidenceById, tracesById, factPack.pack);
  const ranges: LocatedRange[] = [];
  const outcomes: Array<{ kind: PacketUnitKind; id: string; outcome: PacketUnitOutcome; bytes: number; occurrences: number }> = [];

  for (const unit of units) {
    const chunk = Buffer.from(unit.chunk, "utf8");
    const chunkHits = findAll(packet, chunk);
    // A unit keyed by a unique id is rendered at one site, so a second hit means the bytes cannot be attributed
    // and is a named failure. A fact listing is different by construction: the renderer re-renders a category in
    // every section block that maps to it, so every hit is attributed and the count is reported.
    if (!unit.repeatable && chunkHits.length > 1) fail(`document ${document.id}: the rendered chunk for ${unit.kind} ${unit.id} occurs ${chunkHits.length} times, so its bytes cannot be attributed`);
    let bytes = 0;
    for (const hit of chunkHits) {
      ranges.push({ start: hit, end: hit + chunk.length, kind: unit.kind, id: unit.id, anchorOnly: false });
      bytes += chunk.length;
    }

    // Extra anchor lines: the renderer's cross-block "see the X block" form, a completeness row, or a tail the
    // byte bound cut. Only id-line units have an anchor; a fact listing opens with its own `####` heading.
    if (unit.anchor !== null) {
      for (const lineStart of findAll(packet, Buffer.from(`\n${unit.anchor}`, "utf8")).map((index) => index + 1)) {
        if (chunkHits.some((hit) => lineStart >= hit && lineStart < hit + chunk.length)) continue;
        const newline = packet.indexOf(0x0a, lineStart);
        const end = newline === -1 ? packet.length : newline;
        ranges.push({ start: lineStart, end, kind: unit.kind, id: unit.id, anchorOnly: true });
        bytes += end - lineStart;
      }
    }
    const outcome: PacketUnitOutcome = chunkHits.length ? "full" : bytes > 0 ? "anchor-only" : "absent";
    outcomes.push({ kind: unit.kind, id: unit.id, outcome, bytes, occurrences: chunkHits.length });
    if (bytes > 0) record(occurrences, unit.kind, unit.id, document.id, bytes);
  }

  const buckets = bucketize(document.id, packet.length, ranges);
  return {
    documentId: document.id,
    kind: document.kind,
    audience: document.audience,
    sections: document.sections.length,
    claims: countClaims(runDir, document.id),
    packetBytes: packet.length,
    packetDigest: sha256(packet),
    blocks: blocks.length,
    buckets,
    units: {
      total: outcomes.length,
      full: outcomes.filter((unit) => unit.outcome === "full").length,
      anchorOnly: outcomes.filter((unit) => unit.outcome === "anchor-only").length,
      absent: outcomes.filter((unit) => unit.outcome === "absent").length
    },
    absentUnits: outcomes.filter((unit) => unit.outcome === "absent").map((unit) => ({ kind: unit.kind, id: unit.id })),
    repeatedUnits: outcomes.filter((unit) => unit.occurrences > 1).map((unit) => ({ kind: unit.kind, id: unit.id, occurrences: unit.occurrences })),
    factPack: factPack.state,
    auditErrors: auditCounts.errors,
    auditWarnings: auditCounts.warnings
  };
}

/** Turn the located ranges into byte buckets, refusing to double count and refusing to lose a byte. */
function bucketize(documentId: string, packetBytes: number, ranges: LocatedRange[]): PacketByteBuckets {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const buckets: PacketByteBuckets = { "work-item": 0, evidence: 0, trace: 0, factpack: 0, "anchor-line": 0, unattributed: 0 };
  let previous: LocatedRange | null = null;
  let attributed = 0;
  for (const range of sorted) {
    if (previous && range.start < previous.end) {
      fail(`document ${documentId}: attributed ranges overlap (${previous.kind} ${previous.id} [${previous.start},${previous.end}) and ${range.kind} ${range.id} [${range.start},${range.end}))`);
    }
    const size = range.end - range.start;
    if (size <= 0) fail(`document ${documentId}: ${range.kind} ${range.id} located an empty range at ${range.start}`);
    if (range.anchorOnly) buckets["anchor-line"] += size; else buckets[range.kind] += size;
    attributed += size;
    previous = range;
  }
  if (attributed > packetBytes) fail(`document ${documentId}: attributed ${attributed} bytes of a ${packetBytes}-byte packet`);
  buckets.unattributed = packetBytes - attributed;
  const sum = buckets["work-item"] + buckets.evidence + buckets.trace + buckets.factpack + buckets["anchor-line"] + buckets.unattributed;
  if (sum !== packetBytes) fail(`document ${documentId}: buckets sum to ${sum} but the packet is ${packetBytes} bytes`);
  return buckets;
}

function record(occurrences: Map<string, DuplicatedUnit>, kind: PacketUnitKind, id: string, documentId: string, bytes: number): void {
  const key = `${kind}:${id}`;
  const existing = occurrences.get(key);
  if (!existing) {
    occurrences.set(key, { kind, id, packets: 1, bytes: [bytes], documentIds: [documentId], duplicateBytes: 0 });
    return;
  }
  existing.packets += 1;
  existing.bytes.push(bytes);
  existing.documentIds.push(documentId);
  // Duplicate bytes are everything after the FIRST packet that carried the unit. With equal renders this is
  // exactly the issue's (k-1) x blockBytes; when a later packet renders it at a different size, this counts
  // the bytes that were actually spent again rather than assuming they matched.
  existing.duplicateBytes += bytes;
}

interface PacketUnit {
  kind: PacketUnitKind;
  id: string;
  chunk: string;
  /** The `- \`id\`` line the renderer opens this unit with, or null for a unit that has no id line. */
  anchor: string | null;
  /** Whether the renderer legitimately writes this chunk more than once into one packet. */
  repeatable: boolean;
}

/**
 * The units a document's packet renders, produced by the renderer itself — one call per unit, so no formatting
 * rule is restated here. `renderWorkItems` / `renderTraces` render a whole block, so they are invoked with a
 * single member and their own heading line is sliced off; the slice asserts the heading it removed.
 */
function unitsOf(
  document: DocumentPlan,
  blocks: PacketSection[],
  evidenceById: Map<string, EvidenceItem>,
  tracesById: Map<string, TraceRecord>,
  pack: FeatureFactPack | null
): PacketUnit[] {
  const units: PacketUnit[] = [];
  const seen = new Set<string>();
  const push = (kind: PacketUnitKind, id: string, chunk: string, options: { anchored: boolean; repeatable: boolean }): void => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    units.push({ kind, id, chunk, anchor: options.anchored ? anchorOf(kind, id, chunk) : null, repeatable: options.repeatable });
  };
  const idLine = { anchored: true, repeatable: false };
  for (const block of blocks) {
    for (const item of block.workItems) push("work-item", item.id, withoutHeading(renderWorkItems([item]), `work-item ${item.id}`), idLine);
    for (const id of block.evidenceIds) push("evidence", id, renderEvidenceItem(id, evidenceById.get(id)).join("\n"), idLine);
    for (const item of block.workItems) {
      for (const traceId of item.traceIds ?? []) {
        const rendered = renderTraces(singleTraceBlock(traceId), tracesById, new Map());
        if (rendered === null) fail(`the renderer produced no trace block for ${traceId}`);
        push("trace", traceId, withoutHeading(rendered, `trace ${traceId}`), idLine);
      }
    }
    // A block renders a fact category iff one of its work items maps to that category. That one predicate is
    // mirrored here, over the renderer's own exported dimension table, rather than the whole selection. What the
    // readings then show if the renderer and this mirror diverge, stated as measured, not as hoped:
    //
    //   - the renderer STOPS writing a listing this still enumerates -> the unit lands in `absentUnits` and the
    //     `factpack` bucket falls;
    //   - the renderer writes an EXTRA copy of a category some block already maps to -> every copy is attributed,
    //     so the bucket RISES and that unit's `repeatedUnits` occurrence count goes up;
    //   - the renderer writes a listing for a category NO block maps to -> this never enumerates it, so those
    //     bytes land in `unattributed` and nothing is named.
    //
    // All three are visible in the readings. Visible is not the same as red: on a frozen fixture packet a
    // divergence in the SELECTION predicate moves no number here at all, because the checked-in bytes were
    // rendered by the older renderer and both sides of the disagreement still agree with each other. That blind
    // spot is covered by `packet-fixture-freshness.test.ts`, which re-renders each fixture packet with the
    // current renderer and compares bytes — the layer where this rot actually happens.
    if (!pack) continue;
    const key = featureKeyOf(document);
    for (const category of categoriesOf(block)) {
      const coverage = pack.coverage.find((entry) => entry.category === category);
      const items = consumableFactPackItems(pack).filter((item) => item.category === category);
      push("factpack", `factpack:${key}:${category}`, renderFactCategory(category, coverage, items, key), { anchored: false, repeatable: true });
    }
  }
  return units;
}

/** The fact categories one block's work items map to, via the renderer's own dimension table. */
function categoriesOf(block: PacketSection): FactPackCategory[] {
  const categories: FactPackCategory[] = [];
  for (const item of block.workItems) {
    const category = DIMENSION_FACT_CATEGORY[item.dimension];
    if (category && !categories.includes(category)) categories.push(category);
  }
  return categories;
}

/**
 * The document's fact pack, if it has one. Only a feature document renders fact listings at all, so an overview
 * reports `not-applicable`; a feature document whose pack is not on disk reports `absent`, which is the same
 * thing the packet itself says in prose. A pack that IS on disk but fails the run's own factpack-v2 validator is
 * a named failure — the validator is reused rather than restated.
 */
function loadFactPack(runDir: string, document: DocumentPlan): { pack: FeatureFactPack | null; state: "present" | "absent" | "not-applicable" } {
  if (document.kind !== "feature") return { pack: null, state: "not-applicable" };
  const key = featureKeyOf(document);
  const path = join(runDir, "context", "features", `${key}.factpack.json`);
  if (!existsSync(path)) return { pack: null, state: "absent" };
  const value = readJsonFile<unknown>(path, `context/features/${key}.factpack.json`);
  try {
    requireFactPackV2(value, `context/features/${key}.factpack.json`);
  } catch (error) {
    fail((error as Error).message);
  }
  return { pack: value, state: "present" };
}

/**
 * The run's read-coverage residual, copied out of `coverage/read-residual.json`. Every scalar the baseline
 * publishes is required: a summary field that vanished from the artifact is a named failure, not a zero.
 */
function readCoverageReading(runDir: string): ReadCoverageReading {
  const report = readJsonFile<ReadCoverageReport>(join(runDir, "coverage", "read-residual.json"), "coverage/read-residual.json");
  if (typeof report.version !== "string" || !report.version) fail("coverage/read-residual.json has no version");
  if (typeof report.consumptionEvaluated !== "boolean") fail("coverage/read-residual.json has no consumptionEvaluated flag");
  if (!Array.isArray(report.items)) fail("coverage/read-residual.json has no items array");
  if (!report.summary || typeof report.summary !== "object") fail("coverage/read-residual.json has no summary");
  const summary = report.summary as unknown as Record<string, unknown>;
  const scalars = ["counted", "covered", "partial", "notOpened", "cannotDetermine", "obligationLines", "openedLines", "uncoveredLines", "openedNotConsumed", "gatedNotOpened"] as const;
  const copied: Record<string, number> = {};
  for (const field of scalars) {
    const value = summary[field];
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`coverage/read-residual.json summary.${field} is ${JSON.stringify(value)}, not a number`);
    copied[field] = value;
  }
  const byStatus: Record<string, number> = {};
  for (const [index, item] of report.items.entries()) {
    const status = (item as { status?: unknown }).status;
    if (typeof status !== "string" || !status) fail(`coverage/read-residual.json item ${index} has no status`);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return {
    version: report.version,
    consumptionEvaluated: report.consumptionEvaluated,
    items: report.items.length,
    itemsByStatus: Object.fromEntries(Object.keys(byStatus).sort().map((status) => [status, byStatus[status]])),
    summary: copied as ReadCoverageReading["summary"],
    notOpenedByAttribution: attributionSplit(summary.notOpenedByAttribution, "notOpenedByAttribution"),
    notOpenedLinesByAttribution: attributionSplit(summary.notOpenedLinesByAttribution, "notOpenedLinesByAttribution")
  };
}

/** The anchor-label split is optional in the artifact; its absence is reported as the literal "absent". */
function attributionSplit(value: unknown, field: string): Record<string, number> | "absent" {
  if (value === undefined) return "absent";
  if (!value || typeof value !== "object") fail(`coverage/read-residual.json summary.${field} is ${JSON.stringify(value)}, not an object`);
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) fail(`coverage/read-residual.json summary.${field}.${key} is ${JSON.stringify(entry)}, not a number`);
    out[key] = entry;
  }
  return out;
}

/** A renderer block carrying exactly one trace id; `renderTraces` reads nothing else off the block. */
function singleTraceBlock(traceId: string): PacketSection {
  return { key: "projection", heading: "projection", workItems: [{ traceIds: [traceId] } as unknown as InvestigationWorkItem], evidenceIds: [] };
}

/** Slice the renderer's own block heading off a single-member render, asserting what was sliced. */
function withoutHeading(rendered: string, what: string): string {
  const newline = rendered.indexOf("\n");
  if (newline === -1) fail(`the renderer's block for ${what} has no line after its heading (${JSON.stringify(rendered)})`);
  const heading = rendered.slice(0, newline);
  if (!heading.startsWith("### ")) fail(`the renderer's block heading for ${what} is ${JSON.stringify(heading)}, which the projection cannot slice`);
  return rendered.slice(newline + 1);
}

/** The id's anchor, verified to be the prefix the renderer actually emitted for it. */
function anchorOf(kind: PacketUnitKind, id: string, chunk: string): string {
  const anchor = `- \`${id}\``;
  if (!chunk.startsWith(anchor)) fail(`the renderer no longer opens ${kind} ${id} with ${JSON.stringify(anchor)} (got ${JSON.stringify(chunk.slice(0, anchor.length + 20))})`);
  return anchor;
}

function findAll(haystack: Buffer, needle: Buffer): number[] {
  if (needle.length === 0) fail("cannot locate an empty chunk");
  const hits: number[] = [];
  for (let from = 0; ; ) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return hits;
    hits.push(index);
    from = index + 1;
  }
}

/** Claim entries across a document's claims files. A missing claims directory is a named failure, not a zero. */
function countClaims(runDir: string, documentId: string): number {
  const dir = join(runDir, "claims", documentId);
  if (!existsSync(dir)) fail(`document ${documentId} has no claims directory at claims/${documentId}`);
  let total = 0;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
    const file = readJsonFile<SectionClaimsFile>(join(dir, name), `claims/${documentId}/${name}`);
    if (!Array.isArray(file.claims)) fail(`claims/${documentId}/${name} has no claims array`);
    total += file.claims.length;
  }
  return total;
}
