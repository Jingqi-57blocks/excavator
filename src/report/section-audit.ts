/**
 * The report side of auditing: every check whose subject is rendered section text or a claim.
 *
 * Split out of `assurance.ts`, which mixed these with the knowledge-side work-item and evidence audits and
 * therefore had to import the report-side claim comparator — an upward edge, and one half of a cycle. The
 * direction is now one-way: this module may read the knowledge side, never the reverse.
 */

import { markersIn, visibleText } from "./evidence-markers.ts";
import type { AuditFinding, DocumentPlan, EvidenceItem, EvidenceMarker, FactPackCategory, SectionClaim, SectionClaimsFile } from "../base/types.ts";

export function auditSectionClaims(options: {
  documentId: string;
  sectionIndex: number;
  sectionText: string;
  claimsFile: SectionClaimsFile | null;
  evidenceIds: Set<string>;
  traceIds?: Set<string>;
}): AuditFinding[] {
  // One generation at a time, whole comparison: the segments and the claim statements are folded the same
  // way before being compared, and the section is accepted if ANY generation is internally consistent.
  // Mixing generations is what broke archived runs — see TEXT_FOLDINGS.
  const attempts = TEXT_FOLDINGS.map((fold) => judgeSectionClaims(options, fold));
  // The generation that reads the section best, reported WHOLE. Not "fewest errors across generations" —
  // that would mix two readings; the findings returned are always one generation's, so the section is judged
  // by a single self-consistent view. Ties keep the newest, so a section that binds under both is reported
  // under current semantics.
  const cost = (attempt: AuditFinding[]): number => attempt.filter((finding) => FOLDING_SENSITIVE.test(finding.message)).length;
  return attempts.reduce((best, attempt) => (cost(attempt) < cost(best) ? attempt : best), attempts[0]);
}

/**
 * The findings whose outcome depends on how text was folded; everything else is generation-independent.
 *
 * `too short to bind` belongs here and was missed: folding decides the length. A statement written as
 * `` `事实` 共5项 `` folds to `事实 共5项` (6 characters, binds) under the legacy generation and to `共5项`
 * (3) under the current one — so a section that is entirely self-consistent under legacy was reported as
 * too-short because the cost comparison could not see it. Leaving it out contradicted this fix's own
 * contract, that a section passes when ANY generation reads it consistently.
 */
const FOLDING_SENSITIVE = /statement is not present in section|has an unclaimed substantive statement|statement is too short to bind/;

function judgeSectionClaims(options: {
  documentId: string;
  sectionIndex: number;
  sectionText: string;
  claimsFile: SectionClaimsFile | null;
  evidenceIds: Set<string>;
  traceIds?: Set<string>;
}, fold: (value: string) => string): AuditFinding[] {
  const { documentId, sectionIndex, sectionText, claimsFile, evidenceIds, traceIds = new Set<string>() } = options;
  const findings: AuditFinding[] = [];
  const visible = visibleText(sectionText);
  const segments = substantiveSegments(sectionText, fold);
  const markers = markersIn(visible);
  const cited = evidenceIdsInSection(sectionText, evidenceIds);
  if (!claimsFile) {
    if (!segments.length && !markers.size && !cited.size) return findings;
    return [error(documentId, `section ${sectionIndex} has substantive statements but no claims file`)];
  }
  if (!claimsFile.claims.length && segments.length) findings.push(error(documentId, `section ${sectionIndex} has substantive statements but an empty claims file`));
  if (claimsFile.documentId !== documentId || claimsFile.section !== sectionIndex) findings.push(error(documentId, `section ${sectionIndex} claims metadata points to ${claimsFile.documentId} section ${claimsFile.section}`));
  const claimIds = new Set<string>();
  const declaredEvidence = new Set<string>();
  const claimMarkers = new Set<EvidenceMarker>();
  for (const claim of claimsFile.claims) {
    findings.push(...auditClaim(documentId, sectionIndex, visible, claim, evidenceIds, traceIds, fold));
    if (claimIds.has(claim.id)) findings.push(error(documentId, `section ${sectionIndex} has duplicate claim id ${claim.id}`));
    claimIds.add(claim.id);
    claimMarkers.add(claim.marker);
    for (const id of claim.evidenceIds ?? []) declaredEvidence.add(id);
  }
  const normalizedClaims = claimsFile.claims.map((claim) => fold(claim.statement)).filter(Boolean);
  for (const segment of segments) {
    const covered = normalizedClaims.some((statement) => statement.includes(segment) || segment.includes(statement));
    if (!covered) findings.push(error(documentId, `section ${sectionIndex} has an unclaimed substantive statement: ${segment.slice(0, 120)}`));
  }
  for (const marker of markers) if (!claimMarkers.has(marker)) findings.push(error(documentId, `section ${sectionIndex} contains ${marker} wording but declares no ${marker} claim`));
  for (const id of cited) if (!declaredEvidence.has(id)) findings.push(error(documentId, `section ${sectionIndex} cites ${id} but no section claim declares it`));
  for (const id of declaredEvidence) if (!cited.has(id)) findings.push(error(documentId, `section ${sectionIndex} claim declares ${id}, but the section evidence block does not cite it`));
  return findings;
}

function evidenceIdsInSection(sectionText: string, knownEvidenceIds: Set<string>): Set<string> {
  const cited = new Set<string>();
  for (const id of knownEvidenceIds) if (sectionText.includes(id)) cited.add(id);
  // The id body must end on a letter or digit: a trailing separator is never part of an id,
  // and letting one in turns `<!--E:S-d59eb3a823-->` into the pseudo id `S-d59eb3a823--`.
  const pattern = /(?<![\p{L}\p{N}_])((?:S|CG|FG|GIT|SEARCH|SCOPE|PROVIDER|FACT)-[\p{L}\p{N}](?:[\p{L}\p{N}._:-]*[\p{L}\p{N}])?)(?![\p{L}\p{N}_.:-])/gu;
  for (const match of sectionText.matchAll(pattern)) cited.add(match[1]);
  return cited;
}

function auditClaim(documentId: string, sectionIndex: number, visible: string, claim: SectionClaim, evidenceIds: Set<string>, traceIds: Set<string>, fold: (value: string) => string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (!claim.id.trim()) findings.push(error(documentId, `section ${sectionIndex} has a claim with no id`));
  const statement = fold(claim.statement);
  if (statement.length < 6) findings.push(error(documentId, `claim ${claim.id || "<missing>"} statement is too short to bind to report prose`));
  else if (!fold(visible).includes(statement)) findings.push(error(documentId, `claim ${claim.id} statement is not present in section ${sectionIndex}`));
  if (claim.marker === "unavailable") {
    if (claim.evidenceIds?.length) findings.push(error(documentId, `unavailable claim ${claim.id} must not cite evidence ids`));
    if (!claim.reason?.trim()) findings.push(error(documentId, `unavailable claim ${claim.id} requires a reason`));
  } else {
    if (!claim.evidenceIds?.length) findings.push(error(documentId, `${claim.marker} claim ${claim.id} requires evidence ids`));
    for (const id of claim.evidenceIds ?? []) if (!evidenceIds.has(id)) findings.push(error(documentId, `claim ${claim.id} references missing evidence id ${id}`));
  }
  for (const id of claim.traceIds ?? []) if (!traceIds.has(id)) findings.push(error(documentId, `claim ${claim.id} references missing trace id ${id}`));
  if (claim.status === "verified" && claim.confidence === "low") findings.push(error(documentId, `verified claim ${claim.id} cannot have low confidence`));
  return findings;
}

export function auditDetailedFeatureSection(options: {
  document: DocumentPlan;
  detailLevel: "standard" | "detailed" | undefined;
  sectionIndex: number;
  sectionText: string;
  claimsFile: SectionClaimsFile | null;
  factEvidence?: EvidenceItem[];
}): AuditFinding[] {
  const { document, detailLevel, sectionIndex, sectionText, claimsFile, factEvidence } = options;
  if ((detailLevel ?? "detailed") !== "detailed" || document.kind !== "feature" || document.audience !== "engineering") return [];
  const minimumClaims = [0, 6, 8, 6, 16, 8, 8, 7, 7, 6, 7, 7, 6];
  const findings: AuditFinding[] = [];
  const count = claimsFile?.claims.length ?? 0;
  if (count < minimumClaims[sectionIndex]) findings.push(error(document.id, `detailed section ${sectionIndex} has ${count} claims; minimum is ${minimumClaims[sectionIndex]}`));
  const tableSections = new Set([1, 2, 4, 5, 6, 7, 8, 9, 11, 12]);
  const diagramSections = new Set([3, 10]);
  if (tableSections.has(sectionIndex) && !/^\s*\|.+\|\s*$/m.test(visibleText(sectionText))) findings.push(error(document.id, `detailed section ${sectionIndex} requires an inventory or comparison table`));
  if (diagramSections.has(sectionIndex) && !/```mermaid[\s\S]*?```/i.test(sectionText)) findings.push(error(document.id, `detailed section ${sectionIndex} requires a Mermaid flow or dependency diagram`));
  findings.push(...reconcileFactPack(document, sectionIndex, sectionText, factEvidence ?? []));
  return findings;
}

/** The enumerating chapter that must cover each fact pack category; other sections reconcile nothing. */
const FACT_PACK_SECTIONS: Record<number, FactPackCategory[]> = {
  2: ["entrypoints"],
  4: ["states"],
  6: ["entities"],
  7: ["external-calls"],
  9: ["config-keys", "jobs"]
};

/**
 * Advisory enumeration reconciliation: the enumerating chapter must represent every consumable fact-pack item of
 * the categories it owns. Under-coverage is a warning, never an error, and only non-truncated
 * categories are enforced — a truncated category (e.g. a 405-item entrypoint boundary) is already
 * declared incomplete, so holding the prose to it would flood the report. An absent fact-pack view
 * run, no `FACT-*` evidence passed) reconciles nothing.
 */
function reconcileFactPack(document: DocumentPlan, sectionIndex: number, sectionText: string, factEvidence: EvidenceItem[]): AuditFinding[] {
  const categories = FACT_PACK_SECTIONS[sectionIndex];
  if (!categories || !factEvidence.length) return [];
  const findings: AuditFinding[] = [];
  for (const category of categories) {
    const data = factEvidence.find((item) => (item.data as { category?: string } | undefined)?.category === category)?.data as
      | { items?: Array<{ name?: string; filePath?: string; line?: number }>; coverage?: { truncated?: boolean } }
      | undefined;
    if (!data || data.coverage?.truncated) continue;
    const uncovered = (data.items ?? []).filter((item) => !factItemCovered(sectionText, item));
    if (!uncovered.length) continue;
    const sample = uncovered.slice(0, 5).map((item) => item.name || `${item.filePath ?? "?"}:${item.line ?? "?"}`).join(", ");
    findings.push(warning(document.id, `detailed section ${sectionIndex} enumeration under-covers fact pack category ${category}: ${uncovered.length} item(s) not represented (e.g. ${sample})`));
  }
  return findings;
}

/** Lenient by design: any mention of the item name or its `path:line` location counts as coverage. */
/**
 * Whether a claim disposed this rescued item by naming its work item — the binding the contract promises.
 *
 * EXACT id, never a suffix. The id shape is `feature:<key>:logic:<name>@<path>:<line>`, and a suffix match
 * drops the feature key: measured, `feature:OTHER:logic:f@x.js:10` then "covers" `feature:k:logic:f@x.js:10`,
 * so in a multi-feature run one feature's disposition silences another's rescued item. A silenced real miss
 * is worse than a false warning, which is why this is a lookup on the whole id and the caller supplies the
 * feature key. (A name containing `@` collides the same way under suffix matching; exact ids end that too.)
 */
function logicItemDisposed(item: { name?: string; filePath?: string; line?: number }, disposedIds: Set<string>, featureKey: string): boolean {
  if (!disposedIds.size || !featureKey) return false;
  return disposedIds.has(`feature:${featureKey}:logic:${item.name ?? ""}@${item.filePath ?? ""}:${item.line ?? ""}`);
}

function factItemCovered(sectionText: string, item: { name?: string; filePath?: string; line?: number }): boolean {
  const name = (item.name ?? "").trim();
  const path = (item.filePath ?? "").trim();
  if (name.length >= 3 && sectionText.includes(name)) return true;
  if (path && item.line != null && sectionText.includes(`${path}:${item.line}`)) return true;
  return false;
}

/**
 * Document-level advisory (warning-only): every rescued-signal `logic` fact — a business/decision function
 * the boundary fix pulled in that carries a `signal` — should be represented somewhere in the assembled
 * report. Unlike the per-section fact-pack reconciliation, this is document-scoped: logic items may
 * legitimately land in §3/§4/§5, so a per-section check would false-warn across sections. It reuses the
 * loose `factItemCovered` matching (name or path:line mention) and is self-gated: a run with no logic
 * evidence, no rescued items, or no report reconciles nothing. Consistent with the "enumeration
 * reconciliation is advisory, never a hard gate" ruling.
 */
export function auditRescuedLogicCoverage(
  documentId: string,
  reportText: string,
  factEvidence: EvidenceItem[],
  claims: SectionClaim[] = [],
  featureKey = "",
): AuditFinding[] {
  const logic = factEvidence.find((item) => (item.data as { category?: string } | undefined)?.category === "logic")?.data as
    | { items?: Array<{ name?: string; filePath?: string; line?: number; signal?: string }> }
    | undefined;
  if (!logic) return [];
  const rescued = (logic.items ?? []).filter((item) => typeof item.signal === "string" && item.signal.length);
  // BINDING FIRST, TEXT ONLY AS A FALLBACK. `writing-rules.md` states the contract this check has to
  // measure: "The prose need not contain the identifier — the coverage ledger binds through the cited
  // evidence." A full-text search for the identifier measures something else, and measured on a real run it
  // punished an author for FOLLOWING that contract — five rescued items warned while every one of them was
  // disposed through a claim, until the identifiers were stuffed into a collapsed block to silence it.
  // An advisory that fires when the documented practice is followed is worse than no advisory: it teaches
  // people to ignore advisories, and this system's honesty rests on them being read.
  const disposedIds = new Set(claims.flatMap((claim) => claim.workItemIds ?? []));
  const uncovered = rescued.filter((item) => !logicItemDisposed(item, disposedIds, featureKey) && !factItemCovered(reportText, item));
  if (!uncovered.length) return [];
  const sample = uncovered.slice(0, 5).map((item) => item.name || `${item.filePath ?? "?"}:${item.line ?? "?"}`).join(", ");
  return [warning(documentId, `report does not represent ${uncovered.length} rescued logic fact(s) that need individual disposition (e.g. ${sample})`)];
}

export function substantiveSegments(section: string, fold: (value: string) => string = normalizeText): string[] {
  const lines = visibleText(section).split(/\r?\n/);
  const segments: string[] = [];
  for (let line of lines) {
    line = line.trim();
    if (!line || /^#{1,6}\s+/.test(line) || /^[-| :]+$/.test(line)) continue;
    if (/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) continue;
    line = line
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(EVIDENCE_MARKER_TOKEN, "")
      .trim();
    if (line.startsWith("|") && line.endsWith("|")) {
      line = line.slice(1, -1).split("|").map((cell) => cell.trim()).filter(Boolean).join("；");
    }
    for (const part of line.split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z0-9])/u)) {
      const normalized = fold(part).trim();
      const semanticLength = (normalized.match(/[\p{Letter}\p{Number}]/gu) ?? []).length;
      if (semanticLength >= 8) segments.push(normalized);
    }
  }
  return [...new Set(segments)];
}

/**
 * The evidence-level marker token, as prose carries it. One definition: the segmenter strips it and the
 * audit's folding must strip it identically, or a segment stops being a substring of the text it came from.
 */
const EVIDENCE_MARKER_TOKEN = /`(?:事实|验证|推断|不可得|fact|verified|inferred|unavailable)`/gi;

/**
 * Remove what is decoration rather than content: the marker token, and the backticks and asterisks that sit
 * BETWEEN characters a reader sees as adjacent.
 *
 * Shared by `substantiveSegments` and `normalizeText` because they had drifted twice in the same way, and
 * each drift made a segment fail to be found in the very section that produced it — once on `**bold**`
 * (asterisks became a space on one side and vanished on the other) and once on the marker token (removed
 * entirely by the segmenter, left as a bare word by the audit). One function, so a third drift needs a
 * deliberate edit rather than an oversight.
 */
function foldInlineDecoration(value: string): string {
  return value.replace(EVIDENCE_MARKER_TOKEN, "").replace(/[`*]/g, "");
}

/**
 * Fold report prose and a claim statement into one comparable form.
 *
 * INLINE DECORATION IS REMOVED, NOT SPACED. Backticks and emphasis asterisks sit BETWEEN characters that
 * the reader sees as adjacent, so turning them into whitespace injects a separator that exists in no
 * rendering of the text: `产品名为 **CMS3000**，其源码` folded to `… CMS3000 ，其源码` — a space before the
 * comma. Nothing an author writes contains that space, so every claim binding a bold lead-in failed as
 * "statement is not present in section", including the stubs `claims scaffold` emits itself. Two engine
 * rules contradicted each other: `writing-rules.md` asks every chapter for bold lead-ins, and this
 * function made them unbindable. Found by a real authoring run on a Perl target, ~30 errors in one report.
 *
 * The rest stay spaced. `-` and `_` occur INSIDE identifiers (`read-obligations`, `snake_case`), where
 * removal would weld words together and change which statements match.
 */
function normalizeText(value: string): string {
  return foldInlineDecoration(value).replace(/[_>#-]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * How text folded before inline decoration stopped being spaced.
 *
 * Kept because a run authored against it carries the artefact IN ITS CLAIMS: an archived statement reads
 * `目录： cms provital` where the prose folds to `目录：cms provital` today. Measured on 31 archived runs —
 * 8 of them, 4 previously green, gained errors when only the current folding was tried.
 */
function normalizeTextLegacy(value: string): string {
  return value.replace(/[`*_>#-]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The foldings a section may be judged under, newest first.
 *
 * A section passes if ANY generation is INTERNALLY consistent: segments and claim statements folded the same
 * way, then compared. Both halves must move together — `substantiveSegments` folds through `normalizeText`
 * itself, so a per-check fallback compares the two sides across generations, which is the drift this exists
 * to remove.
 */
const TEXT_FOLDINGS: Array<(value: string) => string> = [normalizeText, normalizeTextLegacy];

function error(document: string, message: string): AuditFinding { return { level: "error", document, message }; }
function warning(document: string, message: string): AuditFinding { return { level: "warning", document, message }; }
