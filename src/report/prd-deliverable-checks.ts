/**
 * THE PRD DELIVERABLE'S WORD-FORM CONTRACT, read off the visible prose of one unit: acceptance residue, the id
 * series the trace index is forbidden to define, the shape and uniqueness of the two series it does define, and a
 * conservative tripwire for storage-schema vocabulary that escaped the evidence block.
 *
 * WHY IT EXISTS. `skills/excavator/references/prd-feature.md` and `references/writing-rules.md` state four things
 * about a PRD's own words that a machine can check and nothing checked: the document "states how the capability
 * behaves, never how someone would verify it" (no acceptance chapter, no checkbox lists); the trace index "defines
 * no other id series: no acceptance ids, no component ids, no test ids"; its two series are `FR-` and `PAGE-` plus
 * THREE DIGITS, each id "unique within the document"; and no "table names, column names, column types, indexes,
 * foreign keys" appear in a chapter — all of it stays inside the collapsed evidence block. Every one of those is a
 * sentence a model reads once and drifts from, and drifts from quietly.
 *
 * WHAT IT REFUSES TO READ: ANYTHING BUT VISIBLE PROSE, and the definition of "visible" is IMPORTED, never
 * restated. `visibleUnitText` (`unit-claim-binding.ts`) is the one authority for what a reader sees — collapsed
 * `<details>` blocks, fenced code and HTML comments removed — and it is the same authority the claim-binding
 * contract binds claims against. A second mapping here would be a second definition of "visible", and the two
 * would disagree the first time either moved. It is also what makes the rules SAFE: a PRD's evidence blocks carry
 * DDL, column types and API paths legitimately, and a chapter quoting a Markdown sample inside a fence is quoting,
 * not writing.
 *
 * WHAT "UNIQUE WITHIN THE DOCUMENT" IS TAKEN TO MEAN, stated because the narrower reading was chosen deliberately.
 * An id is checked for uniqueness at its DEFINITION SITES — the lines it LEADS, after list markers, table-cell
 * bars, blockquote marks and emphasis are stripped — and not at every occurrence. The trace index exists so "later
 * work can cite a line of this document without quoting it"; an id that leads two lines makes a citation point at
 * two places, which is the property the contract is about. An id MENTIONED mid-sentence somewhere else in the
 * document is a citation, and reporting that as a duplicate would red a document for doing the thing the index is
 * for. THE COST IS NAMED: a second definition written mid-line is not counted as a definition, so it is not
 * reported as a duplicate — including an index written as a table whose id sits in the SECOND column. The trace
 * index the template asks for leads with the id (a list item, or a table's first cell), both of which are
 * definition sites; the shape rule still reads every other occurrence, and no observed defect has that form.
 *
 * THE TECHNICAL-LEAK LIST IS A TRIPWIRE AND SAYS SO IN ITS SEVERITY. A vocabulary list cannot be complete — that
 * is a property of vocabulary lists, not a gap in this one — so it reports `warning` and never fails a check. The
 * tokens are chosen for one property: they are close to impossible in business prose about a product. It therefore
 * MISSES, by construction, every leak written in words that are also ordinary words: a table name (`sys_user`), a
 * column name, `index`, `join`, `int`, `datetime`, a status code, an HTTP method, an API path. Those are left to a
 * human reading a real run, which is what the parent epic assigns to its last slice.
 *
 * IT IS A PURE FUNCTION OF ONE STRING. No path, no I/O, no model, no audience — the caller decides whether the
 * document this prose came from is a PRD at all.
 */

import { assertNever } from "../base/artifact-result.ts";
import { visibleUnitText } from "./unit-claim-binding.ts";

export const PRD_DELIVERABLE_CHECKS_VERSION = "prd-deliverable-checks-v1";

/**
 * The five shapes, as a census. `tests/prd-deliverable-checks.test.ts` walks it and demands a fixture that
 * produces each one, so a sixth shape cannot be added with nothing reaching it.
 */
export const PRD_PROBLEM_SHAPES = [
  "acceptance-residue",
  "forbidden-anchor-series",
  "anchor-shape",
  "anchor-duplicate",
  "technical-leak"
] as const;
export type PrdProblemShape = (typeof PRD_PROBLEM_SHAPES)[number];

/** What a shape costs: a gate that fails the check, or a tripwire that reports and does not. */
export type PrdCheckSeverity = "error" | "warning";

/**
 * The severity of one shape. Exhaustive, no `default`, and the ONE authority for which rules are gates.
 *
 * Four are `error` because each is a contract stated in words in the template the run was drafted from, and each
 * is decidable without a vocabulary: a checkbox is a syntax, `AC-\d+` is a series the contract forbids by name,
 * and `(FR|PAGE)-\d{3}` plus uniqueness is a shape. The fifth is `warning` because it is decided by a word list —
 * see the file header on what such a list must miss.
 */
export function prdProblemSeverity(shape: PrdProblemShape): PrdCheckSeverity {
  switch (shape) {
    case "acceptance-residue":
    case "forbidden-anchor-series":
    case "anchor-shape":
    case "anchor-duplicate":
      return "error";
    case "technical-leak":
      return "warning";
  }
  return assertNever(shape, "prd problem shape");
}

/**
 * One thing wrong with one PRD deliverable's words.
 *
 * The four per-unit shapes carry a COUNT AND ONE EXCERPT rather than one problem per occurrence: an acceptance
 * table with twenty checkbox rows is one residue and one repair, and reporting twenty findings would multiply one
 * defect by how thoroughly it was written. `anchor-duplicate` is per id, because two ids colliding are two
 * repairs.
 */
export type PrdProblem =
  | { readonly shape: "acceptance-residue"; readonly occurrences: number; readonly excerpt: string }
  | { readonly shape: "forbidden-anchor-series"; readonly token: string; readonly occurrences: number; readonly excerpt: string }
  | { readonly shape: "anchor-shape"; readonly token: string; readonly occurrences: number; readonly excerpt: string }
  | { readonly shape: "anchor-duplicate"; readonly anchorId: string; readonly definitions: number }
  | { readonly shape: "technical-leak"; readonly token: string; readonly occurrences: number; readonly excerpt: string };

/** What one unit's visible prose holds. `anchorIds` keeps repeats: two definitions of one id are two entries. */
export interface PrdUnitScan {
  /** The four per-unit shapes, in `PRD_PROBLEM_SHAPES` order, then by token. Uniqueness is not decidable here. */
  readonly problems: readonly PrdProblem[];
  /** Every well-formed `FR-###` / `PAGE-###` this unit DEFINES (leads a line with), in reading order. */
  readonly anchorIds: readonly string[];
  /** Every `FR-` / `PAGE-` token seen, well-formed or not, at any position: the shape rule's denominator. */
  readonly anchorTokens: number;
  /** Non-blank lines of visible prose read. Reported so "0 findings" has a denominator that can be checked. */
  readonly visibleLines: number;
}

/**
 * The storage-schema vocabulary, verbatim as the deciding issue enumerated it.
 *
 * A space in an entry matches ANY run of whitespace, so `PRIMARY  KEY` and a line-wrapped `NOT\nNULL` are the same
 * token. Matching is case-insensitive: `VARCHAR` and `varchar` are one leak.
 *
 * `unsigned` IS the loosest entry and that is recorded rather than hidden — English business prose can say "an
 * unsigned agreement". It stays because the list is the one the decision fixed, and because the shape it belongs
 * to is a warning that costs a reader one glance.
 */
export const TECHNICAL_LEAK_TOKENS = [
  "varchar",
  "bigint",
  "tinyint",
  "smallint",
  "mediumtext",
  "longtext",
  "AUTO_INCREMENT",
  "PRIMARY KEY",
  "FOREIGN KEY",
  "NOT NULL",
  "DEFAULT NULL",
  "unsigned"
] as const;

/**
 * A GFM task-list item: a list marker, then `[ ]` or `[x]`, then whitespace or end of line.
 *
 * The trailing boundary is what keeps `- [x](https://…)` — a link whose text is "x" — from reading as a checkbox.
 * Leading blockquote marks and table-cell bars are allowed through, so a checklist tucked into a quote or a table
 * is still a checklist.
 */
const TASK_LIST_ITEM = /^[\s>|]*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\](?=[\s|]|$)/u;

/**
 * The two trace-anchor series' prefixes, at a token boundary, with whatever they are actually followed by.
 *
 * It matches the PREFIX and captures the rest, rather than matching the legal shape, because a rule that only
 * matched `(FR|PAGE)-\d{3}` could not see a violation: `FR-1` would simply not be a token it knows. Case-sensitive
 * on purpose — the contract's series are upper-case, and a case-insensitive rule would read `page-break` and the
 * `fr-` of an ordinary word as trace anchors.
 */
const ANCHOR_TOKEN = /(?<![0-9A-Za-z_-])(FR|PAGE)-([0-9A-Za-z_-]*)/gu;

/** The one legal suffix: exactly three ASCII digits. `FR-1`, `FR-0012` and `FR-A01` all fail it. */
const WELL_FORMED_SUFFIX = /^[0-9]{3}$/u;

/** The id series the trace index is forbidden to define, by name: acceptance ids. */
const FORBIDDEN_SERIES = /(?<![0-9A-Za-z_-])AC-[0-9]+/gu;

/**
 * The decoration a definition may hide behind at the start of its line: whitespace, blockquote marks, table-cell
 * bars, a heading mark, a bullet or ordered marker, and inline emphasis.
 *
 * This is what makes `| FR-001 | … |`, `- **FR-001** — …` and `1. \`FR-001\` …` all count as definitions of
 * `FR-001`, which matters because the template asks for the index as lists and `writing-rules.md` asks for tables.
 */
const DEFINITION_LEAD = /^(?:#{1,6}[ \t]|[-*+][ \t]|[0-9]+[.)][ \t]|[\s>|`*_])*/u;

/** One compiled leak rule: the canonical token from the list, and the pattern that finds it. */
const LEAK_RULES: ReadonlyArray<{ readonly token: string; readonly pattern: RegExp }> = TECHNICAL_LEAK_TOKENS.map((token) => ({
  token,
  pattern: new RegExp(`(?<![0-9A-Za-z_])${token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+")}(?![0-9A-Za-z_])`, "giu")
}));

/** Read one unit's visible prose against the four rules that need only that unit. */
export function scanPrdUnitProse(content: string): PrdUnitScan {
  const visible = visibleUnitText(content);
  const lines = visible.split(/\r?\n/);
  const anchorIds: string[] = [];
  let anchorTokens = 0;
  let visibleLines = 0;
  const checkboxes: string[] = [];
  const forbidden = new Map<string, string[]>();
  const malformed = new Map<string, string[]>();
  for (const line of lines) {
    if (line.trim() === "") continue;
    visibleLines += 1;
    if (TASK_LIST_ITEM.test(line)) checkboxes.push(excerptOf(line));
    for (const match of line.matchAll(FORBIDDEN_SERIES)) {
      forbidden.set(match[0], [...(forbidden.get(match[0]) ?? []), excerptOf(line)]);
    }
    const lead = DEFINITION_LEAD.exec(line)![0].length;
    for (const match of line.matchAll(ANCHOR_TOKEN)) {
      anchorTokens += 1;
      const token = match[0];
      if (!WELL_FORMED_SUFFIX.test(match[2]!)) {
        malformed.set(token, [...(malformed.get(token) ?? []), excerptOf(line)]);
        continue;
      }
      // A definition is an id that LEADS its line; anything further in is a citation. See the file header.
      if (match.index === lead) anchorIds.push(token);
    }
  }
  const leaks = new Map<string, string[]>();
  for (const rule of LEAK_RULES) {
    for (const match of visible.matchAll(rule.pattern)) {
      leaks.set(rule.token, [...(leaks.get(rule.token) ?? []), excerptAround(visible, match.index, match[0].length)]);
    }
  }
  const problems: PrdProblem[] = [];
  if (checkboxes.length > 0) {
    problems.push({ shape: "acceptance-residue", occurrences: checkboxes.length, excerpt: checkboxes[0]! });
  }
  for (const [token, hits] of sorted(forbidden)) {
    problems.push({ shape: "forbidden-anchor-series", token, occurrences: hits.length, excerpt: hits[0]! });
  }
  for (const [token, hits] of sorted(malformed)) {
    problems.push({ shape: "anchor-shape", token, occurrences: hits.length, excerpt: hits[0]! });
  }
  for (const [token, hits] of sorted(leaks)) {
    problems.push({ shape: "technical-leak", token, occurrences: hits.length, excerpt: hits[0]! });
  }
  return { problems, anchorIds, anchorTokens, visibleLines };
}

/** One id defined more than once, and every unit that defines it. */
export interface DuplicateAnchor {
  readonly problem: Extract<PrdProblem, { shape: "anchor-duplicate" }>;
  /** Ascending and distinct — the units whose prose leads a line with this id. Never empty. */
  readonly unitIds: readonly string[];
}

/**
 * Every trace anchor two definitions answer to, over one document's units.
 *
 * It is here and not in the caller because "what counts as a duplicate" is this file's rule: the caller supplies
 * WHOSE prose each definition came from, and nothing else. Two definitions inside ONE unit are a duplicate too —
 * the property is about the document, and a unit is part of one.
 */
export function duplicateAnchorDefinitions(
  perUnit: ReadonlyArray<{ readonly unitId: string; readonly anchorIds: readonly string[] }>
): readonly DuplicateAnchor[] {
  const byId = new Map<string, { definitions: number; unitIds: string[] }>();
  for (const unit of perUnit) {
    for (const anchorId of unit.anchorIds) {
      const row = byId.get(anchorId) ?? { definitions: 0, unitIds: [] };
      row.definitions += 1;
      if (!row.unitIds.includes(unit.unitId)) row.unitIds.push(unit.unitId);
      byId.set(anchorId, row);
    }
  }
  return [...byId.entries()]
    .filter(([, row]) => row.definitions > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([anchorId, row]) => ({
      problem: { shape: "anchor-duplicate", anchorId, definitions: row.definitions },
      unitIds: [...row.unitIds].sort()
    }));
}

/**
 * The sentence one problem prints. Exhaustive over the five shapes.
 *
 * `where` is the units the finding names, already rendered, so this file never learns how a unit id is spelled or
 * sorted — that is `unit-consistency.ts`'s business, and it has one comparator for it.
 */
export function describePrdProblem(problem: PrdProblem, documentId: string, where: string): string {
  switch (problem.shape) {
    case "acceptance-residue":
      return `${where} keeps ${problem.occurrences} acceptance checkbox line(s) in the visible prose of prd deliverable ${documentId} (${JSON.stringify(problem.excerpt)}); the PRD template has no acceptance chapter and states the document says how the capability behaves, never how someone would verify it, so a checkbox list is the residue of a chapter this deliverable does not have`;
    case "forbidden-anchor-series":
      return `${where} writes acceptance id ${problem.token} in the visible prose of prd deliverable ${documentId} (${problem.occurrences} occurrence(s), first ${JSON.stringify(problem.excerpt)}); the trace index defines exactly two id series, FR-### and PAGE-###, and the contract names the ones it may not define — no acceptance ids, no component ids, no test ids`;
    case "anchor-shape":
      return `${where} writes ${problem.token} in the visible prose of prd deliverable ${documentId} (${problem.occurrences} occurrence(s), first ${JSON.stringify(problem.excerpt)}); the trace index's two series are FR- and PAGE- plus exactly three digits, so this token cites nothing the index can define`;
    case "anchor-duplicate":
      return `prd deliverable ${documentId} defines trace anchor ${problem.anchorId} on ${problem.definitions} line(s), written by ${where}; an anchor exists so later work can cite one line of this document without quoting it, and an id that leads two lines cites both`;
    case "technical-leak":
      return `${where} writes storage-schema token ${JSON.stringify(problem.token)} in the visible prose of prd deliverable ${documentId} (${problem.occurrences} occurrence(s), first ${JSON.stringify(problem.excerpt)}); a PRD chapter carries no table names, column names, column types or schema definitions — they belong in the collapsed evidence block. This is a tripwire rather than a gate: it is decided by a word list, which cannot be complete, so it reports and does not fail the check`;
  }
  return assertNever(problem, "prd problem");
}

/** One line, squeezed and clipped, so a finding can quote what it read without carrying a paragraph. */
function excerptOf(line: string): string {
  const squeezed = line.replace(/\s+/gu, " ").trim();
  return squeezed.length <= 120 ? squeezed : `${squeezed.slice(0, 120)}…`;
}

/** The text around one match, for a rule that scans the whole prose rather than one line. */
function excerptAround(prose: string, index: number, length: number): string {
  return excerptOf(prose.slice(Math.max(0, index - 20), index + length + 20));
}

/** Token order, so one input has one problem order. Code-point order: these tokens are ASCII by construction. */
function sorted(hits: ReadonlyMap<string, readonly string[]>): ReadonlyArray<readonly [string, readonly string[]]> {
  return [...hits.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
