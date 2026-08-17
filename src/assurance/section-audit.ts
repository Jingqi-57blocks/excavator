/**
 * The report side of auditing: every check whose subject is rendered section text or a claim.
 *
 * Split out of `assurance.ts`, which mixed these with the knowledge-side work-item and evidence audits and
 * therefore had to import the report-side claim comparator — an upward edge, and one half of a cycle. The
 * direction is now one-way: this module may read the knowledge side, never the reverse.
 */

import type {
  AuditFinding,
  DocumentPlan,
  EvidenceItem,
  EvidenceMarker,
  FactPackCategory,
  InvestigationPlan,
  SectionClaim,
  SectionClaimsFile
} from "../base/types.ts";
import { validateComparisonSides } from "./claim-comparison.ts";

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

const ANALYSIS_METHOD_TERMS: Array<RegExp> = [
  /\bCodeGraph\b/i,
  /\bExcavator\b/i,
  /unresolved[ -]?(?:reference|edge|relation)s?/i,
  /未解析(?:引用|关系|边)/,
  /源码回退|source fallback/i,
  /source window|源码窗口/i,
  /provider (?:coverage|selection|mode)|provider 覆盖|提供方覆盖/i,
  /candidate (?:node|file)s?|候选(?:节点|文件)/i,
  /graph coverage|图覆盖/i,
  /analysis (?:budget|performance|limitation)|分析(?:预算|性能|限制|不足)/i,
  /static[- ]review limitation|静态(?:审阅|分析)(?:限制|不足)/i,
  /handler[- ]resolution|处理角色解析|路由解析能力/i
];

export function auditTargetProblemAttribution(options: {
  document: DocumentPlan;
  sectionIndex: number;
  sectionText: string;
}): AuditFinding[] {
  const { document, sectionIndex, sectionText } = options;
  // A prd feature report has no "current problems" chapter (rule contradictions are shown inline in ch.2),
  // so this attribution check does not apply to it.
  if (document.audience === "prd") return [];
  // Feature reports now carry a standalone "Current problems found" chapter at §11 for both audiences
  // (product problems split out of the old §10 connected-scope chapter; engineering was already §11).
  // Overviews keep their problem chapter in place: product §9, engineering §11.
  const problemSection = document.kind === "overview"
    ? (document.audience === "product" ? 9 : 11)
    : 11;
  if (sectionIndex !== problemSection) return [];
  const visible = visibleText(sectionText);
  const findings: AuditFinding[] = [];
  for (const pattern of ANALYSIS_METHOD_TERMS) {
    pattern.lastIndex = 0;
    if (pattern.test(visible)) findings.push(error(document.id, `section ${sectionIndex} contains analysis-method information in a target problem section: ${pattern}`));
  }
  return findings;
}

/**
 * Advisory readability nudge (warning-only; NOT version-gated; does NOT touch the hard path).
 *
 * The engineering-FEATURE detailed path already HARD-requires inventory/comparison tables via
 * `auditDetailedFeatureSection`. The other three document contracts — product feature, product
 * overview, engineering overview — carried no table requirement at all, which is why their reports
 * came out as walls of prose. For a designated inventory/comparison section that has substantive
 * prose but no Markdown table in its reading flow, this emits a single `warning`. It never emits an
 * `error`, never gates on `ASSURANCE_VERSION`, and never runs for engineering-feature documents.
 *
 * The per-(kind, audience) section-index sets below (1-based, indices as they appear in the four
 * reference templates) list only the clearly-tabular inventory/comparison chapters. Deliberately
 * omitted: narrative openings (purpose/boundary), ordered journeys/flows and runtime topology
 * (Mermaid's job), pure-risk problem prose with no inventory, and the coverage/analysis-boundary
 * meta-chapters. A tests-and-problems chapter is included only where it carries a tests/documentation
 * inventory (the engineering templates), not a product report's pure-risk chapter.
 */
const READABILITY_TABLE_SECTIONS: Record<string, Set<number>> = {
  // product-overview.md §2 system parts, §3 capability map, §4 roles/permission boundary,
  // §5 business objects+states, §7 external dependencies, §8 back-office capabilities.
  // Omitted: §1 purpose, §6 data movement (a flow narrative), §9 pure risks, §10 coverage.
  "overview:product": new Set([2, 3, 4, 5, 7, 8]),
  // engineering-overview.md §2 repositories/units, §3 stack, §5 interfaces/entry points,
  // §7 data models/storage, §8 identity/auth, §9 external integrations, §10 config/jobs,
  // §11 tests+problems (tests inventory), §13 database design (per-table column tables).
  // Omitted: §1 purpose/snapshot, §4 topology (Mermaid), §6 call structure (graph), §12 coverage.
  "overview:engineering": new Set([2, 3, 5, 7, 8, 9, 10, 11, 13]),
  // product-feature.md §3 rules, §5 role-by-action, §6 data/fields, §7 side effects,
  // §8 failure modes, §9 config/switches, §13 glossary (glossary moved from §11 after the problem
  // chapter split). Omitted: §1 boundary, §2 journey (flow), §4 states (Mermaid state diagram is
  // mandated there), §10 connected scope, §11 current problems (table-or-list, like product-overview
  // §9), §12 coverage.
  "feature:product": new Set([3, 5, 6, 7, 8, 9, 13])
  // "feature:engineering" is intentionally absent: it stays on the hard `auditDetailedFeatureSection` path.
};

export function auditReadabilityTables(options: {
  document: DocumentPlan;
  sectionIndex: number;
  sectionText: string;
}): AuditFinding[] {
  const { document, sectionIndex, sectionText } = options;
  const sections = READABILITY_TABLE_SECTIONS[`${document.kind}:${document.audience}`];
  if (!sections || !sections.has(sectionIndex)) return [];
  // Only nudge a chapter that actually carries inventory-style prose; a heading-only or empty section
  // has nothing to tabulate. Reuse the same substantive-segment primitive the claim audit relies on.
  if (!substantiveSegments(sectionText).length) return [];
  // Reuse the exact table regex and visible-text scope the engineering-feature hard path uses, so a
  // table living only inside a collapsed evidence block does not count as a tabular reading flow.
  if (/^\s*\|.+\|\s*$/m.test(visibleText(sectionText))) return [];
  return [warning(document.id, `section ${sectionIndex} is an inventory/comparison chapter with no Markdown table; consider presenting the items as a table (advisory)`)];
}

const EVIDENCE_LEVEL_LEAD_IN = /^\**\s*(?:Evidence level|证据级别)\s*\**\s*[:：]/i;

const EVIDENCE_MARKER_WORD = /`?(?:事实|验证|推断|不可得)`?|`?\b(?:fact|verified|inferred|unavailable)\b`?/gi;

/**
 * Advisory marker-placement nudge (warning-only; NOT version-gated; NOT on the hard path). It does NOT
 * touch the `markersIn`/`visibleText` evidence-level accounting — it only reads the visible reading
 * flow to catch a marker that has drifted off the statement it should qualify.
 *
 * The writing rules require a marker to ride at the end of the statement it qualifies, or to sit in the
 * qualified table cell / a dedicated level column — never as its own line and never behind an
 * "Evidence level:" lead-in. A marker stranded on its own line reads as a floating label. When a
 * visible line's only semantic content is a marker (or such a lead-in), this emits one `warning` for
 * the section. It never emits an `error` and never gates on ASSURANCE_VERSION, so it can never fail a
 * run or retroactively fail an older one.
 */
export function auditEvidenceMarkerPlacement(options: {
  document: DocumentPlan;
  sectionIndex: number;
  sectionText: string;
}): AuditFinding[] {
  const { document, sectionIndex, sectionText } = options;
  for (const line of visibleText(sectionText).split(/\r?\n/)) {
    if (isStandaloneMarkerLine(line)) {
      return [warning(document.id, `section ${sectionIndex} places an evidence marker on its own line or behind an "Evidence level:" lead-in; attach the marker at the end of the statement it qualifies or in the qualified table cell (advisory)`)];
    }
  }
  return [];
}

/** A visible line whose only semantic content is an evidence marker or an "Evidence level:" lead-in. */
function isStandaloneMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const withoutLeadIn = trimmed.replace(EVIDENCE_LEVEL_LEAD_IN, " ");
  const hadLeadIn = withoutLeadIn !== trimmed;
  const withoutMarkers = withoutLeadIn.replace(EVIDENCE_MARKER_WORD, " ");
  const hadMarker = withoutMarkers !== withoutLeadIn;
  if (!hadLeadIn && !hadMarker) return false;
  const semantic = (normalizeText(withoutMarkers).match(/[\p{Letter}\p{Number}]/gu) ?? []).length;
  return semantic === 0;
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
 * Advisory enumeration reconciliation: the enumerating chapter must represent every fact pack item of
 * the categories it owns. Under-coverage is a warning, never an error, and only non-truncated
 * categories are enforced — a truncated category (e.g. a 405-item entrypoint boundary) is already
 * declared incomplete, so holding the prose to it would flood the report. An absent fact pack (older
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

/**
 * Coverage findings split into two kinds. Claim-attribution defects (a claim pointing at an
 * unknown work item, a document it is not required for, or the wrong section) are always errors:
 * they are detectable from the single document under audit, so they run for every document passed,
 * complete or not. Completeness findings (a material work item that no claim represents) assert
 * something about the WHOLE requested document set: a caller auditing a partial or single-document
 * scope passes `coverageLevel: "warning"` to keep them advisory, and passes `completeDocumentIds`
 * so completeness is certified only for documents whose sections are all checkpointed — an
 * incomplete document is still attribution-checked but never reported as falsely under-covered.
 */
export function auditWorkItemClaimCoverage(plan: InvestigationPlan, documents: DocumentPlan[], claimsByDocument: Map<string, Array<{ section: number; claim: SectionClaim }>>, options: { coverageLevel?: "error" | "warning"; completeDocumentIds?: Set<string> } = {}): AuditFinding[] {
  const coverageLevel = options.coverageLevel ?? "error";
  const coverage = (document: string, message: string): AuditFinding => ({ level: coverageLevel, document, message });
  const findings: AuditFinding[] = [];
  const items = new Map(plan.items.map((item) => [item.id, item]));
  for (const document of documents) {
    const claims = claimsByDocument.get(document.id) ?? [];
    for (const { section, claim } of claims) {
      for (const id of claim.workItemIds ?? []) {
        const item = items.get(id);
        if (!item) { findings.push(error(document.id, `claim ${claim.id} references unknown work item ${id}`)); continue; }
        if (!item.requiredFor.includes(document.id)) findings.push(error(document.id, `claim ${claim.id} references work item ${id} that is not required for this document`));
        // The exact section-link check assumes the canonical 1..12 feature chapter numbering. A prd feature
        // report has its own (fewer) chapters, so a work item pinned to §N need not land in the prd chapter N;
        // skip only this check for prd (product/engineering paths are byte-unchanged). Every other coverage
        // rule below still applies to prd.
        if (document.audience !== "prd" && item.reportSection && item.reportSection !== section) findings.push(error(document.id, `claim ${claim.id} links work item ${id} to section ${section}, expected section ${item.reportSection}`));
      }
    }
    // Completeness certifies the full requested set; skip it for a document the caller marks incomplete.
    if (options.completeDocumentIds && !options.completeDocumentIds.has(document.id)) continue;
    for (const item of plan.items.filter((candidate) => candidate.material && candidate.requiredFor.includes(document.id) && candidate.origin !== "open")) {
      const linked = claims.filter(({ claim }) => (claim.workItemIds ?? []).includes(item.id));
      if (!linked.length) { findings.push(coverage(document.id, `material work item ${item.id} is not represented by any report claim`)); continue; }
      if (item.status === "found") {
        const grounded = linked.some(({ claim }) => (claim.evidenceIds ?? []).some((id) => item.evidenceIds.includes(id)) || (claim.traceIds ?? []).some((id) => item.traceIds.includes(id)));
        if (!grounded) findings.push(coverage(document.id, `claims for material work item ${item.id} do not reuse its evidence or trace`));
      }
      if (item.status === "searched-not-found" && !linked.some(({ claim }) => claim.marker === "verified" && (claim.evidenceIds ?? []).some((id) => item.evidenceIds.includes(id)))) {
        findings.push(coverage(document.id, `searched-not-found work item ${item.id} requires a linked verified claim using its search receipt`));
      }
      if (["cannot-determine", "not-applicable"].includes(item.status) && !linked.some(({ claim }) => claim.marker === "unavailable" || claim.marker === "verified")) {
        findings.push(coverage(document.id, `unresolved work item ${item.id} requires a linked unavailable or verified claim`));
      }
    }
  }
  return findings;
}

export function validateClaimsInput(documentId: string, section: number, claims: SectionClaim[]): SectionClaimsFile {
  if (!Array.isArray(claims)) throw new Error("Claims must be an array");
  for (const claim of claims) {
    if (!claim || typeof claim !== "object") throw new Error("Each claim must be an object");
    if (!claim.id || !claim.statement || !["fact", "verified", "inferred", "unavailable"].includes(claim.marker)) throw new Error(`Invalid claim in ${documentId} section ${section}`);
    const sideViolations = validateComparisonSides(claim);
    if (sideViolations.length) throw new Error(`Invalid comparison sides in ${documentId} section ${section}: ${sideViolations.join("; ")}`);
  }
  return { version: 2, documentId, section, claims };
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

function visibleText(section: string): string {
  return section
    .replace(/<details[\s\S]*?<\/details>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
}

/**
 * The localized marker vocabulary, as whole backticked tokens.
 *
 * `writing-rules.md` tells authors to "render these semantic markers naturally … in the requested output
 * language", while this function accepted exactly four Chinese strings — so an author following the contract
 * wrote `` `已验证` `` or `` `不可用` `` and the chapter was reported as having no marker at all. Measured on a
 * real Chinese run: `` `不可得` `` was the only accepted way to say "unavailable", which reads badly, and the
 * accepted set appeared in no document.
 *
 * Matched as COMPLETE tokens rather than substrings: `` `验证服务` `` is a component name, not a marker, and a
 * substring rule would read it as one. Adding a synonym means adding it here AND to `writing-rules.md`,
 * which is the honest state — the deeper fix is one vocabulary both the doc and the code read.
 */
export const MARKER_TOKENS: Record<string, EvidenceMarker> = {
  "事实": "fact",
  "验证": "verified",
  "已验证": "verified",
  "推断": "inferred",
  "已推断": "inferred",
  "不可得": "unavailable",
  "不可用": "unavailable",
  "无法获得": "unavailable",
};

export function markersIn(text: string): Set<EvidenceMarker> {
  const markers = new Set<EvidenceMarker>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const level = MARKER_TOKENS[match[1].trim()];
    if (level) markers.add(level);
  }
  // English markers stay bare words, as they always were — changing that would move existing runs.
  if (/\bfact\b/i.test(text)) markers.add("fact");
  if (/\bverified\b/i.test(text)) markers.add("verified");
  if (/\binferred\b/i.test(text)) markers.add("inferred");
  if (/\bunavailable\b/i.test(text)) markers.add("unavailable");
  return markers;
}

/**
 * The one rule for "does this prose carry an evidence-level marker". Document- and section-level
 * checks both route through `markersIn` over `visibleText`, so they cannot drift onto different rules:
 * a bare backtick-free word like an incidental "事实" in prose is not a marker, only a real
 * `事实`/`验证`/`推断`/`不可得` (or the English marker words the paragraph audit already accepts) is.
 */
export function hasEvidenceMarkers(text: string): boolean {
  return markersIn(visibleText(text)).size > 0;
}

/**
 * The report's "evidence levels are annotated" conclusion is only trustworthy if every substantive
 * section actually carries an evidence-level marker in its visible prose. This reuses the same
 * `markersIn` primitive the paragraph-level claim audit uses, via `hasEvidenceMarkers`, so it cannot
 * diverge from the document-level check. It is gated by assurance version: a run prepared under the
 * current version is held to it as a hard error, while an older or field-less run is grandfathered
 * (the weaker document-level warning still applies) so this tightening never retroactively fails it.
 */
export function auditSectionEvidenceMarkers(options: {
  documentId: string;
  sectionIndex: number;
  sectionText: string;
  strict: boolean;
}): AuditFinding[] {
  const { documentId, sectionIndex, sectionText, strict } = options;
  if (!strict || !substantiveSegments(sectionText).length || hasEvidenceMarkers(sectionText)) return [];
  return [error(documentId, `section ${sectionIndex} has substantive statements but no evidence-level marker`)];
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
