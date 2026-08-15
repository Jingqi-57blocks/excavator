// CONDITION INVENTORY — the segment no formal gate can reach: P(fact extracted | window opened).
//
// Reading accountability (read-obligations/read-coverage) proves a decision function's span was opened. It
// cannot prove the RULES inside it were extracted: opening `Approve 362-739` satisfies "opened" whether or
// not the 16h/40h thresholds ever reach a claim. This module measures that gap by inverting the direction
// of the question. It does NOT ask "is every number in a claim present in the cited window" — that check was
// calibrated on real runs and rejected: 5–42% of its flags were legitimate (file names, technology names,
// author-computed counts, line references, constant-name-vs-value, and values the redaction layer removed
// from the stored window on purpose). Accusing a correct report 4 times in 10 is how advisories die.
//
// Instead it asks the answerable question: WHICH literal conditions sit inside the windows that were opened,
// and which of them no claim ever mentions. An unaccounted condition is a RESIDUAL, not a defect — the author
// may legitimately judge it unreportable — so this layer is advisory by construction.
//
// SCOPE IS THE WHOLE TRICK. A repo-wide literal scan was already rejected (`Font.Size = 16` drowning the
// signal); scanning only inside opened windows keeps the surface tiny. Three calibrated filters then remove
// the classes that are never business rules — measured on a real 21-feature WCP run:
//   raw comparisons 204 → excluding 0/1 existence guards and >100000 timestamps/ids: 34
//   → excluding structural/presentational left-hand sides (len/length/count/rows/depth/index/status code/
//     size/width/height/font/px/page/limit/offset): 17, of which 16 are domain rules
//     (`record.status < 7`, `tr.Status == 3`, `project_id != 13`, `now.Hour() != 10`, `result.Hours != 10`).
//   `lv.Hours > 16` / `> 40` — the thresholds this whole line of work exists for — pass all three filters.
//
// WHAT THE NUMBER MEANS, precisely. Consumption requires a claim that BOTH cites the window and states the
// literal, so `unaccounted` counts two different failures together: a rule never extracted, and a rule stated
// while citing some other window. The ratio is therefore a LOWER BOUND on extraction — "P(extracted and
// correctly back-referenced | opened)" — never a clean extraction rate. Splitting the two by asking whether
// any claim anywhere states the literal was tried and does NOT work: across thousands of claims a small
// ordinal (2, 3, 6, 12) appears by coincidence, so the split is confounded by exactly the accident this
// module guards against inside a single claim.
//
// TWO MORE KNOWN DENOMINATOR GAPS, recorded rather than implied: a rule expressed as `switch`/`case 3:` is not
// a comparison expression and never enters the inventory, and neither does a threshold that lives in
// configuration instead of code. Declarative rule objects (a form's `rules={[{ required: true }]}`, a schema
// literal, a constant catalogue) are absent for the same reason — they are data, not comparisons.
//
// Pure: zero I/O, zero model call, byte-stable ordering.

import type { EvidenceItem } from "../core/types.ts";
import type { AuditFinding } from "./assurance.ts";
import { extractComparisons, type RawComparison } from "./condition-extract.ts";
import { normalizeObligationPath } from "./read-obligations.ts";

export const CONDITION_INVENTORY_VERSION = "condition-inventory-v1";

/**
 * Left-hand sides that measure STRUCTURE or PRESENTATION rather than domain state. Calibrated against real
 * runs: these produced the noise (`len(parts) != 3`, `Math.abs(value) < 1000`, `searchDepth < 15`,
 * `StatusCode != 200`), while domain fields produced the signal (`record.Status`, `ItemType`, `project_id`).
 */
// camelCase-aware anchoring, NOT a case-insensitive substring match: an unanchored `count` swallowed
// `order.discount > 30` and an unanchored `index` swallowed `priceIndex > 900` — a discount threshold and a
// price index are exactly the domain rules this inventory exists to surface. Each term therefore matches
// only as a standalone word or a camelCase tail (`rowCount`, `searchDepth`), never inside a longer lowercase
// word. `index` is deliberately absent: `priceIndex`/`qualityIndex` are domain values and array-index
// comparisons are already caught by `len(`.
const STRUCTURAL_LHS = /(\blen\(|\.length\b|\bMath\.|\bcount\b|Count\b|\brows?\b|Rows?\b|\bdepth\b|Depth\b|\bstatuscode\b|StatusCode\b|\bsize\b|Size\b|[Ww]idth|[Hh]eight|[Ff]ont|\bpx\b|\bpage\b|Page\b|\blimit\b|Limit\b|\boffset\b|Offset\b)/;

/**
 * Literals that are existence/emptiness guards (0, 1) or clock/id magnitudes rather than business values.
 * The magnitude cut is 1e8, not 1e5: epoch seconds (~1.6e9) and generated ids sit far above it, while a
 * money or quota ceiling (`amount > 500000`) is a real rule and must survive.
 *
 * KNOWN BIAS (documented rather than silently accepted): filtering 0/1 makes an enum family inconsistent —
 * `Status == 3` is inventoried while `Status == 1` in the same family is invisible, so a reader must not read
 * "not listed" as "consumed". It is kept because it is what took the real-run surface from 204 to 34.
 */
function isStructuralLiteral(literal: string): boolean {
  const value = Number(literal);
  return value === 0 || value === 1 || value > 100_000_000;
}

/** Well-known HTTP status codes: `resp.status !== 200` is protocol handling, not a domain rule. Narrow on
 *  purpose — a domain field compared against a small ordinal (`record.status < 7`) is NOT exempted. */
const HTTP_STATUS = new Set(["200", "201", "202", "204", "301", "302", "304", "400", "401", "403", "404", "409", "422", "429", "500", "502", "503", "504"]);
function isProtocolComparison(field: string, literal: string): boolean {
  return HTTP_STATUS.has(literal) && /(status|code|statuscode|resp|response)/i.test(field);
}

export interface ConditionSite {
  /** Stable identity: normalized path, absolute line, and the expression as written. */
  id: string;
  path: string;
  line: number;
  expression: string;
  field: string;
  operator: string;
  literal: string;
  /** A numeric threshold or a string enum value — the two shapes a business literal takes. */
  literalKind: "number" | "string";
  /** Which extraction path produced it, so degraded (regex, numeric-only) coverage is visible, not implied. */
  via: "ast" | "regex";
  /** The opened source window this condition was found inside. */
  windowId: string;
}

/**
 * A field compared against several string literals — an enum family. Grouping is not cosmetic: six separate
 * `repr.View == "..."` lines say far less than one line saying WHICH values that field accepts, and "which
 * modes exist" is exactly the question a report has to answer (measured on a real run: 66 string comparisons
 * collapsed into 30 field families, e.g. `activeTab ∈ {feature-breakdowns, team-rampup}`).
 */
export interface EnumFamily {
  path: string;
  field: string;
  values: string[];
  lines: number[];
  status: "consumed" | "partial" | "unaccounted";
}

export interface ConditionCoverageItem extends ConditionSite {
  status: "consumed" | "unaccounted";
  /** Claim refs that cite this window AND state the literal. */
  consumedBy: string[];
}

export interface ConditionInventory {
  version: string;
  items: ConditionCoverageItem[];
  /** String comparisons regrouped per field — "which values this field accepts". */
  families: EnumFamily[];
  summary: {
    total: number;
    consumed: number;
    unaccounted: number;
    /** Windows that contained at least one qualifying condition. */
    windowsWithConditions: number;
    numericSites: number;
    stringSites: number;
    /** Sites whose window had no AST grammar, so only numeric literals could be seen there. */
    regexOnlySites: number;
  };
}

/** One claim's statement plus its citations — consumption needs the prose, not just the ids. */
export interface ClaimStatement {
  ref: string;
  statement: string;
  evidenceIds: string[];
}

/**
 * Enumerate the qualifying conditions inside opened source windows and mark each consumed or unaccounted.
 * A condition counts as consumed when a claim citing that same window states its literal value.
 */
export function inventoryConditions(evidence: EvidenceItem[], claims: ClaimStatement[]): ConditionInventory {
  const statementsByWindow = new Map<string, ClaimStatement[]>();
  for (const claim of claims) {
    for (const id of claim.evidenceIds ?? []) {
      const list = statementsByWindow.get(id);
      if (list) list.push(claim);
      else statementsByWindow.set(id, [claim]);
    }
  }

  const items: ConditionCoverageItem[] = [];
  const windowsWithConditions = new Set<string>();
  for (const window of evidence) {
    if (window.kind !== "source" || typeof window.content !== "string" || typeof window.startLine !== "number") continue;
    const path = normalizeObligationPath(window.path);
    const citing = statementsByWindow.get(window.id) ?? [];
    const { sites, via } = extractComparisons(window);
    for (const site of sites) {
      if (!isBusinessComparison(site)) continue;
      const { field, operator, literal, literalKind, line } = site;
      const expression = literalKind === "string" ? `${field} ${operator} "${literal}"` : `${field} ${operator} ${literal}`;
      const consumedBy = citing
        .filter((claim) => mentionsLiteral(claim.statement, literal, literalKind))
        .map((claim) => claim.ref)
        .sort(cmp);
      windowsWithConditions.add(window.id);
      {
        items.push({
          id: `${path}:${line}:${expression}`,
          path,
          line,
          expression,
          field,
          operator,
          literal,
          literalKind,
          via,
          windowId: window.id,
          status: consumedBy.length ? "consumed" : "unaccounted",
          consumedBy: [...new Set(consumedBy)],
        });
      }
    }
  }

  // De-duplicate identical sites reached through overlapping windows. `consumedBy` is UNIONED, not
  // first-wins: the same condition can be cited by different claims through different windows, and dropping
  // the later ones would understate consumption (and vary with input order).
  const byId = new Map<string, ConditionCoverageItem>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      continue;
    }
    const merged = [...new Set([...existing.consumedBy, ...item.consumedBy])].sort(cmp);
    existing.consumedBy = merged;
    existing.status = merged.length ? "consumed" : "unaccounted";
  }
  const unique = [...byId.values()].sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.expression, b.expression));

  return {
    version: CONDITION_INVENTORY_VERSION,
    items: unique,
    families: enumFamilies(unique),
    summary: {
      total: unique.length,
      consumed: unique.filter((item) => item.status === "consumed").length,
      unaccounted: unique.filter((item) => item.status === "unaccounted").length,
      windowsWithConditions: windowsWithConditions.size,
      numericSites: unique.filter((item) => item.literalKind === "number").length,
      stringSites: unique.filter((item) => item.literalKind === "string").length,
      regexOnlySites: unique.filter((item) => item.via === "regex").length,
    },
  };
}

/**
 * The judgement layer, kept deliberately separate from the (open-source) syntactic extraction: which
 * comparison is a business rule. Numeric filters are the ones calibrated in 57B-393; the two string filters
 * were calibrated the same way on a real run (164 raw string comparisons → 66 after these two):
 *   - an empty-string comparison (`loc == ""`) is the string analogue of the 0/1 existence guard;
 *   - a `typeof` comparison (`typeof value !== "string"`) is a type guard, never domain behaviour.
 */
function isBusinessComparison(site: RawComparison): boolean {
  if (STRUCTURAL_LHS.test(site.field)) return false;
  if (site.literalKind === "string") {
    if (site.literal === "") return false;
    if (/\btypeof\b/.test(site.field)) return false;
    return true;
  }
  return !isStructuralLiteral(site.literal) && !isProtocolComparison(site.field, site.literal);
}

/** Group string-literal comparisons per (path, field) into the enum family that field accepts. */
function enumFamilies(items: ConditionCoverageItem[]): EnumFamily[] {
  const byKey = new Map<string, { path: string; field: string; values: Set<string>; lines: Set<number>; consumed: number; total: number }>();
  for (const item of items) {
    if (item.literalKind !== "string") continue;
    const key = `${item.path}${item.field}`;
    const entry = byKey.get(key) ?? { path: item.path, field: item.field, values: new Set<string>(), lines: new Set<number>(), consumed: 0, total: 0 };
    entry.values.add(item.literal);
    entry.lines.add(item.line);
    entry.total += 1;
    if (item.status === "consumed") entry.consumed += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((entry): EnumFamily => ({
      path: entry.path,
      field: entry.field,
      values: [...entry.values].sort(cmp),
      lines: [...entry.lines].sort((a, b) => a - b),
      status: entry.consumed === 0 ? "unaccounted" : entry.consumed === entry.total ? "consumed" : "partial",
    }))
    .sort((a, b) => b.values.length - a.values.length || cmp(a.path, b.path) || cmp(a.field, b.field));
}

/**
 * The literal appears in the statement as its own token — never inside a longer number or identifier.
 * Both sides are guarded, and asymmetry here is a FALSE-GREEN generator, which is worse than a false red:
 * it makes extraction look better than it is. "平均耗时 16.5 小时" must not consume `Hours > 16`, and
 * "结果为 10/4" must not consume `!= 10`, so a following `.digit` or `/digit` disqualifies the match just as
 * a preceding one does.
 */
function mentionsLiteral(statement: string, literal: string, kind: "number" | "string"): boolean {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Short enum values (`on`, `all`, `asc`, `new`) are common, and plain containment let "The configuration
  // loads once." consume `mode === "on"` — a measured false green. Guard both sides on word and hyphen
  // characters: a CJK or punctuation neighbour still matches, `configuration` and `open_positions` do not.
  // A single character stays unmatchable as a string: guarded or not, one letter carries no evidence that
  // the author meant this value. Numbers keep their own guard at any length (`Status == 3` is real).
  if (kind === "string") return literal.length > 1 && new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(statement);
  return new RegExp(`(?<![\\w./])${escaped}(?![\\w]|[./]\\d)`).test(statement);
}

/**
 * Advisory only, and deliberately so: an unaccounted condition may be a rule the report should have stated,
 * or one the author correctly judged unreportable — the difference is a judgement no mechanical check owns.
 * Hardening this into an error without a content red line per case would just push authors to name conditions
 * mechanically, which is the same Goodhart migration the read gates already have to watch for.
 */
export function auditConditionCoverage(inventory: ConditionInventory): AuditFinding[] {
  if (!inventory.summary.unaccounted) return [];
  const worst = inventory.items
    .filter((item) => item.status === "unaccounted")
    .slice(0, 12)
    .map((item) => `${item.path}:${item.line} (${item.expression})`);
  const findings: AuditFinding[] = [{
    level: "warning",
    document: "condition-coverage",
    message: `condition residual (advisory): ${inventory.summary.unaccounted} of ${inventory.summary.total} literal domain conditions inside opened windows are stated by no claim (${inventory.summary.numericSites} numeric, ${inventory.summary.stringSites} string-enum${inventory.summary.regexOnlySites ? `; ${inventory.summary.regexOnlySites} site(s) came from a language with no AST grammar, where only numeric literals are visible` : ""}) — ${worst.join("; ")}${inventory.summary.unaccounted > worst.length ? `; +${inventory.summary.unaccounted - worst.length} more` : ""}; see coverage/condition-inventory.json. This measures extraction, not reading: a window can be opened and its rules still never reported.`,
  }];
  const unstatedFamilies = inventory.families.filter((family) => family.values.length > 1 && family.status !== "consumed");
  if (unstatedFamilies.length) {
    const named = unstatedFamilies.slice(0, 6).map((family) => `${family.field} ∈ {${family.values.join(", ")}}`);
    findings.push({
      level: "warning",
      document: "condition-coverage",
      message: `value-set residual (advisory): ${unstatedFamilies.length} field(s) are compared against a set of literal values no claim fully states — ${named.join("; ")}${unstatedFamilies.length > named.length ? `; +${unstatedFamilies.length - named.length} more` : ""}. A value set is the modes/types/states that exist; omitting it usually means the report describes one path and leaves the others invisible.`,
    });
  }
  return findings;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
