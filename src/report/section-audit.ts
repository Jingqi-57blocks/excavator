/**
 * The report side of auditing: every check whose subject is rendered section text or a claim.
 *
 * Split out of `assurance.ts`, which mixed these with the knowledge-side work-item and evidence audits and
 * therefore had to import the report-side claim comparator — an upward edge, and one half of a cycle. The
 * direction is now one-way: this module may read the knowledge side, never the reverse.
 */

import { visibleText } from "./evidence-markers.ts";
import type { AuditFinding, DocumentPlan, EvidenceItem, FactPackCategory, SectionClaim, SectionClaimsFile } from "../base/types.ts";

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

function error(document: string, message: string): AuditFinding { return { level: "error", document, message }; }
function warning(document: string, message: string): AuditFinding { return { level: "warning", document, message }; }
